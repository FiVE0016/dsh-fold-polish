// Browser half — display-only folding of overlong user inputs and assistant replies.
//
// Design rules (kept deliberately strict so a host upgrade degrades softly):
//   1. Anchors are contract data-* attributes + structural descent only.
//   2. Movement lives in `max-height`/`padding-bottom`, never in the markup React owns.
//   3. Nothing is written to the session log, the model, or the agent.
//   4. Every clamp is reversible: disable the plugin and the DOM returns to stock.

const FLOW_ITEM = '[data-chat-flow-kind]'
const KIND_USER = 'user'
const KIND_STEERING = 'steering'
const KIND_ASSISTANT = 'assistant-step'
/** The Turn's own summary row ("已完成，用时 …"); its members are the step rows. */
const KIND_TURN_PROCESS = 'turn-process'
/** Marks a step row the plugin folded itself, for a block the host will not. */
const FOLD_MARK = 'data-lf-step-folded'

/**
 * Per-frame ceiling for the clamp pass. A long conversation holds over a
 * thousand flow items; measuring them all in one frame costs a forced layout per
 * item and stalls the interface outright, so the pass yields and reschedules.
 */
export const SCAN_BUDGET_MS = 4

/** Where the manually adjusted composer height is remembered. */
export const COMPOSER_STORAGE_KEY = 'dsh.bubble-fold.composer-height'

/** The host's own cap, so "reset" means the stock height. */
export const COMPOSER_DEFAULT = 336

// Ancestor markers that mean "this is not a message body" — tool output, a folded
// process envelope, context injection, a system prompt card, or an error row.
//
// 2026-10-13 拆分：真机诊断（stats.side.skipAncestor = 37739）证明宿主更新后把
// assistant-step 回复行包进了过程容器（[data-turn-process] / [data-step-process] /
// [data-step-process-content]），按老契约整表跳过就把「助手回复」全误杀了 —— 这是
// 「助手回复不再折叠、展开全文按钮消失」的根因。回复行自身的 flow-kind 已证明它是
// 正文，所以对它只保留「标记类」跳过（标记在锚点自身或祖先上都生效，closest 从
// 自身开始匹配）；「容器类」仍对 user/steering 生效，行为与老契约一致。
const SKIP_CONTAINERS = [
  '[data-turn-process]',
  '[data-step-process]',
  '[data-step-process-content]'
].join(',')
const SKIP_MARKERS = [
  '[data-turn-process-hidden]',
  '[data-turn-process-answer]',
  '[data-turn-process-inline]',
  '[data-context-fields]',
  '[data-context-text]',
  '[data-context-injection-body]',
  '[data-system-prompt-body]',
  '[data-variant]',
  '[data-error]',
  '[data-compaction-icon]',
  '[data-message-attachments]'
].join(',')
const SKIP_ANCESTORS = [SKIP_CONTAINERS, SKIP_MARKERS].join(',')

// A numeric/boolean control is meaningless while its gate is off.
const TIE = Object.freeze({
  userLines: 'userEnabled',
  assistantLines: 'assistantEnabled',
  collapsedLines: 'collapseAll'
})
const TIE_LABEL = Object.freeze({
  userEnabled: '折叠我的输入',
  assistantEnabled: '折叠助手回复',
  collapseAll: '全部消息都折叠'
})

const CSS = `
/* The clamp wrapper inherits the bubble's own alignment so wrapping never moves it. */
:root[data-dsh-bubble-fold] [data-lf-body] {
  position: relative !important;
  display: flex !important;
  flex-direction: column !important;
  max-width: 100% !important;
}
:root[data-dsh-bubble-fold] [data-lf-body="user"] {
  align-items: flex-end !important;
}
:root[data-dsh-bubble-fold] [data-lf-body="assistant"] {
  display: flex !important;
  flex-direction: column !important;
  align-items: flex-start !important;
  width: 100% !important;
}
:root[data-dsh-bubble-fold] [data-lf-clamped="1"] {
  display: block !important;
  /* Clipped, NOT scrollable. A scroll container here turned a passing wheel into
     "the reader wants the rest" and expanded messages nobody asked to open. The
     find panel reveals its hits itself (revealAt), so nothing needs to scroll it. */
  overflow: hidden !important;
  /* The visible box is exactly the line budget: nothing is reserved below it and
     nothing is pulled back up over it, so the control row under the message can
     never land on a line the reader is meant to see. Bottom padding has to go
     too — content overflows into the padding box, so a padded box would still
     paint the first pixels of the following line. */
  max-height: var(--lf-clamp-height, 0px) !important;
  padding-bottom: 0 !important;
  /* 无 transition：根治后扫描不再抖动，transition 只会把残余变化拉成渐变，
     看上去像「被慢慢吸下去」。高度变化只在真正该变的时候发生，瞬间到位更诚实。 */
}
:root[data-dsh-bubble-fold] [data-lf-clamped="1"][data-lf-open="1"] {
  max-height: none !important;
}
/* The message control is a bubble-styled capsule: rounded, softly elevated,
   with a chevron that flips between the collapsed and open states. */
:root[data-dsh-bubble-fold] [data-lf-toggle] {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  margin: 2px 0 0 !important;
  padding: 2px 10px 2px 8px !important;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, .12)) !important;
  border-radius: 999px !important;
  background: var(--dsw-alias-bg-base, #fff) !important;
  color: var(--dsw-alias-label-secondary, #68707d) !important;
  font-size: 12px !important;
  line-height: 18px !important;
  font-weight: 450 !important;
  cursor: pointer !important;
  user-select: none !important;
  white-space: nowrap !important;
  position: relative !important;
  z-index: 2 !important;
  box-shadow: 0 1px 5px rgba(15, 23, 42, .1) !important;
}
:root[data-dsh-bubble-fold] [data-lf-toggle] svg {
  width: 13px !important;
  height: 13px !important;
  flex: none !important;
  transition: transform .15s ease !important;
}
:root[data-dsh-bubble-fold] [data-lf-toggle][aria-expanded="true"] svg {
  transform: rotate(180deg) !important;
}
:root[data-dsh-bubble-fold] [data-lf-toggle]:hover {
  color: var(--dsw-alias-label-primary, #1f2328) !important;
  background: var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, .05)) !important;
}
/* One control row sits under each folded message it acts on. The gap above it is
   the "间距" setting — the row is in normal flow, never pulled back over the
   message, so it cannot cover the last visible line. */
:root[data-dsh-bubble-fold] [data-lf-tail] {
  display: flex !important;
  align-items: center !important;
  flex-wrap: wrap !important;
  gap: 6px !important;
  margin-top: var(--lf-gap, 4px) !important;
}
/* The row must be allowed to exceed the bubble: the capsule does not fit inside
   a 70%-wide bubble, and squeezing it there overlaps the bubble's own edge. */
:root[data-dsh-bubble-fold] [data-lf-body] + [data-lf-tail] {
  width: 100% !important;
  max-width: none !important;
}
:root[data-dsh-bubble-fold] [data-lf-tail="user"] {
  justify-content: flex-end !important;
}
:root[data-dsh-bubble-fold] [data-lf-tail="assistant"] {
  justify-content: flex-start !important;
}
/* display would beat the hidden attribute, so restate it */
:root[data-dsh-bubble-fold] [data-lf-tail][hidden] {
  display: none !important;
}
/* The work-step fold: ONE seam per process block, sitting between the run of
   step rows and the message bubble that follows them. It never owns the state —
   clicking it clicks every host control the block covers — so the chevron
   mirrors the host's own data-open. The seam is a LINE: the hairline runs
   through it and the controls ride on it, which is what lets a Turn's last seam
   carry a second, Turn-wide control without moving anything else. */
:root[data-dsh-bubble-fold] [data-lf-step-line] {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  width: 100% !important;
  box-sizing: border-box !important;
  margin: 2px 0 !important;
}
/* The per-turn duration chip: a muted, right-aligned line at a Turn's end. */
:root[data-dsh-bubble-fold] [data-lf-turn-timer] {
  margin: 0 8px 4px 0 !important;
  text-align: right !important;
  font-size: 11px !important;
  line-height: 1.5 !important;
  color: var(--dsw-alias-text-2, rgba(100, 116, 139, .85)) !important;
  user-select: none !important;
}
/* The hairlines turn the line into the seam that separates steps from reply. */
:root[data-dsh-bubble-fold] [data-lf-step-line]::before,
:root[data-dsh-bubble-fold] [data-lf-step-line]::after {
  content: "" !important;
  flex: 1 1 auto !important;
  height: 1px !important;
  background: var(--dsw-alias-border-l1, rgba(15, 23, 42, .1)) !important;
  transition: background-color .12s ease !important;
}
/* ONE geometry for all three seam controls, and ONE layer of chrome per mode:
   with the text off the icon holder IS the circle; with the text on the BUTTON
   is the pill and the icon holder drops its own chrome — the nesting (a bordered
   circle inside a bordered pill) was the "button inside a button" look. */
:root[data-dsh-bubble-fold] [data-lf-step-toggle],
:root[data-dsh-bubble-fold] [data-lf-step-all],
:root[data-dsh-bubble-fold] [data-lf-step-every] {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 4px !important;
  flex: none !important;
  height: 26px !important;
  padding: 0 !important;
  border: none !important;
  background: none !important;
  color: var(--dsw-alias-label-secondary, #68707d) !important;
  font-size: 11px !important;
  line-height: 18px !important;
  font-weight: 450 !important;
  cursor: pointer !important;
  user-select: none !important;
  white-space: nowrap !important;
  border-radius: 999px !important;
  appearance: none !important;
  -webkit-appearance: none !important;
  transition: color .12s ease, background-color .12s ease !important;
}
/* Icon-only mode: the holder is the circle. */
:root[data-dsh-bubble-fold] [data-lf-icon] {
  flex: none !important;
  width: 26px !important;
  height: 26px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, .12)) !important;
  border-radius: 50% !important;
  background: var(--dsw-alias-bg-base, #fff) !important;
  box-shadow: 0 2px 8px rgba(15, 23, 42, .14) !important;
  transition: color .12s ease, background-color .12s ease, box-shadow .12s ease, transform .12s ease !important;
}
:root[data-dsh-bubble-fold] [data-lf-icon] svg {
  width: 14px !important;
  height: 14px !important;
  flex: none !important;
  transition: transform .15s ease !important;
}
/* A control that reports "open" flips its own glyph. */
:root[data-dsh-bubble-fold] [data-lf-step-toggle][data-lf-step-open="1"] [data-lf-icon] svg,
:root[data-dsh-bubble-fold] [data-lf-step-all][data-lf-all-open="1"] [data-lf-icon] svg,
:root[data-dsh-bubble-fold] [data-lf-step-every][data-lf-every-open="1"] [data-lf-icon] svg {
  transform: rotate(180deg) !important;
}
:root[data-dsh-bubble-fold] [data-lf-step-toggle]:hover [data-lf-icon],
:root[data-dsh-bubble-fold] [data-lf-step-all]:hover [data-lf-icon],
:root[data-dsh-bubble-fold] [data-lf-step-every]:hover [data-lf-icon] {
  color: var(--dsw-alias-label-primary, #1f2328) !important;
  background: var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, .05)) !important;
}
:root[data-dsh-bubble-fold] [data-lf-step-toggle]:hover [data-lf-icon] {
  transform: scale(1.08) !important;
}
/* Text mode: the button carries the pill, the holder becomes a bare icon. */
:root[data-dsh-bubble-fold] [data-lf-step-toggle][data-lf-text="1"],
:root[data-dsh-bubble-fold] [data-lf-step-all][data-lf-text="1"],
:root[data-dsh-bubble-fold] [data-lf-step-every][data-lf-text="1"] {
  height: 24px !important;
  padding: 0 10px 0 5px !important;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, .12)) !important;
  background: var(--dsw-alias-bg-base, #fff) !important;
  box-shadow: 0 1px 4px rgba(15, 23, 42, .08) !important;
}
:root[data-dsh-bubble-fold] [data-lf-step-toggle][data-lf-text="1"]:hover,
:root[data-dsh-bubble-fold] [data-lf-step-all][data-lf-text="1"]:hover,
:root[data-dsh-bubble-fold] [data-lf-step-every][data-lf-text="1"]:hover {
  color: var(--dsw-alias-label-primary, #1f2328) !important;
  background: var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, .05)) !important;
}
:root[data-dsh-bubble-fold] [data-lf-text="1"] [data-lf-icon] {
  width: 16px !important;
  height: 16px !important;
  border: none !important;
  background: none !important;
  box-shadow: none !important;
  transform: none !important;
}
/* The text itself: shown only while the setting asks for it. */
:root[data-dsh-bubble-fold] [data-lf-step-label],
:root[data-dsh-bubble-fold] [data-lf-all-label],
:root[data-dsh-bubble-fold] [data-lf-every-label] {
  display: none !important;
}
:root[data-dsh-bubble-fold] [data-lf-step-toggle][data-lf-text="1"] [data-lf-step-label],
:root[data-dsh-bubble-fold] [data-lf-step-all][data-lf-text="1"] [data-lf-all-label],
:root[data-dsh-bubble-fold] [data-lf-step-every][data-lf-text="1"] [data-lf-every-label] {
  display: inline !important;
}
:root[data-dsh-bubble-fold] [data-lf-step-line]:hover::before,
:root[data-dsh-bubble-fold] [data-lf-step-line]:hover::after {
  background: var(--dsw-alias-border-l2, rgba(15, 23, 42, .22)) !important;
}
/* display would beat the hidden attribute, so restate it for every control */
:root[data-dsh-bubble-fold] [data-lf-step-line][hidden],
:root[data-dsh-bubble-fold] [data-lf-step-toggle][hidden],
:root[data-dsh-bubble-fold] [data-lf-step-all][hidden],
:root[data-dsh-bubble-fold] [data-lf-step-every][hidden] {
  display: none !important;
}
/* Rows the plugin folded itself, for a block the host refuses to fold. They are
   hidden "until found" rather than removed, so the browser's own find can reach
   them: it matches the text, fires beforematch, and the seam opens the block.
   The attribute is set in JS; this rule keeps browsers that map hidden to
   display:none on the same footing. */
:root[data-dsh-bubble-fold] [data-lf-step-folded] {
  content-visibility: hidden !important;
}
@supports not (content-visibility: hidden) {
  :root[data-dsh-bubble-fold] [data-lf-step-folded] {
    display: none !important;
  }
}
:root[data-dsh-bubble-fold] [data-lf-toggle]:disabled {
  opacity: .35 !important;
  cursor: default !important;
}
/* Drag handle for the composer height. Purely additive: no transition on the
   drag itself, so the resize cannot flicker. */
:root[data-dsh-bubble-fold] [data-lf-composer-handle] {
  /* The order property pins the handle to the top of the card's flex column
     regardless of where a host re-render would move it in the child list. */
  order: -1 !important;
  height: 12px !important;
  pointer-events: auto !important;
  margin: 0 8px 2px !important;
  cursor: ns-resize !important;
  position: relative !important;
  flex: none !important;
  user-select: none !important;
  touch-action: none !important;
}
:root[data-dsh-bubble-fold] [data-lf-composer-handle]:after {
  content: "" !important;
  position: absolute !important;
  left: 50% !important;
  top: 4px !important;
  transform: translateX(-50%) !important;
  width: 64px !important;
  height: 4px !important;
  border-radius: 2px !important;
  background: var(--dsw-alias-border-l2, rgba(15, 23, 42, .3)) !important;
  transition: background-color .12s ease !important;
}
:root[data-dsh-bubble-fold] [data-lf-composer-handle]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, .05)) !important;
}
:root[data-dsh-bubble-fold] [data-lf-composer-handle]:hover:after,
:root[data-dsh-bubble-fold] [data-lf-composer-handle][data-dragging]:after {
  background: var(--dsw-alias-state-business-primary, #4f6ef7) !important;
}
/* A settings dialog is user-invoked and dismissible — never a standing overlay
   hovering above the composer. */
:root[data-dsh-bubble-fold] [data-lf-scrim] {
  position: fixed !important;
  inset: 0 !important;
  z-index: 59 !important;
  background: rgba(15, 23, 42, .28) !important;
}
:root[data-dsh-bubble-fold] [data-lf-panel] {
  position: fixed !important;
  top: 50% !important;
  left: 50% !important;
  transform: translate(-50%, -50%) !important;
  z-index: 60 !important;
  box-sizing: border-box !important;
  width: min(320px, calc(100vw - 32px)) !important;
  padding: 12px 14px !important;
  border-radius: var(--dsw-radius-panel, 14px) !important;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, .12)) !important;
  background: var(--dsw-alias-bg-base, #fff) !important;
  box-shadow: var(--dsw-elevation-soft, 0 8px 28px rgba(15, 23, 42, .18)) !important;
  color: var(--dsw-alias-label-primary, #1f2328) !important;
  font-size: 13px !important;
  text-align: left !important;
}
:root[data-dsh-bubble-fold] [data-lf-panel] h4 {
  margin: 0 0 8px !important;
  font-size: 13px !important;
  font-weight: 600 !important;
}
:root[data-dsh-bubble-fold] [data-lf-panel] label {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 10px !important;
  padding: 3px 0 !important;
}
:root[data-dsh-bubble-fold] [data-lf-panel] input[type="number"] {
  width: 64px !important;
  box-sizing: border-box !important;
  padding: 2px 6px !important;
  border-radius: 6px !important;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, .12)) !important;
  background: var(--dsw-alias-bg-base, #fff) !important;
  color: inherit !important;
  font: inherit !important;
}
:root[data-dsh-bubble-fold] [data-lf-panel] footer {
  display: flex !important;
  justify-content: space-between !important;
  align-items: center !important;
  gap: 8px !important;
  margin-top: 10px !important;
  padding-top: 8px !important;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, .08)) !important;
}
:root[data-dsh-bubble-fold] [data-lf-panel] button {
  appearance: none !important;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, .12)) !important;
  background: transparent !important;
  color: inherit !important;
  font: inherit !important;
  padding: 2px 10px !important;
  border-radius: 999px !important;
  cursor: pointer !important;
}
:root[data-dsh-bubble-fold] [data-lf-panel] button:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, .05)) !important;
}
:root[data-dsh-bubble-fold] [data-lf-panel] [data-lf-hint] {
  color: var(--dsw-alias-label-tertiary, #8b93a1) !important;
  font-size: 12px !important;
  line-height: 16px !important;
}
/* Printing is the one place the reader cannot undo a fold: paper has no
   scrollbar and no click. Expand everything the plugin clamps by CSS —
   attribute-level hides are undone in JS before the snapshot, where a style
   recalc still lands — and drop every control that only makes sense while
   interacting. */
@media print {
  :root[data-dsh-bubble-fold] [data-lf-clamped="1"] {
    max-height: none !important;
    padding-bottom: 0 !important;
    margin-bottom: 0 !important;
  }
  :root[data-dsh-bubble-fold] [data-lf-clamped="1"]:not([data-lf-open="1"]):after {
    content: none !important;
  }
  /* A host group that folds with hidden="until-found" keeps its rows in the DOM,
     but Chromium still lays it out as display:none — paper needs both overrides.
     Scoped to the step rows so an unrelated closed menu can never print open. */
  :root[data-dsh-bubble-fold] [data-step-process] [hidden="until-found"],
  :root[data-dsh-bubble-fold] [data-turn-process-member][hidden="until-found"],
  :root[data-dsh-bubble-fold] [data-turn-process][hidden="until-found"] {
    display: revert !important;
    content-visibility: visible !important;
  }
  :root[data-dsh-bubble-fold] [data-lf-toggle],
  :root[data-dsh-bubble-fold] [data-lf-tail],
  :root[data-dsh-bubble-fold] [data-lf-step-line],
  :root[data-dsh-bubble-fold] [data-lf-composer-handle],
  :root[data-dsh-bubble-fold] [data-lf-panel],
  :root[data-dsh-bubble-fold] [data-lf-scrim] {
    display: none !important;
  }
}
/* The settings tab this plugin contributes to the host's Plugins settings
   section. Deliberately OUTSIDE the root-attribute scope: the tab must stay
   styled while the fold itself is toggled off, because its switch is the way
   back on. Every selector is namespaced, so nothing leaks. */
[data-lf-setting] {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
[data-lf-setting-empty] {
  color: var(--dsw-alias-label-secondary, #68707d);
  font-size: 13px;
}
[data-lf-setting-intro] {
  color: var(--dsw-alias-label-secondary, #68707d);
  font-size: 12.5px;
  line-height: 1.55;
  margin: 2px 0 10px;
}
[data-lf-setting-row] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, .08));
}
[data-lf-setting-row]:first-of-type {
  border-top: none;
}
[data-lf-setting-text] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
[data-lf-setting-label] {
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
  font-weight: 500;
}
[data-lf-setting-hint] {
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-size: 12px;
  line-height: 1.45;
}
[data-lf-setting-control] {
  flex: none;
  display: flex;
  align-items: center;
}
/* Toggle switch, drawn from scratch on host tokens. */
[data-lf-switch] {
  position: relative;
  width: 38px;
  height: 21px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, .12));
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-subtle, rgba(15, 23, 42, .06));
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  transition: background-color .15s ease, border-color .15s ease;
}
[data-lf-switch][data-lf-switch="1"] {
  background: var(--dsw-alias-accent-primary, #2f6feb);
  border-color: transparent;
}
[data-lf-switch] [data-lf-knob] {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(15, 23, 42, .25);
  transition: transform .15s ease;
}
[data-lf-switch][data-lf-switch="1"] [data-lf-knob] {
  transform: translateX(17px);
}
[data-lf-number] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
[data-lf-number] input {
  width: 64px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, .12));
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
  text-align: right;
  outline: none;
}
[data-lf-number] input:focus {
  border-color: var(--dsw-alias-accent-primary, #2f6feb);
}
[data-lf-suffix] {
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-size: 12px;
}
/* The sidebar find panel (same namespace rule: namespaced selectors, no root
   scoping, so it stays styled while the fold is toggled off). */
[data-lf-find] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;
  overflow: hidden;
}
[data-lf-find-head] {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-lf-find-head] input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, .12));
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
  outline: none;
}
[data-lf-find-head] input:focus {
  border-color: var(--dsw-alias-accent-primary, #2f6feb);
}
[data-lf-find-count] {
  flex: none;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
[data-lf-find-list] {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
}
[data-lf-find-empty] {
  color: var(--dsw-alias-label-secondary, #68707d);
  font-size: 12.5px;
  line-height: 1.5;
  padding: 6px 2px;
}
[data-lf-find-row] {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: none;
  color: var(--dsw-alias-label-primary, #1f2328);
  text-align: left;
  cursor: pointer;
  font: inherit;
  appearance: none;
  -webkit-appearance: none;
}
[data-lf-find-row]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, .05));
}
[data-lf-find-row][data-lf-find-active="1"] {
  border-color: var(--dsw-alias-accent-primary, #2f6feb);
}
[data-lf-find-kind] {
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-size: 11px;
  line-height: 1.4;
}
[data-lf-find-snippet] {
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 12.5px;
  line-height: 1.5;
}
/* The transient ring around a reveal: hit jumps wear it for a moment. */
[data-lf-find-hit] {
  animation: lf-find-flash 1.2s ease 1;
}
@keyframes lf-find-flash {
  0% { box-shadow: 0 0 0 2px var(--dsw-alias-accent-primary, #2f6feb); }
  100% { box-shadow: 0 0 0 2px transparent; }
}
`

