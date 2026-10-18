import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
function load() {
  let registration
  const window = {
    __ModuleLoader__: {
      load: (value) => {
        registration = value
      },
    },
  }
  const context = vm.createContext({ window, console: { warn() {} } })
  new vm.Script(bundle, { filename: 'client.js' }).runInContext(context)
  return { window, registration }
}
test('the shipped bundle parses and registers exactly its self-contained entry', () => {
  const { registration } = load()
  assert.equal(registration.id, 'dsh-fold-polish')
  assert.equal(typeof registration.factory, 'function')
})
test('all local modules are available without using the host resolver', () => {
  const { window } = load()
  const modules = window.__DSH_BUBBLE_FOLD_MODULES__
  for (const [file, method] of [
    ['fold', 'normalizeSettings'],
    ['browser', 'start'],
    ['settings-panel', 'createPanel'],
    ['find-panel', 'createFindPanel'],
    ['turn-timer', 'watchTurnTimers'],
    ['rightbar', 'createRightbarControl'],
    ['delete-panel', 'createDeleteController'],
  ])
    assert.equal(typeof modules[`./src/${file}.js`]?.[method], 'function', file)
})
test('the bundle factory does not load private specifiers through the host', () => {
  const { registration } = load()
  const requested = []
  const plugin = registration.factory((name) => {
    requested.push(name)
    throw Error('platform unavailable')
  })
  assert.equal(plugin.name, 'dsh-fold-polish')
  assert.deepEqual(requested, [])
  assert.doesNotThrow(() =>
    plugin.apply(
      new Proxy(
        {},
        {
          get() {
            throw Error('restricted')
          },
        },
      ),
    ),
  )
})
