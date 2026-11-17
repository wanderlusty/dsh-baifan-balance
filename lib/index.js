// dsh-baifan-balance：给 DSH 加「大白饭余额」的可视化与查询能力（Host 侧）。
//
// 两条凭据槽，回答的是两个不同的问题：
//   - 账户口径（访问令牌，推荐）：整个账户还剩多少钱，还能看到账号/分组/请求数
//   - 单 key 口径（api key，可选）：某一个 key 自己被设了多少额度
// 站点开着「令牌级别统计」时，api key 只肯回答自己那条 key 的额度；不限额的 key 站点只给
// 一个哨兵值，所以这里单独识别成「无限制」，而不是硬报一个假数字。
//
// 折算用的 quota_per_unit / quota_display_type / usd_exchange_rate 来自公开的 /api/status，
// 按站点缓存几分钟；算法与 new-api 后端 controller/billing.go 的三分支换算一致。
//
// 三条硬规则：
//   1. 宁可报错，也不要把解析失败当成 0——「剩余 ¥0.00」比查不到更糟。
//   2. 传了 base_url 就必须同时给 key，否则配置里的凭据会被送到别的站点去。
//   3. 本地路由只认回环 Host + 同源，防 DNS rebinding 与跨站改写。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名。 */
export const name = 'baifan-balance'

/** 依赖的 Host 服务。commands / credentials / webServer 都是可选探测的。 */
export const inject = ['tools']

/** 包根目录（lib/ 的上一级），用于找本地 secret.json。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const DEFAULT_BASE_URL = 'https://baifanapi.awstme.top'
const DEFAULT_TIMEOUT_MS = 15000
const SITE_STATUS_TTL_MS = 5 * 60 * 1000
const SUMMARY_TTL_MS = 30 * 1000

const SUMMARY_ROUTE = '/baifan-balance/summary'
const CONFIG_ROUTE = '/baifan-balance/config'
const AUTHORIZE_ROUTE = '/baifan-balance/authorize-key'

/** 凭据记录地址：两个槽，外加 1.6 及以前的旧记录（按前缀归位）。 */
const CREDENTIAL_SLOTS = {
	account: ['baifan-balance/access-token'],
	key: ['baifan-balance/api-key'],
}
const LEGACY_CREDENTIAL_KEY = 'baifan-balance/relay-key'

/** new-api 用 100000000 表示「令牌不限额」，不是真的余额。 */
const UNLIMITED_SENTINEL = 100000000

/** 个性化默认值：显示位置、刷新节奏、信息密度、图标、强调色、低余额阈值。 */
const DEFAULT_SETTINGS = {
	surface: 'both',
	refreshSeconds: 60,
	detail: 'standard',
	showIcon: true,
	accent: 'auto',
	// 提醒线按口径分开：账户余额一个，key 额度一个。
	lowBalanceAccount: 1,
	lowBalanceKey: 1,
	// 默认自动认领 DSH 正在使用的那条 api key；关掉后面下方只显示手动填的那条。
	autoDetectKey: true,
}
const SURFACES = ['both', 'avatar', 'bottom', 'hidden']
const DETAIL_LEVELS = ['compact', 'standard', 'detailed']
const ACCENTS = ['auto', 'brand', 'success', 'warn']
const CHANNELS = ['account', 'key', 'auto']

/** 自动认领 api key 时依次尝试的凭据引用（DSH 里配模型提供商用的名字）。 */
const AUTO_KEY_REFS = [
	'DABAIFAN_API_KEY',
	'DABAIFAN_CESHI_API_KEY',
	'BAIFAN_API_KEY',
	'NEWAPI_API_KEY',
]

/** 站点展示参数缓存：baseUrl → { at, value }。 */
const siteStatusCache = new Map()

/** 令牌表缓存（用来把 sk- 对上「key 名」）：baseUrl → { at, items }。 */
const tokenListCache = new Map()

/** 读数缓存（账户 + key 一起），供 UI 轮询与手动刷新共用。 */
const summaryCache = { at: 0, payload: undefined, inFlight: undefined }

/** 空串、纯空白和非字符串一律视作「没配」。 */
function nonEmptyText(value) {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 站点根地址归一化。用户最常粘的就是提供商里那串带 /v1 的地址，
 * 直接拿它拼 /api/user/self 会查到 /v1/api/user/self，然后被误诊成「不是 new-api」。
 */
function normalizeBaseUrl(value) {
	const raw = nonEmptyText(value) ?? DEFAULT_BASE_URL
	return raw
		.replace(/\/+$/, '')
		.replace(/\/v1$/i, '')
		.replace(/\/+$/, '')
}

/** 从 URL 里取主机名，只用于把错误信息说清楚。 */
function hostOf(baseUrl) {
	try {
		return new URL(baseUrl).host
	} catch {
		return baseUrl
	}
}

function clampNumber(value, min, max, fallback) {
	const parsed = Number(value)
	if (!Number.isFinite(parsed)) return fallback
	return Math.min(Math.max(parsed, min), max)
}

/** 把配置里的个性化字段归一化，非法值一律退回默认值。 */
function readSettings(config) {
	return {
		surface: SURFACES.includes(config.surface) ? config.surface : DEFAULT_SETTINGS.surface,
		refreshSeconds: Math.round(clampNumber(config.refreshSeconds, 15, 600, DEFAULT_SETTINGS.refreshSeconds)),
		detail: DETAIL_LEVELS.includes(config.detail) ? config.detail : DEFAULT_SETTINGS.detail,
		showIcon: config.showIcon !== false,
		accent: ACCENTS.includes(config.accent) ? config.accent : DEFAULT_SETTINGS.accent,
		// 1.10 及以前的单一 lowBalance 作为两条提醒线的中间默认值，最终兜底是 5。
		lowBalanceAccount: Math.max(clampNumber(
			config.lowBalanceAccount, 0, 1e9,
			clampNumber(config.lowBalance, 0, 1e9, DEFAULT_SETTINGS.lowBalanceAccount),
		), 0),
		lowBalanceKey: Math.max(clampNumber(
			config.lowBalanceKey, 0, 1e9,
			clampNumber(config.lowBalance, 0, 1e9, DEFAULT_SETTINGS.lowBalanceKey),
		), 0),
		autoDetectKey: config.autoDetectKey !== false,
	}
}

/** 凭据尾号：让用户能确认「这是哪个凭据」，又不把整串密钥写进会话日志。 */
function credentialTail(credential) {
	return credential.length <= 4 ? '****' : credential.slice(-4)
}

/** 本地凭据文件：与本插件同目录的 secret.json，形如 {"token":"..."}。 */
function readSecretFile() {
	const path = join(PACKAGE_ROOT, 'secret.json')
	if (!existsSync(path)) return undefined
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'))
		return nonEmptyText(parsed.accessToken) ?? nonEmptyText(parsed.token) ?? nonEmptyText(parsed.key)
	} catch {
		return undefined
	}
}

