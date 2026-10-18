import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as turnTimer from '../src/turn-timer.js'
import * as rightbar from '../src/rightbar.js'
import * as deletePanel from '../src/delete-panel.js'

const source = readFileSync(
  new URL('../src/client-entry.js', import.meta.url),
  'utf8',
)

function boot({
  startError,
  reactError,
  slotError,
  primitivesError,
  throwingStorage = false,
} = {}) {
  let registration
  let starts = 0
  let stops = 0
  let unsubscribes = 0
  let settings = { enabled: true, rightbarRatio: 45, assistantLines: 3 }
  const listeners = new Set()
  const registered = []
  const removed = []
  const tabs = []
  const fibers = []
  const win = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
    __DSH_BUBBLE_FOLD_MODULES__: {
      './src/browser.js': {
        start() {
          starts++
          if (startError) throw Error('start')
          return controller
        },
      },
      './src/settings-panel.js': { createPanel: () => () => null },
      './src/find-panel.js': {
        createFindPanel: () => ({ Panel: () => null, Title: () => null }),
      },
      './src/turn-timer.js': turnTimer,
      './src/rightbar.js': rightbar,
      './src/delete-panel.js': deletePanel,
    },
    getComputedStyle() {
      return {}
    },
    requestAnimationFrame() {},
    cancelAnimationFrame() {},
    setTimeout() {},
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
  }
  if (throwingStorage)
    Object.defineProperty(win, 'localStorage', {
      get() {
        throw Error('blocked')
      },
    })
  else win.localStorage = { getItem() {}, setItem() {} }
  const doc = { defaultView: win, querySelector: () => null }
  const controller = {
    settings: () => settings,
    update(patch) {
      settings = { ...settings, ...patch }
      for (const fn of listeners) fn()
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
        unsubscribes++
      }
    },
    search: () => [{ element: 'handle' }],
    revealAt: (element) => element,
    composer: () => ({ value: 336 }),
    setHeight: (value) => value,
    resetHeight: () => 336,
    dispose() {
      stops++
    },
  }
  const services = {
    slots: {
      inject(name, fn) {
        fn()
        return () => removed.push(name)
      },
      register(options, component) {
        if (options.name === slotError) throw Error('slot failure')
        registered.push({ options, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(tab) {
        tabs.push(tab)
        return () => removed.push('tab-type')
      },
    },
  }
  // Strictly ctx.get: any direct service property access fails the test.
  const ctx = new Proxy(
    {
      get: (name) => services[name],
      inject(names, callback) {
        let prior = []
        let off = null
        let active = false
        const fiber = {
          names,
          disposed: false,
          refresh() {
            if (this.disposed) return
            const next = names.map((name) => services[name])
            if (active && next.every((value, index) => value === prior[index]))
              return
            off?.()
            off = null
            active = false
            prior = next
            if (next.every(Boolean)) {
              active = true
              off = callback(ctx)
            }
          },
          dispose() {
            this.disposed = true
            off?.()
            off = null
            active = false
          },
        }
        fibers.push(fiber)
        fiber.refresh()
        return fiber
      },
    },
    {
      get(target, name) {
        if (name === 'get' || name === 'inject') return target[name]
        throw Error(`direct service read: ${String(name)}`)
      },
    },
  )
  new Function('window', 'document', 'console', source)(win, doc, { warn() {} })
  const plugin = registration.factory((name) => {
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      if (primitivesError) throw Error('primitives unavailable')
      return { MenuItemButton: 'menu', Modal: 'modal', Button: 'button' }
    }
    assert.equal(name, 'react')
    if (reactError) throw Error('react')
    return { createElement() {} }
  })
  return {
    plugin,
    ctx,
    win,
    controller,
    services,
    registered,
    removed,
    tabs,
    fibers,
    setService(name, value) {
      services[name] = value
      for (const fiber of fibers) fiber.refresh()
    },
    starts: () => starts,
    stops: () => stops,
    unsubscribes: () => unsubscribes,
  }
}

test('optional features declare separate lifetimes without blocking core startup', () => {
  const env = boot()
  assert.deepEqual(env.plugin.inject, [])
  env.plugin.apply(env.ctx)
  assert.deepEqual(
    env.fibers.map((fiber) => fiber.names),
    [
      ['layout'],
      ['slots'],
      ['slots', 'connection', 'sessions', 'uiWorkspace', 'workspaces'],
      ['slots', 'sidebarRightTabs'],
      ['uiConversation', 'sessions'],
    ],
  )
})

test('strict restricted context boots and registers the native panel contracts', () => {
  const env = boot()
  assert.doesNotThrow(() => env.plugin.apply(env.ctx))
  assert.equal(env.win.__DSH_FOLD_POLISH__.status, 'running')
  const settings = env.registered.find(
    ({ options }) => options.name === 'settings.plugins.tab',
  )
  assert.equal(settings.options.id, 'bubble-fold')
  const body = env.registered.find(
    ({ options }) => options.name === 'sidebar.right.pane.tab',
  )
  const title = env.registered.find(
    ({ options }) => options.name === 'sidebar.right.pane.tab.title',
  )
  assert.equal(body.options.key, 'bubble-fold-find')
  assert.equal(title.options.key, body.options.key)
  assert.equal(env.tabs[0].id, body.options.key)
  assert.equal(env.tabs[0].kind, body.options.key)
  assert.equal(env.win.__DSH_FOLD_POLISH__.findTabRegistered, true)
})

test('panel API stays connected to the controller', () => {
  const env = boot()
  env.plugin.apply(env.ctx)
  const api = env.registered[0].options.inject().api
  api.update({ assistantLines: 5 })
  assert.equal(api.settings().assistantLines, 5)
  assert.deepEqual(api.search('text'), [{ element: 'handle' }])
  assert.equal(api.revealAt('handle'), 'handle')
  assert.equal(api.setHeight(450), 450)
  assert.equal(api.resetHeight(), 336)
})

test('apply is idempotent and disposal permits a clean restart', () => {
  const env = boot()
  const off = env.plugin.apply(env.ctx)
  assert.equal(env.plugin.apply(env.ctx), off)
  assert.equal(env.starts(), 1)
  off()
  off()
  assert.equal(env.stops(), 1)
  assert.equal(env.win.__DSH_FOLD_POLISH__, undefined)
  assert.equal(env.removed.length, 4)
  env.plugin.apply(env.ctx)
  assert.equal(env.starts(), 2)
  env.plugin.dispose()
  assert.equal(env.stops(), 2)
})

test('missing services and blocked preference storage preserve the DOM feature', () => {
  const env = boot({ throwingStorage: true })
  assert.doesNotThrow(() => env.plugin.apply(null))
  assert.equal(env.win.__DSH_FOLD_POLISH__.status, 'running')
})

test('a DOM-controller failure never aborts host startup', () => {
  const env = boot({ startError: true })
  assert.doesNotThrow(() => env.plugin.apply(env.ctx))
  assert.equal(env.win.__DSH_FOLD_POLISH__.status, 'failed')
  assert.equal(typeof env.win.__DSH_FOLD_POLISH__.dispose, 'function')
})

test('a platform resolver failure is isolated inside apply', () => {
  const env = boot({ reactError: true })
  assert.doesNotThrow(() => env.plugin.apply(env.ctx))
  assert.equal(env.starts(), 0)
  assert.equal(env.win.__DSH_FOLD_POLISH__, undefined)
})

test('a failed find seat rolls its type and prior seats back immediately', () => {
  const env = boot({ slotError: 'sidebar.right.pane.tab.title' })
  env.plugin.apply(env.ctx)
  assert.equal(env.win.__DSH_FOLD_POLISH__.findTabRegistered, false)
  assert.deepEqual(env.removed, ['sidebar.right.pane.tab', 'tab-type'])
  assert.equal(env.win.__DSH_FOLD_POLISH__.status, 'running')
})

test('late right-sidebar service mounts, unmounts and remounts its three seats', () => {
  const env = boot()
  const tabs = env.services.sidebarRightTabs
  env.setService('sidebarRightTabs', undefined)
  const off = env.plugin.apply(env.ctx)
  assert.equal(env.win.__DSH_FOLD_POLISH__.findTabRegistered, false)
  assert.equal(env.starts(), 1)
  env.setService('sidebarRightTabs', tabs)
  assert.equal(env.win.__DSH_FOLD_POLISH__.findTabRegistered, true)
  assert.equal(env.tabs.length, 1)
  env.setService('sidebarRightTabs', undefined)
  assert.equal(env.win.__DSH_FOLD_POLISH__.findTabRegistered, false)
  assert.deepEqual(env.removed, [
    'sidebar.right.pane.tab.title',
    'sidebar.right.pane.tab',
    'tab-type',
  ])
  env.setService('sidebarRightTabs', tabs)
  assert.equal(env.tabs.length, 2)
  off()
  assert.equal(
    env.fibers.every((fiber) => fiber.disposed),
    true,
  )
  env.setService('sidebarRightTabs', undefined)
  env.setService('sidebarRightTabs', tabs)
  assert.equal(env.tabs.length, 2)
})

test('late layout provider has exactly one settings listener and restores on provider removal', () => {
  const env = boot()
  let mounted = 0
  let disposed = 0
  let refreshed = 0
  env.win.__DSH_BUBBLE_FOLD_MODULES__['./src/rightbar.js'] = {
    createRightbarControl() {
      mounted++
      return {
        refresh() {
          refreshed++
        },
        info: () => ({ supported: true }),
        dispose() {
          disposed++
        },
      }
    },
  }
  env.plugin.apply(env.ctx)
  assert.equal(env.win.__DSH_FOLD_POLISH__.rightbar().supported, false)
  const layout = { panels: {} }
  env.setService('layout', layout)
  assert.equal(mounted, 1)
  assert.equal(env.win.__DSH_FOLD_POLISH__.rightbar().supported, true)
  env.controller.update({ enabled: false })
  assert.equal(refreshed, 1)
  env.setService('layout', undefined)
  assert.equal(disposed, 1)
  env.controller.update({ enabled: true })
  assert.equal(refreshed, 1)
  env.setService('layout', layout)
  assert.equal(mounted, 2)
  env.plugin.dispose()
  assert.equal(disposed, 2)
})

test('late timer service subscribes only while both providers exist', () => {
  const env = boot()
  let subscriptions = 0
  let unsubscriptions = 0
  env.plugin.apply(env.ctx)
  env.setService('uiConversation', {
    binding() {
      throw Error('no displayed session')
    },
  })
  assert.equal(subscriptions, 0)
  const sessions = {
    list: {
      subscribe() {
        subscriptions++
        return () => {
          unsubscriptions++
        }
      },
    },
  }
  env.setService('sessions', sessions)
  assert.equal(subscriptions, 1)
  env.setService('sessions', undefined)
  assert.equal(unsubscriptions, 1)
  env.setService('sessions', sessions)
  assert.equal(subscriptions, 2)
  env.plugin.dispose()
  assert.equal(unsubscriptions, 2)
})

function mountDeleteServices(env) {
  env.setService('connection', {
    rpc: {
      call() {
        throw Error('unexpected deletion')
      },
    },
  })
  env.setService('sessions', {
    list: { getSnapshot: () => ({ byId: {} }) },
    refresh: async () => {},
  })
  env.setService('uiWorkspace', {})
  env.setService('workspaces', {
    list: { getSnapshot: () => ({ archivedSessionIds: [] }) },
  })
}

test('native deletion menu and confirmation mount lazily and clean up when their carrier disappears', () => {
  const env = boot()
  env.plugin.apply(env.ctx)
  assert.equal(
    env.registered.some(({ options }) => options.id === 'fold-polish-delete'),
    false,
  )
  mountDeleteServices(env)
  assert.equal(
    env.registered.filter(({ options }) => options.id === 'fold-polish-delete')
      .length,
    1,
  )
  assert.equal(
    env.registered.filter(
      ({ options }) => options.id === 'fold-polish-delete-confirm',
    ).length,
    1,
  )
  assert.equal(env.starts(), 1)
  env.setService('connection', undefined)
  assert.ok(env.removed.includes('sidebar.workspaces.session.menu.item'))
  assert.ok(env.removed.includes('shell.overlay'))
  assert.equal(env.win.__DSH_FOLD_POLISH__.status, 'running')
  env.setService('connection', {
    rpc: {
      call() {
        throw Error('unexpected deletion')
      },
    },
  })
  assert.equal(
    env.registered.filter(({ options }) => options.id === 'fold-polish-delete')
      .length,
    2,
  )
  env.plugin.dispose()
  assert.equal(env.removed.filter((name) => name === 'shell.overlay').length, 2)
})

test('a missing native menu platform module cannot disable folding or leave a partial delete action', () => {
  const env = boot({ primitivesError: true })
  env.plugin.apply(env.ctx)
  assert.doesNotThrow(() => mountDeleteServices(env))
  assert.equal(env.win.__DSH_FOLD_POLISH__.status, 'running')
  assert.equal(
    env.registered.some(({ options }) => options.id === 'fold-polish-delete'),
    false,
  )
  env.plugin.dispose()
})
