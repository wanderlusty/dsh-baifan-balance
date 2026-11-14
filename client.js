// dsh-baifan-balance 的浏览器侧：大白饭余额的显示位置、口径与外观都在这里。
//   - sidebar.footer.action       头像上方：固定显示**账户余额**（访问令牌）
//   - conversation.composer.dock  页面下方：显示**单 key 额度**（api key），没配就回退到账户
// 两个位置都常驻注册，显示与否由设置里的 surface 决定，改完立刻生效、不用刷新页面。
// 数据来自 Host 侧的 /baifan-balance/summary（一次返回两个口径）与 /baifan-balance/config。
window.__ModuleLoader__.load({
	id: 'dsh-baifan-balance',
	factory(require) {
		const React = require('react')
		const h = React.createElement
		const { useCallback, useEffect, useRef, useState } = React

		const SUMMARY_URL = '/baifan-balance/summary'
		const CONFIG_URL = '/baifan-balance/config'
		const DEFAULT_BASE_URL = 'https://baifanapi.awstme.top'

		/** 设置拿不到时的兜底，与 Host 侧 DEFAULT_SETTINGS 保持一致。 */
		const DEFAULT_SETTINGS = {
			surface: 'both',
			refreshSeconds: 60,
			detail: 'standard',
			showIcon: true,
			accent: 'auto',
			lowBalanceAccount: 5,
			lowBalanceKey: 5,
			autoDetectKey: true,
		}

		const FALLBACK = {
			'balance.loading': '查询中…',
			'balance.unavailable': '余额不可用',
			'balance.unconfigured': '未配置',
			'balance.unlimited': '无限制',
			'balance.remaining': '剩余',
			'balance.used': '已用',
			'balance.total': '总额',
			'balance.updated': '更新',
			'balance.low': '低于提醒线',
			'balance.scope.token': 'key 额度',
			'balance.scope.account': '账户余额',
			'balance.mark.token': 'key额度',
			'balance.mark.account': '账户',
		}

		function translate(t, key) {
			return typeof t === 'function' ? t(key) : (FALLBACK[key] ?? key)
		}

		function formatMoney(amount, currency) {
			if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
			if (currency === 'TOKENS') return `${Math.round(amount).toLocaleString('en-US')} tok`
			return `${currency === 'CNY' ? '¥' : '$'}${amount.toFixed(2)}`
		}

		function formatClock(iso) {
			const time = new Date(iso)
			if (Number.isNaN(time.getTime())) return ''
			return time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
		}

		/** 强调色只影响图标颜色，正文始终跟随主题。 */
		function accentOf(accent) {
			if (accent === 'brand') return 'var(--dsw-alias-brand-primary)'
			if (accent === 'success') return 'var(--dsw-alias-state-success-primary)'
			if (accent === 'warn') return 'var(--dsw-alias-state-warn-primary)'
			return 'currentColor'
		}

		// ---- 共享设置：一次取，多处用；保存后立即广播 ----
		const settingsStore = { value: undefined, inFlight: undefined, listeners: new Set() }

		function publishSettings(value) {
			settingsStore.value = value
			for (const listener of settingsStore.listeners) listener()
		}

		async function loadSettings() {
			if (settingsStore.inFlight !== undefined) return settingsStore.inFlight
			settingsStore.inFlight = (async () => {
				try {
					const response = await fetch(CONFIG_URL, { headers: { accept: 'application/json' } })
					const data = await response.json()
					publishSettings({ ...DEFAULT_SETTINGS, ...(data.ok === true ? data.settings : {}) })
				} catch {
					publishSettings(settingsStore.value ?? DEFAULT_SETTINGS)
				} finally {
					settingsStore.inFlight = undefined
				}
			})()
			return settingsStore.inFlight
		}

		/** 保存设置后由设置页调用，让两处显示立刻按新配置重绘。 */
		function refreshSettings() {
			settingsStore.value = undefined
			void loadSettings()
		}

		function useSettings() {
			const [value, setValue] = useState(settingsStore.value)
			useEffect(() => {
				const listener = () => setValue(settingsStore.value)
				settingsStore.listeners.add(listener)
				if (settingsStore.value === undefined) void loadSettings()
				return () => { settingsStore.listeners.delete(listener) }
			}, [])
			return value ?? DEFAULT_SETTINGS
		}

		// ---- 共享读数：一次取两个口径，处处同步；设置页查询也会广播 ----
		const summaryStore = { value: undefined, inFlight: undefined, listeners: new Set(), timer: undefined, period: 0 }

		function publishSummary(payload) {
			summaryStore.value = payload
			for (const listener of summaryStore.listeners) listener()
		}

		/** 拉一次读数并广播；force 绕过 Host 侧 30 秒缓存，并发请求合并成一次。 */
		function loadSummary(force) {
			if (force !== true && summaryStore.inFlight !== undefined) return summaryStore.inFlight
			const request = (async () => {
				try {
					const response = await fetch(`${SUMMARY_URL}${force === true ? '?force=1' : ''}`, {
						headers: { accept: 'application/json' },
					})
					publishSummary(await response.json())
				} catch (error) {
					publishSummary({ ok: false, error: error instanceof Error ? error.message : String(error) })
				} finally {
					summaryStore.inFlight = undefined
				}
				return summaryStore.value
			})()
			summaryStore.inFlight = request
			return request
		}

		/** 所有订阅者共用一个定时器，挂几个组件都只按一个节拍刷新。 */
		function ensureTicker(refreshSeconds) {
			const period = Math.max(refreshSeconds, 15) * 1000
			if (summaryStore.timer !== undefined && summaryStore.period === period) return
			if (summaryStore.timer !== undefined) clearInterval(summaryStore.timer)
			summaryStore.period = period
			summaryStore.timer = setInterval(() => { void loadSummary(false) }, period)
		}

		function useSummary(refreshSeconds) {
			const [payload, setPayload] = useState(summaryStore.value)
			const [busy, setBusy] = useState(false)
			useEffect(() => {
				const listener = () => setPayload(summaryStore.value)
				summaryStore.listeners.add(listener)
				ensureTicker(refreshSeconds)
				if (summaryStore.value === undefined) void loadSummary(false)
				return () => {
					summaryStore.listeners.delete(listener)
					if (summaryStore.listeners.size === 0 && summaryStore.timer !== undefined) {
						clearInterval(summaryStore.timer)
						summaryStore.timer = undefined
						summaryStore.period = 0
					}
				}
			}, [])

			return {
				payload,
				busy,
				refresh: () => {
					setBusy(true)
					void loadSummary(true).finally(() => setBusy(false))
				},
			}
		}

		/** 某个位置该拿哪个口径：头像要账户，下方要 key；缺了就用另一个顶上。 */
		function pick(payload, surface) {
			if (payload === undefined) return { reading: undefined, error: undefined }
			const wantAccount = surface === 'avatar'
			const preferred = wantAccount ? payload.account : payload.key
			const fallback = wantAccount ? payload.key : payload.account
			const error = wantAccount ? payload.accountError : payload.keyError
			return { reading: preferred ?? fallback, error }
		}

		/** 数值说的是什么：这个 key 的额度，还是整个账户的余额。 */
		function scopeOf(reading, t) {
			return translate(t, reading.scope === 'account' ? 'balance.scope.account' : 'balance.scope.token')
		}

		/** 数值前的口径标记：账户后面跟用户名，额度后面跟 key 名。 */
		function markOf(reading, t) {
			const word = translate(t, reading.scope === 'account' ? 'balance.mark.account' : 'balance.mark.token')
			const name = typeof reading.credential_name === 'string' && reading.credential_name.length > 0
				? reading.credential_name
				: undefined
			return name === undefined ? word : `${word} ${name}`
		}

		/** 把一次读数压成提示语；detail 决定给多少内容。 */
		function describe(reading, t, detail) {
			const parts = [reading.site]
			if (detail !== 'compact') parts.push(scopeOf(reading, t))
			parts.push(reading.unlimited === true
				? translate(t, 'balance.unlimited')
				: `${translate(t, 'balance.remaining')} ${formatMoney(reading.remaining, reading.currency)}`)
			if (detail !== 'compact' && reading.unlimited !== true) {
				parts.push(`${translate(t, 'balance.used')} ${formatMoney(reading.used, reading.currency)}`)
				parts.push(`${translate(t, 'balance.total')} ${formatMoney(reading.total, reading.currency)}`)
				if (reading.account !== undefined) parts.push(`${reading.account}${reading.group ? `（${reading.group}）` : ''}`)
				parts.push(`${translate(t, 'balance.updated')} ${formatClock(reading.checked_at)}`)
			}
			if (detail === 'detailed' && reading.credential_tail !== undefined) {
				parts.push(`${reading.credential_source} …${reading.credential_tail}`)
			}
			return parts.join(' · ')
		}

		/** 一次显示需要的所有派生状态，两个位置共用。 */
		function present(payload, settings, t, surface) {
			const { reading, error } = pick(payload, surface)
			const ok = reading !== undefined
			const unconfigured = payload !== undefined && payload.ok !== true && payload.configured === false
			const unlimited = ok && reading.unlimited === true
			// 提醒线按口径分开：账户余额和 key 额度各有一条。
			const threshold = reading?.scope === 'account' ? settings.lowBalanceAccount : settings.lowBalanceKey
			const low = ok && !unlimited && threshold > 0 && reading.remaining < threshold
			let description
			if (ok) description = describe(reading, t, settings.detail)
			else if (payload === undefined) description = translate(t, 'balance.loading')
			else description = String(error ?? payload.error ?? translate(t, 'balance.unavailable'))

			return {
				ok,
				low,
				unconfigured,
				failed: payload !== undefined && !ok,
				state: payload === undefined ? 'loading' : (ok ? 'ok' : 'error'),
				mark: ok ? markOf(reading, t) : undefined,
				amount: ok
					? (unlimited ? translate(t, 'balance.unlimited') : formatMoney(reading.remaining, reading.currency))
					: undefined,
				idle: payload === undefined
					? translate(t, 'balance.loading')
					: translate(t, unconfigured ? 'balance.unconfigured' : 'balance.unavailable'),
				used: ok && !unlimited && settings.detail === 'detailed'
					? `${translate(t, 'balance.used')} ${formatMoney(reading.used, reading.currency)}`
					: undefined,
				description: low ? `⚠ ${translate(t, 'balance.low')} · ${description}` : description,
			}
		}

		const CSS = `
.dshBaifanBalance_anchor{display:inline-flex;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.dshBaifanBalance_pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;
  padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;
  white-space:nowrap;cursor:pointer}
.dshBaifanBalance_pill svg{width:14px;height:14px;flex:none;color:var(--baifan-accent,currentColor)}
.dshBaifanBalance_pill:disabled{cursor:default}
/* 预警/错误色必须压过 hover 的常规换色，否则鼠标一悬停红色就变灰了。 */
.dshBaifanBalance_pill[data-state=error],.dshBaifanBalance_pill[data-state=error]:hover{color:var(--dsw-alias-state-error-primary)}
.dshBaifanBalance_pill[data-low=true],.dshBaifanBalance_pill[data-low=true]:hover{color:var(--dsw-alias-state-error-primary);font-weight:500}
.dshBaifanBalance_pill[data-low=true] svg,.dshBaifanBalance_pill[data-low=true]:hover svg{color:var(--dsw-alias-state-error-primary)}
@media (hover:hover){.dshBaifanBalance_pill:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dshBaifanBalance_label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dshBaifanBalance_scope{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshBaifanBalance_sep{opacity:.45}
`

		/** 一枚带 ¥ 符号的硬币，14px 下也能认出来。 */
		function CoinIcon() {
			return h('svg', {
				viewBox: '0 0 16 16',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.4,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': true,
			},
			h('circle', { cx: 8, cy: 8, r: 6.2 }),
			h('path', { d: 'M5.7 5.4 8 8.4l2.3-3' }),
			h('path', { d: 'M8 8.4V11' }),
			h('path', { d: 'M6.3 9.3h3.4' }))
		}

		/** 页面下方：输入框统计行里的那个条目，走单 key 口径。 */
		function ComposerStatPill(props) {
			const t = props?.t
			const settings = useSettings()
			const { payload, busy, refresh } = useSummary(settings.refreshSeconds)
			if (settings.surface !== 'both' && settings.surface !== 'bottom') return null
			const view = present(payload, settings, t, 'bottom')
			const label = view.amount ?? view.idle
			return h('div', { className: 'dshBaifanBalance_anchor' },
				h('style', null, CSS),
				h('button', {
					type: 'button',
					className: 'dshBaifanBalance_pill',
					'data-state': view.state,
					'data-low': view.low ? 'true' : 'false',
					style: { '--baifan-accent': accentOf(settings.accent) },
					onClick: refresh,
					disabled: busy,
					title: view.description,
					'aria-label': view.description,
				},
				settings.showIcon ? CoinIcon() : null,
				h('span', { className: 'dshBaifanBalance_label' }, label),
				view.used === undefined ? null : h('span', { className: 'dshBaifanBalance_sep' }, '·'),
				view.used === undefined ? null : h('span', { className: 'dshBaifanBalance_label' }, view.used),
				view.mark === undefined ? null : h('span', { className: 'dshBaifanBalance_scope' }, view.mark)))
		}

		/** 头像上方：侧栏底部、设置旁边的紧凑按钮，走账户口径；收起成图标列时只剩硬币。 */
		function FooterAction(props) {
			const t = props?.t
			const wide = props?.wide !== false
			const settings = useSettings()
			const { payload, busy, refresh } = useSummary(settings.refreshSeconds)
			if (settings.surface !== 'both' && settings.surface !== 'avatar') return null
			const view = present(payload, settings, t, 'avatar')
			const label = view.amount ?? (payload === undefined ? '' : (view.unconfigured ? translate(t, 'balance.unconfigured') : '!'))
			return h('button', {
				type: 'button',
				className: 'dshBaifanBalance_pill',
				'data-state': view.state,
				'data-low': view.low ? 'true' : 'false',
				style: wide
					? { '--baifan-accent': accentOf(settings.accent) }
					: { '--baifan-accent': accentOf(settings.accent), padding: '1px 6px' },
				onClick: refresh,
				disabled: busy,
				title: view.description,
				'aria-label': view.description,
			},
			h('style', null, CSS),
			settings.showIcon ? CoinIcon() : null,
			wide && label !== '' ? h('span', { className: 'dshBaifanBalance_label' }, label) : null,
			wide && view.mark !== undefined ? h('span', { className: 'dshBaifanBalance_scope' }, view.mark) : null)
		}

		// 设置页走「标签在左、控件在右」的行式布局，行间用发丝线分隔，和宿主设置页一致。
		const SETTINGS_CSS = `
.dshBaifanBalanceSet_root{display:flex;flex-direction:column;gap:18px;max-width:620px;
  font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dshBaifanBalanceSet_heading{display:flex;flex-direction:column;gap:3px}
.dshBaifanBalanceSet_title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshBaifanBalanceSet_lede{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshBaifanBalanceSet_group{display:flex;flex-direction:column}
.dshBaifanBalanceSet_groupTitle{padding-bottom:6px;font-size:12px;font-weight:600;
  color:var(--dsw-alias-label-tertiary)}
.dshBaifanBalanceSet_row{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.dshBaifanBalanceSet_text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshBaifanBalanceSet_label{font-weight:500}
.dshBaifanBalanceSet_hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshBaifanBalanceSet_hintStrong{font-size:12px;color:var(--dsw-alias-brand-primary);font-weight:500}
.dshBaifanBalanceSet_control{flex:none;width:240px;display:flex;justify-content:flex-end;align-items:center}
.dshBaifanBalanceSet_controlWide{width:300px;gap:6px}
.dshBaifanBalanceSet_inlineSave{flex:none;height:30px;padding:0 10px;font:inherit;font-size:12px;
  border:1px solid transparent;border-radius:var(--dsw-radius-sm);cursor:pointer;
  background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:500}
.dshBaifanBalanceSet_input{height:30px;width:100%;box-sizing:border-box;padding:0 8px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.dshBaifanBalanceSet_input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dshBaifanBalanceSet_check{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
.dshBaifanBalanceSet_actions{display:flex;align-items:center;gap:8px;padding-top:14px;
  border-top:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.dshBaifanBalanceSet_primary,.dshBaifanBalanceSet_secondary{height:30px;padding:0 12px;font:inherit;
  border-radius:var(--dsw-radius-sm);cursor:pointer}
.dshBaifanBalanceSet_primary{border:1px solid transparent;background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-bg-base);font-weight:500}
.dshBaifanBalanceSet_secondary{border:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-secondary)}
.dshBaifanBalanceSet_primary:disabled,.dshBaifanBalanceSet_secondary:disabled{opacity:.55;cursor:default}
.dshBaifanBalanceSet_status{font-size:12px;margin-left:2px}
.dshBaifanBalanceSet_status[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}
.dshBaifanBalanceSet_status[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
.dshBaifanBalanceSet_reading{padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);font-size:12px;
  color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:pre-line}
@media (max-width:560px){
  .dshBaifanBalanceSet_row{flex-direction:column;align-items:stretch;gap:6px}
  .dshBaifanBalanceSet_control{width:100%;justify-content:flex-start}
}
`

		/** 一个凭据槽的现状说明。 */
		function slotHint(slot, loading) {
			if (loading) return '正在读取…'
			if (slot?.configured !== true) return '未配置'
			return `当前生效：${slot.source}，末四位 ${slot.tail}`
		}

		/** 设置 → 大白饭余额：两个凭据 + 显示与个性化。 */
		function SettingsPage() {
			const [form, setForm] = useState({
				baseUrl: '',
				timeoutMs: '15000',
				accessToken: '',
				apiKey: '',
				surface: DEFAULT_SETTINGS.surface,
				refreshSeconds: String(DEFAULT_SETTINGS.refreshSeconds),
				detail: DEFAULT_SETTINGS.detail,
				showIcon: DEFAULT_SETTINGS.showIcon,
				accent: DEFAULT_SETTINGS.accent,
				lowBalanceAccount: '5',
				lowBalanceKey: '5',
				autoDetectKey: DEFAULT_SETTINGS.autoDetectKey,
			})
			const [info, setInfo] = useState(undefined)
			const [message, setMessage] = useState(undefined)
			const [busy, setBusy] = useState(false)
			const [reading, setReading] = useState(undefined)
			const alive = useRef(true)
			useEffect(() => () => { alive.current = false }, [])

			const load = useCallback(async () => {
				try {
					const response = await fetch(CONFIG_URL, { headers: { accept: 'application/json' } })
					const data = await response.json()
					if (!alive.current) return
					if (data.ok !== true) throw new Error(data.error ?? '读取配置失败')
					const settings = data.settings ?? DEFAULT_SETTINGS
					setInfo(data)
					setForm({
						baseUrl: data.baseUrl ?? '',
						timeoutMs: String(data.timeoutMs ?? ''),
						accessToken: '',
						apiKey: '',
						surface: settings.surface,
						refreshSeconds: String(settings.refreshSeconds),
						detail: settings.detail,
						showIcon: settings.showIcon,
						accent: settings.accent,
						lowBalanceAccount: String(settings.lowBalanceAccount ?? 0),
						lowBalanceKey: String(settings.lowBalanceKey ?? 0),
						autoDetectKey: settings.autoDetectKey !== false,
					})
				} catch (error) {
					if (alive.current) setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
				}
			}, [])

			useEffect(() => { void load() }, [load])

			const submit = useCallback(async (payload) => {
				setBusy(true)
				setMessage(undefined)
				try {
					const response = await fetch(CONFIG_URL, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(payload),
					})
					const data = await response.json()
					if (data.ok !== true) throw new Error(data.error ?? '保存失败')
					if (alive.current) setMessage({ kind: 'ok', text: '已保存' })
					refreshSettings()
					await load()
					// 写配置会让插件重启一次，缓一下再拉，避免撞在重启空档上；外面两处一起更新。
					await new Promise((resolve) => setTimeout(resolve, 700))
					await loadSummary(true)
				} catch (error) {
					if (alive.current) setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
				} finally {
					if (alive.current) setBusy(false)
				}
			}, [load])

			const save = useCallback(() => {
				const payload = {
					baseUrl: form.baseUrl,
					timeoutMs: form.timeoutMs,
					surface: form.surface,
					refreshSeconds: form.refreshSeconds,
					detail: form.detail,
					showIcon: form.showIcon,
					accent: form.accent,
					lowBalanceAccount: form.lowBalanceAccount,
					lowBalanceKey: form.lowBalanceKey,
					autoDetectKey: form.autoDetectKey,
				}
				if (form.accessToken !== '') payload.accessToken = form.accessToken
				if (form.apiKey !== '') payload.apiKey = form.apiKey
				return submit(payload)
			}, [form, submit])

			const probe = useCallback(async () => {
				setBusy(true)
				setMessage(undefined)
				try {
					// 走共享的取数通道，外面两处会一起更新。
					const data = await loadSummary(true)
					if (alive.current) {
						const lines = []
						if (data.account !== undefined) lines.push(describe(data.account, undefined, 'detailed'))
						else if (data.accountError !== undefined) lines.push(`账户口径失败：${data.accountError}`)
						if (data.key !== undefined) lines.push(describe(data.key, undefined, 'detailed'))
						else if (data.keyError !== undefined) lines.push(`key 口径失败：${data.keyError}`)
						const ok = data.ok === true
						setReading(lines.join('\n'))
						setMessage({ kind: ok ? 'ok' : 'error', text: ok ? '查询成功' : '查询失败' })
					}
				} catch (error) {
					if (alive.current) setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
				} finally {
					if (alive.current) setBusy(false)
				}
			}, [])

			const update = (field) => (event) => setForm({ ...form, [field]: event.target.value })
			const loading = info === undefined
			const accountSlot = info?.credentials?.account
			const keySlot = info?.credentials?.key

			/** 一行「标签在左、控件在右」；说明可以给多行，{ text, strong } 用来强调。 */
			const row = (id, label, hints, control, wide) => {
				const list = (hints === undefined ? [] : (Array.isArray(hints) ? hints : [hints]))
					.filter((hint) => hint !== undefined && hint !== null && hint !== '')
				return h('div', { className: 'dshBaifanBalanceSet_row' },
					h('div', { className: 'dshBaifanBalanceSet_text' },
						h('label', { className: 'dshBaifanBalanceSet_label', htmlFor: id }, label),
						list.map((hint, index) => {
							const text = typeof hint === 'string' ? hint : hint.text
							const strong = typeof hint === 'string' ? false : hint.strong === true
							return h('span', {
								key: `hint-${index}`,
								className: strong ? 'dshBaifanBalanceSet_hintStrong' : 'dshBaifanBalanceSet_hint',
							}, text)
						})),
					h('div', { className: wide === true ? 'dshBaifanBalanceSet_control dshBaifanBalanceSet_controlWide' : 'dshBaifanBalanceSet_control' }, control))
			}

			/** 凭据输入框 + 一改动就出现的行内「保存」，防止填完忘了按底部的保存。 */
			const credentialField = (id, value, field, placeholder) => h('div', {
				style: { display: 'flex', alignItems: 'center', gap: '6px', width: '100%' },
			},
			h('input', {
				id,
				className: 'dshBaifanBalanceSet_input',
				type: 'password',
				value,
				placeholder,
				autoComplete: 'off',
				style: { flex: '1 1 auto', minWidth: '0' },
				onChange: update(field),
			}),
			value
				? h('button', {
					type: 'button',
					className: 'dshBaifanBalanceSet_inlineSave',
					disabled: busy,
					onClick: () => submit({ [field]: value }),
				}, '保存')
				: null)

			return h('div', { className: 'dshBaifanBalanceSet_root' },
				h('style', null, SETTINGS_CSS),

				h('div', { className: 'dshBaifanBalanceSet_heading' },
					h('h2', { className: 'dshBaifanBalanceSet_title' }, '大白饭余额'),
					h('p', { className: 'dshBaifanBalanceSet_lede' }, '大白饭中转站（白饭API）的剩余额度')),

				h('div', { className: 'dshBaifanBalanceSet_group' },
					h('span', { className: 'dshBaifanBalanceSet_groupTitle' }, '连接'),
					row('baifan-base-url', '站点地址', '不带 /v1', h('input', {
						id: 'baifan-base-url',
						className: 'dshBaifanBalanceSet_input',
						type: 'text',
						value: form.baseUrl,
						placeholder: DEFAULT_BASE_URL,
						onChange: update('baseUrl'),
					})),
					row('baifan-timeout', '超时（毫秒）', '含换通道重试的总预算', h('input', {
						id: 'baifan-timeout',
						className: 'dshBaifanBalanceSet_input',
						type: 'number',
						min: 3000,
						max: 120000,
						step: 1000,
						value: form.timeoutMs,
						onChange: update('timeoutMs'),
					}))),

				h('div', { className: 'dshBaifanBalanceSet_group' },
					h('span', { className: 'dshBaifanBalanceSet_groupTitle' }, '余额显示'),
					row('baifan-access-token', '访问令牌（账户口径）', [
						slotHint(accountSlot, loading),
						{ text: '账户完整余额', strong: true },
						'头像上方显示的就是它',
					], credentialField('baifan-access-token', form.accessToken, 'accessToken', '留空不改动'), true),

					row('baifan-auto-detect', '自动检测当前使用 key 的余额', [
						{ text: '自动检测当前使用的 key，无需手动填写', strong: true },
						'页面下方显示的就是它；不限额的 key 会显示「无限制」',
						keySlot?.source === '自动检测' ? `当前生效：自动检测，末四位 ${keySlot.tail}` : undefined,
					], h('input', {
						id: 'baifan-auto-detect',
						className: 'dshBaifanBalanceSet_check',
						type: 'checkbox',
						checked: form.autoDetectKey,
						onChange: (event) => setForm({ ...form, autoDetectKey: event.target.checked }),
					})),

					form.autoDetectKey === false
						? row('baifan-api-key', '手动指定 api key', [
							slotHint(keySlot, loading),
							'关掉自动检测后用这条；留空则页面下方回退显示账户余额',
						], credentialField('baifan-api-key', form.apiKey, 'apiKey', 'sk-... 留空不改动'), true)
						: null),

				h('div', { className: 'dshBaifanBalanceSet_group' },
					h('span', { className: 'dshBaifanBalanceSet_groupTitle' }, '显示与个性化'),
					row('baifan-surface', '显示位置', '保存后立刻生效', h('select', {
						id: 'baifan-surface',
						className: 'dshBaifanBalanceSet_input',
						value: form.surface,
						onChange: update('surface'),
					},
					h('option', { value: 'both' }, '两处都显示'),
					h('option', { value: 'avatar' }, '只在头像上方（账户）'),
					h('option', { value: 'bottom' }, '只在页面下方（key）'),
					h('option', { value: 'hidden' }, '都不显示'))),
					row('baifan-refresh', '刷新间隔（秒）', '15–600', h('input', {
						id: 'baifan-refresh',
						className: 'dshBaifanBalanceSet_input',
						type: 'number',
						min: 15,
						max: 600,
						step: 5,
						value: form.refreshSeconds,
						onChange: update('refreshSeconds'),
					})),
					row('baifan-detail', '信息密度', undefined, h('select', {
						id: 'baifan-detail',
						className: 'dshBaifanBalanceSet_input',
						value: form.detail,
						onChange: update('detail'),
					},
					h('option', { value: 'compact' }, '简洁'),
					h('option', { value: 'standard' }, '标准'),
					h('option', { value: 'detailed' }, '详细'))),
					row('baifan-accent', '强调色', '只染硬币图标', h('select', {
						id: 'baifan-accent',
						className: 'dshBaifanBalanceSet_input',
						value: form.accent,
						onChange: update('accent'),
					},
					h('option', { value: 'auto' }, '跟随主题'),
					h('option', { value: 'brand' }, '品牌色'),
					h('option', { value: 'success' }, '绿色'),
					h('option', { value: 'warn' }, '琥珀色'))),
					row('baifan-icon', '显示硬币图标', undefined, h('input', {
						id: 'baifan-icon',
						className: 'dshBaifanBalanceSet_check',
						type: 'checkbox',
						checked: form.showIcon,
						onChange: (event) => setForm({ ...form, showIcon: event.target.checked }),
					})),
					row('baifan-low-account', '账户余额提醒（金额）', '账户余额低于这个值变红，填 0 关闭', h('input', {
						id: 'baifan-low-account',
						className: 'dshBaifanBalanceSet_input',
						type: 'number',
						min: 0,
						step: 1,
						value: form.lowBalanceAccount,
						onChange: update('lowBalanceAccount'),
					})),
					row('baifan-low-key', 'key 额度提醒（金额）', 'key 额度低于这个值变红，填 0 关闭', h('input', {
						id: 'baifan-low-key',
						className: 'dshBaifanBalanceSet_input',
						type: 'number',
						min: 0,
						step: 1,
						value: form.lowBalanceKey,
						onChange: update('lowBalanceKey'),
					}))),

				h('div', { className: 'dshBaifanBalanceSet_actions' },
					h('button', { type: 'button', className: 'dshBaifanBalanceSet_primary', onClick: save, disabled: busy }, '保存'),
					h('button', { type: 'button', className: 'dshBaifanBalanceSet_secondary', onClick: probe, disabled: busy }, '测试查询'),
					accountSlot?.configured === true
						? h('button', {
							type: 'button',
							className: 'dshBaifanBalanceSet_secondary',
							onClick: () => submit({ accessToken: null }),
							disabled: busy,
						}, '清除访问令牌')
						: null,
					keySlot?.configured === true
						? h('button', {
							type: 'button',
							className: 'dshBaifanBalanceSet_secondary',
							onClick: () => submit({ apiKey: null }),
							disabled: busy,
						}, '清除 api key')
						: null,
					message === undefined
						? null
						: h('span', { className: 'dshBaifanBalanceSet_status', 'data-kind': message.kind }, message.text)),

				reading === undefined
					? null
					: h('div', { className: 'dshBaifanBalanceSet_reading' }, reading),

				info !== undefined && info.canSaveConfig !== true
					? h('p', { className: 'dshBaifanBalanceSet_status', 'data-kind': 'error' },
						'这个 profile 不支持从界面写回配置，请直接改 cordis.patch.yml。')
					: null)
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register('baifan-balance', {
					zh: {
						'balance.loading': '查询中…',
						'balance.unavailable': '余额不可用',
						'balance.unconfigured': '未配置',
						'balance.unlimited': '无限制',
						'balance.remaining': '剩余',
						'balance.used': '已用',
						'balance.total': '总额',
						'balance.updated': '更新',
						'balance.low': '低于提醒线',
						'balance.scope.token': 'key 额度',
						'balance.scope.account': '账户余额',
						'balance.mark.token': 'key额度',
						'balance.mark.account': '账户',
					},
					en: {
						'balance.loading': 'Checking…',
						'balance.unavailable': 'Balance unavailable',
						'balance.unconfigured': 'Not set up',
						'balance.unlimited': 'Unlimited',
						'balance.remaining': 'Remaining',
						'balance.used': 'Used',
						'balance.total': 'Total',
						'balance.updated': 'Updated',
						'balance.low': 'Below your alert threshold',
						'balance.scope.token': 'Key quota',
						'balance.scope.account': 'Account balance',
						'balance.mark.token': 'Key quota',
						'balance.mark.account': 'Account',
					},
				}), 'baifan-balance: locale')

				// 两个位置都注册，显示与否由设置决定——所以切换位置不需要刷新页面。
				ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
					name: 'conversation.composer.dock',
					id: 'baifan-balance',
					order: 2,
					locale: 'baifan-balance',
				}, ComposerStatPill))

				ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
					name: 'sidebar.footer.action',
					id: 'baifan-balance',
					order: 5,
					locale: 'baifan-balance',
				}, FooterAction))

				// 头像 → 设置 里的独立一页。
				ctx.slots.inject('settings.section', () => ctx.slots.register({
					name: 'settings.section',
					id: 'baifan-balance',
					order: 50,
					label: '大白饭余额',
					locale: 'baifan-balance',
				}, SettingsPage))
			},
		}
	},
})