/**
 * 读出两个凭据槽。优先级：插件配置 > 设置页记录 > secret.json > 环境变量。
 * 旧的单槽记录按前缀归位：sk- 开头的进 key 槽，其余进账户槽。
 */
async function resolveCredentials(config, services) {
	const slots = { account: undefined, key: undefined }

	const fromConfigAccount = nonEmptyText(config.accessToken) ?? nonEmptyText(config.token)
	if (fromConfigAccount !== undefined) slots.account = { value: fromConfigAccount, source: '插件配置' }
	const fromConfigKey = nonEmptyText(config.key)
	if (fromConfigKey !== undefined) slots.key = { value: fromConfigKey, source: '插件配置' }

	const credentials = services.credentials
	if (credentials !== undefined) {
		for (const [slot, recordKeys] of Object.entries(CREDENTIAL_SLOTS)) {
			if (slots[slot] !== undefined) continue
			for (const recordKey of recordKeys) {
				try {
					const record = await credentials.readRecord(recordKey)
					const value = record?.kind === 'api-key' ? nonEmptyText(record.key) : undefined
					if (value !== undefined) {
						slots[slot] = { value, source: '设置页' }
						break
					}
				} catch {
					// 存储读失败就是没有，不阻塞其它来源
				}
			}
		}
		if (credentials !== undefined) {
			try {
				const legacy = await credentials.readRecord(LEGACY_CREDENTIAL_KEY)
				const value = legacy?.kind === 'api-key' ? nonEmptyText(legacy.key) : undefined
				if (value !== undefined) {
					const slot = value.startsWith('sk-') ? 'key' : 'account'
					slots[slot] ??= { value, source: '设置页' }
				}
			} catch {
				// 同上
			}
		}
	}

	const fromFile = readSecretFile()
	if (fromFile !== undefined) {
		const slot = fromFile.startsWith('sk-') ? 'key' : 'account'
		slots[slot] ??= { value: fromFile, source: 'secret.json' }
	}

	const fromEnvAccount = nonEmptyText(process.env.BAIFAN_ACCESS_TOKEN) ?? nonEmptyText(process.env.NEWAPI_ACCESS_TOKEN)
	if (fromEnvAccount !== undefined) slots.account ??= { value: fromEnvAccount, source: '环境变量' }
	const fromEnvKey = nonEmptyText(process.env.DABAIFAN_API_KEY) ?? nonEmptyText(process.env.BAIFAN_API_KEY)
	if (fromEnvKey !== undefined) slots.key ??= { value: fromEnvKey, source: '环境变量' }

	// 自动认领：DSH 里配模型提供商用的 api key 会存在凭据服务里，
	// 用户已经在用的那条 sk- 就不必再手动填一遍。设置里可以关掉。
	if (config.autoDetectKey !== false && slots.key === undefined
		&& credentials !== undefined && typeof credentials.resolve === 'function') {
		for (const ref of AUTO_KEY_REFS) {
			try {
				const resolved = await credentials.resolve(ref)
				const value = nonEmptyText(resolved?.value)
				if (value !== undefined && value.startsWith('sk-')) {
					slots.key = { value, source: '自动检测' }
					break
				}
			} catch {
				// 该引用没配就是没有，继续试下一个
			}
		}
	}

	return slots
}

/** 缺失凭据时给一条能照做的提示；两个槽缺的是不同的东西。 */
function missingCredentialMessage(channel) {
	if (channel === 'key') {
		return '还没有配置 api key（可选）：填了页面下方才显示单 key 额度，否则回退显示账户余额'
	}
	return '还没有配置访问令牌：打开 头像 → 设置 → 大白饭余额 填一个（推荐，查账户余额）'
}

/** 剩余时间：整次查询共用一个预算，而不是每个请求各自 15 秒。 */
function remainingBudget(options) {
	const left = options.deadline - Date.now()
	return left > 0 ? left : 0
}

/** 发一次请求并解析 JSON；超时、取消、连不上都翻译成能看懂的一句话。 */
async function requestJson(url, token, options) {
	const budget = remainingBudget(options)
	if (budget <= 0) throw new Error(`查询超时：${options.timeoutMs} 毫秒内没查完（${hostOf(url)}）`)
	const controller = new AbortController()
	const forwardAbort = () => controller.abort(options.signal?.reason)
	if (options.signal !== undefined) {
		if (options.signal.aborted) forwardAbort()
		else options.signal.addEventListener('abort', forwardAbort, { once: true })
	}
	const timer = setTimeout(() => controller.abort(new Error('timeout')), budget)
	try {
		let response
		try {
			const headers = { accept: 'application/json' }
			if (token !== undefined) headers.authorization = `Bearer ${token}`
			if (options.body !== undefined) headers['content-type'] = 'application/json'
			response = await fetch(url, {
				method: options.method ?? 'GET',
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: controller.signal,
			})
		} catch (error) {
			if (options.signal?.aborted === true) throw error
			if (controller.signal.aborted) {
				throw new Error(`查询超时：${options.timeoutMs} 毫秒内没查完（${hostOf(url)}）`)
			}
			const detail = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error)
			throw new Error(`连不上 ${hostOf(url)}（${detail}）`)
		}
		const body = await response.text()
		try {
			return { status: response.status, payload: JSON.parse(body) }
		} catch {
			throw new Error(
				`${hostOf(url)} 返回的不是 JSON（HTTP ${response.status}）：这个地址可能不是 new-api 站点，或站点地址多带了路径`,
			)
		}
	} finally {
		clearTimeout(timer)
		options.signal?.removeEventListener('abort', forwardAbort)
	}
}

