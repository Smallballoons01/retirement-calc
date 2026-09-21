/**
 * 宿主端行为测试。
 *
 * 用一个最小假上下文替代 cordis 组合：它记录插件注册了什么，并让每个工具的
 * `execute` 真跑一遍。因为 `defineTool` 会校验参数、运行时还会拿返回值去对
 * `output.schema`，这里同时也断言每个工具的返回值确实符合它自己声明的结构 ——
 * 那是插件最容易悄悄腐烂的地方（尤其是 `additionalProperties: false` 配
 * 全字段 required 时，返回一个 null 就会校验失败）。
 *
 * 拆除阶段走的是与 harness 相同的 `ctx.effect` disposer，它会等落盘写完；
 * 在写入还在飞的时候删临时目录，正是让这个测试变成偶发失败的原因。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SKILL_NAME } from '../skill.js'

/** Harness 包是宿主提供的 peer dependency，新克隆的仓库要能软失败。 */
const SKIP_REASON = '需要 DeepSeek Harness 包（@deepseek-ai/dsh-tools、schemastery）；见 README 的前置条件'
const pluginModule = await import('../index.js').catch(() => undefined)

/** 递归断言一个值符合插件声明的那套内联 schema。 */
function assertMatchesSchema(schema, value, path = 'value') {
  if (schema.type === 'object') {
    assert.equal(typeof value, 'object', `${path} 应为对象`)
    assert.notEqual(value, null, `${path} 不应为 null`)
    const properties = schema.properties ?? {}
    for (const [key, child] of Object.entries(properties)) {
      if (child.required === true) {
        assert.ok(key in value, `${path}.${key} 声明为必填，但结果里没有`)
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) assertMatchesSchema(child, value[key], `${path}.${key}`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(key in properties, `${path}.${key} 出现在结果里，却未在 output.schema 中声明`)
      }
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path} 应为数组`)
    for (const [index, item] of value.entries()) assertMatchesSchema(schema.items ?? {}, item, `${path}[${index}]`)
    return
  }
  // 运行时最忌讳的是 null：schema 里没有 null 这一型，但 `typeof null === 'object'`
  // 会让对象之外的所有分支都悄悄放它过去。
  assert.notEqual(value, null, `${path} 不应为 null`)
  assert.notEqual(value, undefined, `${path} 不应为 undefined`)
  if (schema.type === 'number') assert.equal(typeof value, 'number', `${path} 应为数字`)
  else if (schema.type === 'string') assert.equal(typeof value, 'string', `${path} 应为字符串`)
  else if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${path} 应为布尔值`)
}

/** 一个记录注册内容、并对所有能力都给得出东西的假宿主上下文。 */
function harness(options = {}) {
  const captured = { tools: [], sections: [], skills: [], routes: [], disposers: [], settings: undefined }
  const services = {
    settings: { installSection: (...args) => { captured.settings = args; return () => {} } },
    systemPrompt: { section: value => { captured.sections.push(value); return () => {} } },
    skills: { register: value => { captured.skills.push(value); return () => {} } },
    webServer: { register: value => { captured.routes.push(value); return () => {} } },
  }
  const ctx = {
    tools: { register: tool => captured.tools.push(tool) },
    on: () => () => {},
    get: key => options.services?.[key],
    effect: callback => {
      const dispose = callback()
      if (typeof dispose === 'function') captured.disposers.push(dispose)
      return dispose ?? (() => {})
    },
    logger: { warn: () => {}, info: () => {} },
    inject: (dependencies, callback) => {
      const available = {}
      for (const dependency of dependencies) {
        if (services[dependency] !== undefined) available[dependency] = services[dependency]
      }
      // 与 cordis 保持一致：依赖齐了才调用回调。
      if (Object.keys(available).length === dependencies.length) callback(available)
    },
    ...options.ctx,
  }
  return { ctx, captured }
}

/** 满足前缀路由 body 读取器的请求桩。 */
function request(method, url, body, headers = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
}

/** 捕获状态码与 JSON 正文的响应桩。 */
function response() {
  const captured = { status: undefined, body: undefined }
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(text) { captured.body = JSON.parse(text) },
  }
}

