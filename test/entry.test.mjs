// Plain-Node checks for the client entry: the settings-tab and right-sidebar-find
// registration contracts that only run inside the real host. The DOM-layer
// behaviour stays in runtime.test.mjs; this file covers the ctx slice with a
// faked loader.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(here, '..', 'src', 'client-entry.js'), 'utf8')
const foldModule = await import(pathToFileURL(path.join(here, '..', 'src', 'fold.js')).href)

const FIND_TAB_ID = 'bubble-fold-find'

let passed = 0
let failed = 0
const queued = []
/**
 * Queue a check. Tests are collected and run in order, awaiting each one: several
 * of them drive code that schedules work through `setTimeout`, and that work only
 * happens once the current synchronous block ends.
 */
function test(name, fn) {
  queued.push({ name, fn })
}

async function runAll() {
  for (const { name, fn } of queued) {
    try {
      await fn()
      passed += 1
      console.log(`  ok   ${name}`)
    } catch (error) {
      failed += 1
      console.log(`  FAIL ${name}\n       ${error.message}`)
    }
  }
}

/** Let every microtask-scheduled retry drain. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** Boot the entry in a sandbox with a faked loader surface. */
const runEntry = (options = {}) => {
  let registration = null
  const listeners = {}
  let currentSettings = { enabled: true, userLines: 6, assistantLines: 10, extraPx: 8, rightbarRatio: 45 }
  const fakeController = {
    applied: [],
    disposed: false,
    settings: () => ({ ...currentSettings }),
    update(patch) {
      this.applied.push(patch)
      currentSettings = { ...currentSettings, ...patch }
      this.listener?.()
    },
    subscribe(fn) { this.listener = fn; return () => { this.listener = null } },
    rescan() {},
    stats: () => ({}),
    setHeight() {},
    resetHeight() {},
    dispose() { this.disposed = true }
  }
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {}
  }
  const observers = []
  const intervals = []
  const win = {
    __ModuleLoader__: { load: (row) => { registration = row } },
    __DSH_BUBBLE_FOLD_MODULES__: {
      './src/browser.js': { start: () => fakeController },
      './src/fold.js': {},
      './src/settings-panel.js': { createPanel: () => () => null },
      './src/find-panel.js': { createFindPanel: () => ({ Panel: () => null, Title: () => null }) }
    },
    // The entry derives every browser global from `document.defaultView ?? window`;
    // the real page supplies these, so the sandbox must too.
    navigator: { userAgent: options.userAgent ?? '' },
    localStorage: { getItem: () => null, setItem() {} },
    getComputedStyle: () => ({}),
    requestAnimationFrame: () => 0,
    // Real timers are asynchronous; running the callback inline would let code that
    // waits for the controller race ahead of its own creation.
    setTimeout: (fn) => { if (typeof fn === 'function') Promise.resolve().then(fn); return 0 },
    clearTimeout: () => {},
    // 右栏几何自检用的低频定时器：测试里手动触发（fireIntervals），不引入真实等待。
    setInterval: (fn) => { intervals.push(fn); return intervals.length },
    clearInterval: (id) => { if (id > 0) intervals[id - 1] = null },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback
        this.targets = new Map()
        this.pending = []
        this.disconnects = 0
        observers.push(this)
      }
      observe(target, options) {
        assert.ok(target, 'MutationObserver requires an existing target')
        this.targets.set(target, { ...options })
      }
      disconnect() {
        this.targets.clear()
        this.pending.length = 0
        this.disconnects += 1
      }
      takeRecords() { return this.pending.splice(0) }
    },
    HTMLElement: class {},
    Element: class {},
    innerWidth: 1600,
    addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler) },
    removeEventListener: () => {}
  }
  // The entry reads the DOM for the right-bar width; an empty document is the
  // "not measurable yet" case it must survive. Tests that need a frame pass one in.
  const fakeDocument = options.document ?? { defaultView: null, querySelector: () => null, body: null, documentElement: null }
  const fn = new Function('window', 'document', 'console', source)
  fn(win, fakeDocument, { warn() {}, error() {}, log() {} })
  const plugin = registration.factory((name) => (name === 'react' ? fakeReact : null))
  // Queue records against the subscriptions in force WHEN the mutation happens.
  // Flush separately so replacement + new-frame style changes can be coalesced.
  const queueMutations = (records) => {
    for (const observer of observers) {
      for (const record of records) {
        const matches = [...observer.targets].some(([target, config]) => {
          const inScope = target === record.target || (config.subtree && target.contains?.(record.target))
          if (!inScope) return false
          if (record.type === 'childList') return config.childList === true
          return record.type === 'attributes' && config.attributes === true &&
            (!config.attributeFilter || config.attributeFilter.includes(record.attributeName))
        })
        if (matches) observer.pending.push(record)
      }
    }
  }
  const flushMutations = () => {
    // Snapshot first: one callback rebinding another observer must not lose the
    // batch already delivered to that observer at this checkpoint.
    const deliveries = observers.map((observer) => [observer, observer.takeRecords()])
    for (const [observer, records] of deliveries) {
      if (records.length) observer.callback(records, observer)
    }
  }
  const emitMutations = (...records) => { queueMutations(records); flushMutations() }
  return {
    plugin, win, fakeController, listeners, observers, queueMutations, flushMutations, emitMutations,
    fireIntervals: () => { for (const fn of [...intervals]) if (typeof fn === 'function') fn() }
  }
}

