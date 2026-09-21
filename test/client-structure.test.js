/**
 * `client.js` 的结构约束测试。
 *
 * 这些不是行为测试，而是把踩过的坑钉成可执行的规则。客户端这一半跑在宿主浏览器里，
 * 既没有单元测试的着力点，也不方便端到端断言（面板要先点开才存在），于是最容易
 * 「改一行、看起来没事、实际坏掉体验」。所以用源码层面的断言守住四条底线：
 *
 * 1. 编辑控件必须定义在模块级。
 * 2. 填充色不得使用无法核实的主题 token。
 * 3. 前景与背景的兜底值必须成对。
 * 4. 必须显式定义 `::selection`。
 *
 * 第 1 条的机制已用真实 React 18.3.1 + jsdom 复现过：控件定义在组件内部时，
 * 父组件每次重渲染都会因函数引用变化而卸载重建子树 —— 输入框 DOM 节点被替换，
 * 焦点随之丢失，表现就是「输入一个字符就要重新点一次」。定义在模块级则节点复用、
 * 焦点保持。
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
 * 取匹配某模式的行号（从 1 开始），便于报错时定位。
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

test('编辑控件定义在模块级，而不是组件内部', () => {
  // 这条是「输入一次就要重新点一次」那个缺陷的守门人。
  for (const component of ['NumberField', 'Slider', 'MonthYear']) {
    const definitions = findLines(new RegExp(`const ${component} = `))
    assert.equal(definitions.length, 1, `${component} 应当恰好定义一次，实际 ${definitions.length} 次`)
    const { line, text } = definitions[0]
    // 模块级定义在 4 空格缩进上（位于 factory 闭包内、createPanel 之外）；
    // 组件内部会是 8 空格。
    assert.ok(
      text.startsWith(`const ${component} = `),
      `${component} 的定义在第 ${line} 行，但前面有多余缩进（${text.slice(0, 40)}…）——`
      + '它很可能又被挪进组件体内了，那会让每次重渲染都重建子树并丢失输入焦点。',
    )
  }

  // 反向确认：组件体内（8 空格缩进）不应再出现这三个名字的定义。
  for (const component of ['NumberField', 'Slider', 'MonthYear']) {
    const nested = findLines(new RegExp(`^ {8}const ${component} = `))
    assert.equal(nested.length, 0, `${component} 第 ${nested[0]?.line} 行被定义在了组件内部`)
  }
})

test('填充色不使用无法核实的主题 token', () => {
  // `--dsw-alias-brand-text` 在 harness 源码与已安装的构建产物里都搜不到定义。
  // 名字听起来像「品牌色的文字色」，拿它当背景填充，一旦 token 取到浅色就是
  // 白底白字。填充色因此写死为 #3055d6，宁可少一点主题适配。
  const hits = findLines(/dsw-alias-brand-text/)
  assert.equal(
    hits.length, 0,
    `第 ${hits[0]?.line} 行仍在使用不可核实的 --dsw-alias-brand-text；`
    + '填充色请直接用 #3055d6，理由见 STYLE 顶部的注释。',
  )
})

test('前景色的兜底不得是 inherit', () => {
  // 曾经写成 `background: var(--…, #fff)` 配 `color: var(--…, inherit)`：
  // token 一旦不生效就成了纯白底配继承来的浅色字。两者必须兜到同一套配色。
  const hits = findLines(/var\(--dsw-alias-text-primary, inherit\)/)
  assert.equal(
    hits.length, 0,
    `第 ${hits[0]?.line} 行把兜底写成了 inherit —— token 失效时会出现白底浅字。`,
  )
  // 兜底应当落在浅色主题的正文色上，与面板背景的 #fff 兜底成对。
  assert.match(source, /var\(--dsw-alias-text-primary, #101828\)/, '前景兜底应为 #101828')
  assert.match(source, /background: var\(--dsw-alias-bg-layer-1, #fff\)/, '面板背景兜底应为 #fff')
})

test('显式定义 ::selection', () => {
  // dsh 自身没有任何 ::selection 规则（源码与已安装产物里都搜过），浏览器默认高亮
  // 在这套外壳里偏淡，选中面板里的数字时几乎看不出选了什么。
  assert.match(source, /\.dsh-rc-panel::selection/, '缺少面板自身的 ::selection 规则')
  assert.match(source, /\.dsh-rc-panel ::selection/, '缺少面板内元素的 ::selection 规则')
})

test('草稿更新不把副作用写进 setState 更新器', () => {
  // `setDraft(previous => { preview(next); return next })` 这种写法在严格模式下会
  // 被调用两次（等于多发一次试算请求），连续两次改动还会读到同一个过期的 previous。
  const hits = findLines(/setDraft\(\s*previous\s*=>/)
  assert.equal(
    hits.length, 0,
    `第 ${hits[0]?.line} 行把副作用写进了 setDraft 更新器；请改用 applyDraft() 与 draftRef。`,
  )
  assert.match(source, /const applyDraft = useCallback/, 'applyDraft 应当是稳定引用')
})
