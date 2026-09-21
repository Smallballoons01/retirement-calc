/**
 * 核心引擎测试。
 *
 * 分三组：
 * 1. 政策对照表 —— 延迟退休、最低缴费年限、计发月数，逐条对齐官方口径。
 * 2. 养老金公式 —— 用江西新余市人社局公开的两道例题（《退休时的养老金，你会算吗？》）
 *    做端到端校验，题目给了答案，误差必须落在分位以内。
 * 3. 边界与兜底 —— 弹性退休上下限、指数折减、空输入。
 *
 * 时间一律注入固定值，不依赖运行时的当前时间。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  annuityMonths,
  applyFlexible,
  baseAmountAt,
  compute,
  findProvince,
  formatMonths,
  legalRetirement,
  minimumContributionMonths,
  normalizeInput,
} from '../core.js'

/** 构造一个「基准时刻」，让账户推演区间为 0，专注验证公式本身。 */
function at(year, month) {
  return new Date(year, month - 1, 1, 12, 0, 0)
}

test('延迟退休：男职工从 2025 年起每 4 个月延迟 1 个月', () => {
  // 原本 2025 年 1 月退休 → 延迟 1 个月
  const jan2025 = legalRetirement({ year: 1965, month: 1 }, 'male')
  assert.equal(jan2025.originalYearMonth.year, 2025)
  assert.equal(jan2025.delayMonths, 1)
  assert.deepEqual(jan2025.yearMonth, { year: 2025, month: 2 })
  assert.equal(jan2025.age.years, 60)
  assert.equal(jan2025.age.months, 1)

  // 原本 2025 年 5 月退休 → 延迟 2 个月
  const may2025 = legalRetirement({ year: 1965, month: 5 }, 'male')
  assert.equal(may2025.delayMonths, 2)
  assert.deepEqual(may2025.yearMonth, { year: 2025, month: 7 })

  // 原本 2025 年 9 月退休 → 延迟 3 个月
  const sep2025 = legalRetirement({ year: 1965, month: 9 }, 'male')
  assert.equal(sep2025.delayMonths, 3)
})

test('延迟退休：改革前已到龄的不受影响', () => {
  const before = legalRetirement({ year: 1964, month: 6 }, 'male')
  assert.equal(before.delayMonths, 0)
  assert.deepEqual(before.yearMonth, { year: 2024, month: 6 })
})

test('延迟退休：男职工封顶 63 周岁', () => {
  // 1976 年 9 月生，原本 2036 年 9 月退休，延迟 36 个月到 63 周岁
  const capped = legalRetirement({ year: 1976, month: 9 }, 'male')
  assert.equal(capped.delayMonths, 36)
  assert.deepEqual(capped.yearMonth, { year: 2039, month: 9 })
  assert.equal(capped.age.years, 63)
  assert.equal(capped.atCeiling, true)

  // 再晚出生的人同样停在 63 周岁
  const later = legalRetirement({ year: 1990, month: 1 }, 'male')
  assert.equal(later.delayMonths, 36)
  assert.equal(later.age.years, 63)
})

test('延迟退休：原 55 岁女职工每 4 个月延迟 1 个月，封顶 58 周岁', () => {
  // 1970 年 1 月生，原本 2025 年 1 月退休 → 延迟 1 个月
  const first = legalRetirement({ year: 1970, month: 1 }, 'female55')
  assert.equal(first.delayMonths, 1)
  assert.deepEqual(first.yearMonth, { year: 2025, month: 2 })

  // 1978 年 3 月生，原本 2033 年 3 月退休 → 延迟 25 个月
  const mar1978 = legalRetirement({ year: 1978, month: 3 }, 'female55')
  assert.equal(mar1978.delayMonths, 25)
  assert.deepEqual(mar1978.yearMonth, { year: 2035, month: 4 })
  assert.equal(mar1978.age.years, 57)
  assert.equal(mar1978.age.months, 1)

  const capped = legalRetirement({ year: 1982, month: 1 }, 'female55')
  assert.equal(capped.delayMonths, 36)
  assert.equal(capped.age.years, 58)
})