const FRAME_TRACKS = '280px minmax(400px, 1fr) minmax(0px, 720px)'
const CLOSED_TRACKS = '280px minmax(400px, 1fr) minmax(0px, 0px)'
const attrMutation = (target, attributeName = 'style') => ({ type: 'attributes', target, attributeName })

/** A replaceable frame with write counters, not a layout/CSS engine. */
const makeFrameDocument = (tracks = FRAME_TRACKS, { mounted = true } = {}) => {
  const created = []
  const root = {
    contains(node) { return node === this || node?.isConnected === true },
    querySelectorAll(selector) { return document.querySelectorAll(selector) }
  }
  const makeFrame = (value = FRAME_TRACKS) => ({
    style: { gridTemplateColumns: value },
    attrs: {},
    isConnected: false,
    attributeWrites: 0,
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) },
    getAttribute(name) { return this.attrs[name] ?? null },
    setAttribute(name, value) { this.attributeWrites += 1; this.attrs[name] = String(value) },
    removeAttribute(name) { this.attributeWrites += 1; delete this.attrs[name] }
  })
  const frame = makeFrame(tracks)
  let currentFrame = mounted ? frame : null
  frame.isConnected = mounted
  const head = {
    children: [],
    appendChild(child) { this.children.push(child); child.isConnected = true }
  }
  const document = {
    defaultView: null,
    head,
    body: root,
    documentElement: root,
    createElement: () => {
      let text = ''
      const el = {
        id: '',
        textWrites: 0,
        get textContent() { return text },
        set textContent(value) { this.textWrites += 1; text = String(value) },
        setAttribute(name, value) { if (name === 'id') this.id = value },
        remove() { this.isConnected = false; head.children = head.children.filter((child) => child !== this) }
      }
      created.push(el)
      return el
    },
    getElementById: (id) => created.find((el) => el.id === id && el.isConnected) ?? null,
    querySelector: (selector) => document.querySelectorAll(selector)[0] ?? null,
    querySelectorAll: (selector) => {
      if (!currentFrame) return []
      if (String(selector).includes('div[style]')) return [currentFrame]
      if (String(selector).includes('data-lf-frame') && currentFrame.hasAttribute('data-lf-frame')) return [currentFrame]
      return []
    }
  }
  return {
    frame, created, document, makeFrame,
    replaceFrame(next) {
      const previous = currentFrame
      if (previous) previous.isConnected = false
      currentFrame = next
      if (next) next.isConnected = true
      return { type: 'childList', target: root, addedNodes: next ? [next] : [], removedNodes: previous ? [previous] : [] }
    }
  }
}

