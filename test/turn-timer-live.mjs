// Read-only live probe for the per-turn timer: drives a headless Chrome against
// the RUNNING harness GUI and reports what the probe has actually seen.
//   node test/turn-timer-live.mjs [url]
// Writes nothing: settings, layout, store are only read.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9228
const USER_DATA = path.join(here, '_chrome-live')
const URL = process.argv[2] ?? 'http://127.0.0.1:19387'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let socket = null
let nextId = 1
const pending = new Map()
const pageErrors = []
const connect = async (url) => {
  socket = new WebSocket(url)
  await new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true })
    socket.addEventListener('error', rej, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text)
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1000', 'about:blank'
], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 40 && !target; i += 1) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    target = list.find((e) => e.type === 'page')
  } catch { /* not up yet */ }
}
if (!target) {
  console.log('chrome did not start')
  chrome.kill()
  process.exit(1)
}
await connect(target.webSocketDebuggerUrl)
await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: URL })

let ready = false
for (let i = 0; i < 60 && !ready; i += 1) {
  await sleep(500)
  try {
    ready = await evaluate('typeof window.__DSH_BUBBLE_FOLD__ === "object"')
  } catch { /* page still loading */ }
}
console.log('plugin handle ready:', ready)
if (!ready) {
  console.log(JSON.stringify(await evaluate(`(() => {
    const boot = window.__DSH_BOOT__ ?? null
    return {
      url: location.href,
      title: document.title,
      bootType: typeof boot,
      bootText: typeof boot === 'string' ? boot.slice(0, 200) : (boot ? JSON.stringify(boot).slice(0, 400) : null),
      foldPolishAlias: typeof window.__DSH_FOLD_POLISH__,
      bodyStart: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 200)
    }
  })()`), null, 2))
  console.log('page errors:', JSON.stringify(pageErrors, null, 2))
  chrome.kill()
  process.exit(0)
}

// Sample the timer diagnostics twice, 2.5s apart: the poll loop ticks every 1s,
// so the second read must show polls increasing — that alone proves the probe
// is alive. durations comes from whatever the CURRENT session has settled.
const read = () => evaluate(`(() => {
  const h = window.__DSH_BUBBLE_FOLD__
  if (!h) return { present: false }
  const t = h.turnTimer?.() ?? {}
  const probe = t.probe ?? {}
  return {
    present: true,
    status: h.status,
    storeKeys: t.store ? Object.keys(t.store).length : null,
    durationsSample: t.store ? Object.fromEntries(Object.entries(t.store).slice(0, 6)) : null,
    probe: {
      polls: probe.polls ?? null,
      attempts: probe.attempts ?? null,
      services: probe.services ?? null,
      sessionId: probe.sessionId ? String(probe.sessionId).slice(0, 12) + '…' : null,
      target: probe.target ?? null,
      nodes: probe.nodes ?? null,
      snapshot: probe.snapshot ?? null,
      lastError: probe.lastError ?? null
    }
  }
})()`)
console.log('--- read 1 ---')
console.log(JSON.stringify(await read(), null, 2))
await sleep(2500)
console.log('--- read 2 (2.5s later) ---')
console.log(JSON.stringify(await read(), null, 2))

console.log('\npage errors:', JSON.stringify(pageErrors, null, 2))
chrome.kill()
process.exit(0)