/** 缺失或非数字的字段一律当失败处理，绝不静默当 0。 */
function requireNumber(value, what) {
	const parsed = Number(value)
	if (!Number.isFinite(parsed)) throw new Error(`站点返回的 ${what} 不是有效数字（${JSON.stringify(value)}）`)
	return parsed
}

/** 读站点展示参数（公开接口），5 分钟内复用同一份结果。 */
async function readSiteStatus(baseUrl, token, options) {
	const cached = siteStatusCache.get(baseUrl)
	if (cached !== undefined && Date.now() - cached.at < SITE_STATUS_TTL_MS) return cached.value
	const { payload } = await requestJson(`${baseUrl}/api/status`, token, options)
	const data = payload?.data ?? {}
	const displayType = (nonEmptyText(data.quota_display_type) ?? '').toUpperCase()
	if (displayType !== 'CNY' && displayType !== 'USD' && displayType !== 'TOKENS') {
		throw new Error(`${hostOf(baseUrl)} 没有返回可识别的 quota_display_type，无法确定该用哪种货币展示`)
	}
	const value = {
		name: nonEmptyText(data.system_name) ?? hostOf(baseUrl),
		displayType,
		// 只有需要换算时才要求这两个字段存在。
		quotaPerUnit: displayType === 'TOKENS' ? 0 : requireNumber(data.quota_per_unit, 'quota_per_unit'),
		exchangeRate: displayType === 'CNY' ? requireNumber(data.usd_exchange_rate, 'usd_exchange_rate') : 1,
	}
	siteStatusCache.set(baseUrl, { at: Date.now(), value })
	return value
}

/** 内部 quota → 站点展示单位，与 new-api 后端的三分支换算一致。 */
function toDisplayAmount(quota, site) {
	if (site.displayType === 'TOKENS') return quota
	const usd = quota / site.quotaPerUnit
	return site.displayType === 'CNY' ? usd * site.exchangeRate : usd
}

function displayCurrency(site) {
	return site.displayType === 'TOKENS' ? 'TOKENS' : site.displayType
}

function formatAmount(amount, currency) {
	if (currency === 'TOKENS') return `${Math.round(amount)} tokens`
	return `${currency === 'CNY' ? '¥' : '$'}${amount.toFixed(2)}`
}

/** 换算会带出浮点尾数，落到结果里保留 6 位，展示层再按货币精度取整。 */
function roundAmount(amount) {
	return Math.round(amount * 1e6) / 1e6
}

function formatTimestamp(iso) {
	const time = new Date(iso)
	if (Number.isNaN(time.getTime())) return iso
	return time.toLocaleString('zh-CN', { hour12: false })
}

/** 账户口径：/api/user/self，拿到的是内部 quota，要先折算。 */
async function queryAccount(baseUrl, credential, options) {
	const { status, payload } = await requestJson(`${baseUrl}/api/user/self`, credential.value, options)
	if (status === 401 || payload?.success === false) {
		throw new Error(`访问令牌无效或已过期（${hostOf(baseUrl)}）：请更新设置页里的访问令牌`)
	}
	const data = payload?.data ?? {}
	if (data.quota === undefined) {
		throw new Error(`${hostOf(baseUrl)} 没有返回 quota 字段：这个地址可能不是 new-api 站点，或站点地址多带了路径`)
	}
	return {
		scope: 'account',
		credential: 'access_token',
		credentialSource: credential.source,
		credentialTail: credentialTail(credential.value),
		account: nonEmptyText(data.username) ?? nonEmptyText(data.display_name),
		group: nonEmptyText(data.group),
		remainingQuota: requireNumber(data.quota, 'quota'),
		usedQuota: requireNumber(data.used_quota ?? 0, 'used_quota'),
		requestCount: requireNumber(data.request_count ?? 0, 'request_count'),
		accessUntil: 0,
	}
}

/**
 * 新接口 `/api/usage/token/`：返回令牌自己的额度；令牌被授权查询用户额度时，
 * 还会多带一个 `user_quota`（账户剩余/已用）。单位都是内部 quota。
 * 老站点没有这个接口时返回 undefined，调用方回退到 billing 接口。
 */
async function queryTokenUsage(baseUrl, credential, options) {
	let response
	try {
		response = await requestJson(`${baseUrl}/api/usage/token/`, credential.value, options)
	} catch {
		return undefined
	}
	if (response.status === 401 || response.payload?.code !== true) return undefined
	const data = response.payload?.data
	if (data === undefined || data.object !== 'token_usage') return undefined
	const user = data.user_quota === undefined ? undefined : {
		available: Number(data.user_quota.total_available) || 0,
		used: Number(data.user_quota.total_used) || 0,
	}
	return {
		name: nonEmptyText(data.name),
		unlimited: data.unlimited_quota === true,
		granted: Number(data.total_granted) || 0,
		available: Number(data.total_available) || 0,
		used: Number(data.total_used) || 0,
		expiresAt: Number(data.expires_at) || 0,
		user,
	}
}

/**
 * 单 key 口径。优先用 `/api/usage/token/`：它能一并给出令牌名，令牌被授权时还能给账户额度；
 * 老站点没有这个接口时退回 billing 接口（返回的已经是展示单位）。
 */