const rightbarContext = () => ({
  slots: { inject: (_name, callback) => { callback(); return () => {} }, register: () => () => {} },
  get: (name) => (name === 'layout' ? { panels: { setRightbar: () => {}, setViewportWidth: () => {} } } : undefined)
})

/** A ctx with the slot ledger plus the right-bar services the entry asks for. */
const makeCtx = () => {
  const registrations = new Map()
  const tabs = []
  const opened = []
  const ctx = {
    slots: {
      // The host projects the ledger lazily: inject() records the callback, and
      // the callback is what performs the actual register().
      inject: (_name, callback) => { callback(); return () => {} },
      register: (options, component) => {
        registrations.set(options.name, { options, component })
        return () => {}
      }
    },
    get: (name) => {
      if (name === 'sidebarRightTabs') {
        return { register: (definition) => { tabs.push(definition); return () => {} } }
      }
      if (name === 'sidebarRight') return { openTab: (id) => { opened.push(id) } }
      if (name === 'layout') return { openRightbar: () => {} }
      return undefined
    }
  }
  return { ctx, registrations, tabs, opened }
}

test('declares the slots dependency the panels need', () => {
  const { plugin } = runEntry()
  assert.ok(plugin.inject.includes('slots'), `inject: ${JSON.stringify(plugin.inject)}`)
})

test('registers one tab into settings.plugins.tab', () => {
  const { plugin } = runEntry()
  const { ctx, registrations } = makeCtx()
  plugin.apply(ctx)
  const tab = registrations.get('settings.plugins.tab')
  assert.ok(tab, 'the settings tab was registered')
  assert.equal(tab.options.id, 'bubble-fold', 'a fresh id adds a tab beside "all"')
  assert.equal(tab.options.order, 20)
  assert.equal(tab.options.label, 'UI 美化')
  assert.equal(typeof tab.component, 'function', 'the panel component is a function')
})

test('registers the find panel as a RIGHT sidebar tab, not a left-column panel', () => {
  const { plugin } = runEntry()
  const { ctx, registrations, tabs } = makeCtx()
  plugin.apply(ctx)
  assert.equal(tabs.length, 1, 'exactly one tab type is declared')
  assert.equal(tabs[0].id, FIND_TAB_ID)
  assert.equal(tabs[0].kind, FIND_TAB_ID, 'the kind matches the id, as the shipped panels do')
  assert.equal(typeof tabs[0].title, 'function', 'the title is a thunk so it follows the locale')
  const body = registrations.get('sidebar.right.pane.tab')
  assert.ok(body, 'the body registers under the keyed pane.tab seat')
  assert.equal(body.options.key, FIND_TAB_ID, 'keyed by the tab type id')
  assert.equal(typeof body.component, 'function')
  const title = registrations.get('sidebar.right.pane.tab.title')
  assert.ok(title, 'the chip registers too')
  assert.equal(title.options.key, FIND_TAB_ID)
  assert.equal(registrations.has('sidebar.panellist'), false, 'the left sidebar entry is gone')
  assert.equal(registrations.has('main'), false, 'and so is the left-column panel')
})

test('the tab api writes through to the running controller', () => {
  const { plugin, fakeController } = runEntry()
  const { ctx, registrations } = makeCtx()
  plugin.apply(ctx)
  const props = registrations.get('settings.plugins.tab').options.inject()
  assert.equal(props.api.settings().userLines, 6, 'reads come from the controller')
  props.api.update({ userLines: 9 })
  assert.deepEqual(fakeController.applied.at(-1), { userLines: 9 })
  assert.equal(props.api.settings().userLines, 9, 'the write landed in the controller state, reads still go through it')
  const off = props.api.subscribe(() => {})
  assert.equal(typeof off, 'function', 'subscribe hands back an unsubscribe')
})

