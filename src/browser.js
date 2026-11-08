// Reversible view controller. Host-owned nodes are never moved or rewritten.
// Folded messages use a disposable presentation clone; search always reads the source.
export const SCAN_BUDGET_MS = 6
// While the conversation is being folded for the first time (or after older
// history is prepended) a small overlay covers the transcript, so the reader
// never sees half-folded content and the heights cannot shift under them. The
// work then runs in larger slices, with a floor so the badge cannot flash and a
// ceiling so it can never trap the reader.
export const PENDING_BUDGET_MS = 40
export const PENDING_MIN_MS = 250
export const PENDING_MAX_MS = 2500
// How many loaded turns before the reader is reminded that switching away and
// back lets the host unload older history (the same trick they already use).
export const LOADED_TURN_HINT = 40
export const COMPOSER_STORAGE_KEY = 'dsh.bubble-fold.composer-height'
export const COMPOSER_DEFAULT = 336

const OWN = '[data-lf-owned]'
const FLOW = '[data-chat-flow-kind],[data-step-process]'
const MEDIA = 'img,picture,source,video,canvas,svg,iframe,audio'
const SKIP =
  '[data-context-fields],[data-context-text],[data-context-injection-body],[data-system-prompt-body],[data-message-attachments],[data-error],[data-variant]'
const CSS = `
:root[data-dsh-bubble-fold] [data-conversation-scroll] { overflow-anchor:none; }
[data-lf-source="collapsed"], [data-lf-step-folded] {
  content-visibility:hidden !important; block-size:0 !important; min-block-size:0 !important;
  margin-block:0 !important; padding-block:0 !important; border-block-width:0 !important;
  overflow:clip !important; pointer-events:none !important;
}
[data-lf-preview] { box-sizing:border-box; max-width:100%; overflow:visible !important; }
[data-lf-preview] img, [data-lf-preview] video { max-width:100%; height:auto; }
[data-lf-toggle] {
  display:inline-flex; align-items:center; gap:4px; margin:2px 0 0; padding:2px 10px 2px 8px;
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent)); border-radius:999px;
  background:var(--dsw-alias-bg-base,Canvas); color:var(--dsw-alias-label-secondary,#68707d);
  font:inherit; font-size:12px; line-height:18px; font-weight:450; cursor:pointer; user-select:none; white-space:nowrap;
  position:relative; z-index:2; box-shadow:0 1px 5px rgba(15,23,42,.1); touch-action:manipulation;
}
[data-lf-toggle] svg { width:13px; height:13px; flex:none; transition:transform .15s ease; }
[data-lf-toggle][aria-expanded="true"] svg { transform:rotate(180deg); }
[data-lf-toggle]:hover, [data-lf-step-line] button:hover {
  color:var(--dsw-alias-label-primary,#1f2328); background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 5%,Canvas));
}
[data-lf-pending] {
  position:fixed; z-index:45; display:flex; align-items:flex-end; justify-content:center;
  padding-bottom:18px; box-sizing:border-box; opacity:0; pointer-events:none;
  background:color-mix(in srgb,var(--dsw-alias-bg-base,Canvas) 90%,transparent);
  transition:opacity .16s ease;
}
[data-lf-pending][data-lf-visible] { opacity:1; pointer-events:auto; }
[data-lf-hint] {
  position:fixed; left:50%; transform:translateX(-50%); z-index:44; max-width:min(90vw,560px);
  display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px;
  background:var(--dsw-alias-bg-layer-1,Canvas); color:var(--dsw-alias-label-secondary,#68707d);
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent));
  font-size:12px; line-height:18px; box-shadow:0 2px 10px rgba(15,23,42,.12);
  opacity:0; pointer-events:none; transition:opacity .16s ease;
}
[data-lf-hint][data-lf-visible] { opacity:1; pointer-events:auto; }
[data-lf-hint-close] { border:0; background:transparent; color:inherit; cursor:pointer; font-size:14px; line-height:1; padding:0 2px; }
[data-lf-pending-badge] {
  display:inline-flex; align-items:center; gap:8px; padding:6px 14px; border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent));
  background:var(--dsw-alias-bg-layer-1,Canvas); color:var(--dsw-alias-label-secondary,#68707d);
  font-size:12px; line-height:18px; box-shadow:0 2px 10px rgba(15,23,42,.12);
}
[data-lf-spinner] {
  width:13px; height:13px; flex:none; border-radius:50%; border:2px solid currentColor;
  border-top-color:transparent; animation:dsh-lf-spin .8s linear infinite;
}
@keyframes dsh-lf-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { [data-lf-spinner] { animation:none; } }
[data-lf-toggle]:focus-visible, [data-lf-step-line] button:focus-visible, [data-lf-composer-handle]:focus-visible { outline:2px solid #5c8fff; outline-offset:2px; }
[data-lf-control] { display:flex; justify-content:flex-start; width:100%; }
[data-lf-control="user"] { justify-content:flex-end; }
[data-lf-step-line] { display:flex; align-items:center; gap:8px; margin:2px 0; width:100%; box-sizing:border-box; }
[data-lf-step-line]::before, [data-lf-step-line]::after {
  content:''; height:1px; flex:1 1 auto; background:var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent)); transition:background-color .12s ease;
}
[data-lf-step-toggle], [data-lf-step-all], [data-lf-step-every] {
  display:inline-flex; align-items:center; justify-content:center; gap:4px; flex:none; height:26px; padding:0; margin:0; box-sizing:border-box;
  border:0; border-radius:999px; background:none; color:var(--dsw-alias-label-secondary,#68707d);
  font:inherit; font-size:11px; line-height:18px; font-weight:450; cursor:pointer; user-select:none; white-space:nowrap;
  appearance:none; touch-action:manipulation; transition:color .12s ease,background-color .12s ease;
}
[data-lf-icon] {
  flex:none; width:26px; height:26px; box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center;
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent)); border-radius:50%;
  background:var(--dsw-alias-bg-base,Canvas); box-shadow:0 2px 8px rgba(15,23,42,.14);
  transition:color .12s ease,background-color .12s ease,transform .12s ease;
}
[data-lf-icon] svg { width:14px; height:14px; flex:none; transition:transform .15s ease; }
[data-lf-step-line] [aria-expanded="true"] svg { transform:rotate(180deg); }
[data-lf-step-line] button:hover [data-lf-icon] {
  color:var(--dsw-alias-label-primary,#1f2328); background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 5%,Canvas));
}
[data-lf-step-toggle]:hover [data-lf-icon] { transform:scale(1.08); }
[data-lf-step-line] button[data-lf-text="1"] {
  height:24px; padding:0 10px 0 5px; border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent));
  background:var(--dsw-alias-bg-base,Canvas); box-shadow:0 1px 4px rgba(15,23,42,.08);
}
[data-lf-text="1"] [data-lf-icon] { width:16px; height:16px; border:0; background:none !important; box-shadow:none; transform:none !important; }
[data-lf-step-line] [data-lf-label] { display:none; }
[data-lf-step-line] [data-lf-text="1"] [data-lf-label] { display:inline; }
[data-lf-step-line]:hover::before, [data-lf-step-line]:hover::after { background:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 22%,transparent)); }
[data-lf-step-line][hidden] { display:none !important; }
[data-lf-step-toggle][hidden], [data-lf-step-all][hidden], [data-lf-step-every][hidden] { display:none !important; }
[data-lf-turn-timer] { color:inherit; opacity:.55; font-size:12px; line-height:22px; margin-top:8px; }
/* Keep the grip outside the flex flow: a final flex child adds the host's 12px
   gap below the toolbar and makes its buttons float above the card's bottom. */
[data-lf-composer-handle] { position:absolute; top:-5px; left:50%; transform:translateX(-50%); z-index:2; display:flex; align-items:center; justify-content:center; width:72px; height:16px; min-height:0; cursor:ns-resize; touch-action:none; border:0; background:transparent; color:inherit; padding:0; margin:0; }
[data-lf-composer-handle]::after { content:''; display:block; width:34px; height:3px; border-radius:4px; background:color-mix(in srgb,currentColor 30%,transparent); }
/* Both sticky insets keep the seat at the scrollport's bottom even while an
   expanding session view still reports its previous, shorter layout height. */
[data-conversation-scroll]:not(:has([data-conversation-composer-overlay])) > [data-lf-composer-docked] { top:var(--lf-composer-top); }
[data-lf-setting] { display:flex; flex-direction:column; gap:4px; padding:18px; color:inherit; }
[data-lf-setting-intro] { margin-bottom:16px; opacity:.65; font-size:13px; line-height:1.6; }
[data-lf-setting-footnote] { margin-top:14px; opacity:.55; font-size:12px; line-height:1.6; }
[data-lf-setting-row] { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:12px 0; border-bottom:1px solid color-mix(in srgb,currentColor 9%,transparent); }
[data-lf-setting-text] { min-width:0; }
[data-lf-setting-label] { font-size:14px; }
[data-lf-setting-hint] { font-size:12px; opacity:.6; margin-top:4px; line-height:1.5; }
[data-lf-setting-control], [data-lf-number], [data-lf-height-row] { display:flex; align-items:center; gap:6px; flex:none; }
[data-lf-number] input { width:65px; border:1px solid color-mix(in srgb,currentColor 20%,transparent); border-radius:6px; padding:5px; color:inherit; background:transparent; }
[data-lf-switch] { display:block; border:0; border-radius:20px; width:36px; height:21px; padding:3px; background:#9998; cursor:pointer; }
[data-lf-switch="1"] { background:#467bdf; }
[data-lf-knob] { display:block; width:15px; height:15px; background:white; border-radius:50%; transition:transform .12s; }
[data-lf-switch="1"] [data-lf-knob] { transform:translateX(15px); }
[data-lf-setting] button:disabled, [data-lf-setting] input:disabled { opacity:.4; cursor:default; }
[data-lf-height-reset] { font:inherit; font-size:12px; color:inherit; background:transparent; border:1px solid #9996; border-radius:6px; padding:5px; }
[data-lf-find] { display:flex; flex-direction:column; height:100%; min-height:0; padding:12px; gap:12px; box-sizing:border-box; }
[data-lf-find-head] { display:flex; align-items:center; gap:8px; }
[data-lf-find-head] input { min-width:0; flex:1; font:inherit; font-size:13px; padding:8px; color:inherit; background:transparent; border:1px solid #9996; border-radius:8px; }
[data-lf-find-count] { flex:none; opacity:.6; font-size:12px; }
[data-lf-find-list] { overflow:auto; display:flex; flex-direction:column; gap:6px; }
[data-lf-find-row] { text-align:left; display:flex; flex-direction:column; gap:5px; font:inherit; color:inherit; background:transparent; border:1px solid transparent; border-radius:8px; padding:9px; cursor:pointer; }
[data-lf-find-row]:hover, [data-lf-find-active="1"] { background:color-mix(in srgb,currentColor 6%,transparent); border-color:#9995; }
[data-lf-find-kind], [data-lf-find-empty] { opacity:.6; font-size:12px; line-height:1.7; }
[data-lf-find-snippet] { white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; line-height:1.6; }
::highlight(dsh-fold-match) { background:#ffce5580; color:inherit; }
@media print { [data-lf-owned] { display:none !important; } [data-lf-source], [data-lf-step-folded] { content-visibility:visible !important; block-size:auto !important; overflow:visible !important; } }
`

