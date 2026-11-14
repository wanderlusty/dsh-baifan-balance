// dsh-baifan-balance：给 DSH 加一个「查余额」工具 + 一个 /balance 斜杠命令（Host 侧）。
//
// 它只做一件事：用一份凭据查一次中转站的额度，再折算成站点自己展示的货币。
// 两条通道对应 new-api 的两类凭据，算法与站点后端保持一致：
//   - sk- 推理密钥  → GET /v1/dashboard/billing/subscription + /usage
//     （见 new-api controller/billing.go：*_USD 字段实际是「站点展示单位」）
//   - 访问令牌      → GET /api/user/self，拿到的是内部 quota，需要自己折算
// 折算用的 quota_per_unit / quota_display_type / usd_exchange_rate 来自公开的
// /api/status，按站点缓存几分钟，避免每次查询多打一次接口。
//
// 两条硬规则，都是从评审里补回来的：
//   1. 宁可报错，也不要把解析失败当成 0——「剩余 ¥0.00」比查不到更糟。
//   2. 传了 base_url 就必须同时传 key，否则配置里的凭据会被送到别的站点去。
//
// 插件不引入任何 @deepseek-ai/* 依赖：直接构造注册表接受的 JSON Schema 定义，
// 因此在 profile 里以本地目录链接安装时不需要额外的模块解析。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名。 */
export const name = 'baifan-balance'

/** 依赖的 Host 服务。commands 是可选的，用 ctx.get 探测，缺失时只少一个入口。 */
export const inject = ['tools']

/** 包根目录（lib/ 的上一级），用于找本地 secret.json。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const DEFAULT_BASE_URL = 'https://baifanapi.awstme.top'
const DEFAULT_TIMEOUT_MS = 15000
const SITE_STATUS_TTL_MS = 5 * 60 * 1000
/** 浏览器侧轮询的摘要路由；30 秒内复用，避免多个面板各拉一次站点。 */
const SUMMARY_ROUTE = '/baifan-balance/summary'
const SUMMARY_TTL_MS = 30 * 1000
/** 设置页读写配置的路由，以及密钥在 credentials 存储里的记录地址。 */
const CONFIG_ROUTE = '/baifan-balance/config'
const CREDENTIAL_KEY = 'baifan-balance/relay-key'

/** 个性化默认值：显示位置、刷新节奏、信息密度、图标、强调色、低余额阈值。 */
const DEFAULT_SETTINGS = {
	surface: 'both',
	refreshSeconds: 60,
	detail: 'standard',
	showIcon: true,
	accent: 'auto',
	lowBalance: 0,
}
const SURFACES = ['both', 'avatar', 'bottom', 'hidden']
const DETAIL_LEVELS = ['compact', 'standard', 'detailed']
const ACCENTS = ['auto', 'brand', 'success', 'warn']

function clampNumber(value, min, max, fallback) {
	const parsed = Number(value)
	if (!Number.isFinite(parsed)) return fallback
	return Math.min(Math.max(parsed, min), max)
}

/** 把配置里的个性化字段归一化，非法值一律退回默认值，界面不会因为脏数据崩掉。 */
function readSettings(config) {
	return {
		surface: SURFACES.includes(config.surface) ? config.surface : DEFAULT_SETTINGS.surface,
		refreshSeconds: Math.round(clampNumber(
			config.refreshSeconds, 15, 600, DEFAULT_SETTINGS.refreshSeconds,
		)),
		detail: DETAIL_LEVELS.includes(config.detail) ? config.detail : DEFAULT_SETTINGS.detail,
		showIcon: config.showIcon !== false,
		accent: ACCENTS.includes(config.accent) ? config.accent : DEFAULT_SETTINGS.accent,
		lowBalance: Math.max(clampNumber(config.lowBalance, 0, 1e9, DEFAULT_SETTINGS.lowBalance), 0),
	}
}

/** 站点展示参数缓存：baseUrl → { at, value }。 */
const siteStatusCache = new Map()

/** 余额摘要缓存，供 UI 轮询与手动刷新共用。 */
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

/** 本地凭据文件：与本插件同目录的 secret.json，形如 {"token":"..."}。 */
function readSecretFile() {
	const path = join(PACKAGE_ROOT, 'secret.json')
	if (!existsSync(path)) return undefined
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'))
		return nonEmptyText(parsed.token) ?? nonEmptyText(parsed.key)
	} catch {
		return undefined
	}
}

