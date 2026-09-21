#!/usr/bin/env node
/**
 * 把 `core.js` + `web/app.js` + `web/template.html` 合成一个自包含的 HTML。
 *
 * 为什么要内联：计算器要能双击打开就用。`file://` 下的 ES module 会被 CORS 拦，
 * 而引一个 `core.js` 又要求用户把整个目录带走。把源码拼进 `<script>` 里，
 * 产出的就是一个能单独发出去的 .html —— 也是分发给不装插件的同事时最省事的形式。
 *
 * 代价是 core.js 里不能有顶层 `import`（现在没有），且 `export` 关键字要被剥掉：
 * 内联脚本里不需要模块语法，剥掉之后 core 的所有函数直接落在全局作用域，
 * 后面的 app.js 就能像调用本地函数一样用它们。
 *
 *   node scripts/build-web.mjs          # 生成 dist/retirement-calculator.html
 *   node scripts/build-web.mjs --check  # 只校验产物是否与源码同步（不改文件）
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const checkOnly = process.argv.includes('--check')

/** 输出文件名，同时也是建议的分发名。 */
const OUTPUT = join(root, 'dist', 'retirement-calculator.html')

/**
 * 剥掉顶层的 `export` 关键字。
 *
 * 只匹配行首的 `export`，避免误伤 JSDoc 正文里出现的同名词。
 */
function stripExports(source) {
  return source.replace(/^export\s+/gm, '')
}

/**
 * 防呆：内联脚本里如果残留 `import`，产物在浏览器里会静默失败。
 * @param {string} source 待检查的源码。
 * @param {string} label 报错时用于定位的名字。
 */
function assertNoImports(source, label) {
  if (/^\s*import\s/m.test(source)) {
    throw new Error(`${label} 含有 import 语句，内联进单文件 HTML 后无法解析。请去掉依赖后再构建。`)
  }
}

async function main() {
  const [coreSource, appSource, template] = await Promise.all([
    readFile(join(root, 'core.js'), 'utf8'),
    readFile(join(root, 'web', 'app.js'), 'utf8'),
    readFile(join(root, 'web', 'template.html'), 'utf8'),
  ])

  assertNoImports(coreSource, 'core.js')
  assertNoImports(appSource, 'web/app.js')

  for (const token of ['/*__CORE_SOURCE__*/', '/*__APP_SOURCE__*/']) {
    if (!template.includes(token)) throw new Error(`模板缺少占位标记 ${token}`)
  }

  const html = template
    .replace('/*__CORE_SOURCE__*/', `\n/* ── core.js（构建期内联） ── */\n${stripExports(coreSource)}\n`)
    .replace('/*__APP_SOURCE__*/', `\n/* ── web/app.js（构建期内联） ── */\n${appSource}\n`)

  if (checkOnly) {
    let existing = ''
    try {
      existing = await readFile(OUTPUT, 'utf8')
    } catch {
      throw new Error(`产物不存在，请先运行 node scripts/build-web.mjs`)
    }
    if (existing !== html) {
      throw new Error('产物与源码不同步，请重新运行 node scripts/build-web.mjs')
    }
    process.stdout.write(`✓ 产物已是最新：${relative(root, OUTPUT)}\n`)
    return
  }

  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, html, 'utf8')

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)
  process.stdout.write(`✓ 已生成 ${relative(root, OUTPUT)}（${kb} KB，单文件可直接打开）\n`)
}

main().catch(error => {
  process.stderr.write(`构建失败：${error.message}\n`)
  process.exitCode = 1
})
