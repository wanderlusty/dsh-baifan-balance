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
			lowBalanceAccount: 1,
			lowBalanceKey: 1,
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
			'balance.keyUnavailable': 'key 查不到',
			'balance.where.avatar': '左下角',
			'balance.where.bottom': '输入框下方',
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

		function localDateKey(offsetDays) {
			const day = new Date()
			day.setDate(day.getDate() + offsetDays)
			return day.toLocaleDateString('sv-SE')
		}

		/** 折叠时也要能一眼看到今天/昨天花了多少；按日期取值，避免跨天后误标。 */
		function boardSummaryText(usage, usageBusy) {
			if (usage === undefined) return usageBusy ? '正在读取…' : '—'
			if (usage.ok !== true || usage.totals === undefined) return '不可用'
			const range = `近 ${usage.days} 天　${formatMoney(usage.totals.amount, usage.currency)}　${usage.totals.count} 次`
			const daily = Array.isArray(usage.daily) ? usage.daily : []
			const byDate = new Map(daily.map((day) => [day.date, day]))
			const quick = []
			for (const [label, offset] of [['今日', 0], ['昨日', -1]]) {
				const day = byDate.get(localDateKey(offset))
				if (day !== undefined) quick.push(`${label} ${formatMoney(day.amount, usage.currency)}`)
			}
			return quick.length === 0 ? range : `${quick.join('　')}　·　${range}`
		}

		/** 强调色只影响图标颜色，正文始终跟随主题。 */
		function accentOf(accent) {
			if (accent === 'brand') return 'var(--dsw-alias-brand-primary)'
			if (accent === 'success') return 'var(--dsw-alias-state-success-primary)'
			if (accent === 'warn') return 'var(--dsw-alias-state-warn-primary)'
			return 'currentColor'
		}

		/** 看板里的柱子和色条：auto 时用品牌色，否则跟随强调色。 */
		function chartColor(accent) {
			if (accent === 'success') return 'var(--dsw-alias-state-success-primary)'
			if (accent === 'warn') return 'var(--dsw-alias-state-warn-primary)'
			return 'var(--dsw-alias-brand-primary)'
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

		/** 某个位置该拿哪个口径：头像要账户，下方要 key。
		 *  只有「根本没配 key」才回退到账户；key 配了但查不通必须如实报错，不能假装是 key。 */
		function pick(payload, surface) {
			if (payload === undefined) return { reading: undefined, error: undefined }
			const wantAccount = surface === 'avatar'
			const preferred = wantAccount ? payload.account : payload.key
			const error = wantAccount ? payload.accountError : payload.keyError
			if (preferred !== undefined) return { reading: preferred, error: undefined }
			// 下方位置：key 缺失时，只有「未配置」才允许退回账户口径。
			if (!wantAccount && payload.keyMissing === true) {
				return { reading: payload.account, error: payload.accountError }
			}
			return { reading: undefined, error }
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
		function describe(reading, t, detail, surface) {
			const parts = []
			if (surface !== undefined) parts.push(translate(t, surface === 'avatar' ? 'balance.where.avatar' : 'balance.where.bottom'))
			parts.push(reading.site)
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
			if (ok) description = describe(reading, t, settings.detail, surface)
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
			// key 查不通时，整条显示成红色原因，而不是留一个「余额不可用」让人猜。
			const label = view.amount ?? (view.failed ? translate(t, 'balance.keyUnavailable') : view.idle)
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
.dshBaifanBalanceSet_root{display:flex;flex-direction:column;gap:26px;max-width:620px;
  font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dshBaifanBalanceSet_heading{display:flex;flex-direction:column;gap:3px}
.dshBaifanBalanceSet_title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshBaifanBalanceSet_lede{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshBaifanBalanceSet_group{display:flex;flex-direction:column}
.dshBaifanBalanceSet_groupTitle{padding:0 0 10px;font-size:13px;font-weight:600;
  color:var(--dsw-alias-label-primary);letter-spacing:.01em}
.dshBaifanBalanceSet_row{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.dshBaifanBalanceSet_text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshBaifanBalanceSet_label{font-weight:500}
.dshBaifanBalanceSet_hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshBaifanBalanceSet_hintStrong{font-size:12px;color:var(--dsw-alias-brand-primary);font-weight:500}
.dshBaifanBalanceSet_control{flex:none;width:260px;display:flex;justify-content:flex-end;align-items:center;gap:6px}
.dshBaifanBalanceSet_controlWide{width:260px;gap:6px}
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
.dshBaifanBalanceSet_notes{display:flex;flex-direction:column;gap:4px;padding-top:8px;
  border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshBaifanBalanceSet_notesCode{font-family:var(--dsw-font-family-code,ui-monospace,monospace)}
.dshBaifanBalanceSet_boardHead{display:flex;align-items:center;gap:10px;padding:2px 0}
.dshBaifanBalanceSet_boardToggle{display:flex;align-items:center;gap:8px;flex:1;min-width:0;border:0;
  background:transparent;padding:2px 0;font:inherit;color:inherit;cursor:pointer;text-align:left}
.dshBaifanBalanceSet_chevron{flex:none;width:10px;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dshBaifanBalanceSet_boardTitle{flex:none;font-size:12px;font-weight:600;
  color:var(--dsw-alias-label-tertiary);letter-spacing:.04em}
.dshBaifanBalanceSet_boardSummary{font-size:12px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshBaifanBalanceSet_segmented{display:flex;gap:2px;flex:none}
.dshBaifanBalanceSet_segment{height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;
  border-radius:var(--dsw-radius-sm);cursor:pointer}
.dshBaifanBalanceSet_segment[data-active=true]{background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dshBaifanBalanceSet_board{display:flex;flex-direction:column;gap:16px;padding-top:10px;
  border-top:1px solid var(--dsw-alias-border-l1)}
.dshBaifanBalanceSet_block{display:flex;flex-direction:column;gap:6px}
.dshBaifanBalanceSet_blockLabel{font-size:11px;color:var(--dsw-alias-label-tertiary);letter-spacing:.04em}
.dshBaifanBalanceSet_stats{display:flex;gap:28px;flex-wrap:wrap}
.dshBaifanBalanceSet_stat{display:flex;flex-direction:column;gap:2px}
.dshBaifanBalanceSet_statValue{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums;line-height:1.25}
.dshBaifanBalanceSet_statLabel{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshBaifanBalanceSet_chart{display:flex;align-items:flex-end;gap:8px;height:92px;
  padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshBaifanBalanceSet_barCol{flex:1;display:flex;flex-direction:column;align-items:center;
  justify-content:flex-end;gap:3px;min-width:0;height:100%}
.dshBaifanBalanceSet_barValue{font-size:9px;line-height:1;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;height:10px}
.dshBaifanBalanceSet_bar{width:100%;max-width:26px;border-radius:3px 3px 0 0;
  background:var(--dsw-alias-brand-primary);opacity:.85}
.dshBaifanBalanceSet_bar[data-empty=true]{background:var(--dsw-alias-border-l1);opacity:.7}
.dshBaifanBalanceSet_barLabel{font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshBaifanBalanceSet_modelRow{position:relative;display:flex;align-items:center;gap:10px;
  padding:3px 6px;border-radius:4px;overflow:hidden;font-size:12px;line-height:1.5}
.dshBaifanBalanceSet_modelList{display:flex;flex-direction:column;gap:2px}
.dshBaifanBalanceSet_modelFillBg{position:absolute;top:0;bottom:0;left:0;
  background:var(--dsw-alias-brand-primary);opacity:.1}
.dshBaifanBalanceSet_modelName{position:relative;flex:1 1 auto;min-width:0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dshBaifanBalanceSet_modelAmount{position:relative;flex:none;width:78px;text-align:right;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dshBaifanBalanceSet_modelCount{position:relative;flex:none;width:56px;text-align:right;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshBaifanBalanceSet_recent{display:flex;flex-direction:column;gap:3px;font-size:12px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshBaifanBalanceSet_recentRow{display:flex;gap:10px;align-items:baseline;padding:2px 6px;border-radius:4px}
.dshBaifanBalanceSet_recentTime{width:40px;flex:none}
.dshBaifanBalanceSet_recentModel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dshBaifanBalanceSet_recentAmount{flex:none;width:70px;text-align:right;color:var(--dsw-alias-label-primary)}
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
				lowBalanceAccount: '1',
				lowBalanceKey: '1',
				autoDetectKey: DEFAULT_SETTINGS.autoDetectKey,
			})
			const [info, setInfo] = useState(undefined)
			// 载入时的快照：用来判断哪个字段被改过，改过才显示行内「保存」。
			const [initial, setInitial] = useState({})
			const [message, setMessage] = useState(undefined)
			const [busy, setBusy] = useState(false)
			const [reading, setReading] = useState(undefined)
			const [usage, setUsage] = useState(undefined)
			const [usageBusy, setUsageBusy] = useState(false)
			// 折叠状态与所选天数记在本地，下次打开设置页保持原样。
			const [boardOpen, setBoardOpen] = useState(() => {
				try { return window.localStorage.getItem('baifan-board-open') === '1' } catch { return false }
			})
			const [boardDays, setBoardDays] = useState(() => {
				try {
					const stored = Number(window.localStorage.getItem('baifan-board-days'))
					return [7, 14, 30].includes(stored) ? stored : 7
				} catch { return 7 }
			})
			const alive = useRef(true)
			// 订阅共享读数：据它判断当前 key 是不是「只能查 key 额度」。
			const live = useSummary(DEFAULT_SETTINGS.refreshSeconds)
			// 只有「这条 key 还不能查账户额度」时才提示去授权。
			const keyNeedsAuthorize = live.payload?.key !== undefined && live.payload.key.account_quota === undefined
			useEffect(() => () => { alive.current = false }, [])

			const load = useCallback(async () => {
				try {
					const response = await fetch(CONFIG_URL, { headers: { accept: 'application/json' } })
					const data = await response.json()
					if (!alive.current) return
					if (data.ok !== true) throw new Error(data.error ?? '读取配置失败')
					const settings = data.settings ?? DEFAULT_SETTINGS
					setInfo(data)
					const next = {
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
					}
					setForm(next)
					setInitial(next)
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
				void loadUsage()
			}, [])

			/** 一键把当前 key 的「允许查询用户额度」打开，之后 sk- 就能直接看到账户余额。 */
			const authorize = useCallback(async () => {
				setBusy(true)
				setMessage(undefined)
				try {
					const response = await fetch('/baifan-balance/authorize-key', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: '{}',
					})
					const data = await response.json()
					if (data.ok !== true) throw new Error(data.error ?? '操作失败')
					if (alive.current) {
						setMessage({
							kind: 'ok',
							text: data.already === true
								? `「${data.name}」本来就是开启状态`
								: `已为「${data.name}」开启账户额度查询`,
						})
					}
					await loadSummary(true)
					await load()
				} catch (error) {
					if (alive.current) setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
				} finally {
					if (alive.current) setBusy(false)
				}
			}, [load])

			/** 拉一次用量看板数据。 */
			const loadUsage = useCallback(async (days) => {
				setUsageBusy(true)
				try {
					const response = await fetch(`/baifan-balance/usage?days=${days}`, { headers: { accept: 'application/json' } })
					const data = await response.json()
					if (alive.current) setUsage(data)
				} catch (error) {
					if (alive.current) setUsage({ ok: false, error: error instanceof Error ? error.message : String(error) })
				} finally {
					if (alive.current) setUsageBusy(false)
				}
			}, [])

			useEffect(() => { void loadUsage(boardDays) }, [loadUsage, boardDays])

			/** 折叠开关；顺手记到本地。 */
			const toggleBoard = () => {
				const next = !boardOpen
				setBoardOpen(next)
				try { window.localStorage.setItem('baifan-board-open', next ? '1' : '0') } catch { /* 忽略 */ }
			}

			/** 切换统计天数。 */
			const pickDays = (days) => {
				setBoardDays(days)
				try { window.localStorage.setItem('baifan-board-days', String(days)) } catch { /* 忽略 */ }
			}

			/** 用量看板：概览 + 每日柱状 + 模型占比 + 最近请求。 */
			const board = (data) => {
				// 接口理论上总是给数组，但缺字段时不能让整页崩掉。
				const daily = Array.isArray(data.daily) ? data.daily : []
				const models = Array.isArray(data.models) ? data.models : []
				const recent = Array.isArray(data.recent) ? data.recent : []
				const totals = data.totals ?? { amount: 0, count: 0, average: 0 }
				const maxDay = Math.max(...daily.map((day) => day.amount), 0.000001)
				const maxModel = Math.max(...models.map((item) => item.amount), 0.000001)
				const barColor = chartColor(form.accent)

				const stats = h('div', { className: 'dshBaifanBalanceSet_stats' },
					h('div', { className: 'dshBaifanBalanceSet_stat' },
						h('span', { className: 'dshBaifanBalanceSet_statValue' }, formatMoney(totals.amount, data.currency)),
						h('span', { className: 'dshBaifanBalanceSet_statLabel' }, `近 ${data.days} 天消耗`)),
					h('div', { className: 'dshBaifanBalanceSet_stat' },
						h('span', { className: 'dshBaifanBalanceSet_statValue' }, String(totals.count)),
						h('span', { className: 'dshBaifanBalanceSet_statLabel' }, '请求数')),
					h('div', { className: 'dshBaifanBalanceSet_stat' },
						h('span', { className: 'dshBaifanBalanceSet_statValue' }, formatMoney(totals.average, data.currency)),
						h('span', { className: 'dshBaifanBalanceSet_statLabel' }, '平均每次')))

				const barLabel = (amount) => {
					if (amount >= 10) return amount.toFixed(0)
					if (amount >= 1) return amount.toFixed(1)
					if (amount > 0) return amount.toFixed(2)
					return ''
				}

				// 日期/金额标签的密度：柱子多时隔几根显示一根，避免文字叠在一起。
				const labelStep = daily.length <= 7 ? 1 : (daily.length <= 14 ? 2 : 3)
				const bars = daily.map((day, dayIndex) => h('div', { className: 'dshBaifanBalanceSet_barCol', key: day.date },
					h('span', { className: 'dshBaifanBalanceSet_barValue' }, dayIndex % labelStep === 0 ? barLabel(day.amount) : ''),
					h('div', {
						className: 'dshBaifanBalanceSet_bar',
						'data-empty': day.amount <= 0 ? 'true' : 'false',
						style: {
							height: `${day.amount <= 0 ? 2 : Math.max(4, (day.amount / maxDay) * 62)}px`,
							background: day.amount <= 0 ? undefined : barColor,
						},
						title: `${day.date}　${formatMoney(day.amount, data.currency)}　${day.count} 次`,
					}),
					h('span', { className: 'dshBaifanBalanceSet_barLabel' }, dayIndex % labelStep === 0 ? day.date.slice(5) : '')))

				const chartBlock = h('div', { className: 'dshBaifanBalanceSet_block' },
					h('span', { className: 'dshBaifanBalanceSet_blockLabel' }, '每日消耗'),
					daily.length === 0
						? h('span', { className: 'dshBaifanBalanceSet_hint' }, '这段时间没有消费记录')
						: h('div', { className: 'dshBaifanBalanceSet_chart' }, bars))

				const modelRows = models.map((item) => h('div', { className: 'dshBaifanBalanceSet_modelRow', key: item.model },
					h('div', {
						className: 'dshBaifanBalanceSet_modelFillBg',
						style: { width: `${Math.max(1, (item.amount / maxModel) * 100)}%`, background: barColor },
					}),
					h('span', { className: 'dshBaifanBalanceSet_modelName', title: item.model }, item.model),
					h('span', { className: 'dshBaifanBalanceSet_modelAmount' }, formatMoney(item.amount, data.currency)),
					h('span', { className: 'dshBaifanBalanceSet_modelCount' }, `${item.count} 次`)))

				const modelBlock = models.length === 0 ? null : h('div', { className: 'dshBaifanBalanceSet_block' },
					h('span', { className: 'dshBaifanBalanceSet_blockLabel' }, '按模型'),
					h('div', { className: 'dshBaifanBalanceSet_modelList' }, modelRows))

				const recentRows = recent.map((item, index) => h('div', {
					className: 'dshBaifanBalanceSet_recentRow',
					key: `${item.at}-${index}`,
				},
				h('span', { className: 'dshBaifanBalanceSet_recentTime' }, formatClock(item.at)),
				h('span', {
					className: 'dshBaifanBalanceSet_recentModel',
					title: `${item.token} · ${item.prompt_tokens}→${item.completion_tokens} tok · ${item.use_time}s`,
				}, item.model),
				h('span', { className: 'dshBaifanBalanceSet_recentAmount' }, formatMoney(item.amount, data.currency))))

				const recentBlock = recent.length === 0 ? null : h('div', { className: 'dshBaifanBalanceSet_block' },
					h('span', { className: 'dshBaifanBalanceSet_blockLabel' }, '最近请求'),
					h('div', { className: 'dshBaifanBalanceSet_recent' }, recentRows))

				return h('div', { className: 'dshBaifanBalanceSet_board' }, stats, chartBlock, modelBlock, recentBlock)
			}

			const update = (field) => (event) => setForm({ ...form, [field]: event.target.value })

			/** 选择型控件：选中即保存，不用再找按钮。 */
			const chooseField = (field) => (event) => {
				const value = event.target.value
				setForm({ ...form, [field]: value })
				void submit({ [field]: value })
			}

			/** 勾选型控件：勾上/取消即保存。 */
			const toggleField = (field) => (event) => {
				const value = event.target.checked
				setForm({ ...form, [field]: value })
				void submit({ [field]: value })
			}

			/** 数值/文本型：改过之后旁边才出现「保存」。 */
			const dirtyControl = (field, input, payloadKey) => {
				// 配置读回来之前 initial 是空的，此时不该判定为「已修改」。
				const dirty = Object.hasOwn(initial, field) && form[field] !== initial[field]
				return h('div', {
					style: { display: 'flex', alignItems: 'center', gap: '6px', width: '100%' },
				},
				input,
				dirty
					? h('button', {
						type: 'button',
						className: 'dshBaifanBalanceSet_inlineSave',
						disabled: busy,
						onClick: () => submit({ [payloadKey ?? field]: form[field] }),
					}, '保存')
					: null)
			}
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
					row('baifan-base-url', '站点地址', '不带 /v1', dirtyControl('baseUrl', h('input', {
						id: 'baifan-base-url',
						className: 'dshBaifanBalanceSet_input',
						type: 'text',
						value: form.baseUrl,
						placeholder: DEFAULT_BASE_URL,
						style: { flex: '1 1 auto', minWidth: '0' },
						onChange: update('baseUrl'),
					})), true),
					row('baifan-timeout', '超时（毫秒）', '含换通道重试的总预算', dirtyControl('timeoutMs', h('input', {
						id: 'baifan-timeout',
						className: 'dshBaifanBalanceSet_input',
						type: 'number',
						min: 3000,
						max: 120000,
						step: 1000,
						value: form.timeoutMs,
						style: { flex: '1 1 auto', minWidth: '0' },
						onChange: update('timeoutMs'),
					})), true)),

				h('div', { className: 'dshBaifanBalanceSet_group' },
					h('span', { className: 'dshBaifanBalanceSet_groupTitle' }, '余额显示'),
					row('baifan-access-token', '访问令牌（账户口径）', [
						slotHint(accountSlot, loading),
						{ text: '账户完整余额', strong: true },
						'头像上方显示的就是它',
					], credentialField('baifan-access-token', form.accessToken, 'accessToken', '留空不改动'), true),

					row('baifan-auto-detect', '自动跟随 DSH 当前使用的 key', [
						'页面下方显示的就是这条 key 的额度',
						'如果这条 key 在站点里开了「允许查询用户额度」，这里会直接显示账户余额',
						keySlot?.configured === true
							? `当前生效：${keySlot.ref ? `取自 ${keySlot.ref}，` : ''}末四位 ${keySlot.tail}`
							: undefined,
					], h('input', {
						id: 'baifan-auto-detect',
						className: 'dshBaifanBalanceSet_check',
						type: 'checkbox',
						checked: form.autoDetectKey,
						onChange: toggleField('autoDetectKey'),
					})),

					// DSH 里可能同时存了好几条提供商的 key，让用户选准是哪条。
					form.autoDetectKey && info?.provider !== undefined
						? row('baifan-provider-info', '当前提供商', '自动检测据此决定用哪把 key', h('span', {
							id: 'baifan-provider-info',
							className: 'dshBaifanBalanceSet_hint',
							style: { textAlign: 'right' },
						}, info.provider.id + (info.provider.name === undefined ? '' : '（' + info.provider.name + '）')))
						: null,

					form.autoDetectKey === false
						? row('baifan-api-key', '手动指定 api key', [
							slotHint(keySlot, loading),
							'关掉自动检测后用这条；留空则页面下方回退显示账户余额',
						], credentialField('baifan-api-key', form.apiKey, 'apiKey', 'sk-... 留空不改动'), true)
						: null),

				h('div', { className: 'dshBaifanBalanceSet_group' },
					h('span', { className: 'dshBaifanBalanceSet_groupTitle' }, '显示与个性化'),
					row('baifan-surface', '显示位置', [
						'头像上方 = 账户余额，页面下方 = key 额度',
						'两者是不同口径，不会互相覆盖；选中即生效',
					], h('select', {
						id: 'baifan-surface',
						className: 'dshBaifanBalanceSet_input',
						value: form.surface,
						onChange: chooseField('surface'),
					},
					h('option', { value: 'both' }, '两处都显示'),
					h('option', { value: 'avatar' }, '只在头像上方（账户）'),
					h('option', { value: 'bottom' }, '只在页面下方（key）'),
					h('option', { value: 'hidden' }, '都不显示'))),
					row('baifan-refresh', '刷新间隔（秒）', '15–600', dirtyControl('refreshSeconds', h('input', {
						id: 'baifan-refresh',
						className: 'dshBaifanBalanceSet_input',
						type: 'number',
						min: 15,
						max: 600,
						step: 5,
						value: form.refreshSeconds,
						style: { flex: '1 1 auto', minWidth: '0' },
						onChange: update('refreshSeconds'),
					})), true),
					row('baifan-detail', '信息密度', '选中即生效', h('select', {
						id: 'baifan-detail',
						className: 'dshBaifanBalanceSet_input',
						value: form.detail,
						onChange: chooseField('detail'),
					},
					h('option', { value: 'compact' }, '简洁'),
					h('option', { value: 'standard' }, '标准'),
					h('option', { value: 'detailed' }, '详细'))),
					row('baifan-accent', '强调色', '图标与看板配色，选中即生效', h('select', {
						id: 'baifan-accent',
						className: 'dshBaifanBalanceSet_input',
						value: form.accent,
						onChange: chooseField('accent'),
					},
					h('option', { value: 'auto' }, '跟随主题'),
					h('option', { value: 'brand' }, '品牌色'),
					h('option', { value: 'success' }, '绿色'),
					h('option', { value: 'warn' }, '琥珀色'))),
					row('baifan-icon', '显示硬币图标', '勾选即生效', h('input', {
						id: 'baifan-icon',
						className: 'dshBaifanBalanceSet_check',
						type: 'checkbox',
						checked: form.showIcon,
						onChange: toggleField('showIcon'),
					})),
					row('baifan-low-account', '账户余额提醒（金额）', '账户余额低于这个值变红，填 0 关闭', dirtyControl('lowBalanceAccount', h('input', {
						id: 'baifan-low-account',
						className: 'dshBaifanBalanceSet_input',
						type: 'number',
						min: 0,
						step: 1,
						value: form.lowBalanceAccount,
						style: { flex: '1 1 auto', minWidth: '0' },
						onChange: update('lowBalanceAccount'),
					})), true),
					row('baifan-low-key', 'key 额度提醒（金额）', 'key 额度低于这个值变红，填 0 关闭', dirtyControl('lowBalanceKey', h('input', {
						id: 'baifan-low-key',
						className: 'dshBaifanBalanceSet_input',
						type: 'number',
						min: 0,
						step: 1,
						value: form.lowBalanceKey,
						style: { flex: '1 1 auto', minWidth: '0' },
						onChange: update('lowBalanceKey'),
					})), true)),

				h('div', { className: 'dshBaifanBalanceSet_group' },
					h('div', { className: 'dshBaifanBalanceSet_boardHead' },
						h('button', {
							type: 'button',
							className: 'dshBaifanBalanceSet_boardToggle',
							onClick: toggleBoard,
							'aria-expanded': boardOpen ? 'true' : 'false',
						},
						h('span', { className: 'dshBaifanBalanceSet_chevron' }, boardOpen ? '▾' : '▸'),
						h('span', { className: 'dshBaifanBalanceSet_boardTitle' }, '用量看板'),
						h('span', { className: 'dshBaifanBalanceSet_boardSummary' }, boardSummaryText(usage, usageBusy))),
						boardOpen
							? h('div', { className: 'dshBaifanBalanceSet_segmented' },
								[7, 14, 30].map((days) => h('button', {
									key: days,
									type: 'button',
									className: 'dshBaifanBalanceSet_segment',
									'data-active': boardDays === days ? 'true' : 'false',
									onClick: () => pickDays(days),
								}, `${days} 天`)))
							: null),
					boardOpen
						? (usage === undefined
							? h('div', { className: 'dshBaifanBalanceSet_notes' },
								h('span', null, usageBusy ? '正在读取…' : '暂无数据'))
							: usage.ok !== true
								? h('div', { className: 'dshBaifanBalanceSet_notes' },
									h('span', null, String(usage.error ?? '用量数据暂时不可用')))
								: board(usage))
						: null),

				h('div', { className: 'dshBaifanBalanceSet_group' },
					h('span', { className: 'dshBaifanBalanceSet_groupTitle' }, '其他入口'),
					h('div', { className: 'dshBaifanBalanceSet_notes' },
						h('span', null, '对话里问「我余额还剩多少」→ 助手会调用 relay_balance 工具'),
						h('span', null, '输入框敲 /balance 直接出结果，不走模型、不耗 token'),
						h('span', null, '/balance 后面可加 account 或 key 指定口径，不带参数＝自动选择'),
						h('span', null, '/balance today / week 直接看今日或近 7 天用量（需访问令牌，按自然日统计）'),
						h('span', null, '余额查询可临时传一个别的凭据，不会改动设置；用量查询用这里保存的访问令牌'))),

				h('div', { className: 'dshBaifanBalanceSet_actions' },
					h('button', { type: 'button', className: 'dshBaifanBalanceSet_secondary', onClick: probe, disabled: busy }, '测试查询'),
					keyNeedsAuthorize && accountSlot?.configured === true
						? h('button', { type: 'button', className: 'dshBaifanBalanceSet_secondary', onClick: authorize, disabled: busy }, '一键开启账户额度查询')
						: null,
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
						'balance.keyUnavailable': 'key 查不到',
						'balance.where.avatar': '左下角',
						'balance.where.bottom': '输入框下方',
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
						'balance.keyUnavailable': 'Key unavailable',
						'balance.where.avatar': 'Sidebar footer',
						'balance.where.bottom': 'Under composer',
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