test('延迟退休：原 50 岁女职工每 2 个月延迟 1 个月，封顶 55 周岁', () => {
  // 1975 年 1-2 月生，原本 2025 年 1-2 月退休 → 各延迟 1 个月
  const jan = legalRetirement({ year: 1975, month: 1 }, 'female50')
  assert.equal(jan.delayMonths, 1)
  assert.deepEqual(jan.yearMonth, { year: 2025, month: 2 })

  // 1975 年 3-4 月生 → 各延迟 2 个月
  const mar = legalRetirement({ year: 1975, month: 3 }, 'female50')
  assert.equal(mar.delayMonths, 2)
  assert.deepEqual(mar.yearMonth, { year: 2025, month: 5 })

  // 1978 年 3 月生，原本 2028 年 3 月退休 → 延迟 20 个月
  const mar1978 = legalRetirement({ year: 1978, month: 3 }, 'female50')
  assert.equal(mar1978.delayMonths, 20)
  assert.deepEqual(mar1978.yearMonth, { year: 2029, month: 11 })
  assert.equal(mar1978.age.years, 51)
  assert.equal(mar1978.age.months, 8)

  // 封顶 55 周岁
  const capped = legalRetirement({ year: 1984, month: 11 }, 'female50')
  assert.equal(capped.delayMonths, 60)
  assert.equal(capped.age.years, 55)
})

test('最低缴费年限：2030 年起每年提高 6 个月，2039 年封顶 20 年', () => {
  assert.equal(minimumContributionMonths({ year: 2029, month: 12 }), 180)
  assert.equal(minimumContributionMonths({ year: 2030, month: 1 }), 186)
  assert.equal(minimumContributionMonths({ year: 2031, month: 6 }), 192)
  assert.equal(minimumContributionMonths({ year: 2038, month: 3 }), 234) // 19 年 6 个月
  assert.equal(minimumContributionMonths({ year: 2039, month: 1 }), 240)
  assert.equal(minimumContributionMonths({ year: 2041, month: 3 }), 240)
  assert.equal(formatMonths(234), '19年6个月')
  assert.equal(formatMonths(240), '20年')
})

test('计发月数：按满周岁取值', () => {
  assert.equal(annuityMonths(50), 195)
  assert.equal(annuityMonths(55), 170)
  assert.equal(annuityMonths(60), 139)
  assert.equal(annuityMonths(63), 117)
  // 50 周岁 11 个月仍按 50 岁计发
  assert.equal(annuityMonths(50 + 11 / 12), 195)
  // 表外区间就近取端点
  assert.equal(annuityMonths(35), 233)
  assert.equal(annuityMonths(72), 56)
})

test('弹性退休：上界受原法定退休年龄约束', () => {
  const birth = { year: 1978, month: 3 }
  const legal = legalRetirement(birth, 'male') // 2041-03，63 岁

  const early = applyFlexible(birth, 'male', { earlyMonths: 36 })
  assert.equal(early.mode, 'early')
  assert.deepEqual(early.yearMonth, { year: 2038, month: 3 })
  assert.equal(early.age.years, 60)

  const late = applyFlexible(birth, 'male', { delayMonths: 36 })
  assert.equal(late.mode, 'delay')
  assert.deepEqual(late.yearMonth, { year: 2044, month: 3 })
  assert.equal(late.age.years, 66)
})

test('弹性退休：提前超过 3 年会被上收到原法定年龄并给出说明', () => {
  // 女工人：法定 2029-11（51 岁 8 个月），原法定是 50 周岁（2028-03）
  const flex = applyFlexible({ year: 1978, month: 3 }, 'female50', { earlyMonths: 36 })
  assert.deepEqual(flex.yearMonth, { year: 2028, month: 3 })
  assert.equal(flex.age.years, 50)
  assert.equal(flex.clamped, true)
  assert.match(flex.reason, /不得低于原法定退休年龄/)
})