async function queryKey(baseUrl, credential, options) {
	const base = {
		credential: 'api_key',
		credentialSource: credential.source,
		credentialTail: credentialTail(credential.value),
	}
	const usage = await queryTokenUsage(baseUrl, credential, options)
	if (usage !== undefined) {
		// 无论有没有被授权，key 通道都报令牌自己的额度；被授权时额外带上账户额度，
		// 由 readBoth / readChannel 决定要不要用它填「账户」那一侧。
		return {
			...base,
			scope: 'token',
			name: usage.name,
			unlimited: usage.unlimited,
			remainingQuota: usage.available,
			usedQuota: usage.used,
			totalQuota: usage.granted,
			accessUntil: usage.expiresAt,
			userQuota: usage.user,
		}
	}

	const subscription = await requestJson(`${baseUrl}/v1/dashboard/billing/subscription`, credential.value, options)
	if (subscription.status === 401 || subscription.payload?.error !== undefined) {
		throw new Error(`api key 无效或已过期（${hostOf(baseUrl)}）：请更新设置页里的 api key`)
	}
	const total = requireNumber(subscription.payload?.hard_limit_usd, 'hard_limit_usd')
	if (total >= UNLIMITED_SENTINEL) {
		return { ...base, scope: 'token', unlimited: true, displayUnits: true, remaining: 0, used: 0, total: 0, accessUntil: 0 }
	}
	const usageBilling = await requestJson(`${baseUrl}/v1/dashboard/billing/usage`, credential.value, options)
	if (usageBilling.payload?.error !== undefined) {
		throw new Error(`用量接口返回错误（${hostOf(baseUrl)}）：请稍后重试或联系站点管理员`)
	}
	const used = requireNumber(usageBilling.payload?.total_usage, 'total_usage') / 100
	// 不夹到 0：透支是信息，抹平会让人以为刚好用完。
	return {
		...base,
		scope: 'token',
		displayUnits: true,
		total,
		used,
		remaining: total - used,
		accessUntil: Number(subscription.payload?.access_until) || 0,
	}
}

/** 把一次通道读数折算成展示值。 */
function toBalanceValue(reading, site, baseUrl) {
	let amounts
	if (reading.scope === 'account') {
		amounts = {
			remaining: toDisplayAmount(reading.remainingQuota, site),
			used: toDisplayAmount(reading.usedQuota, site),
			total: toDisplayAmount(reading.remainingQuota + reading.usedQuota, site),
		}
	} else if (reading.displayUnits === true) {
		// 老 billing 接口返回的已经是展示单位。
		amounts = { remaining: reading.remaining, used: reading.used, total: reading.total }
	} else {
		// /api/usage/token/ 给的是内部 quota，要自己折算。
		amounts = {
			remaining: toDisplayAmount(reading.remainingQuota, site),
			used: toDisplayAmount(reading.usedQuota, site),
			total: toDisplayAmount(reading.totalQuota ?? (reading.remainingQuota + reading.usedQuota), site),
		}
	}
	const value = {
		site: site.name,
		base_url: baseUrl,
		scope: reading.scope,
		credential: reading.credential,
		credential_source: reading.credentialSource,
		credential_tail: reading.credentialTail,
		currency: displayCurrency(site),
		remaining: roundAmount(amounts.remaining),
		used: roundAmount(amounts.used),
		total: roundAmount(amounts.total),
		checked_at: new Date().toISOString(),
		access_until: reading.accessUntil > 0 ? new Date(reading.accessUntil * 1000).toISOString() : '',
	}
	if (reading.unlimited === true) value.unlimited = true
	if (reading.account !== undefined) value.account = reading.account
	if (reading.group !== undefined) value.group = reading.group
	if (reading.requestCount !== undefined) value.request_count = reading.requestCount
	// /api/usage/token/ 直接给了令牌名，就不用再去令牌表反查。
	if (reading.name !== undefined) value.credential_name = reading.name
	// 令牌被授权查用户额度时，同一份响应里还带着账户额度，折算好备用。
	if (reading.userQuota !== undefined) {
		value.account_quota = {
			remaining: roundAmount(toDisplayAmount(reading.userQuota.available, site)),
			used: roundAmount(toDisplayAmount(reading.userQuota.used, site)),
			total: roundAmount(toDisplayAmount(reading.userQuota.available + reading.userQuota.used, site)),
		}
	}
	return value
}

/** 用账号凭据列一次令牌表，只为把 sk- 对上「key 名」。拿不到就返回 undefined。 */
async function readTokenList(baseUrl, accountCredential, options) {
	if (accountCredential === undefined) return undefined
	const cached = tokenListCache.get(baseUrl)
	if (cached !== undefined && Date.now() - cached.at < SITE_STATUS_TTL_MS) return cached.items
	try {
		const { payload } = await requestJson(`${baseUrl}/api/token/?p=1&page_size=100`, accountCredential.value, options)
		if (payload?.success !== true) return undefined
		const items = Array.isArray(payload.data?.items) ? payload.data.items : []
		tokenListCache.set(baseUrl, { at: Date.now(), items })
		return items
	} catch {
		return undefined
	}
}

/** 站点的 key 是「前四位 + 星号 + 后四位」，用后四位匹配即可拿到名字。 */
function matchKeyName(items, credentialValue) {
	const tail = credentialValue.slice(-4)
	const hit = items?.find((item) => typeof item.key === 'string' && item.key.endsWith(tail))
	return nonEmptyText(hit?.name)
}

/**
 * 查一个通道。channel 是 'account' 或 'key'；凭据缺失或查询失败都抛出可读的错误。
 */
