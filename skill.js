/**
 * retirement-calc 内嵌的技能：`retirement-planner`。
 *
 * 插件挂载时会通过 `ctx.skills.register()` 注册它，所以模型立刻就有这套口径；
 * 同一份正文也会被写到 `skills/retirement-planner/SKILL.md`，供使用文件系统
 * 技能根（`~/.agents/skills`、`~/.claude/skills`、项目 `.dsh/skills`）的部署使用。
 *
 * 本模块是唯一事实来源：`test/skill.test.js` 断言检入的 SKILL.md 与
 * {@link skillMarkdown} 逐字节一致，两条分发路径因此不会各自漂移。
 *
 * @module retirement-calc/skill
 */

/** 技能名，kebab-case，且必须等于它所在目录名。 */
export const SKILL_NAME = 'retirement-planner'

/** 技能目录里展示给模型的路由描述。 */
export const SKILL_DESCRIPTION = 'China statutory retirement planning: work out when someone may retire under the 2025 phased-delay reform, how many days away that is, and what monthly pension to expect — plus how contribution years, contribution index, and retirement timing move the number.'

/** 额外的路由提示：把触发条件和工具绑在一起。 */
export const SKILL_WHEN_TO_USE = 'Use when the user asks when they can retire, how many days until retirement, how much pension they will get, whether to contribute more years or retire later, or mentions 退休 / 养老金 / 社保 / 缴费年限 / 延迟退休 / 计发基数 / 个人账户. Requires the retirement-calc plugin tools (retirement_plan, retirement_profile, retirement_compare).'

/**
 * 技能正文，Markdown，不含 frontmatter。
 * @returns {string} 指令正文。
 */
