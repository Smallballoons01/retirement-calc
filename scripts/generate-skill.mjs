#!/usr/bin/env node
/**
 * 从 `skill.js` 生成 `skills/retirement-planner/SKILL.md`。
 *
 * 技能的正文有两个出口：插件运行时通过 `ctx.skills.register()` 注册，以及作为
 * 文件落盘供使用文件系统技能根的宿主读取。两份内容必须逐字节相同，否则同一个
 * 技能在不同工具里会讲两套话。`skill.js` 是唯一事实来源，这个脚本负责把它铺到
 * 磁盘上，`--check` 用来在改动后验证没有漂移。
 *
 *   node scripts/generate-skill.mjs          # 写文件
 *   node scripts/generate-skill.mjs --check  # 只校验，不写
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SKILL_NAME, skillMarkdown } from '../skill.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const checkOnly = process.argv.includes('--check')

/** 目标路径。目录名必须与 SKILL_NAME 一致，这是 Agent Skills 规范的硬要求。 */
const TARGET = join(root, 'skills', SKILL_NAME, 'SKILL.md')

async function main() {
  const expected = `${skillMarkdown()}\n`

  if (checkOnly) {
    let existing = ''
    try {
      existing = await readFile(TARGET, 'utf8')
    } catch {
      throw new Error(`技能文件不存在：${relative(root, TARGET)}，请先运行 node scripts/generate-skill.mjs`)
    }
    if (existing !== expected) {
      throw new Error(`技能文件与 skill.js 不同步：${relative(root, TARGET)}`)
    }
    process.stdout.write(`✓ 技能文件已是最新：${relative(root, TARGET)}\n`)
    return
  }

  await mkdir(dirname(TARGET), { recursive: true })
  await writeFile(TARGET, expected, 'utf8')
  process.stdout.write(`✓ 已生成 ${relative(root, TARGET)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
