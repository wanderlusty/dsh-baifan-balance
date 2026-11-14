// dsh-baifan-balance 的浏览器侧：大白饭余额的显示位置与外观都在这里。
//   - conversation.composer.dock   界面下方统计行里的条目（排在「缓存命中」之后）
//   - sidebar.footer.action        头像上方的紧凑按钮
// 两个位置都常驻注册，实际显示与否由设置里的 surface 决定——所以改完设置立刻生效、不用刷新页面。
// 样式照抄同一行的 activity/usage 统计条目，只使用 --dsw-* 主题 token，深浅色主题都跟着走。
// 数据来自 Host 侧的 /baifan-balance/summary 与 /baifan-balance/config；浏览器只读，不接触凭据。
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
			lowBalance: 0,
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

		/** 两个入口共用一份读数：挂载即取，之后按设置里的刷新间隔静默刷新。 */
		function useSummary(refreshSeconds) {
			const [payload, setPayload] = useState(undefined)
			const [busy, setBusy] = useState(true)
			const alive = useRef(true)
			useEffect(() => () => { alive.current = false }, [])

			const load = useCallback(async (force) => {
				setBusy(true)
				try {
					const response = await fetch(`${SUMMARY_URL}${force ? '?force=1' : ''}`, {
						headers: { accept: 'application/json' },
					})
					const body = await response.json()
					if (alive.current) setPayload(body)
				} catch (error) {
					if (alive.current) {
						setPayload({ ok: false, error: error instanceof Error ? error.message : String(error) })
					}
				} finally {
					if (alive.current) setBusy(false)
				}
			}, [])

			useEffect(() => {
				void load(false)
				const timer = setInterval(() => { void load(false) }, Math.max(refreshSeconds, 15) * 1000)
				return () => clearInterval(timer)
			}, [load, refreshSeconds])

			return { payload, busy, refresh: () => { void load(true) } }
		}

		/** 把一次读数压成提示语；detail 决定给多少内容。 */
		function describe(payload, t, detail) {
			if (payload === undefined) return translate(t, 'balance.loading')
			if (payload.ok !== true) return String(payload.error)
			const parts = [
				payload.site,
				`${translate(t, 'balance.remaining')} ${formatMoney(payload.remaining, payload.currency)}`,
			]
			if (detail !== 'compact') {
				parts.push(`${translate(t, 'balance.used')} ${formatMoney(payload.used, payload.currency)}`)
				parts.push(`${translate(t, 'balance.total')} ${formatMoney(payload.total, payload.currency)}`)
				if (payload.account !== undefined) parts.push(`${payload.account}${payload.group ? `（${payload.group}）` : ''}`)
				parts.push(`${translate(t, 'balance.updated')} ${formatClock(payload.checked_at)}`)
			}
			if (detail === 'detailed' && payload.credential_tail !== undefined) {
				parts.push(`${payload.credential_source} …${payload.credential_tail}`)
			}
			return parts.join(' · ')
		}

		/** 一次读数在界面上的所有派生状态，两个位置共用。 */
		function present(payload, settings, t) {
			const ok = payload?.ok === true
			const failed = payload !== undefined && !ok
			const unconfigured = payload?.code === 'no-credential'
			const unlimited = ok && payload.unlimited === true
			const low = ok && !unlimited && settings.lowBalance > 0 && payload.remaining < settings.lowBalance
			const description = describe(payload, t, settings.detail)
			return {
				ok,
				failed,
				low,
				unconfigured,
				state: failed ? 'error' : (ok ? 'ok' : 'loading'),
				amount: ok
					? (unlimited ? translate(t, 'balance.unlimited') : formatMoney(payload.remaining, payload.currency))
					: undefined,
				idle: payload === undefined
					? translate(t, 'balance.loading')
					: translate(t, unconfigured ? 'balance.unconfigured' : 'balance.unavailable'),
				used: ok && !unlimited && settings.detail === 'detailed'
					? `${translate(t, 'balance.used')} ${formatMoney(payload.used, payload.currency)}`
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
.dshBaifanBalance_pill[data-state=error]{color:var(--dsw-alias-state-error-primary)}
.dshBaifanBalance_pill[data-low=true]{color:var(--dsw-alias-state-error-primary);font-weight:500}
.dshBaifanBalance_pill[data-low=true] svg{color:var(--dsw-alias-state-error-primary)}
@media (hover:hover){.dshBaifanBalance_pill:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.dshBaifanBalance_label{min-width:0;overflow:hidden;text-overflow:ellipsis}
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

		/** 界面下方：输入框统计行里的余额条目。 */
		function ComposerStatPill(props) {
			const t = props?.t
			const settings = useSettings()
			const { payload, busy, refresh } = useSummary(settings.refreshSeconds)
			if (settings.surface !== 'both' && settings.surface !== 'bottom') return null
			const view = present(payload, settings, t)
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
				view.used === undefined
					? null
					: h('span', { className: 'dshBaifanBalance_sep' }, '·'),
				view.used === undefined
					? null
					: h('span', { className: 'dshBaifanBalance_label' }, view.used)))
		}

		/** 头像上方：侧栏底部、设置旁边的紧凑按钮；收起成图标列时只剩硬币。 */
		function FooterAction(props) {
			const t = props?.t
			const wide = props?.wide !== false
			const settings = useSettings()
			const { payload, busy, refresh } = useSummary(settings.refreshSeconds)
			if (settings.surface !== 'both' && settings.surface !== 'avatar') return null
			const view = present(payload, settings, t)
			const label = view.amount ?? (payload === undefined
				? ''
				: (view.unconfigured ? translate(t, 'balance.unconfigured') : '!'))
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
			wide && label !== '' ? h('span', { className: 'dshBaifanBalance_label' }, label) : null)
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
.dshBaifanBalanceSet_control{flex:none;width:240px;display:flex;justify-content:flex-end;align-items:center}
.dshBaifanBalanceSet_input{height:30px;width:100%;box-sizing:border-box;padding:0 8px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.dshBaifanBalanceSet_input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dshBaifanBalanceSet_check{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
.dshBaifanBalanceSet_actions{display:flex;align-items:center;gap:8px;padding-top:14px;
  border-top:1px solid var(--dsw-alias-border-l1)}
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
  color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
@media (max-width:560px){
  .dshBaifanBalanceSet_row{flex-direction:column;align-items:stretch;gap:6px}
  .dshBaifanBalanceSet_control{width:100%;justify-content:flex-start}
}
`

		/** 设置 → 大白饭余额：连接方式 + 显示与个性化。 */
		function SettingsPage() {
			const [form, setForm] = useState({
				baseUrl: '',
				timeoutMs: '15000',
				key: '',
				surface: DEFAULT_SETTINGS.surface,
				refreshSeconds: String(DEFAULT_SETTINGS.refreshSeconds),
				detail: DEFAULT_SETTINGS.detail,
				showIcon: DEFAULT_SETTINGS.showIcon,
				accent: DEFAULT_SETTINGS.accent,
				lowBalance: '0',
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
						key: '',
						surface: settings.surface,
						refreshSeconds: String(settings.refreshSeconds),
						detail: settings.detail,
						showIcon: settings.showIcon,
						accent: settings.accent,
						lowBalance: String(settings.lowBalance),
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
					lowBalance: form.lowBalance,
				}
				if (form.key !== '') payload.key = form.key
				return submit(payload)
			}, [form, submit])

			const clearKey = useCallback(() => submit({ key: null }), [submit])

			const probe = useCallback(async () => {
				setBusy(true)
				setMessage(undefined)
				try {
					const response = await fetch(`${SUMMARY_URL}?force=1`, { headers: { accept: 'application/json' } })
					const data = await response.json()
					if (alive.current) {
						setReading(data.ok === true ? describe(data, undefined, 'detailed') : `查询失败：${data.error}`)
						setMessage({ kind: data.ok === true ? 'ok' : 'error', text: data.ok === true ? '查询成功' : '查询失败' })
					}
				} catch (error) {
					if (alive.current) setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
				} finally {
					if (alive.current) setBusy(false)
				}
			}, [])

			const update = (field) => (event) => setForm({ ...form, [field]: event.target.value })
			const keyHint = info === undefined
				? '正在读取配置…'
				: (info.key.configured === true
					? `当前生效：${info.key.source}，末四位 ${info.key.tail}`
					: '还没有可用凭据')

			/** 一行「标签在左、控件在右」，行与行之间由 CSS 的发丝线分隔。 */
			const row = (id, label, hint, control) => h('div', { className: 'dshBaifanBalanceSet_row' },
				h('div', { className: 'dshBaifanBalanceSet_text' },
					h('label', { className: 'dshBaifanBalanceSet_label', htmlFor: id }, label),
					hint === undefined ? null : h('span', { className: 'dshBaifanBalanceSet_hint' }, hint)),
				h('div', { className: 'dshBaifanBalanceSet_control' }, control))

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
					row('baifan-key', '密钥 / 访问令牌', keyHint, h('input', {
						id: 'baifan-key',
						className: 'dshBaifanBalanceSet_input',
						type: 'password',
						value: form.key,
						placeholder: '留空不改动',
						autoComplete: 'off',
						onChange: update('key'),
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
					h('span', { className: 'dshBaifanBalanceSet_groupTitle' }, '显示与个性化'),
					row('baifan-surface', '显示位置', '保存后立刻生效', h('select', {
						id: 'baifan-surface',
						className: 'dshBaifanBalanceSet_input',
						value: form.surface,
						onChange: update('surface'),
					},
					h('option', { value: 'both' }, '两处都显示'),
					h('option', { value: 'avatar' }, '只在头像上方'),
					h('option', { value: 'bottom' }, '只在界面下方'),
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
					row('baifan-low', '低余额提醒（金额）', '低于这个值变红，填 0 关闭', h('input', {
						id: 'baifan-low',
						className: 'dshBaifanBalanceSet_input',
						type: 'number',
						min: 0,
						step: 1,
						value: form.lowBalance,
						onChange: update('lowBalance'),
					}))),

				h('div', { className: 'dshBaifanBalanceSet_actions' },
					h('button', { type: 'button', className: 'dshBaifanBalanceSet_primary', onClick: save, disabled: busy }, '保存'),
					h('button', { type: 'button', className: 'dshBaifanBalanceSet_secondary', onClick: probe, disabled: busy }, '测试查询'),
					info !== undefined && info.key.storedInSettings === true
						? h('button', { type: 'button', className: 'dshBaifanBalanceSet_secondary', onClick: clearKey, disabled: busy }, '清除密钥')
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
