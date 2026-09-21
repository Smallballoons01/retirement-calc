/**
 * `client.js` 的结构约束测试。
 *
 * 这些不是行为测试，而是把踩过的坑钉成可执行的规则。客户端这一半跑在宿主浏览器里，
 * 既没有单元测试的着力点，也不方便端到端断言（面板要先点开才存在），于是最容易
 * 「改一行、看起来没事、实际坏掉体验」。所以用源码层面的断言守住几条底线。
 *
 * 每一条都对应一次真实故障，注释里写明了是哪一次。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(root, 'client.js'), 'utf8')
const lines = source.split('\n')

/**
 * 取匹配某模式的行号（从 1 开始）。
 *
 * 默认跳过注释行：这些注释里会引用「不要这么写」的反面示例，把它们也算成违规，
 * 规则就变成了谁解释谁挨罚 —— 第一版就踩了这个，把自己写的说明判成了违规。
 */
function findLines(pattern, { codeOnly = true } = {}) {
  const hits = []
  for (const [index, line] of lines.entries()) {
    if (codeOnly && /^\s*(\/\/|\*|\/\*)/.test(line)) continue
    if (pattern.test(line)) hits.push({ line: index + 1, text: line.trim() })
  }
  return hits
}

/**
 * 已确认**有真实定义**的 dsh 主题 token（取自运行中实例的客户端 bundle）。
 *
 * 怎么得到的：把 dsh 的客户端 bundle 拉下来，grep `--dsw-alias-<名>: <值>`。
 * 只被 `var(...)` 引用而没有定义的不要放进这个名单 —— 那些是遗留名，会静默落到
 * fallback 上。更新方法写在 client.js 顶部注释里。
 *
 * 名单里的值都是 `var(--dsw-static-neutral-bluish-N)` 形式，并且**成对**出现
 * （浅色主题一个、深色主题一个），所以它们会跟随主题。
 */
const KNOWN_TOKENS = new Set([
  // 文字
  'label-primary', 'label-secondary', 'label-tertiary', 'label-caption', 'label-dimmed',
  'brand-primary', 'brand-text',
  // 背景
  'bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3',
  // 边框
  'border-l1', 'border-l2', 'border-l3', 'border-l4',
  // 交互
  'interactive-bg-hover', 'interactive-bg-active', 'interactive-bg-hover-danger',
  // 状态。`state-business-primary` 指向 deepseek-400/500，是这套系统里真正的品牌蓝。
  'state-success-primary', 'state-error-primary', 'state-warn-primary', 'state-warn-label',
  'state-business-primary',
  // 其他
  'scrollbar-bg-l2', 'scrollbar-hover-l2', 'separator-primary',
])

test('编辑控件定义在模块级，而不是组件内部', () => {
  // 「输入一个字符就要重新点一次」的守门人。机制：控件定义在组件体内时，父组件每次
  // 重渲染都产生新的函数引用，React 据此判定元素类型变了，卸载并重建整棵子树 ——
  // 输入框 DOM 节点被替换，焦点随之丢失。已用 React 18.3.1 + jsdom 复现确认。
  for (const component of ['NumberField', 'Slider', 'MonthYear']) {
    const definitions = findLines(new RegExp(`const ${component} = `))
    assert.equal(definitions.length, 1, `${component} 应当恰好定义一次，实际 ${definitions.length} 次`)
    const { line, text } = definitions[0]
    assert.ok(
      text.startsWith(`const ${component} = `),
      `${component} 的定义在第 ${line} 行却有多余缩进（${text.slice(0, 40)}…）——`
      + '它很可能又被挪进组件体内了，那会让每次重渲染都重建子树并丢失输入焦点。',
    )
    const nested = findLines(new RegExp(`^ {8}const ${component} = `))
    assert.equal(nested.length, 0, `${component} 第 ${nested[0]?.line} 行被定义在了组件内部`)
  }
})