if (pluginModule === undefined) {
  test('retirement-calc 插件测试', t => t.skip(SKIP_REASON))
} else {
  const { apply, Config, inject, name, SETTINGS_NS } = pluginModule

  async function setup(t, config = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'retirement-calc-'))
    const stateFile = join(directory, 'profile.json')
    const { ctx, captured } = harness()
    apply(ctx, { stateFile, ...config })
    const byName = Object.fromEntries(captured.tools.map(tool => [tool.name, tool]))
    t.after(async () => {
      for (const dispose of captured.disposers) await dispose()
      await rm(directory, { recursive: true, force: true })
    })
    return { directory, stateFile, captured, byName }
  }

  test('声明插件身份', () => {
    assert.equal(name, 'retirement-calc')
    assert.deepEqual(inject, ['tools'])
    assert.equal(SETTINGS_NS, 'retirement-calc')
    assert.ok(Config !== undefined)
  })

  test('注册三个工具、系统提示段、内嵌技能与路由', async t => {
    const { captured, byName } = await setup(t)
    assert.deepEqual(Object.keys(byName).sort(), ['retirement_compare', 'retirement_plan', 'retirement_profile'])
    assert.equal(captured.sections.length, 1)
    assert.equal(captured.sections[0].name, 'retirement-calc')
    assert.equal(captured.skills.length, 1)
    assert.equal(captured.skills[0].name, SKILL_NAME)
    assert.equal(captured.skills[0].source, 'runtime')
    assert.equal(captured.routes.length, 1)
    assert.equal(captured.routes[0].path, '/retire/api')
    assert.ok(captured.settings !== undefined, '应向设置服务注册配置段')
  })

  test('retirement_plan 用默认档案出结果，且符合自己声明的 schema', async t => {
    const { byName } = await setup(t)
    const value = await byName.retirement_plan.execute({})
    assertMatchesSchema(byName.retirement_plan.output.schema, value)

    assert.equal(value.retirement_date, '2053年1月')
    assert.equal(value.retirement_age, '63岁')
    assert.equal(value.legal_delay_months, 36)
    assert.equal(value.annuity_months, 117)
    assert.equal(value.total_paid_months, 38 * 12)
    assert.equal(value.required_months, 240)
    assert.equal(value.meets_minimum, true)
    assert.ok(value.days_until_retirement > 0)
    assert.ok(value.monthly_pension > 0)
    // 三项构成相加应等于合计（允许一分钱的四舍五入差）
    const sum = value.basic_pension + value.account_pension + value.transitional_pension
    assert.ok(Math.abs(sum - value.monthly_pension) < 0.02, `构成 ${sum} 与合计 ${value.monthly_pension} 不符`)
    assert.match(value.report, /预计月养老金/)
    assert.match(value.notes, /最低缴费年限/)
  })

  test('retirement_plan 的参数覆盖只影响本次调用，不写档案', async t => {
    const { byName } = await setup(t)
    await byName.retirement_plan.execute({ birth_year: 1978, birth_month: 3, category: 'female50', province: 'heilongjiang' })
    const after = await byName.retirement_plan.execute({})
    assert.equal(after.retirement_date, '2053年1月', '未传 save 时不应改动档案')

    const overridden = await byName.retirement_plan.execute({ province: 'shanghai' })
    assert.ok(overridden.base_at_retirement > after.base_at_retirement, '上海计发基数更高')
  })

  test('1978 年 3 月生的女工人按新政 2029 年 11 月退休，最低缴费年限 15 年', async t => {
    const { byName } = await setup(t)
    const value = await byName.retirement_plan.execute({
      birth_year: 1978, birth_month: 3, category: 'female50', province: 'heilongjiang',
    })
    assert.equal(value.retirement_date, '2029年11月')
    assert.equal(value.retirement_age, '51岁8个月')
    assert.equal(value.legal_delay_months, 20)
    assert.equal(value.required_months, 180)
  })

  test('同样的 1978 年 3 月生，男职工要 2041 年 3 月才退，最低缴费年限 20 年', async t => {
    const { byName } = await setup(t)
    const value = await byName.retirement_plan.execute({
      birth_year: 1978, birth_month: 3, category: 'male', province: 'heilongjiang',
    })
    assert.equal(value.retirement_date, '2041年3月')
    assert.equal(value.retirement_age, '63岁')
    assert.equal(value.required_months, 240)
  })

  test('save=true 会把参数写进档案，并且能跨实例恢复', async t => {
    const { stateFile, byName } = await setup(t)
    await byName.retirement_plan.execute({
      birth_year: 1978, birth_month: 3, category: 'female50', province: 'heilongjiang',
      paid_months: 27 * 12, paid_index: 0.8, future_months: 3 * 12, future_index: 0.6,
      account_balance: 114_000, save: true,
    })

    const persisted = await byName.retirement_plan.execute({})
    assert.equal(persisted.retirement_date, '2029年11月')

    // 新开一个实例读同一个文件，验证确实落盘了。
    const { ctx, captured } = harness()
    apply(ctx, { stateFile })
    // 等启动读盘完成
    await new Promise(resolve => setTimeout(resolve, 20))
    const reloaded = captured.tools.find(tool => tool.name === 'retirement_plan')
    const value = await reloaded.execute({})
    assert.equal(value.retirement_date, '2029年11月')
    assert.equal(value.total_paid_months, 30 * 12)
    for (const dispose of captured.disposers) await dispose()
  })

  test('retirement_profile 能读、能改、能清空', async t => {
    const { byName } = await setup(t)
    const tool = byName.retirement_profile

    const initial = await tool.execute({ action: 'get' })
    assertMatchesSchema(tool.output.schema, initial)
    assert.match(initial.profile_text, /出生：1990 年 1 月/)

    const updated = await tool.execute({
      action: 'set',
      fields: { birth_year: 1985, birth_month: 7, category: 'female55', province: 'jiangsu', account_balance: 150_000 },
    })
    assertMatchesSchema(tool.output.schema, updated)
    assert.match(updated.changed, /已更新 5 项/)
    assert.match(updated.profile_text, /出生：1985 年 7 月/)
    assert.match(updated.profile_text, /女职工·管理技术岗/)

    // camelCase 也认
    const camel = await tool.execute({ action: 'set', fields: { birthYear: 1992 } })
    assert.match(camel.profile_text, /出生：1992 年 7 月/)

    const cleared = await tool.execute({ action: 'clear' })
    assert.match(cleared.profile_text, /出生：1990 年 1 月/)
  })

  test('retirement_profile 忽略不认识的字段，且不会被 __proto__ 带偏', async t => {
    const { byName } = await setup(t)
    // 用 JSON.parse 才能造出「`__proto__` 是一个普通自身属性」的输入 ——
    // 对象字面量里的 `__proto__` 只会改掉原型，造不出真正的攻击形态。
    const fields = JSON.parse('{"birth_year":1985,"不认识的字段":"x","__proto__":{"polluted":true}}')
    assert.ok(Object.hasOwn(fields, '__proto__'), '前置条件：__proto__ 应是自身属性')

    const value = await byName.retirement_profile.execute({ action: 'set', fields })
    assert.match(value.changed, /已更新 1 项/)
    assert.match(value.profile_text, /出生：1985 年/)
    assert.equal({}.polluted, undefined, '不应造成原型污染')
  })

  test('retirement_compare 逐项给出差额与百分比', async t => {
    const { byName } = await setup(t)
    const value = await byName.retirement_compare.execute({
      scenarios: {
        多缴五年: { future_months: 30 * 12 + 60 },
        档次提高: { future_index: 1.0 },
        延后三年: { delay_months: 36 },
      },
    })
    assertMatchesSchema(byName.retirement_compare.output.schema, value)
    assert.match(value.table, /基准：/)
    assert.match(value.table, /多缴五年/)
    assert.match(value.table, /延后三年/)
    assert.equal((value.table.match(/·/g) ?? []).length, 3)
    assert.match(value.note, /经济假设/)

    const empty = await byName.retirement_compare.execute({})
    assert.match(empty.table, /未提供情景/)
  })

  test('情景对比缺省时不抛错，基准与自身差为零', async t => {
    const { byName } = await setup(t)
    const value = await byName.retirement_compare.execute({ scenarios: { 原样: {} } })
    assert.match(value.table, /\+￥0\.00/)
  })

  test('HTTP 路由：catalog / status / preview / save / reset', async t => {
    const { captured, byName } = await setup(t)
    const route = captured.routes[0].handler

    async function call(method, path, body) {
      const res = response()
      await route(request('POST', `/retire/api/${path}`, body), res)
      return res.captured
    }

    const catalog = await call('POST', 'catalog')
    assert.equal(catalog.status, 200)
    assert.ok(catalog.body.value.provinces.length > 20)
    assert.equal(catalog.body.value.categories.length, 3)

    const status = await call('POST', 'status')
    assert.equal(status.body.value.result.retirementDate, '2053年1月')
    assert.equal(status.body.value.result.monthlyPension > 0, true)
    assert.match(status.body.value.report, /退休测算/)
    assert.equal(status.body.value.assumptions.baseGrowthRate, 0.02)

    // preview 只算不存
    const preview = await call('POST', 'preview', { profile: { province: 'shanghai' } })
    assert.equal(preview.body.value.result.baseAtRetirement > status.body.value.result.baseAtRetirement, true)
    const afterPreview = await call('POST', 'status')
    assert.equal(afterPreview.body.value.result.retirementDate, '2053年1月')
    assert.equal(afterPreview.body.value.result.baseAtRetirement, status.body.value.result.baseAtRetirement)

    // save 落盘
    const saved = await call('POST', 'save', { profile: { birth_year: 1978, birth_month: 3, category: 'female50' } })
    assert.equal(saved.body.value.result.retirementDate, '2029年11月')
    assert.equal(saved.body.value.changed, 3)
    const replayed = await byName.retirement_plan.execute({})
    assert.equal(replayed.retirement_date, '2029年11月')

    // reset 回到默认
    const reset = await call('POST', 'reset')
    assert.equal(reset.body.value.result.retirementDate, '2053年1月')

    // 未知路由
    const unknown = await call('POST', 'nope')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.ok, false)
  })

  test('HTTP 路由：GET 与跨站 Origin 都被拒', async t => {
    const { captured } = await setup(t)
    const route = captured.routes[0].handler

    const getRes = response()
    await route(request('GET', '/retire/api/status'), getRes)
    assert.equal(getRes.captured.body.ok, false)

    const crossRes = response()
    await route(request('POST', '/retire/api/save', { profile: {} }, { origin: 'https://evil.example', host: 'localhost:3000' }), crossRes)
    assert.equal(crossRes.captured.status, 403)
    assert.equal(crossRes.captured.body.error.code, 'cross-site')

    // 同源与无 Origin（CLI 客户端）都要放过
    const sameRes = response()
    await route(request('POST', '/retire/api/status', {}, { origin: 'http://localhost:3000', host: 'localhost:3000' }), sameRes)
    assert.equal(sameRes.captured.body.ok, true)

    const cliRes = response()
    await route(request('POST', '/retire/api/status', {}), cliRes)
    assert.equal(cliRes.captured.body.ok, true)
  })

  test('关掉提示段与技能后不再挂载', async t => {
    const { captured } = await setup(t, { promptSection: false, skill: false })
    assert.equal(captured.sections.length, 0)
    assert.equal(captured.skills.length, 0)
    // 工具与路由与这两个开关无关，仍然要在
    assert.equal(captured.tools.length, 3)
    assert.equal(captured.routes.length, 1)
  })

  test('计发基数没指定时跟随省份，换省后随之改变', async t => {
    const { byName } = await setup(t)
    const guangdong = await byName.retirement_plan.execute({ province: 'guangdong' })
    const heilongjiang = await byName.retirement_plan.execute({ province: 'heilongjiang' })
    // 广东 9493、黑龙江 7570，退休上一年度的值按同一条增长曲线推出去
    assert.ok(guangdong.base_at_retirement > heilongjiang.base_at_retirement)

    // 显式指定基数后，换省不再影响这一个数字
    const pinned = await byName.retirement_plan.execute({ province: 'guangdong', base_amount: 8000, base_year: 2025, base_growth_rate: 0 })
    assert.equal(pinned.base_at_retirement, 8000)
  })
}
