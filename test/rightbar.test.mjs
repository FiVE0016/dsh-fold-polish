import test from 'node:test'
import assert from 'node:assert/strict'
import { createRightbarControl } from '../src/rightbar.js'

function fixture() {
  let settings = { enabled: true, rightbarRatio: 45 }
  const rules = []
  const observers = []
  const attrs = new Set()
  const calls = []
  const frame = {
    style: {
      gridTemplateColumns: '280px minmax(400px, 1fr) minmax(0px, 720px)',
    },
    parentElement: {},
    getBoundingClientRect: () => ({ width: 1600 }),
    hasAttribute: (name) => attrs.has(name),
    setAttribute: (name) => attrs.add(name),
    removeAttribute: (name) => attrs.delete(name),
  }
  const column = {
    parentElement: frame,
    childElementCount: 1,
    getAttribute: () => null,
  }
  let layoutListener
  let resized
  let layoutStopped = false
  const view = {
    innerWidth: 1600,
    MutationObserver: class {
      constructor(fn) {
        this.fn = fn
        this.targets = []
        observers.push(this)
      }
      observe(node, options) {
        this.targets.push({ node, options })
      }
      disconnect() {
        this.targets = []
      }
    },
    getComputedStyle: () => ({ width: '720px' }),
    addEventListener(name, fn) {
      if (name === 'resize') resized = fn
    },
    removeEventListener() {},
    setInterval() {
      throw Error('polling forbidden')
    },
  }
  const document = {
    documentElement: {},
    querySelector: () => column,
    head: {
      appendChild(el) {
        rules.push(el)
      },
    },
    createElement: () => ({
      textContent: '',
      remove() {
        this.removed = true
      },
    }),
  }
  const control = createRightbarControl({
    document,
    view,
    layout: {
      panels: {
        setViewportWidth() {},
        setRightbar(px) {
          calls.push(px)
          frame.style.gridTemplateColumns = `280px minmax(400px, 1fr) minmax(0px, ${px}px)`
          layoutListener?.()
        },
      },
      panelInfo: {
        subscribe(fn) {
          layoutListener = fn
          return () => {
            layoutStopped = true
          }
        },
      },
    },
    getSettings: () => settings,
    updateSettings(patch) {
      settings = { ...settings, ...patch }
    },
  })
  return {
    control,
    frame,
    column,
    attrs,
    calls,
    rules,
    observers,
    resized: () => resized(),
    stopped: () => layoutStopped,
    settings: () => settings,
    update(patch) {
      settings = { ...settings, ...patch }
      control.refresh()
    },
  }
}

test('ratio writes through host actions and targets only its marked frame', () => {
  const f = fixture()
  assert.equal(f.calls[0], 720)
  assert.match(f.rules[0].textContent, /720px !important/)
  f.control.setRatio(60)
  assert.equal(f.calls.at(-1), 960)
  // The center keeps its host-guaranteed minimum width.
  assert.match(f.rules[0].textContent, /920px !important/)
  assert.equal(f.settings().rightbarRatio, 60)
})

test('close, fullscreen and absent contents immediately release the track', () => {
  const f = fixture()
  for (const marker of [
    'data-rightbar-collapsed',
    'data-rightbar-fullscreen',
  ]) {
    f.attrs.add(marker)
    f.control.refresh()
    assert.equal(f.rules[0].textContent, '')
    assert.equal(f.attrs.has('data-lf-frame'), false)
    f.attrs.delete(marker)
    f.control.refresh()
    assert.match(f.rules[0].textContent, /720px !important/)
  }
  f.column.childElementCount = 0
  f.control.refresh()
  assert.equal(f.rules[0].textContent, '')
})

test('disable and disposal restore the prior width and release all resources', () => {
  const f = fixture()
  f.control.setRatio(55)
  f.update({ enabled: false })
  assert.equal(f.rules[0].textContent, '')
  assert.equal(f.calls.at(-1), 720)
  f.update({ enabled: true })
  assert.equal(f.calls.at(-1), 880)
  f.control.dispose()
  f.control.dispose()
  assert.equal(f.calls.at(-1), 720)
  assert.equal(f.rules[0].removed, true)
  assert.equal(f.stopped(), true)
  assert.equal(
    f.observers.every((item) => item.targets.length === 0),
    true,
  )
})

test('host handle drags update the saved fraction without delayed polling', () => {
  const f = fixture()
  f.control.refresh() // acknowledge the initial host write
  f.frame.style.gridTemplateColumns =
    '280px minmax(400px, 1fr) minmax(0px, 800px)'
  f.attrs.add('data-dragging')
  f.control.refresh()
  assert.equal(f.settings().rightbarRatio, 50)
  assert.match(f.rules[0].textContent, /800px !important/)
})
