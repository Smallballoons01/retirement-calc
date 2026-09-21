/**
 * 实时计算器的前端逻辑。
 *
 * 本文件在构建时被内联进单文件 HTML，运行环境里 core.js 的所有导出已经挂在
 * 全局作用域上（构建脚本会剥掉 `export` 关键字），所以这里直接调用 compute、
 * formatMoney 等函数，无需 import。
 *
 * 数据流是单向的：DOM 表单 → `readForm()` → `compute()` → 各个 render 函数
 * 把结果写回 DOM。没有双向绑定，任何输入事件都走同一条链路，所以「实时」是
 * 免费的 —— 只要重算一次。
 */

/* eslint-env browser */
/* global compute, formatMoney, formatPercent, formatDays,
   formatMonths, formatYearMonth, formatAge, CATEGORIES, PROVINCES,
   findProvince, defaultBaseFor, defaultBaseYearFor, formatReport */

const $ = id => document.getElementById(id)

/** 首次打开时选中的省份；同时也是计发基数初值的来源。 */
const INITIAL_PROVINCE = 'guangdong'

/** 首次打开时预填的一组数据，让页面一进来就有可看的数字。 */
const INITIAL = {
  birthYear: 1990,
  birthMonth: 1,
  category: 'male',
  province: INITIAL_PROVINCE,
  insuredType: 'employee',
  paidMonths: 8 * 12,
  paidIndex: 0.6,
  futureMonths: 30 * 12,
  futureIndex: 0.6,
  accountBalance: 60_000,
  deemedMonths: 0,
  deemedIndex: 0.6,
  // 计发基数初值取自省份默认表 —— 必须和 normalizeInput 用同一套回落逻辑，
  // 否则会出现「输入框空白、结果却按某个基数算出来」的口径分裂。
  baseAmount: defaultBaseFor(INITIAL_PROVINCE),
  baseYear: defaultBaseYearFor(INITIAL_PROVINCE),
  baseGrowthRate: 0.02,
  accountInterestRate: 0.015,
  transitionRate: 0.013,
  earlyMonths: 0,
  delayMonths: 0,
}

/** 当前表单状态（与 DOM 同步的一份扁平快照）。 */
let state = { ...INITIAL }
/** 上一次渲染的结果，供复制功能使用。 */
let lastResult = null

/* ── 表单骨架：下拉与分段控件 ─────────────────────────────── */

function buildStaticControls() {
  const monthSelect = $('birthMonth')
  monthSelect.innerHTML = Array.from({ length: 12 }, (_, i) =>
    `<option value="${i + 1}">${i + 1} 月</option>`).join('')

  $('categorySeg').innerHTML = Object.values(CATEGORIES).map(spec => `
    <label>
      <input type="radio" name="category" value="${spec.key}">
      <span>${spec.shortLabel}</span>
    </label>`).join('')

  $('insuredSeg').innerHTML = [
    { value: 'employee', label: '职工' },
    { value: 'flexible', label: '灵活就业' },
  ].map(item => `
    <label>
      <input type="radio" name="insuredType" value="${item.value}">
      <span>${item.label}</span>
    </label>`).join('')

  $('province').innerHTML = PROVINCES
    .map(province => `<option value="${province.code}">${province.name}</option>`)
    .join('')
}

/* ── 表单读取与回写 ──────────────────────────────────────── */

/** 把 `state` 写进 DOM。 */
function writeForm() {
  $('birthYear').value = state.birthYear
  $('birthMonth').value = state.birthMonth
  document.querySelector(`input[name="category"][value="${state.category}"]`).checked = true
  document.querySelector(`input[name="insuredType"][value="${state.insuredType}"]`).checked = true

  $('paidYears').value = Math.floor(state.paidMonths / 12)
  $('paidMonthsExtra').value = state.paidMonths % 12
  $('paidIndex').value = state.paidIndex

  $('futureYears').value = Math.floor(state.futureMonths / 12)
  $('futureMonthsExtra').value = state.futureMonths % 12
  $('futureIndex').value = state.futureIndex

  $('accountBalance').value = state.accountBalance
  $('province').value = state.province
  $('baseAmount').value = Math.round(state.baseAmount)

  $('deemedYears').value = Math.floor(state.deemedMonths / 12)
  $('deemedMonthsExtra').value = state.deemedMonths % 12
  $('deemedIndex').value = state.deemedIndex

  $('baseGrowthRate').value = +(state.baseGrowthRate * 100).toFixed(2)
  $('accountInterestRate').value = +(state.accountInterestRate * 100).toFixed(2)
  $('transitionRate').value = +(state.transitionRate * 100).toFixed(1)

  $('earlyMonths').value = state.earlyMonths
  $('delayMonths').value = state.delayMonths
}

