// Read-only timing adapter for DSH's observable Conversation chat target.

export function formatDuration(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0
    ? `本轮用时 ${(ms / 1000).toFixed(1)} 秒`
    : ''
}

/** A settled step is not a settled turn: tools can start another step afterwards. */
export function turnDurations(nodes, { turns, openTurn, partial } = {}) {
  if (!Array.isArray(nodes)) return {}
  const spans = new Map()
  for (const node of nodes) {
    if (
      node?.kind !== 'assistant' ||
      !Number.isInteger(node.turn) ||
      node.turn < 0
    )
      continue
    const timing = node.timing
    if (!timing) continue
    const start = timing.stepStartTime
    const end = timing.completedTime
    const span = spans.get(node.turn) ?? {
      start: Infinity,
      end: -Infinity,
      pending: false,
    }
    spans.set(node.turn, span)
    if (typeof start === 'number' && Number.isFinite(start))
      span.start = Math.min(span.start, start)
    if (typeof end === 'number' && Number.isFinite(end) && end >= start)
      span.end = Math.max(span.end, end)
    else span.pending = true
  }
  const durations = {}
  for (const [turn, span] of spans) {
    if (span.pending || turn === openTurn || turn === partial?.turn) continue
    // When supplied, the host's closed boundary is authoritative.
    if (turns?.get && turns.get(turn)?.status !== 'closed') continue
    if (Number.isFinite(span.start) && span.end >= span.start)
      durations[turn] = span.end - span.start
  }
  return durations
}

export function createTurnTimerStore() {
  let durations = Object.freeze({})
  const listeners = new Set()
  const set = (next) => {
    const value = next && typeof next === 'object' ? next : {}
    const keys = Object.keys(value)
    if (
      keys.length === Object.keys(durations).length &&
      keys.every((key) => durations[key] === value[key])
    )
      return
    durations = Object.freeze({ ...value })
    for (const listener of [...listeners]) {
      try {
        listener(durations)
      } catch {
        /* isolate consumer failures */
      }
    }
  }
  return {
    get: () => durations,
    set,
    clear: () => set({}),
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Follow the displayed conversation; no transport retention or page polling. */
export function watchTurnTimers({
  document: doc,
  view,
  conversation,
  sessions,
  store,
}) {
  const selector =
    '[data-conversation-region="chat"][data-conversation-session]'
  let disposed = false
  let occurrence = null
  let sessionId = null
  let bound = null
  let targetOff = () => {}
  let openOff = () => {}
  let listOff = () => {}
  const safeOff = (off) => {
    try {
      off?.()
    } catch {
      /* optional host source */
    }
  }
  const reset = () => {
    safeOff(targetOff)
    safeOff(openOff)
    targetOff = openOff = () => {}
    bound = null
    store.clear()
  }
  const bind = () => {
    if (disposed) return
    const nextOccurrence = doc.querySelector?.(selector) ?? null
    const nextId =
      nextOccurrence?.getAttribute?.('data-conversation-session') || null
    occurrence = nextOccurrence
    let nextBound = null
    try {
      if (nextId) nextBound = conversation.binding(nextId)
    } catch {
      /* session not retained yet */
    }
    if (nextId === sessionId && nextBound === bound) return
    reset()
    sessionId = nextId
    bound = nextBound
    if (!bound) return
    const owner = bound
    let target = null
    const pull = () => {
      if (disposed || owner !== bound) return
      try {
        const snapshot = target?.getSnapshot?.()
        // Never infer a completed turn from an intermediate finished tool step.
        if (!snapshot?.timeline?.turns?.get) {
          store.clear()
          return
        }
        store.set(
          turnDurations(snapshot.legacy?.nodes, {
            turns: snapshot.timeline.turns,
            openTurn: owner.openTurn?.getSnapshot?.(),
            partial: snapshot.legacy?.partial,
          }),
        )
      } catch {
        store.clear()
      }
    }
    try {
      target = owner.target('chat')
      targetOff = target.subscribe?.(pull) ?? (() => {})
      openOff = owner.openTurn?.subscribe?.(pull) ?? (() => {})
      pull()
    } catch {
      reset()
    }
  }
  let observer = null
  if (typeof view.MutationObserver === 'function' && doc.documentElement) {
    observer = new view.MutationObserver((records) => {
      if (disposed) return
      const relevant = records.some((record) => {
        if (record.type === 'attributes')
          return (
            record.target === occurrence || record.target?.matches?.(selector)
          )
        if (occurrence && !occurrence.isConnected) return true
        return [...(record.addedNodes ?? [])].some(
          (node) => node.matches?.(selector) || node.querySelector?.(selector),
        )
      })
      if (relevant) bind()
    })
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-conversation-session'],
    })
  }
  try {
    listOff = sessions?.list?.subscribe?.(bind) ?? (() => {})
  } catch {
    /* DOM events remain sufficient */
  }
  bind()
  return () => {
    disposed = true
    observer?.disconnect()
    safeOff(listOff)
    reset()
  }
}
