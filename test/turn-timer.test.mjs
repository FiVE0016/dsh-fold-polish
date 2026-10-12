// Plain-Node checks for the per-turn duration logic. No framework, no DOM:
// run with `node test/turn-timer.test.mjs`.
import assert from 'node:assert/strict'
import { createTurnTimerStore, formatDuration, turnDurations } from '../src/turn-timer.js'

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

// ---------------------------------------------------------------- formatDuration

test('sub-10s keeps one decimal', () => {
  assert.equal(formatDuration(3200), '3.2秒')
  assert.equal(formatDuration(999), '1.0秒')
})

test('10s–60s rounds to whole seconds', () => {
  assert.equal(formatDuration(42_000), '42秒')
  assert.equal(formatDuration(59_600), '60秒')
})

test('one minute and above reads as 分/秒', () => {
  assert.equal(formatDuration(72_000), '1分12秒')
  assert.equal(formatDuration(3_600_000), '60分0秒')
})

test('invalid input yields empty string', () => {
  assert.equal(formatDuration(Number.NaN), '')
  assert.equal(formatDuration(-5), '')
  assert.equal(formatDuration(undefined), '')
})

// ---------------------------------------------------------------- turnDurations

test('a single-step turn spans start → completion', () => {
  const nodes = [
    { kind: 'user', turn: 1 },
    { kind: 'assistant', turn: 1, step: 0, timing: { stepStartTime: 1000, firstTokenTime: 1200, completedTime: 4200 } }
  ]
  assert.deepEqual(turnDurations(nodes), { 1: 3200 })
})

test('a multi-step turn takes the FULL span (first start → last completion)', () => {
  const nodes = [
    { kind: 'assistant', turn: 5, step: 0, timing: { stepStartTime: 1000, completedTime: 3000 } },
    { kind: 'assistant', turn: 5, step: 1, timing: { stepStartTime: 5000, completedTime: 9000 } }
  ]
  // The gap between steps (a tool run) is part of "收到命令到完成输出".
  assert.deepEqual(turnDurations(nodes), { 5: 8000 })
})

test('out-of-order steps still widen the span', () => {
  const nodes = [
    { kind: 'assistant', turn: 2, step: 1, timing: { stepStartTime: 5000, completedTime: 9000 } },
    { kind: 'assistant', turn: 2, step: 0, timing: { stepStartTime: 1000, completedTime: 3000 } }
  ]
  assert.deepEqual(turnDurations(nodes), { 2: 8000 })
})

test('user nodes and missing/invalid timing are skipped', () => {
  const nodes = [
    { kind: 'user', turn: 3, timing: { stepStartTime: 0, completedTime: 9999 } },
    { kind: 'assistant', turn: 3, step: 0, timing: null },
    { kind: 'assistant', turn: 3, step: 1, timing: { stepStartTime: 1000, completedTime: null } },
    { kind: 'assistant', turn: 4, step: 0, timing: { stepStartTime: 5000, completedTime: 4000 } }
  ]
  assert.deepEqual(turnDurations(nodes), {})
})

test('garbage input yields an empty map', () => {
  assert.deepEqual(turnDurations(null), {})
  assert.deepEqual(turnDurations(undefined), {})
  assert.deepEqual(turnDurations('nope'), {})
})

// ---------------------------------------------------------------- store

test('store notifies subscribers and reports the latest map', () => {
  const store = createTurnTimerStore()
  const seen = []
  const off = store.subscribe((durations) => seen.push(durations))
  store.set({ 1: 100 })
  store.set({ 1: 100, 2: 200 })
  assert.deepEqual(store.get(), { 1: 100, 2: 200 })
  assert.equal(seen.length, 2)
  off()
  store.set({ 3: 300 })
  assert.equal(seen.length, 2)
})

test('a throwing listener does not break the rest', () => {
  const store = createTurnTimerStore()
  let reached = false
  store.subscribe(() => { throw new Error('boom') })
  store.subscribe(() => { reached = true })
  store.set({ 1: 1 })
  assert.equal(reached, true)
})

test('clear resets the map and notifies', () => {
  const store = createTurnTimerStore()
  let latest = null
  store.subscribe((durations) => { latest = durations })
  store.set({ 1: 5 })
  store.clear()
  assert.deepEqual(store.get(), {})
  assert.deepEqual(latest, {})
})

// ---------------------------------------------------------------- normalizeSettings

test('turnTimer survives normalizeSettings (default on, coercion works)', async () => {
  const { normalizeSettings } = await import('../src/fold.js')
  assert.equal(normalizeSettings({}).turnTimer, true)
  assert.equal(normalizeSettings({ turnTimer: false }).turnTimer, false)
  assert.equal(normalizeSettings({ turnTimer: 'nope' }).turnTimer, true)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
