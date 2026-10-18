import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createTurnTimerStore,
  formatDuration,
  turnDurations,
} from '../src/turn-timer.js'
const assistant = (turn, start, end) => ({
  kind: 'assistant',
  turn,
  timing: { stepStartTime: start, completedTime: end },
})

test('all durations keep seconds and one decimal with the required label', () => {
  assert.equal(formatDuration(0), '本轮用时 0.0 秒')
  assert.equal(formatDuration(999), '本轮用时 1.0 秒')
  assert.equal(formatDuration(42000), '本轮用时 42.0 秒')
  assert.equal(formatDuration(72000), '本轮用时 72.0 秒')
  for (const value of [undefined, null, '1000', -1, NaN, Infinity])
    assert.equal(formatDuration(value), '')
})

test('multi-step timing spans first actual processing to final assistant completion', () => {
  assert.deepEqual(
    turnDurations([
      assistant(2, 5000, 9000),
      assistant(2, 1000, 3000),
      assistant(3, 100, 200),
    ]),
    { 2: 8000, 3: 100 },
  )
})

test('an intermediate settled step never finishes an open turn', () => {
  const nodes = [assistant(1, 1000, 2000), assistant(2, 3000, 4000)]
  const turns = new Map([
    [1, { status: 'closed' }],
    [2, { status: 'open' }],
  ])
  assert.deepEqual(turnDurations(nodes, { turns }), { 1: 1000 })
  turns.set(2, { status: 'closed' })
  assert.deepEqual(turnDurations(nodes, { turns, openTurn: 2 }), { 1: 1000 })
  assert.deepEqual(turnDurations(nodes, { turns, partial: { turn: 2 } }), {
    1: 1000,
  })
  assert.deepEqual(turnDurations(nodes, { turns }), { 1: 1000, 2: 1000 })
})

test('unknown, incomplete or invalid timing produces no completed badge', () => {
  assert.deepEqual(
    turnDurations([assistant(1, 1000, 2000)], { turns: new Map() }),
    {},
  )
  assert.deepEqual(
    turnDurations([assistant(1, 1000, 2000), assistant(1, 2200, null)]),
    {},
  )
  assert.deepEqual(
    turnDurations([
      assistant(1, 3000, 2000),
      assistant(2, NaN, 4000),
      assistant('3', 0, 10),
      {
        kind: 'user',
        turn: 4,
        timing: { stepStartTime: 0, completedTime: 50 },
      },
    ]),
    {},
  )
  assert.deepEqual(turnDurations(null), {})
})

test('the observable store deduplicates equal maps and isolates subscribers', () => {
  const store = createTurnTimerStore()
  const seen = []
  store.subscribe(() => {
    throw Error('consumer')
  })
  const off = store.subscribe((value) => seen.push(value))
  const input = { 1: 100 }
  store.set(input)
  input[1] = 999
  store.set({ 1: 100 })
  assert.deepEqual(store.get(), { 1: 100 })
  assert.equal(seen.length, 1)
  store.clear()
  assert.equal(seen.length, 2)
  assert.deepEqual(store.get(), {})
  off()
  store.set({ 2: 200 })
  assert.equal(seen.length, 2)
})
