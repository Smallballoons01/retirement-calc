/**
 * @dsh-plugin/retirement-calc — 宿主端。
 *
 * 把 `core.js` 的退休测算能力接进 DeepSeek Harness，一个包提供四个面：
 *
 * 1. **工具** —— `retirement_plan` 出结论，`retirement_profile` 管档案，
 *    `retirement_compare` 做情景对比。模型可以直接回答"我什么时候退休、能领多少"。
 * 2. **侧边栏面板** —— 浏览器端从这里注册，实时显示倒计时与预计养老金，
 *    并允许就地改参数。面板与工具读写的是同一份档案。
 * 3. **系统提示段** —— 让模型知道有这套工具，以及什么情况下该主动用它。
 * 4. **内嵌技能** —— `retirement-planner`，把口径、边界和话术教给模型。
 *
 * 档案（个人参保信息）落在 `$DSH_HOME/retirement-calc.json`；经济假设（增长率、
 * 记账利率、过渡系数）走设置页，因为它们属于"用户对未来的判断"，不是每个人
 * 与生俱来的属性，也更常被调整。
 *
 * @module @dsh-plugin/retirement-calc
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  CATEGORIES,
  PROVINCES,
  compute,
  defaultBaseFor,
  defaultBaseYearFor,
  formatAge,
  formatMonths,
  formatMoney,
  formatPercent,
  formatReport,
  formatYearMonth,
  normalizeInput,
} from './core.js'
import { SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE, skillBody } from './skill.js'

export const name = 'retirement-calc'
export const inject = ['tools']

/** 设置命名空间：设置页卡片与宿主端配置的接头。 */
export const SETTINGS_NS = 'retirement-calc'

/** 面板与宿主端通信的 HTTP 前缀。 */
const API_PREFIX = '/retire/api'

/** 请求体上限。个人档案只有几十个字段，32KB 绰绰有余。 */
const MAX_BODY_BYTES = 32 * 1024

/**
 * 档案字段全集。
 *
 * 前一半是个人参保信息，后一半是经济假设。两者放在同一份档案里，是因为它们
 * 同属「用户对自己未来的判断」：都要持久化、都会被反复调整、也应该在同一个
 * 面上编辑。把它拆到设置页反而会让「改一个数看结果」这件事变得别扭。
 */
const PROFILE_FIELDS = [
  'birthYear', 'birthMonth', 'category', 'province', 'insuredType',
  'paidMonths', 'paidIndex', 'futureMonths', 'futureIndex', 'accountBalance',
  'deemedMonths', 'deemedIndex', 'earlyMonths', 'delayMonths',
  // 缴费基数的金额模式。三个字段一起出现：`monthlyBase > 0` 即启用，
  // 那种情况下 futureIndex 不再参与计算。
  'monthlyBase', 'futureMonthlyBase', 'baseFollowsAverage',
  'baseAmount', 'baseYear', 'baseGrowthRate', 'accountInterestRate', 'transitionRate',
]

/** 默认档案：一个刚工作不久的参保人，用来给面板和工具一个起点。 */
const DEFAULT_PROFILE = Object.freeze({
  birthYear: 1990,
  birthMonth: 1,
  category: 'male',
  province: 'guangdong',
  insuredType: 'employee',
  paidMonths: 8 * 12,
  paidIndex: 0.6,
  futureMonths: 30 * 12,
  futureIndex: 0.6,
  accountBalance: 60_000,
  deemedMonths: 0,
  deemedIndex: 0.6,
  earlyMonths: 0,
  delayMonths: 0,
  monthlyBase: 0,
  futureMonthlyBase: 0,
  baseFollowsAverage: true,
  baseAmount: 0,
  baseYear: 0,
  baseGrowthRate: 0.02,
  accountInterestRate: 0.015,
  transitionRate: 0.013,
})

/** 档案文件的默认位置，与其他 per-user 数据放在一起。 */
function defaultStatePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'retirement-calc.json')
}

/**
 * 插件配置。
 *
 * 只放「插件怎么运转」的开关；测算用的参数（含经济假设）全在档案里，
 * 由工具与面板共同读写，这样面板才能一次改完、立刻看到结果。
 */
