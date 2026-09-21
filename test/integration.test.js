/**
 * 针对真实 cordis 组合的集成测试。
 *
 * `test/plugin.test.js` 驱动的是最小假上下文，跑得快，但抓不到「插件跟 cordis
 * 本身打交道的方式」出了问题。这个文件把插件挂到真正的 `Context` 上，接上真的
 * `tools`、`skills`、`systemPrompt` 服务，因此能证明：声明的依赖确实能解析、
 * 注册的工具能通过 schema 编译、内嵌技能能在 `ctx.skills` 里被发现、卸载之后
 * 一切干净退出。
 *
 * 组合里刻意**不放** `webServer` 与 `settings`：这两个是可选面，在没有它们的
 * 情况下也能加载，才说明插件会降级而不是崩掉。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Harness 包与插件一起解析，缺依赖时给出一条清晰的跳过而不是导入崩溃。 */
const SKIP_REASON = '需要 DeepSeek Harness 包（@deepseek-ai/cordis、dsh-tools、dsh-skill、dsh-system-prompt）；见 README 的前置条件'
const deps = await (async () => {
  try {
    const [cordis, tools, skill, systemPrompt, plugin, skillModule] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-tools'),
      import('@deepseek-ai/dsh-skill'),
      import('@deepseek-ai/dsh-system-prompt'),
      import('../index.js'),
      import('../skill.js'),
    ])
    return {
      Context: cordis.Context,
      ToolRuntime: tools.default,
      SkillRegistry: skill.default,
      SystemPrompt: systemPrompt.default,
      renderPrompt: systemPrompt.renderPrompt,
      plugin,
      SKILL_NAME: skillModule.SKILL_NAME,
      skillBody: skillModule.skillBody,
    }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
})()

const TOOL_NAMES = ['retirement_compare', 'retirement_plan', 'retirement_profile']

if (deps.error !== undefined) {
  test('retirement-calc 组合测试', t => t.skip(`${SKIP_REASON} (${deps.error})`))
} else {
  const { Context, ToolRuntime, SkillRegistry, SystemPrompt, renderPrompt, plugin, SKILL_NAME, skillBody } = deps

  async function composition(t, config = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'retirement-calc-ctx-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    // ToolRuntime 依赖 systemPrompt，所以必须在它之后加载。
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(plugin, { stateFile: join(directory, 'profile.json'), ...config })
    t.after(async () => {
      await fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    })
    return { ctx, fiber, directory }
  }

  test('能挂到真实组合上并注册全部工具', async (t) => {
    const { ctx } = await composition(t)
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), TOOL_NAMES)

    for (const name of TOOL_NAMES) {
      const tool = ctx.tools.get(name)
      assert.notEqual(tool, undefined, `${name} 没有进入注册表`)
      assert.equal(tool.parameters.type, 'object')
      assert.ok(tool.description.length > 40, `${name} 的描述太短，模型无法据以路由`)
      assert.equal(tool.output.schema.type, 'object')
    }

    const profile = ctx.tools.get('retirement_profile')
    assert.deepEqual(profile.parameters.required, ['action'])
    assert.deepEqual(profile.parameters.properties.action.enum, ['get', 'set', 'clear'])

    // 自由形态的参数对象必须显式声明 additionalProperties，否则 schema 编译会拒绝。
    assert.equal(profile.parameters.properties.fields.additionalProperties, true)
    assert.equal(ctx.tools.get('retirement_compare').parameters.properties.scenarios.additionalProperties, true)
  })

  test('通过真实注册表执行工具', async (t) => {
    const { ctx } = await composition(t)
    const value = await ctx.tools.get('retirement_plan').execute({
      birth_year: 1978, birth_month: 3, category: 'female50', province: 'heilongjiang',
      paid_months: 27 * 12, paid_index: 0.8,
      future_months: 3 * 12, future_index: 0.6,
      account_balance: 114_000,
    }, {})

    // 女工人 1978 年 3 月生：原法定 2028 年 3 月，延迟 20 个月 → 2029 年 11 月
    assert.equal(value.retirement_date, '2029年11月')
    assert.equal(value.retirement_age, '51岁8个月')
    assert.equal(value.required_months, 180)
    assert.equal(value.total_paid_months, 30 * 12)
    assert.ok(value.monthly_pension > 0)
    assert.ok(value.days_until_retirement > 0)

    const compared = await ctx.tools.get('retirement_compare').execute({
      scenarios: { 延后三年: { delay_months: 36 } },
    }, {})
    assert.match(compared.table, /延后三年/)
  })

  test('档案确实落到磁盘上', async (t) => {
    const { ctx, directory } = await composition(t)
    await ctx.tools.get('retirement_profile').execute({
      action: 'set',
      fields: { birth_year: 1985, birth_month: 7, category: 'female55', province: 'jiangsu' },
    }, {})

    const saved = JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8'))
    assert.equal(saved.profile.birthYear, 1985)
    assert.equal(saved.profile.category, 'female55')
    assert.equal(saved.profile.province, 'jiangsu')
  })

  test('内嵌技能可被发现与加载', async (t) => {
    const { ctx } = await composition(t)
    const catalog = await ctx.skills.list({})
    const summary = catalog.find(entry => entry.name === SKILL_NAME)
    assert.notEqual(summary, undefined, '内嵌技能没有出现在合并后的目录里')
    assert.equal(summary.source, 'runtime')
    assert.equal(summary.provider, 'runtime')
    assert.equal(summary.invocation.modelInvocable, true)
    assert.ok(summary.description.length > 0 && summary.description.length <= 500)

    const loaded = await ctx.skills.get(SKILL_NAME, {})
    assert.notEqual(loaded, undefined)
    assert.equal(loaded.content, skillBody())
  })

  test('向组合后的系统提示贡献了说明段', async (t) => {
    const { ctx } = await composition(t)
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    assert.match(prompt, /retirement-calc plugin/)
    assert.match(prompt, /retirement_plan/)
    // 最关键的一条纪律：不许凭记忆报数字
    assert.match(prompt, /Never estimate these numbers from memory/)
  })

  test('关掉技能与提示段后不再挂载，工具仍在', async (t) => {
    const { ctx } = await composition(t, { skill: false, promptSection: false })
    const catalog = await ctx.skills.list({})
    assert.equal(catalog.find(entry => entry.name === SKILL_NAME), undefined)

    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    assert.doesNotMatch(prompt, /retirement-calc plugin/)

    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), TOOL_NAMES)
  })

  test('卸载后每一项贡献都被收回', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'retirement-calc-dispose-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)

    const fiber = await ctx.plugin(plugin, { stateFile: join(directory, 'profile.json') })
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), TOOL_NAMES)

    await fiber.dispose()
    await rm(directory, { recursive: true, force: true })

    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), [])
    const catalog = await ctx.skills.list({})
    assert.equal(catalog.find(entry => entry.name === SKILL_NAME), undefined)
  })
}
