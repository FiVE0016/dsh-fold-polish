// 真实浏览器验证：probeNatural 在真实布局下能否量到正确高度。
//
// 为什么要这个脚本：runtime.test.mjs 用的 fake DOM 不产出布局，
// probeNatural 在它上面直接返回 null、走 fallback，所以原有 155 个测试
// 完全覆盖不到「克隆测量」这条路径。2026-10-13 就因此漏掉一个真 bug——
// 测量容器 width:0 + contain:'strict' 让量出的高度完全失真，
// assistant 长文本不再折叠，而所有测试依然全绿。
//
// 这个脚本把真实的折叠几何搬进 headless Chrome，直接验证：
//   1. 克隆量到的自然高度 == 解除限制后真实节点的 scrollHeight
//   2. 克隆宽度 == 真实节点宽度
//   3. **下刀位置落在行数预算之内**，且 overflows 判定与真实内容相符
//      （2026-10-13 补：此前只比高度，漏掉了「下刀位置取到内容总高导致
//       overflows 恒假、胶囊按钮全部消失」这个回归）
//   4. 测量过程不让真实节点产生任何几何变化（这是根治的核心承诺）
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9330
const USER_DATA = path.join(here, '_chrome-probe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let socket = null
let nextId = 1
const pending = new Map()
const connect = async (url) => {
  socket = new WebSocket(url)
  await new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true })
    socket.addEventListener('error', rej, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' — ' + detail}`)
}

// 页面里注入的探针：与 src/browser.js 的 probeNatural 同一套判据
const PAGE = `
<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 14px/22px system-ui, sans-serif; }
  .msg { width: 640px; padding: 8px 12px; }
  /* 与插件真实写法一致：属性选择器 + !important，不是 class */
  [data-lf-clamped="1"] { max-height: 88px !important; overflow: hidden !important; padding-bottom: 0 !important; }