test('the plugin registers no global keyboard shortcuts at all (2026-10-13: all removed)', () => {
  // 用户要求一切设置走设置界面：插件不注册任何 window/document 级 keydown
  // 监听（原 Ctrl+Shift+B 总开关 / Ctrl+Shift+, 开面板 / Ctrl+Shift+↑↓ 调
  // 高度 / Ctrl+F 查找全部移除）——与浏览器、输入法、其它软件热键零冲突。
  for (const userAgent of [
    'Mozilla/5.0 (Windows NT 10.0) Chrome/152 Electron/44.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0) Chrome/152.0 Safari/537.36'
  ]) {
    const entry = runEntry({ userAgent })
    const ctx = makeCtx()
    entry.plugin.apply(ctx.ctx)
    const where = userAgent.includes('Electron') ? 'desktop' : 'browser'
    assert.equal((entry.listeners.keydown ?? []).length, 0, `no keydown listener is installed (${where})`)
  }
})

test('without the right-bar service the find tab is simply not registered', () => {
  const desktop = runEntry({ userAgent: 'Mozilla/5.0 Chrome/152 Electron/44.0.0 Safari/537.36' })
  const layoutCalls = []
  const registrations = new Map()
  const ctx = {
    slots: {
      inject: (_name, callback) => { callback(); return () => {} },
      register: (options, component) => { registrations.set(options.name, { options, component }); return () => {} }
    },
    // The services simply are not there — the shape a dynamic client half hits on
    // hosts that keep the right bar to first-party panels.
    get: (name) => (name === 'layout' ? { openRightbar: (...args) => layoutCalls.push(args) } : undefined)
  }
  desktop.plugin.apply(ctx)
  assert.equal(registrations.has('sidebar.right.pane.tab'), false, 'nothing was registered')
  assert.equal((desktop.listeners.keydown ?? []).length, 0, 'no keyboard route to compensate')
  assert.deepEqual(layoutCalls, [], 'the right column is never opened')
})

test('the settings page covers every setting the in-page panel has', async () => {
  const { createPanel } = await import(pathToFileURL(path.join(here, '..', 'src', 'settings-panel.js')).href)
  // A minimal React stand-in: the panel only uses createElement/useState/useEffect.
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {}
  }
  const settings = { ...foldModule.DEFAULT_SETTINGS }
  const api = {
    settings: () => settings,
    update: () => {},
    subscribe: () => () => {},
    composer: () => ({ min: 200, max: 900, value: 336, fallback: 336 }),
    setHeight: () => {},
    resetHeight: () => {},
    rightbar: () => ({ supported: true, ratio: 45 }),
    setRightbarRatio: () => {}
  }
  const tree = createPanel(React, api)({ api })

  // The tree is nested createElement objects; every control is built by Row with a
  // `label` prop, so collecting those labels proves the page is complete.
  const labels = []
  const walk = (node) => {
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (!node || typeof node !== 'object') return
    if (node.props?.label) labels.push(node.props.label)
    walk(node.props?.children)
  }
  walk(tree)

  // Mirrors the in-page panel row for row: 14 settings + the composer height.
  const expected = [
    '启用插件',
    '最新一轮保持展开',
    '折叠我的输入',
    '我的输入保留行数',
    '折叠助手回复',
    '助手回复保留行数',
    '全部消息都折叠',
    '折叠后保留行数',
    '折叠后与控件的间距 (px)',
    '步骤区与回复之间加折叠按钮',
    '步骤默认收起',
    '默认只留一个按钮',
    '按钮显示文字',
    '每轮显示耗时',
    '输入框可拖动调高',
    '右侧栏占比 (%)',
    '输入框高度'
  ]
  for (const label of expected) {
    assert.ok(labels.includes(label), `设置页缺少「${label}」`)
  }
  assert.equal(expected.length, Object.keys(foldModule.DEFAULT_SETTINGS).length + 1, 'no setting is left out')
})

