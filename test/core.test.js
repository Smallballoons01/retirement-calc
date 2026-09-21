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
