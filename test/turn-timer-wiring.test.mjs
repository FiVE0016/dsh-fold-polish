// Guards the per-turn timer's HOST wiring. These exist because the feature
// silently degraded once already: the tests passed while the chip never
// appeared, because a missing service only produced a console warning that
// nothing asserted on.
//
// The two failure modes this file pins down:
//   1. `inject` omits uiConversation/sessions → the restricted ctx hands back
//      null and the probe can never see a session.
//   2. The probe depends on props the host may not inject (useSessions).
//      It must read the session from the ctx instead.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error.message}`)
  }
}

const entry = readFileSync(path.join(root, 'src', 'client-entry.js'), 'utf8')
const built = readFileSync(path.join(root, 'client.js'), 'utf8')

test('inject declares every service the per-turn probe reads', () => {
  const match = entry.match(/inject:\s*\[([^\]]*)\]/)
  assert.ok(match, 'no inject declaration found')
  const declared = match[1].split(',').map((s) => s.trim().replace(/['"]/g, ''))
  for (const service of ['slots', 'uiConversation', 'sessions']) {
    assert.ok(declared.includes(service), `inject 缺少 ${service}（探针会静默降级）: ${JSON.stringify(declared)}`)
  }
})

test('the probe never depends on host-injected props (uses ctx.get instead)', () => {
  // The earlier version read props.useSessions from a shell.overlay component.
  // That is not guaranteed, and it is what made the chip a no-op in the app.
  assert.equal(/props\.useSessions/.test(entry), false, '探针仍在依赖 props.useSessions（宿主不保证注入）')
  assert.ok(/ctx\s*\?\.\s*get\s*\?\.\s*\(\s*'sessions'\s*\)/.test(entry), '探针没有从 ctx 取 sessions')
  assert.ok(/ctx\s*\?\.\s*get\s*\?\.\s*\(\s*'uiConversation'\s*\)/.test(entry), '探针没有从 ctx 取 uiConversation')
})

test('the probe still uses the verified binding/target/getSnapshot route', () => {
  assert.ok(/conv\.binding\(/.test(entry), '缺少 binding()')
  assert.ok(/\.target\('chat'\)/.test(entry), "缺少 target('chat')")
  assert.ok(/getSnapshot/.test(entry), '缺少 getSnapshot')
  assert.ok(/legacy\?\.nodes|legacy\.nodes/.test(entry), '缺少 legacy.nodes 读取')
})

test('turn durations come from the pure module (no duplicated timing math)', () => {
  assert.ok(/turnTimer\.turnDurations\(/.test(entry), '入口没有复用 turn-timer.js 的 turnDurations')
})

test('the built bundle carries the new wiring (client.js is in sync)', () => {
  assert.ok(built.includes("target('chat')"), 'client.js 未包含 target(chat) —— 忘记 rebuild')
  assert.ok(built.includes("'uiConversation'"), 'client.js 未声明 uiConversation —— 忘记 rebuild')
  assert.ok(built.includes("'sessions'"), 'client.js 未声明 sessions —— 忘记 rebuild')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