test('养老金公式：复现新余市人社局例题一（刘女士）', () => {
  // 6000 社平、指数 0.6、缴费 15 年、账户 40000、55 岁退休
  // 官方答案：720 + 235.3 = 955.3 元
  const result = compute({
    birthYear: 1967, birthMonth: 12,
    category: 'female55',
    province: 'jiangxi',
    paidMonths: 15 * 12,
    paidIndex: 0.6,
    futureMonths: 0,
    accountBalance: 40_000,
    baseAmount: 6000,
    baseYear: 2022,
    baseGrowthRate: 0,
    accountInterestRate: 0,
    indexFloorFactor: false,
  }, at(2022, 12))

  assert.equal(result.retirementYearMonth.year, 2022)
  assert.equal(result.retirementYearMonth.month, 12)
  assert.equal(result.retirementAgeText, '55岁')
  assert.ok(Math.abs(result.basicPension - 720) < 0.01, `基础养老金 ${result.basicPension}`)
  assert.ok(Math.abs(result.accountPension - 235.29) < 0.01, `个人账户养老金 ${result.accountPension}`)
  assert.ok(Math.abs(result.monthlyPension - 955.29) < 0.02, `合计 ${result.monthlyPension}`)
})

test('养老金公式：复现新余市人社局例题二（王先生，含视同缴费）', () => {
  // 6000 社平、指数 0.8、实际 27 年 + 视同 16 年 = 43 年、账户 90000、60 岁、过渡系数 1.3%
  // 官方答案：2322 + 647.49 + 998.4 = 3967.89 元
  const result = compute({
    birthYear: 1962, birthMonth: 9,
    category: 'male',
    province: 'jiangxi',
    paidMonths: 27 * 12,
    paidIndex: 0.8,
    futureMonths: 0,
    deemedMonths: 16 * 12,
    deemedIndex: 0.8,
    accountBalance: 90_000,
    baseAmount: 6000,
    baseYear: 2022,
    baseGrowthRate: 0,
    accountInterestRate: 0,
    transitionRate: 0.013,
    indexFloorFactor: false,
  }, at(2022, 9))

  assert.equal(result.totalPaidMonths, 43 * 12)
  assert.ok(Math.abs(result.averageIndex - 0.8) < 1e-9)
  assert.ok(Math.abs(result.basicPension - 2322) < 0.01, `基础养老金 ${result.basicPension}`)
  assert.ok(Math.abs(result.accountPension - 647.48) < 0.01, `个人账户养老金 ${result.accountPension}`)
  assert.ok(Math.abs(result.transitionalPension - 998.4) < 0.01, `过渡性养老金 ${result.transitionalPension}`)
  assert.ok(Math.abs(result.monthlyPension - 3967.89) < 0.02, `合计 ${result.monthlyPension}`)
})

test('广东规则：平均缴费指数低于 0.6 时基础养老金折减', () => {
  const common = {
    birthYear: 1978, birthMonth: 3,
    category: 'male',
    paidMonths: 30 * 12,
    paidIndex: 0.4,
    futureMonths: 0,
    accountBalance: 100_000,
    baseAmount: 9493,
    baseYear: 2025,
    baseGrowthRate: 0,
    accountInterestRate: 0,
  }
  const gd = compute({ ...common, province: 'guangdong', indexFloorFactor: true }, at(2041, 3))
  const other = compute({ ...common, province: 'jiangxi', indexFloorFactor: false }, at(2041, 3))
  // a = 0.4 / 0.6 = 0.6667，基础养老金按折减后的基数计
  assert.ok(gd.basicPension < other.basicPension)
  assert.ok(Math.abs(gd.basicPension / other.basicPension - 2 / 3) < 1e-9)

  // 指数不低于 0.6 时不折减
  const above = compute({ ...common, paidIndex: 0.8, province: 'guangdong', indexFloorFactor: true }, at(2041, 3))
  const aboveRef = compute({ ...common, paidIndex: 0.8, province: 'jiangxi', indexFloorFactor: false }, at(2041, 3))
  assert.ok(Math.abs(above.basicPension - aboveRef.basicPension) < 1e-9)
})