export function start(win, React) {
  const doc = win.document
  if (!doc || !doc.documentElement) return { dispose() {} }

  const F = win.__DSH_BUBBLE_FOLD_MODULES__?.fold
  if (!F) throw new Error('[dsh-fold-polish] fold module missing from bundle')
  /** Pure helpers + the store the client-entry snapshot probe writes into. */
  const TT = win.__DSH_BUBBLE_FOLD_MODULES__?.turnTimer ?? null
  const turnTimers = win.turnTimers ?? null
  /** Unsubscribe from the duration store, set once the probe has wired it. */
  let turnTimerOff = null
  if (turnTimers && typeof turnTimers.subscribe === 'function') {
    turnTimerOff = turnTimers.subscribe(() => schedule())
  }

  const computedStyleOf = win.getComputedStyle.bind(win)

  // ---------------------------------------------------------------- settings
  let settings = F.normalizeSettings(readStored())
  /** anchor element -> { body, tail, toggle, wrapper, kind, anchor } */
  const clamped = new Map()
  /** anchor element -> measurement signature, so settled rows are not re-measured */
  const measured = new Map()
  /** flow item element -> the seam control injected above the bubble that follows it */
  const stepFolds = new Map()
  /** the same key -> whether the plugin folded that block itself (host cannot) */
  const selfFolds = new Map()
  /**
   * Blocks already folded once for the reader. The host renders its own
   * disclosure open, so "steps start folded" means closing it exactly once per
   * block — after that the reader's own choice wins and nothing re-collapses.
   */
  const autoFolded = new Set()
  /**
   * Turns the reader merged into one seam. Folded state means every block of the
   * Turn is collapsed and only the Turn's last seam remains — above the final
   * answer a single arrow. Session-scoped UI state, like the fold state itself.
   */
  const mergedTurns = new Set()
  /**
   * Turns the reader explicitly un-merged. With "默认合为一道" on, the scan would
   * otherwise fold a Turn straight back into one seam right after the reader
   * asked to see every seam again — an explicit choice wins.
   */
  const unmergedByReader = new Set()
  /**
   * Counters exposed through `__DSH_BUBBLE_FOLD__.stats()`. They exist because
   * a self-feeding scan loop is invisible from the outside: you can only see it
   * as "the interface is slow".
   */
  const stats = {
    scans: 0,
    mutations: 0,
    selfMutations: 0,
    measured: 0,
    // 2026-10-13 排查「助手回复不折叠」的探针计数器，随 stats() 导出
    probe: { cloneOk: 0, cloneNull: 0, cloneNullWhy: {}, fallback: 0, naturalSamples: [] },
    side: { assistantSeen: 0, latestTurn: 0, limitsOff: 0, skipAncestor: 0, streaming: 0, noBody: 0, offscreen: 0, wrapped: 0, measured: 0, userSeen: 0, userLatest: 0, userSkip: 0, userNoBody: 0, userOffscreen: 0, userWrapped: 0, userMeasured: 0 },
    // 「向上滚被拉回最底下」修复的补偿计数（随 stats() 导出）
    scrollFix: { runs: 0, adjusted: 0, pinnedSkipped: 0, lastDelta: 0 }
  }
  /** card element -> the drag handle injected into it */
  const composerHandles = new Map()
  let dragState = null
  let composerHeight = readComposerHeight().value
  let composerManual = readComposerHeight().manual
  let styleTag = null
  let panelOpen = false
  let scheduled = false
  let disposed = false

  /** Subscribers notified after every settings change (floating panel, tab). */
  const settingsListeners = new Set()
  const notifySettings = () => {
    for (const fn of [...settingsListeners]) {
      try { fn() } catch { /* a broken listener must not break the fold */ }
    }
  }

  function readStored() {
    try {
      const raw = win.localStorage?.getItem(F.STORAGE_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  function persist() {
    try {
      win.localStorage?.setItem(F.STORAGE_KEY, JSON.stringify(settings))
    } catch {
      /* private mode: settings simply do not survive a reload */
    }
  }

  function readComposerHeight() {
    try {
      const raw = win.localStorage?.getItem(COMPOSER_STORAGE_KEY)
      if (raw === null || raw === undefined) return { value: COMPOSER_DEFAULT, manual: false }
      const value = Number.parseFloat(raw)
      if (!Number.isFinite(value)) return { value: COMPOSER_DEFAULT, manual: false }
      return {
        value: Math.max(COMPOSER_MIN, Math.min(COMPOSER_MAX, Math.round(value))),
        manual: true
      }
    } catch {
      return { value: COMPOSER_DEFAULT, manual: false }
    }
  }

  // ------------------------------------------------------------------ styles
  function ensureStyles() {
    // `getElementById` can legitimately come back empty (a page without this
    // node yet, or a document that was swapped). Track the node we created so a
    // failed lookup can never stack a second <style> on every scan.
    if (styleTag !== null && styleTag.isConnected) {
      if (styleTag.textContent !== CSS) styleTag.textContent = CSS
      return
    }
    styleTag = doc.getElementById(F.STYLE_ID)
    if (!styleTag) {
      styleTag = doc.createElement('style')
      styleTag.setAttribute('id', F.STYLE_ID)
      styleTag.setAttribute('data-plugin-css', F.STYLE_ID)
      doc.head.appendChild(styleTag)
    }
    if (styleTag.textContent !== CSS) styleTag.textContent = CSS
  }

  function applyRootFlag() {
    if (settings.enabled) doc.documentElement.setAttribute(F.ROOT_ATTRIBUTE, 'on')
    else doc.documentElement.removeAttribute(F.ROOT_ATTRIBUTE)
  }

  // ---------------------------------------------------------------- geometry
  function lineHeightOf(element) {
    const computed = computedStyleOf(element)
    const base = Number.parseFloat(computed.lineHeight)
    const delta = Number.parseFloat(computed.getPropertyValue('--dsh-content-font-delta')) || 0
    if (Number.isFinite(base) && base > 0) return base + delta
    const font = Number.parseFloat(computed.fontSize)
    return Number.isFinite(font) && font > 0 ? font * 1.5 : 22
  }

  function isStreaming(anchor) {
    return Boolean(anchor.querySelector('[data-streaming]'))
  }

  function skipReason(anchor, kind) {
    // 宿主更新后把消息行（user 与 assistant-step）都包进了过程容器
    // （[data-turn-process] / [data-step-process]），容器不再成为跳过任何
    // 消息行的理由——消息行自身的 flow-kind 已证明它是正文。只有「标记类」
    // （隐藏过程成员、答案桩、上下文注入、系统提示、错误行、附件等）仍跳过，
    // closest 从锚点自身开始匹配，锚点自身带标记同样命中。
    if (kind === KIND_USER || kind === KIND_ASSISTANT) return anchor.closest(SKIP_MARKERS)
    return anchor.closest(SKIP_ANCESTORS)
  }

  function messageBodyOf(anchor, kind) {
    if (kind === KIND_USER || kind === KIND_STEERING) {
      const stack = anchor.firstElementChild?.firstElementChild
      if (!stack) return null
      const candidates = stack.children
      // The bubble is the FIRST non-attachment child (attachments render before
      // it, a reference summary after it). Picking the first means the actual
      // text bubble is clamped, never the reference line that follows it.
      for (let i = 0; i < candidates.length; i += 1) {
        const node = candidates[i]
        if (!(node instanceof win.HTMLElement)) continue
        if (node.hasAttribute('data-message-attachments')) continue
        return node
      }
      return null
    }
    if (kind === KIND_ASSISTANT) {
      const root = anchor.querySelector('[data-streaming]') ?? anchor.querySelector('div')
      if (!root) return null
      const body = root.firstElementChild
      return body instanceof win.HTMLElement ? body : null
    }
    return null
  }

  // -------------------------------------------------------- work-step folding
  /**
   * ONE control per PROCESS BLOCK: the run of work-step rows that sits between
   * two message bubbles. The seam lives immediately ABOVE the bubble that
   * follows the block, so one click folds everything between the two bubbles.
   *
   * Two host layouts exist and both are handled here:
   *
   *   1. GROUPED (work-details compact / standard, and history for closed
   *      turns). The steps are nested inside a `[data-step-process]` container
   *      whose own header button is the disclosure, and each Turn may also
   *      render its `[data-turn-process]` summary row. The seam clicks those
   *      host controls — the host stays the single owner of the state.
   *   2. FLAT / INLINE (work-details verbose). No disclosure is offered: the
   *      host renders a disabled summary row and every step inline. There the
   *      seam folds the rows itself, display-only, exactly like a long message
   *      bubble: an attribute on the rows, removed the moment the plugin is
   *      disabled.
   */
  /** A step container, or any flow row (whose kind decides whether it is a step). */
  const STEP_UNIT = '[data-step-process],[data-chat-flow-kind]'
  /** Ancestors that mean "this is not part of the conversation's step flow". */
  const BLOCK_SKIP = [
    '[data-context-fields]',
    '[data-context-text]',
    '[data-context-injection-body]',
    '[data-system-prompt-body]',
    '[data-message-attachments]'
  ].join(',')

  /** True for a Turn summary row, a grouped step container, or a flat member row. */
  function isProcessUnit(element) {
    return element.hasAttribute('data-step-process')
      || element.hasAttribute('data-turn-process-member')
      || element.getAttribute('data-chat-flow-kind') === KIND_TURN_PROCESS
  }

  // Both the seam line and the bubble inside it count, so a block walk that
  // starts from either one still steps over our own node.
  const isOurControl = (element) => element.hasAttribute('data-lf-step-line')
    || element.hasAttribute('data-lf-step-toggle')

  /** The next unit inside the same block; our own seam is skipped, not a wall. */
  function blockUnitAfter(element) {
    let node = element.nextElementSibling
    while (node && isOurControl(node)) node = node.nextElementSibling
    return node && isProcessUnit(node) ? node : null
  }

  function blockUnitBefore(element) {
    let node = element.previousElementSibling
    while (node && isOurControl(node)) node = node.previousElementSibling
    return node && isProcessUnit(node) ? node : null
  }

  /** First sibling after the block that is not part of it — the following bubble. */
  function blockTailAfter(element) {
    let node = element.nextElementSibling
    while (node && isOurControl(node)) node = node.nextElementSibling
    return node
  }

  /**
   * The host disclosure for one unit, when the host actually offers one.
   * `null` means the host renders this unit inline and cannot fold it.
   */
  function hostControlOf(unit) {
    // A Turn's own summary row ("已完成，用时 …").
    if (unit.getAttribute('data-chat-flow-kind') === KIND_TURN_PROCESS) {
      const control = unit.querySelector('[data-turn-process]')
      if (!control || control !== unit.querySelector('[data-turn-process]')) return null
      // `aria-expanded` absent = the host renders the row without a disclosure;
      // `disabled` = it is foldable in principle but nothing to fold right now.
      if (control.disabled === true || control.getAttribute('aria-expanded') === null) return null
      return { control, kind: 'turn' }
    }
    // A grouped step container: its own header button is the disclosure. A
    // container rendered in expanded mode has a hidden header and no fold.
    if (unit.hasAttribute('data-step-process')) {
      if (unit.hasAttribute('data-group-expanded-mode')) return null
      const icon = unit.querySelector('[data-step-process-icon]')
      const button = icon?.closest('button') ?? unit.querySelector('button[aria-controls]')
      if (!button || button.getAttribute('aria-expanded') === null) return null
      return { control: button, kind: 'group' }
    }
    return null
  }

  const controlIsOpen = (descriptor) => (descriptor.kind === 'group'
    ? descriptor.control.getAttribute('aria-expanded') === 'true'
    : descriptor.control.hasAttribute('data-open'))

  /** Split a block into host-driven controls and rows the plugin may hide itself. */
  function decomposeBlock(items) {
    const controls = []
    const own = []
    for (const item of items) {
      const descriptor = hostControlOf(item)
      if (descriptor) controls.push(descriptor)
      else own.push(item)
    }
    return { controls, own }
  }

  /** The block around one of our seams, re-read from the live DOM at click time. */
  function blockAround(seam) {
    const items = []
    for (let node = blockUnitBefore(seam); node; node = blockUnitBefore(node)) items.unshift(node)
    for (let node = blockUnitAfter(seam); node; node = blockUnitAfter(node)) items.push(node)
    return items
  }

  /**
   * Display-only fold marks for blocks the host itself refuses to fold.
   *
   * The rows are hidden with the browser's "hidden until found" mechanism
   * (the hidden="until-found" attribute, plus the CSS fallback), not with
   * display:none, because that is what lets Ctrl+F reach them: the browser
   * matches the text, fires beforematch, and the seam opens the whole block.
   */
  function applyFoldMarks(items, folded) {
    for (const item of items) {
      if (folded) {
        setAttr(item, FOLD_MARK, '1')
        setAttr(item, 'hidden', 'until-found')
      } else {
        // Only take `hidden` off a row we hid: the host may own that attribute.
        if (item.hasAttribute(FOLD_MARK)) removeAttr(item, 'hidden')
        removeAttr(item, FOLD_MARK)
      }
    }
  }

  /**
   * Whether a block is folded right now. A block the host can fold follows the
   * host's own disclosure; one the host renders inline follows our own flag,
   * which starts folded (nothing hides until the reader asks it to).
   */
  function isBlockFolded(tail, controls) {
    if (controls.length > 0) return !controls.some(controlIsOpen)
    if (settings.foldAllSteps) return selfFolds.get(tail) !== false
    return selfFolds.get(tail) === true
  }

  /** How many step rows a block actually holds, nested ones included. */
  function stepCountOf(items) {
    let count = 0
    for (const item of items) {
      if (item.hasAttribute('data-turn-process-member')) count += 1
      else count += item.querySelectorAll('[data-turn-process-member]').length
    }
    return count
  }

  function syncStepFolds() {
    if (!settings.enabled || !settings.workStepButtons) {
      for (const [tail, record] of stepFolds) {
        record.line.remove()
        stepFolds.delete(tail)
      }
      for (const row of doc.querySelectorAll(`[${FOLD_MARK}]`)) {
        // Ours to take off: the mark says this row's hiding came from the plugin.
        row.removeAttribute('hidden')
        row.removeAttribute(FOLD_MARK)
      }
      selfFolds.clear()
      autoFolded.clear()
      mergedTurns.clear()
      return
    }
    const seen = new Set()
    const live = new Set()
    /** Turn id -> { count, openCount, record, records }: the Turn's own state. */
    const turns = new Map()
    for (const unit of doc.querySelectorAll(STEP_UNIT)) {
      if (seen.has(unit) || !isProcessUnit(unit)) continue
      // Only top-level units: rows nested inside a step container belong to it.
      const owner = unit.closest('[data-step-process]')
      if (owner && owner !== unit) continue
      const parent = unit.parentElement
      if (!parent || parent.closest(BLOCK_SKIP)) continue

      // Walk back to the block's first row, then collect the run forward. The
      // `seen` set keeps this linear: only a block's first row walks backwards.
      let first = unit
      for (let previous = blockUnitBefore(first); previous; previous = blockUnitBefore(first)) first = previous
      const items = []
      for (let node = first; node; node = blockUnitAfter(node)) {
        items.push(node)
        seen.add(node)
      }

      const last = items[items.length - 1]
      const tail = blockTailAfter(last)
      // No bubble below yet (a Turn still running): the seam belongs between the
      // steps and that bubble, so there is nothing to attach it to. It appears
      // the moment the reply lands.
      if (!tail || !tail.isConnected) continue

      const { controls, own } = decomposeBlock(items)
      if (controls.length === 0 && own.length === 0) continue
      const selfFold = controls.length === 0

      // Aggregate per Turn for the Turn-wide control. Every block counts, even the
      // ones whose seam is not built yet, so the control never claims a state that
      // only holds for the part of the Turn that happens to be on screen.
      const turnKey = turnKeyOfUnit(first)
      let info = null
      if (turnKey !== null) {
        info = turns.get(turnKey)
        if (!info) {
          info = { count: 0, openCount: 0, record: null, records: [] }
          turns.set(turnKey, info)
        }
        info.count += 1
      }

      // Seams are created lazily, like every other injected node: a long
      // conversation holds hundreds of blocks and each insertion re-triggers the
      // observer that scheduled this pass.
      if (!isNearViewport(tail) && !stepFolds.has(tail)) {
        if (info && !isBlockFolded(tail, controls)) info.openCount += 1
        continue
      }

      live.add(tail)
      let record = stepFolds.get(tail)
      if (record && (!record.line.isConnected || record.line.parentElement !== parent)) {
        record.line.remove()
        stepFolds.delete(tail)
        record = undefined
      }
      if (!record) {
        record = stepLine()
        stepFolds.set(tail, record)
      }
      const fold = record.button
      // The LAST block of a Turn in DOM order is the one that carries the
      // Turn-wide controls: it is the seam right before the Turn's final answer.
      if (info) {
        info.record = record
        info.records.push(record)
      }
      // Idempotent placement: the seam always sits immediately above the bubble,
      // so a host re-render that moved it is corrected without a second write.
      if (record.line.parentElement !== parent || record.line.nextElementSibling !== tail) {
        parent.insertBefore(record.line, tail)
      }

      // Steps start folded — the newest Turn's included. Who does the folding
      // depends on the layout: the host's own disclosure when there is one, our
      // own display-only mark when the host offers none.
      if (settings.foldAllSteps && !autoFolded.has(tail)) {
        autoFolded.add(tail)
        if (selfFold) selfFolds.set(tail, true)
        else for (const descriptor of controls) if (controlIsOpen(descriptor)) descriptor.control.click()
      }

      let folded = isBlockFolded(tail, controls)
      // A merged Turn keeps every block folded: its seams are gone, so an open
      // block would show steps the reader has no control to fold back. Re-fold
      // here covers host re-renders that reset a disclosure.
      if (turnKey !== null && mergedTurns.has(turnKey) && !folded) {
        if (selfFold) {
          selfFolds.set(tail, true)
          applyFoldMarks(items, true)
        } else {
          for (const descriptor of controls) {
            if (descriptor.control.disabled === true) continue
            if (!controlIsOpen(descriptor)) continue
            descriptor.control.click()
          }
        }
        autoFolded.add(tail)
        folded = true
      }
      if (info && !folded) info.openCount += 1
      const open = !folded
      // The host owns its own rows; only a block the host refuses to fold gets
      // our mark, and the write is idempotent so it cannot feed the scan loop.
      if (selfFold) applyFoldMarks(items, folded)

      // 展开本步骤 / 收起本步骤: this block's own steps, and nothing else.
      const label = open ? STEP_FOLD_LABEL : STEP_OPEN_LABEL
      const hidden = folded ? stepCountOf(items) : 0
      const title = hidden > 0 ? `${label} · ${hidden} 步` : label
      if (fold.getAttribute('aria-label') !== label) fold.setAttribute('aria-label', label)
      if (fold.getAttribute('title') !== title) fold.setAttribute('title', title)
      if (fold.getAttribute('aria-expanded') !== String(open)) {
        fold.setAttribute('aria-expanded', String(open))
      }
      setAttr(fold, 'data-lf-step-open', open ? '1' : '0')
      // The optional text exists only while the setting asks for it; the icon is
      // always in place, so the button never loses its meaning.
      writeLabel(fold, 'data-lf-step-label', settings.stepLabels ? label : '')
      if (record.line.hidden) record.line.hidden = false
    }
    for (const [tail, record] of [...stepFolds]) {
      if (live.has(tail) && tail.isConnected) continue
      record.line.remove()
      stepFolds.delete(tail)
    }
    for (const [tail] of [...selfFolds]) {
      if (tail.isConnected) continue
      selfFolds.delete(tail)
    }
    for (const tail of [...autoFolded]) {
      if (tail.isConnected) continue
      autoFolded.delete(tail)
    }

    // The Turn-wide controls live on their Turn's LAST seam and nowhere else, and
    // only when the Turn holds more than one block: with a single block there is
    // no "all" to collapse, so the seam keeps exactly the one button it had.
    const carriers = new Set()
    for (const [turnKey, info] of turns) {
      // "默认只留一个按钮": every multi-block Turn starts in 状态0 unless the reader
      // has already asked this one to stay spread out.
      if (info.count >= 2 && settings.mergeByDefault && !unmergedByReader.has(turnKey)) {
        mergedTurns.add(turnKey)
      }
      const record = info.record
      if (!record) continue
      carriers.add(record)
      const { all, every, button } = record
      const merged = mergedTurns.has(turnKey)
      const allOpen = info.count > 0 && info.openCount === info.count
      // A one-block Turn has nothing to spread: its single primary control IS that
      // block's own toggle, so its label follows the block, not the seam layout.
      const single = info.count < 2

      // 状态0: the Turn shows exactly ONE button — 展开全部. Every other control of
      // that Turn (its own seam arrow included) is hidden until it is clicked.
      const primaryLabel = single
        ? (info.openCount > 0 ? ALL_FOLD_LABEL : ALL_OPEN_LABEL)
        : (merged ? ALL_OPEN_LABEL : ALL_FOLD_LABEL)
      const primaryTitle = single
        ? (info.openCount > 0 ? '收起这一段步骤' : '展开这一段步骤')
        : (merged
            ? `展开全部：把本轮的 ${info.count} 段折叠缝全部摊开`
            : '收起全部：本轮各段内容收起，只留一个按钮')
      if (all.getAttribute('aria-label') !== primaryLabel) all.setAttribute('aria-label', primaryLabel)
      if (all.getAttribute('title') !== primaryTitle) all.setAttribute('title', primaryTitle)
      const primaryOpen = single ? (info.openCount > 0 ? '1' : '0') : (merged ? '0' : '1')
      if (all.getAttribute('data-lf-all-open') !== primaryOpen) all.setAttribute('data-lf-all-open', primaryOpen)
      writeLabel(all, 'data-lf-all-label', primaryLabel)
      setAttr(record.line, 'data-lf-turn', String(turnKey))
      if (all.hidden) all.hidden = false
      const arrowHidden = merged || single
      if (button.hidden !== arrowHidden) button.hidden = arrowHidden

      // 展开所有步骤 / 收起所有步骤: the CONTENT of every block, seams untouched. It
      // only exists while the Turn is spread out, and only with more than one block
      // (with a single block "all steps" is that block's own button).
      const everyVisible = !merged && info.count >= 2
      if (every.hidden !== !everyVisible) every.hidden = !everyVisible
      if (everyVisible) {
        const everyLabel = allOpen ? EVERY_FOLD_LABEL : EVERY_OPEN_LABEL
        const everyTitle = allOpen ? '收起本轮所有步骤的内容' : '展开本轮所有步骤的内容'
        if (every.getAttribute('aria-label') !== everyLabel) every.setAttribute('aria-label', everyLabel)
        if (every.getAttribute('title') !== everyTitle) every.setAttribute('title', everyTitle)
        const everyOpen = allOpen ? '1' : '0'
        if (every.getAttribute('data-lf-every-open') !== everyOpen) every.setAttribute('data-lf-every-open', everyOpen)
        writeLabel(every, 'data-lf-every-label', everyLabel)
      }
    }
    for (const [, record] of stepFolds) {
      if (carriers.has(record)) continue
      if (!record.all.hidden) record.all.hidden = true
      if (!record.every.hidden) record.every.hidden = true
    }
    // One setting decides whether ANY of the three controls shows its text — the
    // three glyphs stay distinguishable without it.
    for (const [, record] of stepFolds) {
      for (const button of [record.button, record.all, record.every]) {
        if (settings.stepLabels) {
          if (button.getAttribute('data-lf-text') !== '1') setAttr(button, 'data-lf-text', '1')
        } else if (button.hasAttribute('data-lf-text')) {
          button.removeAttribute('data-lf-text')
        }
      }
    }
    // A merged Turn shows exactly one seam: its last. Every other seam of that
    // Turn hides — the reader reaches the way back through the one arrow left.
    for (const [turnKey, info] of turns) {
      if (!mergedTurns.has(turnKey)) continue
      for (const record of info.records) {
        const keep = info.record === record
        if (keep) {
          if (record.line.hidden) record.line.hidden = false
        } else if (!record.line.hidden) {
          record.line.hidden = true
        }
      }
    }
    // A Turn that is gone takes its merged state with it; a Turn whose blocks
    // are merely off screen keeps it (its seams were never built to hide).
    for (const turnKey of [...mergedTurns]) {
      if (!turns.has(turnKey)) mergedTurns.delete(turnKey)
    }
    for (const turnKey of [...unmergedByReader]) {
      if (!turns.has(turnKey)) unmergedByReader.delete(turnKey)
    }
  }

  /**
   * The per-turn duration chip: one muted line at each Turn container's END,
   * labelled from the store the client-entry probe fills from the chat
   * snapshot's timing data (first step's start → last step's completion).
   * A Turn the store has no duration for — or the setting off — gets no chip;
   * host re-renders that drop a chip are corrected on the next pass.
   */
  function syncTurnTimers() {
    const durations = turnTimers?.get?.() ?? {}
    // diag 必须写**真 window**：client-entry 的 turnTimer() 句柄读的是
    // view.__DSH_BUBBLE_FOLD_TURN_TIMER_DOM__（真 window），而本函数的 win 是
    // client-entry 传进来的环境对象——写在它上面控制台永远读不到（恒 null）。
    const realWin = doc.defaultView ?? win
    const diag = realWin.__DSH_BUBBLE_FOLD_TURN_TIMER_DOM__ ?? (realWin.__DSH_BUBBLE_FOLD_TURN_TIMER_DOM__ = {})
    diag.containers = 0
    diag.turns = 0
    diag.chips = 0
    diag.durations = durations
    diag.setting = settings.turnTimer
    // 宿主把 data-chat-turn 挂在**每条消息容器**上（与 data-chat-flow-kind
    // 同一批属性，见 dsh-client-ui-chat），所以一轮有几十个带同一 turn 号
    // 的元素——不挑末尾就会每轮重复几十次小字。按 turn 分组、只取每轮在
    // DOM 里的最后一个容器（后出现的覆盖先出现的）。
    const lastOfTurn = new Map()
    for (const container of doc.querySelectorAll('[data-chat-turn]')) {
      diag.containers += 1
      const key = turnIdOf(container)
      if (key !== null) lastOfTurn.set(key, container)
    }
    diag.turns = lastOfTurn.size
    // 末尾容器会随流式追加而移动，旧位置的小字先统一撤掉再重建。
    for (const chip of doc.querySelectorAll('[data-lf-turn-timer]')) chip.remove()
    for (const [key, container] of lastOfTurn) {
      const ms = durations[key]
      if (!settings.turnTimer || typeof ms !== 'number' || !Number.isFinite(ms)) continue
      const chip = doc.createElement('div')
      chip.setAttribute('data-lf-turn-timer', '1')
      chip.textContent = `本轮用时 ${TT ? TT.formatDuration(ms) : ''}`
      container.appendChild(chip)
      diag.chips += 1
    }
  }

  // ------------------------------------------------------------------ clamping
  /** A downward chevron: one step block ("展开本步骤"). */
  const CHEVRON_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  /** A stacked double chevron: "not one block — this Turn's seams" (展开全部). */
  const DOUBLE_CHEVRON_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4.5l4 3.5 4-3.5M4 9l4 3.5 4-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  /** A chevron over two bars: "every block's content" (展开所有步骤). */
  const EVERY_STEP_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 3.5l3.5 3 3.5-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 9.5h9M3.5 12.5h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'

  /** An <img> at least this tall is a picture, not an inline emoji glyph. */
  const MEDIA_MIN_PX = 40

  const STEP_ICON = CHEVRON_ICON
  const ALL_ICON = DOUBLE_CHEVRON_ICON  /** One block's steps. */
  const STEP_OPEN_LABEL = '展开本步骤'
  const STEP_FOLD_LABEL = '收起本步骤'
  /** The Turn's seams: 状态0 ⇄ 状态1/2. */
  const ALL_OPEN_LABEL = '展开全部'
  const ALL_FOLD_LABEL = '收起全部'
  /** Every block's content in the Turn. */
  const EVERY_OPEN_LABEL = '展开所有步骤'
  const EVERY_FOLD_LABEL = '收起所有步骤'

  /**
   * The message's own prose, folded or not. `max-height` is CSS only, so the
   * whole text is still in the DOM — but the host also renders chrome inside the
   * body (code-block copy buttons, aria-hidden decorations), and the clipboard
   * should receive the message, not the interface.
   *
   * Walks child nodes when the platform exposes them, and falls back to the
   * element's own `textContent` for leaf nodes and for harnesses that model text
   * as a string property instead of text nodes.
   */
  function textOfBody(body) {
    const skip = 'button,svg,[aria-hidden="true"]'
    let text = ''
    const walk = (node) => {
      const children = node.childNodes
      if (children && children.length > 0) {
        for (const child of children) {
          if (child.nodeType === 3) {
            text += child.nodeValue ?? ''
            continue
          }
          if (child.nodeType !== 1) continue
          if (typeof child.closest === 'function' && child.closest(skip)) continue
          walk(child)
        }
        return
      }
      if (typeof node.textContent === 'string') text += node.textContent
    }
    walk(body)
    return text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  /** A bubble-styled capsule button: chevron icon + label text. */
  function controlButton(label, attribute, value = '1') {
    const button = doc.createElement('button')
    button.type = 'button'
    button.setAttribute(attribute, value)
    const icon = doc.createElement('span')
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML = CHEVRON_ICON
    const text = doc.createElement('span')
    text.setAttribute('data-lf-label', '1')
    text.textContent = label
    button.append(icon, text)
    return button
  }

  /**
   * The seam for one process block: a line carrying the block's own control, plus
   * the two Turn-wide slots that only a Turn's LAST seam shows.
   *
   * Three functions, three distinct glyphs — they stay recognisable with the text
   * off (the setting decides whether text is shown at all):
   *   本步骤   single chevron        this block's steps
   *   全部     double chevron        the Turn's seams: 展开全部 / 收起全部
   *   所有步骤 chevron over bars     every block's content: 展开/收起所有步骤
   */
  function stepLine() {
    const line = doc.createElement('div')
    line.setAttribute('data-lf-step-line', '1')

    const build = (attribute, icon, labelAttribute) => {
      const button = doc.createElement('button')
      button.type = 'button'
      button.setAttribute(attribute, '1')
      const iconSpan = doc.createElement('span')
      iconSpan.setAttribute('data-lf-icon', '1')
      iconSpan.setAttribute('aria-hidden', 'true')
      iconSpan.innerHTML = icon
      const labelSpan = doc.createElement('span')
      labelSpan.setAttribute(labelAttribute, '1')
      button.append(iconSpan, labelSpan)
      return { button, labelSpan }
    }

    const step = build('data-lf-step-toggle', STEP_ICON, 'data-lf-step-label')
    const all = build('data-lf-step-all', ALL_ICON, 'data-lf-all-label')
    all.button.hidden = true
    const every = build('data-lf-step-every', EVERY_STEP_ICON, 'data-lf-every-label')
    every.button.hidden = true

    line.append(step.button, all.button, every.button)
    return { line, button: step.button, all: all.button, every: every.button }
  }

  /** Set ONLY the label span, leaving the chevron icon in place. */
  function setLabel(button, label) {
    const text = button.querySelector('[data-lf-label]')
    if (text && text.textContent !== label) text.textContent = label
  }

  /** Write one seam control's own label span (its icon is untouched). */
  function writeLabel(button, attribute, label) {
    const span = button.querySelector(`[${attribute}]`)
    if (span && span.textContent !== label) span.textContent = label
  }

  function wrap(anchor, kind, body) {
    const wrapper = doc.createElement('div')
    wrapper.setAttribute('data-lf-body', kind)
    body.parentNode?.insertBefore(wrapper, body)
    wrapper.appendChild(body)
    // Deliberately NOT setting data-lf-clamped here: measureAndClamp decides,
    // and it writes only on change.

    const tail = doc.createElement('div')
    tail.setAttribute('data-lf-tail', kind)
    tail.hidden = true
    // Exactly ONE control per message: its own 展开 / 收起. Bulk actions were
    // removed — they were confusing, they had nothing to act on beyond these
    // same toggles, and their hover styling fought the per-scan writes.
    const toggle = controlButton('', 'data-lf-toggle')
    toggle.setAttribute('aria-expanded', 'false')
    tail.appendChild(toggle)
    anchor.appendChild(tail)

    const record = { body, tail, toggle, wrapper, kind, anchor }
    // Deliberately NO scroll-driven expansion here: the clamp box is clipped, not
    // scrollable, so a wheel passing over a folded message must leave it alone.
    // The find panel expands what it reveals through revealAt instead.
    clamped.set(anchor, record)
    return record
  }

  function unwrap(anchor) {
    const record = clamped.get(anchor)
    if (!record) return
    clipped(record)
    record.tail.remove()
    const body = record.body
    body.removeAttribute('data-lf-clamped')
    body.removeAttribute('data-lf-open')
    record.wrapper.style.removeProperty('--lf-clamp-height')
    if (record.wrapper.parentNode) {
      record.wrapper.parentNode.insertBefore(body, record.wrapper)
      record.wrapper.remove()
    }
    clamped.delete(anchor)
    measured.delete(anchor)
  }

  function clipAll() {
    for (const anchor of [...clamped.keys()]) unwrap(anchor)
    // Safety net: the clamp value lives in the wrapper's inline variables, so an
    // orphaned attribute (a body React moved out from under it) must not be left
    // able to bound anything.
    for (const stale of doc.querySelectorAll('[data-lf-clamped]')) stale.removeAttribute('data-lf-clamped')
    for (const row of doc.querySelectorAll('[data-lf-tail]')) row.remove()
    for (const fold of doc.querySelectorAll('[data-lf-step-line]')) fold.remove()
    for (const row of doc.querySelectorAll(`[${FOLD_MARK}]`)) {
      row.removeAttribute('hidden')
      row.removeAttribute(FOLD_MARK)
    }
    stepFolds.clear()
    selfFolds.clear()
    mergedTurns.clear()
  }

  function isOpen(body) {
    return body.getAttribute('data-lf-open') === '1'
  }

  /**
   * Set an attribute ONLY when the value actually changes.
   *
   * This is load-bearing, not a micro-optimisation: the plugin's own
   * MutationObserver watches these attributes, so an unconditional
   * `setAttribute` with an unchanged value still queues a mutation record and
   * schedules another scan — which writes again. That self-feeding loop runs at
   * requestAnimationFrame rate forever and is what makes a long conversation
   * (1000+ flow items) unusable.
   */
  function setAttr(element, name, value) {
    if (element.getAttribute(name) === value) return false
    element.setAttribute(name, value)
    return true
  }

  function removeAttr(element, name) {
    if (!element.hasAttribute(name)) return false
    element.removeAttribute(name)
    return true
  }

  function setOpen(anchor, record, open) {
    const { body, toggle } = record
    setAttr(body, 'data-lf-open', open ? '1' : '0')
    setAttr(toggle, 'aria-expanded', open ? 'true' : 'false')
    setLabel(toggle, open ? '收起' : labelFor(record))
  }

  function labelFor(record) {
    const { body, kind } = record
    // 自然高度必须从克隆量：body 正被 max-height 夹着，它的 scrollHeight 是裁剪值，
    // 直接拿来当「内容总高」会把「还有 N 行」算得严重偏低。预算行数与测量同源。
    const limits = F.settingsForSide(settings, kind)
    const budgetLines = settings.collapseAll ? settings.collapsedLines : limits.lines
    const probe = probeNatural(body, budgetLines)
    const contentPx = probe ? probe.natural : body.scrollHeight
    const visiblePx = body.getBoundingClientRect().height
    const lineHeight = probe ? probe.lineHeight : lineHeightOf(body)
    const hidden = F.hiddenLineLabel(contentPx, visiblePx, lineHeight)
    const name = kind === F.SIDE_USER ? '展开我的输入' : '展开全文'
    return hidden ? `${name} · ${hidden}` : name
  }

  function refreshLabel(record) {
    if (!isOpen(record.body)) setLabel(record.toggle, labelFor(record))
  }

  /**
   * The max-height to clamp to: the bottom of the last line the budget can hold
   * in full. A box of exactly `lines × lineHeight` slices the following line
   * through the middle — which is what the old fade used to hide — so the fold
   * lands on a line boundary instead. Ranges give the real line boxes (a body can
   * be one text node with no element children at all); the element walk is the
   * fallback for environments without Range. Padding and box-sizing are part of
   * the conversion, because line boxes are measured from the border box while the
   * budget counts content.
   */

  /**
   * 屏幕外测量容器：克隆节点在这里量几何，真实节点全程带着 max-height 不动。
   *
   * 为什么必须这么做：`max-height` 会同时影响 `scrollHeight` 与
   * `getBoundingClientRect()` / `Range.getClientRects()`——被夹住的盒子量出来的
   * 是裁剪后的值。老代码为了拿到真实高度，先在真实节点上
   * `removeAttr('data-lf-clamped')` 量一次、再夹回去；而扫描是每秒跑的，于是
   * 「展开→夹回」每秒发生一次，对话总高度跟着抖，读者停在历史位置时会被挤到
   * 底部（症状：往上翻被强制拉回最新一条）。
   *
   * 克隆到屏幕外容器量，真实节点一秒都不被解除限制，布局零扰动。
   * 容器复用同一个实例，避免每次扫描都创建/销毁 DOM。
   */
  let measureHost = null

  function measureHostOf() {
    if (measureHost && measureHost.isConnected) return measureHost
    // 必须挂在 document 上：脱离文档的节点量不到几何。
    const host = doc.createElement('div')
    host.setAttribute('data-lf-measure-host', '')
    // 定位到屏幕外：不影响任何可见布局，也滚不到那儿。
    host.style.position = 'fixed'
    host.style.left = '-99999px'
    host.style.top = '0'
    // 容器必须给足宽度：宽 0 会让克隆里的文本无限换行，量出来的高度完全失真。
    // 取视口宽度的上限即可——克隆自身还会被显式设成真实节点的宽度。
    host.style.width = '100vw'
    host.style.height = 'auto'
    host.style.overflow = 'visible'
    host.style.visibility = 'hidden'
    host.style.pointerEvents = 'none'
    host.style.zIndex = '-1'
    // 不能加 contain —— size containment 会把克隆当成空元素（尺寸算 0），
    // 量出来全是 0，overflows 恒为 false，折叠整体失效。
    ;(doc.body ?? doc.documentElement).appendChild(host)
    measureHost = host
    return host
  }

  /**
   * 量一个 body 的自然（未裁剪）高度与内容结束位置，不扰动真实节点。
   * @param body - 真实节点（可能正被 max-height 夹着）
   * @param budgetLines - 这一侧的保留行数预算。下刀位置只允许落在预算之内的
   *   最后一行底部——这与 cutHeightForBody 是同一判据。2026-10-13 修：此前
   *   这里的 pick 取「所有行的最底部」（= 内容总高度），于是
   *   `overflows = natural > cutHeight + 8` 恒为假，凡走克隆测量的消息都
   *   丢按钮、不折叠（胶囊「展开全文 · 还有 N 行」消失的根因）。
   *   缺省时下刀位置为 0，由调用方用 contentBudget 兜底。
   * @returns { natural, cutHeight, lineHeight, padTop, padBottom, boxSizing } 或 null
   */
  function probeNatural(body, budgetLines) {
    if (typeof body.cloneNode !== 'function') return null
    const host = measureHostOf()
    let clone
    try {
      // deep clone：内容、样式类、内联样式都带过去；脚本不执行（cloneNode 不跑 JS）
      clone = body.cloneNode(true)
    } catch {
      stats.probe.cloneNull += 1
      stats.probe.cloneNullWhy.cloneThrow = (stats.probe.cloneNullWhy.cloneThrow || 0) + 1
      return null
    }
    // 克隆必须解除一切钳制，否则量到的还是裁剪值。
    // cloneNode 会把 class 一起带过来，而 max-height 写在 CSS class 规则里
    // （:root[data-dsh-bubble-fold] [data-lf-clamped="1"]）而不是内联样式 ——
    // removeProperty 清不掉 class 规则，克隆会一直带着 88px 的 max-height，
    // 量出来的仍是裁剪值（诊断实测 offsetHeight 恒 96、scrollHeight 646 vs 真值 654）。
    // 所以必须把钳制 class 摘掉，内联兜底同时保留。
    clone.removeAttribute('data-lf-clamped')
    clone.removeAttribute('data-lf-open')
    try {
      for (const cls of [...clone.classList]) {
        if (cls.startsWith('lf-')) clone.classList.remove(cls)
      }
    } catch { /* classList 不可用时靠下面的内联兜底 */ }
    // 解除一切可能限制高度的内联样式，否则量到的仍是裁剪值
    clone.style.removeProperty('max-height')
    clone.style.removeProperty('min-height')
    clone.style.removeProperty('height')
    clone.style.removeProperty('padding-bottom')
    clone.style.removeProperty('overflow')
    clone.style.removeProperty('contain')
    clone.style.removeProperty('--lf-clamp-height')
    // 宽度必须与真实节点一致，否则换行位置不同、高度就没有意义。
    // 必须用 computedStyle.width——getBoundingClientRect().width 是边框盒宽度，
    // 而克隆用 content-box，直接拿边框盒宽度会少减 padding+border，
    // 克隆更宽、换行更少、量出的高度偏小（实测差 30px/4.6%）。
    const realStyle = computedStyleOf(body)
    const realBox = body.getBoundingClientRect()
    const styleWidth = Number.parseFloat(realStyle.width)
    const width = Number.isFinite(styleWidth) && styleWidth > 0
      ? styleWidth
      : (realBox.width > 0 ? realBox.width : Number.parseFloat(realStyle.width) || 0)
    clone.style.width = width > 0 ? `${width}px` : (realStyle.width || 'auto')
    clone.style.boxSizing = realStyle.boxSizing || 'content-box'
    // padding 一并搬过去：content-box 下 padding 不计入 width，但会影响换行
    clone.style.paddingLeft = realStyle.paddingLeft
    clone.style.paddingRight = realStyle.paddingRight
    clone.style.paddingTop = realStyle.paddingTop
    clone.style.margin = '0'
    clone.style.position = 'static'
    clone.style.visibility = 'hidden'
    host.appendChild(clone)

    let result = null
    try {
      const style = computedStyleOf(clone)
      const padTop = Number.parseFloat(style.paddingTop) || 0
      const padBottom = Number.parseFloat(style.paddingBottom) || 0
      const lineHeight = lineHeightOf(clone)
      const mediaHeight = mediaHeightIn(clone)
      // 下刀位置的预算：本侧保留行数 × 行高 + 附件总高，与调用方算的
      // contentBudget 同源，必须在克隆上先量出来（保留行数由调用方传入）。
      const budget = F.clampHeightFor(budgetLines, lineHeight) + mediaHeight
      const box = clone.getBoundingClientRect()
      // 克隆必须真的被布局过：宽度为 0 说明当前 DOM 实现不产出几何
      // （jsdom / 测试替身），此时克隆上的任何数值都不可信，交给调用方回退。
      if (!(box.width > 0) || !(box.height > 0)) {
        stats.probe.cloneNull += 1
        stats.probe.cloneNullWhy.boxZero = (stats.probe.cloneNullWhy.boxZero || 0) + 1
        stats.probe.cloneNullWhy.lastBox = [Math.round(box.width), Math.round(box.height)]
        return null
      }
      const origin = box.top + (clone.clientTop || 0) + padTop

      // 内容结束位置：优先 Range（按行/按文本片段，能在行边界处下刀），
      // 退回按子元素底边——与 cutHeightForBody 同一套判据：只接受预算之内
      // 的行底部并取其中最大者；一行都放不下时返回 0，由调用方兜底。
      const pick = (ends) => {
        let cut = 0
        for (const end of ends) {
          if (end <= 0) continue
          if (end > budget) continue
          if (cut === 0 || end > cut) cut = end
        }
        return cut
      }
      let cut = 0
      if (typeof doc.createRange === 'function') {
        try {
          const range = doc.createRange()
          range.selectNodeContents(clone)
          const rects = range.getClientRects()
          const ends = []
          for (let index = 0; index < rects.length; index += 1) ends.push(rects[index].bottom - origin)
          cut = pick(ends)
        } catch {
          cut = 0
        }
      }
      if (cut === 0) cut = pick(elementEnds(clone, origin, 0))

      // 自然高度：克隆没有被 max-height 夹，scrollHeight 就是真实内容高度。
      // 不要再补 padding-bottom —— scrollHeight 的定义已含它（实测：清掉内联
      // padding-bottom 后克隆的 computedStyle 仍是 8px、scrollHeight 654/38 与真值
      // 完全一致）。补了就是重复计算，短文本会从 38 变 46。
      const natural = clone.scrollHeight
      // 量不到自然高度同样不可信，回退
      if (!(natural > 0)) {
        stats.probe.cloneNull += 1
        stats.probe.cloneNullWhy.naturalZero = (stats.probe.cloneNullWhy.naturalZero || 0) + 1
        return null
      }
      stats.probe.cloneOk += 1
      if (stats.probe.naturalSamples.length < 6) stats.probe.naturalSamples.push(Math.round(natural))
      result = {
        natural: natural > 0 ? natural : Math.round(box.height),
        cutHeight: cut > 0 ? Math.round(style.boxSizing === 'border-box' ? cut + padTop + padBottom : cut) : 0,
        lineHeight,
        padTop,
        padBottom,
        boxSizing: style.boxSizing,
        // 附件总高：克隆里的 img 等同样有几何，量法与 attachmentHeightIn 一致
        mediaHeight
      }
    } finally {
      // 无论成败都必须移除克隆：留在 DOM 里会一直占着测量容器
      if (clone.parentNode) clone.parentNode.removeChild(clone)
    }
    return result
  }

  /**
   * 克隆测量的降级路径：直接量真实节点，因此必须临时解除钳制再夹回。
   *
   * 只在克隆量不到几何时才会被调用——真实浏览器里 probeNatural 一定成功，
   * 所以这条路不会把每秒抖动带回来。它的存在是为了让「不做布局的 DOM 实现」
   * （jsdom、测试替身）依然能夹断、依然能算出「还有 N 行」。
   */
  function probeNaturalFallback(body, limits, lines) {
    if (typeof body.getBoundingClientRect !== 'function') return null
    const lineHeight = lineHeightOf(body)
    const contentBudget = F.clampHeightFor(lines, lineHeight) + mediaHeightIn(body)
    // 已经解除钳制的节点不需要「先解除再还原」：直接量，零写入。
    // 只有正被夹住的节点才必须临时解除——这时写入是必要的，量完立刻还原，
    // 并且只在值真的不同时才写（setAttr/removeAttr 自带同值短路）。
    const wasClamped = body.getAttribute('data-lf-clamped') === '1'
    const wasOpen = body.getAttribute('data-lf-open')
    if (wasClamped) removeAttr(body, 'data-lf-clamped')
    if (wasOpen !== null) removeAttr(body, 'data-lf-open')
    let result = null
    try {
      const natural = body.scrollHeight
      if (natural > 0) {
        const cut = cutHeightForBody(body, contentBudget)
        const style = computedStyleOf(body)
        result = {
          natural,
          cutHeight: cut > 0 ? cut : contentBudget,
          lineHeight,
          mediaHeight: mediaHeightIn(body),
          // 与 probeNatural 返回同一字段集：overflows 的判定必须同量纲
          padTop: Number.parseFloat(style.paddingTop) || 0,
          padBottom: Number.parseFloat(style.paddingBottom) || 0,
          boxSizing: style.boxSizing,
          fallback: true
        }
      }
    } finally {
      // 还原：只在值与当前不同时才写，避免同值写入喂给 MutationObserver
      if (wasClamped && body.getAttribute('data-lf-clamped') !== '1') setAttr(body, 'data-lf-clamped', '1')
      if (wasOpen !== null && body.getAttribute('data-lf-open') !== wasOpen) setAttr(body, 'data-lf-open', wasOpen)
    }
    return result
  }

  /**
   * 在（已解除钳制的）真实节点上算下刀高度：按行边界优先，退回子元素底边。
   * 与 probeNatural 内的判据一致，只是跑在真实节点上。
   */
  function cutHeightForBody(body, budget) {
    const box = body.getBoundingClientRect()
    const style = computedStyleOf(body)
    const padTop = Number.parseFloat(style.paddingTop) || 0
    const padBottom = Number.parseFloat(style.paddingBottom) || 0
    const origin = box.top + (body.clientTop || 0) + padTop

    const pick = (ends) => {
      let cut = 0
      for (const end of ends) {
        if (end <= budget && end > cut) cut = end
      }
      return cut
    }

    let cut = 0
    if (typeof doc.createRange === 'function') {
      try {
        const range = doc.createRange()
        range.selectNodeContents(body)
        const rects = range.getClientRects()
        const ends = []
        for (let index = 0; index < rects.length; index += 1) ends.push(rects[index].bottom - origin)
        cut = pick(ends)
      } catch {
        cut = 0
      }
    }
    if (cut === 0) cut = pick(elementEnds(body, origin, 0))
    if (cut === 0) return 0
    return Math.round(style.boxSizing === 'border-box' ? cut + padTop + padBottom : cut)
  }

  /** 屏幕外容器随插件一起销毁。 */
  function disposeMeasureHost() {
    if (measureHost && measureHost.parentNode) measureHost.parentNode.removeChild(measureHost)
    measureHost = null
  }

  /** Box ends of nested element children, for the no-Range fallback. */
  function elementEnds(node, origin, depth) {
    const ends = []
    const children = node.children
    if (!children || children.length === 0 || depth > 3) return ends
    for (const child of children) {
      const end = child.getBoundingClientRect().bottom - origin
      if (end <= 0) continue
      ends.push(end)
      ends.push(...elementEnds(child, origin, depth + 1))
    }
    return ends
  }

  /**
   * Rendered height of the media sitting INSIDE a message body, so the line budget
   * can be spent on text only: a picture is never cut in half, and a long message
   * with a picture still folds.
   *
   * Only the host's own attachment markers and real media count — an `<img>` is
   * skipped unless it is tall enough to be a picture, because chat clients often
   * render emoji as inline images.
   */
  /**
   * 节点内附件的渲染高度总和。对真实节点和屏幕外克隆都适用——判据只看几何，
   * 所以克隆里的 img 量出来的一样有效。
   */
  function mediaHeightIn(node) {
    if (typeof node.querySelectorAll !== 'function') return 0
    let total = 0
    for (const item of node.querySelectorAll('[data-message-attachments], [data-attachment], img, video, audio, picture, figure')) {
      const rect = item.getBoundingClientRect?.()
      if (!rect || !(rect.height > 0)) continue
      const marked = item.hasAttribute('data-message-attachments') || item.hasAttribute('data-attachment')
      if (!marked && rect.height < MEDIA_MIN_PX) continue
      total += rect.height
    }
    return Math.round(total)
  }

  /** 真实 body 的附件高度（兼容旧调用点）。 */
  function attachmentHeightIn(body) {
    return mediaHeightIn(body)
  }

  /**
   * 纯内容指纹：不碰布局、不写 DOM。
   * 行数预算与 extraPx 来自设置，结构与文本量来自 DOM 只读属性，
   * 四者任一变化才可能让几何变化——所以它足以替代旧的 scrollHeight 指纹，
   * 且不需要为算指纹而测量。
   */
  function contentSignature(body, lines, extraPx, tailHidden) {
    let nodes = 0
    let chars = 0
    try {
      const walk = (node) => {
        for (const child of node.children ?? []) {
          nodes += 1
          walk(child)
        }
      }
      walk(body)
      chars = (body.textContent ?? '').length
    } catch {
      // 读不到就退化成只有设置的指纹：最坏情况是每轮都重测，不会错。
      nodes = -1
      chars = -1
    }
    return `${nodes}|${chars}|${lines}|${extraPx}|${tailHidden}`
  }

  function measureAndClamp(anchor, side, record, probed) {
    const { body } = record
    const limits = F.settingsForSide(settings, side)
    const lines = settings.collapseAll ? settings.collapsedLines : limits.lines

    // 全部几何都在屏幕外克隆上量：真实节点全程带着 max-height 不动，
    // 因此扫描再也不产生「解除→夹回」的布局抖动。下刀位置必须带上本侧的
    // 行数预算，否则量出的下刀位置等于内容总高，overflows 恒假（按钮消失）。
    let probe = probed ?? probeNatural(body, lines)
    if (probe === null) {
      // 克隆量不到几何（当前 DOM 实现不产出布局，例如测试替身）：
      // 回退到直接在真实节点上量。这条路径在真实浏览器里不会走到，
      // 所以不会把抖动带回来；但不做布局的环境必须还能夹断。
      probe = probeNaturalFallback(body, limits, lines)
      stats.probe.fallback += 1
    }
    if (probe === null) return
    const lineHeight = probe.lineHeight
    // An attachment inside the body keeps its FULL height — the line budget is for
    // text, and a picture must never be cut in half. Whatever the attachment
    // occupies is added on top of the budget, so image + 很长的正文 still folds:
    // the picture stays whole and only the text is clipped. The host usually
    // renders attachments in their own row OUTSIDE the bubble, in which case this
    // is zero and nothing changes.
    const contentBudget = F.clampHeightFor(lines, lineHeight) + probe.mediaHeight
    const gap = F.gapFor(settings.extraPx)

    const natural = probe.natural
    const cutHeight = probe.cutHeight > 0 ? probe.cutHeight : contentBudget
    // 比较必须同量纲：natural 是 scrollHeight（含上下 padding），cutHeight 是按
    // box-sizing 换算过的 max-height 值（content-box 下只到内容框）。把 padding
    // 补回去再比，否则「一行短消息、根本没超预算」也会被判成溢出，多出一个
    // 按钮并白裁掉 8px —— README 承诺的「短消息不折」就是这样失守的。
    const cutBoxHeight = cutHeight + (probe.boxSizing === 'border-box'
      ? 0
      : (probe.padTop || 0) + (probe.padBottom || 0))
    const overflows = natural > cutBoxHeight + 8

    if (overflows) {
      setAttr(body, 'data-lf-clamped', '1')
      // Keep the collapsed/expanded flag explicit for every folded body, so a
      // missing attribute never has to be read as "collapsed by accident".
      if (!body.hasAttribute('data-lf-open')) setAttr(body, 'data-lf-open', '0')
      record.wrapper.style.setProperty('--lf-clamp-height', `${cutHeight}px`)
      record.tail.style.setProperty('--lf-gap', `${gap}px`)
      if (!isOpen(body)) setLabel(record.toggle, labelFor(record))
    } else {
      removeAttr(body, 'data-lf-clamped')
      removeAttr(body, 'data-lf-open')
    }

    if (!overflows) setAttr(record.tail, 'hidden', '')
    else removeAttr(record.tail, 'hidden')
    return overflows
  }

  function clipped(record) {
    setAttr(record.tail, 'hidden', '')
    setAttr(record.body, 'data-lf-open', '0')
  }

  // ------------------------------------------------------------ visibility
  /**
   * The conversation holds over a thousand flow items. Anything that measures or
   * writes across all of them costs a synchronous layout per item, so both the
   * clamp pass and the work-step rows are limited to what is actually on screen
   * (plus a screen of margin, so scrolling never reveals an unfitted message).
   */
  function isNearViewport(element) {
    const rect = element.getBoundingClientRect()
    const height = win.innerHeight || 800
    return rect.bottom > -height && rect.top < height * 2
  }

  // ---------------------------------------------------------------- turn ids
  /** The Turn one flow row belongs to, as the host numbers it, or null. */
  function turnIdOf(element) {
    const raw = element.getAttribute('data-chat-turn')
    if (raw === null || raw === '') return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }

  /**
   * The newest Turn in the conversation. Read from the rows themselves rather
   * than from scroll position: a Turn is "latest" while its reply is the last
   * thing that happened, no matter where the reader has scrolled to.
   */
  function latestTurnId() {
    let latest = null
    for (const element of doc.querySelectorAll('[data-chat-turn]')) {
      const value = turnIdOf(element)
      if (value === null) continue
      if (latest === null || value > latest) latest = value
    }
    return latest
  }

  /** The Turn a step row belongs to: its own id, or the container's. */
  function turnKeyOfUnit(unit) {
    const own = turnIdOf(unit)
    if (own !== null) return own
    const row = unit.closest('[data-chat-turn]')
    return row ? turnIdOf(row) : null
  }

  /**
   * Every process block the host rendered for one Turn, in DOM order. Walks the
   * DOM fresh, so the Turn-wide control can act on blocks whose seam was never
   * built (they are off screen) instead of only on what happens to be visible.
   */
  function turnBlocksOf(turnKey) {
    const blocks = []
    const seen = new Set()
    for (const unit of doc.querySelectorAll(STEP_UNIT)) {
      if (seen.has(unit) || !isProcessUnit(unit)) continue
      const owner = unit.closest('[data-step-process]')
      if (owner && owner !== unit) continue
      const parent = unit.parentElement
      if (!parent || parent.closest(BLOCK_SKIP)) continue
      if (turnKeyOfUnit(unit) !== turnKey) continue

      let first = unit
      for (let previous = blockUnitBefore(first); previous; previous = blockUnitBefore(first)) first = previous
      const items = []
      for (let node = first; node; node = blockUnitAfter(node)) {
        items.push(node)
        seen.add(node)
      }
      const tail = blockTailAfter(items[items.length - 1])
      if (!tail || !tail.isConnected) continue
      const { controls, own } = decomposeBlock(items)
      if (controls.length === 0 && own.length === 0) continue
      blocks.push({ items, tail, controls, selfFold: controls.length === 0 })
    }
    return blocks
  }

  /**
   * The browser is about to reveal something it matched while it was hidden: a
   * Ctrl+F hit inside a folded step block, ours (hidden="until-found" on the rows)
   * or the host's own (its group members). Nothing may stay folded around the
   * match, so open the whole block — through whichever control owns it — and the
   * reader gets the step in context instead of one orphan row.
   */
  function onBeforeMatch(event) {
    const target = event.target
    if (!(target instanceof win.Element)) return
    if (target.closest('[data-lf-body],[data-lf-tail],[data-lf-step-line],[data-lf-panel]')) return
    // The browser opened this block for a reason; the automatic pass must not
    // fold it straight back under the reader (openBlockAt records that too).
    openBlockAt(target)
  }

  /**
   * Un-merge a Turn: every seam comes back, and the blocks stay folded exactly as
   * they were. Unfolding them here would make this control a duplicate of
   * "展开本轮" — un-merging is about the seams, not about the step content.
   */
  function unmergeTurn(turnKey) {
    mergedTurns.delete(turnKey)
    unmergedByReader.add(turnKey)
    schedule()
  }

  // -------------------------------------------------------------------- search
  /**
   * The conversation's searchable text blocks, folded content included: the fold
   * is display-level, so the text is always in the DOM — that is the whole point
   * of the until-found and scroll-reveal work.
   */
  function searchableBlocks() {
    const blocks = []
    for (const anchor of doc.querySelectorAll(FLOW_ITEM)) {
      const kind = anchor.getAttribute('data-chat-flow-kind')
      if (anchor.hasAttribute('data-turn-process-member')) {
        const text = (anchor.textContent ?? '').trim()
        if (text) blocks.push({ text, element: anchor, anchor, kind: 'step' })
        continue
      }
      if (kind === KIND_USER || kind === KIND_STEERING || kind === KIND_ASSISTANT) {
        const found = messageBodyOf(anchor, kind)
        if (!found) continue
        // After wrap() the host row's first child is OUR wrapper; the text body
        // lives inside it (and carries the clamp attributes reveal needs).
        const body = found.hasAttribute('data-lf-body') ? (found.firstElementChild ?? found) : found
        const text = textOfBody(body).trim()
        if (text) blocks.push({ text, element: body, anchor, kind: 'message' })
      }
    }
    return blocks
  }

  /** One hit: a short snippet around the match, plus what reveals it. */
  function snippetOf(text, index, length) {
    const start = Math.max(0, index - 24)
    const end = Math.min(text.length, index + length + 40)
    return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '')
  }

  /**
   * Search the rendered conversation, case-insensitively, folded content
   * included. Returns every hit in reading order with the element to reveal.
   */
  function searchConversation(query) {
    const needle = String(query ?? '').trim().toLocaleLowerCase()
    if (!needle) return []
    const hits = []
    for (const block of searchableBlocks()) {
      const lower = block.text.toLocaleLowerCase()
      let index = lower.indexOf(needle)
      while (index !== -1) {
        hits.push({
          element: block.element,
          kind: block.kind,
          snippet: snippetOf(block.text, index, needle.length)
        })
        index = lower.indexOf(needle, index + 1)
      }
    }
    return hits
  }

  /** Open the whole step block a row belongs to, whichever control owns it. */
  function openBlockAt(element) {
    const unit = element.closest?.(STEP_UNIT) ?? element
    if (!unit || !unit.isConnected || !isProcessUnit(unit)) return false
    const parent = unit.parentElement
    if (!parent || parent.closest(BLOCK_SKIP)) return false
    let first = unit
    for (let previous = blockUnitBefore(first); previous; previous = blockUnitBefore(first)) first = previous
    const items = []
    for (let node = first; node; node = blockUnitAfter(node)) items.push(node)
    const tail = blockTailAfter(items[items.length - 1])
    if (!tail || !tail.isConnected) return false
    const { controls } = decomposeBlock(items)
    if (controls.length > 0) {
      for (const descriptor of controls) {
        if (descriptor.control.disabled === true) continue
        if (controlIsOpen(descriptor)) continue
        descriptor.control.click()
      }
    } else {
      selfFolds.set(tail, false)
      applyFoldMarks(items, false)
    }
    autoFolded.add(tail)
    schedule()
    return true
  }

  /**
   * Reveal one search hit: a clamped message expands (a clipped highlight is a
   * highlight the reader cannot see), a folded step block opens through whichever
   * control owns it, and the page scrolls to the hit. This is the same unfolding
   * the browser's own find triggers through beforematch.
   */
  function revealAt(element) {
    if (!(element instanceof win.Element) || !element.isConnected) return false
    let changed = false
    const clampedBody = element.closest?.('[data-lf-clamped]')
    if (clampedBody) {
      for (const [anchor, record] of clamped) {
        if (record.body !== clampedBody) continue
        if (!isOpen(record.body)) {
          setOpen(anchor, record, true)
          schedule()
          changed = true
        }
        break
      }
    }
    const target = clampedBody ?? element
    if (openBlockAt(target)) changed = true
    if (typeof target.scrollIntoView === 'function') {
      try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch { target.scrollIntoView() }
    }
    // A short-lived ring marks the hit the reader jumped to.
    setAttr(target, 'data-lf-find-hit', '1')
    win.setTimeout(() => {
      if (target.isConnected) target.removeAttribute('data-lf-find-hit')
    }, 1300)
    return changed
  }

  /**
   * Fold or unfold every block of one Turn. Each block still goes through
   * whichever control owns it — the host's disclosure where there is one, our own
   * display-only mark where there is not — so the host's own header never
   * disagrees with what the reader sees.
   */
  function setTurnFolded(turnKey, folded) {
    for (const block of turnBlocksOf(turnKey)) {
      if (block.selfFold) {
        selfFolds.set(block.tail, folded)
        applyFoldMarks(block.items, folded)
      } else {
        for (const descriptor of block.controls) {
          if (descriptor.control.disabled === true) continue
          // Clicking toggles, so only a control that disagrees with the target
          // state may be clicked.
          if (controlIsOpen(descriptor) !== folded) continue
          descriptor.control.click()
        }
      }
      // An explicit choice by the reader: the automatic pass must not undo it.
      autoFolded.add(block.tail)
    }
    schedule()
  }

  // -------------------------------------------------------------------- scan
  // ---- 滚动位置补偿（「向上滚被拉回最底下」的病根修复）----
  // 折叠/展开会改变对话区总高度。变化发生在读者视口**下方**（读者刚离开底部
  // 一点点）时，浏览器会把 scrollTop 钳到新的 floor——这就是「向上拉动页面
  // 自动被拉回到最底下」：每趟 scan 折掉底部附近的消息，人就被钳回底部。
  // 宿主的贴底跟随阈值只有 1px（离开即释放 follow），所以症状主因是钳位。
  // 修法：每趟 scan 前后取滚动位置，仅当「位置被钳到了新 floor 且新 floor
  // 低于原位」时恢复原位；读者本来贴底不碰；宿主自己滚动的中间位置不碰。
  const scrollRootOf = () => doc.querySelector('[data-conversation-scroll]') ?? doc.body
  let scrollAnchor = null

  function captureScrollAnchor() {
    const root = scrollRootOf()
    const top = root.scrollTop
    const floor = Math.max(0, root.scrollHeight - root.clientHeight)
    scrollAnchor = { root, top, pinned: floor - top <= 2 }
  }

  function restoreScrollAnchor() {
    const saved = scrollAnchor
    scrollAnchor = null
    if (saved === null) return
    const { root, top, pinned } = saved
    stats.scrollFix.runs += 1
    if (pinned) { stats.scrollFix.pinnedSkipped += 1; return }
    const newFloor = Math.max(0, root.scrollHeight - root.clientHeight)
    // 被钳到（新）floor 且新 floor 低于原位置 → 恢复原位。
    if (root.scrollTop >= newFloor && newFloor < top) {
      root.scrollTop = top
      stats.scrollFix.adjusted += 1
      stats.scrollFix.lastDelta = top - newFloor
    }
  }

  function scan() {
    if (disposed) return
    captureScrollAnchor()
    try { scanInner() } finally { restoreScrollAnchor() }
  }

  function scanInner() {
    ensureStyles()
    applyRootFlag()
    stats.scans += 1

    if (!settings.enabled) {
      if (clamped.size > 0) clipAll()
      for (const chip of doc.querySelectorAll('[data-lf-turn-timer]')) chip.remove()
      return
    }

    const seen = new Set()
    const streaming = []
    const startedAt = now()
    let budgetLeft = true
    // The newest Turn is what the reader came for: its messages stay open even
    // when they are long. Older Turns fold down to their line budget.
    const latestTurn = settings.keepLatestOpen ? latestTurnId() : null

    for (const anchor of doc.querySelectorAll(FLOW_ITEM)) {
      // Yield between rows: a frame that touches a thousand flow items is what
      // made the interface stutter. Rows skipped here are picked up by the next
      // scheduled pass, and scrolling schedules one.
      if (budgetLeft && now() - startedAt > SCAN_BUDGET_MS) {
        budgetLeft = false
        schedule()
      }
      const flowKind = anchor.getAttribute('data-chat-flow-kind')
      if (flowKind !== KIND_USER && flowKind !== KIND_STEERING && flowKind !== KIND_ASSISTANT) continue
      // The DOM kind ("assistant-step") and the side ("assistant") are distinct;
      // settings and the anchor marker both use the side.
      const side = flowKind === KIND_ASSISTANT ? F.SIDE_ASSISTANT : F.SIDE_USER
      const limits = F.settingsForSide(settings, side)
      const existing = clamped.get(anchor)
      const isAssistant = side === F.SIDE_ASSISTANT
      if (isAssistant) stats.side.assistantSeen += 1
      else stats.side.userSeen += 1

      // The latest Turn never folds — not even by collapseAll.
      if (latestTurn !== null && turnIdOf(anchor) === latestTurn) {
        if (isAssistant) stats.side.latestTurn += 1
        else stats.side.userLatest += 1
        unwrap(anchor)
        continue
      }

      // Cheap, non-measuring branch: keep the bookkeeping honest for every row.
      if (!limits.enabled || skipReason(anchor, flowKind) || (side === F.SIDE_ASSISTANT && isStreaming(anchor))) {
        if (isAssistant) {
          if (!limits.enabled) stats.side.limitsOff += 1
          else if (skipReason(anchor, flowKind)) stats.side.skipAncestor += 1
          else stats.side.streaming += 1
        } else {
          stats.side.userSkip += 1
        }
        if (side === F.SIDE_ASSISTANT && isStreaming(anchor)) streaming.push(anchor)
        unwrap(anchor)
        continue
      }
      // Off-screen rows keep whatever fit they already have: measuring each one
      // costs a forced layout, and nobody can see the result.
      if (existing === undefined && !isNearViewport(anchor)) {
        if (isAssistant) stats.side.offscreen += 1
        else stats.side.userOffscreen += 1
        continue
      }

      seen.add(anchor)
      stats.measured += 1
      const lines = settings.collapseAll ? settings.collapsedLines : limits.lines

      let record = existing
      if (record && (!record.body.isConnected || !record.wrapper.isConnected || record.body.parentNode !== record.wrapper)) {
        // React replaced the subtree underneath us; drop the stale record and re-clamp.
        clamped.delete(anchor)
        measured.delete(anchor)
        record = undefined
      }
      if (!record) {
        const body = messageBodyOf(anchor, flowKind)
        if (!body) {
          if (isAssistant) stats.side.noBody += 1
          else stats.side.userNoBody += 1
          continue
        }
        record = wrap(anchor, side, body)
      }
      if (isAssistant) stats.side.wrapped += 1
      else stats.side.userWrapped += 1
      // Skip the measurement pass for settled rows whose geometry has not moved.
      // 指纹必须**不测量**：任何测量在克隆不可用的环境里都会退化成
      // 「解除 max-height → 量 → 还原」，那是每轮白写 4 个属性的自我喂食。
      // 内容指纹（结构 + 文本量 + 生效的行数预算）变了，几何才可能变；
      // 没变就一跳而过，连量都不量。
      const signature = contentSignature(record.body, lines, settings.extraPx, record.tail.hidden ? 0 : 1)
      if (measured.get(anchor) === signature) continue
      measured.set(anchor, signature)
      measureAndClamp(anchor, side, record)
      if (isAssistant) stats.side.measured += 1
      else stats.side.userMeasured += 1
    }

    if (budgetLeft) {
      for (const anchor of [...clamped.keys()]) {
        if (!seen.has(anchor) && !streaming.includes(anchor)) unwrap(anchor)
      }
      syncStepFolds()
      syncTurnTimers()
      syncComposerGrip()
    }
  }

  function now() {
    return win.performance?.now ? win.performance.now() : Date.now()
  }

  function schedule() {
    if (scheduled || disposed) return
    scheduled = true
    const run = () => {
      scheduled = false
      scan()
    }
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(run)
    else win.setTimeout(run, 60)
  }

  // ---------------------------------------------------------------- settings
  // There is deliberately NO standing overlay: a floating bar overlaps the
  // composer. Bulk actions live in each message's control row, and settings open
  // as a dismissible dialog.
  let panel = null
  let scrim = null

  function buildPanel() {
    panel = doc.createElement('div')
    panel.setAttribute('data-lf-panel', '1')

    const title = doc.createElement('h4')
    // 折叠只是这个插件最早的功能；现在它顺带接管输入框、步骤、右栏宽度与查找。
    title.textContent = 'UI 美化'
    panel.appendChild(title)

    const row = (labelText, control) => {
      const label = doc.createElement('label')
      const span = doc.createElement('span')
      span.textContent = labelText
      label.append(span, control)
      panel.appendChild(label)
      return control
    }

    const number = (key, min, max) => {
      const input = doc.createElement('input')
      input.type = 'number'
      input.min = String(min)
      input.max = String(max)
      input.value = String(settings[key])
      input.setAttribute('data-lf-key', key)
      input.addEventListener('change', () => {
        settings = F.normalizeSettings({ ...settings, [key]: input.value })
        input.value = String(settings[key])
        persist()
        scan()
      })
      return input
    }

    const checkbox = (key) => {
      const input = doc.createElement('input')
      input.type = 'checkbox'
      input.checked = Boolean(settings[key])
      input.setAttribute('data-lf-key', key)
      input.addEventListener('change', () => {
        settings = F.normalizeSettings({ ...settings, [key]: input.checked })
        persist()
        scan()
        syncPanel()
      })
      return input
    }

    row('启用插件', checkbox('enabled'))
    row('最新一轮保持展开', checkbox('keepLatestOpen'))
    row('折叠我的输入', checkbox('userEnabled'))
    row('我的输入保留行数', number('userLines', F.LIMITS.minLines, F.LIMITS.maxLines))
    row('折叠助手回复', checkbox('assistantEnabled'))
    row('助手回复保留行数', number('assistantLines', F.LIMITS.minLines, F.LIMITS.maxLines))
    row('全部消息都折叠', checkbox('collapseAll'))
    row('折叠后保留行数', number('collapsedLines', F.LIMITS.minLines, F.LIMITS.maxDefaultCollapsedLines))
    row('折叠后与控件的间距 (px)', number('extraPx', F.LIMITS.minExtraPx, F.LIMITS.maxExtraPx))
    row('步骤区与回复之间加折叠按钮', checkbox('workStepButtons'))
    row('步骤默认收起', checkbox('foldAllSteps'))
    row('默认只留一个按钮', checkbox('mergeByDefault'))
    row('按钮显示文字', checkbox('stepLabels'))
    row('每轮显示耗时', checkbox('turnTimer'))
    row('输入框可拖动调高', checkbox('composerResize'))

    // 右侧栏宽度：百分比存进设置（重启后保持），像素由宿主 layout store 管。
    // 这里提交时把值交给 win.rightbar 去同时改设置和宿主宽度；拖动宿主手柄时，
    // 宿主 store 的变化又通过控制器写回这个百分比，两边始终一致。
    const ratioInput = doc.createElement('input')
    ratioInput.type = 'number'
    ratioInput.min = String(F.LIMITS.minRightbarRatio)
    ratioInput.max = String(F.LIMITS.maxRightbarRatio)
    ratioInput.value = String(settings.rightbarRatio)
    ratioInput.setAttribute('data-lf-key', 'rightbarRatio')
    ratioInput.addEventListener('change', () => {
      const parsed = Number.parseInt(ratioInput.value, 10)
      if (!Number.isFinite(parsed)) {
        ratioInput.value = String(settings.rightbarRatio)
        return
      }
      win.rightbar?.setRatio?.(parsed)
    })
    row('右侧栏占比 (%)', ratioInput)

    // The composer height is not a plugin setting: it drives the host's own CSS
    // variable, so it gets its own control rather than the settings schema.
    const heightInput = doc.createElement('input')
    heightInput.type = 'number'
    heightInput.min = String(COMPOSER_MIN)
    heightInput.max = String(COMPOSER_MAX)
    heightInput.value = String(composerHeight)
    heightInput.setAttribute('data-lf-height', '1')
    heightInput.addEventListener('change', () => {
      const value = Number.parseFloat(heightInput.value)
      if (Number.isFinite(value)) setComposerHeight(value)
      else resetComposerHeight()
    })
    row(`输入框高度 (${COMPOSER_MIN}–${COMPOSER_MAX}px，留空恢复默认)`, heightInput)

    const footer = doc.createElement('footer')
    const hint = doc.createElement('span')
    hint.setAttribute('data-lf-hint', '1')
    hint.textContent = '仅改显示，不动会话'
    const close = doc.createElement('button')
    close.type = 'button'
    close.setAttribute('data-lf-act', 'close-panel')
    close.textContent = '关闭'
    const reset = doc.createElement('button')
    reset.type = 'button'
    reset.setAttribute('data-lf-act', 'reset')
    reset.textContent = '恢复默认'
    footer.append(hint, reset, close)
    panel.appendChild(footer)
    return panel
  }

  function syncPanel() {
    if (!panel) return
    for (const input of panel.querySelectorAll('[data-lf-key]')) {
      const key = input.getAttribute('data-lf-key')
      if (input.type === 'checkbox') input.checked = Boolean(settings[key])
      else input.value = String(settings[key])
      const gate = TIE[key]
      input.disabled = gate ? !settings[gate] : false
      if (gate) input.title = `需要先开启「${TIE_LABEL[gate]}」`
      else input.removeAttribute('title')
    }
    // Never rewrite a field the user is typing in: sync runs on every scan.
    const heightInput = panel.querySelector('[data-lf-height]')
    if (heightInput && doc.activeElement !== heightInput) heightInput.value = String(composerHeight)
  }

  function togglePanel(open) {
    panelOpen = open ?? !panelOpen
    if (panelOpen) {
      if (!panel) {
        panel = buildPanel()
        scrim = doc.createElement('div')
        scrim.setAttribute('data-lf-scrim', '1')
        doc.body.append(scrim, panel)
      }
      syncPanel()
      panel.hidden = false
      if (scrim) scrim.hidden = false
    } else {
      if (panel) panel.hidden = true
      if (scrim) scrim.hidden = true
    }
  }

  function closePanel() {
    togglePanel(false)
  }

  // ------------------------------------------------------- composer resizing
  // The host caps the composer at `--dsh-composer-text-max-height` (336px by
  // default) and scrolls inside that. Manually adjusting the height therefore
  // means raising that cap; the content still grows on its own up to it.
  const COMPOSER_MIN = 72
  const COMPOSER_MAX = 1400

  function composerSeats() {
    return [...doc.querySelectorAll('[data-composer-seat]')]
  }

  /**
   * The seat's first child is NOT the card: the host renders a zero-height
   * placeholder slot first, and a handle placed there is unreachable — pointer
   * hits land on the wrapper instead, so real mouse input never reaches it.
   * The card is the element that actually contains the input, so find it by
   * that relationship rather than by position or by a hashed class name.
   */
  function composerCardOf(seat) {
    for (const child of seat.children) {
      if (child.querySelector('[contenteditable="true"]')) return child
    }
    return seat.lastElementChild ?? seat.firstElementChild
  }

  /**
   * The host caps the input at max-height and scrolls inside; raising the cap
   * alone changes NOTHING visually while the content is short, which is why the
   * first drag seemed dead. When the user takes manual control we also pin the
   * scroll area with a min-height, so the box actually grows to the chosen size
   * (and still auto-scrolls once content passes it).
   *
   * The host marks that container with `data-input-scroll` (verified in its own
   * bundle: `className: css.scroll, "data-input-scroll": true`, wrapping the
   * contenteditable). Scanning for `overflow-y: auto` instead can return some
   * other scrollable box inside the card, and a wrong box means a wrong drag
   * origin — which the reader sees as the composer jumping on the first frame.
   */
  function composerScrollOf(card) {
    const marked = card.querySelector('[data-input-scroll]')
    if (marked) return marked
    for (const node of card.querySelectorAll('*')) {
      let style
      try {
        style = win.getComputedStyle(node)
      } catch {
        continue
      }
      if (style?.overflowY === 'auto') return node
    }
    return null
  }

  function applyComposerHeight() {
    for (const seat of composerSeats()) {
      seat.style.setProperty('--dsh-composer-text-max-height', `${composerHeight}px`)
      const card = composerCardOf(seat)
      const scroll = card ? composerScrollOf(card) : null
      if (!scroll) continue
      if (composerManual) scroll.style.setProperty('min-height', `${composerHeight}px`)
      else scroll.style.removeProperty('min-height')
    }
  }

  /**
   * Apply a manually chosen height. `floor` matters for dragging: an empty
   * composer is only ~44–52px tall, while the manual minimum is 72px, so dragging
   * from a one-line box would snap it UP to 72 on the very first frame. Passing the
   * current height as the floor keeps the first frame exactly where the reader is.
   */
  function setComposerHeight(value, floor = COMPOSER_MIN) {
    const lowest = Math.max(1, Math.min(floor, COMPOSER_MAX))
    const next = Math.max(lowest, Math.min(COMPOSER_MAX, Math.round(value)))
    if (next === composerHeight && composerManual) return
    composerHeight = next
    composerManual = true
    try {
      win.localStorage?.setItem(COMPOSER_STORAGE_KEY, String(next))
    } catch {
      /* private mode: the height simply does not survive a reload */
    }
    applyComposerHeight()
    syncPanel()
  }

  function resetComposerHeight() {
    composerHeight = COMPOSER_DEFAULT
    composerManual = false
    try {
      win.localStorage?.removeItem(COMPOSER_STORAGE_KEY)
    } catch {
      /* private mode */
    }
    applyComposerHeight()
    syncPanel()
  }

  /**
   * Add one thin drag handle to every composer card. It lives INSIDE the card's
   * flex column, so it can never overlap the input, the toolbar row, or the
   * send button.
   */
  function syncComposerGrip() {
    if (!settings.composerResize || !settings.enabled) {
      for (const [, handle] of composerHandles) handle.remove()
      composerHandles.clear()
      return
    }
    const wanted = new Set()
    for (const seat of composerSeats()) {
      applyComposerHeight()
      const card = composerCardOf(seat)
      if (!card) continue
      wanted.add(card)
      const live = composerHandles.get(card)
      // Validity is the PARENT relationship, not mere connectivity: on first run
      // the card may not be rendered yet, and a handle parked in the seat's
      // placeholder slot stays "connected" forever while being unreachable —
      // pointer hits land on the wrapper instead of the handle.
      if (live && live.isConnected && live.parentElement === card) continue
      if (live) {
        live.remove()
        composerHandles.delete(card)
      }
      const handle = doc.createElement('div')
      handle.setAttribute('data-lf-composer-handle', '1')
      handle.setAttribute('role', 'separator')
      handle.setAttribute('aria-orientation', 'horizontal')
      handle.setAttribute('aria-label', '拖动调整输入框高度；双击恢复默认')
      card.insertBefore(handle, card.firstChild)
      composerHandles.set(card, handle)
    }
    for (const [card, handle] of [...composerHandles]) {
      if (wanted.has(card) && card.isConnected && handle.parentElement === card) continue
      handle.remove()
      composerHandles.delete(card)
    }
    // Sweep strays from an earlier run that landed somewhere we no longer track.
    for (const stray of doc.querySelectorAll('[data-lf-composer-handle]')) {
      if (stray.parentElement && stray.parentElement.querySelector('[contenteditable="true"]')) continue
      stray.remove()
    }
  }

  /**
   * The pixel height the input area actually occupies right now. The first drag
   * must start from THIS, not from the configured cap: otherwise the first
   * pointermove snaps the box from its natural size to the cap in one jump.
   *
   * The scroll area is preferred, but when it cannot be resolved (a host restyle
   * can move it) the CARD is measured instead. Never fall back to `composerHeight`:
   * that value is a preference, not the current geometry, and using it as the drag
   * origin made a stray click jump the box to it.
   */
  function composerOrigin(seat) {
    const card = composerCardOf(seat)
    const scroll = card ? composerScrollOf(card) : null
    const viaAnchor = !!scroll && typeof scroll.hasAttribute === 'function' && scroll.hasAttribute('data-input-scroll')
    const candidates = [[scroll, viaAnchor ? 'input-scroll' : 'overflow-scan'], [card, 'card']]
    for (const [node, source] of candidates) {
      const rect = node?.getBoundingClientRect?.()
      if (rect && rect.height > 0) return { px: Math.round(rect.height), source }
    }
    return { px: 0, source: 'none' }
  }

  function composerVisualHeight(seat) {
    return composerOrigin(seat).px
  }

  /** The last few drag starts, so a bad first frame can be reported with numbers. */
  const dragSamples = []

  function onPointerDown(event) {
    const target = event.target
    if (!(target instanceof win.Element)) return
    const handle = target.closest('[data-lf-composer-handle]')
    if (!handle) return
    event.preventDefault()
    dragState = {
      handle,
      startY: event.clientY ?? 0,
      // Captured when the drag really starts, not here: anything the host does
      // between pointerdown and the first move (focus, auto-grow, layout) must be
      // absorbed into the origin instead of becoming a jump. The delta still
      // counts from the pointerdown position, so no pointer travel is lost.
      baseVisual: 0,
      moved: false
    }
    setAttr(handle, 'data-dragging', '1')
    win.addEventListener('pointermove', onPointerMove)
    win.addEventListener('pointerup', onPointerUp)
    win.addEventListener('pointercancel', onPointerUp)
  }

  /** A click is not a drag: ignore the sub-pixel jitter a tap always produces. */
  const DRAG_THRESHOLD_PX = 3

  function onPointerMove(event) {
    if (!dragState) return
    // The handle is the TOP EDGE of the composer: pulling it UP must raise the
    // edge and grow the box, so the pointer keeps touching the handle the whole
    // drag (up = taller, down = shorter).
    const y = event.clientY ?? 0
    if (!dragState.moved) {
      if (Math.abs(y - dragState.startY) < DRAG_THRESHOLD_PX) return
      const seat = composerSeats()[0]
      const origin = seat ? composerOrigin(seat) : { px: 0, source: 'none' }
      if (!(origin.px > 0)) return
      dragState.moved = true
      dragState.baseVisual = origin.px
      dragState.scrollSource = origin.source
    }
    if (!(dragState.baseVisual > 0)) return
    const applied = dragState.baseVisual - (y - dragState.startY)
    // The floor is the manual minimum, EXCEPT while the box is shorter than it: an
    // empty composer is ~44–52px, and clamping that up to 72 is exactly the "first
    // frame jump" the reader sees. Dragging down stays possible either way.
    const floor = Math.min(COMPOSER_MIN, dragState.baseVisual)
    setComposerHeight(applied, floor)
    if (!dragState.logged) {
      dragState.logged = true
      dragState.sample = {
        from: dragState.baseVisual,
        picked: dragState.scrollSource,
        delta: y - dragState.startY
      }
    }
    const seat = composerSeats()[0]
    const sample = dragState.sample
    if (sample && seat) {
      sample.applied = composerHeight
      win.requestAnimationFrame(() => {
        sample.actual = composerVisualHeight(seat)
        dragSamples.push(sample)
        if (dragSamples.length > 8) dragSamples.shift()
      })
    }
  }

  function onPointerUp() {
    if (!dragState) return
    removeAttr(dragState.handle, 'data-dragging')
    dragState = null
    win.removeEventListener('pointermove', onPointerMove)
    win.removeEventListener('pointerup', onPointerUp)
    win.removeEventListener('pointercancel', onPointerUp)
  }

  function onDoubleClick(event) {
    const target = event.target
    if (!(target instanceof win.Element)) return
    if (!target.closest('[data-lf-composer-handle]')) return
    resetComposerHeight()
  }

  // -------------------------------------------------------------------- print
  /**
   * Printing is the one reader action that cannot un-fold anything: paper has no
   * scrollbar and no click. So a print pass expands every fold first.
   *
   * Attribute-level hides (our own step marks, the host's own
   * `data-turn-process-hidden`) are undone synchronously, so the style recalc
   * lands before the snapshot is taken. Host disclosures that unfold by
   * unmounting rather than hiding are clicked as well — those travel through
   * React, so they are best effort. `afterprint` puts every recorded fold back.
   */
  let printRestore = null

  function expandForPrint() {
    if (printRestore !== null || !settings.enabled) return
    const attributes = []
    const foldedTails = new Set()
    for (const row of doc.querySelectorAll(`[${FOLD_MARK}]`)) {
      attributes.push([row, FOLD_MARK, row.getAttribute(FOLD_MARK)])
      row.removeAttribute(FOLD_MARK)
      // The until-found hiding travels with the mark: paper shows the rows.
      attributes.push([row, 'hidden', row.getAttribute('hidden')])
      row.removeAttribute('hidden')
    }
    for (const row of doc.querySelectorAll('[data-turn-process-hidden]')) {
      attributes.push([row, 'data-turn-process-hidden', row.getAttribute('data-turn-process-hidden')])
      row.removeAttribute('data-turn-process-hidden')
    }
    for (const [tail, record] of stepFolds) {
      if (!tail.isConnected || !record.line.isConnected) continue
      const items = blockAround(record.line)
      if (items.length === 0) continue
      const { controls } = decomposeBlock(items)
      if (!isBlockFolded(tail, controls)) continue
      foldedTails.add(tail)
      if (controls.length > 0) {
        for (const descriptor of controls) {
          if (descriptor.control.disabled === true) continue
          if (controlIsOpen(descriptor)) continue
          descriptor.control.click()
        }
      } else {
        selfFolds.set(tail, false)
        applyFoldMarks(items, false)
      }
      // The print pass made its own folding decision for this block; the scan
      // must not auto-fold it back underneath the snapshot.
      autoFolded.add(tail)
    }
    printRestore = { attributes, foldedTails }
  }

  function restoreAfterPrint() {
    const restore = printRestore
    printRestore = null
    if (restore === null) return
    for (const [row, name, value] of restore.attributes) {
      if (!row.isConnected) continue
      if (value === null) row.removeAttribute(name)
      else row.setAttribute(name, value)
    }
    for (const tail of restore.foldedTails) {
      const record = stepFolds.get(tail)
      if (!tail.isConnected || !record || !record.line.isConnected) continue
      const items = blockAround(record.line)
      if (items.length === 0) continue
      const { controls } = decomposeBlock(items)
      if (controls.length > 0) {
        for (const descriptor of controls) {
          if (descriptor.control.disabled === true) continue
          if (controlIsOpen(descriptor) === false) continue
          descriptor.control.click()
        }
      } else {
        selfFolds.set(tail, true)
        applyFoldMarks(items, true)
      }
    }
    schedule()
  }

  // ------------------------------------------------------------------ events
  function onClick(event) {
    const target = event.target
    if (!(target instanceof win.Element)) return

    // A bubble's own toggle: flips just that message.
    const toggle = target.closest('[data-lf-toggle]')
    if (toggle) {
      for (const [anchor, record] of clamped.entries()) {
        if (record.toggle === toggle) {
          setOpen(anchor, record, !isOpen(record.body))
          break
        }
      }
      return
    }

    // 展开全部 / 收起全部 — the Turn's seams, and only those:
    //   状态0 → click 展开全部 → 状态1: every seam comes back, contents stay folded.
    //   状态1/2 → click 收起全部 → 状态0: contents fold too and only this one
    //   button is left. (A single-block Turn has nothing to spread, so its 展开全部
    //   opens that block straight away.)
    const stepAll = target.closest('[data-lf-step-all]')
    if (stepAll) {
      const line = stepAll.closest('[data-lf-step-line]')
      const raw = line?.getAttribute('data-lf-turn')
      const turnKey = raw === null || raw === undefined ? null : Number(raw)
      if (turnKey !== null && Number.isFinite(turnKey)) {
        const blocks = turnBlocksOf(turnKey)
        if (blocks.length <= 1) {
          // A one-block Turn has nothing to spread out: this button is that block's
          // own toggle.
          const folded = blocks.length === 0 || isBlockFolded(blocks[0].tail, blocks[0].controls)
          setTurnFolded(turnKey, !folded)
          mergedTurns.delete(turnKey)
          unmergedByReader.add(turnKey)
          return
        }
        if (mergedTurns.has(turnKey)) {
          unmergeTurn(turnKey)
        } else {
          unmergedByReader.delete(turnKey)
          mergedTurns.add(turnKey)
          setTurnFolded(turnKey, true)
        }
      }
      return
    }

    // 展开所有步骤 / 收起所有步骤 — the CONTENT of every block of the Turn, while
    // the seams themselves stay exactly as they are.
    const stepEvery = target.closest('[data-lf-step-every]')
    if (stepEvery) {
      const line = stepEvery.closest('[data-lf-step-line]')
      const raw = line?.getAttribute('data-lf-turn')
      const turnKey = raw === null || raw === undefined ? null : Number(raw)
      if (turnKey !== null && Number.isFinite(turnKey) && !mergedTurns.has(turnKey)) {
        const blocks = turnBlocksOf(turnKey)
        const allOpen = blocks.length > 0 && blocks.every((block) => !isBlockFolded(block.tail, block.controls))
        setTurnFolded(turnKey, allOpen)
      }
      return
    }

    // 展开本步骤 / 收起本步骤 — one block's own steps. Folded → unfold: open the
    // host's own disclosure where there is one, or drop our display-only mark where
    // there is not. Unfolded → fold: the reverse.
    const stepFold = target.closest('[data-lf-step-toggle]')
    if (stepFold) {
      const line = stepFold.closest('[data-lf-step-line]') ?? stepFold
      const items = blockAround(line)
      if (items.length > 0) {
        const { controls } = decomposeBlock(items)
        const tail = blockTailAfter(items[items.length - 1])
        const folded = isBlockFolded(tail, controls)
        if (controls.length > 0) {
          // Both directions go through the host, so its own header never
          // disagrees with what the reader sees.
          for (const descriptor of controls) {
            if (descriptor.control.disabled === true) continue
            if (controlIsOpen(descriptor) === folded) continue
            descriptor.control.click()
          }
        } else if (tail) {
          selfFolds.set(tail, !folded)
        }
        // The reader made a choice: never auto-collapse this block again.
        if (tail) autoFolded.add(tail)
        schedule()
      }
      return
    }

    const action = target.closest('[data-lf-act]')?.getAttribute('data-lf-act')
    if (action === 'close-panel' || target === scrim) closePanel()
    else if (action === 'reset') {
      settings = F.normalizeSettings(null)
      persist()
      measured.clear()
      scan()
      syncPanel()
    }
  }

  // 面板内交互只剩 Esc 关闭（弹窗关闭的标准模式）。
  // 2026-10-13：**全部全局快捷键已移除**（原 Ctrl+Shift+B 总开关 / Ctrl+Shift+,
  // 开面板 / Ctrl+Shift+↑↓ 调输入框高度）——用户要求一切设置走设置界面
  // （宿主「设置 → 插件 → UI 美化」tab），不再注册任何组合键。
  function onKeydown(event) {
    if (event.key === 'Escape' && panelOpen) {
      closePanel()
    }
  }

  // Mutations coming from our OWN injected nodes (the control rows and the
  // clamp state) must not schedule another pass. Attribute writes are already
  // idempotent, but React re-rendering the surrounding row can still surface
  // them, and each one used to feed the loop.
  const observer = new win.MutationObserver((records) => {
    stats.mutations += records.length
    let foreign = false
    for (const record of records) {
      const target = record.target
      if (target instanceof win.Element && target.closest('[data-lf-body],[data-lf-tail],[data-lf-step-toggle],[data-lf-panel],[data-lf-scrim]')) {
        stats.selfMutations += 1
        continue
      }
      foreign = true
    }
    if (foreign) schedule()
  })
  ensureStyles()
  applyRootFlag()
  scan()

  // Observe the whole scroll root from the start: at activation time the chat
  // column may not be mounted yet, and the conversation renders inside it later.
  const scope = doc.querySelector('[data-conversation-scroll]') ?? doc.body
  observer.observe(scope, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'data-streaming',
      'data-chat-flow-kind',
      'hidden',
      'data-turn-process-hidden',
      'data-turn-process-answer'
    ]
  })
  win.addEventListener('resize', schedule, { passive: true })
  win.addEventListener('scroll', schedule, { passive: true, capture: true })
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('keydown', onKeydown, true)
  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('dblclick', onDoubleClick, true)
  // A printout must read as the whole conversation, whatever the screen shows.
  win.addEventListener('beforeprint', expandForPrint)
  win.addEventListener('afterprint', restoreAfterPrint)
  // Fired when find-in-page is about to reveal hidden-until-found content.
  doc.addEventListener('beforematch', onBeforeMatch, true)

  return {
    rescan: schedule,
    settings: () => ({ ...settings }),
    /**
     * Live counters. `scans` climbing while nothing happens means the plugin is
     * feeding itself; `measured` shows how much of each pass touched layout.
     */
    stats: () => ({ ...stats, clamped: clamped.size, stepFolds: stepFolds.size, selfFolds: selfFolds.size }),
    update(patch) {
      settings = F.normalizeSettings({ ...settings, ...patch })
      persist()
      measured.clear()
      scan()
      syncPanel()
      notifySettings()
    },
    /**
     * Subscribe to settings changes; returns an unsubscribe. The React tab in the
     * host's settings page re-reads `settings()` on every notification.
     */
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {}
      settingsListeners.add(fn)
      return () => settingsListeners.delete(fn)
    },
    // Manual controls, also available from the console for scripting/tests.
    setHeight: (value) => setComposerHeight(value),
    resetHeight: () => resetComposerHeight(),
    /**
     * The composer height is a host-CSS knob rather than a plugin setting, so the
     * settings page asks for it separately (range, current value, stock fallback).
     */
    composer: () => ({
      min: COMPOSER_MIN,
      max: COMPOSER_MAX,
      value: composerHeight,
      fallback: F.COMPOSER_DEFAULT,
      manual: composerManual
    }),
    /**
     * Self-recorded drag samples: where the origin came from, what we applied and
     * what the box actually measured one frame later. `actual !== applied` means the
     * host ignored or re-laid-out our value, which is the only way to tell that
     * apart from a bad origin.
     */
    dragLog: () => dragSamples.slice(),
    // The sidebar find panel: search the rendered conversation (folded content
    // included) and reveal one hit by unfolding whatever hides it.
    search: searchConversation,
    revealAt,
    dispose() {
      disposed = true
      observer.disconnect()
      win.removeEventListener('resize', schedule)
      win.removeEventListener('scroll', schedule, { capture: true })
      doc.removeEventListener('click', onClick, true)
      doc.removeEventListener('keydown', onKeydown, true)
      doc.removeEventListener('pointerdown', onPointerDown, true)
      doc.removeEventListener('dblclick', onDoubleClick, true)
      win.removeEventListener('beforeprint', expandForPrint)
      win.removeEventListener('afterprint', restoreAfterPrint)
      doc.removeEventListener('beforematch', onBeforeMatch, true)
      win.removeEventListener('pointermove', onPointerMove)
      win.removeEventListener('pointerup', onPointerUp)
      win.removeEventListener('pointercancel', onPointerUp)
      for (const [, handle] of composerHandles) handle.remove()
      composerHandles.clear()
      for (const seat of composerSeats()) seat.style.removeProperty('--dsh-composer-text-max-height')
      turnTimerOff?.()
      turnTimerOff = null
      for (const chip of doc.querySelectorAll('[data-lf-turn-timer]')) chip.remove()
      clipAll()
      disposeMeasureHost()
      panel?.remove()
      scrim?.remove()
      panel = null
      scrim = null
      styleTag?.remove()
      styleTag = null
      doc.documentElement.removeAttribute(F.ROOT_ATTRIBUTE)
      if (win.__DSH_BUBBLE_FOLD__) delete win.__DSH_BUBBLE_FOLD__
    }
  }
}
