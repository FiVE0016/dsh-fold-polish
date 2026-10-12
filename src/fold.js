// Pure fold logic — no DOM access, so it can be unit tested in plain Node.
//
// Anchor contract (verified against @deepseek-ai/dsh-client-ui-chat 0.2.0-rc.2):
//   [data-chat-flow-kind="user"]           → user input row
//     > div (userRow)
//       > div (userStack)
//         > div (bubble)                   ← text body we clamp
//   [data-chat-flow-kind="assistant-step"] → assistant reply row
//     div (AssistantMarkdown root)[data-streaming?]
//       > div (body)                       ← markdown we clamp
//
// Only contract-level data-* attributes and structural descent are used; hashed
// CSS-module class names never appear here, so a host restyle cannot break this.

export const ROOT_ATTRIBUTE = 'data-dsh-bubble-fold'
export const STYLE_ID = 'dsh-bubble-fold-styles'
export const STORAGE_KEY = 'dsh.bubble-fold.settings'

export const SIDE_USER = 'user'
export const SIDE_ASSISTANT = 'assistant'

/** Where the manually adjusted composer height is remembered. */
export const COMPOSER_STORAGE_KEY = 'dsh.bubble-fold.composer-height'

/** The host's own cap, so "reset" means the stock height. */
export const COMPOSER_DEFAULT = 336

/** Keyboard step size for the composer height. */
export const HEIGHT_STEP = 40

/** Collapse policy for content that is over the line budget. */
export const MODE_OVERFLOW = 'overflow'
/** Collapse policy for every message, regardless of length. */
export const MODE_ALWAYS = 'always'

export const LIMITS = Object.freeze({
  minLines: 2,
  maxLines: 120,
  minExtraPx: 0,
  maxExtraPx: 120,
  maxDefaultCollapsedLines: 60,
  minRightbarRatio: 30,
  maxRightbarRatio: 70
})

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  userEnabled: true,
  assistantEnabled: true,
  /** Always applied, even when collapsedByDefault is on. */
  userLines: 6,
  assistantLines: 10,
  /** Gap kept between a collapsed message and its control row, in px. */
  extraPx: 8,
  /** Collapse every message, not only overlong ones. */
  collapseAll: false,
  /** Line budget used when collapseAll is on. */
  collapsedLines: 3,
  /** Never fold the newest turn's message bodies: that is what you are reading. */
  keepLatestOpen: true,
  /** Start every work-step block folded, newest turn included. */
  foldAllSteps: true,
  /** Float a small bubble 展开/收起 control below each native work-step row. */
  workStepButtons: true,
  /** Show a drag handle for manually adjusting the composer height. */
  composerResize: true,
  /** Turns start merged into one seam (folded blocks, a single arrow left). */
  mergeByDefault: true,
  /** Put the text (展开步骤/收起步骤) on the seam bubble, not just the icon. */
  stepLabels: false,
  /** Stamp each Turn's end with how long the round took (收到命令 → 输出完成). */
  turnTimer: true,
  /** Preferred right-sidebar width, as a percent of the frame (30–70). */
  rightbarRatio: 45
})

const clampInt = (value, min, max, fallback) => {
  const number = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

const clampBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

/** Coerce any stored/partial input into a complete, in-range settings object. */
export function normalizeSettings(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  return {
    enabled: clampBool(raw.enabled, DEFAULT_SETTINGS.enabled),
    userEnabled: clampBool(raw.userEnabled, DEFAULT_SETTINGS.userEnabled),
    assistantEnabled: clampBool(raw.assistantEnabled, DEFAULT_SETTINGS.assistantEnabled),
    userLines: clampInt(raw.userLines, LIMITS.minLines, LIMITS.maxLines, DEFAULT_SETTINGS.userLines),
    assistantLines: clampInt(raw.assistantLines, LIMITS.minLines, LIMITS.maxLines, DEFAULT_SETTINGS.assistantLines),
    extraPx: clampInt(raw.extraPx, LIMITS.minExtraPx, LIMITS.maxExtraPx, DEFAULT_SETTINGS.extraPx),
    collapseAll: clampBool(raw.collapseAll, DEFAULT_SETTINGS.collapseAll),
    collapsedLines: clampInt(raw.collapsedLines, LIMITS.minLines, LIMITS.maxDefaultCollapsedLines, DEFAULT_SETTINGS.collapsedLines),
    keepLatestOpen: clampBool(raw.keepLatestOpen, DEFAULT_SETTINGS.keepLatestOpen),
    foldAllSteps: clampBool(raw.foldAllSteps, DEFAULT_SETTINGS.foldAllSteps),
    workStepButtons: clampBool(raw.workStepButtons, DEFAULT_SETTINGS.workStepButtons),
    composerResize: clampBool(raw.composerResize, DEFAULT_SETTINGS.composerResize),
    mergeByDefault: clampBool(raw.mergeByDefault, DEFAULT_SETTINGS.mergeByDefault),
    stepLabels: clampBool(raw.stepLabels, DEFAULT_SETTINGS.stepLabels),
    turnTimer: clampBool(raw.turnTimer, DEFAULT_SETTINGS.turnTimer),
    rightbarRatio: clampInt(raw.rightbarRatio, LIMITS.minRightbarRatio, LIMITS.maxRightbarRatio, DEFAULT_SETTINGS.rightbarRatio)
  }
}

export function settingsForSide(settings, side) {
  if (side === SIDE_USER) {
    return { enabled: settings.userEnabled, lines: settings.userLines }
  }
  return { enabled: settings.assistantEnabled, lines: settings.assistantLines }
}

/**
 * Max height for the clamp box: exactly the visible line budget. Whatever sits
 * below the box — the control row and its gap — is real flow, never part of it.
 * @param lines - visible line budget.
 * @param lineHeight - resolved line height in CSS px.
 */
export function clampHeightFor(lines, lineHeight) {
  const height = (Number(lines) || 0) * (Number(lineHeight) || 0)
  if (!(height > 0)) return 0
  return Math.round(height)
}

/** Gap between a collapsed message and its control row, in px. */
export function gapFor(extraPx) {
  return Math.round(Math.max(0, Number(extraPx) || 0))
}

/**
 * Decide whether one message body should be clamped.
 * @param input.contentPx - full content height of the body.
 * @param input.lineHeight - resolved line height.
 */
export function shouldClamp(input) {
  const { contentPx, lineHeight, lines, collapseAll } = input
  if (!input.sideEnabled) return false
  if (input.streaming) return false
  if (input.alreadyWrapped) return false
  if (!(contentPx > 0) || !(lineHeight > 0)) return false
  if (collapseAll) return contentPx > clampHeightFor(lines, lineHeight)
  // Overflow mode and collapse-all share the same geometry test; the difference
  // is the line budget (per-side vs collapsedLines), which the caller supplies.
  return contentPx > clampHeightFor(lines, lineHeight)
}

/** A short human label for how much is hidden, e.g. "还有 12 行". */
export function hiddenLineLabel(contentPx, visiblePx, lineHeight) {
  if (!(lineHeight > 0)) return ''
  const hidden = Math.max(0, Math.round((contentPx - visiblePx) / lineHeight))
  if (hidden <= 0) return ''
  return `还有 ${hidden} 行`
}
