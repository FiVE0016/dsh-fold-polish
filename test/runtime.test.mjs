// Runtime checks against a fake DOM that mirrors the real DSH anchor contract.
// This is what proves the plugin wraps the right nodes and skips the wrong ones.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { start } from '../src/browser.js'

let passed = 0
let failed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

// ----------------------------------------------------------------- fake DOM
class FakeElement {
  constructor(tag, attrs = {}) {
    this.tagName = String(tag).toUpperCase()
    this.attrs = { ...attrs }
    this.children = []
    // Real DOM nodes expose both; plugin code may read either.
    this.parentElement = null
    this.parentNode = null
    this.style = {
      values: {},
      setProperty: (key, value) => { this.style.values[key] = String(value) },
      removeProperty: (key) => { delete this.style.values[key] }
    }
    this.textContent = ''
    this.hidden = false
    this.type = ''
    this.title = ''
    this.disabled = false
    this.value = ''
    this.checked = false
    this.scrollHeight = 0
    this.rectHeight = 0
    this.rectTop = 0
    this.clientWidth = 0
    this.computedOverflowY = null
    this.isConnected = true
  }

  get dataset() {
    const out = {}
    for (const [key, value] of Object.entries(this.attrs)) {
      if (key.startsWith('data-')) out[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
    }
    return out
  }

  hasAttribute(name) { return Object.hasOwn(this.attrs, name) }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null }
  // Attribute writes are counted *when the value actually changes*: the plugin's
  // own MutationObserver watches these attributes, so a same-value write is a
  // self-inflicted mutation that used to feed a scan loop.
  setAttribute(name, value) {
    const before = Object.hasOwn(this.attrs, name) ? this.attrs[name] : null
    const next = String(value)
    this.attrs[name] = next
    if (before !== next) this.attributeWrites = (this.attributeWrites ?? 0) + 1
  }
  removeAttribute(name) {
    if (!Object.hasOwn(this.attrs, name)) return
    delete this.attrs[name]
    this.attributeWrites = (this.attributeWrites ?? 0) + 1
  }
  // `hidden` is a REFLECTED property: writing the attribute must be visible
  // through the property and vice versa. Without this the fixture reports a row
  // as hidden right after the plugin un-hid it, which silently disabled every
  // expand path in the tests.
  get hidden() { return this.hasAttribute('hidden') }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden') }
  // Text lives as a plain property (the fixtures never model text nodes), and
  // textContent reads the subtree the way the DOM does: children first, a leaf's
  // own text last.
  get textContent() {
    const children = this.children ?? []
    if (children.length > 0) return children.map((child) => child.textContent ?? '').join('')
    return this._text ?? ''
  }
  set textContent(value) { this._text = value }
  // The DOM reflects `id` as both a property and an attribute. Keep them in sync
  // so code that assigns `.id` is exercised the way a browser would behave.
  get id() { return this.attrs.id ?? '' }
  set id(value) { this.attrs.id = String(value) }
  appendChild(child) {
    // A real append MOVES the node: detach it from its previous parent first.
    // Without this the fixture keeps it in two child lists at once and the
    // plugin looks broken when it is not.
    if (child.parentElement) child.remove()
    child.parentElement = this
    child.parentNode = this
    child.isConnected = true
    this.children.push(child)
    return child
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node) }
  insertBefore(child, reference) {
    // Insert AT the reference's position; a reference that is not a child (or is
    // null) means "append". Both parentNode and parentElement are maintained,
    // as the real DOM does.
    if (child.parentElement) child.remove()
    const index = reference ? this.children.indexOf(reference) : -1
    child.parentElement = this
    child.parentNode = this
    child.isConnected = true
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }
  remove() {
    if (!this.parentElement) return
    const index = this.parentElement.children.indexOf(this)
    if (index >= 0) this.parentElement.children.splice(index, 1)
    this.parentElement = null
    this.parentNode = null
    this.isConnected = false
  }
  get firstElementChild() { return this.children[0] ?? null }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null }
  // Sibling navigation, as the real DOM reflects it. The process-block walk needs
  // these to group the step rows that sit between two message bubbles.
  get nextElementSibling() {
    const siblings = this.parentElement?.children
    if (!siblings) return null
    const index = siblings.indexOf(this)
    return index >= 0 ? siblings[index + 1] ?? null : null
  }
  get previousElementSibling() {
    const siblings = this.parentElement?.children
    if (!siblings) return null
    const index = siblings.indexOf(this)
    return index > 0 ? siblings[index - 1] : null
  }
  getBoundingClientRect() {
    // Clamping is driven by the wrapper's own variable, and the visible box is
    // exactly the line budget: the control row below is real flow, not overlay.
    let height = this.rectHeight
    const wrapper = this.parentElement
    if (this.hasAttribute('data-lf-clamped') && this.getAttribute('data-lf-open') !== '1' && wrapper) {
      const budget = Number.parseFloat(wrapper.style.values['--lf-clamp-height'])
      if (Number.isFinite(budget)) height = Math.min(height, budget)
    }
    // An inline min-height (the composer scroll area, while manually sized) is
    // part of layout, so the rect must reflect it.
    const minHeight = Number.parseFloat(this.style.values['min-height'])
    if (Number.isFinite(minHeight)) height = Math.max(height, minHeight)
    // `top`/`bottom` drive the visibility gate; fixtures sit on screen by default
    // and can be pushed off screen with `data-lf-offscreen`.
    const offscreen = this.hasAttribute('data-lf-offscreen')
    const top = offscreen ? -5000 : this.rectTop
    return { top, bottom: top + height, left: 0, right: 700, height, width: 700 }
  }
  querySelectorAll(selector) { return collect(this, selector, true) }
  querySelector(selector) { return collect(this, selector, true)[0] ?? null }
  closest(selector) { return closestMatch(this, selector) }
  addEventListener(type, handler) {
    if (!this.listeners) this.listeners = new Map()
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }
  /** Dispatch to this element's own handlers, whatever the event type. */
  fireEvent(type, event = {}) {
    for (const handler of this.listeners?.get(type) ?? []) {
      handler({ target: this, currentTarget: this, ...event })
    }
  }
  /** Dispatch to this element's own handlers, like a real user click. */
  click() {
    this.fireEvent('click')
  }
  get scrollTop() { return this.scrolledTo ?? 0 }
  set scrollTop(value) { this.scrolledTo = value }
  getContext() { return null }
}

const parseSimple = (selector) => {
  // Minimal CSS subset: "*", "tag", "[attr]", '[attr="value"]', and comma groups.
  if (selector.trim() === '*') return { tag: null, attrs: [], any: true }
  const match = /^([a-zA-Z]+)?((?:\[[^\]]*\])*)$/.exec(selector.trim())
  if (!match) return null
  const attrs = [...match[2].matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)]
    .map(([, name, value]) => ({ name, value }))
  return { tag: match[1]?.toUpperCase() ?? null, attrs, any: false }
}

const matchesSimple = (element, selector) => {
  const parsed = parseSimple(selector)
  if (!parsed) return false
  if (parsed.any) return true
  if (parsed.tag && element.tagName !== parsed.tag) return false
  return parsed.attrs.every(({ name, value }) => (
    value === undefined ? element.hasAttribute(name) : element.getAttribute(name) === value
  ))
}

/** Selector groups plus descendant combinators: "A B" means B inside A. */
const matches = (element, selector) => selector.split(',').some((group) => {
  const parts = group.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return false
  if (!matchesSimple(element, parts[parts.length - 1])) return false
  let node = element.parentElement
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    let found = false
    while (node) {
      if (matchesSimple(node, parts[i])) { found = true; node = node.parentElement; break }
      node = node.parentElement
    }
    if (!found) return false
  }
  return true
})
const closestMatch = (element, selector) => {
  let node = element
  while (node) {
    if (matches(node, selector)) return node
    node = node.parentElement
  }
  return null
}

const collect = (root, selector, deep) => {
  const out = []
  for (const child of root.children) {
    // querySelectorAll never returns the context node itself, only descendants.
    if (matches(child, selector)) out.push(child)
    if (deep) out.push(...collect(child, selector, true))
  }
  return out
}

// ------------------------------------------------------------- DOM fixtures
function buildFixture() {
  const html = new FakeElement('html')
  const head = new FakeElement('head')
  const body = new FakeElement('body')
  html.append(head, body)
  const scroll = new FakeElement('div', { 'data-conversation-scroll': '' })
  body.appendChild(scroll)

  const flowItem = (attrs) => {
    const item = new FakeElement('div', { 'data-chat-flow-kind': '', ...attrs })
    scroll.appendChild(item)
    return item
  }

  // user input: anchor > userRow > userStack > bubble
  const user = (attrs = {}, height = 480, attachment = false) => {
    const anchor = flowItem({ 'data-chat-flow-kind': 'user', 'data-chat-anchor-key': 'user:1', ...attrs })
    const row = anchor.appendChild(new FakeElement('div'))
    const stack = row.appendChild(new FakeElement('div'))
    // The host renders attachments as a sibling BEFORE the text bubble.
    if (attachment) stack.appendChild(new FakeElement('div', { 'data-message-attachments': 'true' }))
    const bubble = stack.appendChild(new FakeElement('div'))
    bubble.scrollHeight = height
    bubble.rectHeight = height
    return { anchor, bubble }
  }

  // assistant reply: anchor > markdownRoot[data-streaming?] > body
  const assistant = (attrs = {}, height = 900, streaming = false) => {
    const anchor = flowItem({ 'data-chat-flow-kind': 'assistant-step', 'data-chat-anchor-key': 'a:1', ...attrs })
    const root = anchor.appendChild(new FakeElement('div', streaming ? { 'data-streaming': '' } : {}))
    const markdown = root.appendChild(new FakeElement('div'))
    markdown.scrollHeight = height
    markdown.rectHeight = height
    return { anchor, markdown, root }
  }

  return { html, body, scroll, user, assistant }
}

// Mirrors the browser's brand check: `getComputedStyle` may only be called with a
// window as its receiver. This deliberately does NOT compare against a specific
// window object — several fixtures exist at once and any of them is a legal
// receiver; what must throw is an unbound call or one bound to `globalThis`.
// That is exactly how the real bug reached a user: the entry read the bare
// `getComputedStyle` global, which works in a harness and dies in the page.
let activeWindow = null