async function readChannel(config, channel, timeoutMs, request, slots) {
	const requestedBaseUrl = nonEmptyText(request.baseUrl)
	if (requestedBaseUrl !== undefined && request.credential === undefined) {
		throw new Error('指定 base_url 时必须同时给凭据：否则配置里的凭据会被发到另一个站点')
	}
	const baseUrl = normalizeBaseUrl(requestedBaseUrl ?? config.baseUrl)
	const options = { signal: request.signal, timeoutMs, deadline: Date.now() + timeoutMs }

	let credential = request.credential
	if (credential === undefined) {
		if (channel === 'account') credential = slots.account
		else if (channel === 'key') credential = slots.key
		else credential = slots.account ?? slots.key
	}
	if (credential === undefined) throw new Error(missingCredentialMessage(channel))

	// 凭据类型决定走哪条接口，而不是看它被放在哪个槽里。
	let reading
	if (credential.value.startsWith('sk-')) {
		try {
			reading = await queryKey(baseUrl, credential, options)
		} catch (error) {
			// 自动认领来的 key 可能根本不属于这个站点，要说明白而不是只丢一句 401。
			if (credential.source === '自动检测') {
				const detail = error instanceof Error ? error.message : String(error)
				throw new Error(
					`自动检测到的 key 不属于这个站点或已失效（${hostOf(baseUrl)}）：${detail}；可在设置页关掉自动检测并手动填一条`,
				)
			}
			throw error
		}
	} else {
		reading = await queryAccount(baseUrl, credential, options)
	}
	const site = await readSiteStatus(baseUrl, credential.value, options)
	const value = toBalanceValue(reading, site, baseUrl)
	// 用户问「余额」通常指账户余额：只有 key 可用但它被授权时，按账户口径回答。
	if (channel === 'auto' && value.scope === 'token') {
		const accountView = asAccountValue(value)
		if (accountView !== undefined) return accountView
	}
	if (value.credential_name !== undefined) {
		// /api/usage/token/ 已经给了令牌名，直接用。
	} else if (value.scope === 'account') {
		// 账户口径本来就带用户名，直接拿来当标签。
		value.credential_name = value.account
	} else {
		// key 口径没有名字，用账号凭据查令牌表按末四位匹配；查不到就退回末四位。
		const items = await readTokenList(baseUrl, slots.account, options)
		value.credential_name = matchKeyName(items, credential.value) ?? `…${value.credential_tail}`
	}
	return value
}

/** 把「被授权的 key 读数」提升成账户口径读数；没被授权就返回 undefined。 */
function asAccountValue(keyValue) {
	if (keyValue?.account_quota === undefined) return undefined
	const value = {
		...keyValue,
		scope: 'account',
		remaining: keyValue.account_quota.remaining,
		used: keyValue.account_quota.used,
		total: keyValue.account_quota.total,
	}
	// 令牌的「不限额」说的是 key，不是账户，别带到账户口径上。
	delete value.unlimited
	delete value.account_quota
	return value
}

/** 同时读两个通道：任一失败只影响自己那一侧，另一侧照常显示。 */
async function readBoth(config, timeoutMs, services) {
	const slots = await resolveCredentials(config, services)
	const baseUrl = normalizeBaseUrl(config.baseUrl)
	const timeout = { signal: undefined, timeoutMs }
	const result = {
		ok: false,
		base_url: baseUrl,
		configured: slots.account !== undefined || slots.key !== undefined,
	}

	const attempt = async (channel) => {
		try {
			return { value: await readChannel(config, channel, timeoutMs, timeout, slots) }
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) }
		}
	}
	const [account, key] = await Promise.all([attempt('account'), attempt('key')])
	if (account.value !== undefined) {
		result.account = account.value
	} else if (key.value !== undefined && key.value.account_quota !== undefined) {
		// 令牌被授权查用户额度时，key 通道本身就带着账户额度——用它填账户那一侧。
		result.account = asAccountValue(key.value)
		result.accountFromKey = true
	} else {
		result.accountError = account.error ?? missingCredentialMessage('account')
	}
	if (key.value !== undefined) result.key = key.value
	else result.keyError = key.error ?? missingCredentialMessage('key')
	result.ok = account.value !== undefined || key.value !== undefined
	if (result.ok) {
		const primary = account.value ?? key.value
		result.site = primary.site
		result.currency = primary.currency
		result.checked_at = primary.checked_at
	}
	return result
}

/**
 * 浏览器侧读的合并读数。失败也缓存 30 秒，避免站点挂掉时被轮询打爆；
 * 手动刷新走 ?force=1 绕过缓存。
 */
async function readSummary(config, timeoutMs, force, services) {
	const fresh = Date.now() - summaryCache.at < SUMMARY_TTL_MS
	if (force !== true && summaryCache.payload !== undefined && fresh) return summaryCache.payload
	if (summaryCache.inFlight !== undefined) return summaryCache.inFlight
	summaryCache.inFlight = (async () => {
		try {
			summaryCache.payload = await readBoth(config, timeoutMs, services)
		} catch (error) {
			summaryCache.payload = { ok: false, error: error instanceof Error ? error.message : String(error) }
		} finally {
			summaryCache.at = Date.now()
			summaryCache.inFlight = undefined
		}
		return summaryCache.payload
	})()
	return summaryCache.inFlight
}

/** 写 JSON 响应；调用方只管给数据。 */
function sendJson(res, status, payload, method) {
	const body = JSON.stringify(payload)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body),
	})
	if (method === 'HEAD') {
		res.end()
		return
	}
	res.end(body)
}

/**
 * 只接受回环 Host。防的是 DNS rebinding：外部域名解析到 127.0.0.1 时，
 * 浏览器会把请求当同源发过来，Host 校验是这种场景下唯一可靠的一道关。
 */
function isLocalHost(req) {
	const host = String(req.headers?.host ?? '').toLowerCase()
	if (host === '') return false
	const name = host.replace(/:\d+$/, '')
	return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/** 只接受同源请求：别的页面即使知道回环地址，也不能改写本站的密钥与站点地址。 */
function isSameOrigin(req) {
	const origin = req.headers?.origin
	if (origin === undefined) return true
	try {
		return new URL(origin).host === req.headers?.host
	} catch {
		return false
	}
}

/** 限时读完 JSON 请求体，避免畸形请求把 handler 挂住。 */
function readJsonBody(req, limitBytes = 64 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks = []
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > limitBytes) {
				reject(new Error('请求体过大'))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => {
			if (chunks.length === 0) {
				resolve({})
				return
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
			} catch {
				reject(new Error('请求体不是合法 JSON'))
			}
		})
		req.on('error', reject)
	})
}