/** 从 DOM 收回一份状态。 */
function readForm() {
  const int = (id, fallback) => {
    const value = Number.parseInt($(id).value, 10)
    return Number.isFinite(value) ? value : fallback
  }

  state = {
    ...state,
    birthYear: int('birthYear', state.birthYear),
    birthMonth: int('birthMonth', state.birthMonth),
    category: document.querySelector('input[name="category"]:checked').value,
    insuredType: document.querySelector('input[name="insuredType"]:checked').value,

    paidMonths: Math.max(0, int('paidYears', 0)) * 12 + Math.max(0, int('paidMonthsExtra', 0)),
    paidIndex: Number($('paidIndex').value),

    futureMonths: Math.max(0, int('futureYears', 0)) * 12 + Math.max(0, int('futureMonthsExtra', 0)),
    futureIndex: Number($('futureIndex').value),

    accountBalance: Math.max(0, Number($('accountBalance').value) || 0),
    province: $('province').value,
    // 基数被清空时回落到该省默认值，而不是让 0 悄悄流进计算。
    baseAmount: Math.max(0, Number($('baseAmount').value) || 0) || defaultBaseFor($('province').value),

    deemedMonths: Math.max(0, int('deemedYears', 0)) * 12 + Math.max(0, int('deemedMonthsExtra', 0)),
    deemedIndex: Number($('deemedIndex').value),

    baseGrowthRate: (Number($('baseGrowthRate').value) || 0) / 100,
    accountInterestRate: (Number($('accountInterestRate').value) || 0) / 100,
    transitionRate: (Number($('transitionRate').value) || 0) / 100,

    earlyMonths: Number($('earlyMonths').value),
    delayMonths: Number($('delayMonths').value),
  }
  return state
}

/* ── 渲染 ───────────────────────────────────────────────── */

/**
 * 大数字的滚动过渡。上一次未播完的动画会被打断，从当前位置重新起算。
 *
 * 动画用 `setInterval` 而不是 `requestAnimationFrame`：标签页切到后台时浏览器
 * 停发渲染帧，rAF 回调会被一直挂起，数字就永久停在旧值上 —— 用户切回来看到的是
 * 过期结果。定时器即使被节流也一定会跑到最后一步，届时强制写入终值，
 * 所以「显示的数」与「算出的数」在任何情况下都不会脱节。
 *
 * 真实值同时写在 `dataset.raw` 上，与播放中的过渡值区分开。
 */
const tweens = new Map()
function tweenNumber(el, to, formatter) {
  const from = Number(el.dataset.raw ?? to)
  el.dataset.raw = String(to)
  const previous = tweens.get(el)
  if (previous !== undefined) clearInterval(previous)
  tweens.delete(el)

  if (!Number.isFinite(from) || Math.abs(to - from) < 0.005) {
    el.textContent = formatter(to)
    return
  }

  const start = performance.now()
  const duration = 200
  const settle = () => {
    clearInterval(timer)
    tweens.delete(el)
    el.textContent = formatter(Number(el.dataset.raw))
  }
  const timer = setInterval(() => {
    const t = Math.min(1, (performance.now() - start) / duration)
    if (t >= 1) {
      settle()
      return
    }
    const eased = 1 - (1 - t) ** 3
    el.textContent = formatter(from + (to - from) * eased)
  }, 16)
  tweens.set(el, timer)
}

function renderHero(result) {
  const days = result.daysUntilRetire
  tweenNumber($('daysValue'), Math.max(0, days), value => formatDays(Math.round(value)))

  if (days > 0) {
    const years = days / 365.2425
    $('daysNote').textContent = `约 ${years.toFixed(1)} 年 · ${formatMonths(Math.round(days / 30.44))}`
    $('daysDate').textContent = `${formatYearMonth(result.retirementYearMonth)} 达到条件，退休年龄 ${result.retirementAgeText}`
  } else {
    $('daysNote').textContent = '已达到法定退休条件'
    $('daysDate').textContent = `${formatYearMonth(result.retirementYearMonth)} · ${result.retirementAgeText}`
  }

  tweenNumber($('pensionValue'), result.monthlyPension, value => formatMoney(value))
  $('pensionNote').textContent = `每年约 ￥${formatMoney(result.annualPension)}`
  $('pensionSub').textContent = `相当于退休前工资的 ${formatPercent(result.wageReplacement, 1)}`
    + `（退休前月工资约 ￥${formatMoney(result.preRetirementWage)}）`
}

