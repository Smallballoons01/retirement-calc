/**
 * retirement_calc/core.js — 中国城镇职工基本养老保险退休测算引擎。
 *
 * 纯逻辑、零依赖、ESM。同一份代码在 Node（测试 / DSH 插件宿主端）与浏览器
 * （内联进单文件计算器）里运行，所以这里不碰任何 IO、不读时钟以外的环境。
 *
 * 计算口径全部来自公开法规，每一处都能追溯到文号：
 *
 * - **渐进式延迟法定退休年龄**（全国人大常委会 2024-09-13 决定）：
 *   自 2025-01-01 起，原法定退休年龄 60 周岁的男性每 4 个月延迟 1 个月至 63 周岁；
 *   原 55 周岁的女性每 4 个月延迟 1 个月至 58 周岁；原 50 周岁的女性每 2 个月
 *   延迟 1 个月至 55 周岁。本例按「原退休时点距 2025-01 的月数」定位延迟档位。
 * - **最低缴费年限**：2029-12-31 前仍为 15 年；自 2030 年起每年提高 6 个月，
 *   2039 年及以后为 20 年。
 * - **计发月数表**：国发〔2005〕38 号附件，按办理退休时的**满周岁**年龄取值
 *   （例：50 周岁 11 个月退休，按 50 岁对应的 195 个月计发）。
 * - **养老金构成**：基础养老金 + 个人账户养老金（+ 有视同缴费年限者的过渡性养老金）。
 *
 * @module core
 */

/** 引擎版本，随包发布。 */
export const ENGINE_VERSION = '0.1.0'

/* ────────────────────────────────────────────────────────────────
 * 1. 年月运算
 *
 * 全程用「月序号」（year * 12 + month - 1）做整数运算，避免 Date 的时区、
 * 月末进位等坑。退休测算的最小粒度就是月，用整数最稳。
 * ──────────────────────────────────────────────────────────────── */

/**
 * 把 `{year, month}` 转成线性月序号。
 * @param {{year: number, month: number}} ym 年月，month 为 1-12。
 * @returns {number} 月序号。
 */
export function monthIndexOf(ym) {
  return ym.year * 12 + (ym.month - 1)
}

/**
 * 月序号还原为 `{year, month}`。
 * @param {number} index 月序号。
 * @returns {{year: number, month: number}} 年月。
 */