/** 注册 UI 轮询用的只读路由。 */
function registerSummaryRoute(webServer, config, timeoutMs, services) {
	return webServer.register({
		kind: 'exact',
		path: SUMMARY_ROUTE,
		handler: (req, res) => {
			if (req.method !== 'GET' && req.method !== 'HEAD') {
				res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
				res.end('Method Not Allowed')
				return
			}
			if (isLocalHost(req) !== true) {
				res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
				res.end('Forbidden')
				return
			}
			const force = (req.url ?? '').includes('force=1')
			void readSummary(config, timeoutMs, force, services).then((payload) => {
				sendJson(res, 200, payload, req.method)
			})
		},
	})
}

/** 某个槽的状态描述：有没有配、来自哪里、末四位。 */
function describeSlot(slot, writable) {
	return {
		configured: slot !== undefined,
		source: slot?.source ?? '',
		tail: slot === undefined ? '' : credentialTail(slot.value),
		writable,
	}
}

/** 设置页读的配置快照：永远不含完整密钥，只给来源与末四位。 */
async function describeConfig(config, timeoutMs, services) {
	const slots = await resolveCredentials(config, services)
	const writable = services.credentials !== undefined
	return {
		ok: true,
		baseUrl: normalizeBaseUrl(config.baseUrl),
		timeoutMs,
		settings: readSettings(config),
		credentials: {
			account: describeSlot(slots.account, writable),
			key: describeSlot(slots.key, writable),
		},
		canSaveConfig: services.configEditor !== undefined && services.entry !== undefined,
	}
}

/**
 * 写回设置页提交的值。
 * 密钥进 credentials 记录（按 DSH 规范，密钥不写进配置文件），站点地址与个性化进插件配置。
 * 先写密钥再写配置：写配置会让插件重启，重启后新密钥必须已经就位。
 */
async function saveConfig(body, services) {
	const nextBaseUrl = nonEmptyText(body.baseUrl)
	if (nextBaseUrl !== undefined && !/^https?:\/\//i.test(nextBaseUrl)) {
		throw new Error('站点地址要以 http:// 或 https:// 开头')
	}
	const rawTimeout = body.timeoutMs
	const nextTimeout = rawTimeout === undefined || rawTimeout === null || rawTimeout === ''
		? undefined
		: Number(rawTimeout)
	if (nextTimeout !== undefined
		&& (!Number.isFinite(nextTimeout) || nextTimeout < 3000 || nextTimeout > 120000)) {
		throw new Error('超时要在 3000 到 120000 毫秒之间')
	}
	if (body.surface !== undefined && !SURFACES.includes(body.surface)) {
		throw new Error('显示位置只能是 both / avatar / bottom / hidden')
	}
	if (body.detail !== undefined && !DETAIL_LEVELS.includes(body.detail)) {
		throw new Error('信息密度只能是 compact / standard / detailed')
	}
	if (body.accent !== undefined && !ACCENTS.includes(body.accent)) {
		throw new Error('强调色只能是 auto / brand / success / warn')
	}

	// accessToken 落账户槽，apiKey 落 key 槽；null 表示清除，缺省表示不改。
	const writes = [
		[CREDENTIAL_SLOTS.account[0], body.accessToken, '账户访问令牌'],
		[CREDENTIAL_SLOTS.key[0], body.apiKey, 'api key'],
	]
	for (const [recordKey, input, label] of writes) {
		if (input === undefined || (input !== null && nonEmptyText(input) === undefined)) {
			if (input !== null) continue
		}
		if (services.credentials === undefined) throw new Error('这个 profile 没有凭据存储，无法保存密钥')
		if (input === null) {
			await services.credentials.deleteRecord(recordKey)
			continue
		}
		const value = nonEmptyText(input)
		if (value === undefined) throw new Error(`${label}不能是空的`)
		await services.credentials.modifyRecord(recordKey, async () => ({ kind: 'api-key', key: value }))
	}

	const patch = {}
	if (nextBaseUrl !== undefined) patch.baseUrl = nextBaseUrl
	if (nextTimeout !== undefined) patch.timeoutMs = nextTimeout
	if (body.surface !== undefined) patch.surface = body.surface
	if (body.detail !== undefined) patch.detail = body.detail
	if (body.accent !== undefined) patch.accent = body.accent
	if (typeof body.showIcon === 'boolean') patch.showIcon = body.showIcon
	if (body.refreshSeconds !== undefined) {
		patch.refreshSeconds = Math.round(clampNumber(body.refreshSeconds, 15, 600, DEFAULT_SETTINGS.refreshSeconds))
	}
	if (body.lowBalanceAccount !== undefined) {
		patch.lowBalanceAccount = Math.max(clampNumber(body.lowBalanceAccount, 0, 1e9, 0), 0)
	}
	if (body.lowBalanceKey !== undefined) {
		patch.lowBalanceKey = Math.max(clampNumber(body.lowBalanceKey, 0, 1e9, 0), 0)
	}
	if (typeof body.autoDetectKey === 'boolean') patch.autoDetectKey = body.autoDetectKey
	if (Object.keys(patch).length > 0) {
		if (services.configEditor === undefined || services.entry === undefined) {
			throw new Error('这个 profile 不支持从界面保存插件配置')
		}
		await services.configEditor.edit(services.entry, (current) => ({ ...current, ...patch }))
	}

	summaryCache.payload = undefined
	summaryCache.at = 0
}