function makeWindow(html) {
  const listeners = { document: new Map(), window: new Map() }
  const record = (bag, type, handler) => {
    if (!bag.has(type)) bag.set(type, [])
    bag.get(type).push(handler)
  }
  const doc = {
    documentElement: html,
    head: html.children[0],
    body: html.children[1],
    activeElement: null,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => collect(html, `[id="${id}"]`, true)[0] ?? null,
    querySelectorAll: (selector) => collect(html, selector, true),
    querySelector: (selector) => collect(html, selector, true)[0] ?? null,
    addEventListener: (type, handler) => record(listeners.document, type, handler),
    removeEventListener: (type, handler) => {
      const bag = listeners.document.get(type) ?? []
      const index = bag.indexOf(handler)
      if (index >= 0) bag.splice(index, 1)
    }
  }
  return {
    document: doc,
    listeners,
    innerHeight: 800,
    performance: { now: () => Date.now() },
    localStorage: {
      store: new Map(),
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
      setItem(key, value) { this.store.set(key, String(value)) },
      removeItem(key) { this.store.delete(key) }
    },
    // Mirrors the browser: getComputedStyle is brand-checked on its receiver, so
    // an unbound or mis-bound reference throws exactly like Chrome's
    // "Illegal invocation". Without this the harness silently accepts code that
    // dies in a real page.
    getComputedStyle(styleTarget) {
      if (this === undefined || this === null || this === globalThis) {
        throw new TypeError('Illegal invocation (getComputedStyle called without a window receiver)')
      }
      return {
        lineHeight: '22px',
        fontSize: '14px',
        backgroundColor: 'rgb(255, 255, 255)',
        overflowY: styleTarget?.computedOverflowY ?? 'visible',
        getPropertyValue: () => '0px'
      }
    },
    requestAnimationFrame: (fn) => { fn(); return 1 },
    setTimeout: (fn) => { fn(); return 1 },
    clearTimeout() {},
    addEventListener: (type, handler) => record(listeners.window, type, handler),
    removeEventListener: (type, handler) => {
      const bag = listeners.window.get(type) ?? []
      const index = bag.indexOf(handler)
      if (index >= 0) bag.splice(index, 1)
    },
    MutationObserver: class { observe() {} disconnect() {} },
    HTMLElement: FakeElement,
    Element: FakeElement,
    __DSH_BUBBLE_FOLD_MODULES__: {}
  }
  doc.defaultView = win
  activeWindow = win
  return win
}

// Every browser global the bundle reads by bare name. The host calls the factory
// in a page where these exist; a plain Node run has to provide them.
const BROWSER_GLOBALS = [
  'document',
  'localStorage',
  'getComputedStyle',
  'requestAnimationFrame',
  'setTimeout',
  'clearTimeout',
  'MutationObserver',
  'HTMLElement',
  'Element'
]

const withBrowserGlobals = (win, fn) => {
  const saved = new Map()
  for (const name of BROWSER_GLOBALS) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      value: name === 'document' ? win.document : win[name],
      configurable: true,
      writable: true
    })
  }
  try {
    return fn()
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
}

/** Fire a delegated handler the way the browser would. */
const fire = (win, bag, type, event) => {
  for (const handler of win.listeners[bag].get(type) ?? []) handler(event)
  return event
}

async function boot(fixture, settings, stored) {
  const win = makeWindow(fixture.html)
  win.__DSH_BUBBLE_FOLD_DEBUG__ = []
  const fold = await import('../src/fold.js')
  win.__DSH_BUBBLE_FOLD_MODULES__ = { fold }
  // Stored settings are read AT STARTUP, before the first scan: a case that is
  // about the start-up policy has to seed storage, because update() runs after
  // that first pass has already acted.
  if (stored) win.localStorage.setItem('dsh.bubble-fold.settings', JSON.stringify(stored))
  const controller = start(win, {})
  if (settings) controller.update(settings)
  controller.rescan()
  return { win, controller }
}

// ------------------------------------------------------------------- checks
console.log('wrapping')
{
  const fixture = buildFixture()
  const long = fixture.user({}, 600)
  const short = fixture.user({ 'data-chat-anchor-key': 'user:2' }, 60)
  const { controller } = await boot(fixture)

  test('an overlong message is clamped and offered a toggle', () => {
    assert.equal(long.bubble.getAttribute('data-lf-clamped'), '1')
    assert.equal(long.bubble.parentElement.getAttribute('data-lf-body'), 'user')
  })
  test('a short message is wrapped but never clamped', () => {
    const wrapper = short.bubble.parentElement
    assert.equal(wrapper.getAttribute('data-lf-body'), 'user', 'wrapped so measurement is uniform')
    assert.equal(short.bubble.hasAttribute('data-lf-clamped'), false, 'no max-height applied')
    const toggle = short.anchor.querySelector('[data-lf-toggle]')
    assert.equal(toggle.parentElement.hidden, true, 'no affordance shown')
    // It keeps its natural height: clamp styles must not be reachable.
    assert.equal(short.bubble.getBoundingClientRect().height, short.bubble.scrollHeight)
  })
  test('adds exactly one toggle per message', () => {
    assert.equal(long.anchor.querySelectorAll('[data-lf-toggle]').length, 1)
    assert.equal(short.anchor.querySelectorAll('[data-lf-toggle]').length, 1)
  })
  test('the clamp box is the line budget and the gap lives on the control row', () => {
    const wrapper = long.bubble.parentElement
    // 6 lines * 22px of visible text, and nothing else inside the box.
    assert.equal(wrapper.style.values['--lf-clamp-height'], '132px')
    // The gap belongs to the control row, which sits below the message in flow.
    const tail = long.anchor.querySelector('[data-lf-tail="user"]')
    assert.equal(tail.style.values['--lf-gap'], '8px')
  })
  test('the control row cannot sit on the message it folds', () => {
    // Real flow: the row starts at or below the bottom of the clamped box.
    const tail = long.anchor.querySelector('[data-lf-tail="user"]')
    assert.equal(tail.parentElement, long.anchor, 'the row is a sibling of the message, not an overlay')
    assert.equal(tail.hasAttribute('data-lf-float'), false, 'nothing is positioned over the bubble')
  })
  test('labels the affordance with what is hidden', () => {
    const toggle = long.anchor.querySelector('[data-lf-toggle]')
    // 600px of content inside a 132px box of six lines.
    assert.match(toggle.querySelector('[data-lf-label]').textContent, /展开我的输入 · 还有 21 行/)
  })
  test('clamping is reversible', () => {
    controller.dispose()
    assert.equal(long.bubble.getAttribute('data-lf-clamped'), null)
    assert.equal(long.anchor.querySelectorAll('[data-lf-toggle]').length, 0)
  })
}

console.log('folding on a paragraph boundary')
{
  const fixture = buildFixture()
  const mine = fixture.user({}, 200)
  // Four 50px blocks. The line budget is 6 * 22 = 132px, which would slice the
  // third block through the middle — the fold has to land on the 100px boundary
  // the blocks actually end on, with no fade needed to hide a cut line.
  for (const [index, height] of [50, 50, 50, 50].entries()) {
    const block = mine.bubble.appendChild(new FakeElement('div'))
    block.rectHeight = height
    block.rectTop = index * height
  }
  await boot(fixture)

  test('the clamp box lands on a block boundary, not mid-block', () => {
    assert.equal(mine.bubble.getAttribute('data-lf-clamped'), '1')
    assert.equal(mine.bubble.parentElement.style.values['--lf-clamp-height'], '100px')
  })
  test('the control row still sits clear of the message', () => {
    const tail = mine.anchor.querySelector('[data-lf-tail="user"]')
    assert.equal(tail.style.values['--lf-gap'], '8px')
    assert.equal(tail.hidden, false)
  })
}

console.log('folding through a single wrapper')
{
  const fixture = buildFixture()
  const mine = fixture.user({}, 200)
  // A message body is often ONE container around the real paragraphs, so the
  // boundary search has to descend into it: same four 50px blocks, one level in.
  const wrapper = mine.bubble.appendChild(new FakeElement('div'))
  wrapper.rectHeight = 200
  wrapper.rectTop = 0
  for (const [index, height] of [50, 50, 50, 50].entries()) {
    const block = wrapper.appendChild(new FakeElement('div'))
    block.rectHeight = height
    block.rectTop = index * height
  }
  await boot(fixture)

  test('a wrapped body still folds on the inner boundary', () => {
    assert.equal(mine.bubble.getAttribute('data-lf-clamped'), '1')
    assert.equal(mine.bubble.parentElement.style.values['--lf-clamp-height'], '100px')
  })
}

console.log('assistant side')
{
  const fixture = buildFixture()
  const reply = fixture.assistant({}, 900)
  const streaming = fixture.assistant({ 'data-chat-anchor-key': 'a:2' }, 900, true)
  await boot(fixture)

  test('wraps a settled long reply', () => {
    assert.equal(reply.markdown.getAttribute('data-lf-clamped'), '1')
    assert.equal(reply.markdown.parentElement.getAttribute('data-lf-body'), 'assistant')
  })
  test('never clamps a streaming reply', () => {
    assert.equal(streaming.markdown.getAttribute('data-lf-clamped'), null)
  })
  test('uses the assistant line budget', () => {
    // 10 lines * 22px, and the gap is tracked on the control row instead.
    assert.equal(reply.markdown.parentElement.style.values['--lf-clamp-height'], '220px')
    assert.equal(reply.anchor.querySelector('[data-lf-tail="assistant"]').style.values['--lf-gap'], '8px')
  })
}

console.log('skipping what must not be folded')
{
  const fixture = buildFixture()
  // A tool card inside a folded process envelope, and one marked hidden.
  const hidden = fixture.assistant({ 'data-turn-process-hidden': '' }, 900)
  const answer = fixture.assistant({ 'data-turn-process-answer': '' }, 900)
  const streamed = fixture.assistant({}, 900, true)
  await boot(fixture)

  test('skips process members hidden inside a turn envelope', () => {
    const toggle = hidden.anchor.querySelector('[data-lf-toggle]')
    assert.equal(hidden.markdown.hasAttribute('data-lf-clamped'), false)
    assert.equal(toggle, null)
  })
  test('skips the compact answer stub the host renders', () => {
    const toggle = answer.anchor.querySelector('[data-lf-toggle]')
    assert.equal(answer.markdown.hasAttribute('data-lf-clamped'), false)
    assert.equal(toggle, null)
  })
  test('skips streaming content', () => {
    assert.equal(streamed.markdown.getAttribute('data-lf-clamped'), null)
  })
  test('leaves unrelated flow kinds alone', () => {
    const fixture2 = buildFixture()
    const other = fixture2.scroll.appendChild(new FakeElement('div', { 'data-chat-flow-kind': 'tool-call' }))
    const body = other.appendChild(new FakeElement('div'))
    body.scrollHeight = 900
    // boot() above already ran against fixture; a fresh boot sees the new node.
    return boot(fixture2).then(() => {
      assert.equal(body.getAttribute('data-lf-clamped'), null)
    })
  })
}

