import test from 'node:test'
import assert from 'node:assert/strict'
import { createTurnTimerStore, watchTurnTimers } from '../src/turn-timer.js'

function source(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set(next) {
      value = next
      for (const fn of [...listeners]) fn()
    },
    count: () => listeners.size,
  }
}
const snapshot = (status, end = 2000) => ({
  timeline: { turns: new Map([[1, { status }]]) },
  legacy: {
    nodes: [
      {
        kind: 'assistant',
        turn: 1,
        timing: { stepStartTime: 1000, completedTime: end },
      },
    ],
    partial: null,
  },
})

function fixture() {
  const chatA = source(snapshot('open'))
  const chatB = source(snapshot('closed', 6000))
  const open = source(1)
  const list = source({ byId: { wrong: {} } })
  const bindings = {
    a: { target: () => chatA, openTurn: open },
    b: { target: () => chatB, openTurn: source(undefined) },
  }
  let id = 'a'
  const occurrence = { isConnected: true, getAttribute: () => id }
  let callback
  let disconnected = false
  const view = {
    MutationObserver: class {
      constructor(fn) {
        callback = fn
      }
      observe() {}
      disconnect() {
        disconnected = true
      }
    },
    setInterval() {
      throw Error('polling forbidden')
    },
  }
  const doc = {
    documentElement: {},
    querySelector: () => (id ? occurrence : null),
  }
  const store = createTurnTimerStore()
  const reads = []
  const off = watchTurnTimers({
    document: doc,
    view,
    conversation: {
      binding(next) {
        reads.push(next)
        return bindings[next]
      },
    },
    sessions: { list },
    store,
  })
  return {
    store,
    off,
    reads,
    list,
    chatA,
    chatB,
    open,
    disconnected: () => disconnected,
    switch(next) {
      id = next
      callback([{ type: 'attributes', target: occurrence }])
    },
  }
}

test('subscribed snapshots wait for turn completion and publish the last output time', () => {
  const f = fixture()
  assert.deepEqual(f.store.get(), {})
  assert.equal(f.chatA.count(), 1)
  f.chatA.set(snapshot('closed', 4500))
  assert.deepEqual(f.store.get(), {})
  f.open.set(undefined)
  assert.deepEqual(f.store.get(), { 1: 3500 })
  f.off()
})

test('switching sessions releases prior sources and never chooses a catalog fallback', () => {
  const f = fixture()
  f.switch('b')
  assert.equal(f.chatA.count(), 0)
  assert.equal(f.chatB.count(), 1)
  assert.deepEqual(f.store.get(), { 1: 5000 })
  f.switch(null)
  assert.deepEqual(f.store.get(), {})
  assert.equal(f.chatB.count(), 0)
  assert.equal(f.reads.includes('wrong'), false)
  f.off()
  assert.equal(f.list.count(), 0)
  assert.equal(f.disconnected(), true)
})

test('hosts without a closed-turn signal show no misleading duration', () => {
  const f = fixture()
  f.open.set(undefined)
  f.chatA.set({ legacy: snapshot('closed').legacy })
  assert.deepEqual(f.store.get(), {})
  f.off()
})