/** 从 credentials 记录里取「设置页保存的那份密钥」；没装 credentials 服务时就是没有。 */
async function readStoredKey(credentials) {
	if (credentials === undefined) return undefined
	try {
		const record = await credentials.readRecord(CREDENTIAL_KEY)
		return record?.kind === 'api-key' ? nonEmptyText(record.key) : undefined
	} catch {
		return undefined
	}
}

/**
 * 凭据优先级：调用参数 > 插件配置 > 设置页保存的记录 > 本地 secret.json > 显式环境变量 > 站点默认提供商密钥。
 * 最具体的排最前；设置页存在记录时它就压过 secret.json，否则改完设置会看起来没生效。
 * 连来源一起返回，结果里要报出来——配错了能当场看出查的是哪个凭据。
 */
async function resolveCredential(config, override, credentials) {
	const fromArgument = nonEmptyText(override)
	if (fromArgument !== undefined) return { value: fromArgument, source: '工具参数' }
	const fromConfig = nonEmptyText(config.key) ?? nonEmptyText(config.token) ?? nonEmptyText(config.accessToken)
	if (fromConfig !== undefined) return { value: fromConfig, source: '插件配置' }
	const fromStore = await readStoredKey(credentials)
	if (fromStore !== undefined) return { value: fromStore, source: '设置页' }
	const fromFile = readSecretFile()
	if (fromFile !== undefined) return { value: fromFile, source: 'secret.json' }
	const fromEnvironment = nonEmptyText(process.env.BAIFAN_BALANCE_TOKEN)
		?? nonEmptyText(process.env.NEWAPI_ACCESS_TOKEN)
		?? nonEmptyText(process.env.DABAIFAN_API_KEY)
	if (fromEnvironment !== undefined) return { value: fromEnvironment, source: '环境变量' }
	return undefined
}

/** 剩余时间：整个查询共用一个预算，而不是每个请求各自 15 秒。 */
function remainingBudget(options) {
	const left = options.deadline - Date.now()
	return left > 0 ? left : 0
}