function renderMetrics(result) {
  const province = findProvince(result.input.province)
  const meets = result.meetsMinimum
  const metrics = [
    {
      label: '退休年月',
      value: formatYearMonth(result.retirementYearMonth),
      note: result.legal.delayMonths > 0 ? `延迟 ${result.legal.delayMonths} 个月` : '不受延迟影响',
    },
    {
      label: '退休年龄',
      value: result.retirementAgeText,
      note: `法定 ${formatAge(result.legal.age)}`,
    },
    {
      label: '累计缴费年限',
      value: formatMonths(result.totalPaidMonths),
      note: `最低要求 ${formatMonths(result.requiredMonths)}`,
      tone: meets ? 'pos' : 'neg',
    },
    {
      label: '平均缴费指数',
      value: result.averageIndex.toFixed(4),
      note: `${formatPercent(result.averageIndex, 0)} 档`,
    },
    {
      label: '退休时个人账户',
      value: `￥${formatMoney(result.projectedAccountBalance)}`,
      note: `含利息 ￥${formatMoney(result.accountProjection.interestEarned)}`,
    },
    {
      label: '计发月数',
      value: `${result.annuityMonths} 个月`,
      note: `按 ${result.actual.age.years} 周岁取值`,
    },
    {
      label: '计发基数',
      value: `￥${formatMoney(result.baseAtRetirement)}`,
      note: `${result.retirementYearMonth.year - 1} 年 · ${province ? province.name : ''}`,
    },
    {
      label: '养老金替代率',
      value: formatPercent(result.replacementRate, 1),
      note: '对当地计发基数',
    },
  ]

  $('metricGrid').innerHTML = metrics.map(metric => `
    <div class="metric">
      <dt>${metric.label}</dt>
      <dd class="${metric.tone ?? ''}">${metric.value}</dd>
      <dt style="margin:4px 0 0">${metric.note ?? ''}</dt>
    </div>`).join('')
}

function renderCallout(result) {
  const target = $('statusCallout')
  if (!result.meetsMinimum) {
    const shortfall = result.requiredMonths - result.totalPaidMonths
    target.innerHTML = `<div class="callout warn"><b>缴费年限还差 ${formatMonths(shortfall)}。</b>
      在 ${result.retirementYearMonth.year} 年退休，领取养老金的最低缴费年限为 ${formatMonths(result.requiredMonths)}，
      当前测算的累计缴费年限只有 ${formatMonths(result.totalPaidMonths)}。
      需要继续缴费或补缴，否则无法按月领取基本养老金。</div>`
    return
  }
  const spec = CATEGORIES[result.input.category]
  target.innerHTML = `<div class="callout ok"><b>已满足最低缴费年限。</b>
    ${spec.label}的法定退休年龄为 ${spec.originalAge} 周岁，
    ${result.legal.delayMonths > 0
      ? `本次改革下延迟 ${result.legal.delayMonths} 个月，实际按 ${formatAge(result.legal.age)} 执行。`
      : '本次改革不影响其退休时点。'}
    ${result.actual.mode === 'early' ? `已选择弹性提前 ${Math.abs(result.actual.appliedMonths)} 个月。` : ''}
    ${result.actual.mode === 'delay' ? `已选择弹性延后 ${result.actual.appliedMonths} 个月。` : ''}
    ${result.actual.reason ? `（${result.actual.reason}）` : ''}</div>`
}

