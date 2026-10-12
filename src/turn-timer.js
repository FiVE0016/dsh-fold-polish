// Per-turn duration chips — pure logic plus a tiny plain store.
//
// Data source (read-only, display-only like the rest of this plugin): the chat
// snapshot's settled nodes, each carrying `turn` and `timing`
// { stepStartTime, firstTokenTime, completedTime }. A Turn's duration is the
// span from its FIRST step's start to its LAST step's completion — i.e. from
// the host beginning to process the command to the final output landing.
// (Verified pattern against gbeta/dsh-token-speed lib/client.js, MIT.)
//
// No DOM access here, so everything is unit-testable in plain Node.

/**
 * Human label for a duration: seconds below a minute ("3.2秒" / "42秒"),
 * minutes above ("1分12秒"). Invalid input yields ''.
 */
export function formatDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return ''
  const seconds = value / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}分${rest}秒`
}

/**
 * Fold settled assistant nodes into { turn: milliseconds }.
 * A step without usable timing is skipped; a Turn with no timed step has no
 * entry, which is exactly what the DOM layer needs to leave it chip-less.
 */
export function turnDurations(nodes) {
  const spans = {}
  if (!Array.isArray(nodes)) return {}
  for (const node of nodes) {
    if (!node || node.kind !== 'assistant') continue
    const timing = node.timing
    if (!timing) continue
    const start = timing.stepStartTime
    const end = timing.completedTime
    if (typeof start !== 'number' || typeof end !== 'number') continue
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
    const key = Number(node.turn)
    if (!Number.isFinite(key)) continue
    const span = spans[key] ?? (spans[key] = { start, end })
    if (start < span.start) span.start = start
    if (end > span.end) span.end = end
  }
  const durations = {}
  for (const key of Object.keys(spans)) durations[key] = spans[key].end - spans[key].start
  return durations
}

/** Plain observable store bridging the snapshot probe and the DOM pass. */
export function createTurnTimerStore() {
  let durations = {}
  const listeners = new Set()
  return {
    get: () => durations,
    set(next) {
      durations = next && typeof next === 'object' ? next : {}
      for (const listener of [...listeners]) {
        try { listener(durations) } catch { /* one bad listener must not break the rest */ }
      }
    },
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {}
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    clear() {
      durations = {}
      for (const listener of [...listeners]) {
        try { listener(durations) } catch { /* ignore */ }
      }
    }
  }
}
