#!/usr/bin/env node
/**
 * 真机组合验证：把插件挂到真实的 cordis 组合上，打真实的 HTTP 请求。
 *
 * `test/integration.test.js` 刻意不加载 `webServer`，用来看插件在可选面缺失时
 * 会不会降级；代价是 `/retire/api` 那条路由从来没被真正请求过。这个脚本补上
 * 那一半：连真的 WebServer 服务一起装，起监听，用 fetch 打进去。
 *
 * 它**不碰任何 profile** —— 全程在一个临时目录里读档写档，进程退出一切归零。
 *
 *   node scripts/verify-plugin.mjs
 *
 * 找不到 harness 包时打印提示并以 0 退出（视为跳过）。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 找一个当前空闲的端口交给 WebServer，避免撞上用户正在跑的服务。 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const checks = []
const failures = []
function check(condition, message) {
  checks.push(message)
  if (!condition) failures.push(message)
}

async function main() {
  let deps
  try {
    const [cordis, tools, skill, systemPrompt, webServer, plugin] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-tools'),
      import('@deepseek-ai/dsh-skill'),
      import('@deepseek-ai/dsh-system-prompt'),
      import('@deepseek-ai/dsh-host-webserver'),
      import('../index.js'),
    ])
    deps = {
      Context: cordis.Context,
      ToolRuntime: tools.default,
      SkillRegistry: skill.default,
      SystemPrompt: systemPrompt.default,
      renderPrompt: systemPrompt.renderPrompt,
      WebServer: webServer.default,
      plugin,
    }
  } catch (error) {
    process.stdout.write(`⚠ 未找到 DeepSeek Harness 包，跳过真机验证。（${String(error?.message ?? error).split('\n')[0]}）\n`)
    return
  }

  const { Context, ToolRuntime, SkillRegistry, SystemPrompt, renderPrompt, WebServer, plugin } = deps
  const directory = await mkdtemp(join(tmpdir(), 'retirement-calc-verify-'))
  const stateFile = join(directory, 'profile.json')
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  // ToolRuntime 依赖 systemPrompt，顺序不能反。
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port })
  const fiber = await ctx.plugin(plugin, { stateFile })

  /** 打一个真请求。 */
  async function call(route, body, headers = {}) {
    const response = await fetch(`${base}/retire/api/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    })
    return { status: response.status, json: await response.json().catch(() => undefined) }
  }

  try {
    // —— 组合层面 ——
    check(
      JSON.stringify(ctx.tools.schemas().map(tool => tool.name).sort())
        === JSON.stringify(['retirement_compare', 'retirement_plan', 'retirement_profile']),
      '三个工具都进入了真实注册表',
    )
    check(renderPrompt(await ctx.systemPrompt.assemble()).includes('retirement-calc plugin'), '系统提示段已注入')
    check(
      (await ctx.skills.list({})).some(entry => entry.name === 'retirement-planner' && entry.source === 'runtime'),
      '内嵌技能可被发现',
    )

    // —— 路由真的活着 ——
    const status = await call('status')
    check(status.status === 200 && status.json?.ok === true, 'POST /retire/api/status 返回 200 与 ok')
    check(status.json?.value?.result?.retirementDate === '2053年1月', '默认档案算出 2053 年 1 月退休')
    check(status.json?.value?.result?.daysUntilRetirement > 0, '距退休天数为正')
    check(
      typeof status.json?.value?.result?.monthlyPension === 'number' && status.json.value.result.monthlyPension > 0,
      '预计月养老金为正数',
    )
    check(status.json?.value?.report?.includes('【退休测算】'), '报告文本随响应一并返回')

    const catalog = await call('catalog')
    check(catalog.json?.value?.provinces?.length >= 30, `省份目录有 ${catalog.json?.value?.provinces?.length} 项`)
    check(catalog.json?.value?.categories?.length === 3, '人群目录有 3 项')

    // —— 试算不落盘 ——
    const before = (await call('status')).json.value.result.baseAtRetirement
    const preview = await call('preview', { profile: { province: 'shanghai' } })
    check(preview.json.value.result.baseAtRetirement > before, 'preview 换到上海后计发基数上升')
    const afterPreview = (await call('status')).json.value.result.baseAtRetirement
    check(afterPreview === before, 'preview 没有污染已保存的档案')

    // —— 保存真的落盘 ——
    const saved = await call('save', { profile: { birth_year: 1978, birth_month: 3, category: 'female50', province: 'heilongjiang' } })
    check(saved.json.value.result.retirementDate === '2029年11月', 'save 后档案生效：女工人 2029 年 11 月退休')
    const onDisk = JSON.parse(await readFile(stateFile, 'utf8'))
    check(onDisk.profile.birthYear === 1978 && onDisk.profile.category === 'female50', '档案已写入磁盘')

    // —— 防线还在 ——
    const crossSite = await call('status', {}, { origin: 'https://evil.example' })
    check(crossSite.status === 403, '跨站 Origin 被 403 拒绝')
    const notFound = await call('nope')
    check(notFound.status === 404, '未知路由返回 404')
    const getMethod = await fetch(`${base}/retire/api/status`, { method: 'GET' })
    const getBody = await getMethod.json()
    check(getBody.ok === false, 'GET 被拒绝')

    // —— 卸载干净 ——
    await fiber.dispose()
    check(ctx.tools.schemas().length === 0, '卸载后工具全部注销')
    // WebServer 是独立挂载的，卸载本插件不会关掉它 —— 所以判据不是「连不上」，
    // 而是「这条路没了」：前缀路由被收回，请求落到 404。
    const afterDispose = await fetch(`${base}/retire/api/status`, { method: 'POST', body: '{}' })
    check(afterDispose.status === 404, '卸载后 /retire/api 路由已注销（返回 404）')
  } finally {
    // dispose 在 try 里已经调过一次，这里只是兜底；重复卸载会抛，忽略即可。
    try {
      await fiber.dispose()
    } catch {
      // 已经卸载过了
    }
    await rm(directory, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    process.stderr.write(`\n✗ ${failures.length}/${checks.length} 项未通过：\n`)
    for (const failure of failures) process.stderr.write(`  · ${failure}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`✓ 真机组合验证通过（${checks.length} 项，端口 ${port}）：\n`)
  for (const message of checks) process.stdout.write(`  · ${message}\n`)
}

main()
  .catch(error => {
    process.stderr.write(`验证失败：${error.stack ?? error}\n`)
    process.exitCode = 1
  })
  .finally(() => {
    // WebServer 的 http listener 会让事件循环一直活着。dispose 理应关掉它，
    // 但只要还有任何一处没释放，脚本就会挂在这里既不出结果也不退出 ——
    // 所以验证做完直接退出，别把「跑完」这件事押在清理的完整性上。
    process.exit(process.exitCode ?? 0)
  })