function renderBreakdown(result) {
  const input = result.input
  const base = result.baseAtRetirement
  const years = result.totalPaidYears
  const lines = []

  const rows = []
  rows.push({
    title: '基础养老金',
    formula: `(${formatMoney(base)} × (1 + ${result.averageIndex.toFixed(4)})) ÷ 2 × ${years.toFixed(2)} 年 × 1%`,
    amount: result.basicPension,
    note: `计发基数 ${formatMoney(base)} 元/月，缴费年限 ${formatMonths(result.totalPaidMonths)}`,
  })
  rows.push({
    title: '个人账户养老金',
    formula: `${formatMoney(result.projectedAccountBalance)} ÷ ${result.annuityMonths}`,
    amount: result.accountPension,
    note: `账户里本金 ${formatMoney(input.accountBalance + result.accountProjection.contributed)} 元、记账利息 ${formatMoney(result.accountProjection.interestEarned)} 元`,
  })
  if (result.transitionalPension > 0) {
    rows.push({
      title: '过渡性养老金',
      formula: `${formatMoney(base)} × ${input.deemedIndex.toFixed(4)} × ${formatPercent(input.transitionRate)} × ${(input.deemedMonths / 12).toFixed(2)} 年`,
      amount: result.transitionalPension,
      note: `视同缴费年限 ${formatMonths(input.deemedMonths)}`,
    })
  }

  for (const row of rows) {
    lines.push(`<div class="line">
      <div class="desc"><b>${row.title}</b><code>${row.formula}</code>
      <code style="color:#98a2b3">${row.note}</code></div>
      <div class="amt">￥${formatMoney(row.amount)}</div>
    </div>`)
  }

  lines.push(`<div class="line total">
    <div class="desc"><b>合计每月</b><code>基本养老金 = 基础养老金 + 个人账户养老金${result.transitionalPension > 0 ? ' + 过渡性养老金' : ''}</code></div>
    <div class="amt">￥${formatMoney(result.monthlyPension)}</div>
  </div>`)

  lines.push(`<div class="line" style="border-top:1px dashed #e4e7ec;margin-top:10px;padding-top:10px">
    <div class="desc"><b>个人账户推演</b>
      <code>当前 ${formatMoney(input.accountBalance)} ＋ 未来缴费 ${formatMoney(result.accountProjection.contributed)} ＋ 记账利息 ${formatMoney(result.accountProjection.interestEarned)} ＝ 退休时 ${formatMoney(result.projectedAccountBalance)}</code>
      <code style="color:#98a2b3">未来 ${result.accountProjection.monthsPaid} 个月实际缴费，其余 ${result.accountProjection.months - result.accountProjection.monthsPaid} 个月只计息</code>
    </div>
    <div class="amt" style="font-size:14px">￥${formatMoney(input.accountBalance)} → ￥${formatMoney(result.projectedAccountBalance)}</div>
  </div>`)

  $('breakdown').innerHTML = lines.join('')
}

/**
 * 三个「提高待遇」情景，每个只改一个变量。
 *
 * 已缴的部分改不了，所以「提高缴费档次」被解读为「假设从头到尾都按更高档缴」，
 * 这在文案里写清楚，避免被误读成可以追溯修改历史缴费。
 */