test('a hostile restricted ctx cannot make apply throw (boot must survive)', () => {
  const { plugin, win, fakeController, listeners } = runEntry({
    userAgent: 'Mozilla/5.0 Chrome/152 Electron/44.0.0 Safari/537.36'
  })
  // The shape that once killed the boot: reading an UNKNOWN property off the
  // restricted context throws, and a throwing `dsh.client.immediately` row makes
  // the whole host fail to start (verified: "web boot: 1 entry did not activate").
  const slots = { inject: (_name, callback) => { callback(); return () => {} }, register: () => () => {} }
  const ctx = new Proxy({ slots, get: (name) => (name === 'layout' ? { openRightbar() {} } : undefined) }, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop !== 'string') return undefined
      throw new Error(`Unknown service: ${prop}`)
    }
  })
  assert.doesNotThrow(() => plugin.apply(ctx), 'apply must never throw at the host')
  assert.equal(win.__DSH_BUBBLE_FOLD__?.status, 'running', 'the fold itself still comes up')
  assert.equal(fakeController.disposed, false)
  // The key route may exist now; it must stay harmless without a registered tab.
  const handler = (listeners.keydown ?? [])[0]
  if (handler) {
    assert.doesNotThrow(() => handler({ key: 'f', ctrlKey: true, shiftKey: false, altKey: false, preventDefault() {} }))
  }
})

test('the right-sidebar ratio is applied through layout.panels.setRightbar', async () => {
  const calls = []
  const viewports = []
  const { plugin, win } = runEntry({ userAgent: 'Mozilla/5.0 Chrome/152 Electron/44.0.0 Safari/537.36' })
  const ctx = {
    slots: { inject: (_name, callback) => { callback(); return () => {} }, register: () => () => {} },
    // The host's real shape: a LayoutController carrying the store actions as
    // `panels`. `layout.setRightbar` does NOT exist — that wrong guess is why the
    // setting silently did nothing on the first release of this control.
    get: (name) => (name === 'layout'
      ? { panels: { setRightbar: (px) => calls.push(px), setViewportWidth: (px) => viewports.push(px) } }
      : undefined)
  }
  plugin.apply(ctx)
  await tick()
  assert.ok(calls.length > 0, '激活时就应用了设置里的占比')
  assert.equal(calls[0], Math.round(1600 * 45 / 100), '像素 = 帧宽 × 占比')
  // The store clamps against its own viewportWidth, which is 0 during boot; without
  // this correction every request collapses to the 300px floor and a restart loses
  // the width the reader chose.
  assert.ok(viewports.length > 0, '先校正 store 的 viewportWidth')
  assert.equal(viewports[0], 1600, '用真实帧宽校正')
  win.__DSH_BUBBLE_FOLD__.setRightbarRatio(60)
  assert.equal(calls.at(-1), Math.round(1600 * 60 / 100), '改设置立刻应用')
  assert.equal(win.__DSH_BUBBLE_FOLD__.rightbar().supported, true)
  assert.doesNotThrow(() => win.__DSH_BUBBLE_FOLD__.layoutDebug())
})

test('the right-bar width is read from the host inline grid, never guessed', async () => {
  // The host writes `grid-template-columns` inline on the AppFrame; the third track
  // is `minmax(0px, <rightbarMax>px)`. That number is what our setting must mirror —
  // walking up from a child can land on an inner grid and read an unrelated width.
  const frame = { style: { gridTemplateColumns: '280px minmax(400px, 1fr) minmax(0px, 900px)' } }
  const document = {
    defaultView: null,
    querySelector: () => null,
    querySelectorAll: (selector) => (String(selector).includes('div[style]') ? [frame] : []),
    body: null,
    documentElement: null
  }
  const { plugin, win } = runEntry({ userAgent: 'Mozilla/5.0 Chrome/152 Electron/44.0.0 Safari/537.36', document })
  const ctx = {
    slots: { inject: (_name, callback) => { callback(); return () => {} }, register: () => () => {} },
    get: (name) => (name === 'layout' ? { panels: { setRightbar: () => {}, setViewportWidth: () => {} } } : undefined)
  }
  plugin.apply(ctx)
  await tick()
  assert.equal(win.__DSH_BUBBLE_FOLD__.rightbar().ratio, 56, '900px of a 1600px frame')
})