const CHEVRON = '<path d="M4 6l4 4 4-4" stroke-width="1.5"/>'
const DOUBLE_CHEVRON =
  '<path d="M4 4.5l4 3.5 4-3.5M4 9l4 3.5 4-3.5" stroke-width="1.4"/>'
const EVERY_STEP =
  '<path d="M4.5 3.5l3.5 3 3.5-3M3.5 9.5h9M3.5 12.5h9" stroke-width="1.4"/>'
// Only static, plugin-owned SVG markup is inserted here. Message text is never HTML.
const controlButton = (doc, attribute, glyph, step = false) => {
  const button = doc.createElement('button')
  button.type = 'button'
  button.setAttribute(attribute, '1')
  const icon = doc.createElement('span'),
    label = doc.createElement('span')
  if (step) icon.setAttribute('data-lf-icon', '1')
  icon.setAttribute('aria-hidden', 'true')
  icon.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`
  label.setAttribute('data-lf-label', '1')
  button.append(icon, label)
  return button
}
const labelButton = (button, label) => {
  const text = button.querySelector('[data-lf-label]')
  if (text.textContent !== label) text.textContent = label
  put(button, 'aria-label', label)
}

const put = (node, name, value) => {
  if (node.getAttribute(name) !== String(value))
    node.setAttribute(name, String(value))
}
const ownNode = (doc, tag, name) => {
  const node = doc.createElement(tag)
  node.setAttribute('data-lf-owned', '1')
  if (name) node.setAttribute(name, '1')
  return node
}
const turnOf = (node) =>
  node.closest('[data-chat-turn]')?.getAttribute('data-chat-turn') ?? ''
const messageKind = (node) =>
  ['user', 'steering', 'assistant-step'].includes(
    node.getAttribute('data-chat-flow-kind'),
  ) &&
  !node.closest(
    '[data-turn-process-member],[data-turn-process-hidden],[data-turn-process-inline]',
  ) &&
  !node.closest(SKIP)
const bodyOf = (node) => {
  if (node.getAttribute('data-chat-flow-kind') === 'assistant-step') {
    const root =
      node.querySelector('[data-streaming]') ??
      [...node.children].find((child) => !child.matches(OWN))
    return (
      [...(root?.children ?? [])].find((child) => !child.matches(OWN)) ?? null
    )
  }
  // Host 0.2.2-rc.1 renders the user text inside its own bubble component and
  // puts a slot chain (`conversation.chat.user.before`) in front of the stack,
  // so the fixed positional path below no longer lands on the text. Prefer the
  // marker the host puts on the bubble itself and keep the old path as the
  // fallback for hosts that predate it. `:not([data-lf-owned])` keeps our own
  // collapsed preview, which is a clone inserted before the source, out of the
  // way so the live node stays the one folded, searched and restored.
  const bubble =
    node.querySelector('[data-message-bubble]:not([data-lf-owned])') ??
    node.querySelector('[data-text-interaction-source]:not([data-lf-owned])')
  if (bubble) return bubble
  return (
    [...(node.firstElementChild?.firstElementChild?.children ?? [])].find(
      (child) =>
        !child.hasAttribute('data-message-attachments') && !child.matches(OWN),
    ) ?? null
  )
}
const isStep = (node) =>
  !node.closest(SKIP) &&
  (node.hasAttribute('data-step-process') ||
    node.hasAttribute('data-turn-process-member') ||
    node.getAttribute('data-chat-flow-kind') === 'turn-process' ||
    node.hasAttribute('data-turn-process-hidden'))

// Text rectangles, not box heights: margins, images and nested picture/img never
// consume the text budget. Every measured node belongs to a disposable clone.
function previewOf(doc, source, width, budget) {
  // A canvas or embedded document cannot be faithfully cloned. Preserve the
  // live message instead of duplicating playback or creating a broken control.
  if (
    source.querySelector(
      'iframe,object,embed,canvas,video,audio,input,textarea,select',
    )
  )
    return { count: 0, preview: null }
  const clone = source.cloneNode(true)
  const originals = [source, ...source.querySelectorAll('*')]
  const targets = new Map(
    [clone, ...clone.querySelectorAll('*')].map((node, index) => [
      node,
      originals[index],
    ]),
  )
  clone.removeAttribute('hidden')
  clone.removeAttribute('data-lf-source')
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const attr of [...node.attributes]) {
      if (
        /^on/i.test(attr.name) ||
        /^(id|name|autofocus)$/.test(attr.name) ||
        /^data-(chat|step|turn|lf|streaming)/.test(attr.name)
      )
        node.removeAttribute(attr.name)
    }
  }
  for (const unsafe of clone.querySelectorAll('script,style,[data-lf-owned]'))
    unsafe.remove()
  clone.setAttribute('data-lf-owned', '1')
  clone.setAttribute('data-lf-preview', 'collapsed')
  clone.setAttribute('aria-hidden', 'true')
  Object.assign(clone.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: `${width}px`,
    maxWidth: 'none',
    height: 'auto',
    maxHeight: 'none',
    boxSizing: 'border-box',
    visibility: 'hidden',
    pointerEvents: 'none',
    contentVisibility: 'visible',
    overflow: 'visible',
  })
  for (const image of clone.querySelectorAll('img')) image.loading = 'eager'
  source.parentNode.insertBefore(clone, source)
  const walker = doc.createTreeWalker(clone, 4)
  const texts = []
  const lines = []
  const lineBuckets = new Map()
  let node
  while ((node = walker.nextNode())) {
    if (!node.textContent.trim() || node.parentElement.closest(MEDIA)) continue
    const range = doc.createRange()
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()].filter(
      (rect) => rect.height > 0 && rect.width > 0,
    )
    const indexes = rects.map((rect) => {
      const bucket = Math.round(rect.top / 6)
      const nearby = [-2, -1, 0, 1, 2].flatMap(
        (offset) => lineBuckets.get(bucket + offset) ?? [],
      )
      let index =
        nearby.find((index) => {
          const line = lines[index]
          return (
            Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top) >
            0.7 * Math.min(line.bottom - line.top, rect.height)
          )
        }) ?? -1
      if (index < 0) {
        index = lines.length
        lines.push({ top: rect.top, bottom: rect.bottom })
        if (!lineBuckets.has(bucket)) lineBuckets.set(bucket, [])
        lineBuckets.get(bucket).push(index)
      }
      return index
    })
    texts.push({ node, range, indexes })
  }
  if (lines.length <= budget) {
    clone.remove()
    return { count: lines.length, preview: null }
  }
  for (const entry of texts) {
    const { node, range, indexes } = entry
    if (!indexes.some((index) => index < budget)) {
      node.textContent = ''
      continue
    }
    if (indexes.every((index) => index < budget)) continue
    let low = 0,
      high = node.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      range.setEnd(node, mid)
      const rects = [...range.getClientRects()].filter(
        (rect) => rect.width > 0 && rect.height > 0,
      )
      const allowed = rects.every((rect) =>
        lines
          .slice(0, budget)
          .some(
            (line) =>
              Math.min(line.bottom, rect.bottom) -
                Math.max(line.top, rect.top) >
              0.7 * Math.min(line.bottom - line.top, rect.height),
          ),
      )
      if (allowed) low = mid
      else high = mid - 1
    }
    if (low && /[\uD800-\uDBFF]/.test(node.textContent[low - 1])) low--
    node.textContent = node.textContent.slice(0, low)
  }
  // Empty markdown blocks must not leave phantom paragraphs/list items, and a
  // code block whose text fell outside the budget must not keep its chrome.
  // The host draws a copy button with an icon-sized <svg> inside every block;
  // treating that tick as "media" left an empty dark shell behind. Real media
  // still keeps its ancestors: every image regardless of size, plus any <svg>
  // large enough to be a diagram rather than a control icon.
  const KEPT = 'img,picture,source,video,canvas,iframe,audio'
  const iconSized = (element) => {
    const rect = element.getBoundingClientRect()
    return rect.width <= 32 && rect.height <= 32
  }
  const holdsContent = (element) =>
    element.querySelector(KEPT) !== null ||
    [...element.querySelectorAll('svg')].some((svg) => !iconSized(svg))
  const retainedText = texts
    .filter((entry) => entry.node.textContent.trim())
    .map((entry) => entry.node)
  for (const element of [...clone.querySelectorAll('*')].reverse()) {
    if (element.matches(MEDIA)) continue
    if (holdsContent(element)) continue
    if (
      element.tagName === 'BR' &&
      retainedText.some((node) => element.compareDocumentPosition(node) & 4)
    )
      continue
    if (!element.textContent.trim()) element.remove()
  }
  // A table whose body fell outside the line budget must not leave a floating
  // header row behind. The header cells still count as text lines, so the pass
  // above keeps them while every data cell is already gone.
  for (const table of [...clone.querySelectorAll('table')]) {
    if (!table.querySelector('thead, th')) continue
    if (holdsContent(table)) continue
    const cells = [...table.querySelectorAll('td')]
    if (cells.some((cell) => cell.textContent.trim())) continue
    table.remove()
  }
  for (const key of [
    'position',
    'left',
    'top',
    'height',
    'maxHeight',
    'visibility',
    'pointerEvents',
    'contentVisibility',
    'overflow',
  ])
    clone.style[key] = ''
  clone.style.maxWidth = '100%'
  clone.removeAttribute('aria-hidden')
  return { count: lines.length, preview: clone, targets }
}

export function start(env, React, timerStore) {
  const doc = env.document
  const view = doc.defaultView ?? env
  const F =
    env.__DSH_BUBBLE_FOLD_MODULES__?.fold ??
    view.__DSH_BUBBLE_FOLD_MODULES__?.fold
  if (!F) throw new Error('fold module unavailable')
  const TT =
    env.__DSH_BUBBLE_FOLD_MODULES__?.turnTimer ??
    view.__DSH_BUBBLE_FOLD_MODULES__?.turnTimer
  const timers = env.turnTimers ?? timerStore ?? view.__DSH_TURN_TIMERS__
  let stored = {}
  try {
    stored = JSON.parse(view.localStorage.getItem(F.STORAGE_KEY) ?? '{}')
  } catch {}
  let settings = F.migrateSettings(stored)
  try {
    view.localStorage.setItem(
      F.STORAGE_KEY,
      JSON.stringify({ ...settings, schemaVersion: F.SETTINGS_VERSION }),
    )
  } catch {}
  const messages = new Map(),
    blocks = new Map(),
    timerNodes = new Map(),
    stepState = new Map(),
    turnSpread = new Map(),
    listeners = new Set()
  const hiddenNodes = new Map(),
    choices = new Map(),
    hitCache = new WeakMap()
  let disposed = false,
    frame = 0,
    settle = 0,
    lastInput = -Infinity,
    session = '',
    sequence = 0,
    dirty = true
  let queue = [],
    queueLatest = '',
    queueIndex = 0,
    rebuilding = false
  // Rows whose own subtree changed. Only these are re-rendered between full
  // rebuilds; a structural change (new message, pagination, step block) still
  // rebuilds everything, because group/timer composition may have moved.
  const dirtyRows = new Set()
  let observedScrollRoot = null
  // One style read per scan (instead of one per message) and a width guard:
  // a container width change invalidates every cached measurement.
  let fontKey = '',
    lastRootWidth = 0
  // Measurement counters, read through `stats()`. They change no behaviour.
  const perf = {
    scans: 0,
    lastScanMs: 0,
    scanMs: 0,
    maxScanMs: 0,
    renders: 0,
    skipped: 0,
    previews: 0,
    folds: 0,
    previewMs: 0,
  }
  let lineHeight = 0
  // First-fold overlay state. `pendingShownAt === 0` means hidden.
  let pendingNode = null,
    pendingShownAt = 0,
    pendingArmed = false,
    pendingGaveUp = false,
    pendingTimer = 0,
    pendingFirstKey = '',
    pendingCount = 0
  const now = () => view.performance.now()
  const notify = () => {
    for (const fn of [...listeners]) {
      try {
        fn(settings)
      } catch {}
    }
  }
  const style = doc.createElement('style')
  style.id = F.STYLE_ID
  style.textContent = CSS
  doc.head.appendChild(style)
  const scrollRoot = () =>
    doc.querySelector('[data-conversation-scroll]') ?? doc.scrollingElement
  const anchor = () => {
    const root = scrollRoot()
    if (!root) return null
    const top = root.getBoundingClientRect().top
    const row = [...root.querySelectorAll('[data-chat-flow-kind]')].find(
      (node) =>
        !node.closest(OWN) &&
        node.getBoundingClientRect().bottom > top + 1 &&
        node.getBoundingClientRect().height > 0,
    )
    return row
      ? {
          root,
          row,
          top: row.getBoundingClientRect().top,
          scroll: root.scrollTop,
        }
      : null
  }
  const preserve = (fn, preferred) => {
    const pin = preferred
      ? {
          root: scrollRoot(),
          row: preferred,
          top: preferred.getBoundingClientRect().top,
        }
      : anchor()
    fn()
    if (pin?.root && pin.row.isConnected) {
      const delta = pin.row.getBoundingClientRect().top - pin.top
      if (Math.abs(delta) > 0.5) pin.root.scrollTop += delta
    }
  }
  function hide(node, mark) {
    if (!hiddenNodes.has(node))
      hiddenNodes.set(node, { hidden: node.getAttribute('hidden'), mark })
    put(node, mark, 'collapsed')
    put(node, 'hidden', 'until-found')
  }
  function show(node) {
    const previous = hiddenNodes.get(node)
    if (!previous) return
    node.removeAttribute(previous.mark)
    if (previous.hidden === null) node.removeAttribute('hidden')
    else put(node, 'hidden', previous.hidden)
    hiddenNodes.delete(node)
  }
  function release(record) {
    show(record.source)
    record.preview?.remove()
    record.control?.remove()
    messages.delete(record.row)
  }
  function sourceOpen(record, open) {
    record.open = open
    if (open) {
      show(record.source)
      record.preview?.remove()
    } else {
      if (record.preview && !record.preview.isConnected)
        record.source.after(record.preview)
      hide(record.source, 'data-lf-source')
    }
    if (record.control) {
      // Never re-insert the control when it already sits in the right place.
      // Moving a node between a pointer's press and release cancels the click,
      // and a live conversation re-scans (and used to re-insert) constantly.
      const anchor = open ? record.source : (record.preview ?? record.source)
      const parent = record.source.parentNode
      if (
        parent &&
        anchor?.parentNode === parent &&
        anchor.nextSibling !== record.control
      )
        parent.insertBefore(record.control, anchor.nextSibling)
    }
    put(record.button, 'aria-expanded', open)
    labelButton(
      record.button,
      open
        ? '收起'
        : `${record.side === 'user' ? '展开我的输入' : '展开全文'} · 还有 ${Math.max(1, record.count - record.budget)} 行`,
    )
  }
  function renderMessage(row, latest) {
    const source = bodyOf(row)
    if (!source || source.closest(OWN)) return
    const side =
      row.getAttribute('data-chat-flow-kind') === 'assistant-step'
        ? 'assistant'
        : 'user'
    let record = messages.get(row)
    if (record && record.source !== source) {
      release(record)
      record = null
    }
    const enabled = settings.enabled && settings[`${side}Enabled`]
    const streaming =
      row.hasAttribute('data-streaming') ||
      !!row.querySelector('[data-streaming="true"],[data-streaming=""]')
    if (!enabled || streaming) {
      if (record) release(record)
      return
    }
    const key =
      row.getAttribute('data-chat-anchor-key') ??
      row.getAttribute('data-chat-flow-key') ??
      `${turnOf(row)}:${side}:${sequence++}`
    const budget = settings.collapseAll
      ? settings.collapsedLines
      : settings[`${side}Lines`]
    perf.renders++
    // A message that already fits inside the budget cannot need a preview: its
    // whole height is at most `budget` lines. Cloning and measuring it first and
    // then throwing the clone away was pure overhead on short messages.
    if (!record && lineHeight > 0) {
      const box = source.getBoundingClientRect()
      if (box.height > 0 && box.height <= budget * lineHeight) {
        perf.skipped++
        return
      }
    }
    // Cheap digest instead of serializing the whole subtree. Reading every
    // message's innerHTML plus its computed font forced layout and style
    // resolution once per message per scan, which dominated long transcripts.
    const text = source.textContent ?? ''
    const digest = `${text.length}\u0000${text.slice(0, 24)}\u0000${text.slice(-24)}\u0000${budget}\u0000${fontKey}`
    if (!record || record.digest !== digest) {
      const width = Math.max(
        1,
        record
          ? row.getBoundingClientRect().width * record.ratio
          : source.getBoundingClientRect().width,
      )
      const previewStart = now()
      const result = previewOf(doc, source, width, budget)
      perf.previewMs += now() - previewStart
      perf.previews += 1
      if (result.preview) perf.folds += 1
      if (!result.preview) {
        if (record) release(record)
        return
      }
      if (!record) {
        const control = ownNode(doc, 'div', 'data-lf-control'),
          button = controlButton(doc, 'data-lf-toggle', CHEVRON)
        put(control, 'data-lf-control', side)
        control.appendChild(button)
        record = {
          row,
          source,
          side,
          key,
          control,
          button,
          ratio:
            source.getBoundingClientRect().width /
            Math.max(1, row.getBoundingClientRect().width),
          open: true,
          preview: null,
          digest: '',
        }
        messages.set(row, record)
      }
      record.preview?.remove()
      record.preview = result.preview
      record.count = result.count
      record.budget = budget
      record.digest = digest
      record.preview.addEventListener('click', (event) => {
        const action = event.target.closest('button,img')
        const original = result.targets.get(action)
        if (!original || !original.isConnected) return
        event.preventDefault()
        event.stopPropagation()
        choices.set(record.key, true)
        preserve(() => sourceOpen(record, true))
        original.click?.()
      })
    }
    record.control.style.marginTop = `${settings.extraPx}px`
    // A preference applies only until the reader makes an explicit choice.
    const open = !F.shouldFold({
      totalLines: record.count,
      budget,
      enabled,
      streaming,
      latest: turnOf(row) === latest,
      settings,
      choice: choices.get(record.key),
    })
    sourceOpen(record, open)
  }
  function units() {
    return [...doc.querySelectorAll(FLOW)].filter(
      (node) =>
        !node.closest(OWN) &&
        !node.parentElement?.closest('[data-step-process]') &&
        !node.parentElement?.closest('[data-chat-flow-kind]'),
    )
  }
  function nativeOpen(item) {
    const button = item.hasAttribute('data-step-process')
      ? (item.querySelector('[data-step-process-icon]')?.closest('button') ??
        item.querySelector('button[aria-controls]'))
      : item.querySelector('button[data-turn-process]')
    if (
      button &&
      !button.disabled &&
      button.getAttribute('aria-expanded') === 'false'
    )
      button.click()
  }
  function toggleBlock(block, open) {
    const wasOpen = stepState.get(block.key) === true
    stepState.set(block.key, open)
    for (const item of block.items) {
      if (open) show(item)
      else hide(item, 'data-lf-step-folded')
    }
    if (open && !wasOpen) for (const item of block.items) nativeOpen(item)
  }
  const blocksOfTurn = (turn) =>
    [...blocks.values()].filter((block) => block.turn === turn)
  const merged = (group) =>
    group.length > 1 &&
    !(turnSpread.get(group[0].turn) ?? !settings.mergeByDefault)
  // The turn that is still generating. Folding it hides its reasoning and tool
  // rows with `pointer-events:none`, so the reader cannot click the host's own
  // disclosure headers to follow what is being thought. That turn stays open
  // until it finishes; then the normal settings apply again. The mark is held
  // briefly so a gap between stream chunks cannot make the steps flicker shut.
  let liveHeld = '',
    liveAt = -Infinity
  const liveTurn = () => {
    const node = scrollRoot()?.querySelector('[data-streaming]') ?? null
    const turn =
      node?.closest?.('[data-chat-turn]')?.getAttribute('data-chat-turn') ?? ''
    if (turn) {
      liveHeld = turn
      liveAt = now()
    }
    return now() - liveAt < 1500 ? liveHeld : ''
  }
  function renderSteps(allUnits) {
    const live = liveTurn()
    const runs = []
    let run = null
    for (const unit of allUnits) {
      if (
        isStep(unit) &&
        !(
          unit.getAttribute('data-chat-flow-kind') === 'assistant-step' &&
          unit.querySelector('[data-streaming]')
        )
      ) {
        if (
          !run ||
          run.turn !== turnOf(unit) ||
          run.parent !== unit.parentNode
        ) {
          run = { items: [], turn: turnOf(unit), parent: unit.parentNode }
          runs.push(run)
        }
        run.items.push(unit)
      } else run = null
    }
    const wanted = new Set()
    for (const run of runs) {
      const first = run.items[0]
      wanted.add(first)
      let block = blocks.get(first)
      if (!block) {
        const line = ownNode(doc, 'div', 'data-lf-step-line'),
          single = controlButton(doc, 'data-lf-step-toggle', CHEVRON, true),
          all = controlButton(doc, 'data-lf-step-all', DOUBLE_CHEVRON, true),
          every = controlButton(doc, 'data-lf-step-every', EVERY_STEP, true)
        line.append(single, all, every)
        block = {
          line,
          single,
          all,
          every,
          key:
            first.getAttribute('data-chat-anchor-key') ?? `step:${sequence++}`,
        }
        blocks.set(first, block)
      }
      for (const previous of block.items ?? [])
        if (!run.items.includes(previous)) show(previous)
      Object.assign(block, run)
      if (!settings.enabled || !settings.workStepButtons) {
        block.line.remove()
        for (const item of run.items) show(item)
        continue
      }
      const last = run.items.at(-1)
      // Same rule as the message control: re-inserting an unchanged row on every
      // scan would swallow clicks that straddle a scan.
      if (last.nextSibling !== block.line) last.after(block.line)
    }
    for (const [first, block] of blocks)
      if (!wanted.has(first)) {
        block.line.remove()
        for (const item of block.items) show(item)
        blocks.delete(first)
      }
    const turns = new Map()
    // Runs are in document order, even when the host inserts a new earlier block.
    for (const run of runs) {
      const block = blocks.get(run.items[0])
      if (!turns.has(block.turn)) turns.set(block.turn, [])
      turns.get(block.turn).push(block)
    }
    for (const group of turns.values()) {
      if (!settings.enabled || !settings.workStepButtons) continue
      if (live && group[0].turn === live) {
        for (const block of group) {
          block.line.hidden = true
          for (const item of block.items) show(item)
        }
        continue
      }
      const last = group.at(-1),
        isMerged = merged(group),
        singleBlock = group.length === 1
      for (const block of group)
        toggleBlock(
          block,
          isMerged
            ? false
            : (stepState.get(block.key) ?? !settings.foldAllSteps),
        )
      const allOpen = group.every((block) => stepState.get(block.key) === true)
      for (const block of group) {
        const open = stepState.get(block.key) === true
        block.line.hidden = isMerged && block !== last
        block.single.hidden = singleBlock || isMerged
        block.all.hidden = block !== last
        block.every.hidden = block !== last || singleBlock || isMerged
        put(block.single, 'aria-expanded', open)
        put(block.all, 'aria-expanded', singleBlock ? allOpen : !isMerged)
        put(block.every, 'aria-expanded', allOpen)
        labelButton(block.single, open ? '收起本步骤' : '展开本步骤')
        labelButton(
          block.all,
          (singleBlock ? allOpen : !isMerged) ? '收起全部' : '展开全部',
        )
        labelButton(block.every, allOpen ? '收起所有步骤' : '展开所有步骤')
        block.single.title = block.single.getAttribute('aria-label')
        block.all.title = singleBlock
          ? allOpen
            ? '收起这一段步骤'
            : '展开这一段步骤'
          : isMerged
            ? `展开全部：显示本轮 ${group.length} 段步骤的开关`
            : '收起全部：收起本轮步骤，只留一个按钮'
        block.every.title = allOpen
          ? '收起本轮所有步骤的内容'
          : '展开本轮所有步骤的内容'
        for (const button of [block.single, block.all, block.every])
          put(button, 'data-lf-text', settings.stepLabels ? '1' : '0')
      }
    }
  }
  function renderTimers(allUnits) {
    const last = new Map()
    for (const unit of allUnits)
      if (
        messageKind(unit) &&
        unit.getAttribute('data-chat-flow-kind') === 'assistant-step'
      )
        last.set(turnOf(unit), unit)
    const durations = timers?.get?.() ?? {}
    for (const [turn, unit] of last) {
      const ms = durations[turn]
      if (
        !settings.enabled ||
        !settings.turnTimer ||
        typeof ms !== 'number' ||
        !Number.isFinite(ms)
      )
        continue
      let chip = timerNodes.get(turn)
      if (!chip) {
        chip = ownNode(doc, 'div', 'data-lf-turn-timer')
        put(chip, 'data-lf-turn-id', turn)
        timerNodes.set(turn, chip)
      }
      const text =
        TT?.formatDuration?.(ms) ?? `本轮用时 ${(ms / 1000).toFixed(1)} 秒`
      if (chip.textContent !== text) chip.textContent = text
      if (chip.parentNode !== unit) unit.appendChild(chip)
    }
    for (const [turn, chip] of timerNodes)
      if (
        !last.has(turn) ||
        !settings.enabled ||
        !settings.turnTimer ||
        !Number.isFinite(durations[turn])
      ) {
        chip.remove()
        timerNodes.delete(turn)
      }
  }
  // ---- first-fold overlay -------------------------------------------------
  // The transcript is covered while it is being folded for the first time (or
  // after older history is prepended), so heights never shift under the reader.
  const overlayNode = () => {
    if (pendingNode) return pendingNode
    pendingNode = ownNode(doc, 'div', 'data-lf-pending')
    pendingNode.setAttribute('role', 'status')
    pendingNode.setAttribute('aria-live', 'polite')
    const badge = ownNode(doc, 'div', 'data-lf-pending-badge')
    const spinner = ownNode(doc, 'span', 'data-lf-spinner')
    spinner.setAttribute('aria-hidden', 'true')
    const label = ownNode(doc, 'span', 'data-lf-pending-label')
    label.textContent = '正在整理会话…'
    badge.append(spinner, label)
    pendingNode.appendChild(badge)
    // The layer only covers the transcript: the composer stays usable.
    pendingNode.addEventListener('wheel', (event) => event.preventDefault(), {
      passive: false,
    })
    pendingNode.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    return pendingNode
  }
  const placeOverlay = () => {
    // Only a real conversation pane may be covered; settings pages and empty
    // states have no session root and would otherwise get a full-page layer.
    if (!doc.querySelector('[data-conversation-session]')) return false
    const rect = scrollRoot()?.getBoundingClientRect?.()
    if (!rect || rect.width < 80 || rect.height < 80) return false
    const node = overlayNode()
    node.style.left = `${Math.round(rect.left)}px`
    node.style.top = `${Math.round(rect.top)}px`
    node.style.width = `${Math.round(rect.width)}px`
    node.style.height = `${Math.round(rect.height)}px`
    if (!node.isConnected) doc.body.appendChild(node)
    return true
  }
  const hideOverlay = () => {
    view.clearTimeout(pendingTimer)
    pendingTimer = 0
    if (pendingShownAt === 0) {
      pendingNode?.removeAttribute('data-lf-visible')
      return
    }
    pendingShownAt = 0
    pendingNode?.removeAttribute('data-lf-visible')
  }
  const showOverlay = () => {
    if (disposed || !placeOverlay()) return
    if (pendingShownAt === 0) {
      pendingShownAt = now()
      pendingTimer = view.setTimeout(() => {
        pendingTimer = 0
        // Failsafe: never trap the reader behind a badge that cannot finish.
        pendingGaveUp = true
        pendingArmed = false
        hideOverlay()
      }, PENDING_MAX_MS)
    }
    pendingNode.setAttribute('data-lf-visible', '')
  }
  // ---- loaded-content hint ------------------------------------------------
  // The host unloads older turns only when the conversation is re-entered, and
  // that is also what makes the page fast again. The plugin cannot unload host
  // content, so once the transcript holds many turns it offers the same action
  // as a dismissible hint instead of doing it silently behind the reader.
  let hintNode = null,
    hintDismissed = false,
    hintTurns = 0
  const hintElement = () => {
    if (hintNode) return hintNode
    hintNode = ownNode(doc, 'div', 'data-lf-hint')
    hintNode.setAttribute('role', 'status')
    const text = ownNode(doc, 'span', 'data-lf-hint-text')
    text.textContent = ''
    const close = ownNode(doc, 'button', 'data-lf-hint-close')
    close.type = 'button'
    close.setAttribute('aria-label', '不再提示')
    close.textContent = '×'
    close.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      hintDismissed = true
      hideHint()
    })
    hintNode.append(text, close)
    return hintNode
  }
  const hideHint = () => hintNode?.removeAttribute('data-lf-visible')
  const showHint = () => {
    const node = hintElement()
    const label = `已加载 ${hintTurns} 轮，变慢时可切走再切回以释放内存`
    const span = node.querySelector('[data-lf-hint-text]')
    if (span && span.textContent !== label) span.textContent = label
    const seat = doc.querySelector('[data-composer-seat]')
    const rect = seat?.getBoundingClientRect?.()
    const top =
      rect && rect.height > 0
        ? Math.max(8, Math.round(rect.top) - 44)
        : Math.round(view.innerHeight - 160)
    node.style.top = `${top}px`
    if (!node.isConnected) doc.body.appendChild(node)
    node.setAttribute('data-lf-visible', '')
  }
  function scan() {
    frame = 0
    if (disposed) return
    const scanStart = now()
    observer.disconnect()
    try {
      preserve(() => {
        const currentRoot = scrollRoot()
        if (currentRoot !== observedScrollRoot) {
          if (observedScrollRoot) resize.unobserve(observedScrollRoot)
          observedScrollRoot = currentRoot
          if (currentRoot) resize.observe(currentRoot)
        }
        if (settings.enabled) put(doc.documentElement, F.ROOT_ATTRIBUTE, 'on')
        else doc.documentElement.removeAttribute(F.ROOT_ATTRIBUTE)
        // Font changes alter wrapping; sampled once per scan so the per-message
        // digest never has to resolve styles itself.
        fontKey =
          view
            .getComputedStyle(doc.documentElement)
            .getPropertyValue('--dsh-content-font-size')
            .trim() ||
          view.getComputedStyle(doc.documentElement).fontSize ||
          ''
        const nextSession =
          doc
            .querySelector('[data-conversation-session]')
            ?.getAttribute('data-conversation-session') ?? ''
        if (nextSession !== session) {
          choices.clear()
          stepState.clear()
          turnSpread.clear()
          session = nextSession
          // Entering a conversation: cover the transcript until it is folded.
          pendingArmed = true
          pendingGaveUp = false
          hintDismissed = false
          hideHint()
        }
        if (rebuilding) {
          dirtyRows.clear()
          const list = units(),
            latest = [...list].reverse().find((unit) => turnOf(unit))
          queue = list.filter(messageKind)
          queueIndex = 0
          queueLatest = latest ? turnOf(latest) : ''
          // "加载更早" prepends rows: the first message changes while the list
          // grows. A resize or a new reply at the bottom must not arm the layer.
          const firstKey =
            list
              .find((unit) => messageKind(unit))
              ?.getAttribute('data-chat-anchor-key') ?? ''
          if (
            pendingFirstKey &&
            firstKey &&
            firstKey !== pendingFirstKey &&
            list.length > pendingCount
          ) {
            pendingArmed = true
            pendingGaveUp = false
          }
          pendingFirstKey = firstKey
          pendingCount = list.length
          const turnIds = new Set()
          for (const unit of list) {
            const id = turnOf(unit)
            if (id) turnIds.add(id)
          }
          hintTurns = turnIds.size
          rebuilding = false
          const live = new Set(list)
          for (const [row, record] of messages)
            if (!row.isConnected || !live.has(row)) release(record)
          renderSteps(list)
          renderTimers(list)
          composer.sync(settings.enabled, settings.composerResize)
        }
        // Row-local edits do not need the rebuild above: only the touched rows
        // are re-rendered, which keeps streaming and typing from re-walking the
        // whole transcript.
        if (dirtyRows.size) {
          for (const row of dirtyRows)
            if (row.isConnected) renderMessage(row, queueLatest)
          dirtyRows.clear()
        }
        // One computed-style probe per scan feeds the "already fits" fast path.
        if (queue.length) {
          const probe = queue[Math.min(queueIndex, queue.length - 1)]
          const probeBody = probe?.isConnected ? bodyOf(probe) : null
          if (probeBody) {
            const next = Number.parseFloat(
              view.getComputedStyle(probeBody).lineHeight,
            )
            if (Number.isFinite(next) && next > 0) lineHeight = next
          }
        }
        const streamingBusy =
          doc.querySelector(
            '[data-conversation-scroll] [data-streaming]',
          ) !== null
        if (!settings.enabled) {
          pendingArmed = false
          hideOverlay()
        }
        const overlayBusy = pendingShownAt !== 0
        if (overlayBusy || now() - lastInput > 180 || !settings.enabled) {
          const started = now()
          // Behind the overlay the reader is not reading yet, so a bigger slice
          // is safe and keeps the wait short.
          const budget = overlayBusy ? PENDING_BUDGET_MS : SCAN_BUDGET_MS
          while (queueIndex < queue.length) {
            const row = queue[queueIndex++]
            if (row.isConnected) renderMessage(row, queueLatest)
            if (now() - started > budget) break
          }
          if (queueIndex < queue.length) schedule()
          else queue = []
        }
        const stillFolding =
          pendingArmed &&
          !pendingGaveUp &&
          !streamingBusy &&
          (queueIndex < queue.length || rebuilding)
        if (stillFolding) showOverlay()
        else {
          // Nothing left to fold. Disarm, otherwise every later rebuild — a
          // keystroke in the composer, a resize, a new reply — would look like
          // "still folding" and bring the layer back.
          pendingArmed = false
          if (pendingShownAt !== 0) {
            if (
              pendingGaveUp ||
              streamingBusy ||
              now() - pendingShownAt >= PENDING_MIN_MS
            )
              hideOverlay()
            else schedule()
          }
        }
        if (
          hintTurns >= LOADED_TURN_HINT &&
          !hintDismissed &&
          !streamingBusy &&
          settings.enabled
        )
          showHint()
        else hideHint()
      })
    } finally {
      observe()
    }
    if (dirty) {
      dirty = false
      notify()
    }
    const elapsed = now() - scanStart
    perf.scans += 1
    perf.lastScanMs = Math.round(elapsed * 100) / 100
    perf.scanMs += elapsed
    if (elapsed > perf.maxScanMs) perf.maxScanMs = Math.round(elapsed * 100) / 100
  }
  function schedule(changed = false) {
    if (disposed) return
    if (changed) {
      dirty = true
      rebuilding = true
    }
    if (!frame) frame = view.requestAnimationFrame(scan)
  }
  const observer = new view.MutationObserver((records) => {
    let structural = false
    for (const record of records) {
      if (record.target.nodeType === 1 && record.target.closest(OWN)) continue
      if (record.target.parentElement?.closest(OWN)) continue
      // Typing, draft chips and IME updates live inside the composer card and
      // never change the transcript. Treating each keystroke as a conversation
      // change made the plugin re-scan every message on every character.
      const touched =
        record.target.nodeType === 1
          ? record.target
          : record.target.parentElement
      if (touched?.closest?.('[data-composer-card]')) continue
      if (
        record.type === 'childList' &&
        [...record.addedNodes, ...record.removedNodes].every(
          (node) => node.nodeType === 1 && node.matches(OWN),
        )
      )
        continue
      if (
        record.type === 'attributes' &&
        record.attributeName === 'data-conversation-session'
      ) {
        structural = true
        continue
      }
      // Row-local edits (streaming text, a disclosure inside one message) only
      // need that row re-rendered. A step block or a container-level change can
      // move group membership, so those still rebuild everything.
      const row = touched?.closest?.(
        '[data-chat-flow-kind],[data-step-process]',
      )
      const rowIsStep =
        row?.hasAttribute('data-step-process') ||
        row?.getAttribute('data-chat-flow-kind') === 'turn-process'
      // Attributes on the row itself (membership markers, flow kind, streaming
      // flag) change how groups and step runs are computed, so they rebuild.
      const rowAttribute = record.type === 'attributes' && touched === row
      if (!row || rowIsStep || rowAttribute) {
        structural = true
        continue
      }
      dirtyRows.add(row)
    }
    if (structural) {
      rebuilding = true
      dirtyRows.clear()
    }
    if (structural || dirtyRows.size) schedule(structural)
  })
  function observe() {
    observer.observe(doc.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'data-chat-flow-kind',
        'data-chat-turn',
        'data-conversation-session',
        'data-content-phase',
        'data-phase',
        'data-streaming',
        'data-turn-process-member',
        'data-turn-process-hidden',
        'data-turn-process-answer',
        'data-turn-process-inline',
        'hidden',
        'aria-expanded',
        'contenteditable',
        'class',
        'style',
        'src',
        'srcset',
      ],
    })
  }
  const composer = createComposer(doc, view, notify, () => schedule(true))
  const resize = new view.ResizeObserver((entries) => {
    // Only a width change rewraps text; growth in height (streaming, new rows)
    // must not throw away the measured previews.
    const width =
      entries?.[0]?.contentRect?.width ??
      doc.querySelector('[data-conversation-scroll]')?.clientWidth ??
      0
    if (width > 0 && Math.abs(width - lastRootWidth) > 1) {
      lastRootWidth = width
      for (const record of messages.values()) record.digest = ''
    }
    schedule(true)
  })
  resize.observe(doc.documentElement)
  const resized = (event) => {
    if (event?.target?.closest?.(OWN)) return
    for (const record of messages.values()) record.digest = ''
    schedule(true)
  }
  const wheel = () => {
    lastInput = now()
    view.clearTimeout(settle)
    settle = view.setTimeout(() => schedule(), 200)
  }
  const click = (event) => {
    const target = event.target.closest?.(
      '[data-lf-toggle],[data-lf-step-toggle],[data-lf-step-all],[data-lf-step-every]',
    )
    if (!target) return
    event.preventDefault()
    const collapsing =
      [...messages.values()].some(
        (record) => record.button === target && record.open,
      ) ||
      (target.getAttribute('aria-expanded') === 'true' &&
        !target.hasAttribute('data-lf-toggle'))
    preserve(
      () => {
        for (const record of messages.values())
          if (record.button === target) {
            choices.set(record.key, !record.open)
            sourceOpen(record, !record.open)
            return
          }
        for (const block of blocks.values()) {
          if (block.single === target) {
            turnSpread.set(block.turn, true)
            toggleBlock(block, !stepState.get(block.key))
            schedule(true)
            return
          }
          if (block.all === target) {
            const group = blocksOfTurn(block.turn)
            if (group.length === 1) {
              turnSpread.set(block.turn, true)
              toggleBlock(block, !stepState.get(block.key))
            } else if (merged(group)) turnSpread.set(block.turn, true)
            else {
              turnSpread.set(block.turn, false)
              for (const item of group) toggleBlock(item, false)
            }
            schedule(true)
            return
          }
          if (block.every === target) {
            const group = blocksOfTurn(block.turn)
            const open = !group.every((item) => stepState.get(item.key))
            turnSpread.set(block.turn, true)
            for (const item of group) toggleBlock(item, open)
            schedule(true)
            return
          }
        }
      },
      collapsing ? target : null,
    )
  }
  const beforematch = (event) => {
    for (const record of messages.values())
      if (record.source.contains(event.target)) {
        choices.set(record.key, true)
        sourceOpen(record, true)
      }
    for (const block of blocks.values())
      if (block.items.some((item) => item.contains(event.target))) {
        turnSpread.set(block.turn, true)
        toggleBlock(block, true)
      }
    schedule(true)
  }
  doc.addEventListener('click', click)
  doc.addEventListener('beforematch', beforematch, true)
  doc.addEventListener('wheel', wheel, { passive: true, capture: true })
  doc.addEventListener('touchmove', wheel, { passive: true, capture: true })
  doc.addEventListener('load', resized, true)
  view.addEventListener('resize', resized)
  doc.fonts?.addEventListener?.('loadingdone', resized)
  const timerOff = timers?.subscribe?.(() => schedule(true))
  observe()
  scan()
  function search(query) {
    const needle = String(query ?? '')
      .trim()
      .toLocaleLowerCase()
    if (!needle) return []
    const candidates = [
      ...doc.querySelectorAll('[data-chat-flow-kind]'),
    ].filter(
      (row) =>
        !row.closest(OWN) &&
        !row.closest(SKIP) &&
        (messageKind(row) || isStep(row)),
    )
    const hits = []
    for (const row of candidates) {
      if (row.getAttribute('data-chat-flow-kind') === 'turn-process') continue
      const source = messageKind(row) ? bodyOf(row) : row
      if (!source) continue
      const walker = doc.createTreeWalker(source, 4),
        parts = []
      let node,
        text = ''
      while ((node = walker.nextNode()))
        if (!node.parentElement.closest(`${OWN},script,style`)) {
          parts.push({ node, start: text.length })
          text += node.textContent
        }
      const lower = text.toLocaleLowerCase()
      let from = 0,
        index
      while ((index = lower.indexOf(needle, from)) >= 0) {
        let cache = hitCache.get(source)
        if (!cache) {
          cache = new Map()
          hitCache.set(source, cache)
        }
        const key = `${needle}:${index}`
        let handle = cache.get(key)
        if (!handle) {
          handle = {}
          cache.set(key, handle)
        }
        Object.assign(handle, {
          source,
          row,
          parts,
          index,
          length: needle.length,
        })
        hits.push({
          element: handle,
          kind: messageKind(row) ? 'message' : 'step',
          snippet: `${index > 35 ? '…' : ''}${text.slice(Math.max(0, index - 35), index + needle.length + 65)}${index + needle.length + 65 < text.length ? '…' : ''}`,
          index,
        })
        from = index + Math.max(1, needle.length)
      }
    }
    return hits
  }
  function revealAt(handle) {
    handle = handle?.element ?? handle
    const source = handle?.source ?? handle
    if (!source?.isConnected) return false
    for (const record of messages.values())
      if (record.source === source || record.source.contains(source)) {
        choices.set(record.key, true)
        sourceOpen(record, true)
      }
    for (const block of blocks.values())
      if (
        block.items.some((item) => item === source || item.contains(source))
      ) {
        turnSpread.set(block.turn, true)
        toggleBlock(block, true)
        block.line.hidden = false
      }
    for (
      let node = source;
      node && node !== doc.body;
      node = node.parentElement
    ) {
      if (node.matches('[data-step-process]')) nativeOpen(node)
      if (node.getAttribute('hidden') === 'until-found')
        node.dispatchEvent(new view.Event('beforematch'))
    }
    view.requestAnimationFrame(() =>
      view.requestAnimationFrame(() => {
        if (!source.isConnected) return
        let rect = source.getBoundingClientRect()
        if (handle.parts) {
          const first = handle.parts.findLast(
            (part) => part.start <= handle.index,
          )
          const endIndex = handle.index + handle.length
          const last = handle.parts.findLast((part) => part.start < endIndex)
          if (first?.node.isConnected && last?.node.isConnected)
            try {
              const range = doc.createRange()
              range.setStart(
                first.node,
                Math.min(first.node.length, handle.index - first.start),
              )
              range.setEnd(
                last.node,
                Math.min(last.node.length, endIndex - last.start),
              )
              rect = range.getBoundingClientRect()
              if (view.CSS?.highlights && view.Highlight)
                view.CSS.highlights.set(
                  'dsh-fold-match',
                  new view.Highlight(range),
                )
            } catch {}
        }
        const root = scrollRoot()
        if (root) {
          const bounds = root.getBoundingClientRect()
          root.scrollTop +=
            rect.top -
            bounds.top -
            Math.max(20, (root.clientHeight - rect.height) / 3)
        }
      }),
    )
    schedule(true)
    return true
  }
  return {
    settings: () => ({ ...settings }),
    update(patch) {
      settings = F.normalizeSettings({ ...settings, ...patch })
      try {
        view.localStorage.setItem(
          F.STORAGE_KEY,
          JSON.stringify({ ...settings, schemaVersion: F.SETTINGS_VERSION }),
        )
      } catch {}
      if (
        [
          'enabled',
          'userEnabled',
          'assistantEnabled',
          'userLines',
          'assistantLines',
          'collapsedLines',
          'collapseAll',
          'keepLatestOpen',
        ].some((key) => key in patch)
      )
        choices.clear()
      if (['foldAllSteps', 'workStepButtons'].some((key) => key in patch))
        stepState.clear()
      if (
        ['mergeByDefault', 'foldAllSteps', 'workStepButtons'].some(
          (key) => key in patch,
        )
      )
        turnSpread.clear()
      schedule(true)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    search,
    revealAt,
    rescan: () => schedule(true),
    scan: () => schedule(true),
    composer: () => composer.info(),
    setHeight: (value) => composer.setHeight(value),
    resetHeight: () => composer.reset(),
    stats: () => ({
      messages: messages.size,
      blocks: blocks.size,
      session,
      lineHeight,
      ...perf,
      avgScanMs: perf.scans
        ? Math.round((perf.scanMs / perf.scans) * 100) / 100
        : 0,
      avgPreviewMs: perf.previews
        ? Math.round((perf.previewMs / perf.previews) * 100) / 100
        : 0,
    }),
    diagnostics: () => ({
      messages: messages.size,
      blocks: blocks.size,
      session,
    }),
    dispose() {
      if (disposed) return
      disposed = true
      observer.disconnect()
      resize.disconnect()
      view.cancelAnimationFrame(frame)
      view.clearTimeout(settle)
      timerOff?.()
      doc.removeEventListener('click', click)
      doc.removeEventListener('beforematch', beforematch, true)
      doc.removeEventListener('wheel', wheel, true)
      doc.removeEventListener('touchmove', wheel, true)
      doc.removeEventListener('load', resized, true)
      view.removeEventListener('resize', resized)
      doc.fonts?.removeEventListener?.('loadingdone', resized)
      composer.dispose()
      for (const record of [...messages.values()]) release(record)
      for (const node of [...hiddenNodes.keys()]) show(node)
      for (const block of blocks.values()) block.line.remove()
      for (const chip of timerNodes.values()) chip.remove()
      view.clearTimeout(pendingTimer)
      pendingTimer = 0
      pendingNode?.remove()
      pendingNode = null
      pendingShownAt = 0
      pendingArmed = false
      hintNode?.remove()
      hintNode = null
      hintTurns = 0
      style.remove()
      doc.documentElement.removeAttribute(F.ROOT_ATTRIBUTE)
      view.CSS?.highlights?.delete('dsh-fold-match')
      listeners.clear()
    },
  }
}

function createComposer(doc, view, changed, reflow) {
  const cards = new Map(),
    saved = new Map(),
    observed = new Set()
  let height = COMPOSER_DEFAULT,
    manual = false,
    drag = null,
    enabled = false,
    resizable = false
  const resize = new view.ResizeObserver(reflow)
  try {
    const value = Number(view.localStorage.getItem(COMPOSER_STORAGE_KEY))
    if (value >= 32 && value <= 1400) {
      height = value
      manual = true
    }
  } catch {}
  const remember = (node, key) => {
    let map = saved.get(node)
    if (!map) {
      map = new Map()
      saved.set(node, map)
    }
    if (!map.has(key))
      map.set(key, [
        node.style.getPropertyValue(key),
        node.style.getPropertyPriority(key),
      ])
  }
  const write = (node, key, value, priority = '') => {
    if (
      node.style.getPropertyValue(key) === value &&
      node.style.getPropertyPriority(key) === priority
    )
      return
    remember(node, key)
    node.style.setProperty(key, value, priority)
  }
  const restore = (target, keys) => {
    for (const [node, props] of saved) {
      if (target && node !== target) continue
      for (const [key, [value, priority]] of props) {
        if (keys && !keys.includes(key)) continue
        if (value) node.style.setProperty(key, value, priority)
        else node.style.removeProperty(key)
        props.delete(key)
      }
      if (!props.size) saved.delete(node)
    }
  }
  // The host owns the composer's natural ceiling through this custom property
  // (rc.5 sets 336px on the seat). Read it back instead of assuming a constant,
  // so a later harness revision cannot make "restore natural height" land at
  // the wrong size. Falls back to the historical constant when it is absent.
  let naturalDefault = null
  const naturalHeight = () => {
    for (const record of cards.values()) {
      try {
        const value = view
          .getComputedStyle(record.seat)
          .getPropertyValue('--dsh-composer-text-max-height')
          .trim()
        const px = Number.parseFloat(value)
        if (Number.isFinite(px) && px >= 32) return Math.round(px)
      } catch {
        /* keep scanning, then fall back */
      }
    }
    return null
  }
  const placement = ['position', 'top', 'bottom', 'left', 'width', 'box-sizing']
  const editorSize = ['height', 'min-height', 'max-height']
  const release = (card, record) => {
    restore(record.seat)
    record.reserve?.remove()
    restore(card)
    if (record.scroll) restore(record.scroll)
    record.grip.remove()
    record.seat.removeAttribute('data-lf-composer-docked')
    record.seat.removeAttribute('data-lf-composer-recovered')
  }
  const viewportLimit = () =>
    Math.max(32, Math.min(1400, view.innerHeight - 180))
  const info = () => ({
    height,
    manual,
    min: 32,
    max: Math.min(
      viewportLimit(),
      ...[...cards.values()]
        .filter((record) => record.visible)
        .map((record) => record.limit ?? 1400),
    ),
    default: naturalDefault ?? COMPOSER_DEFAULT,
  })
  function apply() {
    // Swap only fixed placement and its equal-height reservation. Keep editor
    // sizing in place: clearing it before measuring briefly shrinks the native
    // scroll range and can be mistaken for a return to the tail by the host.
    for (const { seat, reserve } of cards.values()) {
      if (reserve?.isConnected) {
        restore(seat, placement)
        reserve.remove()
        seat.removeAttribute('data-lf-composer-recovered')
      }
    }
    if (!enabled) return
    for (const [card, record] of cards) {
      const { seat } = record
      const scroll = card.querySelector('[data-input-scroll]')
      if (record.scroll !== scroll) {
        if (record.scroll) restore(record.scroll)
        record.scroll = scroll
      }
      const root = seat.parentElement?.matches('[data-conversation-scroll]')
        ? seat.parentElement
        : null
      const bounds = root?.getBoundingClientRect()
      record.visible =
        card.getClientRects().length > 0 && (!bounds || bounds.height > 0)
      if (!record.visible) continue
      const available = bounds
        ? Math.max(
            0,
            Math.min(view.innerHeight, bounds.bottom) - Math.max(0, bounds.top),
          )
        : view.innerHeight
      const chrome = scroll
        ? Math.max(
            0,
            seat.getBoundingClientRect().height -
              scroll.getBoundingClientRect().height,
          )
        : 0
      // Keep some conversation visible, including when an old preference was
      // saved on a much taller display. Never overwrite that preference here.
      record.limit = Math.max(
        32,
        Math.min(viewportLimit(), available - chrome - 64),
      )
      // The host card already establishes this containing block. Keep the
      // fallback reversible for older composer layouts that are static.
      if (resizable && view.getComputedStyle(card).position === 'static')
        write(card, 'position', 'relative')
      else if (!resizable) restore(card, ['position'])
      if (resizable && manual) {
        const effective = Math.min(height, record.limit)
        write(seat, '--dsh-composer-text-max-height', `${effective}px`)
        if (scroll) {
          write(scroll, 'height', `${effective}px`)
          write(scroll, 'min-height', `${effective}px`)
          write(scroll, 'max-height', `${effective}px`)
        }
      } else {
        restore(seat, ['--dsh-composer-text-max-height'])
        if (scroll) restore(scroll, editorSize)
      }
      const phase = seat.closest('[data-content-phase],[data-phase]')
      const active =
        (phase?.getAttribute('data-content-phase') ??
          phase?.getAttribute('data-phase')) === 'active'
      if (
        root &&
        active &&
        !root.querySelector('[data-conversation-composer-overlay]') &&
        view.getComputedStyle(seat).position === 'sticky'
      ) {
        write(
          seat,
          '--lf-composer-top',
          `${Math.max(0, root.clientHeight - seat.getBoundingClientRect().height)}px`,
        )
        put(seat, 'data-lf-composer-docked', '1')
      } else {
        restore(seat, ['--lf-composer-top'])
        seat.removeAttribute('data-lf-composer-docked')
      }
      if (
        root &&
        active &&
        !root.querySelector('[data-conversation-composer-overlay]')
      ) {
        const pane = seat.closest('[data-conversation-content]')
        const area = pane?.getBoundingClientRect() ?? bounds
        const bottom = Math.min(view.innerHeight, area.bottom)
        const top = Math.max(0, area.top)
        const box = seat.getBoundingClientRect()
        if (
          box.height > 0 &&
          box.height <= bottom - top &&
          Math.abs(box.bottom - bottom) > 2
        ) {
          // Keep the original scroll owner, composer node and parent. Reserving
          // exactly its height preserves the native history/follow scroll range.
          record.reserve ??= ownNode(doc, 'div', 'data-lf-composer-reserve')
          record.reserve.setAttribute('aria-hidden', 'true')
          record.reserve.inert = true
          record.reserve.style.cssText = `flex:0 0 ${box.height}px;height:${box.height}px;min-height:${box.height}px;margin:0;padding:0;border:0;pointer-events:none;overflow-anchor:none;`
          seat.before(record.reserve)
          write(seat, 'position', 'fixed', 'important')
          write(seat, 'top', `${bottom - box.height}px`, 'important')
          write(seat, 'bottom', 'auto', 'important')
          write(seat, 'left', `${box.left}px`, 'important')
          write(seat, 'width', `${box.width}px`, 'important')
          write(seat, 'box-sizing', 'border-box')
          put(seat, 'data-lf-composer-recovered', '1')
        }
      }
      put(record.grip, 'aria-valuemax', record.limit)
      put(record.grip, 'aria-valuenow', Math.min(height, record.limit))
    }
  }
  function setHeight(value, floor = 32) {
    if (!Number.isFinite(Number(value))) return
    height = Math.round(Math.max(floor, Math.min(info().max, Number(value))))
    manual = true
    try {
      view.localStorage.setItem(COMPOSER_STORAGE_KEY, String(height))
    } catch {}
    apply()
    changed()
  }
  function reset() {
    manual = false
    try {
      view.localStorage.removeItem(COMPOSER_STORAGE_KEY)
    } catch {}
    // Restore the host's own ceiling first, then measure it: while a manual
    // preference is applied this property carries our value, not the host's.
    apply()
    const natural = naturalHeight()
    if (natural !== null) naturalDefault = natural
    height = naturalDefault ?? COMPOSER_DEFAULT
    changed()
  }
  function sync(on, allowResize) {
    enabled = on
    resizable = on && allowResize
    const wanted = new Set()
    if (on)
      for (const seat of doc.querySelectorAll('[data-composer-seat]')) {
        // The native editor stays mounted while submitting or busy, but switches
        // contenteditable to false. Its editing state must not remove the card
        // from layout management or detach the reader's resize handle.
        const input = seat.querySelector(
          '[data-composer-input],textarea,[contenteditable]',
        )
        const card =
          seat.querySelector('[data-composer-card]') ??
          input?.closest('[data-composer-card]') ??
          [...seat.children].find((child) => child.contains(input))
        if (!card) continue
        wanted.add(card)
        let record = cards.get(card)
        if (!record) {
          const grip = ownNode(doc, 'button', 'data-lf-composer-handle')
          grip.type = 'button'
          grip.setAttribute('role', 'separator')
          grip.setAttribute('aria-orientation', 'horizontal')
          grip.setAttribute('aria-label', '拖动调整输入框高度；双击恢复默认')
          grip.addEventListener('click', (event) => event.stopPropagation())
          record = { grip, seat }
          cards.set(card, record)
          put(grip, 'aria-valuemin', 32)
        }
        if (
          resizable &&
          (record.grip.parentNode !== card ||
            card.firstElementChild !== record.grip)
        )
          card.insertBefore(record.grip, card.firstChild)
        if (!resizable) record.grip.remove()
      }
    for (const [card, record] of cards)
      if (!wanted.has(card) || !card.isConnected) {
        release(card, record)
        cards.delete(card)
      }
    const targets = new Set()
    for (const { seat } of cards.values()) {
      targets.add(seat)
      if (seat.parentElement?.matches('[data-conversation-scroll]'))
        targets.add(seat.parentElement)
    }
    for (const node of observed)
      if (!targets.has(node)) {
        resize.unobserve(node)
        observed.delete(node)
      }
    for (const node of targets)
      if (!observed.has(node)) {
        resize.observe(node)
        observed.add(node)
      }
    apply()
  }
  function down(event) {
    const grip = event.target.closest?.('[data-lf-composer-handle]')
    if (!grip || event.button !== 0) return
    const card = grip.parentElement
    const scroll = card.querySelector('[data-input-scroll]')
    drag = {
      grip,
      id: event.pointerId,
      y: event.clientY,
      height:
        scroll?.getBoundingClientRect().height ??
        card.getBoundingClientRect().height,
    }
    grip.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.id) return
    const delta = event.clientY - drag.y
    if (Math.abs(delta) < 3) return
    setHeight(drag.height - delta, Math.min(32, drag.height))
    event.preventDefault()
  }
  function up(event) {
    if (!drag) return
    drag.grip.releasePointerCapture?.(drag.id)
    drag = null
  }
  function dbl(event) {
    if (event.target.closest?.('[data-lf-composer-handle]')) {
      event.preventDefault()
      reset()
    }
  }
  function key(event) {
    if (!event.target.matches?.('[data-lf-composer-handle]')) return
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      setHeight(
        Math.min(height, info().max) + (event.key === 'ArrowUp' ? 20 : -20),
      )
    }
    if (event.key === 'Home') {
      event.preventDefault()
      reset()
    }
  }
  doc.addEventListener('pointerdown', down, true)
  doc.addEventListener('pointermove', move)
  doc.addEventListener('pointerup', up)
  doc.addEventListener('pointercancel', up)
  doc.addEventListener('dblclick', dbl)
  doc.addEventListener('keydown', key)
  return {
    sync,
    info,
    setHeight,
    reset,
    dispose() {
      enabled = false
      resize.disconnect()
      observed.clear()
      for (const [card, record] of cards) release(card, record)
      restore()
      cards.clear()
      doc.removeEventListener('pointerdown', down, true)
      doc.removeEventListener('pointermove', move)
      doc.removeEventListener('pointerup', up)
      doc.removeEventListener('pointercancel', up)
      doc.removeEventListener('dblclick', dbl)
      doc.removeEventListener('keydown', key)
    },
  }
}