console.log('settings behaviour')
{
  const fixture = buildFixture()
  const mine = fixture.user({}, 600)
  const theirs = fixture.assistant({}, 900)
  const { controller } = await boot(fixture, { userEnabled: false })

  test('honours the per-side switch', () => {
    assert.equal(mine.bubble.getAttribute('data-lf-clamped'), null)
    assert.equal(theirs.markdown.getAttribute('data-lf-clamped'), '1')
  })
  test('disable-everything restores the stock transcript', () => {
    controller.update({ enabled: false })
    assert.equal(theirs.markdown.getAttribute('data-lf-clamped'), null)
  })
  test('collapseAll clamps even short messages', () => {
    const fixture3 = buildFixture()
    const short = fixture3.user({}, 100)
    return boot(fixture3, { collapseAll: true, collapsedLines: 3 }).then(() => {
      // 3 lines * 22px + 34px = 100px, so a 100px message is right at the edge.
      assert.equal(short.bubble.parentElement.style.values['--lf-clamp-height'], '100px')
      assert.equal(short.anchor.querySelector('[data-lf-toggle]').parentElement.hidden, true)
    })
  })

  const fixture4 = buildFixture()
  const target = fixture4.user({}, 600)
  const controller4 = (await boot(fixture4)).controller
  test('toggle click expands and collapses in place', () => {
    const toggle = target.anchor.querySelector('[data-lf-toggle]')
    const body = target.bubble
    body.setAttribute('data-lf-open', '0')
    assert.equal(body.getAttribute('data-lf-open'), '0')
    // Exercise the same code path the click handler uses.
    controller4.update({ userLines: 20 })
    assert.equal(body.parentElement.style.values['--lf-clamp-height'], '440px')
  })
  test('invalid settings are corrected, not trusted', () => {
    controller4.update({ userLines: -5 })
    assert.equal(controller4.settings().userLines, 2)
  })
}

console.log('interaction')
{
  const fixture = buildFixture()
  const mine = fixture.user({}, 600)
  const reply = fixture.assistant({}, 900)
  const { win, controller } = await boot(fixture)

  test('clicking the toggle expands in place', () => {
    const toggle = mine.anchor.querySelector('[data-lf-toggle]')
    fire(win, 'document', 'click', { target: toggle })
    assert.equal(mine.bubble.getAttribute('data-lf-open'), '1')
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(toggle.querySelector('[data-lf-label]').textContent, '收起')
  })
  test('clicking again collapses', () => {
    const toggle = mine.anchor.querySelector('[data-lf-toggle]')
    fire(win, 'document', 'click', { target: toggle })
    assert.equal(mine.bubble.getAttribute('data-lf-open'), '0')
    assert.match(toggle.querySelector('[data-lf-label]').textContent, /展开我的输入/)
  })
  test('a message row holds its own toggle and nothing else', () => {
    const row = mine.anchor.querySelector('[data-lf-tail="user"]')
    assert.equal(row.children.length, 1, 'one control per folded message')
    assert.equal(row.firstElementChild.getAttribute('data-lf-toggle'), '1')
    assert.equal(row.querySelector('[data-lf-copy]'), null, 'copying is the host own action, not ours')
    assert.equal(row.querySelector('[data-lf-group]'), null, 'no group buttons anywhere')
  })
  test('toggling one bubble leaves the other one alone', () => {
    const toggle = mine.anchor.querySelector('[data-lf-toggle]')
    fire(win, 'document', 'click', { target: toggle })
    assert.equal(mine.bubble.getAttribute('data-lf-open'), '1')
    assert.equal(reply.markdown.getAttribute('data-lf-open'), '0', 'the reply is untouched')
    fire(win, 'document', 'click', { target: toggle })
    assert.equal(mine.bubble.getAttribute('data-lf-open'), '0')
  })
  test('nothing floats over the composer any more', () => {
    // The removed bar was position:fixed above the input box and covered it.
    assert.equal(win.document.body.querySelector('[data-lf-toolbar]'), null, 'no floating toolbar')
    assert.equal(win.document.body.querySelector('[data-lf-count]'), null, 'no "无折叠" pill')
    assert.equal(win.document.body.querySelector('[data-lf-group]'), null, 'no bulk buttons')
  })
  test('no global keyboard gesture changes the plugin (2026-10-13: all shortcuts removed)', () => {
    // 全部全局快捷键已移除（原 Ctrl+Shift+, 开面板 / Ctrl+Shift+B 总开关 /
    // Ctrl+Shift+↑↓ 调高度）：任何组合键都不再打开面板、切换开关或改变
    // 任何设置——一切走宿主「设置 → 插件 → UI 美化」tab。
    for (const key of [',', 'B', 'b', 'ArrowUp', 'ArrowDown', 'f']) {
      let prevented = false
      fire(win, 'document', 'keydown', { ctrlKey: true, shiftKey: true, altKey: false, key, preventDefault() { prevented = true } })
      assert.equal(prevented, false, `Ctrl+Shift+${key} is not consumed`)
    }
    assert.equal(controller.settings().enabled, true, 'the plugin stays on')
    assert.equal(win.document.body.querySelector('[data-lf-panel]'), null, 'the panel never opens from the keyboard')
  })
}

