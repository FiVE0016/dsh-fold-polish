#!/usr/bin/env node
// 老 bug 回归检查 —— 把 docs/回归检查清单.md 里每一条防线变成可执行的断言。
//
// 用法：node scripts/regression-check.mjs [--fast]
//   --fast  跳过需要无头 Chrome 的真实浏览器专项（其余检查照跑）
//
// 这个脚本的存在理由：这个插件的 bug 是**反复复发**的，而且多次是"代码看着对、
// 测试全绿、真机却坏"。清单写在文档里靠自觉，写成断言才拦得住。

import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fast = process.argv.includes('--fast')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n${title}`)

const read = (rel) => {
  try { return readFileSync(path.join(root, rel), 'utf8') } catch { return null }
}

const entry = read('src/client-entry.js') ?? ''
const browser = read('src/browser.js') ?? ''
const fold = read('src/fold.js') ?? ''

const runTests = (rel) => {
  const res = spawnSync(process.execPath, [rel], { cwd: root, encoding: 'utf8' })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const line = out.trim().split('\n').filter(Boolean).pop() ?? '(无输出)'
  return { ok: res.status === 0, line, out }
}

// ---------------------------------------------------------------- 构建与源码同步
section('构建与源码同步（防「改了 src 没重建 client.js」）')
{
  const res = spawnSync(process.execPath, ['scripts/build.mjs', '--check'], { cwd: root, encoding: 'utf8' })
  check('client.js 与 src/ 同步', res.status === 0, (res.stdout ?? '').trim() || (res.stderr ?? '').trim())
}

// ---------------------------------------------------------------- 右栏收起后回弹
section('右栏收起后主区必须回弹（0.9.5 修 → 2026-10-13 复发）')
{
  check('规则选择器自带「收起即失效」',
    /:not\(\[data-rightbar-collapsed\]\)/.test(entry) && /:not\(\[data-rightbar-fullscreen\]\)/.test(entry),
    '缺了它，宿主收起后那条 !important 会一直占着第三列')
  check('观察者盯整棵文档（框架可能被宿主整个换掉）',
    /observer\.observe\(root, \{[\s\S]{0,200}subtree: true/.test(entry))
  check('另有一个观察者盯框架的直接子节点',
    /childObserver\.observe\(frame, \{ childList: true \}\)/.test(entry))
  check('几何自检存在（右栏内容消失也能撤规则）',
    /rightPanelStillThere/.test(entry) && /idleChecks >= 2/.test(entry))
  check('总开关关闭 / dispose 都会撤规则',
    /clearOverride\(\)/.test(entry) && (entry.match(/clearOverride\(\)/g) ?? []).length >= 4)
  const res = runTests('test/entry.test.mjs')
  check('entry 测试（含三条右栏回归）', res.ok, res.line)
}

// ---------------------------------------------------------------- 测量与折叠判定
section('折叠测量（2026-10-13：下刀位置丢掉预算 → 胶囊键消失）')
{
  check('probeNatural 接收保留行数',
    /function probeNatural\(body, budgetLines\)/.test(browser))
  check('下刀位置只接受预算之内的行底部',
    /if \(end > budget\) continue/.test(browser))
  check('降级路径与克隆路径同判据（都带预算）',
    /cutHeightForBody\(body, contentBudget\)/.test(browser))
  check('降级路径补齐同字段集（量纲一致）',
    /padTop: Number\.parseFloat\(style\.paddingTop\)/.test(browser) &&
    /boxSizing: style\.boxSizing/.test(browser))
  check('overflows 两侧同量纲（补回内边距）',
    /cutBoxHeight/.test(browser))
  check('测量走屏幕外克隆，真实节点不被解除限制',
    /function measureHostOf/.test(browser) && /data-lf-measure-host/.test(browser))

  const res = runTests('test/fold.test.mjs')
  check('fold 纯逻辑测试', res.ok, res.line)
  const res2 = runTests('test/runtime.test.mjs')
  check('runtime 运行时测试', res2.ok, res2.line)

  if (fast) {
    console.log('  SKIP  真实浏览器专项（--fast）')
  } else if (!existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')) {
    console.log('  SKIP  真实浏览器专项（本机没找到 Chrome）')
  } else {
    const res3 = runTests('test/probe-natural-browser.mjs')
    check('真实浏览器专项（下刀位置/overflows 的守卫）', res3.ok, res3.line)
  }
}

// ---------------------------------------------------------------- 跳过判定
section('消息行跳过判定（2026-10-13：宿主把回复包进过程容器 → 回复被整体跳过）')
{
  check('标记表已拆成「容器类 / 标记类」',
    /SKIP_CONTAINERS/.test(browser) && /SKIP_MARKERS/.test(browser))
  check('消息行（user / assistant）不再被过程容器跳过',
    /if \(kind === KIND_USER \|\| kind === KIND_ASSISTANT\) return anchor\.closest\(SKIP_MARKERS\)/.test(browser))
  check('探针计数器仍在（side / probe，排障入口）',
    /assistantSeen/.test(browser) && /cloneNullWhy/.test(browser))
}

// ---------------------------------------------------------------- 启动安全
section('启动安全（插件属启动图，抛错会让整个 DSH 起不来）')
{
  check('受限 ctx 只用 ctx.get，不用属性访问服务',
    !/ctx\.(sidebarRightTabs|uiConversation|layout)\b(?!\s*=\s*ctx\.get)/.test(entry) || /ctx\.get\(/.test(entry))
  check('apply 外层有兜底 try/catch',
    /try \{\s*\n\s*const controller = browser\.start/.test(entry) || /catch \(error\)/.test(entry))
  const res = runTests('test/entry.test.mjs')
  check('entry 测试（含敌意 ctx / 无快捷键 / CSS 作用域三个守卫）', res.ok, res.line)
}

// ---------------------------------------------------------------- 其它不变量
section('其它已修不变量')
{
  const rootAttr = /export const ROOT_ATTRIBUTE = '([^']+)'/.exec(fold)?.[1]
  const rootSelectors = [...new Set([...browser.matchAll(/:root\[(data-[a-z-]+)\]/g)].map((m) => m[1]))]
  check('CSS 的 :root[...] 与 ROOT_ATTRIBUTE 一致',
    rootAttr && rootSelectors.length > 0 && rootSelectors.every((sel) => sel === rootAttr),
    `ROOT_ATTRIBUTE=${rootAttr} 选择器=${rootSelectors.join(',')}`)
  check('折叠盒是纯裁切，不是滚动容器（滚轮不该展开它）',
    /\[data-lf-clamped="1"\] \{[\s\S]{0,400}?overflow: hidden !important/.test(browser))
  // Esc 关闭弹窗是允许的（弹窗的标准模式，且只在面板打开时生效）；
  // 禁止的是任何组合键。
  const keydownBody = /function onKeydown\(event\)\s*\{([\s\S]*?)\n  \}/.exec(browser)?.[1] ?? ''
  check('按键处理只认 Esc，没有任何组合键',
    /event\.key === 'Escape'/.test(keydownBody) && !/(ctrlKey|shiftKey|altKey|metaKey)/.test(keydownBody),
    keydownBody ? 'onKeydown 只处理 Escape 关闭弹窗' : '找不到 onKeydown 实现')
  check('图片不吃行数预算（mediaHeight 单独计入）',
    /mediaHeight/.test(browser))

  const wiring = runTests('test/turn-timer-wiring.test.mjs')
  check('turn-timer 数据链（构建注册表自动生成）', wiring.ok, wiring.line)
  const tt = runTests('test/turn-timer.test.mjs')
  check('turn-timer 纯逻辑', tt.ok, tt.line)

  const indexSrc = read('index.js')
  check('index.js 存在且是可解析的 ESM 入口', !!indexSrc && /export const name/.test(indexSrc))
}

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('\n失败的检查（对应 docs/回归检查清单.md 的哪一条，去那儿看根因与防线）：')
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
}
process.exit(failed.length ? 1 : 0)