test('只用真实存在的主题 token', () => {
  // 这是我犯过的错：把 `--dsw-alias-text-primary` / `--dsw-alias-text-tertiary`
  // 当成真名用了 —— 名字看着完全合理，但它们没有定义，于是整块正文静默落到
  // fallback 的深色上，在深色主题里对比度只有 1.03:1，等于隐形。
  // 真实的是 label-* 系列。
  // 逐行扫并跳过注释 —— 文件顶部那段说明里正列举了这些**错误**的名字作为反面教材，
  // 直接对整份源码跑正则会把他们也判成违规。
  const used = new Set()
  for (const line of lines) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    for (const match of line.matchAll(/--dsw-alias-([a-z0-9-]+)/g)) used.add(match[1])
  }
  const unknown = [...used].filter(name => !KNOWN_TOKENS.has(name))
  assert.deepEqual(
    unknown, [],
    `用到了未经验证的 token：${unknown.join('、')}。`
    + '要么改成 KNOWN_TOKENS 里的名字，要么先按 client.js 顶部注释里的方法到真实 bundle 里核实它确实有定义。',
  )
  // 反过来也确认一下：这些确实在用，避免整套退回写死的颜色。
  for (const required of ['label-primary', 'label-tertiary', 'state-business-primary', 'bg-layer-1']) {
    assert.ok(used.has(required), `应当在用 --dsw-alias-${required}`)
  }
})

test('兜底值用系统色，不用写死的明暗', () => {
  // 上一版把兜底写成了 `background: var(--…, #fff)` 配 `color: var(--…, inherit)`：
  // token 一旦不生效就是纯白底配继承来的浅色字 —— 正是用户报的「看不清」。
  // 系统色（Canvas / CanvasText / GrayText / LinkText）跟随 color-scheme，
  // 前景背景天然成对，不会出现这种错配。
  const inheritFallbacks = findLines(/var\(--dsw-alias-[a-z0-9-]+, inherit\)/)
  assert.equal(
    inheritFallbacks.length, 0,
    `第 ${inheritFallbacks[0]?.line} 行把兜底写成了 inherit —— 与写死的背景色不配对。`,
  )
  for (const [token, system] of [
    ['label-primary', 'CanvasText'],
    ['label-tertiary', 'GrayText'],
    ['state-business-primary', 'LinkText'],
    ['bg-layer-1', 'Canvas'],
  ]) {
    assert.match(
      source,
      new RegExp(`var\\(--dsw-alias-${token}, ${system}\\)`),
      `--dsw-alias-${token} 的兜底应当是系统色 ${system}`,
    )
  }
})

test('填充色写死且与文字成对', () => {
  // `--dsw-alias-brand-primary`（以及 button-primary-fill）在深色主题下取的是
  // bluish-50，也就是**浅色** —— 拿它铺按钮背景就成了浅底白字。填充色一律用
  // 写死的中蓝，配白字对比度 5.5:1。
  assert.match(source, /const FILL = '#[0-9a-f]{6}'/, 'FILL 应当是一个写死的实色')
  const fillUse = findLines(/\$\{FILL\}/)
  assert.ok(fillUse.length >= 3, `FILL 至少应用在三处（按钮底/选中态/强调色），实际 ${fillUse.length}`)
  // 每个用 FILL 当背景的地方都要配一个明确的文字色，不能听任继承。
  for (const line of findLines(/background: \$\{FILL\}/)) {
    assert.match(line.text, /color: (#fff|var\(--)/,
      `第 ${line.line} 行用 FILL 当背景却没在同一条规则里指定文字色，会依赖继承。`)
  }
})

test('显式定义 ::selection', () => {
  // dsh 自身没有 ::selection 规则（已从真实 bundle 确认），浏览器默认高亮在这套
  // 外壳里偏淡。用系统色 Highlight / HighlightText，它们成对且跟随 color-scheme。
  assert.match(source, /\.dsh-rc-panel::selection/, '缺少面板自身的 ::selection 规则')
  assert.match(source, /\.dsh-rc-panel ::selection/, '缺少面板内元素的 ::selection 规则')
  assert.match(source, /HighlightText/, '::selection 应当使用系统的 HighlightText')
})

test('草稿更新不把副作用写进 setState 更新器', () => {
  // `setDraft(previous => { preview(next); return next })` 在严格模式下会被调用
  // 两次（等于多发一次试算请求），连续两次改动还会读到同一个过期的 previous。
  const hits = findLines(/setDraft\(\s*previous\s*=>/)
  assert.equal(
    hits.length, 0,
    `第 ${hits[0]?.line} 行把副作用写进了 setDraft 更新器；请改用 applyDraft() 与 draftRef。`,
  )
  assert.match(source, /const applyDraft = useCallback/, 'applyDraft 应当是稳定引用')
})