export function yearMonthOf(index) {
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

/**
 * 年月加减若干个月。
 * @param {{year: number, month: number}} ym 起始年月。
 * @param {number} months 偏移月数，可为负。
 * @returns {{year: number, month: number}} 结果年月。
 */
export function addMonths(ym, months) {
  return yearMonthOf(monthIndexOf(ym) + months)
}

/**
 * 两个年月之间的整月数。
 * @param {{year: number, month: number}} from 起始。
 * @param {{year: number, month: number}} to 结束。
 * @returns {number} 月数，to 早于 from 时为负。
 */
export function monthsBetween(from, to) {
  return monthIndexOf(to) - monthIndexOf(from)
}

/**
 * 按出生年月与某个时点算年龄。
 * @param {{year: number, month: number}} birth 出生年月。
 * @param {{year: number, month: number}} at 时点年月。
 * @returns {{years: number, months: number, totalMonths: number}} 年龄。
 */
export function ageAt(birth, at) {
  const totalMonths = monthsBetween(birth, at)
  return { years: Math.floor(totalMonths / 12), months: totalMonths % 12, totalMonths }
}

/** 把年月格式化成 `2041年3月`。 */
export function formatYearMonth(ym) {
  return `${ym.year}年${ym.month}月`
}

/** 把年龄格式化成 `63岁` 或 `57岁1个月`。 */
export function formatAge(age) {
  return age.months === 0 ? `${age.years}岁` : `${age.years}岁${age.months}个月`
}

/* ────────────────────────────────────────────────────────────────
 * 2. 法定退休年龄（渐进式延迟）
 * ──────────────────────────────────────────────────────────────── */

/**
 * 三类参保人群的原法定退休年龄与延迟节奏。
 *
 * `step` 是「每多少个月延迟 1 个月」，`cap` 是累计延迟上限（月）。
 * 两者都直接来自改革决定：男职工与原 55 岁女职工上限 36 个月（+3 岁），
 * 原 50 岁女职工上限 60 个月（+5 岁）。
 */
export const CATEGORIES = {
  male: {
    key: 'male',
    label: '男职工',
    shortLabel: '男',
    originalAge: 60,
    finalAge: 63,
    step: 4,
    cap: 36,
    description: '男职工，原法定退休年龄 60 周岁，每 4 个月延迟 1 个月，至 63 周岁。',
  },
  female55: {
    key: 'female55',
    label: '女职工·管理技术岗',
    shortLabel: '女（原55）',
    originalAge: 55,
    finalAge: 58,
    step: 4,
    cap: 36,
    description: '原法定退休年龄 55 周岁的女职工（女干部、管理技术岗），每 4 个月延迟 1 个月，至 58 周岁。',
  },
  female50: {
    key: 'female50',
    label: '女职工·工人岗',
    shortLabel: '女（原50）',
    originalAge: 50,
    finalAge: 55,
    step: 2,
    cap: 60,
    description: '原法定退休年龄 50 周岁的女职工（工人岗），每 2 个月延迟 1 个月，至 55 周岁。',
  },
}

/** 延迟退休改革的起算锚点：2025 年 1 月。 */
const REFORM_ANCHOR = { year: 2025, month: 1 }

/**
 * 缴费基数上下限对应的缴费指数范围。
 *
 * 国家统一规则：职工缴费基数不得低于全省全口径社平的 60%，不得高于 300%，
 * 因此任何一年的缴费指数都必然落在 [0.6, 3.0] 之内。金额模式下要用它夹一下 ——
 * 填一个低于下限的基数，算出来的 0.4 之类的档位在多数省份根本不让你缴。
 */
export const MIN_INDEX = 0.6
export const MAX_INDEX = 3

/**
 * 算某人的法定退休时点（不含弹性提前/延后）。
 *
 * 定位方式：先按原法定年龄算出「原本该退休的年月」，再看它与 2025-01 的距离。
 * 距离为负（2024-12 及以前就该退）即不受新政影响；否则第 n 个 step 月区间延迟
 * n 个月，并受 cap 封顶。
 *
 * 该式与官方对照表逐月一致：2025 年 1-4 月退休者延 1 个月，5-8 月延 2 个月，
 * 9-12 月延 3 个月……
 *
 * @param {{year: number, month: number}} birth 出生年月。
 * @param {keyof CATEGORIES} category 人群类别。
 * @returns {{
 *   category: string,
 *   originalYearMonth: {year: number, month: number},
 *   originalAge: number,
 *   delayMonths: number,
 *   yearMonth: {year: number, month: number},
 *   age: {years: number, months: number, totalMonths: number},
 *   atCeiling: boolean,
 * }} 法定退休信息。
 */
export function legalRetirement(birth, category) {
  const spec = CATEGORIES[category]
  if (spec === undefined) throw new Error(`未知的人群类别：${category}`)

  const originalIndex = monthIndexOf(birth) + spec.originalAge * 12
  const offset = originalIndex - monthIndexOf(REFORM_ANCHOR)
  const delayMonths = offset < 0
    ? 0
    : Math.min(spec.cap, Math.floor(offset / spec.step) + 1)

  const retirementIndex = originalIndex + delayMonths
  const yearMonth = yearMonthOf(retirementIndex)
  return {
    category,
    originalYearMonth: yearMonthOf(originalIndex),
    originalAge: spec.originalAge,
    delayMonths,
    yearMonth,
    age: ageAt(birth, yearMonth),
    atCeiling: delayMonths === spec.cap,
  }
}

/**
 * 应用弹性退休选择。
 *
 * 规则（改革决定原文）：达到最低缴费年限可自愿提前，**最长 3 年**，且不得低于
 * 原法定退休年龄；达到法定退休年龄后经与单位协商可延迟，**最长 3 年**。
 *
 * @param {{year: number, month: number}} birth 出生年月。
 * @param {keyof CATEGORIES} category 人群类别。
 * @param {{earlyMonths?: number, delayMonths?: number}} flex 弹性选择，单位月。
 * @returns {{
 *   yearMonth: {year: number, month: number},
 *   age: {years: number, months: number, totalMonths: number},
 *   appliedMonths: number,
 *   mode: 'legal'|'early'|'delay',
 *   clamped: boolean,
 *   reason: string,
 * }} 实际退休时点。
 */
export function applyFlexible(birth, category, flex = {}) {
  const spec = CATEGORIES[category]
  const legal = legalRetirement(birth, category)
  const legalIndex = monthIndexOf(legal.yearMonth)

  const earlyRequested = Math.max(0, Math.round(flex.earlyMonths ?? 0))
  const delayRequested = Math.max(0, Math.round(flex.delayMonths ?? 0))

  // 提前与延后互斥；同时给出时以提前为准，并把原因写回去，避免静默吞掉输入。
  const early = Math.min(earlyRequested, 36)
  const late = earlyRequested > 0 ? 0 : Math.min(delayRequested, 36)

  // 提前的下界是原法定退休年龄，不是「法定年龄 - 3 年」。
  const earliestIndex = monthIndexOf(birth) + spec.originalAge * 12
  let applied = legalIndex - early + late
  let clamped = false
  if (applied < earliestIndex) {
    applied = earliestIndex
    clamped = true
  }

  const yearMonth = yearMonthOf(applied)
  const mode = applied < legalIndex ? 'early' : applied > legalIndex ? 'delay' : 'legal'
  const notes = []
  if (earlyRequested > 36) notes.push('弹性提前最长 3 年，已按 36 个月封顶')
  if (delayRequested > 36) notes.push('弹性延后最长 3 年，已按 36 个月封顶')
  if (earlyRequested > 0 && delayRequested > 0) notes.push('提前与延后互斥，已按提前处理')
  if (clamped) notes.push(`提前不得低于原法定退休年龄 ${spec.originalAge} 周岁，已上收到该年龄`)

  return {
    yearMonth,
    age: ageAt(birth, yearMonth),
    appliedMonths: applied - legalIndex,
    mode,
    clamped,
    reason: notes.join('；'),
  }
}

/* ────────────────────────────────────────────────────────────────
 * 3. 最低缴费年限
 * ──────────────────────────────────────────────────────────────── */

/**
 * 领取基本养老金的最低缴费年限（按月计）。
 *
 * 2029 年及以前退休仍为 15 年（180 个月）；自 2030 年起每年提高 6 个月，
 * 到 2039 年达到 20 年（240 个月）后不再提高。
 *
 * @param {{year: number, month: number}} retireYearMonth 退休年月。
 * @returns {number} 最低缴费月数。
 */
export function minimumContributionMonths(retireYearMonth) {
  const year = retireYearMonth.year
  if (year <= 2029) return 180
  return Math.min(240, 180 + (year - 2029) * 6)
}

/** 把月数格式化成 `19年6个月`。 */
export function formatMonths(months) {
  const total = Math.max(0, Math.round(months))
  const years = Math.floor(total / 12)
  const rest = total % 12
  if (years === 0) return `${rest}个月`
  if (rest === 0) return `${years}年`
  return `${years}年${rest}个月`
}

/* ────────────────────────────────────────────────────────────────
 * 4. 个人账户养老金计发月数表
 * ──────────────────────────────────────────────────────────────── */

/**
 * 个人账户养老金计发月数表（国发〔2005〕38 号附件）。
 * 键为办理退休时的**满周岁**年龄。
 */
export const ANNUITY_MONTHS_TABLE = Object.freeze({
  40: 233, 41: 230, 42: 226, 43: 223, 44: 220, 45: 216, 46: 212, 47: 208,
  48: 204, 49: 199, 50: 195, 51: 190, 52: 185, 53: 180, 54: 175, 55: 170,
  56: 164, 57: 158, 58: 152, 59: 145, 60: 139, 61: 132, 62: 125, 63: 117,
  64: 109, 65: 101, 66: 93, 67: 84, 68: 75, 69: 65, 70: 56,
})

/**
 * 查计发月数。按满周岁取值：40 岁以下按 40 岁，70 岁以上按 70 岁。
 * @param {number} ageYears 退休时的周岁年龄（可为小数，内部向下取整）。
 * @returns {number} 计发月数。
 */
export function annuityMonths(ageYears) {
  const age = Math.min(70, Math.max(40, Math.floor(ageYears)))
  return ANNUITY_MONTHS_TABLE[age]
}

/* ────────────────────────────────────────────────────────────────
 * 5. 各省养老金计发基数
 *
 * 计发基数每年由省级人社厅公布，用于替代早期的「上年度在岗职工月平均工资」。
 * 数据只作**默认值**，面板与工具都允许覆盖 —— 计发基数会随年份更新，内置表
 * 迟早会过期，所以每一项都带 `year` 与 `status`（published = 官方已公布，
 * reference = 沿用上一年度，manual = 未收录需手工填写）。
 * ──────────────────────────────────────────────────────────────── */

/** 省级计发基数默认表。金额单位为元/月。 */
export const PROVINCES = Object.freeze([
  { code: 'shanghai', name: '上海', base: 12434, year: 2025, status: 'published' },
  { code: 'tibet', name: '西藏', base: 11777, year: 2025, status: 'published' },
  { code: 'beijing', name: '北京', base: 11883, year: 2024, status: 'reference', note: '2025 年基数未公布，沿用 2024 年值' },
  { code: 'guangdong', name: '广东', base: 9493, year: 2025, status: 'published', note: '深圳单独公布，未包含' },
  { code: 'qinghai', name: '青海', base: 9056, year: 2025, status: 'published' },
  { code: 'jiangsu', name: '江苏', base: 8917, year: 2025, status: 'published' },
  { code: 'xinjiang', name: '新疆', base: 8448, year: 2025, status: 'published' },
  { code: 'zhejiang', name: '浙江', base: 8433, year: 2025, status: 'published' },
  { code: 'ningxia', name: '宁夏', base: 8366, year: 2025, status: 'published' },
  { code: 'yunnan', name: '云南', base: 8265, year: 2025, status: 'published' },
  { code: 'neimenggu', name: '内蒙古', base: 8179, year: 2025, status: 'published' },
  { code: 'fujian', name: '福建', base: 7932, year: 2025, status: 'published' },
  { code: 'hunan', name: '湖南', base: 7694, year: 2025, status: 'published' },
  { code: 'heilongjiang', name: '黑龙江', base: 7570, year: 2025, status: 'published' },
  { code: 'hebei', name: '河北', base: 7410, year: 2025, status: 'published' },
  { code: 'liaoning', name: '辽宁', base: 7346, year: 2025, status: 'published', note: '不含沈阳（8390）、大连（8956）' },
  { code: 'guizhou', name: '贵州', base: 7324.5, year: 2025, status: 'published' },
  { code: 'jilin', name: '吉林', base: 7322, year: 2025, status: 'published', note: '不含长春（7978.25）' },
  { code: 'tianjin', name: '天津', base: 9232, year: 2024, status: 'reference', note: '2025 年基数未公布，沿用 2024 年值' },
  { code: 'hubei', name: '湖北', base: 8613, year: 2024, status: 'reference', note: '2025 年基数未公布，沿用 2024 年值' },
  { code: 'sichuan', name: '四川', base: 8321, year: 2024, status: 'reference', note: '2025 年基数未公布，沿用 2024 年值' },
  { code: 'chongqing', name: '重庆', base: 8160, year: 2024, status: 'reference', note: '2025 年基数未公布，沿用 2024 年值' },
  { code: 'hainan', name: '海南', base: 8131, year: 2024, status: 'reference', note: '2025 年基数未公布，沿用 2024 年值' },
  { code: 'anhui', name: '安徽', base: 7842, year: 2024, status: 'reference', note: '2025 年基数未公布，沿用 2024 年值' },
  { code: 'shandong', name: '山东', base: 7678, year: 2024, status: 'reference', note: '2025 年基数未公布，沿用 2024 年值；菏泽另计' },
  { code: 'shanxi', name: '山西', base: 7111, year: 2024, status: 'reference', note: '2025 年基数未公布，沿用 2024 年值' },
  { code: 'jiangxi', name: '江西', base: 6916, year: 2024, status: 'reference', note: '2025 年基数未公布，沿用 2024 年值' },
  { code: 'guangxi', name: '广西', base: 6847, year: 2024, status: 'reference', note: '2025 年基数未公布，沿用 2024 年值' },
  { code: 'henan', name: '河南', base: 0, year: 0, status: 'manual', note: '未收录，请填当地最新计发基数' },
  { code: 'shaanxi', name: '陕西', base: 0, year: 0, status: 'manual', note: '未收录，请填当地最新计发基数' },
  { code: 'gansu', name: '甘肃', base: 0, year: 0, status: 'manual', note: '未收录，请填当地最新计发基数' },
  { code: 'shenzhen', name: '深圳', base: 13730, year: 2023, status: 'reference', note: '深圳单独公布，此处为 2023 年值，务必替换' },
])

/** 省份未收录时使用的通用兜底基数，避免出现 0 元/月的荒谬结果。 */
export const FALLBACK_BASE_AMOUNT = 7000

/**
 * 按省份代码取省份记录。
 * @param {string} code 省份代码。
 * @returns {typeof PROVINCES[number] | undefined} 省份记录。
 */
export function findProvince(code) {
  return PROVINCES.find(province => province.code === code)
}

/**
 * 某省份的默认计发基数。
 *
 * 面板与 normalizeInput 都调它，保证「输入框里显示的数」与「实际参与计算的数」
 * 是同一个，不会出现表单空白但结果照算的口径分裂。
 * @param {string} code 省份代码。
 * @returns {number} 计发基数（元/月）。
 */
export function defaultBaseFor(code) {
  const province = findProvince(code)
  return province !== undefined && province.base > 0 ? province.base : FALLBACK_BASE_AMOUNT
}

/**
 * 某省份默认计发基数对应的年份。
 * @param {string} code 省份代码。
 * @returns {number} 年份。
 */
export function defaultBaseYearFor(code) {
  const province = findProvince(code)
  return province !== undefined && province.year > 0 ? province.year : DEFAULT_INPUT.baseYear
}

/* ────────────────────────────────────────────────────────────────
 * 6. 默认输入
 * ──────────────────────────────────────────────────────────────── */

/**
 * 一份完整的默认输入。所有字段都可以被覆盖，`normalizeInput` 负责兜底，
 * 参数面板和工具调用都从这份结构出发。
 */
export const DEFAULT_INPUT = Object.freeze({
  // —— 个人信息 ——
  birthYear: 1990,
  birthMonth: 1,
  category: 'male',            // male | female55 | female50
  province: 'guangdong',

  // —— 参保情况 ——
  insuredType: 'employee',     // employee 职工 | flexible 灵活就业
  paidMonths: 0,               // 已缴月数（累计，含视同缴费前的实际缴费）
  paidIndex: 0.6,              // 已缴部分的平均缴费指数（0.6 = 60% 档）
  futureMonths: 0,             // 计划继续缴费的月数
  futureIndex: 0.6,            // 未来缴费指数（指数模式下使用）

  // —— 缴费基数（金额模式）——
  //
  // 上面那对 index 字段适合「我一直按 60% 档缴」这种说法，但表达不了更常见的情形：
  // 基数是一个**确定金额**（比如 10000 元/月），而社平逐年上涨 —— 此时缴费指数
  // 逐年**下降**，养老金被拉低，用固定指数去算会偏高。
  //
  // 所以允许直接填金额。`monthlyBase > 0` 即切换到金额模式，指数由基数与当年社平
  // 现算：指数 = 缴费基数 ÷ 当年社平。个人账户也按真实基数 × 8% 记账。
  monthlyBase: 0,              // 当前月缴费基数（元）；0 = 用 futureIndex 的指数模式
  futureMonthlyBase: 0,        // 未来的月缴费基数（元）；0 = 沿用 monthlyBase
  baseFollowsAverage: true,    // 未来基数是否随社平同步上调
                               // true  → 指数保持不变（相当于「按同一档位缴到底」）
                               // false → 基数固定，指数逐年下降（「以后就按这个数缴」）
  accountBalance: 0,           // 当前个人账户累计储存额（元）
  deemedMonths: 0,             // 视同缴费年限（月），1990 年代统账结合前的工龄
  deemedIndex: 0.6,            // 视同缴费指数

  // —— 经济假设 ——
  baseAmount: 9493,            // 当年计发基数（元/月）
  baseYear: 2025,              // 计发基数对应年份
  baseGrowthRate: 0.02,        // 计发基数年增长率
  accountInterestRate: 0.015,  // 个人账户记账利率（2025 年全国口径 1.5%）
  transitionRate: 0.013,       // 过渡性养老金系数（各省 1.0%-1.4%）
  indexFloorFactor: false,     // 是否启用「指数低于 0.6 时折减」的地方规则（广东等）

  // —— 弹性退休 ——
  earlyMonths: 0,              // 弹性提前月数（≤36）
  delayMonths: 0,              // 弹性延后月数（≤36）
})

/** 数值字段的兜底与边界。 */
function num(value, fallback, min = -Infinity, max = Infinity) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * 把外部输入补齐成完整、合法的一份。
 *
 * 工具调用、网页表单、设置页三条输入路径的字段都可能缺，统一在这里兜底，
 * 下游计算就不必再做存在性判断。
 *
 * @param {Partial<typeof DEFAULT_INPUT>} input 外部输入。
 * @returns {typeof DEFAULT_INPUT} 完整输入。
 */
export function normalizeInput(input = {}) {
  const province = findProvince(input.province) ?? findProvince(DEFAULT_INPUT.province)
  // 只有正数才算「显式指定」；空串、0、NaN 一律回落到省份默认表。
  //
  // baseYear 上的这个判断不是形式主义：0 是个合法数字，直接交给 `num()` 会被
  // clamp 到下限（2000 年），于是计发基数被推了二十多年的复利，月养老金能虚高
  // 六成。持久化档案里「0 = 跟随省份」是常见状态，所以这条路径一定会被走到。
  const hasExplicitBase = Number.isFinite(Number(input.baseAmount)) && Number(input.baseAmount) > 0
  const hasExplicitBaseYear = Number.isFinite(Number(input.baseYear)) && Number(input.baseYear) > 0

  const category = CATEGORIES[input.category] === undefined ? DEFAULT_INPUT.category : input.category
  const insuredType = input.insuredType === 'flexible' ? 'flexible' : 'employee'

  return {
    birthYear: num(input.birthYear, DEFAULT_INPUT.birthYear, 1940, 2010),
    birthMonth: Math.round(num(input.birthMonth, DEFAULT_INPUT.birthMonth, 1, 12)),
    category,
    province: province.code,

    insuredType,
    paidMonths: Math.round(num(input.paidMonths, DEFAULT_INPUT.paidMonths, 0, 600)),
    paidIndex: num(input.paidIndex, DEFAULT_INPUT.paidIndex, 0.1, 5),
    futureMonths: Math.round(num(input.futureMonths, DEFAULT_INPUT.futureMonths, 0, 600)),
    futureIndex: num(input.futureIndex, DEFAULT_INPUT.futureIndex, 0.1, 5),
    monthlyBase: Math.round(num(input.monthlyBase, DEFAULT_INPUT.monthlyBase, 0, 1_000_000)),
    futureMonthlyBase: Math.round(num(input.futureMonthlyBase, DEFAULT_INPUT.futureMonthlyBase, 0, 1_000_000)),
    baseFollowsAverage: input.baseFollowsAverage !== false,
    accountBalance: num(input.accountBalance, DEFAULT_INPUT.accountBalance, 0, 1e9),
    deemedMonths: Math.round(num(input.deemedMonths, DEFAULT_INPUT.deemedMonths, 0, 600)),
    deemedIndex: num(input.deemedIndex, DEFAULT_INPUT.deemedIndex, 0.1, 5),

    // 用户显式填了基数就用他的；否则跟随省份默认表。
    baseAmount: hasExplicitBase ? Number(input.baseAmount) : defaultBaseFor(province.code),
    baseYear: hasExplicitBaseYear
      ? Math.round(num(input.baseYear, defaultBaseYearFor(province.code), 2000, 2060))
      : defaultBaseYearFor(province.code),
    baseGrowthRate: num(input.baseGrowthRate, DEFAULT_INPUT.baseGrowthRate, -0.05, 0.15),
    accountInterestRate: num(input.accountInterestRate, DEFAULT_INPUT.accountInterestRate, 0, 0.15),
    transitionRate: num(input.transitionRate, DEFAULT_INPUT.transitionRate, 0, 0.05),
    // 显式给了就用给的，没给就跟随省份默认（广东等省对指数低于 0.6 的情形折减）。
    indexFloorFactor: input.indexFloorFactor === undefined
      ? province.code === 'guangdong'
      : input.indexFloorFactor === true,

    earlyMonths: Math.round(num(input.earlyMonths, 0, 0, 120)),
    delayMonths: Math.round(num(input.delayMonths, 0, 0, 120)),
  }
}

/* ────────────────────────────────────────────────────────────────
 * 7. 个人账户累积预测
 * ──────────────────────────────────────────────────────────────── */

/**
 * 计发基数随年份增长后的值。
 * @param {typeof DEFAULT_INPUT} input 完整输入。
 * @param {number} year 目标年份。
 * @returns {number} 该年的计发基数（元/月）。
 */
export function baseAmountAt(input, year) {
  const steps = year - input.baseYear
  if (steps === 0) return input.baseAmount
  return input.baseAmount * (1 + input.baseGrowthRate) ** steps
}

/**
 * 某一年的月缴费基数。只在金额模式下有意义（`monthlyBase > 0`）。
 *
 * - `baseFollowsAverage` 为 true：基数随社平同比例上调，缴费指数因此**保持不变**
 *   —— 这对应「以后继续按现在这个档位缴」。
 * - 为 false：基数固定在填写的金额上，而社平还在涨，指数**逐年下滑**
 *   —— 这对应「以后就按这个数缴，不再跟着调」。
 *
 * @param {typeof DEFAULT_INPUT} input 完整输入。
 * @param {number} year 目标年份。
 * @param {{year: number, month: number}} asOfYearMonth 起算年月。
 * @returns {number} 该年的月缴费基数（元）。未启用金额模式时返回 0。
 */
export function contributionBaseFor(input, year, asOfYearMonth) {
  if (input.monthlyBase <= 0) return 0
  const start = input.futureMonthlyBase > 0 ? input.futureMonthlyBase : input.monthlyBase
  if (!input.baseFollowsAverage) return start
  const steps = year - asOfYearMonth.year
  return start * (1 + input.baseGrowthRate) ** steps
}

/**
 * 某一年的缴费指数。指数 = 当年缴费基数 ÷ 当年社平。
 *
 * 未启用金额模式时退回 {@link DEFAULT_INPUT.futureIndex}，所以两种模式可以无差别地
 * 被下游调用。
 *
 * @param {typeof DEFAULT_INPUT} input 完整输入。
 * @param {number} year 目标年份。
 * @param {{year: number, month: number}} asOfYearMonth 起算年月。
 * @returns {number} 该年的缴费指数。
 */
export function contributionIndexFor(input, year, asOfYearMonth) {
  if (input.monthlyBase <= 0) return input.futureIndex
  const social = baseAmountAt(input, year)
  if (social <= 0) return input.futureIndex
  const raw = contributionBaseFor(input, year, asOfYearMonth) / social
  // 缴费基数受「全省社平的 60%–300%」约束，所以指数天然落在 [0.6, 3.0]。
  // 不夹的话，填一个远低于社平的基数会算出 0.4 之类的值 —— 那种档位在多数省份
  // 根本不让你缴，因为它不满足基数下限。
  return Math.min(MAX_INDEX, Math.max(MIN_INDEX, raw))
}

/**
 * 未来缴费期的**逐月加权平均指数**。
 *
 * 指数模式下每个月都是同一个值，所以直接返回它；金额模式下逐月算，因此「基数固定、
 * 社平上涨」导致的指数逐年下滑会被如实反映进平均值 —— 这正是固定指数算不出来的东西。
 *
 * @param {typeof DEFAULT_INPUT} input 完整输入。
 * @param {{year: number, month: number}} retireYearMonth 退休年月。
 * @param {{year: number, month: number}} asOfYearMonth 起算年月。
 * @returns {{average: number, months: number}} 平均值与实际参与计算的月数。
 */
export function futureAverageIndex(input, retireYearMonth, asOfYearMonth) {
  const horizon = Math.max(0, monthsBetween(asOfYearMonth, retireYearMonth))
  const months = Math.min(input.futureMonths, horizon)
  if (months <= 0) return { average: input.futureIndex, months: 0 }
  if (input.monthlyBase <= 0) return { average: input.futureIndex, months }

  let sum = 0
  for (let step = 0; step < months; step += 1) {
    const cursor = yearMonthOf(monthIndexOf(asOfYearMonth) + step)
    sum += contributionIndexFor(input, cursor.year, asOfYearMonth)
  }
  return { average: sum / months, months }
}

/**
 * 逐月推演个人账户储存额到退休当月。
 *
 * 两件事同时发生：账户余额按月复利计息（记账利率折算成月利率），缴费月里
 * 按当月社平工资 × 缴费指数 × 8% 记入本金。注意「计划缴费月数」与「距退休
 * 月数」是两回事 —— 中断缴费的人退休前仍在计息，只是不再进本金。
 *
 * @param {typeof DEFAULT_INPUT} input 完整输入。
 * @param {{year: number, month: number}} retireYearMonth 退休年月。
 * @param {{year: number, month: number}} asOfYearMonth 估值基准年月。
 * @returns {{balance: number, interestEarned: number, contributed: number, months: number, monthsPaid: number}}
 *   退休时的账户余额与拆分。
 */
export function projectAccount(input, retireYearMonth, asOfYearMonth) {
  const monthlyRate = (1 + input.accountInterestRate) ** (1 / 12) - 1
  const horizon = Math.max(0, monthsBetween(asOfYearMonth, retireYearMonth))
  const monthsPaid = Math.min(input.futureMonths, horizon)

  const opening = input.accountBalance
  let balance = opening
  let contributed = 0

  for (let step = 0; step < horizon; step += 1) {
    const cursor = yearMonthOf(monthIndexOf(asOfYearMonth) + step)
    balance *= 1 + monthlyRate
    if (step < monthsPaid) {
      // 两种模式在这里合流：都先得到「这个月的缴费基数」，再按 8% 计入个人账户。
      // 金额模式直接用真实基数，所以「基数固定、社平上涨」时记账额也不会被虚增。
      const socialAverage = baseAmountAt(input, cursor.year)
      const contributionBase = input.monthlyBase > 0
        ? contributionBaseFor(input, cursor.year, asOfYearMonth)
        : socialAverage * input.futureIndex
      const deposit = contributionBase * 0.08
      balance += deposit
      contributed += deposit
    }
  }

  return {
    balance,
    contributed,
    interestEarned: balance - opening - contributed,
    months: horizon,
    monthsPaid,
  }
}

/* ────────────────────────────────────────────────────────────────
 * 8. 主计算
 * ──────────────────────────────────────────────────────────────── */

/** 一天有多少毫秒。 */
const DAY_MS = 86_400_000

/**
 * 退休生效日。
 *
 * 政策上「达到法定退休年龄」是生日当天，退休手续在生日当月办理、次月起发放。
 * 这里取「退休年月的出生日」作为达到退休条件的时点，用它算倒计时最贴近直觉。
 * @param {{year: number, month: number}} retireYearMonth 退休年月。
 * @param {number} day 出生日。
 * @returns {Date} 退休日（本地时区）。
 */
export function retirementDate(retireYearMonth, day = 1) {
  return new Date(retireYearMonth.year, retireYearMonth.month - 1, day)
}

/**
 * 完整测算。
 *
 * @param {Partial<typeof DEFAULT_INPUT>} rawInput 外部输入。
 * @param {Date} [now] 计算基准时刻，默认取当前时间（测试时注入固定值）。
 * @returns {object} 测算结果，含关键结论与逐步计算过程。
 */
export function compute(rawInput = {}, now = new Date()) {
  const input = normalizeInput(rawInput)
  const birth = { year: input.birthYear, month: input.birthMonth }
  const asOfYearMonth = { year: now.getFullYear(), month: now.getMonth() + 1 }

  // —— 退休时点 ——
  const legal = legalRetirement(birth, input.category)
  const actual = applyFlexible(birth, input.category, {
    earlyMonths: input.earlyMonths,
    delayMonths: input.delayMonths,
  })
  // 输入粒度到月，倒计时统一按退休月的 1 日计，口径在文档里写明。
  const retireAt = retirementDate(actual.yearMonth)
  const daysUntilRetire = Math.ceil((retireAt.getTime() - now.getTime()) / DAY_MS)

  // —— 缴费年限 ——
  // 未来真正能缴的月数：说「打算再缴 30 年」但 27 年后就到退休年龄了，只能算 27 年。
  // 此前直接拿计划月数当缴费年限，会凭空多出几年，缴费年限和养老金一起虚高。
  const future = futureAverageIndex(input, actual.yearMonth, asOfYearMonth)

  const totalPaidMonths = input.paidMonths + future.months + input.deemedMonths
  const requiredMonths = minimumContributionMonths(actual.yearMonth)
  const meetsMinimum = totalPaidMonths >= requiredMonths

  // 综合平均缴费指数：三段各自按实际月数加权。
  //
  // 未来那一段在金额模式下是逐月算出来后求平均的，所以「基数固定不动、社平逐年上涨」
  // 导致的指数下滑会被如实反映 —— 这是单一固定指数表达不出来的。
  const weightedMonths = totalPaidMonths
  const weightedSum = input.paidMonths * input.paidIndex
    + future.months * future.average
    + input.deemedMonths * input.deemedIndex
  const averageIndex = weightedMonths > 0 ? weightedSum / weightedMonths : 0

  // —— 计发基数 ——
  //
  // 用**退休当年**公布的计发基数。各省的计发基本就是按「上年度全口径社平」制定的，
  // 所以「退休时用上年度社平」与「用退休当年的计发基数」是同一件事的两种说法：
  // 2041 年 3 月退休 → 用 2041 年的计发基数。
  //
  // 此前用的是 retirementYear - 1，等于少算一年增长。实操上当年基数多在年中公布，
  // 之前先按上一年预发、公布后重算补发 —— 这里算的是最终核定值。
  const baseAtRetirement = baseAmountAt(input, actual.yearMonth.year)

  // —— 个人账户 ——
  const account = projectAccount(input, actual.yearMonth, asOfYearMonth)
  const divisor = annuityMonths(actual.age.years)

  // —— 三项养老金 ——
  // 基础养老金 = 计发基数 × (1 + 平均缴费指数) ÷ 2 × 缴费年限 × 1%
  // 广东等地对平均指数低于 0.6 的情形额外折减：a = 指数 ÷ 0.6。
  const floorFactor = input.indexFloorFactor && averageIndex < 0.6 ? averageIndex / 0.6 : 1
  const effectiveBase = baseAtRetirement * floorFactor
  const totalYears = totalPaidMonths / 12
  const basicPension = (effectiveBase + effectiveBase * averageIndex) / 2 * totalYears * 0.01

  const accountPension = account.balance / divisor

  // 过渡性养老金 = 计发基数 × 视同缴费指数 × 系数 × 视同缴费年限
  const deemedYears = input.deemedMonths / 12
  const transitionalPension = input.deemedMonths > 0
    ? baseAtRetirement * input.deemedIndex * input.transitionRate * deemedYears
    : 0

  const monthlyPension = basicPension + accountPension + transitionalPension
  const replacementRate = baseAtRetirement > 0 ? monthlyPension / baseAtRetirement : 0

  // 退休时当地社平口径的月工资，用指数还原，作为「退休前工资」的估算。
  const preRetirementWage = baseAtRetirement * Math.max(averageIndex, 0.1)
  const wageReplacement = preRetirementWage > 0 ? monthlyPension / preRetirementWage : 0

  return {
    input,
    engineVersion: ENGINE_VERSION,
    computedAt: now.toISOString(),
    asOfText: formatYearMonth(asOfYearMonth),

    // 退休时点
    legal,
    actual,
    retirementYearMonth: actual.yearMonth,
    retirementDate: retireAt,
    daysUntilRetire,
    yearsUntilRetire: daysUntilRetire / 365.2425,
    retirementAgeText: formatAge(actual.age),
    legalRetirementText: `${formatYearMonth(legal.yearMonth)}（${formatAge(legal.age)}）`,
    delayMonths: legal.delayMonths,

    // 缴费
    totalPaidMonths,
    totalPaidYears: totalYears,
    requiredMonths,
    meetsMinimum,

    // 缴费基数模式：让调用方知道指数是怎么来的
    indexMode: input.monthlyBase > 0 ? 'amount' : 'index',
    currentMonthlyBase: input.monthlyBase,
    effectiveCurrentIndex: contributionIndexFor(input, asOfYearMonth.year, asOfYearMonth),
    futureAverageIndex: future.average,
    futurePaidMonths: future.months,

    // 待遇
    averageIndex,
    annuityMonths: divisor,
    baseAtRetirement,
    projectedAccountBalance: account.balance,
    basicPension,
    accountPension,
    transitionalPension,
    monthlyPension,
    annualPension: monthlyPension * 12,
    replacementRate,
    preRetirementWage,
    wageReplacement,
    accountProjection: account,
  }
}

/* ────────────────────────────────────────────────────────────────
 * 9. 输出格式化
 * ──────────────────────────────────────────────────────────────── */

/**
 * 把金额格式化成带千分位的人民币。
 * @param {number} value 金额。
 * @returns {string} 例如 `4,864.36`。
 */
export function formatMoney(value) {
  if (!Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 把比例格式化成百分比。 */
export function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

/** 把天数格式化成带千分位的整数。 */
export function formatDays(days) {
  if (!Number.isFinite(days)) return '—'
  return Math.max(0, days).toLocaleString('zh-CN')
}

/**
 * 生成一段纯文本测算报告。
 *
 * DSH 工具结果、skill 回复、网页「复制结果」共用一个渲染器，保证三处口径一致。
 * @param {ReturnType<typeof compute>} result 测算结果。
 * @returns {string} 多行文本。
 */
export function formatReport(result) {
  const { input, actual, legal } = result
  const lines = []
  lines.push(`【退休测算】${input.birthYear}年${input.birthMonth}月生 · ${CATEGORIES[input.category].label}`)
  lines.push('')
  lines.push(`距退休：${formatDays(result.daysUntilRetire)} 天（约 ${result.yearsUntilRetire.toFixed(1)} 年）`)
  lines.push(`退休时间：${formatYearMonth(actual.yearMonth)}，${result.retirementAgeText}`)
  lines.push(`法定退休：${result.legalRetirementText}${legal.delayMonths > 0 ? `（延迟 ${legal.delayMonths} 个月）` : ''}`)
  if (actual.mode !== 'legal') {
    lines.push(`弹性选择：${actual.mode === 'early' ? '提前' : '延后'} ${Math.abs(actual.appliedMonths)} 个月${actual.reason ? ` · ${actual.reason}` : ''}`)
  }
  lines.push('')
  lines.push(`预计月养老金：￥${formatMoney(result.monthlyPension)}`)
  lines.push(`  · 基础养老金　　￥${formatMoney(result.basicPension)}`)
  lines.push(`  · 个人账户养老金 ￥${formatMoney(result.accountPension)}`)
  if (result.transitionalPension > 0) {
    lines.push(`  · 过渡性养老金　￥${formatMoney(result.transitionalPension)}`)
  }
  lines.push('')
  lines.push(`缴费年限：${formatMonths(result.totalPaidMonths)}（最低要求 ${formatMonths(result.requiredMonths)}，${result.meetsMinimum ? '已满足' : '未满足'}）`)
  if (result.indexMode === 'amount') {
    lines.push(`缴费基数：${formatMoney(result.currentMonthlyBase)} 元/月（按金额推算，当前指数 ${result.effectiveCurrentIndex.toFixed(4)}）`)
    lines.push(`平均缴费指数：${result.averageIndex.toFixed(4)}（未来 ${formatMonths(result.futurePaidMonths)} 的均值 ${result.futureAverageIndex.toFixed(4)}）`)
  } else {
    lines.push(`平均缴费指数：${result.averageIndex.toFixed(4)}（已缴 ${input.paidIndex.toFixed(2)} / 未来 ${input.futureIndex.toFixed(2)}）`)
  }
  lines.push(`计发基数（${actual.yearMonth.year - 1} 年）：￥${formatMoney(result.baseAtRetirement)}/月`)
  lines.push(`个人账户退休时余额：￥${formatMoney(result.projectedAccountBalance)}（计发月数 ${result.annuityMonths}）`)
  lines.push(`养老金替代率：${formatPercent(result.replacementRate)}（对计发基数）`)
  return lines.join('\n')
}