</style></head><body>
<div class="msg" id="long">${'这是第 X 行用于验证折叠效果的长文本内容，长度足够产生换行与高度。'.repeat(40)}</div>
<div class="msg" id="short">很短的一条。</div>
<script>
window.__probe = function probeNatural(body, budgetLines) {
  const doc = document
  let host = doc.querySelector('[data-lf-measure-host]')
  if (!host) {
    host = doc.createElement('div')
    host.setAttribute('data-lf-measure-host', '')
    host.style.position = 'fixed'
    host.style.left = '-99999px'
    host.style.top = '0'
    host.style.width = '100vw'
    host.style.height = 'auto'
    host.style.overflow = 'visible'
    host.style.visibility = 'hidden'
    host.style.pointerEvents = 'none'
    host.style.zIndex = '-1'
    ;(doc.body ?? doc.documentElement).appendChild(host)
  }
  const clone = body.cloneNode(true)
  clone.removeAttribute('data-lf-clamped')
  clone.removeAttribute('data-lf-open')
  for (const cls of [...clone.classList]) { if (cls.startsWith('lf-')) clone.classList.remove(cls) }
  for (const p of ['max-height','min-height','height','padding-bottom','overflow','contain']) {
    clone.style.removeProperty(p)
  }
  const realStyle = getComputedStyle(body)
  const realBox = body.getBoundingClientRect()
  const styleWidth = parseFloat(realStyle.width)
  const width = (isFinite(styleWidth) && styleWidth > 0) ? styleWidth : (realBox.width > 0 ? realBox.width : 0)
  clone.style.width = width > 0 ? width + 'px' : (realStyle.width || 'auto')
  clone.style.boxSizing = realStyle.boxSizing || 'content-box'
  clone.style.paddingLeft = realStyle.paddingLeft
  clone.style.paddingRight = realStyle.paddingRight
  clone.style.paddingTop = realStyle.paddingTop
  clone.style.margin = '0'
  clone.style.position = 'static'
  clone.style.visibility = 'hidden'
  host.appendChild(clone)
  let out = null
  try {
    const style = getComputedStyle(clone)
    const box = clone.getBoundingClientRect()
    if (!(box.width > 0) || !(box.height > 0)) return null
    const padTop = parseFloat(style.paddingTop) || 0
    const padBottom = parseFloat(style.paddingBottom) || 0
    const lineHeight = parseFloat(style.lineHeight) || 22
    const budget = Math.round((Number(budgetLines) || 0) * lineHeight)
    const origin = box.top + (clone.clientTop || 0) + padTop
    // 与 src/browser.js 的 probeNatural 同一判据：下刀位置只接受「预算之内」
    // 的行底部，取其中最大者。缺了这层过滤就会取到内容总高，overflows 恒假。
    const pick = (ends) => {
      let cut = 0
      for (const end of ends) {
        if (end <= 0) continue
        if (end > budget) continue
        if (cut === 0 || end > cut) cut = end
      }
      return cut
    }
    let cut = 0
    try {
      const range = doc.createRange()
      range.selectNodeContents(clone)
      const rects = range.getClientRects()
      const ends = []
      for (let i = 0; i < rects.length; i += 1) ends.push(rects[i].bottom - origin)
      cut = pick(ends)
    } catch { cut = 0 }
    const natural = clone.scrollHeight
    if (!(natural > 0)) return null
    // 与源码同一换算：cutHeight 是按 box-sizing 得到的 max-height 值；
    // overflows 的比较必须同量纲（natural 含 padding，content-box 下 cutHeight 不含）。
    const boxSizing = style.boxSizing || 'content-box'
    const cutHeight = cut > 0 ? Math.round(boxSizing === 'border-box' ? cut + padTop + padBottom : cut) : 0
    const cutBoxHeight = cutHeight + (boxSizing === 'border-box' ? 0 : padTop + padBottom)
    out = {
      natural,
      offset: clone.offsetHeight,
      rect: box.height,
      cutHeight,
      lineHeight,
      width: box.width,
      budget,
      overflows: natural > cutBoxHeight + 8
    }
  } finally {
    if (clone.parentNode) clone.parentNode.removeChild(clone)
  }
  return out
}
window.__truth = function truth(body) {
  // 真值必须在完全无限制下量：.clamped 会强制 max-height 与 padding-bottom:0，
  // 带着它量出来的数本身就偏低，那是夹具误差，不是被测对象的误差。
  const had = body.getAttribute('data-lf-clamped') === '1'
  body.removeAttribute('data-lf-clamped')
  const natural = body.scrollHeight
  const offset = body.offsetHeight
  const rect = body.getBoundingClientRect().height
  if (had) body.setAttribute('data-lf-clamped', '1')
  return { natural, offset, rect }
}
</script></body></html>
`

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1000', 'about:blank'
], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 40 && !target; i += 1) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    target = list.find((t) => t.type === 'page')
  } catch { /* chrome 还没起来 */ }
}
if (!target) { console.error('chrome 未就绪'); chrome.kill(); process.exit(2) }

await connect(target.webSocketDebuggerUrl)
await send('Page.enable')
await send('Page.navigate', { url: 'about:blank' })
await sleep(300)
await evaluate(`document.write(${JSON.stringify(PAGE)}); document.close();`)
await sleep(400)

console.log('真实浏览器下的克隆测量')

// 先给长文本加上钳制，模拟「已被折叠」的真实状态
await evaluate(`document.getElementById('long').setAttribute('data-lf-clamped', '1')`)

const r = await evaluate(`(function () {
  const long = document.getElementById('long')
  const short = document.getElementById('short')
  const p1 = window.__probe(long, 10)
  const t1 = window.__truth(long)
  const p2 = window.__probe(short, 10)
  const t2 = window.__truth(short)
  return { p1, t1, p2, t2, rectW: long.getBoundingClientRect().width }
})()`)

console.log('  长文本 克隆: scrollHeight=%d offsetHeight=%d rect=%d', r.p1 && r.p1.natural, r.p1 && r.p1.offset, r.p1 && r.p1.rect)
console.log('  长文本 真实: scrollHeight=%d offsetHeight=%d rect=%d', r.t1.natural, r.t1.offset, r.t1.rect)
console.log('  长文本 下刀: cutHeight=%d 预算=%d overflows=%s', r.p1 && r.p1.cutHeight, r.p1 && r.p1.budget, r.p1 && r.p1.overflows)
console.log('  短文本 克隆: scrollHeight=%d  真实: scrollHeight=%d  overflows=%s', r.p2 && r.p2.natural, r.t2.natural, r.p2 && r.p2.overflows)
console.log('  克隆宽度 =', r.p1 && r.p1.width, ' 真实宽度 =', r.rectW)

check('长文本克隆量到非零高度（container width:0 / contain:strict 会让它为 0 或失真）',
  r.p1 !== null && r.p1.natural > 0, r.p1 === null ? 'probeNatural 返回 null' : undefined)
check('长文本克隆高度 == 真实 scrollHeight',
  r.p1 !== null && Math.abs(r.p1.natural - r.t1.natural) <= 2, r.p1 ? `clone=${r.p1.natural} truth=${r.t1.natural}` : 'null')
check('短文本克隆高度 == 真实 scrollHeight',
  r.p2 !== null && Math.abs(r.p2.natural - r.t2.natural) <= 2, r.p2 ? `clone=${r.p2.natural} truth=${r.t2.natural}` : 'null')
check('克隆宽度与真实节点一致（否则换行不同、高度无意义）',
  r.p1 !== null && Math.abs(r.p1.width - r.rectW) <= 1, r.p1 ? `clone=${r.p1.width} real=${r.rectW}` : 'null')
check('短文本也能量到', r.p2 !== null && r.p2.natural > 0)
// 2026-10-13 回归守卫：下刀位置必须落在预算之内。此前 pick 取「所有行的
// 最底部」（= 内容总高），于是 overflows = natural > cutHeight + 8 恒为假，
// 凡是走克隆测量的消息都丢按钮、不折叠；上面几项检查全都察觉不到。
check('长文本下刀位置落在预算之内且非零（「还有 N 行」与按钮的判定依据）',
  r.p1 !== null && r.p1.cutHeight > 0 && r.p1.cutHeight <= r.p1.budget,
  r.p1 ? `cut=${r.p1.cutHeight} budget=${r.p1.budget}` : 'null')
check('长文本判定为需要折叠（overflows 为真，胶囊按钮才会出现）',
  r.p1 !== null && r.p1.overflows === true, r.p1 ? String(r.p1.overflows) : 'null')
check('短文本判定为不需要折叠（overflows 为假）',
  r.p2 !== null && r.p2.overflows === false, r.p2 ? String(r.p2.overflows) : 'null')

// 核心承诺：测量不扰动真实节点
const perturb = await evaluate(`(function () {
  const long = document.getElementById('long')
  const before = { h: long.getBoundingClientRect().height, sh: long.scrollHeight, cls: long.className }
  window.__probe(long, 10)
  window.__probe(long, 10)
  const after = { h: long.getBoundingClientRect().height, sh: long.scrollHeight, cls: long.className }
  return { before, after }
})()`)
check('测量两次后真实节点几何零变化',
  perturb.before.h === perturb.after.h && perturb.before.sh === perturb.after.sh && perturb.before.cls === perturb.after.cls,
  JSON.stringify(perturb))

// 测量容器不应残留在可视区域
const leftover = await evaluate(`(function () {
  const host = document.querySelector('[data-lf-measure-host]')
  const clones = document.querySelectorAll('[data-lf-measure-host] > *')
  return { hostCount: document.querySelectorAll('[data-lf-measure-host]').length, cloneCount: clones.length, hostLeft: host ? host.style.left : null }
})()`)
check('测量容器唯一且克隆已清理', leftover.hostCount === 1 && leftover.cloneCount === 0, JSON.stringify(leftover))

socket.close()
chrome.kill()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