console.log('work-step (host-owned) folding')
{
  // The host renders each Turn's disclosure as <button data-turn-process data-open?>
  // and hides that Turn's member rows itself. The plugin must never invent that
  // state: it puts ONE seam between a run of step rows and the message bubble
  // that follows them, and that seam clicks the host controls the run covers.
  const fixture = buildFixture()
  const blocks = []
  /**
   * One process block in DOM order: summary row, member steps, then the reply.
   * `withAnswer: false` models a Turn still running (nothing to attach to yet).
   */
  /**
   * One process block in DOM order: summary row, step rows, then the reply.
   * `withAnswer: false` models a Turn still running (nothing to attach to yet).
   * `grouped` nests the steps in a `[data-step-process]` container the way the
   * host does in its work-details compact/standard modes; `expandedMode` marks a
   * container the host renders inline (verbose), which has no disclosure at all.
   */
  const addBlock = (turn, {
    open,
    members = 2,
    withAnswer = true,
    collapsible = true,
    grouped = false,
    expandedMode = false
  } = {}) => {
    const summary = fixture.scroll.appendChild(new FakeElement('div', {
      'data-chat-flow-kind': 'turn-process',
      'data-chat-anchor-key': `turn-process:${turn}`
    }))
    const control = summary.appendChild(new FakeElement('button', { 'data-turn-process': String(turn) }))
    if (collapsible) control.setAttribute('aria-expanded', String(Boolean(open)))
    if (open) control.setAttribute('data-open', '1')
    const nativeClicks = []
    const steps = []
    const setStepsHidden = (hidden) => {
      for (const step of steps) {
        if (hidden) step.setAttribute('hidden', 'until-found')
        else step.removeAttribute('hidden')
      }
    }
    control.addEventListener('click', () => {
      if (control.disabled) return
      nativeClicks.push(control.hasAttribute('data-open'))
      if (control.hasAttribute('data-open')) control.removeAttribute('data-open')
      else control.setAttribute('data-open', '1')
      // The host hides and reveals the member rows in the same update.
      setStepsHidden(!control.hasAttribute('data-open'))
    })

    let container = null
    let header = null
    const groupClicks = []
    let stepHost = fixture.scroll
    if (grouped) {
      container = fixture.scroll.appendChild(new FakeElement('div', {
        'data-chat-group-key': `group:${turn}`,
        'data-chat-flow-key': `group:${turn}`,
        'data-chat-anchor-key': `group:${turn}`,
        'data-step-process': 'true'
      }))
      if (expandedMode) container.setAttribute('data-group-expanded-mode', 'true')
      const headerWrap = container.appendChild(new FakeElement('div'))
      // The host hides the header whenever the container renders inline.
      if (expandedMode) headerWrap.setAttribute('hidden', 'until-found')
      header = headerWrap.appendChild(new FakeElement('button', { 'aria-expanded': String(open) }))
      header.appendChild(new FakeElement('span', { 'data-step-process-icon': 'true' }))
      header.addEventListener('click', () => {
        const next = header.getAttribute('aria-expanded') !== 'true'
        groupClicks.push(next)
        header.setAttribute('aria-expanded', String(next))
        setStepsHidden(!next)
      })
      const body = container.appendChild(new FakeElement('div', { 'data-step-process-body': 'true' }))
      stepHost = body.appendChild(new FakeElement('div', { 'data-step-process-content': 'true' }))
    }

    for (let index = 0; index < members; index += 1) {
      const step = stepHost.appendChild(new FakeElement('div', {
        'data-chat-flow-kind': 'tool-call',
        'data-turn-process-member': 'true',
        'data-chat-anchor-key': `member:${turn}:${index}`
      }))
      steps.push(step)
    }
    if (!open) setStepsHidden(true)

    const answer = withAnswer
      ? fixture.scroll.appendChild(new FakeElement('div', {
        'data-chat-flow-kind': 'assistant-step',
        'data-chat-anchor-key': `answer:${turn}`
      }))
      : null
    const block = { summary, control, steps, answer, nativeClicks, container, header, groupClicks }
    blocks.push(block)
    return block
  }

  // Turn 1 and Turn 2 run back to back with no reply between them: one block,
  // exactly the long step list the seam has to fold in a single click.
  const first = addBlock(1, { open: true, withAnswer: false })
  const second = addBlock(2, { open: true })
  // A separate turn with its own reply: a second, independent seam.
  const third = addBlock(3, { open: false, members: 1 })
  // A summary row the host refuses to fold (work-details verbose): the plugin
  // folds those rows itself instead of leaving a dead control.
  const stale = addBlock(5, { open: true, members: 2, collapsible: false })
  // Work-details compact/standard: the steps are nested in a step container and
  // that container's own header is the disclosure.
  const grouped = addBlock(6, { open: true, members: 2, collapsible: false, grouped: true })
  // A container the host renders inline (verbose grouping): no disclosure there
  // either, so the plugin folds it itself.
  const inline = addBlock(7, { open: true, members: 2, collapsible: false, grouped: true, expandedMode: true })
  // A running turn: its steps are the last thing in the conversation.
  const running = addBlock(4, { open: true, withAnswer: false })

  // Boot with the default-fold policy OFF (seeded in storage, because it is read
  // before the first scan): these cases are about how one seam maps to host state,
  // and the default policy itself is covered further down.
  const { win, controller } = await boot(fixture, null, { foldAllSteps: false })

  // A seam is a line: the hairline container the plugin inserts above the reply,
  // with the block's own bubble toggle on it (and, on a Turn's last seam, the
  // Turn-wide control beside that bubble).
  const lineOf = (answer) => answer.previousElementSibling
  const seamOf = (answer) => lineOf(answer).querySelector('[data-lf-step-toggle]')
  const seams = () => fixture.scroll.querySelectorAll('[data-lf-step-toggle]')

  test('one seam per block, placed between the steps and the reply', () => {
    assert.equal(seams().length, 5, 'every block that can be folded gets exactly one seam')
    const line = lineOf(third.answer)
    const seam = seamOf(third.answer)
    assert.equal(line.hasAttribute('data-lf-step-line'), true)
    assert.equal(line.nextElementSibling, third.answer, 'sits immediately above the reply')
    assert.equal(line.previousElementSibling, third.steps[third.steps.length - 1], 'and after the last step row')
    assert.equal(seam.querySelector('[data-lf-label]'), null, 'icon-only bubble, no text pill')
    assert.match(seam.querySelector('[data-lf-icon]').innerHTML, /<svg/, 'the icon holder carries the glyph')
  })
  test('a run of steps spanning several turns folds as one block', () => {
    const line = lineOf(second.answer)
    const seam = seamOf(second.answer)
    assert.equal(line.nextElementSibling, second.answer)
    assert.equal(line.previousElementSibling, second.steps[second.steps.length - 1], 'covers both turns')
    assert.equal(seam.getAttribute('aria-label'), '收起本步骤', 'both turns are open')
    assert.equal(seam.getAttribute('data-lf-step-open'), '1')
  })
  test('the seam folds every host control the block covers', () => {
    const seam = seamOf(second.answer)
    fire(win, 'document', 'click', { target: seam })
    assert.equal(first.nativeClicks.length, 1, 'turn 1 was told to close')
    assert.equal(second.nativeClicks.length, 1, 'turn 2 was told to close')
    assert.equal(first.control.hasAttribute('data-open'), false)
    assert.equal(second.control.hasAttribute('data-open'), false)
    assert.equal(third.nativeClicks.length, 0, 'the other block is untouched')
    assert.equal(third.control.hasAttribute('data-open'), false, 'and keeps its own state')
  })
  test('its state follows the host on the next scan', () => {
    controller.rescan()
    const seam = seamOf(second.answer)
    assert.equal(seam.getAttribute('aria-label'), '展开本步骤', 'now closed, so it offers to open')
    assert.equal(seam.getAttribute('data-lf-step-open'), '0')
    fire(win, 'document', 'click', { target: seam })
    assert.equal(first.control.hasAttribute('data-open'), true, 'one click reopens the whole run')
    assert.equal(second.control.hasAttribute('data-open'), true)
  })
  test('a collapsed turn still gets a seam: that is how it reopens', () => {
    const seam = seamOf(third.answer)
    assert.ok(seam, 'seam exists while the steps are hidden')
    assert.equal(seam.getAttribute('aria-label'), '展开本步骤')
    assert.equal(third.steps[0].getAttribute('hidden'), 'until-found', 'the host hides the rows, not us')
    fire(win, 'document', 'click', { target: seam })
    assert.equal(third.control.hasAttribute('data-open'), true)
  })
  test('a block the host will not fold is folded by the plugin itself', () => {
    const seam = seamOf(stale.answer)
    assert.ok(seam, 'the seam exists even though the host control is dead')
    assert.equal(stale.summary.hasAttribute('data-lf-step-folded'), false, 'nothing hidden yet')
    assert.equal(seam.getAttribute('aria-label'), '收起本步骤', 'the rows are visible, so it offers to fold them')
    fire(win, 'document', 'click', { target: seam })
    assert.equal(stale.summary.getAttribute('data-lf-step-folded'), '1', 'the summary row is folded')
    assert.equal(stale.steps[0].getAttribute('data-lf-step-folded'), '1', 'and so are its step rows')
    assert.equal(stale.nativeClicks.length, 0, 'the disabled host control was never clicked')
    assert.equal(seam.getAttribute('aria-label'), '展开本步骤')
    assert.match(seam.getAttribute('title'), /2 步/)
    fire(win, 'document', 'click', { target: seam })
    assert.equal(stale.summary.hasAttribute('data-lf-step-folded'), false, 'one click brings it back')
    assert.equal(stale.steps[0].hasAttribute('data-lf-step-folded'), false)
  })
  test('a grouped step container is folded through its own header', () => {
    const seam = seamOf(grouped.answer)
    assert.ok(seam, 'the container is treated as one block')
    assert.equal(lineOf(grouped.answer).previousElementSibling, grouped.container, 'the seam sits below the whole container')
    assert.equal(seam.getAttribute('aria-label'), '收起本步骤', 'the group header says open')
    fire(win, 'document', 'click', { target: seam })
    assert.equal(grouped.groupClicks.length, 1, 'the group header was clicked')
    assert.equal(grouped.header.getAttribute('aria-expanded'), 'false')
    assert.equal(grouped.steps[0].getAttribute('hidden'), 'until-found', 'the host hides its own members')
    controller.rescan()
    assert.equal(seam.getAttribute('aria-label'), '展开本步骤')
    fire(win, 'document', 'click', { target: seam })
    assert.equal(grouped.header.getAttribute('aria-expanded'), 'true', 'one click reopens the group')
  })
  test('a container the host renders inline is folded by the plugin', () => {
    const seam = seamOf(inline.answer)
    assert.ok(seam)
    assert.equal(inline.groupClicks.length, 0, 'an inline container has no disclosure to click')
    fire(win, 'document', 'click', { target: seam })
    // Hiding the container hides the rows nested inside it; no per-row write.
    assert.equal(inline.container.getAttribute('data-lf-step-folded'), '1')
    assert.equal(inline.steps[1].closest('[data-step-process]'), inline.container, 'the rows live inside that container')
    assert.equal(seam.getAttribute('aria-label'), '展开本步骤')
    fire(win, 'document', 'click', { target: seam })
    assert.equal(inline.container.hasAttribute('data-lf-step-folded'), false)
  })
  test('a running turn has no seam until its reply lands', () => {
    assert.equal(running.answer, null)
    const lastStep = running.steps[running.steps.length - 1]
    assert.equal(fixture.scroll.children.includes(lastStep), true)
    assert.equal(lastStep.nextElementSibling, null, 'nothing injected after the last step')
  })
  test('the seam is remade when the host re-renders it away', () => {
    const line = lineOf(third.answer)
    line.remove()
    controller.rescan()
    assert.ok(seamOf(third.answer))
  })
  test('disabling workStepButtons removes every seam and every fold mark', () => {
    // Fold one block first so there is a mark to clean up.
    const seam = seamOf(stale.answer)
    if (seam.getAttribute('aria-label') === '收起本步骤') fire(win, 'document', 'click', { target: seam })
    assert.equal(stale.steps[0].getAttribute('data-lf-step-folded'), '1')
    controller.update({ workStepButtons: false })
    assert.equal(seams().length, 0)
    assert.equal(fixture.scroll.querySelectorAll('[data-lf-step-folded]').length, 0, 'no row stays hidden')
  })
  test('a print pass unfolds the rows the plugin hides itself, then puts them back', () => {
    // The previous case turned the seams off; this one needs them back.
    controller.update({ workStepButtons: true })
    const seam = seamOf(stale.answer)
    assert.ok(seam, 'the seam is back with the setting')
    if (seam.getAttribute('aria-label') === '收起本步骤') fire(win, 'document', 'click', { target: seam })
    assert.equal(stale.summary.getAttribute('data-lf-step-folded'), '1', 'folded before printing')
    fire(win, 'window', 'beforeprint', {})
    assert.equal(stale.summary.hasAttribute('data-lf-step-folded'), false, 'the print pass reveals them')
    assert.equal(stale.steps[0].hasAttribute('data-lf-step-folded'), false)
    fire(win, 'window', 'afterprint', {})
    assert.equal(stale.summary.getAttribute('data-lf-step-folded'), '1', 'the fold returns after printing')
    assert.equal(stale.steps[0].getAttribute('data-lf-step-folded'), '1')
  })
}

