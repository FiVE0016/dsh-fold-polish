// Read-only compatibility check for the installed DeepSeek Harness.
//
// The client bundle reaches into the Host through a small set of contracts:
// service names, slot names, `data-*` markers and one CSS custom property.
// None of them are versioned, so an upgrade can remove one silently and the
// matching feature simply stops appearing.
//
// This script scans the installed `app.asar` and reports which contracts are
// still present, comparing against a recorded baseline. It never writes to the
// host, never loads the plugin and is not part of the build.
//
//   node scripts/check-host-compat.mjs             # compare with baseline
//   node scripts/check-host-compat.mjs --baseline  # (re)record baseline
//   node scripts/check-host-compat.mjs --asar <path/to/app.asar>
//
// Exit codes: 0 = every contract found, 1 = at least one contract missing.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const baselinePath = path.join(root, 'docs', 'host-contract-baseline.json')

/** Host contracts this plugin depends on, grouped by the feature they carry. */
const CONTRACTS = [
  // Services the client entry injects.
  ['sessionPersistence', '删除对话'],
  ['sessions', '删除对话'],
  ['agents', '删除对话'],
  ['workspaceRegistry', '删除对话'],
  ['typert', '删除对话'],
  ['agentLoop', '删除对话'],
  ['sessionController', '删除对话'],
  ['sessionQuery', '删除对话'],
  ['storageDomain', '删除对话'],
  ['sessionProjectionCache', '删除对话'],
  // Services the client UI features inject.
  ['slots', '设置面板/查找/删除'],
  ['layout', '右栏宽度'],
  ['connection', '删除对话'],
  ['uiWorkspace', '删除对话'],
  ['workspaces', '删除对话'],
  ['sidebarRightTabs', '查找页签'],
  ['uiConversation', '每轮耗时'],
  // Slot names.
  ['settings.plugins.tab', '设置面板'],
  ['sidebar.right.pane.tab', '查找页签'],
  ['sidebar.right.pane.tab.title', '查找页签'],
  // Conversation markers the fold layer keys off.
  ['data-chat-flow-kind', '消息折叠/耗时'],
  ['data-step-process', '工作步骤折叠'],
  ['data-step-process-icon', '工作步骤折叠'],
  ['data-turn-process', '工作步骤折叠'],
  ['data-turn-process-member', '工作步骤折叠'],
  ['data-turn-process-hidden', '工作步骤折叠'],
  ['data-turn-process-inline', '工作步骤折叠'],
  ['data-conversation-scroll', '输入框定位'],
  ['data-conversation-session', '输入框定位'],
  ['data-conversation-composer-overlay', '输入框定位'],
  ['data-composer-seat', '输入框高度'],
  ['data-composer-card', '输入框高度'],
  ['data-input-scroll', '输入框高度'],
  ['data-streaming', '消息折叠'],
  // Right column markers.
  ['data-rightbar-col', '右栏宽度'],
  ['data-rightbar-collapsed', '右栏宽度'],
  ['data-rightbar-fullscreen', '右栏宽度'],
  ['data-dragging', '右栏宽度'],
  // Ceiling property read back for "restore natural height".
  ['--dsh-composer-text-max-height', '输入框高度'],
]

const args = process.argv.slice(2)
const asarIndex = args.indexOf('--asar')
const asarPath =
  asarIndex >= 0 && args[asarIndex + 1]
    ? path.resolve(args[asarIndex + 1])
    : path.join(
        process.env.LOCALAPPDATA ?? 'C:\\Users\\Default\\AppData\\Local',
        'Programs',
        'DeepSeek Harness',
        'resources',
        'app.asar',
      )
const recordBaseline = args.includes('--baseline')

if (!existsSync(asarPath)) {
  console.error(`[compat] 找不到 Harness 安装包：${asarPath}`)
  console.error('[compat] 用 --asar <path> 指定 app.asar 的路径。')
  process.exit(2)
}

const started = Date.now()
const buffer = readFileSync(asarPath)
// latin1 keeps a 1:1 byte mapping, so offsets and counts stay honest and the
// decode is cheap for an 180 MB archive of mostly ASCII source.
const text = buffer.toString('latin1')

const hostVersion =
  /@deepseek-ai\/dsh-desktop-runtime[\s\S]{0,400}?"version":\s*"([^"]+)"/.exec(text)?.[1] ??
  '未知'

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const union = new RegExp(
  CONTRACTS.map(([token]) => escape(token))
    .sort((a, b) => b.length - a.length)
    .join('|') + '(?![-\\w])',
  'g',
)
const counts = Object.create(null)
for (const token of CONTRACTS) counts[token[0]] = 0
for (const match of text.matchAll(union)) counts[match[0]] += 1

const snapshot = {
  hostVersion,
  asarPath,
  asarBytes: buffer.length,
  asarModified: statSync(asarPath).mtime.toISOString(),
  counts,
}

const missing = CONTRACTS.filter(([token]) => counts[token] === 0)

if (recordBaseline) {
  writeFileSync(baselinePath, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`[compat] 已记录基线：${path.relative(root, baselinePath)}`)
  console.log(`[compat] Harness 版本 ${hostVersion}，契约 ${CONTRACTS.length} 项`)
  for (const [token, feature] of CONTRACTS) {
    if (counts[token] === 0) console.log(`  缺失  ${token}  （${feature}）`)
  }
  process.exit(missing.length ? 1 : 0)
}

const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, 'utf8'))
  : null

const pad = (value, width) => String(value).padEnd(width)
console.log(`[compat] Harness 版本 ${hostVersion}`)
console.log(`[compat] 安装包 ${asarPath}`)
console.log(
  `[compat] 基线 ${baseline ? baseline.hostVersion : '（未记录）'} · 扫描 ${(buffer.length / 1048576).toFixed(1)} MB · ${Date.now() - started} ms`,
)
console.log('')
console.log(`${pad('契约', 40)}${pad('功能', 20)}${pad('数量', 8)}变化`)
const drifted = []
for (const [token, feature] of CONTRACTS) {
  const now = counts[token]
  const before = baseline?.counts?.[token]
  const delta =
    before === undefined ? '—' : now === before ? '不变' : `${before} → ${now}`
  if (before !== undefined && now !== before) drifted.push([token, feature, before, now])
  console.log(`${pad(token, 40)}${pad(feature, 20)}${pad(now, 8)}${delta}`)
}
console.log('')
if (missing.length) {
  console.log(`[compat] ${missing.length} 项契约在当前安装包里找不到，相关功能会静默失效：`)
  for (const [token, feature] of missing) console.log(`  ✗ ${token}  （${feature}）`)
}
if (drifted.length && !missing.length) {
  console.log(`[compat] ${drifted.length} 项数量变化（未必是问题，但值得复核）：`)
  for (const [token, feature, before, now] of drifted)
    console.log(`  ~ ${token}  ${before} → ${now}  （${feature}）`)
}
if (!missing.length && !drifted.length)
  console.log('[compat] 全部契约与基线一致。')
process.exit(missing.length ? 1 : 0)
