// Verified against installed dsh-client-ui-layout: [data-rightbar-col] belongs
// directly to AppFrame; panelInfo.subscribe forwards the full layout store.
const FRAME_MARK = 'data-lf-frame'
const RULE_ID = 'dsh-bubble-fold-frame'

function tracksOf(value) {
  return String(value ?? '').match(/(?:[^\s(]+\([^)]*\)|[^\s]+)/g) ?? []
}

function hostWidth(frame) {
  const last = tracksOf(frame?.style?.gridTemplateColumns).at(-1) ?? ''
  const maximum = /minmax\([^,]+,\s*([\d.]+)px\s*\)/.exec(last)
  return maximum
    ? Number(maximum[1])
    : /^\d+(?:\.\d+)?px$/.test(last)
      ? Number.parseFloat(last)
      : 0
}

export function createRightbarControl({
  layout,
  view,
  document: doc,
  getSettings,
  updateSettings,
}) {
  const panels = layout?.panels
  const supported = typeof panels?.setRightbar === 'function'
  let frame = null
  let column = null
  let style = null
  let originalWidth = null
  let expectedWidth = null
  let pendingWidth = null
  let appliedRatio = null
  let disposed = false
  let applying = false
  let observer = null
  let discovery = null
  let layoutOff = () => {}
  let resizeObserver = null
  let parentObserver = null
  const viewport = () =>
    frame?.getBoundingClientRect?.().width || view.innerWidth || 0
  const ratio = (value) =>
    Math.max(30, Math.min(70, Math.round(Number(value) || 45)))
  const clearRule = () => {
    if (style) style.textContent = ''
    frame?.removeAttribute?.(FRAME_MARK)
  }
  const restore = () => {
    clearRule()
    if (originalWidth !== null && supported) {
      const width = originalWidth
      originalWidth = null
      expectedWidth = null
      pendingWidth = null
      try {
        panels.setRightbar(width)
      } catch {
        /* host may already be disposed */
      }
    }
    appliedRatio = null
  }
  const isShown = () => {
    if (
      !frame ||
      !column ||
      frame.hasAttribute('data-rightbar-collapsed') ||
      frame.hasAttribute('data-rightbar-fullscreen')
    )
      return false
    if (column.hidden || column.getAttribute('aria-hidden') === 'true')
      return false
    return hostWidth(frame) > 0 && column.childElementCount > 0
  }
  const writeRule = (width) => {
    const tracks = tracksOf(frame.style.gridTemplateColumns)
    if (tracks.length !== 3) {
      clearRule()
      return
    }
    if (!style) {
      style = doc.createElement('style')
      style.id = RULE_ID
      doc.head.appendChild(style)
    }
    frame.setAttribute(FRAME_MARK, '1')
    const rule = `[${FRAME_MARK}]:not([data-rightbar-collapsed]):not([data-rightbar-fullscreen]){grid-template-columns:${tracks.slice(0, 2).join(' ')} ${width}px !important}`
    if (style.textContent !== rule) style.textContent = rule
  }
  const refresh = () => {
    if (disposed || applying) return
    applying = true
    try {
      discover()
      if (!supported || !frame) return
      const settings = getSettings()
      if (settings?.enabled === false) {
        restore()
        return
      }
      if (!isShown()) {
        clearRule()
        pendingWidth = expectedWidth = appliedRatio = null
        return
      }
      const width = viewport()
      if (!(width > 0)) return
      let selected = ratio(settings?.rightbarRatio)
      const observed = hostWidth(frame)
      if (pendingWidth !== null && Math.abs(observed - pendingWidth) <= 2)
        pendingWidth = null
      if (
        appliedRatio === selected &&
        expectedWidth !== null &&
        observed > 0 &&
        Math.abs(observed - expectedWidth) > 2 &&
        (pendingWidth === null || frame.hasAttribute('data-dragging'))
      ) {
        selected = ratio((observed / width) * 100)
        updateSettings({ rightbarRatio: selected })
      }
      const px = Math.round((width * selected) / 100)
      if (originalWidth === null) originalWidth = observed
      appliedRatio = selected
      if (expectedWidth !== px) {
        expectedWidth = px
        pendingWidth = px
        panels.setViewportWidth?.(width)
        panels.setRightbar(px)
      }
      // The host reserves at least 400px for the conversation plus its left
      // sidebar. Honour that limit instead of overflowing the frame at 70%.
      const leading =
        Number.parseFloat(tracksOf(frame.style.gridTemplateColumns)[0]) || 0
      writeRule(Math.max(0, Math.min(px, Math.round(width - leading - 400))))
    } catch {
      clearRule()
    } finally {
      applying = false
    }
  }
  const discover = () => {
    const nextColumn = doc.querySelector?.('[data-rightbar-col]') ?? null
    const nextFrame = nextColumn?.parentElement ?? null
    if (nextFrame === frame) return
    clearRule()
    observer?.disconnect()
    resizeObserver?.disconnect()
    parentObserver?.disconnect()
    frame = nextFrame
    column = nextColumn
    pendingWidth = expectedWidth = appliedRatio = null
    if (!frame) return
    if (typeof view.MutationObserver === 'function') {
      observer = new view.MutationObserver(refresh)
      observer.observe(frame, {
        attributes: true,
        attributeFilter: [
          'style',
          'data-rightbar-collapsed',
          'data-rightbar-fullscreen',
          'data-dragging',
        ],
        childList: true,
      })
      // Keep content observation inside the right column, away from chat tokens.
      observer.observe(column, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'aria-hidden'],
      })
    }
    if (frame.parentElement && typeof view.MutationObserver === 'function') {
      parentObserver = new view.MutationObserver(refresh)
      parentObserver.observe(frame.parentElement, { childList: true })
    }
    if (typeof view.ResizeObserver === 'function') {
      resizeObserver = new view.ResizeObserver(() => {
        expectedWidth = null
        refresh()
      })
      resizeObserver.observe(frame)
    }
    discovery?.disconnect()
  }
  if (
    supported &&
    typeof view.MutationObserver === 'function' &&
    doc.documentElement
  ) {
    discovery = new view.MutationObserver((records) => {
      if (
        records.some((record) =>
          [...(record.addedNodes ?? [])].some(
            (node) =>
              node.matches?.('[data-rightbar-col]') ||
              node.querySelector?.('[data-rightbar-col]'),
          ),
        )
      )
        refresh()
    })
    discovery.observe(doc.documentElement, { childList: true, subtree: true })
  }
  try {
    layoutOff = layout?.panelInfo?.subscribe?.(refresh) ?? (() => {})
  } catch {
    /* local observer remains */
  }
  const onResize = () => {
    expectedWidth = null
    refresh()
  }
  view.addEventListener?.('resize', onResize)
  refresh()
  return {
    refresh,
    setRatio(value) {
      updateSettings({ rightbarRatio: ratio(value) })
      refresh()
    },
    info() {
      const width = viewport()
      let actual = 0
      try {
        actual = Number.parseFloat(view.getComputedStyle(column).width)
      } catch {
        /* unmounted */
      }
      return {
        supported,
        ratio: getSettings()?.rightbarRatio ?? 45,
        renderedRatio:
          width > 0 && actual > 0 ? Math.round((actual / width) * 100) : null,
        viewport: width,
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      discovery?.disconnect()
      parentObserver?.disconnect()
      resizeObserver?.disconnect()
      try {
        layoutOff()
      } catch {
        /* host disposal must continue */
      }
      view.removeEventListener?.('resize', onResize)
      restore()
      style?.remove()
    },
  }
}
