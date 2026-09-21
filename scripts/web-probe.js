/**
 * 浏览器内运行的交互探针。
 *
 * 由 `scripts/verify-web.mjs` 注入到构建产物的末尾，模拟一串真实用户操作，
 * 把每个阶段的关键读数写进 `<pre id="__test">`，供驱动脚本解析。
 *
 * 两条必须遵守的时序约定：
 * 1. 重算是异步排队的（见 app.js 的 scheduleRefresh），所以每次改完输入要等一拍
 *    才能读结果。
 * 2. 大数字有 200ms 的过渡动画，等一拍还不够 —— 但真实值同时写在 `dataset.raw`
 *    上，读它就能绕开动画，不必靠加大等待时间来赌。
 */
(function () {
  var out = []
  var g = function (id) { return document.getElementById(id) }

  function snap(tag) {
    var grid = g('metricGrid').textContent
    return {
      tag: tag,
      days: g('daysValue').textContent,
      daysRaw: g('daysValue').dataset.raw,
      pensionRaw: g('pensionValue').dataset.raw,
      pensionShown: g('pensionValue').textContent,
      retire: (grid.match(/20\d\d年\d+月/) || [''])[0],
      minReq: (grid.match(/最低要求\s*(\S+)/) || ['', ''])[1],
      avgIndex: (grid.match(/平均缴费指数\s*([\d.]+)/) || ['', ''])[1],
      metrics: (g('metricGrid').querySelectorAll('.metric') || []).length,
      breakdownLines: g('breakdown').querySelectorAll('.line').length,
      sensRows: g('sensTable').querySelectorAll('tbody tr').length,
      statusText: g('statusCallout').textContent.slice(0, 30),
    }
  }

  function fire(el) { el.dispatchEvent(new Event('input', { bubbles: true })) }
  function set(id, v) {
    var el = g(id)
    if (!el) throw new Error('找不到 #' + id)
    el.value = v
    fire(el)
  }
  function pick(name, value) {
    var el = document.querySelector('input[name="' + name + '"][value="' + value + '"]')
    if (!el) throw new Error('找不到 radio ' + name + '=' + value)
    el.checked = true
    fire(el)
  }

  var stages = [
    ['初始状态', function () {}],
    ['弹性延后3年', function () { set('delayMonths', '36') }],
    ['取消延后', function () { set('delayMonths', '0') }],
    ['换到上海', function () { set('province', 'shanghai') }],
    ['改成女工人', function () { pick('category', 'female50') }],
    ['出生改1978年3月', function () { set('birthYear', '1978'); set('birthMonth', '3') }],
    ['填入示例缴费数据', function () {
      set('paidYears', '27'); set('paidMonthsExtra', '0')
      set('futureYears', '3'); set('futureMonthsExtra', '0')
      set('accountBalance', '114000')
      set('paidIndex', '0.8'); set('futureIndex', '0.6')
    }],
    ['档次提到1.5', function () { set('futureIndex', '1.5'); set('baseGrowthRate', '4') }],
    ['改回男职工广东', function () { pick('category', 'male'); set('province', 'guangdong') }],
    ['清空计发基数', function () { set('baseAmount', '') }],
    ['计发基数改 20000', function () { set('baseAmount', '20000') }],
  ]

  var i = 0
  function run() {
    if (i >= stages.length) {
      g('__test').textContent = JSON.stringify(out)
      return
    }
    var stage = stages[i]
    setTimeout(function () {
      try {
        stage[1]()
      } catch (error) {
        out.push({ tag: stage[0], error: String((error && error.message) || error) })
      }
      setTimeout(function () {
        out.push(snap(stage[0]))
        i += 1
        run()
      }, 120)
    }, 20)
  }

  setTimeout(run, 200)
})()
