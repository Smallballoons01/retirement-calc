/**
 * @dsh-plugin/retirement-calc 的浏览器半边。
 *
 * 只贡献一个面：`sidebar.footer.action` —— 侧边栏底部的「距退休 N 天」按钮，
 * 点开是一个可以就地改参数的浮层面板。数据全部来自宿主端的 `/retire/api` 路由，
 * 所以面板里不存在第二份计算逻辑：改任何一个数，都是把它送回宿主、由同一份
 * `core.js` 重算，再把结果取回来。
 *
 * 编辑走的是 `preview`（只算不存），所以拖动滑块时能实时看到结果变化，
 * 但不会污染档案；只有点「保存」才会落盘。
 *
 * 手写在 `__ModuleLoader__` 闭包格式里，所以这个包不需要构建步骤；`require()`
 * 只解析平台种子（react），样式内联在 dsh 设计 token（`--dsw-alias-*`）之上，
 * 因此面板跟随外壳的明暗主题。
 */
window.__ModuleLoader__.load({
  id: '@dsh-plugin/retirement-calc',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'retirement-calc'

    /** 面板宽 340，弹出时贴在侧边栏底部按钮的上方。 */
    const PANEL_WIDTH = 340

    /*
     * 配色上的两条纪律，都是踩过坑之后定下来的：
     *
     * 1. **填充色不接主题**。`#3055d6` 这个品牌蓝是写死的，不做成
     *    `var(--dsw-alias-*)`。原因是那些 token 名无法核实：harness 源码、
     *    已安装的 `dsh-client-ui-theme` 构建产物里都搜不到它们的定义，而
     *    "看似该是背景色的 token 实际是浅色文字色" 会让选中态变成白底白字。
     *    宁可少一点主题适配，也不要出现读不出字的状态。
     *
     * 2. **前景与背景的兜底值必须成对。** 曾经写成
     *    `background: var(--…, #fff)` 配 `color: var(--…, inherit)`：token
     *    一旦不生效，就是纯白底配继承来的浅色字。现在两者都兜到浅色主题的
     *    那一对（`#ffffff` / `#101828`），要么一起跟随主题，要么一起退回浅色。
     */
    const STYLE = `
.dsh-rc-button { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-text-primary, #101828); font-size: 12px; cursor: pointer; font-variant-numeric: tabular-nums; }
.dsh-rc-button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dsh-rc-button .dsh-rc-days { font-weight: 650; }
.dsh-rc-panel { position: fixed; z-index: 1000; width: ${PANEL_WIDTH}px; max-height: min(640px, calc(100vh - 96px)); display: flex; flex-direction: column; overflow: hidden; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-text-primary, #101828); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); border-radius: 12px; box-shadow: 0 10px 34px rgba(0,0,0,.2); font-size: 12px; }
.dsh-rc-head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.15)); font-weight: 600; }
.dsh-rc-head .dsh-rc-spacer { flex: 1; }
.dsh-rc-x { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-text-tertiary, #888); cursor: pointer; font-size: 13px; }
.dsh-rc-x:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-text-primary, #101828); }
.dsh-rc-body { overflow-y: auto; padding: 12px; display: grid; gap: 12px; }

.dsh-rc-heroes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dsh-rc-hero { padding: 10px 11px; border-radius: 10px; background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.07)); }
.dsh-rc-hero-k { color: var(--dsw-alias-text-tertiary, #888); font-size: 11px; margin-bottom: 3px; }
.dsh-rc-hero-v { font-size: 22px; line-height: 1.15; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.dsh-rc-hero-warm .dsh-rc-hero-v { color: var(--dsw-alias-state-warn-primary, #c77700); }
.dsh-rc-hero-brand .dsh-rc-hero-v { color: #3055d6; }
.dsh-rc-hero-n { margin-top: 3px; color: var(--dsw-alias-text-tertiary, #888); font-size: 11px; }

.dsh-rc-rows { display: grid; gap: 5px; }
.dsh-rc-row { display: flex; align-items: baseline; gap: 8px; }
.dsh-rc-row span { color: var(--dsw-alias-text-tertiary, #888); }
.dsh-rc-row b { margin-left: auto; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-rc-ok { color: var(--dsw-alias-state-success-primary, #2f9e44); }
.dsh-rc-bad { color: var(--dsw-alias-state-error-primary, #d64545); }

.dsh-rc-split { display: grid; gap: 4px; padding: 9px 10px; border-radius: 9px; background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.06)); }
.dsh-rc-split .dsh-rc-row b { font-weight: 500; }

.dsh-rc-sect { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.15)); padding-top: 10px; }
.dsh-rc-sect > summary, .dsh-rc-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 600; color: var(--dsw-alias-text-primary, #101828); list-style: none; user-select: none; }
.dsh-rc-sect > summary::-webkit-details-marker { display: none; }
.dsh-rc-sect > summary::before { content: '▸'; color: var(--dsw-alias-text-tertiary, #888); transition: transform .15s; display: inline-block; }
.dsh-rc-sect[open] > summary::before { transform: rotate(90deg); }
.dsh-rc-fields { display: grid; gap: 9px; padding-top: 10px; }
.dsh-rc-fl { display: grid; gap: 4px; }
.dsh-rc-fl > label { color: var(--dsw-alias-text-tertiary, #888); }
.dsh-rc-inline { display: flex; align-items: center; gap: 6px; }
.dsh-rc-inline > input[type=number] { width: 62px; }
.dsh-rc-inline > select { flex: 1; min-width: 0; }
.dsh-rc-panel input[type=number], .dsh-rc-panel select { box-sizing: border-box; min-height: 28px; padding: 3px 7px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius: 6px; background: transparent; color: inherit; font: inherit; font-variant-numeric: tabular-nums; }
.dsh-rc-panel input[type=number]:focus, .dsh-rc-panel select:focus { outline: none; border-color: #3055d6; }
.dsh-rc-panel input[type=range] { width: 100%; accent-color: #3055d6; }
.dsh-rc-seg { display: flex; gap: 4px; }
.dsh-rc-seg button { flex: 1; min-height: 28px; padding: 3px 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dsh-rc-seg button.dsh-rc-on { border-color: #3055d6; background: #3055d6; color: #fff; font-weight: 600; }
.dsh-rc-slider-head { display: flex; justify-content: space-between; align-items: baseline; }
.dsh-rc-slider-head b { font-variant-numeric: tabular-nums; }

.dsh-rc-actions { display: flex; gap: 6px; align-items: center; }
.dsh-rc-actions button { min-height: 28px; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dsh-rc-actions button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dsh-rc-actions button:disabled { opacity: .5; cursor: default; }
.dsh-rc-actions button.dsh-rc-primary { color: #fff; background: #3055d6; border-color: #3055d6; }
.dsh-rc-actions .dsh-rc-grow { flex: 1; }

.dsh-rc-note { color: var(--dsw-alias-text-tertiary, #888); font-size: 11px; line-height: 1.5; }
.dsh-rc-warn { color: var(--dsw-alias-state-warn-label, #b57708); font-size: 11px; line-height: 1.5; }
.dsh-rc-err { color: var(--dsw-alias-state-error-primary, #d64545); font-size: 11px; }

/* 选中文字。dsh 自身没有任何 ::selection 规则（在源码与已安装产物里都搜过），
   浏览器默认高亮在这套外壳里偏淡，选中面板里的数字时几乎看不出选了什么。
   这里显式给一对高对比配色，并限定在面板作用域内，不外溢到宿主界面。 */
.dsh-rc-panel ::selection,
.dsh-rc-panel::selection { background: #cfe0ff; color: #101828; }
`

    /* ── 与宿主端通信 ─────────────────────────────────────── */

    async function api(route, body) {
      const response = await fetch(`/retire/api/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const envelope = await response.json()
      if (!envelope.ok) throw new Error(envelope.error?.message ?? 'request failed')
      return envelope.value
    }

    /* ── 格式化 ───────────────────────────────────────────── */

    const money = value => `￥${Number(value ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    const count = value => Number(value ?? 0).toLocaleString('zh-CN')
    const pct = (value, digits = 1) => `${(Number(value ?? 0) * 100).toFixed(digits)}%`

    /** 月数 → `19年6个月`。与核心的 formatMonths 同口径，客户端只做展示。 */
    function months(value) {
      const total = Math.max(0, Math.round(Number(value) || 0))
      const years = Math.floor(total / 12)
      const rest = total % 12
      if (years === 0) return `${rest}个月`
      if (rest === 0) return `${years}年`
      return `${years}年${rest}个月`
    }

    /* ── 编辑控件 ─────────────────────────────────────────── */

    /**
     * 面板里的三个编辑控件。
     *
     * 它们**必须定义在组件外面**。定义在 `RetirementButton` 内部的话，父组件每次
     * 重渲染都会生成新的函数引用，React 据此判定元素类型变了，于是卸载并重建整棵
     * 子树 —— 症状就是「在输入框里敲一个字符，焦点立刻丢失，得重新点一次」。
     *
     * 而这个面板几乎每次输入都会 `setDraft` + `setData`，重渲染极其频繁，所以这个
     * 缺陷是必现的，不是偶发。三个控件都只依赖 props，没有闭包依赖，因此可以安全
     * 地提到模块级。
     */

    const NumberField = ({ label, value, onChange, step = 1, min, max, suffix }) => h('label', { className: 'dsh-rc-fl' },
      h('span', null, label),
      h('div', { className: 'dsh-rc-inline' },
        h('input', {
          type: 'number', value: value ?? 0, step, min, max,
          onChange: event => onChange(Number(event.target.value)),
        }),
        suffix ? h('span', { className: 'dsh-rc-note' }, suffix) : null,
      ),
    )

    const Slider = ({ label, value, onChange, min = 0.6, max = 3, step = 0.01 }) => h('div', { className: 'dsh-rc-fl' },
      h('div', { className: 'dsh-rc-slider-head' },
        h('span', { className: 'dsh-rc-note' }, label),
        h('b', null, `${Number(value).toFixed(2)}（${pct(value, 0)}）`),
      ),
      h('input', {
        type: 'range', min, max, step, value,
        onChange: event => onChange(Number(event.target.value)),
      }),
    )

    const MonthYear = ({ label, totalMonths, onChange }) => {
      const total = Number(totalMonths) || 0
      return h('div', { className: 'dsh-rc-fl' },
        h('span', null, label),
        h('div', { className: 'dsh-rc-inline' },
          h('input', {
            type: 'number', min: 0, max: 50, value: Math.floor(total / 12),
            onChange: event => onChange(Math.max(0, Number(event.target.value)) * 12 + (total % 12)),
          }),
          h('span', { className: 'dsh-rc-note' }, '年'),
          h('input', {
            type: 'number', min: 0, max: 11, value: total % 12,
            onChange: event => onChange(Math.floor(total / 12) * 12 + Math.max(0, Math.min(11, Number(event.target.value)))),
          }),
          h('span', { className: 'dsh-rc-note' }, '月'),
        ),
      )
    }

    /* ── 面板 ─────────────────────────────────────────────── */

    function createPanel() {
      return function RetirementButton({ wide }) {
        const [open, setOpen] = useState(false)
        const [data, setData] = useState(null)
        const [catalog, setCatalog] = useState(null)
        const [draft, setDraft] = useState(null)
        const [busy, setBusy] = useState(false)
        const [notice, setNotice] = useState('')
        const [error, setError] = useState('')
        const buttonRef = useRef(null)
        const panelRef = useRef(null)
        const [anchor, setAnchor] = useState(null)
        const previewTimer = useRef(undefined)
        /** 草稿的同步镜像，让事件回调读到的一定是最新值，而不是可能过期的闭包。 */
        const draftRef = useRef(null)

        /**
         * 一处更新草稿：本体与镜像必须同时写，否则会读到一个落后一拍的草稿。
         *
         * 包成 `useCallback([], …)` 是因为 `load` 的依赖数组是空的 —— 两个函数都只
         * 碰稳定引用（ref 与 setter），所以恒等不变量成立，而不是在掩盖真依赖。
         */
        const applyDraft = useCallback((next) => {
          draftRef.current = next
          setDraft(next)
        }, [])

        const load = useCallback(async () => {
          try {
            const value = await api('status')
            setData(value)
            applyDraft(value.profile)
            setError('')
          } catch (failure) {
            setError(String(failure.message ?? failure))
          }
        }, [])

        /**
         * 把改动送回宿主试算。
         *
         * 去抖 240ms：拖滑块一次会产生十几个 input 事件，每次都往返一趟服务端
         * 既浪费又会让数字闪烁。定时器而不是 rAF —— 面板收起时没有渲染帧，
         * rAF 会被挂起，预览就永远不更新了。
         */
        const preview = useCallback((profile) => {
          clearTimeout(previewTimer.current)
          previewTimer.current = setTimeout(async () => {
            try {
              const value = await api('preview', { profile })
              setData(value)
              setError('')
            } catch (failure) {
              setError(String(failure.message ?? failure))
            }
          }, 240)
        }, [])

        useEffect(() => {
          if (!open) return undefined
          void load()
          void api('catalog').then(setCatalog).catch(() => {})
          return () => clearTimeout(previewTimer.current)
        }, [open, load])

        // 跨日之后「距退休天数」要减一天，慢轮询兜住这件事。
        useEffect(() => {
          if (!open) return undefined
          const timer = window.setInterval(() => {
            if (!document.hidden) void load()
          }, 300_000)
          return () => window.clearInterval(timer)
        }, [open, load])

        // 锚点：贴着侧边栏底部的按钮往上弹。
        useEffect(() => {
          if (!open) return undefined
          const place = () => {
            const rect = buttonRef.current?.getBoundingClientRect()
            if (!rect) return
            setAnchor({
              left: Math.min(Math.max(8, rect.left), window.innerWidth - PANEL_WIDTH - 8),
              top: Math.max(8, rect.top - 8),
            })
          }
          place()
          window.addEventListener('resize', place)
          return () => window.removeEventListener('resize', place)
        }, [open])

        // 点外面或按 Esc 关掉。
        useEffect(() => {
          if (!open) return undefined
          const onDown = event => {
            if (panelRef.current?.contains(event.target)) return
            if (buttonRef.current?.contains(event.target)) return
            setOpen(false)
          }
          const onKey = event => { if (event.key === 'Escape') setOpen(false) }
          document.addEventListener('mousedown', onDown)
          document.addEventListener('keydown', onKey)
          return () => {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
          }
        }, [open])

        /**
         * 改一个字段：更新草稿、送去试算。
         *
         * 不要写成 `setDraft(previous => { preview(next); return next })` —— 更新器
         * 里不该有副作用（严格模式下会被调用两次，等于多发一次请求），而且连续两次
         * 改动会读到同一个过期的 `previous`。读 ref 镜像可以同时避开这两点。
         */
        const change = (patch) => {
          setNotice('')
          const next = { ...(draftRef.current ?? data?.profile ?? {}), ...patch }
          applyDraft(next)
          preview(next)
        }

        const commit = async () => {
          setBusy(true)
          setNotice('')
          try {
            const value = await api('save', { profile: draft })
            setData(value)
            applyDraft(value.profile)
            setNotice('已保存')
          } catch (failure) {
            setError(String(failure.message ?? failure))
          } finally {
            setBusy(false)
          }
        }

        const reset = async () => {
          setBusy(true)
          setNotice('')
          try {
            const value = await api('reset')
            setData(value)
            applyDraft(value.profile)
            setNotice('已恢复默认')
          } catch (failure) {
            setError(String(failure.message ?? failure))
          } finally {
            setBusy(false)
          }
        }

        const result = data?.result
        const profile = draft ?? data?.profile

        const dirty = useMemo(() => {
          if (!data || !draft) return false
          return Object.keys(draft).some(key => draft[key] !== data.profile[key])
        }, [data, draft])

        const categories = catalog?.categories ?? []
        const provinces = catalog?.provinceList ?? catalog?.provinces ?? []

        const panel = !open || anchor === null ? null : h('div', {
          className: 'dsh-rc-panel',
          ref: panelRef,
          style: { left: `${anchor.left}px`, top: `${anchor.top}px`, transform: 'translateY(-100%)' },
          role: 'dialog',
          'aria-label': '退休测算',
        },
          h('div', { className: 'dsh-rc-head' },
            h('span', null, '退休测算'),
            h('span', { className: 'dsh-rc-spacer' }),
            h('button', { type: 'button', className: 'dsh-rc-x', onClick: () => setOpen(false), title: '关闭' }, '✕'),
          ),

          h('div', { className: 'dsh-rc-body' },
            error !== '' && h('p', { className: 'dsh-rc-err' }, error),
            !result && error === '' && h('p', { className: 'dsh-rc-note' }, '加载中…'),

            result && h(React.Fragment, null,
              h('div', { className: 'dsh-rc-heroes' },
                h('div', { className: 'dsh-rc-hero dsh-rc-hero-warm' },
                  h('div', { className: 'dsh-rc-hero-k' }, '距退休'),
                  h('div', { className: 'dsh-rc-hero-v' }, `${count(result.daysUntilRetirement)} 天`),
                  h('div', { className: 'dsh-rc-hero-n' }, `${result.legalRetirementDate} · ${result.retirementAge}`),
                ),
                h('div', { className: 'dsh-rc-hero dsh-rc-hero-brand' },
                  h('div', { className: 'dsh-rc-hero-k' }, '预计月养老金'),
                  h('div', { className: 'dsh-rc-hero-v' }, money(result.monthlyPension)),
                  h('div', { className: 'dsh-rc-hero-n' }, `年 ${money(result.annualPension)}`),
                ),
              ),

              h('div', { className: 'dsh-rc-split' },
                h('div', { className: 'dsh-rc-row' }, h('span', null, '基础养老金'), h('b', null, money(result.basicPension))),
                h('div', { className: 'dsh-rc-row' }, h('span', null, '个人账户养老金'), h('b', null, money(result.accountPension))),
                result.transitionalPension > 0
                  ? h('div', { className: 'dsh-rc-row' }, h('span', null, '过渡性养老金'), h('b', null, money(result.transitionalPension)))
                  : null,
              ),

              h('div', { className: 'dsh-rc-rows' },
                h('div', { className: 'dsh-rc-row' },
                  h('span', null, '累计缴费'),
                  h('b', null, `${months(result.totalPaidMonths)} / 最低 ${months(result.requiredMonths)}`)),
                h('div', { className: 'dsh-rc-row' },
                  h('span', null, '是否满足最低年限'),
                  h('b', { className: result.meetsMinimum ? 'dsh-rc-ok' : 'dsh-rc-bad' }, result.meetsMinimum ? '满足' : '不满足')),
                h('div', { className: 'dsh-rc-row' }, h('span', null, '平均缴费指数'), h('b', null, Number(result.averageIndex).toFixed(4))),
                h('div', { className: 'dsh-rc-row' }, h('span', null, '计发月数'), h('b', null, `${result.annuityMonths} 个月`)),
                h('div', { className: 'dsh-rc-row' }, h('span', null, '退休时个人账户'), h('b', null, money(result.projectedAccountBalance))),
                h('div', { className: 'dsh-rc-row' },
                  h('span', null, `计发基数（${result.baseYear}）`),
                  h('b', null, money(result.baseAtRetirement))),
                h('div', { className: 'dsh-rc-row' }, h('span', null, '养老金替代率'), h('b', null, pct(result.replacementRate))),
                h('div', { className: 'dsh-rc-row' }, h('span', null, '法定退休'), h('b', null, `${result.legalRetirementDate}${result.legalDelayMonths > 0 ? `（延迟 ${result.legalDelayMonths} 个月）` : ''}`)),
              ),

              // —— 参保信息 ——
              h('details', { className: 'dsh-rc-sect' },
                h('summary', null, '参保信息'),
                h('div', { className: 'dsh-rc-fields' },
                  h('div', { className: 'dsh-rc-fl' },
                    h('span', null, '出生年月'),
                    h('div', { className: 'dsh-rc-inline' },
                      h('input', {
                        type: 'number', min: 1940, max: 2010, value: profile.birthYear,
                        onChange: event => change({ birthYear: Number(event.target.value) }),
                      }),
                      h('span', { className: 'dsh-rc-note' }, '年'),
                      h('input', {
                        type: 'number', min: 1, max: 12, value: profile.birthMonth,
                        onChange: event => change({ birthMonth: Number(event.target.value) }),
                      }),
                      h('span', { className: 'dsh-rc-note' }, '月'),
                    ),
                  ),
                  h('div', { className: 'dsh-rc-fl' },
                    h('span', null, '人群类别（原法定退休年龄）'),
                    h('div', { className: 'dsh-rc-seg' }, categories.map(spec => h('button', {
                      key: spec.key,
                      type: 'button',
                      className: profile.category === spec.key ? 'dsh-rc-on' : '',
                      onClick: () => change({ category: spec.key }),
                    }, spec.shortLabel))),
                  ),
                  h('div', { className: 'dsh-rc-fl' },
                    h('span', null, '参保地'),
                    h('select', {
                      value: profile.province,
                      onChange: event => {
                        // 换省时把手工指定的基数清掉，让它重新跟随新省份的默认值，
                        // 否则会把上一个省的数字带过去，且看不出来源。
                        change({ province: event.target.value, baseAmount: 0, baseYear: 0 })
                      },
                    }, provinces.map(item => h('option', { key: item.code, value: item.code }, item.name))),
                    h('span', { className: 'dsh-rc-note' },
                      (() => {
                        const province = provinces.find(item => item.code === profile.province)
                        if (!province) return ''
                        if (province.status === 'manual') return '该省计发基数未收录，当前用通用兜底值，请手工填写。'
                        return `${province.year} 年计发基数 ${money(province.base)}${province.status === 'reference' ? '（新年度未公布）' : ''}`
                      })()),
                  ),
                  h(MonthYear, {
                    label: '累计已缴月数',
                    totalMonths: profile.paidMonths,
                    onChange: value => change({ paidMonths: value }),
                  }),
                  h(Slider, {
                    label: '已缴部分平均缴费指数',
                    value: profile.paidIndex,
                    onChange: value => change({ paidIndex: value }),
                  }),
                  h(MonthYear, {
                    label: '计划继续缴费月数',
                    totalMonths: profile.futureMonths,
                    onChange: value => change({ futureMonths: value }),
                  }),
                  h(Slider, {
                    label: '未来缴费指数',
                    value: profile.futureIndex,
                    onChange: value => change({ futureIndex: value }),
                  }),
                  h(NumberField, {
                    label: '当前个人账户累计储存额',
                    value: profile.accountBalance, step: 1000, min: 0, suffix: '元',
                    onChange: value => change({ accountBalance: value }),
                  }),
                  h(MonthYear, {
                    label: '视同缴费年限（没有就填 0）',
                    totalMonths: profile.deemedMonths,
                    onChange: value => change({ deemedMonths: value }),
                  }),
                ),
              ),

              // —— 弹性退休 ——
              h('details', { className: 'dsh-rc-sect' },
                h('summary', null, '弹性退休'),
                h('div', { className: 'dsh-rc-fields' },
                  h('div', { className: 'dsh-rc-fl' },
                    h('div', { className: 'dsh-rc-slider-head' },
                      h('span', { className: 'dsh-rc-note' }, '弹性提前（不得低于原法定年龄）'),
                      h('b', null, profile.earlyMonths > 0 ? `${profile.earlyMonths} 个月` : '不提前'),
                    ),
                    h('input', {
                      type: 'range', min: 0, max: 36, step: 1, value: profile.earlyMonths,
                      onChange: event => change({ earlyMonths: Number(event.target.value) }),
                    }),
                  ),
                  h('div', { className: 'dsh-rc-fl' },
                    h('div', { className: 'dsh-rc-slider-head' },
                      h('span', { className: 'dsh-rc-note' }, '弹性延后'),
                      h('b', null, profile.delayMonths > 0 ? `${profile.delayMonths} 个月` : '不延后'),
                    ),
                    h('input', {
                      type: 'range', min: 0, max: 36, step: 1, value: profile.delayMonths,
                      onChange: event => change({ delayMonths: Number(event.target.value) }),
                    }),
                  ),
                  h('p', { className: 'dsh-rc-note' }, '两项互斥；同时设置时按提前处理。'),
                ),
              ),

              // —— 经济假设 ——
              h('details', { className: 'dsh-rc-sect' },
                h('summary', null, '经济假设'),
                h('div', { className: 'dsh-rc-fields' },
                  h(NumberField, {
                    label: '计发基数年增长率',
                    value: +(profile.baseGrowthRate * 100).toFixed(2), step: 0.1, suffix: '%',
                    onChange: value => change({ baseGrowthRate: value / 100 }),
                  }),
                  h(NumberField, {
                    label: '个人账户记账利率',
                    value: +(profile.accountInterestRate * 100).toFixed(2), step: 0.05, suffix: '%',
                    onChange: value => change({ accountInterestRate: value / 100 }),
                  }),
                  h(NumberField, {
                    label: '过渡性养老金系数',
                    value: +(profile.transitionRate * 100).toFixed(1), step: 0.1, suffix: '%',
                    onChange: value => change({ transitionRate: value / 100 }),
                  }),
                  h(NumberField, {
                    label: '手工指定计发基数（0 表示跟随省份）',
                    value: profile.baseAmount, step: 100, min: 0, suffix: '元/月',
                    onChange: value => change({ baseAmount: value }),
                  }),
                  h('p', { className: 'dsh-rc-note' },
                    `当前按 ${profile.baseYear > 0 ? profile.baseYear : data.provinceDefault.year} 年的 `
                    + `${money(profile.baseAmount > 0 ? profile.baseAmount : data.provinceDefault.amount)} 推算。`),
                ),
              ),

              h('div', { className: 'dsh-rc-actions' },
                h('button', {
                  type: 'button', className: 'dsh-rc-primary dsh-rc-grow',
                  disabled: busy || !dirty, onClick: commit,
                }, busy ? '…' : (dirty ? '保存档案' : '已是最新')),
                h('button', { type: 'button', disabled: busy, onClick: reset }, '恢复默认'),
                notice !== '' && h('span', { className: 'dsh-rc-note' }, notice),
              ),

              h('p', { className: 'dsh-rc-note' },
                '改动会立刻重算，但只有点「保存档案」才写入。金额与退休时点均为估算，'
                + '计发基数与记账利率是假设值，实际待遇以社保经办机构核定为准。'),
            ),
          ),
        )

        return h(React.Fragment, null,
          h('button', {
            type: 'button',
            ref: buttonRef,
            className: 'dsh-rc-button',
            onClick: () => setOpen(current => !current),
            title: '退休测算',
          },
          h('span', null, '🕐'),
          result
            ? h('span', null,
              wide === false
                ? h('span', { className: 'dsh-rc-days' }, count(result.daysUntilRetirement))
                : h('span', null, '退休 ', h('span', { className: 'dsh-rc-days' }, count(result.daysUntilRetirement)), ' 天'))
            : h('span', null, wide === false ? '—' : '退休测算'),
          ),
          panel,
        )
      }
    }

    function apply(ctx) {
      const style = document.createElement('style')
      style.textContent = STYLE
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'retirement-calc: 样式')

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: NS,
        order: 165,
      }, createPanel()))
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