test('个人账户：未来缴费按社平 × 指数 × 8% 记入并复利', () => {
  const result = compute({
    birthYear: 1990, birthMonth: 1,
    category: 'male',
    province: 'guangdong',
    paidMonths: 0, paidIndex: 0.6,
    futureMonths: 12, futureIndex: 1,
    accountBalance: 100_000,
    baseAmount: 10_000,
    baseYear: 2026,
    baseGrowthRate: 0,
    accountInterestRate: 0,
  }, at(2026, 1))

  // 12 个月、每月记入 10000 × 1 × 8% = 800，利率为 0
  assert.ok(Math.abs(result.accountProjection.contributed - 9600) < 0.01)
  assert.ok(Math.abs(result.projectedAccountBalance - 109_600) < 0.01)
})

test('距退休天数与基础结论对得上', () => {
  // 1978 年 3 月生的男职工，法定 2041 年 3 月
  const result = compute({
    birthYear: 1978, birthMonth: 3,
    category: 'male',
    province: 'heilongjiang',
    paidMonths: 27 * 12,
    paidIndex: 0.8,
    futureMonths: 3 * 12,
    futureIndex: 0.6,
    accountBalance: 114_000,
    baseAmount: 7570,
    baseYear: 2025,
    baseGrowthRate: 0.03,
    accountInterestRate: 0.02,
  }, at(2026, 9))

  assert.deepEqual(result.retirementYearMonth, { year: 2041, month: 3 })
  assert.equal(result.legal.delayMonths, 36)
  assert.equal(result.retirementAgeText, '63岁')
  assert.equal(result.annuityMonths, 117)
  assert.equal(result.totalPaidMonths, 30 * 12)
  assert.equal(result.requiredMonths, 240)
  assert.equal(result.meetsMinimum, true)
  assert.ok(Math.abs(result.averageIndex - 0.78) < 1e-9, `平均指数 ${result.averageIndex}`)
  // 上限：不超过当地计发基数的 1.2 倍量级，下限：明显高于最低生活线
  assert.ok(result.monthlyPension > 2000 && result.monthlyPension < 12_000, `月养老金 ${result.monthlyPension}`)
  assert.ok(result.daysUntilRetire > 0)
})

/* ── 缴费基数（金额模式） ──────────────────────────────────
 *
 * 现实里很多人说得清自己的缴费基数（「现在一万」），说不清抽象的缴费指数。
 * 而这两者不等价：基数是个确定金额，社平却逐年涨，指数 = 基数 ÷ 当年社平
 * 会因此逐年下滑。用固定指数去近似，会把养老金算高。
 */

/** 金额模式的公共输入。 */
const AMOUNT_BASE = {
  birthYear: 1990, birthMonth: 1, category: 'male', province: 'guangdong',
  paidMonths: 8 * 12, paidIndex: 0.6, deemedMonths: 0,
  futureMonths: 30 * 12, accountBalance: 60_000,
  baseGrowthRate: 0.02, accountInterestRate: 0,
}

test('金额模式：基数随社平同步上涨时，缴费指数恒定', () => {
  const result = compute({ ...AMOUNT_BASE, monthlyBase: 10_000, baseFollowsAverage: true }, at(2026, 1))
  assert.equal(result.indexMode, 'amount')

  // 指数 = 基数 ÷ 当年社平。注意分母是**当年**的社平，不是填进去的 2025 年计发基数：
  // 2026 年缴费用的社平已经是 9493 × 1.02 = 9682.86。
  const social2026 = 9493 * 1.02
  assert.ok(Math.abs(result.effectiveCurrentIndex - 10_000 / social2026) < 1e-9,
    `当前指数应为 ${(10_000 / social2026).toFixed(6)}，实际 ${result.effectiveCurrentIndex.toFixed(6)}`)

  // 基数与社平同比例上涨 → 指数在时间上恒定，这正是「继续按同一档位缴」的含义
  assert.ok(Math.abs(result.futureAverageIndex - result.effectiveCurrentIndex) < 1e-9,
    '基数随社平同步时，未来平均指数应与当前指数相同')
})