console.log('the three seam controls of a Turn')
{
  const fixture = buildFixture()
  const TURN = '9'
  const OTHER = '10'
  const mkBlock = (turn, key, { open = true } = {}) => {
    const summary = fixture.scroll.appendChild(new FakeElement('div', {
      'data-chat-flow-kind': 'turn-process',
      'data-chat-turn': turn,
      'data-chat-anchor-key': `turn-process:${key}`
    }))
    const control = summary.appendChild(new FakeElement('button', { 'data-turn-process': turn }))
    control.setAttribute('aria-expanded', String(open))
    if (open) control.setAttribute('data-open', '1')
    const steps = []
    const setHidden = (hidden) => {
      for (const step of steps) {
        if (hidden) step.setAttribute('hidden', 'until-found')
        else step.removeAttribute('hidden')
      }
    }
    const nativeClicks = []
    control.addEventListener('click', () => {
      if (control.disabled) return
      nativeClicks.push(control.hasAttribute('data-open'))
      if (control.hasAttribute('data-open')) control.removeAttribute('data-open')
      else control.setAttribute('data-open', '1')
      setHidden(!control.hasAttribute('data-open'))
    })
    steps.push(fixture.scroll.appendChild(new FakeElement('div', {
      'data-chat-flow-kind': 'tool-call',
      'data-turn-process-member': 'true',
      'data-chat-turn': turn,
      'data-chat-anchor-key': `member:${key}`
    })))
    if (!open) setHidden(true)
    const answer = fixture.scroll.appendChild(new FakeElement('div', {
      'data-chat-flow-kind': 'assistant-step',
      'data-chat-turn': turn,
      'data-chat-anchor-key': `answer:${key}`
    }))
    return { summary, control, steps, answer, nativeClicks }
  }

  // One Turn interleaving three step runs with three replies (all folded, the way
  // the default policy leaves them), plus a neighbour Turn holding a single block.
  const a = mkBlock(TURN, 'a', { open: false })
  const b = mkBlock(TURN, 'b', { open: false })
  const c = mkBlock(TURN, 'c', { open: false })
  const solo = mkBlock(OTHER, 'solo', { open: false })

  const { win, controller } = await boot(fixture, null, { foldAllSteps: false, mergeByDefault: false })

  const lineOf = (answer) => answer.previousElementSibling
  const buttonOf = (answer, attribute) => lineOf(answer).querySelector(`[${attribute}]`)
  const visibleLines = () => [...fixture.scroll.querySelectorAll('[data-lf-step-line]')].filter((line) => !line.hidden)
  const openFlags = () => [a, b, c].map((block) => block.control.hasAttribute('data-open'))

  test('every Turn carries 收起全部 on its last seam while spread', () => {
    assert.equal(fixture.scroll.querySelectorAll('[data-lf-step-line]').length, 4, 'one seam per block')
    assert.equal(buttonOf(c.answer, 'data-lf-step-all').hidden, false)
    assert.equal(buttonOf(c.answer, 'data-lf-step-all').getAttribute('aria-label'), '收起全部')
    assert.equal(buttonOf(solo.answer, 'data-lf-step-all').hidden, false, 'a single-block Turn has one too')
  })
  test('展开所有步骤 exists only while spread and with more than one block', () => {
    assert.equal(buttonOf(c.answer, 'data-lf-step-every').hidden, false, 'the three-block Turn carries it')
    assert.equal(buttonOf(c.answer, 'data-lf-step-every').getAttribute('aria-label'), '展开所有步骤')
    assert.equal(buttonOf(a.answer, 'data-lf-step-every').hidden, true, 'it rides the last seam only')
    assert.equal(buttonOf(solo.answer, 'data-lf-step-every').hidden, true, 'one block has no separate "all steps"')
  })
  test('收起全部 folds every block of that Turn and leaves one button', () => {
    const soloBefore = solo.control.hasAttribute('data-open')
    fire(win, 'document', 'click', { target: buttonOf(c.answer, 'data-lf-step-all') })
    controller.rescan()
    assert.deepEqual(openFlags(), [false, false, false], 'every block folded')
    assert.equal(visibleLines().length, 2, 'the Turn keeps only its last seam')
    assert.equal(lineOf(c.answer).hidden, false)
    assert.equal(buttonOf(c.answer, 'data-lf-step-toggle').hidden, true, 'state 0 shows exactly one button')
    assert.equal(buttonOf(c.answer, 'data-lf-step-every').hidden, true)
    assert.equal(buttonOf(c.answer, 'data-lf-step-all').getAttribute('aria-label'), '展开全部')
    assert.equal(solo.control.hasAttribute('data-open'), soloBefore, 'the other Turn is untouched')
  })
  test('展开全部 brings the seams back with the contents still folded', () => {
    fire(win, 'document', 'click', { target: buttonOf(c.answer, 'data-lf-step-all') })
    controller.rescan()
    assert.equal(visibleLines().length, 4, 'all four seams are visible again')
    assert.deepEqual(openFlags(), [false, false, false], 'contents stay folded')
    assert.equal(buttonOf(c.answer, 'data-lf-step-all').getAttribute('aria-label'), '收起全部')
    assert.equal(buttonOf(c.answer, 'data-lf-step-every').getAttribute('aria-label'), '展开所有步骤')
  })
  test('展开所有步骤 opens every block; 收起所有步骤 folds them back', () => {
    fire(win, 'document', 'click', { target: buttonOf(c.answer, 'data-lf-step-every') })
    controller.rescan()
    assert.deepEqual(openFlags(), [true, true, true], 'every block open')
    assert.equal(buttonOf(c.answer, 'data-lf-step-every').getAttribute('aria-label'), '收起所有步骤')
    assert.equal(buttonOf(c.answer, 'data-lf-step-all').getAttribute('aria-label'), '收起全部', 'still spread')
    fire(win, 'document', 'click', { target: buttonOf(c.answer, 'data-lf-step-every') })
    controller.rescan()
    assert.deepEqual(openFlags(), [false, false, false], 'folded again')
    assert.equal(buttonOf(c.answer, 'data-lf-step-every').getAttribute('aria-label'), '展开所有步骤')
    assert.equal(visibleLines().length, 4, 'the seams were never touched')
  })
  test('展开本步骤 opens only its own block', () => {
    fire(win, 'document', 'click', { target: buttonOf(b.answer, 'data-lf-step-toggle') })
    controller.rescan()
    assert.deepEqual(openFlags(), [false, true, false], 'only the middle block')
    assert.equal(buttonOf(b.answer, 'data-lf-step-toggle').getAttribute('aria-label'), '收起本步骤')
  })
  test('收起全部 from a fully expanded Turn goes straight back to one button', () => {
    fire(win, 'document', 'click', { target: buttonOf(c.answer, 'data-lf-step-every') })
    controller.rescan()
    assert.deepEqual(openFlags(), [true, true, true], 'all open again')
    fire(win, 'document', 'click', { target: buttonOf(c.answer, 'data-lf-step-all') })
    controller.rescan()
    assert.deepEqual(openFlags(), [false, false, false], 'contents fold on the way out')
    assert.equal(visibleLines().length, 2, 'and the seams go with them')
    assert.equal(buttonOf(c.answer, 'data-lf-step-all').getAttribute('aria-label'), '展开全部')
  })
  test('the three controls carry three different glyphs', () => {
    const icons = ['data-lf-step-toggle', 'data-lf-step-all', 'data-lf-step-every']
      .map((attribute) => buttonOf(c.answer, attribute).querySelector('[data-lf-icon]')?.innerHTML ?? '')
    assert.equal(new Set(icons).size, 3, 'no two controls share an icon')
    for (const icon of icons) assert.match(icon, /<svg/, 'each control has its own svg')
  })
}

console.log('default: each Turn shows one button until asked')
{
  const fixture = buildFixture()
  const TURN = '7'
  const mk = (turn, key) => {
    const summary = fixture.scroll.appendChild(new FakeElement('div', {
      'data-chat-flow-kind': 'turn-process',
      'data-chat-turn': turn,
      'data-chat-anchor-key': `turn-process:${key}`
    }))
    const control = summary.appendChild(new FakeElement('button', { 'data-turn-process': turn }))
    control.setAttribute('aria-expanded', 'true')
    control.setAttribute('data-open', '1')
    const clicks = []
    control.addEventListener('click', () => {
      clicks.push(control.hasAttribute('data-open'))
      if (control.hasAttribute('data-open')) control.removeAttribute('data-open')
      else control.setAttribute('data-open', '1')
    })
    fixture.scroll.appendChild(new FakeElement('div', {
      'data-chat-flow-kind': 'tool-call',
      'data-turn-process-member': 'true',
      'data-chat-turn': turn,
      'data-chat-anchor-key': `member:${key}`
    }))
    const answer = fixture.scroll.appendChild(new FakeElement('div', {
      'data-chat-flow-kind': 'assistant-step',
      'data-chat-turn': turn,
      'data-chat-anchor-key': `answer:${key}`
    }))
    return { control, answer, clicks }
  }
  const a = mk(TURN, 'a')
  const b = mk(TURN, 'b')
  const solo = mk('8', 'solo')
  const { win, controller } = await boot(fixture)
  const visibleLines = () => [...fixture.scroll.querySelectorAll('[data-lf-step-line]')].filter((line) => !line.hidden)
  const lineOf = (answer) => answer.previousElementSibling
  const buttonOf = (answer, attribute) => lineOf(answer).querySelector(`[${attribute}]`)

  test('a fresh Turn boots with exactly one button', () => {
    assert.equal(visibleLines().length, 2, 'one seam per Turn')
    assert.equal(buttonOf(b.answer, 'data-lf-step-all').getAttribute('aria-label'), '展开全部')
    assert.equal(buttonOf(b.answer, 'data-lf-step-toggle').hidden, true, 'its own arrow waits')
    assert.equal(buttonOf(b.answer, 'data-lf-step-every').hidden, true)
    assert.equal(a.control.hasAttribute('data-open'), false)
    assert.equal(b.control.hasAttribute('data-open'), false)
  })
  test('展开全部 spreads the seams and keeps every block folded', () => {
    fire(win, 'document', 'click', { target: buttonOf(b.answer, 'data-lf-step-all') })
    controller.rescan()
    assert.equal(visibleLines().length, 3, 'both seams of that Turn plus the single-block Turn')
    assert.equal(a.control.hasAttribute('data-open'), false, 'contents stay folded')
    assert.equal(b.control.hasAttribute('data-open'), false, 'contents stay folded')
    assert.equal(buttonOf(b.answer, 'data-lf-step-toggle').hidden, false, 'the per-seam arrow is back')
    assert.equal(buttonOf(b.answer, 'data-lf-step-all').getAttribute('aria-label'), '收起全部')
    controller.rescan()
    assert.equal(visibleLines().length, 3, 'the explicit spread sticks')
  })
  test('one setting decides the text of all three controls', () => {
    controller.update({ stepLabels: true })
    assert.equal(buttonOf(b.answer, 'data-lf-step-label').textContent, '展开本步骤')
    assert.equal(buttonOf(b.answer, 'data-lf-all-label').textContent, '收起全部')
    assert.equal(buttonOf(b.answer, 'data-lf-every-label').textContent, '展开所有步骤')
    for (const attribute of ['data-lf-step-toggle', 'data-lf-step-all', 'data-lf-step-every']) {
      assert.equal(buttonOf(b.answer, attribute).getAttribute('data-lf-text'), '1', 'text mode on')
    }
    controller.update({ stepLabels: false })
    for (const attribute of ['data-lf-step-toggle', 'data-lf-step-all', 'data-lf-step-every']) {
      assert.equal(buttonOf(b.answer, attribute).hasAttribute('data-lf-text'), false, 'icon-only again')
    }
  })
  test('a single-block Turn has nothing to spread: 展开全部 opens it', () => {
    const primary = buttonOf(solo.answer, 'data-lf-step-all')
    assert.equal(primary.getAttribute('aria-label'), '展开全部')
    fire(win, 'document', 'click', { target: primary })
    controller.rescan()
    assert.equal(solo.control.hasAttribute('data-open'), true, 'its one block opened')
    assert.equal(primary.getAttribute('aria-label'), '收起全部')
  })
}