/** 设置页的读写路由：GET 读快照，POST 写回；只接受本机同源请求。 */
function registerConfigRoute(webServer, config, timeoutMs, services) {
	return webServer.register({
		kind: 'exact',
		path: CONFIG_ROUTE,
		handler: (req, res) => {
			void (async () => {
				try {
					if (isLocalHost(req) !== true) {
						sendJson(res, 403, { ok: false, error: '只接受本机访问' }, req.method)
						return
					}
					if (req.method === 'GET' || req.method === 'HEAD') {
						sendJson(res, 200, await describeConfig(config, timeoutMs, services), req.method)
						return
					}
					if (req.method !== 'POST') {
						sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, req.method)
						return
					}
					if (isSameOrigin(req) !== true) {
						sendJson(res, 403, { ok: false, error: '只接受本站页面发起的保存' }, req.method)
						return
					}
					await saveConfig(await readJsonBody(req), services)
					// 写配置会让插件重启，这里不读回配置，让界面重新 GET 一次。
					sendJson(res, 200, { ok: true }, req.method)
				} catch (error) {
					sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }, req.method)
				}
			})()
		},
	})
}

/**
 * 一键授权：用账号访问令牌把「当前这条 api key」的 `allow_user_quota_query` 打开。
 * 之后这条 sk- 就能直接查到账户余额，访问令牌可以删掉。
 * 只改这一个字段：其余字段沿用站点里的现值，不会动到额度、模型限制、IP 白名单。
 */
async function authorizeCurrentKey(config, timeoutMs, services) {
	const slots = await resolveCredentials(config, services)
	if (slots.account === undefined) throw new Error('需要先在设置页配置访问令牌，才能改站点的令牌设置')
	if (slots.key === undefined) throw new Error('还没有可用的 api key')
	const baseUrl = normalizeBaseUrl(config.baseUrl)
	const options = { signal: undefined, timeoutMs, deadline: Date.now() + timeoutMs }
	const tail = slots.key.value.slice(-4)
	// 名单必须现取：缓存里可能是改之前的旧值。
	const { payload } = await requestJson(`${baseUrl}/api/token/?p=1&page_size=100`, slots.account.value, options)
	if (payload?.success !== true) {
		throw new Error(`读取令牌列表失败（${hostOf(baseUrl)}）：访问令牌可能没有权限`)
	}
	const items = Array.isArray(payload.data?.items) ? payload.data.items : []
	const hit = items.find((item) => typeof item.key === 'string' && item.key.endsWith(tail))
	if (hit === undefined) {
		throw new Error(`账号的令牌列表里没有末四位 ${tail} 的 key：它可能属于另一个账号，或已被删除`)
	}
	const name = nonEmptyText(hit.name) ?? `…${tail}`
	if (hit.allow_user_quota_query === true) return { ok: true, already: true, name }
	const update = await requestJson(`${baseUrl}/api/token/`, slots.account.value, {
		...options,
		method: 'PUT',
		body: {
			id: hit.id,
			name: hit.name,
			expired_time: hit.expired_time,
			remain_quota: hit.remain_quota,
			unlimited_quota: hit.unlimited_quota === true,
			model_limits_enabled: hit.model_limits_enabled === true,
			model_limits: hit.model_limits ?? '',
			allow_ips: hit.allow_ips ?? '',
			group: hit.group ?? '',
			cross_group_retry: hit.cross_group_retry === true,
			allow_user_quota_query: true,
		},
	})
	if (update.payload?.success !== true) {
		throw new Error(nonEmptyText(update.payload?.message) ?? '站点拒绝了这次修改')
	}
	tokenListCache.delete(baseUrl)
	summaryCache.payload = undefined
	summaryCache.at = 0
	return { ok: true, already: false, name }
}

/** 一键授权路由：只接受本机同源 POST。 */
function registerAuthorizeRoute(webServer, config, timeoutMs, services) {
	return webServer.register({
		kind: 'exact',
		path: AUTHORIZE_ROUTE,
		handler: (req, res) => {
			void (async () => {
				try {
					if (isLocalHost(req) !== true) {
						sendJson(res, 403, { ok: false, error: '只接受本机访问' }, req.method)
						return
					}
					if (req.method !== 'POST') {
						sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, req.method)
						return
					}
					if (isSameOrigin(req) !== true) {
						sendJson(res, 403, { ok: false, error: '只接受本站页面发起的操作' }, req.method)
						return
					}
					sendJson(res, 200, await authorizeCurrentKey(config, timeoutMs, services), req.method)
				} catch (error) {
					sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }, req.method)
				}
			})()
		},
	})
}

/** 工具与命令共用的纯文本渲染。 */
function renderBalance(value) {
	const scopeLabel = value.scope === 'account' ? '账户余额' : 'key 额度'
	const unit = value.currency === 'TOKENS' ? 'tokens' : value.currency
	const credentialLabel = value.credential === 'api_key' ? 'api key' : '访问令牌'
	const name = value.credential_name === undefined ? '' : `「${value.credential_name}」`
	const credentialLine = `凭据：${credentialLabel}${name} …${value.credential_tail}，来自${value.credential_source}`
	if (value.unlimited === true) {
		return [
			`${value.site} ${scopeLabel}（${unit}）`,
			'无限制：这个 key 没有设额度上限，站点不提供可用额度',
			credentialLine,
			`站点：${value.base_url}　查询时间：${formatTimestamp(value.checked_at)}`,
		].join('\n')
	}
	const lines = [
		`${value.site} ${scopeLabel}（${unit}）`,
		`剩余：${formatAmount(value.remaining, value.currency)}`,
		`已用：${formatAmount(value.used, value.currency)}　总额：${formatAmount(value.total, value.currency)}（＝剩余＋已用，站点未直接提供）`,
	]
	const details = []
	if (value.account !== undefined) details.push(`账号：${value.account}`)
	if (value.group !== undefined) details.push(`分组：${value.group}`)
	if (value.request_count !== undefined) details.push(`请求数：${value.request_count}`)
	if (details.length > 0) lines.push(details.join('　'))
	lines.push(credentialLine)
	if (value.access_until !== undefined && value.access_until !== '') {
		lines.push(`凭据到期：${formatTimestamp(value.access_until)}`)
	}
	lines.push(`站点：${value.base_url}　查询时间：${formatTimestamp(value.checked_at)}`)
	return lines.join('\n')
}

