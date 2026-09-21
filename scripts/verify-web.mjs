#!/usr/bin/env node
/**
 * 端到端验证构建产物。
 *
 * 单元测试只能证明 core.js 算得对，证明不了「页面真的会跑、改了输入真的会重算」。
 * 这个脚本把 `scripts/web-probe.js` 注入到 dist 里的单文件 HTML，用无头浏览器
 * 打开，模拟一串真实操作，然后对每一阶段的读数做断言。
 *
 *   node scripts/verify-web.mjs
 *
 * 找不到 Chrome / Edge / Chromium 时打印提示并以 0 退出（视为跳过），这样在
 * CI 或没有浏览器的机器上不会误报失败。
 */

import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 各平台上可能的浏览器可执行文件位置。 */
const BROWSER_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

async function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // 继续找下一个
    }
  }
  return undefined
}

/** HTML 实体反转义，用于还原探针写出的 JSON。 */
function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** 收集所有断言失败，跑完全部再一次性报告。 */
const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

function money(value) {
  const n = Number(value)
  return Number.isFinite(n) ? `￥${n.toFixed(2)}` : `(无法解析: ${value})`
}

async function main() {
  const browser = await findBrowser()
  if (browser === undefined) {
    process.stdout.write('⚠ 未找到 Chrome / Edge / Chromium，跳过浏览器端验证。\n')
    return
  }

  const html = await readFile(join(root, 'dist', 'retirement-calculator.html'), 'utf8')
  const probe = await readFile(join(here, 'web-probe.js'), 'utf8')

  const sandbox = await mkdtemp(join(tmpdir(), 'retire-verify-'))
  const page = join(sandbox, 'probe.html')
  await writeFile(
    page,
    html.replace('</body>', `<pre id="__test" style="display:none"></pre><script>${probe}<\/script></body>`),
    'utf8',
  )

  const { stdout } = await run(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=40000', '--dump-dom',
    `file://${page}`,
  ], { maxBuffer: 64 * 1024 * 1024 })

  await rm(sandbox, { recursive: true, force: true })

  const match = stdout.match(/id="__test"[^>]*>([\s\S]*?)<\/pre>/)
  if (match === null || match[1].trim() === '') {
    process.stderr.write('✗ 探针没有写出任何结果 —— 页面脚本可能没有执行。\n')
    process.exitCode = 1
    return
  }

  const rows = JSON.parse(decodeEntities(match[1]))
  const byTag = Object.fromEntries(rows.map(row => [row.tag, row]))

  const expectTags = [
    '初始状态', '弹性延后3年', '取消延后', '换到上海', '改成女工人', '出生改1978年3月',
    '填入示例缴费数据', '档次提到1.5', '改回男职工广东', '清空计发基数', '计发基数改 20000',
  ]
  for (const tag of expectTags) {
    const row = byTag[tag]
    check(row !== undefined, `缺少阶段「${tag}」的结果`)
    if (row === undefined) continue
    check(row.error === undefined, `阶段「${tag}」抛错：${row.error}`)
  }

  const base = byTag['初始状态']
  const delayed = byTag['弹性延后3年']
  const restored = byTag['取消延后']
  const shanghai = byTag['换到上海']
  const femaleWorker = byTag['改成女工人']
  const born1978 = byTag['出生改1978年3月']
  const filled = byTag['填入示例缴费数据']
  const raised = byTag['档次提到1.5']
  const maleFinal = byTag['改回男职工广东']
  const cleared = byTag['清空计发基数']
  const customBase = byTag['计发基数改 20000']

  // —— 渲染完整性 ——
  check(base?.metrics === 8, `关键指标应有 8 项，实际 ${base?.metrics}`)
  check(base?.breakdownLines >= 3, `计算明细至少 3 行，实际 ${base?.breakdownLines}`)
  check(base?.sensRows === 4, `敏感性表应有 4 行，实际 ${base?.sensRows}`)
  check(/已满足最低缴费年限/.test(base?.statusText ?? ''), '初始状态应提示已满足最低缴费年限')

  // —— 实时重算：每个阶段必须真的改变结果 ——
  check(Number(delayed?.pensionRaw) > Number(base?.pensionRaw),
    `延后 3 年后养老金应上升：${money(base?.pensionRaw)} → ${money(delayed?.pensionRaw)}`)
  check(Number(delayed?.daysRaw) > Number(base?.daysRaw),
    '延后 3 年后距退休天数应增加')
  check(delayed?.retire === '2056年1月', `延后 3 年应 2056年1月退休，实际 ${delayed?.retire}`)
  check(Math.abs(Number(restored?.pensionRaw) - Number(base?.pensionRaw)) < 0.01,
    '取消延后应回到初始养老金')

  // —— 省份切换要带上该省的计发基数 ——
  check(Number(shanghai?.pensionRaw) > Number(restored?.pensionRaw),
    `上海计发基数更高，养老金应上升：${money(restored?.pensionRaw)} → ${money(shanghai?.pensionRaw)}`)

  // —— 退休年龄规则：原 50 岁女工人 ——
  check(femaleWorker?.retire === '2045年1月',
    `1990 年 1 月生的女工人应 2045年1月退休，实际 ${femaleWorker?.retire}`)
  check(born1978?.retire === '2029年11月',
    `1978 年 3 月生的女工人应 2029年11月退休，实际 ${born1978?.retire}`)
  // 2029 年退休仍执行 15 年最低缴费年限
  check(born1978?.minReq === '15年', `2029 年退休最低缴费年限应为 15 年，实际 ${born1978?.minReq}`)

  // —— 1978 年 3 月生的男职工才是 2041 年 3 月退休（63 岁）——
  check(maleFinal?.retire === '2041年3月',
    `1978 年 3 月生的男职工应 2041年3月退休，实际 ${maleFinal?.retire}`)
  check(maleFinal?.minReq === '20年', `2041 年退休最低缴费年限应为 20 年，实际 ${maleFinal?.minReq}`)

  // —— 缴费档次提高待遇 ——
  check(Number(raised?.pensionRaw) > Number(filled?.pensionRaw),
    `提高缴费档次后养老金应上升：${money(filled?.pensionRaw)} → ${money(raised?.pensionRaw)}`)

  // —— 计发基数被清空时要回落到省份默认，不能变成 0 ——
  check(cleared?.retire === maleFinal?.retire, '清空计发基数不应改变退休时间')
  check(Math.abs(Number(cleared?.pensionRaw) - Number(maleFinal?.pensionRaw)) < 0.01,
    `清空计发基数应回落到省份默认值（${money(cleared?.pensionRaw)} vs ${money(maleFinal?.pensionRaw)}）`)
  check(Number(customBase?.pensionRaw) > Number(maleFinal?.pensionRaw),
    '手工把计发基数改成 20000 后养老金应上升')

  // —— 没有任何阶段算出 NaN / 空值 ——
  for (const row of rows) {
    check(Number.isFinite(Number(row.pensionRaw)), `阶段「${row.tag}」的养老金不是有限数：${row.pensionRaw}`)
    check(Number.isFinite(Number(row.daysRaw)), `阶段「${row.tag}」的天数不是有限数：${row.daysRaw}`)
  }

  // —— 报告 ——
  const pad = (text, width) => String(text).padEnd(width)
  process.stdout.write('\n浏览器端交互验证\n')
  process.stdout.write('-'.repeat(76) + '\n')
  process.stdout.write(`${pad('操作', 22)}${'距退休天数'.padStart(10)}${'预计月养老金'.padStart(14)}${'退休时间'.padStart(12)}${'最低'.padStart(7)}\n`)
  for (const row of rows) {
    process.stdout.write(
      pad(row.tag, 22)
      + String(row.daysRaw ?? '').padStart(10)
      + money(row.pensionRaw).padStart(14)
      + String(row.retire ?? '').padStart(12)
      + String(row.minReq ?? '').padStart(7) + '\n')
  }
  process.stdout.write('-'.repeat(76) + '\n')

  if (failures.length > 0) {
    process.stderr.write(`\n✗ ${failures.length} 项断言未通过：\n`)
    for (const failure of failures) process.stderr.write(`  · ${failure}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`✓ ${rows.length} 个阶段全部通过，页面实时重算正常。\n`)
}

main().catch(error => {
  process.stderr.write(`验证失败：${error.stack ?? error}\n`)
  process.exitCode = 1
})