console.log('a picture keeps its height; the text still folds')
{
  const fixture = buildFixture()
  // The layout that hid the reader's own text: the media sits INSIDE the body.
  // Children carry explicit tops so the fixture models real block flow: the
  // picture first, the text lines after it.
  const mediaIn = (holder, picturePx, textPx) => {
    const media = holder.appendChild(new FakeElement('div', { 'data-attachment': '1' }))
    media.rectTop = 0
    media.rectHeight = picturePx
    const text = holder.appendChild(new FakeElement('div'))
    text.rectTop = picturePx
    text.rectHeight = textPx
  }
  // 6 lines × 22px = 132px of text budget; the picture adds 300px of its own.
  const short = fixture.user({}, 300 + 80)
  mediaIn(short.bubble, 300, 80)
  const long = fixture.user({ 'data-chat-anchor-key': 'user:2' }, 300 + 700)
  mediaIn(long.bubble, 300, 700)
  // The host's usual layout: the attachment row sits OUTSIDE the bubble.
  const outside = fixture.user({ 'data-chat-anchor-key': 'user:3' }, 700, true)
  // Keep a newer row after them, so nothing here is "the message being read".
  fixture.user({ 'data-chat-anchor-key': 'user:4' }, 200)
  const { controller } = await boot(fixture)
  controller.rescan()

  test('a picture plus a little text is not folded', () => {
    assert.equal(short.bubble.hasAttribute('data-lf-clamped'), false, 'the picture ate the budget, not the text')
  })
  test('a picture plus a long text still folds', () => {
    assert.equal(long.bubble.getAttribute('data-lf-clamped'), '1', 'a picture must not cost the fold')
  })
  test('the fold keeps the picture whole', () => {
    const budget = Number.parseFloat(long.bubble.parentElement.style.values['--lf-clamp-height'])
    assert.ok(budget >= 300, `clamp height ${budget} must cover the 300px picture`)
    assert.ok(budget <= 300 + 6 * 22 + 1, 'and add only the text budget on top')
  })
  test('an attachment row outside the bubble leaves the budget alone', () => {
    assert.equal(outside.bubble.getAttribute('data-lf-clamped'), '1', 'the long text folds at 6 lines as usual')
  })
}

console.log('sidebar find: search and reveal')
{
  const fixture = buildFixture()
  // A long message that folds, with text the fold hides from view but not from
  // the DOM — the search must still reach it.
  const mine = fixture.user({}, 600)
  mine.bubble.textContent = '折叠起来的一句话 alpha-beta 关键词'
  // A block the host will not fold: its rows carry findable text too.
  const summary = fixture.scroll.appendChild(new FakeElement('div', {
    'data-chat-flow-kind': 'turn-process',
    'data-chat-turn': '6',
    'data-chat-anchor-key': 'turn-process:6'
  }))
  const control = summary.appendChild(new FakeElement('button', { 'data-turn-process': '6' }))
  control.disabled = true
  const row = fixture.scroll.appendChild(new FakeElement('div', {
    'data-chat-flow-kind': 'tool-call',
    'data-turn-process-member': 'true',
    'data-chat-turn': '6',
    'data-chat-anchor-key': 'member:6'
  }))
  row.textContent = '藏在步骤里的 关键词'
  fixture.scroll.appendChild(new FakeElement('div', {
    'data-chat-flow-kind': 'assistant-step',
    'data-chat-turn': '6',
    'data-chat-anchor-key': 'answer:6'
  }))

  const { controller } = await boot(fixture, null, { mergeByDefault: false })

  test('search reaches text inside a folded message and a folded step', () => {
    assert.equal(mine.bubble.getAttribute('data-lf-clamped'), '1', 'the message is folded')
    const hits = controller.search('关键词')
    assert.equal(hits.length, 2, 'one in the folded message, one in the folded step')
  })
  test('revealAt opens the folded message', () => {
    const hit = controller.search('alpha-beta').find((entry) => entry.kind === 'message')
    assert.ok(hit, 'the hit exists')
    controller.revealAt(hit.element)
    assert.equal(mine.bubble.getAttribute('data-lf-open'), '1', 'the message unfolds')
  })
  test('revealAt opens the whole folded step block', () => {
    const hit = controller.search('藏在步骤里的').find((entry) => entry.kind === 'step')
    assert.ok(hit, 'the hit exists')
    assert.equal(row.getAttribute('data-lf-step-folded'), '1', 'folded before')
    controller.revealAt(hit.element)
    assert.equal(row.hasAttribute('data-lf-step-folded'), false, 'the block opens through its own path')
  })
}

console.log('Ctrl+F reaches folded content')
{
  const fixture = buildFixture()

  // A block the host refuses to fold: the plugin hides those rows itself.
  const summary = fixture.scroll.appendChild(new FakeElement('div', {
    'data-chat-flow-kind': 'turn-process',
    'data-chat-turn': '4',
    'data-chat-anchor-key': 'turn-process:4'
  }))
  const control = summary.appendChild(new FakeElement('button', { 'data-turn-process': '4' }))
  control.disabled = true
  const rows = [0, 1].map((index) => fixture.scroll.appendChild(new FakeElement('div', {
    'data-chat-flow-kind': 'tool-call',
    'data-turn-process-member': 'true',
    'data-chat-turn': '4',
    'data-chat-anchor-key': `member:4:${index}`
  })))
  fixture.scroll.appendChild(new FakeElement('div', {
    'data-chat-flow-kind': 'assistant-step',
    'data-chat-turn': '4',
    'data-chat-anchor-key': 'answer:4'
  }))

  // A block the host folds itself, with the same until-found mechanism.
  const hostSummary = fixture.scroll.appendChild(new FakeElement('div', {
    'data-chat-flow-kind': 'turn-process',
    'data-chat-turn': '5',
    'data-chat-anchor-key': 'turn-process:5'
  }))
  const hostControl = hostSummary.appendChild(new FakeElement('button', { 'data-turn-process': '5' }))
  hostControl.setAttribute('aria-expanded', 'false')
  const hostRows = [0, 1].map((index) => fixture.scroll.appendChild(new FakeElement('div', {
    'data-chat-flow-kind': 'tool-call',
    'data-turn-process-member': 'true',
    'data-chat-turn': '5',
    'data-chat-anchor-key': `member:5:${index}`,
    hidden: 'until-found'
  })))
  hostControl.addEventListener('click', () => {
    const open = hostControl.getAttribute('aria-expanded') !== 'true'
    hostControl.setAttribute('aria-expanded', String(open))
    for (const row of hostRows) {
      if (open) row.removeAttribute('hidden')
      else row.setAttribute('hidden', 'until-found')
    }
  })
  fixture.scroll.appendChild(new FakeElement('div', {
    'data-chat-flow-kind': 'assistant-step',
    'data-chat-turn': '5',
    'data-chat-anchor-key': 'answer:5'
  }))

  // A folded message: the browser reveals a match inside it by scrolling the box.
  const long = fixture.user({ 'data-chat-anchor-key': 'user:9' }, 600)

  const { win, controller } = await boot(fixture)

  test('rows the plugin folds are hidden until found, not removed', () => {
    assert.equal(rows[0].getAttribute('data-lf-step-folded'), '1')
    assert.equal(rows[0].getAttribute('hidden'), 'until-found', 'the browser can still match this text')
    assert.equal(rows[1].getAttribute('hidden'), 'until-found')
  })
  test('the browser revealing one row opens the whole block', () => {
    fire(win, 'document', 'beforematch', { target: rows[0] })
    for (const row of rows) {
      assert.equal(row.hasAttribute('hidden'), false, 'every row of the block comes back')
      assert.equal(row.hasAttribute('data-lf-step-folded'), false)
    }
    controller.rescan()
    assert.equal(rows[0].hasAttribute('hidden'), false, 'and the automatic pass leaves it open')
  })
  test('a host-folded block is opened through the host control', () => {
    fire(win, 'document', 'beforematch', { target: hostRows[0] })
    assert.equal(hostControl.getAttribute('aria-expanded'), 'true', 'the host was told to open')
    assert.equal(hostRows[0].hasAttribute('hidden'), false)
  })
  test('a match inside a folded message opens it instead of leaving it clipped', () => {
    assert.equal(long.bubble.getAttribute('data-lf-clamped'), '1')
    assert.equal(long.bubble.getAttribute('data-lf-open'), '0')
    // The find panel reveals its hits itself — and a passing wheel must NOT,
    // which is why the clamp box is clipped rather than scrollable.
    long.bubble.scrollTop = 120
    long.bubble.fireEvent('scroll')
    assert.equal(long.bubble.getAttribute('data-lf-open'), '0', 'a scroll alone expands nothing')
    controller.revealAt(long.bubble)
    assert.equal(long.bubble.getAttribute('data-lf-open'), '1', 'the message unfolds')
    assert.match(long.anchor.querySelector('[data-lf-label]').textContent, /收起/)
  })
  test('revealed blocks are remembered, so nothing folds them back', () => {
    controller.rescan()
    controller.rescan()
    assert.equal(rows[0].hasAttribute('hidden'), false)
    assert.equal(long.bubble.hasAttribute('data-lf-open'), true)
  })
}