export const Config = z.object({
  /** 档案文件位置，默认 `$DSH_HOME/retirement-calc.json`。 */
  stateFile: z.string(),
  /** 是否注入系统提示段。 */
  promptSection: z.boolean().default(true),
  /** 是否注册内嵌的 retirement-planner 技能。 */
  skill: z.boolean().default(true),
})

const PROMPT_SECTION = `Retirement planning (retirement-calc plugin):
- \`retirement_plan\` computes the statutory retirement date under China's 2025 phased-delay reform, the countdown in days, and the projected monthly pension (base + individual account + transitional).
- \`retirement_profile\` reads or updates the user's stored particulars (birth month, category, province, months contributed, contribution index, account balance).
- \`retirement_compare\` quantifies the effect of changing one thing — contributing more years, a higher index, delaying retirement.
- Call \`retirement_plan\` before answering any question about when the user may retire or how much they will receive. Never estimate these numbers from memory: the reform's delay schedule and the 2030-onward minimum-contribution ramp are exact rules, and guessing gets them wrong.
- State the assumptions you used (projected base amount growth, account interest rate) whenever you report a pension figure — they are assumptions, not guarantees.`

/* ── 档案与配置的组装 ─────────────────────────────────────── */

/**
 * 工具参数名（snake_case）到档案字段名（camelCase）的映射。
 *
 * 三个工具、HTTP 请求体、档案文件四处都用同一张表，所以它是模块级的常量：
 * 各自维护一份的结局一定是某天加了字段却漏改其中一处。
 */
const ARG_FIELD_MAP = {
  birth_year: 'birthYear',
  birth_month: 'birthMonth',
  category: 'category',
  province: 'province',
  insured_type: 'insuredType',
  paid_months: 'paidMonths',
  paid_index: 'paidIndex',
  future_months: 'futureMonths',
  future_index: 'futureIndex',
  account_balance: 'accountBalance',
  deemed_months: 'deemedMonths',
  deemed_index: 'deemedIndex',
  early_months: 'earlyMonths',
  delay_months: 'delayMonths',
  monthly_base: 'monthlyBase',
  future_monthly_base: 'futureMonthlyBase',
  base_follows_average: 'baseFollowsAverage',
  base_amount: 'baseAmount',
  base_year: 'baseYear',
  base_growth_rate: 'baseGrowthRate',
  account_interest_rate: 'accountInterestRate',
  transition_rate: 'transitionRate',
}

/**
 * 把外部对象的键翻译成档案字段，并丢掉不认识的部分。
 *
 * 同时接受 snake_case 与 camelCase，方便模型用任一种写法调用。空串、null、
 * undefined 视为「没提供」，不会覆盖已有值。
 * @param {object} source 外部对象。
 * @returns {object} 只含档案字段的新对象。
 */
function translateFields(source) {
  const out = {}
  if (source === null || typeof source !== 'object') return out
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null || value === '') continue
    // 用 hasOwn 而不是 `map[key]`：`__proto__` 这类键在普通对象上会命中原型链，
    // 让查找返回 Object.prototype 而不是 undefined，从而把垃圾带进结果。
    const field = Object.hasOwn(ARG_FIELD_MAP, key)
      ? ARG_FIELD_MAP[key]
      : (PROFILE_FIELDS.includes(key) ? key : undefined)
    if (field !== undefined) out[field] = value
  }
  return out
}

/**
 * 把一份外部输入补齐成合法档案。
 * @param {object} source 外部对象。
 * @returns {typeof DEFAULT_PROFILE} 完整档案。
 */
function normalizeProfile(source) {
  const raw = translateFields(source)
  const input = normalizeInput({ ...DEFAULT_PROFILE, ...raw })
  const profile = {}
  for (const field of PROFILE_FIELDS) profile[field] = input[field]
  // `normalizeInput` 会把「没指定计发基数」解析成省份默认值，但档案要保留
  // 「没指定」这个事实本身：否则用户以后换省份，会带着上一个省的数字过去，
  // 而那个数字在新省份既不对、又看不出来源。
  profile.baseAmount = Number(raw.baseAmount) > 0 ? Number(raw.baseAmount) : 0
  profile.baseYear = Number(raw.baseYear) > 0 ? Number(raw.baseYear) : 0
  return profile
}