test('金额模式：基数固定不动时指数逐年下滑，养老金随之降低', () => {
  const follows = compute({ ...AMOUNT_BASE, monthlyBase: 10_000, baseFollowsAverage: true }, at(2026, 1))
  const frozen = compute({ ...AMOUNT_BASE, monthlyBase: 10_000, baseFollowsAverage: false }, at(2026, 1))

  // 「以后就按一万缴，不跟着社平调」→ 指数被社平上涨摊薄
  assert.ok(frozen.futureAverageIndex < follows.futureAverageIndex,
    `固定基数应拉低平均指数：${frozen.futureAverageIndex.toFixed(4)} 应低于 ${follows.futureAverageIndex.toFixed(4)}`)
  assert.ok(frozen.monthlyPension < follows.monthlyPension,
    '基数不随社平调整，养老金应当更低')
  // 差距必须有实际意义，不是四舍五入的噪声
  const gap = (follows.monthlyPension - frozen.monthlyPension) / follows.monthlyPension
  assert.ok(gap > 0.05, `两种口径的差距只有 ${(gap * 100).toFixed(1)}%，与预期不符`)
})

test('金额模式：缴费基数受 60%–300% 上下限夹取', () => {
  // 3000 元远低于广东社平的 60%，多数省份根本不允许按这个数缴
  const tooLow = compute({ ...AMOUNT_BASE, monthlyBase: 3000, baseFollowsAverage: false }, at(2026, 1))
  assert.equal(tooLow.effectiveCurrentIndex, 0.6, `低于下限的基数应夹到 0.6，实际 ${tooLow.effectiveCurrentIndex}`)

  const tooHigh = compute({ ...AMOUNT_BASE, monthlyBase: 100_000, baseFollowsAverage: false }, at(2026, 1))
  assert.equal(tooHigh.effectiveCurrentIndex, 3, `高于上限的基数应夹到 3.0，实际 ${tooHigh.effectiveCurrentIndex}`)
})

test('金额模式与指数模式在等价输入下结果一致', () => {
  // 「一直按某个档位缴」等价于「基数 = 社平 × 该档位，且随社平同步调整」。
  //
  // 这里刻意取 1.2 而不是 0.6：0.6 正好是基数下限对应的指数，任何略低于它的基数都会
  // 被夹回 0.6，两条路径于是"看起来相等"—— 那是夹取造成的巧合，会把这个测试变成
  // 假阳性（第一版就是这么写的，实际算出来是 0.5883 被夹成了 0.6）。
  const target = 1.2
  const probe = normalizeInput({ ...AMOUNT_BASE })
  const monthlyBase = Math.round(baseAmountAt(probe, 2026) * target)

  const byIndex = compute({ ...AMOUNT_BASE, futureIndex: target }, at(2026, 1))
  const byAmount = compute({ ...AMOUNT_BASE, monthlyBase, baseFollowsAverage: true }, at(2026, 1))

  assert.ok(Math.abs(byAmount.effectiveCurrentIndex - target) < 1e-3,
    `基数 ${monthlyBase} 应对应指数 ${target}，实际 ${byAmount.effectiveCurrentIndex.toFixed(4)}`)
  assert.ok(Math.abs(byIndex.futureAverageIndex - byAmount.futureAverageIndex) < 1e-3)
  assert.ok(Math.abs(byIndex.averageIndex - byAmount.averageIndex) < 1e-3,
    `两种模式的平均指数应一致：${byIndex.averageIndex.toFixed(6)} vs ${byAmount.averageIndex.toFixed(6)}`)
  // 结论层也要对得上，否则前面几项一致也没意义
  assert.ok(Math.abs(byIndex.monthlyPension - byAmount.monthlyPension) < 1,
    `两种模式的养老金应一致：${byIndex.monthlyPension.toFixed(2)} vs ${byAmount.monthlyPension.toFixed(2)}`)
})

test('未来的缴费月数超过到退休的实际月数时，只计实际可缴的部分', () => {
  // 说「打算再缴 50 年」，但 26 年后就到退休年龄了
  const result = compute({ ...AMOUNT_BASE, futureMonths: 600, monthlyBase: 0, futureIndex: 0.6 }, at(2026, 1))
  assert.ok(result.futurePaidMonths < 600, '不应把退休之后的年月也算成缴费')
  assert.equal(result.totalPaidMonths, 8 * 12 + result.futurePaidMonths)
  // 到退休还有 27 年上下；缴费年限不该因此虚高到 50 年
  assert.ok(result.totalPaidYears < 40, `总缴费年限 ${result.totalPaidYears} 年明显偏高`)
})