export function skillBody() {
  return `# 退休养老测算

你要用 \`retirement-calc\` 插件的三个工具，回答"我什么时候能退休、能领多少"。
**核心原则：数字必须来自工具调用，规则必须说清，假设必须标注。**

## 工具

| 工具 | 什么时候用 |
| --- | --- |
| \`retirement_plan\` | 任何"什么时候退休 / 能领多少 / 还差几年"的问题。默认读已存档案，传参可临时覆盖 |
| \`retirement_profile\` | 读、改、清空用户的参保档案。用户报了个人信息就 \`set\` 存下来 |
| \`retirement_compare\` | 用户问"多缴几年会怎样""延后退休划不划算"时做情景对比 |

## 绝对不要凭记忆报数字

延迟退休的档位表和最低缴费年限的爬坡表都是**精确规则**，凭印象回答十次错八次：

- 法定退休年龄：自 2025-01-01 起，原 60 周岁的男职工每 4 个月延迟 1 个月至 **63 周岁**；
  原 55 周岁的女职工每 4 个月延迟 1 个月至 **58 周岁**；原 50 周岁的女职工每 2 个月
  延迟 1 个月至 **55 周岁**。
- 最低缴费年限：2029 年及以前退休仍是 **15 年**；自 2030 年起每年提高 6 个月，
  2039 年及以后为 **20 年**。
- 计发月数：按办理退休时的**满周岁**年龄查表，60 岁 139、63 岁 117、55 岁 170、50 岁 195。

直接调 \`retirement_plan\`，别自己算。

## 收集信息

最少需要四项就能出结果，缺的可以先用默认值算再回问：

1. **出生年月**（只要年月，不需要日）
2. **人群类别** —— 这是最容易问错的一项，务必确认：
   - \`male\` 男职工（原 60 岁）
   - \`female55\` 女职工·管理技术岗 / 女干部（原 55 岁）
   - \`female50\` 女职工·工人岗（原 50 岁）
3. **参保地** —— 决定计发基数。用户没说就用自己的省份默认值，并在回复里点出来。
4. **缴费情况** —— 已缴多少年、按什么档次缴（\`paid_index\`，0.6 表示 60% 档）、
   个人账户余额多少（支付宝 → 市民中心 → 社保查询 → 个人权益单）。

可选：计划继续缴多少年（\`future_months\`）、未来档次（\`future_index\`）、
视同缴费年限（\`deemed_months\`，统账结合前的工龄，有就一定要问）。

## 用户的参保信息要存下来

用户报过的信息调用 \`retirement_profile\` 的 \`set\` 写进档案，下次就不用再问。
写之前先说一句"我记一下"，别默默存。用户说"别记"就只做当次试算。

## 回答的写法

一个完整的回复包含四块，缺一不可：

1. **结论先行** —— 退休年月、退休年龄、距今天数、预计月养老金。
2. **构成** —— 基础养老金 + 个人账户养老金（+ 过渡性养老金）分别是多少。
3. **口径** —— 法定退休年龄是多少、延迟了几个月、最低缴费年限要求多少、是否满足。
4. **假设** —— 计发基数年增长率、个人账户记账利率用的是多少，并说明这是假设值。

用 \`retirement_plan\` 返回的 \`report\` 字段直接展示结论，不要自己重排数字。
价格/金额一律带 ￥ 和千分位。

## 情景分析的用法

用户问"怎么才能多领点"时调 \`retirement_compare\`，传入情景映射：

\`\`\`json
{
  "scenarios": {
    "多缴 5 年": { "future_months": 360 },
    "档次提到 100%": { "future_index": 1.0 },
    "延后 3 年退休": { "delay_months": 36 }
  }
}
\`\`\`

拿到表格后**给出判断**，不要只甩数字：缴费年限的边际收益通常最稳，
提高档次在指数已经较高时收益递减，延后退休同时增加缴费年限又缩小计发月数、
但对身体状况有前提。

## 边界

- 算出来的是**估算**，不是承诺。计发基数、记账利率、缴费基数上下限每年由各省
  重新公布，工具里的增长率是假设。每份结果后面都要带这句。
- 不提供投资建议、不推荐具体的商业养老保险产品、不评价社保制度好坏。
- 视同缴费年限、过渡性养老金的地方差异极大（过渡系数 1.0%–1.4%），
  涉及这类情形要提示用户以当地社保经办机构核定为准。
- 用户表现出对退休的焦虑时，正常回应，不放大也不敷衍；把重点放在"哪些变量
  是你还能改变的"。
- 省份显示为 \`manual\`（未收录计发基数）时，明确告诉用户当前用的是兜底值，
  请他去当地人社厅官网核对。

## 快速示例

用户：我 1990 年 1 月生的，男的，在广东，现在养老金账户 6 万，什么时候能退休？
→ 调 \`retirement_profile\` \`{ action: "set", fields: { birth_year: 1990, birth_month: 1, category: "male", province: "guangdong", account_balance: 60000 } }\`
→ 调 \`retirement_plan\`
→ 回："2053 年 1 月满 63 周岁退休，距今 9,59x 天，预计月养老金约 ￥x,xxx
（基础 ￥x,xxx + 个人账户 ￥x,xxx）。按广东 2025 年计发基数 9,493 元和 2% 年增长推算，
属假设值。要不要看看多缴几年能多领多少？"

用户：多缴 5 年能多领多少？
→ 调 \`retirement_compare\` \`{ scenarios: { "多缴 5 年": { "future_months": 360 } } }\`
→ 回对比结论 + 一句判断，不甩原始表格。
`
}

/**
 * 完整的 SKILL.md 内容：YAML frontmatter 加正文。
 * @returns {string} Markdown 文档，以换行结尾。
 */
export function skillMarkdown() {
  const frontmatter = [
    '---',
    `name: ${SKILL_NAME}`,
    `description: ${SKILL_DESCRIPTION}`,
    `whenToUse: ${SKILL_WHEN_TO_USE}`,
    '---',
  ].join('\n')
  // frontmatter 与正文之间空一行，与其他技能文件的写法保持一致。
  return `${frontmatter}\n\n${skillBody()}`
}