/** 一次测算把结果压成工具能安全返回的扁平结构。 */
function toToolPayload(result, notes) {
  return {
    retirement_date: formatYearMonth(result.retirementYearMonth),
    retirement_age: formatAge(result.actual.age),
    days_until_retirement: Math.max(0, result.daysUntilRetire),
    monthly_pension: round2(result.monthlyPension),
    annual_pension: round2(result.annualPension),
    basic_pension: round2(result.basicPension),
    account_pension: round2(result.accountPension),
    transitional_pension: round2(result.transitionalPension),
    total_paid_months: result.totalPaidMonths,
    required_months: result.requiredMonths,
    meets_minimum: result.meetsMinimum,
    // 说「打算再缴 30 年」但 27 年后就到退休年龄时，只有 27 年算数。
    // 单独暴露出来，免得调用方以为计划月数就是实际月数。
    future_paid_months: result.futurePaidMonths,
    average_index: Number(result.averageIndex.toFixed(4)),
    index_mode: result.indexMode,
    annuity_months: result.annuityMonths,
    projected_account_balance: round2(result.projectedAccountBalance),
    base_at_retirement: round2(result.baseAtRetirement),
    replacement_rate: Number(result.replacementRate.toFixed(4)),
    legal_delay_months: result.legal.delayMonths,
    report: formatReport(result),
    notes,
  }
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/* ── 插件主体 ─────────────────────────────────────────────── */

/**
 * 注册插件。
 * @param {object} ctx 宿主上下文。
 * @param {object} config 组合层传入的配置。
 */
export function apply(ctx, config) {
  let current = config
  let source = () => current

  const runtime = {
    /** 持久化的个人档案。 */
    profile: { ...DEFAULT_PROFILE },
    /** 串行化写入，避免两次保存交错。 */
    writes: Promise.resolve(),
    /** 组合卸载后置位，启动流程据此放弃后续动作。 */
    disposed: false,
  }

  const statePath = () => current.stateFile ?? defaultStatePath()

  /** 原子写入档案文件。 */
  function save() {
    const payload = `${JSON.stringify({ version: 1, profile: runtime.profile }, null, 2)}\n`
    const target = statePath()
    runtime.writes = runtime.writes
      .then(async () => {
        await mkdir(dirname(target), { recursive: true })
        const temporary = `${target}.tmp`
        await writeFile(temporary, payload, 'utf8')
        await rename(temporary, target)
      })
      .catch(error => ctx.logger.warn(`retirement-calc: 档案未保存：${String(error)}`))
    return runtime.writes
  }

  /**
   * 启动时读一次档案。
   *
   * 文件缺失或损坏都退回默认档案，并把这份 promise 交给工具与销毁屏障 await，
   * 这样卸载时不会有人在读盘读到一半。
   */
  const ready = (async () => {
    try {
      const parsed = JSON.parse(await readFile(statePath(), 'utf8'))
      runtime.profile = normalizeProfile(parsed?.profile ?? parsed)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        ctx.logger.warn(`retirement-calc: 档案未恢复：${String(error)}`)
      }
      runtime.profile = { ...DEFAULT_PROFILE }
    }
  })()

  /**
   * 用「档案 + 假设 + 本次覆盖」算一次。
   * @param {object} overrides 本次调用的临时覆盖。
   * @returns {{result: object, payload: object}} 完整结果与工具用载荷。
   */
  function evaluate(overrides = {}) {
    const input = { ...runtime.profile, ...overrides }
    const result = compute(input, new Date())
    return { result, payload: toToolPayload(result, capabilityNotes(result)) }
  }

  /** 把口径边界写成一句话，附在每个结果后面。 */
  function capabilityNotes(result) {
    const notes = []
    notes.push('法定退休年龄按全国人大常委会 2024-09-13 决定计算；最低缴费年限 2029 年前 15 年、之后每年提高 6 个月至 20 年。')
    notes.push(`计发基数按每年 ${formatPercent(runtime.profile.baseGrowthRate, 1)} 增长推算至退休上一年度，属假设值。`)
    const province = PROVINCES.find(item => item.code === result.input.province)
    if (province?.status === 'manual') {
      notes.push(`${province.name}的计发基数未收录，当前用了 ${formatMoney(result.input.baseAmount)} 元的兜底值，请替换为当地实际公布值。`)
    } else if (province?.status === 'reference') {
      notes.push(`${province.name}用的是 ${province.year} 年的计发基数（新一年度尚未公布），请留意更新。`)
    }
    if (!result.meetsMinimum) {
      notes.push(`累计缴费 ${formatMonths(result.totalPaidMonths)}，低于该退休年份要求的 ${formatMonths(result.requiredMonths)}。`)
    }
    return notes.join(' ')
  }

  // --- 工具 -----------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'retirement_plan',
    description:
      'Compute the user\'s statutory retirement date under China\'s 2025 phased-delay reform, the countdown in days, '
      + 'and the projected monthly pension. Defaults to the stored profile; any argument overrides it for this call only '
      + 'unless save is true. Call this before answering any retirement-date or pension-amount question.',
    parameters: {
      birth_year: { type: 'number', description: '出生年份，例如 1978。' },
      birth_month: { type: 'number', description: '出生月份 1-12。' },
      category: {
        type: 'string',
        enum: ['male', 'female55', 'female50'],
        description: '男职工 / 原 55 岁女职工（管理技术岗）/ 原 50 岁女职工（工人岗）。决定原法定退休年龄。',
      },
      province: { type: 'string', description: `省份代码，例如 ${PROVINCES.slice(0, 4).map(p => p.code).join(' / ')} 等。` },
      paid_months: { type: 'number', description: '累计已缴月数。' },
      paid_index: { type: 'number', description: '已缴部分的平均缴费指数，0.6 表示 60% 档。' },
      future_months: { type: 'number', description: '计划继续缴费的月数。' },
      future_index: { type: 'number', description: '未来缴费的缴费指数。' },
      account_balance: { type: 'number', description: '当前个人账户累计储存额（元）。' },
      deemed_months: { type: 'number', description: '视同缴费年限（月），没有就填 0。' },
      deemed_index: { type: 'number', description: '视同缴费指数。' },
      early_months: { type: 'number', description: '弹性提前退休的月数，最长 36，且不得低于原法定退休年龄。' },
      delay_months: { type: 'number', description: '弹性延后退休的月数，最长 36。与 early_months 互斥。' },
      monthly_base: { type: 'number', description: '当前月缴费基数（元）。填了就切到金额模式：指数由「基数 ÷ 当年社平」现算，个人账户也按真实基数记账。填 0 则回到按指数计算。当用户只说得清「我基数是八千/一万」而说不清档位时用这个。' },
      future_monthly_base: { type: 'number', description: '未来的月缴费基数（元）。0 表示沿用 monthly_base；用户说「以后打算降到多少」时填这里。' },
      base_follows_average: { type: 'boolean', description: '未来的缴费基数是否随社平同步上调。true（默认）= 继续按同一档位缴，缴费指数保持不变；false = 基数固定不动，社平继续涨会把缴费指数逐年拉低。' },
      base_amount: { type: 'number', description: '手动指定养老金计发基数（元/月）。不填则用参保地的默认值。' },
      base_year: { type: 'number', description: '计发基数对应的年份。不填则用省份默认年份。' },
      base_growth_rate: { type: 'number', description: '计发基数年增长率的假设，0.02 表示 2%。' },
      account_interest_rate: { type: 'number', description: '个人账户记账利率的假设，2025 年全国口径为 0.015。' },
      transition_rate: { type: 'number', description: '过渡性养老金系数，各省在 0.01-0.014 之间。' },
      save: { type: 'boolean', description: '是否把本次参数写回档案。默认 false，只做一次试算。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          retirement_date: { type: 'string', required: true },
          retirement_age: { type: 'string', required: true },
          days_until_retirement: { type: 'number', required: true },
          monthly_pension: { type: 'number', required: true },
          annual_pension: { type: 'number', required: true },
          basic_pension: { type: 'number', required: true },
          account_pension: { type: 'number', required: true },
          transitional_pension: { type: 'number', required: true },
          total_paid_months: { type: 'number', required: true },
          required_months: { type: 'number', required: true },
          meets_minimum: { type: 'boolean', required: true },
          future_paid_months: { type: 'number', required: true },
          average_index: { type: 'number', required: true },
          index_mode: { type: 'string', required: true },
          annuity_months: { type: 'number', required: true },
          projected_account_balance: { type: 'number', required: true },
          base_at_retirement: { type: 'number', required: true },
          replacement_rate: { type: 'number', required: true },
          legal_delay_months: { type: 'number', required: true },
          report: { type: 'string', required: true },
          notes: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.report}\n\n口径：${value.notes}` }],
    },
    async execute(args) {
      await ready
      // `save` 不在字段映射表里，所以会被自动忽略，不会混进测算参数。
      const overrides = translateFields(args)

      const { payload } = evaluate(overrides)
      if (args.save === true && Object.keys(overrides).length > 0) {
        runtime.profile = normalizeProfile({ ...runtime.profile, ...overrides })
        await save()
      }
      return payload
    },
    presentCall: () => ({ card: 'generic', title: '测算退休时间与养老金', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'retirement_profile',
    description:
      'Read, update, or clear the stored retirement particulars (birth month, category, province, contributed months, '
      + 'contribution index, account balance, deemed years, flexible-retirement choice). '
      + 'Use get before asking the user to repeat information they have already provided.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['get', 'set', 'clear'],
        description: 'get 读取，set 局部更新，clear 清空回默认。',
      },
      fields: {
        type: 'object',
        // 键名由调用方自由给出，所以显式放开；不认识的键在 execute 里被丢掉。
        additionalProperties: true,
        description: 'action=set 时提供，键名与 retirement_plan 的参数一致（birth_year、category、paid_months 等）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          profile_text: { type: 'string', required: true },
          changed: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.profile_text}\n\n${value.summary}` }],
    },
    async execute(args) {
      await ready

      let changed = ''
      if (args.action === 'clear') {
        runtime.profile = { ...DEFAULT_PROFILE }
        await save()
        changed = '已清空'
      } else if (args.action === 'set') {
        const overrides = translateFields(args.fields ?? {})
        const keys = Object.keys(overrides)
        if (keys.length === 0) {
          changed = '没有识别到可更新的字段'
        } else {
          runtime.profile = normalizeProfile({ ...runtime.profile, ...overrides })
          await save()
          changed = `已更新 ${keys.length} 项`
        }
      } else {
        changed = '未改动'
      }

      const { payload } = evaluate()
      return {
        action: args.action,
        profile_text: describeProfile(runtime.profile),
        changed,
        summary: payload.report.split('\n').slice(0, 4).join('\n'),
      }
    },
    presentCall: args => ({ card: 'generic', title: `退休档案：${args.action}`, kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'retirement_compare',
    description:
      'Quantify what changes the pension: run the stored profile plus several variations and return a side-by-side table. '
      + 'Use it to answer "what if I contribute more years / a higher index / retire later".',
    parameters: {
      scenarios: {
        type: 'object',
        additionalProperties: true,
        description:
          '情景映射：键是情景名称，值是覆盖字段（与 retirement_plan 参数同名），例如 '
          + '{"多缴5年":{"future_months":360},"延后3年":{"delay_months":36}}。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.table}\n\n${value.note}` }],
    },
    async execute(args) {
      await ready
      const baseline = evaluate()
      const lines = [
        `基准：${formatYearMonth(baseline.result.retirementYearMonth)}退休，`
        + `${formatAge(baseline.result.actual.age)}，`
        + `月养老金 ￥${formatMoney(baseline.result.monthlyPension)}`,
        '',
        '情景对比',
      ]

      const scenarios = args.scenarios ?? {}
      const entries = Object.entries(scenarios)
      if (entries.length === 0) {
        lines.push('（未提供情景）')
      }
      for (const [label, fields] of entries) {
        const variant = evaluate(translateFields(fields))
        const diff = variant.result.monthlyPension - baseline.result.monthlyPension
        const pct = baseline.result.monthlyPension > 0
          ? (diff / baseline.result.monthlyPension) * 100
          : 0
        lines.push(
          `· ${label}：${formatYearMonth(variant.result.retirementYearMonth)}退休，`
          + `月养老金 ￥${formatMoney(variant.result.monthlyPension)}`
          + `（${diff >= 0 ? '+' : '−'}￥${formatMoney(Math.abs(diff))}，${diff >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%）`,
        )
      }

      return {
        table: lines.join('\n'),
        note: `所有情景都用了同一套经济假设（计发基数年增长 ${formatPercent(runtime.profile.baseGrowthRate, 1)}、`
          + `个人账户记账利率 ${formatPercent(runtime.profile.accountInterestRate, 2)}），改变的是缴费年限、缴费指数或退休时点。`
          + '差异是长期复利的结果，不代表最终待遇。',
      }
    },
    presentCall: () => ({ card: 'generic', title: '对比退休方案', kind: 'read' }),
  }))

  // --- 可选挂载面 -----------------------------------------------------------

  if (current.promptSection !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: 'retirement-calc',
        order: 158,
        text: PROMPT_SECTION,
      })
    })
  }

  if (current.skill !== false) {
    ctx.inject(['skills'], (skillCtx) => {
      ctx.effect(() => skillCtx.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        source: 'runtime',
        content: skillBody(),
      }), 'retirement-calc: 内嵌 retirement-planner 技能')
    })
  }

  ctx.inject(['webServer'], (webCtx) => {
    ctx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        const route = new URL(req.url ?? '/', 'http://localhost').pathname.slice(`${API_PREFIX}/`.length)
        try {
          if (crossSiteRequest(req)) {
            respond(res, 403, { ok: false, error: { code: 'cross-site', message: 'cross-site request refused' } })
            return
          }
          if (req.method !== 'POST') throw new Error('POST only')
          const body = await readBody(req)
          await ready

          switch (route) {
            case 'status': {
              const { result, payload } = evaluate()
              respond(res, 200, { ok: true, value: statusEnvelope(runtime.profile, result, payload, current) })
              return
            }
            case 'preview': {
              // 面板改参数时的高频路径：只算不存，让用户拖着看效果。
              // 返回的 `profile` 刻意保持「已保存」的那份 —— 面板靠它和草稿比对
              // 来决定「保存」按钮是否可点。把试算值回传过去会让那个按钮永远禁用。
              const patch = translateFields(body?.profile ?? {})
              const { result, payload } = evaluate(patch)
              respond(res, 200, {
                ok: true,
                value: statusEnvelope(runtime.profile, result, payload, current, { ...runtime.profile, ...patch }),
              })
              return
            }
            case 'save': {
              const patch = translateFields(body?.profile ?? {})
              runtime.profile = normalizeProfile({ ...runtime.profile, ...patch })
              await save()
              const { result, payload } = evaluate()
              respond(res, 200, {
                ok: true,
                value: { ...statusEnvelope(runtime.profile, result, payload, current), changed: Object.keys(patch).length },
              })
              return
            }
            case 'reset': {
              runtime.profile = { ...DEFAULT_PROFILE }
              await save()
              const { result, payload } = evaluate()
              respond(res, 200, { ok: true, value: statusEnvelope(runtime.profile, result, payload, current) })
              return
            }
            case 'catalog': {
              respond(res, 200, {
                ok: true,
                value: {
                  provinces: PROVINCES.map(item => ({
                    code: item.code, name: item.name, base: item.base,
                    year: item.year, status: item.status, note: item.note ?? '',
                  })),
                  categories: Object.values(CATEGORIES).map(spec => ({
                    key: spec.key, label: spec.label, shortLabel: spec.shortLabel,
                    originalAge: spec.originalAge, description: spec.description,
                  })),
                },
              })
              return
            }
            default:
              respond(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route '${route}'` } })
          }
        } catch (error) {
          respond(res, 200, { ok: false, error: { code: 'error', message: String(error?.message ?? error) } })
        }
      },
    }), 'retirement-calc: /retire/api 路由')
  })

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NS, Config, config, {
      setSource: (get) => { source = () => get() },
      onChange: () => { current = source() },
    })
  })

  ctx.effect(() => () => {
    runtime.disposed = true
    return ready.catch(() => {}).then(() => runtime.writes)
  }, 'retirement-calc: 档案落盘')
}

/* ── 辅助 ─────────────────────────────────────────────────── */

/**
 * 面板需要的一份完整快照。
 *
 * `profile` 始终是**已保存**的那份，`effectiveProfile` 才是本次算用的是谁。
 * 试算时两者不同：前者让面板能判断「草稿有没有改动过」，后者决定省份默认值
 * 该按哪个省查。混用其中一个都会让面板显示错东西。
 *
 * @param {object} profile 已保存的档案。
 * @param {object} result `compute` 的结果。
 * @param {object} payload 工具用载荷。
 * @param {object} config 当前配置。
 * @param {object} [effectiveProfile] 本次计算实际使用的档案，默认同 `profile`。
 * @returns {object} 面板快照。
 */
function statusEnvelope(profile, result, payload, config, effectiveProfile = profile) {
  return {
    profile: { ...profile },
    result: {
      retirementDate: formatYearMonth(result.retirementYearMonth),
      retirementAge: formatAge(result.actual.age),
      daysUntilRetirement: Math.max(0, result.daysUntilRetire),
      monthlyPension: round2(result.monthlyPension),
      annualPension: round2(result.annualPension),
      basicPension: round2(result.basicPension),
      accountPension: round2(result.accountPension),
      transitionalPension: round2(result.transitionalPension),
      totalPaidMonths: result.totalPaidMonths,
      requiredMonths: result.requiredMonths,
      meetsMinimum: result.meetsMinimum,
      averageIndex: Number(result.averageIndex.toFixed(4)),
      annuityMonths: result.annuityMonths,
      projectedAccountBalance: round2(result.projectedAccountBalance),
      baseAtRetirement: round2(result.baseAtRetirement),
      baseYear: result.retirementYearMonth.year - 1,
      replacementRate: Number(result.replacementRate.toFixed(4)),
      legalDelayMonths: result.legal.delayMonths,
      legalRetirementDate: formatYearMonth(result.legal.yearMonth),
      legalRetirementAge: formatAge(result.legal.age),
      flexMode: result.actual.mode,
      flexMonths: Math.abs(result.actual.appliedMonths),
      flexReason: result.actual.reason,
      computedAt: result.computedAt,
    },
    assumptions: {
      baseGrowthRate: profile.baseGrowthRate,
      accountInterestRate: profile.accountInterestRate,
      transitionRate: profile.transitionRate,
      baseAmount: profile.baseAmount,
      baseYear: profile.baseYear,
    },
    report: payload.report,
    notes: payload.notes,
    provinceDefault: {
      amount: defaultBaseFor(effectiveProfile.province),
      year: defaultBaseYearFor(effectiveProfile.province),
    },
  }
}

/** 把档案渲染成一段人话。 */
function describeProfile(profile) {
  const spec = CATEGORIES[profile.category] ?? CATEGORIES.male
  const province = PROVINCES.find(item => item.code === profile.province)
  return [
    `出生：${profile.birthYear} 年 ${profile.birthMonth} 月`,
    `人群：${spec.label}（原法定 ${spec.originalAge} 周岁）`,
    `参保地：${province?.name ?? profile.province}`,
    `已缴：${formatMonths(profile.paidMonths)}，平均指数 ${profile.paidIndex.toFixed(2)}`,
    profile.monthlyBase > 0
      ? `计划续缴：${formatMonths(profile.futureMonths)}，按月缴费基数 ${formatMoney(profile.monthlyBase)} 元`
        + `（未来 ${profile.futureMonthlyBase > 0 ? `${formatMoney(profile.futureMonthlyBase)} 元` : '沿用'}，`
        + `${profile.baseFollowsAverage ? '随社平同步上调' : '固定不变'}）`
      : `计划续缴：${formatMonths(profile.futureMonths)}，指数 ${profile.futureIndex.toFixed(2)}`,
    `个人账户余额：￥${formatMoney(profile.accountBalance)}`,
    profile.deemedMonths > 0 ? `视同缴费：${formatMonths(profile.deemedMonths)}` : '无视同缴费年限',
    profile.earlyMonths > 0 ? `弹性提前：${profile.earlyMonths} 个月` : '',
    profile.delayMonths > 0 ? `弹性延后：${profile.delayMonths} 个月` : '',
  ].filter(Boolean).join('\n')
}

/** 读取并限制大小的 JSON 请求体。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

/** 以统一信封回复面板。 */
function respond(res, status, envelope) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/**
 * 判断请求是否来自其他站点。
 *
 * 这些路由不在 harness 自己的浏览器信任围栏内，而改动档案用的是简单的
 * 跨域 POST（`text/plain` 请求体也照样能过 handler），所以必须自己挡一下：
 * 要求同源 Origin，或者干脆不带 Origin（CLI 客户端就是这种）。
 * @param {object} req 请求对象。
 * @returns {boolean} 是否应作为跨站请求拒绝。
 */
function crossSiteRequest(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return false
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return true
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}