/** 发一次 GET 并解析 JSON；超时、取消、连不上都翻译成能看懂的一句话。 */
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
			response = await fetch(url, {
				headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
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

/** 凭据尾号：让用户能确认「这是哪个 key 的钱」，又不把整串密钥写进会话日志。 */
function credentialTail(credential) {
	return credential.length <= 4 ? '****' : credential.slice(-4)
}

/** 访问令牌通道：拿到的是内部 quota，要先折算。 */
async function queryByAccessToken(baseUrl, token, options) {
	const { status, payload } = await requestJson(`${baseUrl}/api/user/self`, token, options)
	if (status === 401 || payload?.success === false) {
		throw new Error(`访问令牌无效或已过期（${hostOf(baseUrl)}）：请更新插件配置里的 key`)
	}
	const data = payload?.data ?? {}
	if (data.quota === undefined) {
		throw new Error(`${hostOf(baseUrl)} 没有返回 quota 字段：这个地址可能不是 new-api 站点，或站点地址多带了路径`)
	}
	return {
		credential: 'access_token',
		account: nonEmptyText(data.username) ?? nonEmptyText(data.display_name),
		group: nonEmptyText(data.group),
		remainingQuota: requireNumber(data.quota, 'quota'),
		usedQuota: requireNumber(data.used_quota ?? 0, 'used_quota'),
		requestCount: requireNumber(data.request_count ?? 0, 'request_count'),
		accessUntil: 0,
	}
}

/** new-api 用 100000000 表示「令牌不限额」，不是真的余额，必须单独识别。 */
const UNLIMITED_SENTINEL = 100000000

/** 推理密钥通道：billing 接口返回的已经是展示单位。 */
async function queryByApiKey(baseUrl, token, options) {
	const subscription = await requestJson(`${baseUrl}/v1/dashboard/billing/subscription`, token, options)
	if (subscription.status === 401 || subscription.payload?.error !== undefined) {
		throw new Error(`推理密钥无效或已过期（${hostOf(baseUrl)}）：请更新插件配置里的 key`)
	}
	const total = requireNumber(subscription.payload?.hard_limit_usd, 'hard_limit_usd')
	if (total >= UNLIMITED_SENTINEL) {
		// 无限额度令牌没有可报告的余额，硬报一个数字只会误导人。
		return { credential: 'api_key', unlimited: true, remaining: 0, used: 0, total: 0, accessUntil: 0 }
	}
	const usage = await requestJson(`${baseUrl}/v1/dashboard/billing/usage`, token, options)
	if (usage.payload?.error !== undefined) {
		throw new Error(`用量接口返回错误（${hostOf(baseUrl)}）：请稍后重试或联系站点管理员`)
	}
	const used = requireNumber(usage.payload?.total_usage, 'total_usage') / 100
	// 不夹到 0：透支是信息，抹平会让人以为刚好用完。
	return {
		credential: 'api_key',
		total,
		used,
		remaining: total - used,
		accessUntil: Number(subscription.payload?.access_until) || 0,
	}
}

/**
 * 两类凭据都试一遍：先试更可能的那个，失败再换另一条通道。
 * 两条都失败时抛第一条，它是与凭据形态最匹配的那条诊断。
 */
async function queryRelayBalance(baseUrl, credential, options) {
	const order = credential.startsWith('sk-')
		? ['api_key', 'access_token']
		: ['access_token', 'api_key']
	let preferredFailure
	for (const kind of order) {
		try {
			return kind === 'api_key'
				? await queryByApiKey(baseUrl, credential, options)
				: await queryByAccessToken(baseUrl, credential, options)
		} catch (error) {
			preferredFailure ??= error
		}
	}
	throw preferredFailure
}

/** 查一次余额，返回结构化的读数。工具、斜杠命令、UI 与设置页共用。 */
async function readBalance(config, timeoutMs, request, services) {
	const requestedBaseUrl = nonEmptyText(request.baseUrl)
	if (requestedBaseUrl !== undefined && nonEmptyText(request.key) === undefined) {
		throw new Error('指定 base_url 时必须同时给 key：否则配置里的凭据会被发到另一个站点')
	}
	const baseUrl = normalizeBaseUrl(requestedBaseUrl ?? config.baseUrl)
	const resolved = await resolveCredential(config, request.key, services.credentials)
	if (resolved === undefined) {
		throw new Error('还没有配置密钥：打开 头像 → 设置 → 大白饭余额，填入 sk- 推理密钥或访问令牌')
	}
	const options = { signal: request.signal, timeoutMs, deadline: Date.now() + timeoutMs }
	const reading = await queryRelayBalance(baseUrl, resolved.value, options)
	const site = await readSiteStatus(baseUrl, resolved.value, options)
	const amounts = reading.credential === 'api_key'
		? { remaining: reading.remaining, used: reading.used, total: reading.total }
		: {
			remaining: toDisplayAmount(reading.remainingQuota, site),
			used: toDisplayAmount(reading.usedQuota, site),
			total: toDisplayAmount(reading.remainingQuota + reading.usedQuota, site),
		}
	const value = {
		site: site.name,
		base_url: baseUrl,
		credential: reading.credential,
		// 两种凭据查的不是同一件东西：sk- 是「这个令牌的额度」，访问令牌是「账户余额」。
		scope: reading.credential === 'api_key' ? 'token' : 'account',
		credential_source: resolved.source,
		credential_tail: credentialTail(resolved.value),
		currency: displayCurrency(site),
		remaining: roundAmount(amounts.remaining),
		used: roundAmount(amounts.used),
		total: roundAmount(amounts.total),
		checked_at: new Date().toISOString(),
	}
	if (reading.account !== undefined) value.account = reading.account
	if (reading.group !== undefined) value.group = reading.group
	if (reading.requestCount !== undefined) value.request_count = reading.requestCount
	if (reading.unlimited === true) value.unlimited = true
	value.access_until = reading.accessUntil > 0 ? new Date(reading.accessUntil * 1000).toISOString() : ''
	return { value }
}

function renderBalance(value) {
	const scopeLabel = value.scope === 'account' ? '账户余额' : '令牌额度'
	if (value.unlimited === true) {
		const lines = [
			`${value.site} ${scopeLabel}（${value.currency === 'TOKENS' ? 'tokens' : value.currency}）`,
			'无限制：这个令牌没有设上限，站点不提供可用额度',
			`凭据：${value.credential === 'api_key' ? '推理密钥' : '访问令牌'} …${value.credential_tail}，来自${value.credential_source}`,
			`站点：${value.base_url}　查询时间：${formatTimestamp(value.checked_at)}`,
		]
		return lines.join('\n')
	}
	const lines = [
		`${value.site} ${scopeLabel}（${value.currency === 'TOKENS' ? 'tokens' : value.currency}）`,
		`剩余：${formatAmount(value.remaining, value.currency)}`,
		`已用：${formatAmount(value.used, value.currency)}　总额：${formatAmount(value.total, value.currency)}（＝剩余＋已用，站点未直接提供）`,
	]
	const details = []
	if (value.account !== undefined) details.push(`账号：${value.account}`)
	if (value.group !== undefined) details.push(`分组：${value.group}`)
	if (value.request_count !== undefined) details.push(`请求数：${value.request_count}`)
	if (details.length > 0) lines.push(details.join('　'))
	lines.push(`凭据：${value.credential === 'api_key' ? '推理密钥' : '访问令牌'} …${value.credential_tail}，来自${value.credential_source}`)
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
		key: {
			type: 'string',
			description: 'Relay API key (sk-...) or account access token to check instead of the configured one. Prefer putting a key in the plugin config instead of here, because a value passed here is recorded in the conversation.',
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
		required: ['site', 'base_url', 'credential', 'credential_source', 'credential_tail', 'currency', 'remaining', 'used', 'total', 'checked_at'],
		properties: {
			site: { type: 'string', description: 'Relay display name reported by the site.' },
			base_url: { type: 'string', description: 'Relay base URL that was queried.' },
			credential: { type: 'string', enum: ['api_key', 'access_token'], description: 'Which relay credential channel answered.' },
			scope: {
				type: 'string',
				enum: ['token', 'account'],
				description: 'What the amount describes: the quota of this one API key, or the whole account balance. An API key reports its own quota; an access token reports the account.',
			},
			credential_source: { type: 'string', description: 'Where the credential came from: tool argument, plugin config, secret.json, or environment.' },
			credential_tail: { type: 'string', description: 'Last four characters of the credential, so the account being reported is identifiable.' },
			currency: { type: 'string', enum: ['CNY', 'USD', 'TOKENS'], description: 'Unit the site displays quota in.' },
			remaining: { type: 'number', description: 'Credit left, in the display currency. Negative means overdrawn. Zero for an unlimited token.' },
			used: { type: 'number', description: 'Credit already spent, in the display currency. Zero for an unlimited token.' },
			total: { type: 'number', description: 'Remaining plus used. Derived here; the site does not report a total for an access token. Zero for an unlimited token.' },
			unlimited: { type: 'boolean', description: 'Present and true when the API key has no quota limit, so the site reports no usable balance.' },
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

/**
 * 浏览器侧读的余额摘要。失败也缓存 30 秒，避免站点挂掉时被轮询打爆；
 * 手动刷新走 ?force=1 绕过缓存。返回值里没有完整凭据，只有来源和尾号。
 */
async function readSummary(config, timeoutMs, force, services) {
	const fresh = Date.now() - summaryCache.at < SUMMARY_TTL_MS
	if (force !== true && summaryCache.payload !== undefined && fresh) return summaryCache.payload
	if (summaryCache.inFlight !== undefined) return summaryCache.inFlight
	summaryCache.inFlight = (async () => {
		try {
			const resolved = await resolveCredential(config, undefined, services.credentials)
			if (resolved === undefined) {
				// 界面要能把「还没配密钥」和「查询失败」分开显示，所以带一个 code。
				summaryCache.payload = {
					ok: false,
					code: 'no-credential',
					error: '还没有配置密钥：打开 头像 → 设置 → 大白饭余额，填入 sk- 推理密钥或访问令牌',
				}
				return summaryCache.payload
			}
			const { value } = await readBalance(config, timeoutMs, {}, services)
			summaryCache.payload = { ok: true, ...value }
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

/** 只接受同源请求：别的页面即使知道 127.0.0.1 的地址，也不能改写本站的密钥与站点地址。 */
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

/** 注册 UI 轮询用的只读路由；HEAD 只回响应头，其他方法一律 405。 */
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
				const body = JSON.stringify(payload)
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
					'content-length': Buffer.byteLength(body),
				})
				if (req.method === 'HEAD') {
					res.end()
					return
				}
				res.end(body)
			})
		},
	})
}

/** 设置页读的配置快照：永远不含完整密钥，只给来源与末四位。 */
async function describeConfig(config, timeoutMs, services) {
	const resolved = await resolveCredential(config, undefined, services.credentials)
	const stored = await readStoredKey(services.credentials)
	return {
		ok: true,
		baseUrl: normalizeBaseUrl(config.baseUrl),
		timeoutMs,
		settings: readSettings(config),
		key: {
			configured: resolved !== undefined,
			source: resolved?.source ?? '',
			tail: resolved === undefined ? '' : credentialTail(resolved.value),
			storedInSettings: stored !== undefined,
			writable: services.credentials !== undefined,
		},
		canSaveConfig: services.configEditor !== undefined && services.entry !== undefined,
	}
}

/**
 * 写回设置页提交的值。
 * 密钥进 credentials 记录（按 DSH 规范，密钥不写进配置文件），站点地址与超时进插件配置。
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

	// key 缺省＝不改，null＝清除，非空字符串＝写入。
	if (body.key === null || nonEmptyText(body.key) !== undefined) {
		if (services.credentials === undefined) throw new Error('这个 profile 没有凭据存储，无法保存密钥')
		if (body.key === null) {
			await services.credentials.deleteRecord(CREDENTIAL_KEY)
		} else {
			const value = nonEmptyText(body.key)
			await services.credentials.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'api-key', key: value }))
		}
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
	if (body.lowBalance !== undefined) {
		patch.lowBalance = Math.max(clampNumber(body.lowBalance, 0, 1e9, 0), 0)
	}
	if (Object.keys(patch).length > 0) {
		if (services.configEditor === undefined || services.entry === undefined) {
			throw new Error('这个 profile 不支持从界面保存插件配置')
		}
		await services.configEditor.edit(services.entry, (current) => ({ ...current, ...patch }))
	}

	summaryCache.payload = undefined
	summaryCache.at = 0
}

/** 设置页的读写路由：GET 读快照，POST 写回；只接受同源请求。 */
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
					const body = await readJsonBody(req)
					await saveConfig(body, services)
					// 写配置会让插件重启，这里不读回配置，让界面重新 GET 一次。
					sendJson(res, 200, { ok: true }, req.method)
				} catch (error) {
					sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }, req.method)
				}
			})()
		},
	})
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
		description: 'Check the relay site credit left on a 大白饭 (白饭API, new-api) account: the money/quota on that relay service, not the DSH account balance. Use it for questions about 余额, 额度, remaining credit, spend, or insufficient-quota errors.',
		parameters,
		output,
		// 声明的是整次查询的预算，与实现里的统一 deadline 一致。
		timeoutMs,
		async execute(args, exec) {
			const { value } = await readBalance(config, timeoutMs, {
				signal: exec.signal,
				key: args.key,
				baseUrl: args.base_url,
			}, services)
			return value
		},
	}), 'baifan-balance: relay_balance tool')

	// 浏览器面板轮询的只读路由与设置页的读写路由；没有 webServer 的部署只是少了界面。
	const webServer = ctx.get('webServer')
	if (webServer !== undefined) {
		ctx.effect(() => registerSummaryRoute(webServer, config, timeoutMs, services), 'baifan-balance: summary route')
		ctx.effect(() => registerConfigRoute(webServer, config, timeoutMs, services), 'baifan-balance: config route')
	}

	// 斜杠命令是「不靠模型猜」的入口；commands 服务缺失时只少这个入口。
	const commands = ctx.get('commands')
	if (commands !== undefined) {
		ctx.effect(() => commands.register({
			name: 'balance',
			description: '查询白饭API 中转站剩余额度',
			handler: async ({ rawInput, signal }) => {
				if (nonEmptyText(rawInput) !== undefined) {
					return { kind: 'error', text: '/balance 不接受参数；换站点或换密钥请改插件配置，避免把密钥写进会话记录。' }
				}
				try {
					const { value } = await readBalance(config, timeoutMs, { signal }, services)
					return { kind: 'success', text: renderBalance(value) }
				} catch (error) {
					return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
				}
			},
		}), 'baifan-balance: /balance command')
	}
}