console.log('default fold policy (newest turn open, everything else folded)')
{
  // Real conversation order, one Turn after another:
  //   user(1) → steps(1) → reply(1) → user(2) → steps(2) → reply(2)
  const fixture = buildFixture()
  const block = (turn, { collapsible, open, members = 2 }) => {
    const summary = fixture.scroll.appendChild(new FakeElement('div', {
      'data-chat-flow-kind': 'turn-process',
      'data-chat-turn': String(turn),
      'data-chat-anchor-key': `tp:${turn}`
    }))
    const control = summary.appendChild(new FakeElement('button', { 'data-turn-process': String(turn) }))
    if (collapsible) control.setAttribute('aria-expanded', String(open))
    if (open) control.setAttribute('data-open', '1')
    const nativeClicks = []
    control.addEventListener('click', () => {
      nativeClicks.push(control.hasAttribute('data-open'))
      if (control.hasAttribute('data-open')) control.removeAttribute('data-open')
      else control.setAttribute('data-open', '1')
    })
    const steps = []
    for (let index = 0; index < members; index += 1) {
      steps.push(fixture.scroll.appendChild(new FakeElement('div', {
        'data-chat-flow-kind': 'tool-call',
        'data-turn-process-member': 'true',
        'data-chat-turn': String(turn),
        'data-chat-anchor-key': `m:${turn}:${index}`
      })))
    }
    return { summary, control, steps, nativeClicks, members }
  }

  const olderUser = fixture.user({ 'data-chat-turn': '1' }, 600)
  const olderSteps = block(1, { collapsible: true, open: true })
  const olderReply = fixture.assistant({ 'data-chat-turn': '1', 'data-chat-anchor-key': 'a:1' }, 900)
  // Its own reply right after it, so this block keeps its own seam: two adjacent
  // step blocks with nothing between them are ONE block.
  const olderSelfSteps = block(1, { collapsible: false, open: true, members: 1 })
  const olderSelfReply = fixture.assistant({ 'data-chat-turn': '1', 'data-chat-anchor-key': 'a:1b' }, 900)

  const newerUser = fixture.user({ 'data-chat-turn': '2', 'data-chat-anchor-key': 'user:2' }, 600)
  const newerSteps = block(2, { collapsible: true, open: true, members: 3 })
  const newerReply = fixture.assistant({ 'data-chat-turn': '2', 'data-chat-anchor-key': 'a:2' }, 900)

  const { win, controller } = await boot(fixture, null, { mergeByDefault: false })
  let nextUser = null

  test('the newest turn stays open however long it is', () => {
    assert.equal(newerReply.markdown.hasAttribute('data-lf-clamped'), false, 'the reply you are reading')
    assert.equal(newerUser.bubble.hasAttribute('data-lf-clamped'), false, 'and your own last input')
    assert.equal(newerReply.anchor.querySelector('[data-lf-toggle]'), null, 'no toggle on the newest reply')
  })
  test('older turns fold to their line budget', () => {
    assert.equal(olderUser.bubble.getAttribute('data-lf-clamped'), '1')
    assert.equal(olderReply.markdown.getAttribute('data-lf-clamped'), '1')
    assert.equal(olderSelfReply.markdown.getAttribute('data-lf-clamped'), '1')
  })
  test('every step block starts folded, the newest turn included', () => {
    assert.equal(olderSteps.control.hasAttribute('data-open'), false, 'the older block was closed through the host')
    assert.ok(olderSteps.nativeClicks.length >= 1, 'and the host was the one told to do it')
    assert.equal(newerSteps.control.hasAttribute('data-open'), false, 'the newest turn hangs up too')
    assert.equal(olderSelfSteps.summary.getAttribute('data-lf-step-folded'), '1', 'a block the host will not fold is marked by us')
    assert.equal(olderSelfSteps.steps[0].getAttribute('data-lf-step-folded'), '1')
    for (const seam of fixture.scroll.querySelectorAll('[data-lf-step-toggle]')) {
      assert.equal(seam.getAttribute('aria-label'), '展开本步骤')
    }
  })
  test('opening a block by hand sticks', () => {
    const seam = newerReply.anchor.previousElementSibling.querySelector('[data-lf-step-toggle]')
    assert.equal(seam.hasAttribute('data-lf-step-toggle'), true)
    fire(win, 'document', 'click', { target: seam })
    assert.equal(newerSteps.control.hasAttribute('data-open'), true, 'the newest turn opens on one click')
    assert.equal(seam.getAttribute('aria-label'), '收起本步骤')
    controller.rescan()
    controller.rescan()
    assert.equal(newerSteps.control.hasAttribute('data-open'), true, 'and nothing re-collapses it')
  })
  test('the newest turn keeps up with the conversation', () => {
    // A new Turn arrives: the previous "latest" is now history and folds down.
    nextUser = fixture.user({ 'data-chat-turn': '3', 'data-chat-anchor-key': 'user:3' }, 60)
    controller.rescan()
    assert.equal(newerReply.markdown.getAttribute('data-lf-clamped'), '1', 'the old reply folds')
    assert.equal(newerUser.bubble.getAttribute('data-lf-clamped'), '1', 'and so does the old input')
    assert.equal(nextUser.bubble.hasAttribute('data-lf-clamped'), false, 'the new input stays open')
  })
  test('turning the exemption off folds the newest turn too', () => {
    nextUser.bubble.scrollHeight = 620
    nextUser.bubble.rectHeight = 620
    controller.update({ keepLatestOpen: false })
    assert.equal(controller.settings().keepLatestOpen, false)
    assert.equal(nextUser.bubble.getAttribute('data-lf-clamped'), '1', 'no turn is exempt any more')
  })
}

// ------------------------------------------------- bundled-artifact checks
// These drive the REAL built client.js through the loader path the host uses:
// __ModuleLoader__.load(...) → factory(require) → apply(ctx). The unit tests
// above import src/ directly, so without these the shipped bundle is untested.
console.log('bundled artifact (client.js)')
{
  // The built bundle is ESM-marked but must not use import/export syntax itself.
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const loader = { registration: null, require: null }
  const bundleWindow = {
    __ModuleLoader__: {
      load(registration) { loader.registration = registration },
      require: (name) => { throw new Error(`unexpected host module request: ${name}`) }
    }
  }

  test('bundle registers itself under the package name', () => {
    const run = new Function('window', 'require', source)
    run(bundleWindow, undefined)
    assert.equal(loader.registration?.id, 'dsh-fold-polish')
  })
  test('bundle contains no stray export syntax', () => {
    assert.equal(/^\s*export\s/m.test(source), false)
  })
  test('factory takes exactly the host resolver, no more', () => {
    // The host calls factory(require) with its OWN resolver. `factory.length`
    // is the authoritative arity check — a comment mentioning a pattern must
    // not be mistaken for code.
    assert.equal(loader.registration.factory.length, 1, 'factory must take the host resolver')
  })
  test('bundle declares no external host modules', () => {
    // Only react may be requested; anything else would need dsh.client.external.
    const requested = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
    const external = [...new Set(requested)].filter((name) => !name.startsWith('./'))
    assert.deepEqual(external, ['react'])
  })

  const fixture = buildFixture()
  const mine = fixture.user({}, 600)
  const reply = fixture.assistant({}, 900)
  // A pristine window: the assertions below are about first-activation state.
  const win = makeWindow(fixture.html)
  win.__ModuleLoader__ = {
    load(registration) { loader.registration = registration },
    require: (name) => {
      if (name === 'react') return {}
      throw new Error(`unexpected host module request: ${name}`)
    }
  }
  // Fresh registration run against the window the plugin will actually see.
  // The shims stay installed for the whole block: the bundle captures `document`
  // in its module scope, so activation must happen under the same globals.
  withBrowserGlobals(win, () => {
    new Function('window', 'require', source)(win, undefined)
    let disposer = null

    test('factory is side-effect free until the host applies it', () => {
      const warnings = []
      const originalWarn = console.warn
      console.warn = (...args) => warnings.push(args.map(String).join(' '))
      try {
        // Materialize the factory WITHOUT applying it: this is the "lazy module
        // body" step. The argument models the HOST resolver exactly: it knows
        // `react` and nothing else, and every request is recorded, because the
        // bundle must resolve its OWN sources from the local registry. Both ways
        // of getting this wrong have already booted the app into a crash dialog:
        //   - asking it for "./src/browser.js" → "missed the module table"
        //   - not calling it at all           → "host module unavailable: react"
        const hostRequests = []
        const plugin = loader.registration.factory((spec) => {
          hostRequests.push(spec)
          if (spec === 'react') return { createElement: () => null }
          throw new Error(
            `client-modules: require("${spec}") missed the module table — ` +
            'not a platform seed word, not a materialized module, and no registered package factory'
          )
        })
        assert.deepEqual(hostRequests, ['react'], 'the host resolver must be asked for react only')
        assert.equal(typeof plugin.apply, 'function')
        // The settings tab depends on the slots service; the DOM fold does not.
        // uiConversation feeds the per-turn timer probe and degrades when absent.
        assert.deepEqual(plugin.inject, ['slots', 'uiConversation', 'sessions'])
        assert.equal(win.__DSH_BUBBLE_FOLD__, undefined)
        assert.equal(win.document.getElementById('dsh-bubble-fold-styles'), null)
        // Now the host activates the row; apply() hands back its disposer.
        disposer = plugin.apply({})
        assert.equal(typeof disposer, 'function')
        // An empty ctx has no right-bar, layout or conversation service, and saying
        // so is the ONLY warning activation may produce — the fold itself must come
        // up clean. (uiConversation: the per-turn timer probe degrades the same way.)
        assert.deepEqual(
          warnings.filter((line) => !line.includes('sidebarRightTabs') && !line.includes('layout 服务') && !line.includes('uiConversation')),
          [],
          `activation warned: ${warnings.join(' | ')}`
        )
        assert.equal(win.__DSH_BUBBLE_FOLD__?.status, 'running')
      } finally {
        console.warn = originalWarn
      }
    })
    test('after apply() the real bundle clamps both sides', () => {
      assert.deepEqual(
        { user: mine.bubble.getAttribute('data-lf-clamped'), assistant: reply.markdown.getAttribute('data-lf-clamped') },
        { user: '1', assistant: '1' },
        'clamp attributes'
      )
      assert.equal(win.document.getElementById('dsh-bubble-fold-styles') !== null, true, 'style element')
      assert.equal(win.document.documentElement.getAttribute('data-dsh-bubble-fold'), 'on', 'root flag')
    })
    test('repeated scanning never stacks style tags', () => {
      win.__DSH_BUBBLE_FOLD__.rescan()
      win.__DSH_BUBBLE_FOLD__.rescan()
      const tags = fixture.html.querySelectorAll('style').filter((s) => s.getAttribute('id') === 'dsh-bubble-fold-styles')
      assert.equal(tags.length, 1)
    })
    test('a settled conversation produces no further DOM writes', () => {
      // This is the self-feeding loop guard: the plugin watches the attributes it
      // writes, so any same-value write schedules another scan, which writes
      // again — forever, at frame rate.
      const before = mine.bubble.attributeWrites ?? 0
      const coverBefore = reply.markdown.attributeWrites ?? 0
      for (let i = 0; i < 5; i += 1) win.__DSH_BUBBLE_FOLD__.rescan()
      assert.equal(mine.bubble.attributeWrites ?? 0, before, 'user body re-written while idle')
      assert.equal(reply.markdown.attributeWrites ?? 0, coverBefore, 'assistant body re-written while idle')
    })
    test('the scan pass reports what it touched', () => {
      const stats = win.__DSH_BUBBLE_FOLD__.stats()
      assert.ok(stats.scans > 0, 'scans counted')
      assert.ok(stats.clamped >= 2, 'both messages folded')
      assert.equal(typeof stats.measured, 'number')
    })
    test('dispose() returns the transcript to stock', () => {
      disposer()
      assert.equal(mine.bubble.hasAttribute('data-lf-clamped'), false, 'user clamp released')
      assert.equal(reply.markdown.hasAttribute('data-lf-clamped'), false, 'assistant clamp released')
      assert.equal(win.__DSH_BUBBLE_FOLD__, undefined, 'console handle removed')
      assert.equal(win.document.getElementById('dsh-bubble-fold-styles'), null, 'style tag removed')
      assert.equal(win.document.documentElement.hasAttribute('data-dsh-bubble-fold'), false, 'root flag removed')
    })
  })
}