test('计发基数取退休当年的公布值', () => {
  // 「退休时用上年度社平」与「用退休当年的计发基数」是同一件事的两种说法：
  // 各省的计发基数本就是按上年度全口径社平制定的。
  const result = compute({
    ...AMOUNT_BASE, baseAmount: 9493, baseYear: 2025, baseGrowthRate: 0.02,
  }, at(2026, 1))
  const retireYear = result.retirementYearMonth.year
  const expected = 9493 * 1.02 ** (retireYear - 2025)
  assert.ok(Math.abs(result.baseAtRetirement - expected) < 0.01,
    `计发基数应用 ${retireYear} 年的值（${expected.toFixed(2)}），实际 ${result.baseAtRetirement.toFixed(2)}`)
})

test('normalizeInput 兜底：空输入不抛错且字段补齐', () => {
  const input = normalizeInput({})
  assert.equal(input.category, 'male')
  assert.equal(input.province, 'guangdong')
  assert.ok(input.baseAmount > 0)
  assert.equal(input.baseYear, 2025)

  // 越界值被夹回合法区间
  const clamped = normalizeInput({ paidIndex: 99, birthMonth: 44, paidMonths: -5 })
  assert.equal(clamped.paidIndex, 5)
  assert.equal(clamped.birthMonth, 12)
  assert.equal(clamped.paidMonths, 0)
})

test('省份表：已公布 / 沿用 / 未收录三种状态都能取到', () => {
  assert.equal(findProvince('heilongjiang').base, 7570)
  assert.equal(findProvince('guangdong').status, 'published')
  assert.equal(findProvince('beijing').status, 'reference')
  assert.equal(findProvince('henan').status, 'manual')
  assert.equal(findProvince('nope'), undefined)

  // 未收录的省份回落到通用默认值而不是 0
  const input = normalizeInput({ province: 'henan' })
  assert.ok(input.baseAmount > 0)
})

test('计发基数与年份为 0 时跟随省份，而不是被夹到下限', () => {
  // 这条路径来自持久化档案：「0 = 跟随省份」是常见状态。
  //
  // 曾经的缺陷：0 是合法数字，`num(input.baseYear, fallback, 2000, 2060)` 见 0
  // 不认为是缺失，直接夹到下限 2000 年 —— 计发基数凭空多推二十多年复利，
  // 月养老金虚高约六成，而且完全不报错。网页端因为预填了省份默认值绕过了它，
  // 只有插件（档案里存 0）会踩中，是靠真机验收才暴露出来的。
  const common = {
    birthYear: 1990, birthMonth: 1, category: 'male', province: 'guangdong',
    paidMonths: 96, paidIndex: 0.6, futureMonths: 360, futureIndex: 0.6,
    accountBalance: 60_000, baseGrowthRate: 0.02, accountInterestRate: 0.015,
  }
  const explicit = compute({ ...common, baseAmount: 9493, baseYear: 2025 }, at(2026, 9))
  const zeroed = compute({ ...common, baseAmount: 0, baseYear: 0 }, at(2026, 9))
  const omitted = compute(common, at(2026, 9))

  assert.equal(zeroed.input.baseYear, 2025, '零值年份应回落到省份默认年份')
  assert.equal(zeroed.input.baseAmount, 9493, '零值基数应回落到省份默认基数')
  assert.equal(zeroed.baseAtRetirement, explicit.baseAtRetirement)
  assert.equal(zeroed.monthlyPension, explicit.monthlyPension)
  assert.equal(omitted.monthlyPension, explicit.monthlyPension)
  // 明确一个量级，避免以后有人再把它改回「夹到 2000 年」
  assert.ok(zeroed.baseAtRetirement < 20_000, `计发基数 ${zeroed.baseAtRetirement} 明显偏大，年份可能被夹到了下限`)
})
