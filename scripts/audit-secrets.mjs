#!/usr/bin/env node
/**
 * 提交前 / 开源前的敏感信息扫描。
 *
 * 这个包的仓库里只有测算逻辑，本不该出现任何凭据或个人信息 —— 但"本不该"不是
 * 保证：一条从本地调试里复制过来的绝对路径、一个顺手写进注释的邮箱，都足以在
 * 公开仓库里长期躺着。所以把它做成一条能反复跑的检查，而不是靠发布前想起来。
 *
 *   node scripts/audit-secrets.mjs
 *
 * 发现命中即以非 0 退出；误报通过规则里的 `allow` 显式豁免，不允许静默放宽正则。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 不参与扫描的目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.cache'])

/** 只扫这些扩展名，二进制与锁文件跳过。 */
const SCAN_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.yml', '.yaml',
  '.md', '.html', '.css', '.txt', '.sh',
])

/**
 * 扫描规则。每条都带 `why` —— 命中时解释的是"为什么这有害"，而不是"正则匹配了"。
 */
const RULES = [
  {
    id: 'home-path',
    why: '本机绝对路径会泄露用户名与目录结构',
    // 匹配「家目录 + 用户名」形态的绝对路径；写成占位符的不算（见 allow）。
    // 注意这条注释本身不能出现该形态的字面量，否则扫描会命中自己。
    pattern: /\/(?:Users|home)\/([A-Za-z0-9._-]+)\//g,
    allow: (match, groups) => groups[0].startsWith('<') || groups[0].length === 0,
  },
  {
    id: 'windows-path',
    why: '本机绝对路径会泄露用户名',
    pattern: /[A-Za-z]:\\\\?Users\\\\?([A-Za-z0-9._-]+)/g,
    allow: (_match, groups) => groups[0].startsWith('<'),
  },
  {
    id: 'private-key',
    why: '私钥绝不能进仓库',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'known-token-prefix',
    why: '具有可识别前缀的凭据一旦泄露即可被直接使用',
    pattern: /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    id: 'jwt',
    why: 'JWT 往往携带会话凭据',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./g,
  },
  {
    id: 'ipv4-private',
    why: '内网地址暴露拓扑信息',
    pattern: /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    id: 'email',
    why: '个人邮箱属于可识别信息；文档里的示例地址应使用 example.com',
    pattern: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    allow: (_match, groups) => /(?:^|\.)(?:example\.(?:com|org|net)|test|invalid|localhost)$/i.test(groups[0]),
  },
  {
    id: 'secret-assignment',
    why: '看起来像真凭据的字面量赋值',
    // 键名像凭据，且值是一段足够长的字面量（不是变量引用、不是空串、不是占位符）。
    pattern: /\b(?:api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*['"`]([^'"`\s]{16,})['"`]/gi,
    allow: (_match, groups) => /^(?:<[^>]+>|\$\{|process\.env|xxx+|your[-_]|placeholder|\*+)$/i.test(groups[0]),
  },
]

/** 递归收集待扫描文件。 */
async function collect(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.editorconfig') continue
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collect(full, out)
      continue
    }
    const dot = entry.name.lastIndexOf('.')
    if (dot < 0 || !SCAN_EXTENSIONS.has(entry.name.slice(dot))) continue
    out.push(full)
  }
  return out
}

/**
 * 逐行匹配一条规则。
 * @returns {{line: number, text: string}[]} 命中位置。
 */
function scanText(text, rule) {
  const hits = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    // 每行独立扫描，正则带 g 需要重置 lastIndex
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    let match
    while ((match = pattern.exec(line)) !== null) {
      const groups = match.slice(1)
      if (rule.allow !== undefined && rule.allow(match[0], groups)) {
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1
        continue
      }
      hits.push({ line: index + 1, text: line.trim().slice(0, 160) })
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1
    }
  }
  return hits
}

/** 必须存在于仓库里的文件 —— 少一个都说明打包漏了东西。 */
const REQUIRED_FILES = ['LICENSE', 'README.md', 'README.zh.md', 'SECURITY.md', '.gitignore', 'package.json']

async function main() {
  const files = (await collect(root)).sort()
  const findings = []

  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const rule of RULES) {
      for (const hit of scanText(text, rule)) {
        findings.push({ file: relative(root, file), rule: rule.id, why: rule.why, ...hit })
      }
    }
  }

  const missing = []
  for (const name of REQUIRED_FILES) {
    try {
      await stat(join(root, name))
    } catch {
      missing.push(name)
    }
  }

  process.stdout.write(`敏感信息扫描：${files.length} 个文件，${RULES.length} 条规则\n`)
  process.stdout.write('-'.repeat(72) + '\n')

  if (findings.length === 0) {
    process.stdout.write('✓ 未发现凭据、个人路径、内网地址或邮箱\n')
  } else {
    for (const finding of findings) {
      process.stdout.write(`✗ [${finding.rule}] ${finding.file}:${finding.line}\n`)
      process.stdout.write(`    ${finding.why}\n`)
      process.stdout.write(`    ${finding.text}\n`)
    }
  }

  if (missing.length > 0) {
    process.stdout.write(`\n✗ 缺少必需文件：${missing.join('、')}\n`)
  } else {
    process.stdout.write(`✓ 必需文件齐备（${REQUIRED_FILES.join('、')}）\n`)
  }

  if (findings.length > 0 || missing.length > 0) {
    process.exitCode = 1
    return
  }
  process.stdout.write('✓ 可以安全提交\n')
}

main().catch(error => {
  process.stderr.write(`扫描失败：${error.stack ?? error}\n`)
  process.exitCode = 1
})