test('the chosen width is forced with a stylesheet rule, not left to the host', async () => {
  // The host's third column is `minmax(0px, max)` — content-sized — so asking the
  // store for a bigger max does not widen it. The rule is what makes the chosen
  // ratio real.
  const { document, frame, created } = makeFrameDocument()
  const { plugin, win } = runEntry({ userAgent: 'Mozilla/5.0 Chrome/152 Electron/44.0.0 Safari/537.36', document })
  const ctx = {
    slots: { inject: (_name, callback) => { callback(); return () => {} }, register: () => () => {} },
    get: (name) => (name === 'layout' ? { panels: { setRightbar: () => {}, setViewportWidth: () => {} } } : undefined)
  }
  plugin.apply(ctx)
  await tick()
  const rule = created.find((el) => el.id === 'dsh-bubble-fold-frame')
  assert.ok(rule, '一条覆盖规则被写进 head')
  assert.match(rule.textContent, /!important/, '必须能压过宿主的内联样式')
  assert.match(rule.textContent, /720px/, '45% of a 1600px frame')
  assert.match(rule.textContent, /280px minmax\(400px, 1fr\)/, '另外两列原样保留')
  assert.equal(frame.attrs['data-lf-frame'], '1', '框架被标记')
  win.__DSH_BUBBLE_FOLD__.setRightbarRatio(60)
  assert.match(rule.textContent, /960px/, '改设置立刻重写规则')
})

test('a drag is adopted, and our own apply is not mistaken for one', async () => {
  const { document, frame } = makeFrameDocument()
  const { plugin, win, observers, emitMutations, fakeController } = runEntry({ userAgent: 'Mozilla/5.0 Chrome/152 Electron/44.0.0 Safari/537.36', document })
  const applied = []
  const ctx = {
    slots: { inject: (_name, callback) => { callback(); return () => {} }, register: () => () => {} },
    get: (name) => (name === 'layout' ? { panels: { setRightbar: (px) => applied.push(px), setViewportWidth: () => {} } } : undefined)
  }
  plugin.apply(ctx)
  await tick()
  // 两个观察者、两种职责：一个盯整棵文档里的内联 grid（框架可能被宿主整个换掉，
  // 绑在单个节点上会失灵），一个盯框架的直接子节点（右栏被卸载时靠它响应）。
  const watchesStyle = observers.some((ob) => [...ob.targets.values()]
    .some((cfg) => cfg.attributes === true && (cfg.attributeFilter ?? []).includes('style')))
  const watchesChildren = observers.some((ob) => [...ob.targets.values()]
    .some((cfg) => cfg.childList === true))
  assert.ok(watchesStyle, '必须有一个观察者的范围覆盖内联 grid（style）的变化')
  assert.ok(watchesChildren, '必须有一个观察者盯着框架的直接子节点')

  // Right after our own apply the host re-renders: that must NOT become the ratio.
  frame.style.gridTemplateColumns = '280px minmax(400px, 1fr) minmax(0px, 300px)'
  emitMutations(attrMutation(frame))
  assert.equal(fakeController.applied.length, 0, '自己的应用不算拖动')

  // A real drag, later: the host number changes and we adopt it.
  await new Promise((resolve) => setTimeout(resolve, 850))
  frame.style.gridTemplateColumns = '280px minmax(400px, 1fr) minmax(0px, 960px)'
  emitMutations(attrMutation(frame))
  assert.deepEqual(fakeController.applied.at(-1), { rightbarRatio: 60 }, '拖动写回设置（960 / 1600）')
  assert.equal(win.__DSH_BUBBLE_FOLD__.rightbar().ratio, 60, '读回也是 60%')
})