const parameters = {
	type: 'object',
	additionalProperties: false,
	properties: {
		channel: {
			type: 'string',
			enum: CHANNELS,
			description: 'account reads the whole account balance through an access token; key reads the quota of one api key; auto prefers the account.',
		},
		key: {
			type: 'string',
			description: 'Credential to use instead of the configured one: an access token or an api key (sk-...). Prefer the plugin config or settings page, because a value passed here is recorded in the conversation.',
		},
		base_url: {
			type: 'string',
			description: 'Relay base URL without /v1. Only accepted together with key, so a call cannot send the configured credential to another site.',
		},
	},
}

const output = {
	schema: {
		type: 'object',
		additionalProperties: false,
		required: ['site', 'base_url', 'scope', 'credential', 'credential_source', 'credential_tail', 'currency', 'remaining', 'used', 'total', 'checked_at'],
		properties: {
			site: { type: 'string', description: 'Relay display name reported by the site.' },
			base_url: { type: 'string', description: 'Relay base URL that was queried.' },
			scope: {
				type: 'string',
				enum: ['token', 'account'],
				description: 'What the amount describes: the quota of one api key, or the whole account balance.',
			},
			credential: { type: 'string', enum: ['api_key', 'access_token'], description: 'Which relay credential answered.' },
			credential_source: { type: 'string', description: 'Where the credential came from: settings page, plugin config, secret.json, or environment.' },
			credential_tail: { type: 'string', description: 'Last four characters of the credential, so the credential being reported is identifiable.' },
			credential_name: {
				type: 'string',
				description: 'Human label for the credential: the account name for an access token, or the token name from the site token list for an api key.',
			},
			currency: { type: 'string', enum: ['CNY', 'USD', 'TOKENS'], description: 'Unit the site displays quota in.' },
			remaining: { type: 'number', description: 'Credit left, in the display currency. Negative means overdrawn. Zero for an unlimited key.' },
			used: { type: 'number', description: 'Credit already spent, in the display currency. Zero for an unlimited key.' },
			total: { type: 'number', description: 'Remaining plus used. Derived here; the site does not report a total for an access token.' },
			unlimited: { type: 'boolean', description: 'Present and true when the api key has no quota limit.' },
			account: { type: 'string', description: 'Account name, present for an access token.' },
			group: { type: 'string', description: 'Account group, present for an access token.' },
			request_count: { type: 'integer', description: 'Lifetime request count, present for an access token.' },
			access_until: { type: 'string', description: 'Expiry as an ISO timestamp, or empty when the credential never expires.' },
			checked_at: { type: 'string', description: 'When this reading was taken, as an ISO timestamp.' },
		},
	},
	render(_args, value) {
		return [{ type: 'text', text: renderBalance(value) }]
	},
}

export function apply(ctx, rawConfig) {
	const config = rawConfig ?? {}
	const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS
	// credentials 存密钥，configEditor 写回插件配置；两者缺失时只是少了设置页的写能力。
	const services = {
		credentials: ctx.get('credentials'),
		configEditor: ctx.get('configEditor'),
		entry: ctx.fiber?.entry,
	}

	ctx.effect(() => ctx.tools.register({
		name: 'relay_balance',
		description: 'Check how much credit is left on a 大白饭 (白饭API, new-api) relay account, in the site display currency. Reads the whole account balance through an access token, or the quota of one api key, and reports whether the amount is the account or a single key.',
		parameters,
		output,
		// 声明的是整次查询的预算，与实现里的统一 deadline 一致。
		timeoutMs,
		async execute(args, exec) {
			const slots = await resolveCredentials(config, services)
			const explicit = nonEmptyText(args.key) === undefined
				? undefined
				: { value: nonEmptyText(args.key), source: '工具参数' }
			return readChannel(config, args.channel ?? 'auto', timeoutMs, {
				signal: exec.signal,
				baseUrl: args.base_url,
				credential: explicit,
			}, slots)
		},
	}), 'baifan-balance: relay_balance tool')

	// 浏览器面板轮询的只读路由与设置页的读写路由；没有 webServer 的部署只是少了界面。
	const webServer = ctx.get('webServer')
	if (webServer !== undefined) {
		ctx.effect(() => registerSummaryRoute(webServer, config, timeoutMs, services), 'baifan-balance: summary route')
		ctx.effect(() => registerConfigRoute(webServer, config, timeoutMs, services), 'baifan-balance: config route')
		ctx.effect(() => registerAuthorizeRoute(webServer, config, timeoutMs, services), 'baifan-balance: authorize route')
	}

	// 斜杠命令是「不靠模型猜」的入口；commands 服务缺失时只少这个入口。
	const commands = ctx.get('commands')
	if (commands !== undefined) {
		ctx.effect(() => commands.register({
			name: 'balance',
			description: '查询大白饭中转站余额',
			input: { hint: 'account | key' },
			handler: async ({ rawInput, signal }) => {
				// /balance 默认自动选口径；也可以显式给 account 或 key。
				const argument = (nonEmptyText(rawInput) ?? 'auto').toLowerCase()
				const channel = argument === 'account' || argument === 'token'
					? 'account'
					: (argument === 'key' ? 'key' : (argument === 'auto' ? 'auto' : undefined))
				if (channel === undefined) {
					return { kind: 'error', text: '/balance 只接受 account 或 key 参数（不带参数＝自动选择）' }
				}
				try {
					const slots = await resolveCredentials(config, services)
					const value = await readChannel(config, channel, timeoutMs, { signal }, slots)
					return { kind: 'success', text: renderBalance(value) }
				} catch (error) {
					return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
				}
			},
		}), 'baifan-balance: /balance command')
	}
}