console.log('performance guards')
{
  const fixture = buildFixture()
  const onscreen = fixture.user({}, 600)
  const offscreen = fixture.user({ 'data-chat-anchor-key': 'user:far', 'data-lf-offscreen': '' }, 600)
  const { win, controller } = await boot(fixture)

  test('an off-screen message is not measured or written', () => {
    assert.equal(offscreen.bubble.getAttribute('data-lf-clamped'), null, 'no clamp off screen')
    assert.equal(offscreen.bubble.parentElement?.getAttribute('data-lf-body') ?? null, null, 'not even wrapped')
  })
  test('an on-screen message is folded', () => {
    assert.equal(onscreen.bubble.getAttribute('data-lf-clamped'), '1')
  })
  test('it folds once it scrolls into view', () => {
    offscreen.anchor.removeAttribute('data-lf-offscreen')
    controller.rescan()
    assert.equal(offscreen.bubble.getAttribute('data-lf-clamped'), '1')
  })
  test('the scan pass stays inside its frame budget', () => {
    // 400 flow items: one unbounded pass would measure every one of them.
    const many = buildFixture()
    for (let i = 0; i < 400; i += 1) many.user({ 'data-chat-anchor-key': `user:${i}` }, 600)
    return boot(many).then(({ win: win2 }) => {
      const stats = win2.__DSH_BUBBLE_FOLD__.stats()
      assert.ok(stats.scans > 0)
      assert.ok(stats.measured < 400, `measured ${stats.measured} of 400 rows in one pass`)
    })
  })
}

console.log('composer resize')
{
  // The host caps the composer at --dsh-composer-text-max-height on the seat and
  // scrolls inside that; the plugin raises the cap and remembers the choice.
  const fixture = buildFixture()
  const seat = fixture.body.appendChild(new FakeElement('div', { 'data-composer-seat': '' }))
  // The host renders a zero-height placeholder slot BEFORE the card. A handle put
  // there is unreachable, so the card must be found by owning the input.
  seat.appendChild(new FakeElement('div', { 'data-slot': 'conversation.composer.dock' }))
  const card = seat.appendChild(new FakeElement('div', { 'data-composer-card': '1' }))
  // The host scrolls inside a max-height container; the plugin pins its min-height
  // when the user takes manual control.
  const scroll = card.appendChild(new FakeElement('div', { 'data-composer-scroll': '1' }))
  scroll.computedOverflowY = 'auto'
  scroll.rectHeight = 52 // natural input height before any manual control
  scroll.appendChild(new FakeElement('div', { 'data-composer-input': '1', contenteditable: 'true' }))
  const { win, controller } = await boot(fixture)

  const handleOf = () => card.querySelector('[data-lf-composer-handle]')
  const heightVar = () => seat.style.values['--dsh-composer-text-max-height']

  test('the handle lands in the card that owns the input, not the placeholder slot', () => {
    const handle = handleOf()
    assert.ok(handle, 'handle exists')
    assert.equal(handle.getAttribute('data-lf-composer-handle'), '1')
    assert.equal(handle.parentElement, card, 'inside the real card')
    assert.equal(seat.firstElementChild.getAttribute('data-slot'), 'conversation.composer.dock', 'the placeholder slot is left alone')
    assert.equal(seat.firstElementChild.querySelector('[data-lf-composer-handle]'), null)
    assert.equal(card.querySelector('[contenteditable="true"]') !== null, true, 'the card is identified by owning the input')
    // Physical position in the child list is the host's business; the CSS pins it
    // to the top of the card's flex column with `order: -1`.
    const stylesheet = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(stylesheet, /data-lf-composer-handle\][\s\S]{0,260}?order:\s*-1/, 'pinned to the visual top')
    assert.match(stylesheet, /data-lf-composer-handle\][\s\S]{0,400}?pointer-events:\s*auto/, 'reachable by the pointer')
  })
  test('a handle parked in the placeholder slot is moved into the card', () => {
    // Regression: the earliest scan can run before the card is rendered, so a
    // handle gets inserted into the zero-height slot. It stays "connected"
    // forever, so validity must be checked by parent, not by connectivity.
    const handle = handleOf()
    const slot = seat.firstElementChild
    slot.appendChild(handle)
    assert.equal(handle.parentElement, slot, 'pretend an early scan parked it there')
    assert.equal(handle.isConnected, true, 'it is still in the document')
    controller.rescan()
    assert.equal(handleOf().parentElement, card, 'the next scan relocates it')
    assert.equal(slot.querySelector('[data-lf-composer-handle]'), null, 'the slot is left clean')
  })
  test('an untracked stray handle is swept away', () => {
    // The sweep is intentionally scoped to the composer area: a handle stranded
    // outside any card (the placeholder slot, a dock wrapper) gets removed, while
    // one sitting in a live card is left for the normal path.
    const stray = seat.firstElementChild.appendChild(new FakeElement('div', { 'data-lf-composer-handle': '1' }))
    controller.rescan()
    assert.equal(stray.isConnected, false, 'removed from the slot it was stranded in')
    assert.equal(handleOf().parentElement, card, 'the real handle is untouched')
  })
  test('the handle advertises itself as a separator', () => {
    const handle = handleOf()
    assert.equal(handle.getAttribute('role'), 'separator')
    assert.match(handle.getAttribute('aria-label'), /拖动调整输入框高度/)
  })
  test('a plain click on the handle changes nothing', () => {
    const handle = handleOf()
    const before = heightVar()
    fire(win, 'document', 'pointerdown', { target: handle, clientY: 100, preventDefault() {} })
    fire(win, 'window', 'pointerup', {})
    assert.equal(heightVar(), before, 'no height write without a drag')
    assert.equal(scroll.style.values['min-height'], undefined, 'and the box is not pinned either')
  })
  test('a stray 2px jitter during a tap is not a drag', () => {
    const handle = handleOf()
    const before = heightVar()
    fire(win, 'document', 'pointerdown', { target: handle, clientY: 100, preventDefault() {} })
    fire(win, 'window', 'pointermove', { clientY: 102 })
    fire(win, 'window', 'pointermove', { clientY: 99 })
    fire(win, 'window', 'pointerup', {})
    assert.equal(heightVar(), before, 'the tap never turned into a resize')
    assert.equal(scroll.style.values['min-height'], undefined, 'still unpinned')
  })
  test('a drag from a short box never snaps up to the manual minimum', () => {
    const handle = handleOf()
    const natural = scroll.rectHeight
    scroll.rectHeight = 44 // one line of input, shorter than the 72px manual floor
    fire(win, 'document', 'pointerdown', { target: handle, clientY: 300, preventDefault() {} })
    fire(win, 'window', 'pointermove', { clientY: 296 }) // 4px up, just past the threshold
    assert.equal(heightVar(), '48px', '44 + 4 — never the 72px floor')
    fire(win, 'window', 'pointerup', {})
    scroll.rectHeight = natural
    fire(win, 'document', 'dblclick', { target: handle })
  })
  test('the drag origin is measured when the drag starts, not on pointerdown', () => {
    const handle = handleOf()
    fire(win, 'document', 'pointerdown', { target: handle, clientY: 200, preventDefault() {} })
    // The host grows the box between the press and the first move (focus / auto
    // grow). That growth belongs to the origin — it must not become a jump.
    const natural = scroll.rectHeight
    scroll.rectHeight = 200
    fire(win, 'window', 'pointermove', { clientY: 160 })
    assert.equal(heightVar(), '240px', '200 (current, grown) + 40 pulled up')
    fire(win, 'window', 'pointerup', {})
    scroll.rectHeight = natural
    // Leave no manual pin behind: the later drag tests start from the natural box.
    fire(win, 'document', 'dblclick', { target: handle })
  })
  test('dragging UP grows the composer', () => {
    const handle = handleOf()
    fire(win, 'document', 'pointerdown', { target: handle, clientY: 100, preventDefault() {} })
    fire(win, 'window', 'pointermove', { clientY: 20 })
    // The handle is the top edge: pulling it up must raise that edge. The drag
    // starts from the VISUAL height (52px), so the first move grows the box
    // continuously instead of snapping to 336+.
    assert.equal(heightVar(), '132px', '52 natural + 80 pulled up')
    fire(win, 'window', 'pointerup', {})
  })
  test('manual control pins the scroll area so the box visibly grows', () => {
    // Raising only the max-height changes nothing while the content is short;
    // the first drag must also pin a min-height on the host's scroll area.
    assert.equal(scroll.style.values['min-height'], '132px', 'min-height follows the dragged size')
  })
  test('dragging down shrinks it, down to a floor', () => {
    const handle = handleOf()
    fire(win, 'document', 'pointerdown', { target: handle, clientY: 400, preventDefault() {} })
    fire(win, 'window', 'pointermove', { clientY: 440 })
    assert.equal(heightVar(), '92px', '132 - 40')
    fire(win, 'window', 'pointermove', { clientY: 5000 })
    assert.ok(Number.parseFloat(heightVar()) >= 72, 'never collapses past the floor')
    fire(win, 'window', 'pointerup', {})
  })
  test('the pointer listeners are released on pointerup', () => {
    const handle = handleOf()
    fire(win, 'document', 'pointerdown', { target: handle, clientY: 200, preventDefault() {} })
    fire(win, 'window', 'pointerup', {})
    const before = heightVar()
    fire(win, 'window', 'pointermove', { clientY: 900 })
    assert.equal(heightVar(), before, 'no resize without a drag')
  })
  test('double-clicking the handle restores the host default', () => {
    fire(win, 'document', 'dblclick', { target: handleOf() })
    assert.equal(heightVar(), '336px')
    assert.equal(win.localStorage.getItem('dsh.bubble-fold.composer-height'), null, 'stored height cleared')
    assert.equal(scroll.style.values['min-height'], undefined, 'min-height released, natural auto-grow returns')
  })
  test('the chosen height survives a reload', () => {
    const handle = handleOf()
    fire(win, 'document', 'pointerdown', { target: handle, clientY: 200, preventDefault() {} })
    fire(win, 'window', 'pointermove', { clientY: 0 })
    fire(win, 'window', 'pointerup', {})
    assert.equal(win.localStorage.getItem('dsh.bubble-fold.composer-height'), '252', '52 natural + 200 pulled up, persisted as a number')
    return boot(fixture).then(({ win: win2 }) => {
      assert.equal(win2.localStorage.getItem('dsh.bubble-fold.composer-height'), '252')
      assert.equal(scroll.style.values['min-height'], '252px', 'the manual size is re-applied on load')
    })
  })
  test('disabling composerResize takes the handle away', () => {
    controller.update({ composerResize: false })
    assert.equal(handleOf(), null)
  })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