test('the stylesheet selects exactly the root attribute the plugin sets', async () => {
  // A rename once rewrote the CSS selectors but not the constant that sets the
  // attribute, so every rule in the plugin silently stopped matching and the
  // controls rendered as giant browser-default buttons. The unit suites cannot see
  // that (their DOM does no CSS matching), so the two are compared here.
  const fold = await readFile(path.join(here, '..', 'src', 'fold.js'), 'utf8')
  const browser = await readFile(path.join(here, '..', 'src', 'browser.js'), 'utf8')
  const declared = /ROOT_ATTRIBUTE = '([^']+)'/.exec(fold)?.[1]
  assert.ok(declared, 'ROOT_ATTRIBUTE 应能从 fold.js 读出')
  const used = [...new Set([...browser.matchAll(/:root\[(data-[a-z-]+)\]/g)].map((m) => m[1]))]
  assert.deepEqual(used, [declared], 'CSS 的 :root[...] 作用域必须与 ROOT_ATTRIBUTE 完全一致')
  const styleId = /STYLE_ID = '([^']+)'/.exec(fold)?.[1]
  assert.ok(browser.includes('F.STYLE_ID') || browser.includes(styleId), '样式标签 id 应来自 STYLE_ID')
})

test('closing the right panel releases the forced width, reopening restores it', async () => {
  // A forced `!important` column survives the host CLOSING the panel, and then the
  // conversation stays stuck at half width with no sidebar to explain it. Closing,
  // going fullscreen, or a zero-width column must always drop the rule.
  const { document, frame, created } = makeFrameDocument()
  const { plugin, emitMutations } = runEntry({ userAgent: 'Mozilla/5.0 Chrome/152 Electron/44.0.0 Safari/537.36', document })
  const ctx = {
    slots: { inject: (_name, callback) => { callback(); return () => {} }, register: () => () => {} },
    get: (name) => (name === 'layout' ? { panels: { setRightbar: () => {}, setViewportWidth: () => {} } } : undefined)
  }
  plugin.apply(ctx)
  await tick()
  const rule = created.find((el) => el.id === 'dsh-bubble-fold-frame')
  assert.ok(rule && /720px/.test(rule.textContent), '启动时强制了设定宽度')
  assert.equal(frame.attrs['data-lf-frame'], '1')

  // Closing: the host zeroes the third column and marks the frame collapsed.
  frame.attrs['data-rightbar-collapsed'] = '1'
  frame.style.gridTemplateColumns = '280px minmax(400px, 1fr) minmax(0px, 0px)'
  emitMutations(attrMutation(frame), attrMutation(frame, 'data-rightbar-collapsed'))
  assert.equal(rule.textContent, '', '关闭后必须撤掉强制宽度，否则主区域被占住')
  assert.equal(frame.attrs['data-lf-frame'], undefined, '框架标记也撤掉')

  // Reopening: the reader's own width comes back.
  delete frame.attrs['data-rightbar-collapsed']
  frame.style.gridTemplateColumns = '280px minmax(400px, 1fr) minmax(0px, 720px)'
  emitMutations(attrMutation(frame), attrMutation(frame, 'data-rightbar-collapsed'))
  assert.match(rule.textContent, /720px/, '重新打开时恢复')
  assert.equal(frame.attrs['data-lf-frame'], '1')
})

test('the forced-width rule releases itself in pure CSS when the host marks the panel closed', async () => {
  // 0.9.5 靠 JS 通知撤规则；2026-10-13 该 bug 复发说明通知可能根本收不到。
  // 规则选择器现在自带 :not([data-rightbar-collapsed]) / :not([data-rightbar-fullscreen])：
  // 宿主一打上标记，CSS 立刻不再匹配，不依赖任何 JS 事件。
  const { document, created } = makeFrameDocument()
  const { plugin } = runEntry({ userAgent: 'Mozilla/5.0 Chrome/152 Electron/44.0.0 Safari/537.36', document })
  plugin.apply({
    slots: { inject: (_name, callback) => { callback(); return () => {} }, register: () => () => {} },
    get: (name) => (name === 'layout' ? { panels: { setRightbar: () => {}, setViewportWidth: () => {} } } : undefined)
  })
  await tick()
  const rule = created.find((el) => el.id === 'dsh-bubble-fold-frame')
  assert.match(rule.textContent, /:not\(\[data-rightbar-collapsed\]\)/, '规则必须自带「收起即失效」')
  assert.match(rule.textContent, /:not\(\[data-rightbar-fullscreen\]\)/, '全屏同理')
})