function renderSensitivity(result) {
  const now = new Date(result.computedAt)
  const baseInput = result.input
  const rows = []

  const scenario = (label, patch, note) => {
    const variant = compute({ ...baseInput, ...patch }, now)
    rows.push({ label, note, pension: variant.monthlyPension, days: variant.daysUntilRetire })
  }

  rows.push({
    label: '当前方案', note: '', pension: result.monthlyPension,
    days: result.daysUntilRetire, isBase: true,
  })

  scenario('继续多缴 5 年', { futureMonths: baseInput.futureMonths + 60 },
    `缴费年限 ${formatMonths(baseInput.paidMonths + baseInput.futureMonths)} → ${formatMonths(baseInput.paidMonths + baseInput.futureMonths + 60)}`)

  scenario('全程缴费档次提高 0.2',
    {
      paidIndex: Math.min(3, baseInput.paidIndex + 0.2),
      futureIndex: Math.min(3, baseInput.futureIndex + 0.2),
      deemedIndex: Math.min(3, baseInput.deemedIndex + 0.2),
    },
    `平均指数 ${baseInput.paidIndex.toFixed(2)} → ${Math.min(3, baseInput.paidIndex + 0.2).toFixed(2)}`)

  scenario('弹性延后 3 年退休', { earlyMonths: 0, delayMonths: 36 },
    '多缴 3 年、计发月数变小')

  const basePension = result.monthlyPension
  $('sensTable').innerHTML = `
    <thead><tr><th>情景</th><th>预计月养老金</th><th>距退休</th></tr></thead>
    <tbody>${rows.map(row => {
      const diff = row.pension - basePension
      const delta = row.isBase || Math.abs(diff) < 0.01
        ? ''
        : `<span class="delta ${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : '−'}￥${formatMoney(Math.abs(diff))}</span>`
      const pct = row.isBase || Math.abs(basePension) < 0.01
        ? ''
        : `<div style="font-size:11.5px;color:#98a2b3">${diff >= 0 ? '+' : '−'}${Math.abs(diff / basePension * 100).toFixed(1)}%</div>`
      return `<tr class="${row.isBase ? 'base' : ''}">
        <td>${row.label}${row.note ? `<div style="font-size:11.5px;color:#98a2b3">${row.note}</div>` : ''}</td>
        <td>￥${formatMoney(row.pension)}${delta}${pct}</td>
        <td>${row.isBase ? '—' : (row.days > 0 ? `${formatDays(row.days)} 天` : '已到龄')}</td>
      </tr>`
    }).join('')}</tbody>`
}

function renderAll(result) {
  lastResult = result
  renderHero(result)
  renderMetrics(result)
  renderCallout(result)
  renderBreakdown(result)
  renderSensitivity(result)
  $('asOf').textContent = `${result.asOfText}`
}

/* ── 事件接线 ───────────────────────────────────────────── */

/** 重算 + 重绘。任何输入事件都走这里。 */
function refresh() {
  readForm()
  updateDerivedLabels()
  renderAll(compute(state, new Date()))
}

/** 与结果无关、只反映输入本身的实时标签。 */
function updateDerivedLabels() {
  $('paidIndexVal').textContent = `${state.paidIndex.toFixed(2)}（${formatPercent(state.paidIndex, 0)} 档）`
  $('futureIndexVal').textContent = `${state.futureIndex.toFixed(2)}（${formatPercent(state.futureIndex, 0)} 档）`
  $('deemedIndexVal').textContent = `${state.deemedIndex.toFixed(2)}（${formatPercent(state.deemedIndex, 0)} 档）`
  $('earlyVal').textContent = state.earlyMonths === 0 ? '不提前' : `${state.earlyMonths} 个月`
  $('delayVal').textContent = state.delayMonths === 0 ? '不延后' : `${state.delayMonths} 个月`

  $('categoryHint').textContent = CATEGORIES[state.category].description

  const province = findProvince(state.province)
  if (province) {
    const statusText = province.status === 'published'
      ? `${province.year} 年官方公布值`
      : province.status === 'reference'
        ? `${province.year} 年值（新一年度未公布）`
        : '未收录'
    $('provinceHint').textContent = province.note
      ? `${statusText}：${formatMoney(province.base)} 元/月 · ${province.note}`
      : `${statusText}：${formatMoney(province.base)} 元/月`
    $('provinceHint').className = province.status === 'manual' ? 'hint warn' : 'hint'
  }

  $('baseHint').textContent = `当前按 ${state.baseYear} 年的 ${formatMoney(state.baseAmount)} 元/月推算，`
    + `以每年 ${(state.baseGrowthRate * 100).toFixed(1)}% 递增到退休时。`
}

/**
 * 合并同一批输入触发的重算，避免拖动滑块时重复渲染并打断数字动画。
 *
 * 这里用 `setTimeout(…, 0)` 而不是 `requestAnimationFrame`：无头环境（或页面被
 * 隐藏时）没有渲染帧，rAF 回调会被无限推迟，交互就会静默失效。定时器在所有
 * 环境下都会触发，代价只是可能多算一次 —— 而一次计算是微秒级的。
 */
let refreshQueued = false
function scheduleRefresh() {
  if (refreshQueued) return
  refreshQueued = true
  setTimeout(() => {
    refreshQueued = false
    refresh()
  }, 0)
}

function wireEvents() {
  // `input` 事件对 number / range / radio / select 都会触发，绑一个就够。
  $('form').addEventListener('input', event => {
    // 切换退休地时，把计发基数带到该省的默认值。
    if (event.target.id === 'province') {
      const code = $('province').value
      state.baseAmount = defaultBaseFor(code)
      state.baseYear = defaultBaseYearFor(code)
      $('baseAmount').value = Math.round(state.baseAmount)
    }
    scheduleRefresh()
  })

  $('resetBtn').addEventListener('click', () => {
    state = { ...INITIAL }
    writeForm()
    refresh()
    toast('已恢复默认参数')
  })

  $('copyBtn').addEventListener('click', async () => {
    if (!lastResult) return
    const text = formatReport(lastResult)
      + `\n\n（测算口径：渐进式延迟退休改革 + 国发〔2005〕38 号计发月数表。`
      + `计发基数等参数为假设值，实际待遇以社保经办机构核定为准。）`
    try {
      await navigator.clipboard.writeText(text)
      toast('已复制到剪贴板')
    } catch {
      toast('复制失败，请手动选择文本')
    }
  })

  $('printBtn').addEventListener('click', () => window.print())
}

let toastTimer
function toast(message) {
  const el = $('toast')
  el.textContent = message
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800)
}

/* ── 启动 ───────────────────────────────────────────────── */

buildStaticControls()
state = { ...INITIAL }
writeForm()
wireEvents()
refresh()

// 页面跨过零点时，「距退休天数」应该少一天。每分钟对一次，成本可以忽略。
setInterval(() => {
  const before = lastResult ? lastResult.asOfText : ''
  const result = compute(state, new Date())
  if (result.asOfText !== before) renderAll(result)
}, 60_000)