test('a right panel whose content disappears releases the forced width', async () => {
  // 复发场景（2026-10-13 用户报告）：宿主收起右栏时既不改 frame 的 grid 模板、
  // 也不加 collapsed 属性，只把面板内容卸掉 —— 两个观察者都收不到通知，主区就
  // 永远停在半宽。几何自检兜底：连续两次看不到渲染出来的内容就撤规则。
  const { document, frame, created } = makeFrameDocument()
  const makeColumn = (descendants) => ({
    attrs: {},
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) },
    getAttribute(name) { return this.attrs[name] ?? null },
    getClientRects: () => [{ width: 300, height: 800 }],
    querySelectorAll: () => descendants
  })
  const content = [{ getClientRects: () => [{ width: 280, height: 700 }] }]
  frame.children = [makeColumn([]), makeColumn([]), makeColumn(content)]

  const { plugin, fireIntervals } = runEntry({ userAgent: 'Mozilla/5.0 Chrome/152 Electron/44.0.0 Safari/537.36', document })
  plugin.apply({
    slots: { inject: (_name, callback) => { callback(); return () => {} }, register: () => () => {} },
    get: (name) => (name === 'layout' ? { panels: { setRightbar: () => {}, setViewportWidth: () => {} } } : undefined)
  })
  await tick()
  const rule = created.find((el) => el.id === 'dsh-bubble-fold-frame')
  assert.match(rule.textContent, /720px/, '启动时强制了设定宽度')

  fireIntervals()
  fireIntervals()
  assert.match(rule.textContent, /720px/, '内容还在时自检不能误撤')

  content.length = 0
  fireIntervals()
  assert.match(rule.textContent, /720px/, '只空一次属于瞬时状态，先不撤')
  fireIntervals()
  assert.equal(rule.textContent, '', '连续两次看不到内容 → 撤掉强制宽度，主区回弹')
})

test('a host without panels.setRightbar degrades instead of throwing', () => {
  const { plugin, win } = runEntry({ userAgent: 'Mozilla/5.0 Chrome/152 Electron/44.0.0 Safari/537.36' })
  const ctx = {
    slots: { inject: (_name, callback) => { callback(); return () => {} }, register: () => () => {} },
    get: (name) => (name === 'layout' ? {} : undefined)
  }
  assert.doesNotThrow(() => plugin.apply(ctx), '没有设值入口也不能抛错')
  assert.equal(win.__DSH_BUBBLE_FOLD__.rightbar().supported, false, '如实汇报不支持')
  assert.doesNotThrow(() => win.__DSH_BUBBLE_FOLD__.setRightbarRatio(60))
})

test('a host without a slots service still gets the working fold', () => {
  const { plugin, win } = runEntry()
  plugin.apply(null)
  assert.equal(win.__DSH_BUBBLE_FOLD__.status, 'running')
  assert.equal(typeof win.__DSH_BUBBLE_FOLD__.update, 'function')
})

test('dispose tears the panels down and frees the console handle', () => {
  const { plugin, win, fakeController } = runEntry()
  const { ctx } = makeCtx()
  const off = plugin.apply(ctx)
  off()
  assert.equal(fakeController.disposed, true, 'the DOM controller was disposed')
  assert.equal(win.__DSH_BUBBLE_FOLD__, undefined, 'the console handle is gone')
})

await runAll()
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
