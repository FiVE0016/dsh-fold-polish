// Real Chromium acceptance checks for the rewritten browser controller.
// No npm dependencies. Node >= 22 and Chrome/Chromium are required.
// Run: node test/rewrite-browser.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const artifacts = path.resolve(
  process.env.DSH_TEST_ARTIFACTS || path.join(root, 'work', 'rewrite-browser'),
)
const chromePath =
  process.env.CHROME ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
await mkdir(artifacts, { recursive: true })
const profile = await mkdtemp(path.join(artifacts, 'profile-'))
const results = []
const exceptions = []
let chrome,
  socket,
  nextId = 0
const pending = new Map()

const server = createServer(async (request, response) => {
  try {
    const relative = decodeURIComponent(
      new URL(request.url, 'http://localhost').pathname,
    ).slice(1)
    const filename = path.resolve(root, relative)
    if (filename !== root && !filename.startsWith(root + path.sep))
      throw new Error('outside fixture root')
    const bytes = await readFile(
      relative === 'src/browser.js' && process.env.DSH_TEST_BROWSER_SOURCE
        ? path.resolve(process.env.DSH_TEST_BROWSER_SOURCE)
        : filename,
    )
    response.writeHead(200, {
      'content-type': filename.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(bytes)
  } catch {
    response.writeHead(404)
    response.end('Not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, 15000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text,
    )
  return result.result.value
}
const page = (fn, ...args) =>
  evaluate(
    `(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(',')})`,
  )
async function settle() {
  await page(async () => {
    await new Promise((r) => setTimeout(r, 130))
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    )
  })
}
async function check(name, run) {
  try {
    const detail = await run()
    results.push({ name, pass: true, detail })
    console.log(`PASS ${name}${detail ? ' · ' + JSON.stringify(detail) : ''}`)
  } catch (error) {
    results.push({ name, pass: false, error: error.message })
    console.error(`FAIL ${name}: ${error.message}`)
  }
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  await writeFile(path.join(artifacts, name), Buffer.from(data, 'base64'))
}
async function installHelpers() {
  await page(() => {
    const visible = (element) => {
      if (!element?.isConnected || element.getBoundingClientRect().height === 0)
        return false
      for (let item = element; item; item = item.parentElement)
        if (
          getComputedStyle(item).display === 'none' ||
          getComputedStyle(item).visibility === 'hidden'
        )
          return false
      return true
    }
    window.qa = {
      visible,
      row: (id) =>
        document.getElementById(id)?.closest('[data-chat-flow-kind]'),
      button: (id) => window.qa.row(id)?.querySelector('[data-lf-toggle]'),
      preview: (id) => window.qa.row(id)?.querySelector('[data-lf-preview]'),
      message: (id) => {
        const source = document.getElementById(id)
        const button = window.qa.button(id)
        const preview = window.qa.preview(id)
        const shownText = preview && visible(preview) ? preview : source
        const tops = new Set()
        const walker = document.createTreeWalker(
          shownText,
          NodeFilter.SHOW_TEXT,
        )
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent.trim()) continue
          const range = document.createRange()
          range.selectNodeContents(walker.currentNode)
          for (const rect of range.getClientRects())
            if (rect.width > 0 && rect.height > 0)
              tops.add(Math.round(rect.top))
        }
        return {
          expanded: button?.getAttribute('aria-expanded'),
          label: button?.textContent.trim(),
          sourceVisible: visible(source),
          previewVisible: visible(preview),
          textLines: tops.size,
          sourceText: source?.textContent,
          previewText: preview?.textContent,
        }
      },
      stepButtons: (turn) =>
        [
          ...document.querySelectorAll(
            '[data-lf-step-all],[data-lf-step-toggle],[data-lf-step-every]',
          ),
        ].filter((button) => {
          const line = button.closest('[data-lf-step-line]')
          const actualTurn =
            line?.getAttribute('data-lf-turn') ||
            line?.previousElementSibling
              ?.closest('[data-chat-turn]')
              ?.getAttribute('data-chat-turn')
          return visible(button) && actualTurn === String(turn)
        }),
      stepLines: (turn) =>
        [...document.querySelectorAll('[data-lf-step-line]')].filter((line) => {
          const actualTurn =
            line.getAttribute('data-lf-turn') ||
            line.previousElementSibling
              ?.closest('[data-chat-turn]')
              ?.getAttribute('data-chat-turn')
          return visible(line) && actualTurn === String(turn)
        }),
      stepState: (turn) => ({
        lines: window.qa.stepLines(turn).length,
        buttons: window.qa.stepButtons(turn).map((button) => ({
          kind: button.hasAttribute('data-lf-step-toggle')
            ? 'single'
            : button.hasAttribute('data-lf-step-every')
              ? 'every'
              : 'all',
          text: button.innerText.trim(),
          label: button.getAttribute('aria-label'),
          expanded: button.getAttribute('aria-expanded'),
          width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height,
          svg: button.querySelector('svg')?.innerHTML,
        })),
        content: [
          ...(String(turn) === '1'
            ? ['groupStep1']
            : ['inlineStep1', 'inlineStep2', 'inlineStep3']),
        ].map((id) => window.qa.visible(document.getElementById(id))),
      }),
      composer: () => {
        const card = document.getElementById('composerCard')
        const actions = document.getElementById('composerActions')
        const editor = document.getElementById('editorScroll')
        const handle = card.querySelector('[data-lf-composer-handle]')
        const button = actions.querySelector('button')
        const c = card.getBoundingClientRect()
        const a = actions.getBoundingClientRect()
        const e = editor.getBoundingClientRect()
        const h = handle?.getBoundingClientRect()
        const flow = [...card.children].filter(
          (element) =>
            !['absolute', 'fixed'].includes(getComputedStyle(element).position),
        )
        const style = getComputedStyle(card)
        return {
          handleCount: card.querySelectorAll('[data-lf-composer-handle]')
            .length,
          handlePosition: handle && getComputedStyle(handle).position,
          handleTopOffset: h && h.top - c.top,
          handleBottomOffset: h && h.bottom - c.top,
          editorTopOffset: e.top - c.top,
          editorHeight: e.height,
          cardHeight: c.height,
          expectedHeight:
            Number.parseFloat(style.paddingTop) +
            e.height +
            Number.parseFloat(style.rowGap) +
            a.height,
          lastFlowChild: flow.at(-1)?.id,
          actionsBottomGap: c.bottom - a.bottom,
          buttonBottomGap: c.bottom - button.getBoundingClientRect().bottom,
        }
      },
      hostDock: () => {
        const rect = (id) => {
          const node = document.getElementById(id)
          const box = node.getBoundingClientRect()
          return { top: box.top, bottom: box.bottom, height: box.height }
        }
        const scroll = document.getElementById('scroll')
        const seat = rect('composerSeat')
        return {
          viewport: innerHeight,
          scroll: rect('scroll'),
          seat,
          view: rect('hostViewArea'),
          content: rect('conversation'),
          editor: rect('editorScroll'),
          actions: rect('composerActions'),
          scrollTop: scroll.scrollTop,
          scrollHeight: scroll.scrollHeight,
          scrollClientHeight: scroll.clientHeight,
          bodyHeight: document.body.scrollHeight,
          belowComposer: seat.bottom < innerHeight - 1,
        }
      },
      state: () => window.controller.settings(),
    }
  })
}
async function navigate(persist = false, hostLayout = false) {
  const query = new URLSearchParams()
  if (persist) query.set('persist', '1')
  if (hostLayout) query.set('host-layout', '1')
  await send('Page.navigate', {
    url: `${origin}/test/rewrite-fixture.html?${query}`,
  })
  let ready = false
  for (let index = 0; index < 100 && !ready; index++) {
    await sleep(50)
    try {
      ready = await evaluate(
        'Boolean(window.fixture?.ready && window.controller)',
      )
    } catch {}
  }
  assert.ok(ready, `Fixture did not boot: ${exceptions.join('\n')}`)
  await settle()
  await installHelpers()
}
async function update(patch) {
  await page((patch) => window.controller.update(patch), patch)
  await settle()
}
async function clickMessage(id) {
  await page((id) => window.qa.button(id).click(), id)
  await settle()
}
function assertComposerLayout(info, hasHandle = true) {
  assert.equal(info.handleCount, hasHandle ? 1 : 0, JSON.stringify(info))
  assert.equal(info.lastFlowChild, 'composerActions', JSON.stringify(info))
  assert.ok(Math.abs(info.actionsBottomGap) < 0.5, JSON.stringify(info))
  assert.ok(Math.abs(info.buttonBottomGap - 8) < 0.5, JSON.stringify(info))
  assert.ok(
    Math.abs(info.cardHeight - info.expectedHeight) < 0.5,
    JSON.stringify(info),
  )
  if (hasHandle) {
    assert.equal(info.handlePosition, 'absolute', JSON.stringify(info))
    assert.ok(info.handleTopOffset <= 4, JSON.stringify(info))
    assert.ok(
      info.handleBottomOffset <= info.editorTopOffset + 4,
      JSON.stringify(info),
    )
  }
}
function assertHostDock(info, reserve = 0) {
  assert.ok(
    Math.abs(info.seat.bottom - info.scroll.bottom) < 1,
    JSON.stringify(info),
  )
  assert.ok(info.scroll.bottom <= info.viewport + 1, JSON.stringify(info))
  assert.ok(info.bodyHeight <= info.viewport + 1, JSON.stringify(info))
  assert.ok(
    info.seat.top >= info.scroll.top + reserve - 1,
    JSON.stringify(info),
  )
  assert.equal(info.belowComposer, false, JSON.stringify(info))
}

async function startComposerPositionFault() {
  await page(() => {
    const seat = document.getElementById('composerSeat')
    window.fixture.recoveryNodes = {
      seat,
      parent: seat.parentNode,
      scroll: document.getElementById('scroll'),
    }
    // Native AssistantMarkdown marks its outer root while the body grows.
    document
      .getElementById('answer3')
      .parentElement.setAttribute('data-streaming', 'true')
    document.getElementById('answer3').textContent = window.fixture.lines(
      '正在输出',
      150,
    )
    document.getElementById('conversation').setAttribute('data-chat-motion', '')
    const fault = document.createElement('style')
    fault.id = 'hostComposerPositionFault'
    fault.textContent =
      '#main.hostComposerUnpinned #composerSeat { position:relative; } #main.hostComposerShifted #composerSeat { top:-90px; }'
    document.head.append(fault)
    document.getElementById('main').classList.add('hostComposerUnpinned')
    document.getElementById('scroll').scrollTop = 0
  })
  await settle()
}
async function stopComposerPositionFault(restart = false) {
  await page((restart) => {
    document.getElementById('main').classList.remove('hostComposerUnpinned')
    document.getElementById('main').classList.remove('hostComposerShifted')
    document.getElementById('hostComposerPositionFault')?.remove()
    document
      .getElementById('answer3')
      .parentElement.removeAttribute('data-streaming')
    document.getElementById('conversation').removeAttribute('data-chat-motion')
    document.querySelector('[data-conversation-composer-overlay]')?.remove()
    if (restart) window.fixture.restart()
    else window.controller.rescan()
  }, restart)
  await settle()
}
async function composerRecovery() {
  return page(() => {
    const seat = document.getElementById('composerSeat')
    const reserve = document.querySelector('[data-lf-composer-reserve]')
    const nodes = window.fixture.recoveryNodes
    return {
      recovered: seat.hasAttribute('data-lf-composer-recovered'),
      position: getComputedStyle(seat).position,
      reserves: document.querySelectorAll('[data-lf-composer-reserve]').length,
      reservedHeight: reserve?.getBoundingClientRect().height ?? 0,
      seatHeight: seat.getBoundingClientRect().height,
      reserveInert: reserve?.inert ?? false,
      reserveHidden: reserve?.getAttribute('aria-hidden') ?? null,
      sameSeat: seat === nodes.seat,
      sameParent: seat.parentNode === nodes.parent,
      sameScroll: document.getElementById('scroll') === nodes.scroll,
      scrollTop: nodes.scroll.scrollTop,
    }
  })
}
function assertComposerRecovery(info, active) {
  assert.equal(info.recovered, active, JSON.stringify(info))
  assert.equal(info.reserves, active ? 1 : 0, JSON.stringify(info))
  assert.equal(info.sameSeat, true, JSON.stringify(info))
  assert.equal(info.sameParent, true, JSON.stringify(info))
  assert.equal(info.sameScroll, true, JSON.stringify(info))
  if (active) {
    assert.equal(info.position, 'fixed', JSON.stringify(info))
    assert.ok(
      Math.abs(info.reservedHeight - info.seatHeight) < 1,
      JSON.stringify(info),
    )
    assert.equal(info.reserveInert, true, JSON.stringify(info))
    assert.equal(info.reserveHidden, 'true', JSON.stringify(info))
  }
}

async function installComposerScrollProbe() {
  await page(() => {
    const root = document.getElementById('scroll')
    const seat = document.getElementById('composerSeat')
    let prototype = root
    while (!Object.hasOwn(prototype, 'scrollTop'))
      prototype = Object.getPrototypeOf(prototype)
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollTop')
    const measure = seat.getBoundingClientRect
    const state = { writes: [], samples: [] }
    const sample = (reason) => {
      state.samples.push({
        reason,
        top: descriptor.get.call(root),
        max: root.scrollHeight - root.clientHeight,
      })
    }
    // Read the browser's real layout during composer measurements. Checking only
    // the final scrollTop misses a temporary shrink followed by a restoring write.
    Object.defineProperty(root, 'scrollTop', {
      configurable: true,
      get() {
        sample('read')
        return descriptor.get.call(root)
      },
      set(value) {
        state.writes.push({ value, stack: new Error().stack })
        descriptor.set.call(root, value)
        sample('write')
      },
    })
    seat.getBoundingClientRect = function () {
      const rect = measure.call(this)
      sample('measure')
      return rect
    }
    sample('start')
    window.fixture.scrollProbe = {
      snapshot() {
        sample('end')
        return structuredClone(state)
      },
      reset() {
        state.writes.length = 0
        state.samples.length = 0
        sample('start')
      },
      dispose() {
        delete root.scrollTop
        delete seat.getBoundingClientRect
      },
    }
  })
}
function assertPassiveComposerScroll(probe) {
  const start = probe.samples[0]
  assert.equal(
    probe.writes.length,
    0,
    JSON.stringify({
      writes: probe.writes.length,
      firstWrite: probe.writes[0],
      start,
      minimumRange: Math.min(...probe.samples.map((sample) => sample.max)),
      minimumTop: Math.min(...probe.samples.map((sample) => sample.top)),
    }),
  )
  for (const sample of probe.samples) {
    assert.ok(
      sample.max >= start.max - 1,
      `Scroll range shrank during a composer measurement: ${JSON.stringify({ start, sample })}`,
    )
    assert.ok(
      Math.abs(sample.top - start.top) <= 1,
      `Reader position changed during a composer measurement: ${JSON.stringify({ start, sample })}`,
    )
  }
  return { top: start.top, samples: probe.samples.length, writes: 0 }
}

try {
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1280,1000',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  )
  let debugPort
  for (let index = 0; index < 100 && !debugPort; index++) {
    await sleep(50)
    try {
      debugPort = Number(
        (
          await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')
        ).split('\n')[0],
      )
    } catch {}
  }
  assert.ok(debugPort, 'Chrome did not expose its debugging port')
  const targets = await (
    await fetch(`http://127.0.0.1:${debugPort}/json/list`)
  ).json()
  const target = targets.find((target) => target.type === 'page')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const result = JSON.parse(event.data)
    if (result.method === 'Runtime.exceptionThrown')
      exceptions.push(
        result.params.exceptionDetails?.exception?.description ||
          result.params.exceptionDetails?.text,
      )
    const request = pending.get(result.id)
    if (!request) return
    clearTimeout(request.timeout)
    pending.delete(result.id)
    result.error
      ? request.reject(new Error(JSON.stringify(result.error)))
      : request.resolve(result.result)
  })
  await send('Runtime.enable')
  await send('Page.enable')
  await navigate()

  await check(
    '默认历史用户输入与助手回复均只露出 3 行，并准确显示余行数',
    async () => {
      const state = await page(() =>
        ['user1', 'answer1'].map(window.qa.message),
      )
      for (const item of state) {
        assert.equal(item.expanded, 'false')
        assert.equal(item.textLines, 3)
        assert.equal(item.sourceVisible, false)
        assert.equal(item.previewVisible, true)
      }
      assert.match(state[0].label, /展开我的输入.*还有\s*9\s*行/)
      assert.match(state[1].label, /展开全文.*还有\s*11\s*行/)
      return state.map(({ label, textLines }) => ({ label, textLines }))
    },
  )
  await check('正文按钮恢复箭头图标与文字，用户靠右、助手靠左', async () => {
    const info = await page(() =>
      ['user1', 'answer1'].map((id) => {
        const button = window.qa.button(id)
        const rect = button.getBoundingClientRect()
        const parent = button.parentElement.getBoundingClientRect()
        return {
          id,
          svg: Boolean(button.querySelector('svg')),
          label: button.textContent.trim(),
          leftGap: rect.left - parent.left,
          rightGap: parent.right - rect.right,
        }
      }),
    )
    assert.equal(info[0].svg, true)
    assert.equal(info[1].svg, true)
    assert.match(info[0].label, /展开我的输入/)
    assert.match(info[1].label, /展开全文/)
    assert.ok(Math.abs(info[0].rightGap) <= 1, JSON.stringify(info))
    assert.ok(Math.abs(info[1].leftGap) <= 1, JSON.stringify(info))
    return info
  })
  await check('默认最新一轮双方保持展开', async () => {
    const state = await page(() => ['user3', 'answer3'].map(window.qa.message))
    for (const item of state) {
      assert.equal(item.expanded, 'true')
      assert.equal(item.sourceVisible, true)
      assert.equal(item.textLines, 12)
    }
  })
  await screenshot('rewrite-default.png')
  await check('空闲时 DOM 与图片预览保持稳定，没有后台循环重绘', async () => {
    const info = await page(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
      const preview = window.qa.preview('answer2')
      const image = preview?.querySelector('img')
      let writes = 0
      const observer = new MutationObserver((records) => {
        writes += records.length
      })
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true,
      })
      await new Promise((resolve) => setTimeout(resolve, 500))
      observer.disconnect()
      return {
        writes,
        samePreview: preview === window.qa.preview('answer2'),
        sameImage: image === window.qa.preview('answer2')?.querySelector('img'),
      }
    })
    assert.ok(info.writes <= 6, JSON.stringify(info))
    assert.equal(info.samePreview, true)
    assert.equal(info.sameImage, true)
    return info
  })
  await check('最新轮保持展开可关闭', async () => {
    await update({ keepLatestOpen: false })
    for (const item of await page(() =>
      ['user3', 'answer3'].map(window.qa.message),
    )) {
      assert.equal(item.expanded, 'false')
      assert.equal(item.textLines, 3)
    }
  })
  await check('全部消息都折叠优先于保持最新轮展开', async () => {
    await update({ keepLatestOpen: true, collapseAll: true })
    for (const item of await page(() =>
      ['user3', 'answer3'].map(window.qa.message),
    ))
      assert.equal(item.expanded, 'false')
  })
  await check('滚轮经过正文与胶囊均不会展开', async () => {
    await page(() => {
      const row = window.qa.row('answer1')
      row.scrollIntoView({ block: 'center' })
      for (const target of [
        window.qa.preview('answer1'),
        window.qa.button('answer1'),
      ])
        target.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: 160,
            bubbles: true,
            cancelable: true,
          }),
        )
    })
    await settle()
    assert.equal(
      (await page(() => window.qa.message('answer1'))).expanded,
      'false',
    )
  })
  await check('点击展开保持消息顶部和视口稳定，收起恢复三行正文', async () => {
    await page(() => {
      const button = window.qa.button('answer1')
      document.getElementById('scroll').scrollTop +=
        button.getBoundingClientRect().top -
        document.getElementById('scroll').getBoundingClientRect().top -
        180
    })
    await settle()
    const before = await page(() => ({
      top: window.qa.row('answer1').getBoundingClientRect().top,
      scroll: document.getElementById('scroll').scrollTop,
    }))
    await clickMessage('answer1')
    const open = await page(() => ({
      ...window.qa.message('answer1'),
      top: window.qa.row('answer1').getBoundingClientRect().top,
      scroll: document.getElementById('scroll').scrollTop,
    }))
    assert.equal(open.expanded, 'true')
    assert.ok(
      Math.abs(open.top - before.top) <= 2,
      JSON.stringify({ before, open }),
    )
    assert.ok(Math.abs(open.scroll - before.scroll) <= 2)
    await clickMessage('answer1')
    const closed = await page(() => ({
      ...window.qa.message('answer1'),
      top: window.qa.row('answer1').getBoundingClientRect().top,
      scroll: document.getElementById('scroll').scrollTop,
    }))
    assert.equal(closed.expanded, 'false')
    assert.equal(closed.textLines, 3)
    return { before: before.top, open: open.top, closed: closed.top }
  })
  await check('长回复读到底部后收起保留按钮位置，展开保持原视口', async () => {
    const original = await page(
      () => document.getElementById('answer1').textContent,
    )
    try {
      await page(() => {
        document.getElementById('answer1').textContent = window.fixture.lines(
          '长回复',
          90,
        )
      })
      await settle()
      const beforeOpen = await page(
        () => document.getElementById('scroll').scrollTop,
      )
      await clickMessage('answer1')
      assert.ok(
        Math.abs(
          (await page(() => document.getElementById('scroll').scrollTop)) -
            beforeOpen,
        ) <= 2,
      )
      await page(() => {
        const root = document.getElementById('scroll')
        root.scrollTop +=
          window.qa.button('answer1').getBoundingClientRect().top -
          root.getBoundingClientRect().top -
          160
      })
      await settle()
      const beforeClose = await page(() => ({
        buttonTop: window.qa.button('answer1').getBoundingClientRect().top,
        scroll: document.getElementById('scroll').scrollTop,
      }))
      assert.ok(beforeClose.scroll > 1500, JSON.stringify(beforeClose))
      await clickMessage('answer1')
      const closed = await page(() => ({
        buttonTop: window.qa.button('answer1').getBoundingClientRect().top,
        rootBottom: document.getElementById('scroll').getBoundingClientRect()
          .bottom,
        expanded: window.qa.message('answer1').expanded,
      }))
      assert.equal(closed.expanded, 'false')
      assert.ok(
        Math.abs(closed.buttonTop - beforeClose.buttonTop) <= 2,
        JSON.stringify({ beforeClose, closed }),
      )
      assert.ok(closed.buttonTop < closed.rootBottom)
      return { before: beforeClose.buttonTop, after: closed.buttonTop }
    } finally {
      await page((text) => {
        document.getElementById('answer1').textContent = text
      }, original)
      await update({ collapseAll: true })
    }
  })
  await check('通过 br 换行的 HTML 正文折叠后仍显示三行', async () => {
    const original = await page(
      () => document.getElementById('answer1').innerHTML,
    )
    try {
      await page(() => {
        document.getElementById('answer1').innerHTML = Array.from(
          { length: 12 },
          (_, index) => `第${index + 1}行`,
        ).join('<br>')
      })
      await settle()
      const info = await page(() => ({
        ...window.qa.message('answer1'),
        breaks: window.qa.preview('answer1').querySelectorAll('br').length,
      }))
      assert.equal(info.textLines, 3)
      assert.ok(info.breaks >= 2)
      assert.match(info.label, /还有\s*9\s*行/)
      return { lines: info.textLines, breaks: info.breaks, label: info.label }
    } finally {
      await page((html) => {
        document.getElementById('answer1').innerHTML = html
      }, original)
      await settle()
    }
  })
  await check(
    '图片不占文本行预算且完整显示，picture 的 source 被保留',
    async () => {
      const info = await page(() => {
        const message = window.qa.message('answer2')
        const preview = window.qa.preview('answer2')
        const image = preview?.querySelector('img')
        const bounds = image?.getBoundingClientRect()
        const outer = preview?.getBoundingClientRect()
        return {
          ...message,
          images: preview?.querySelectorAll('img').length,
          pictures: preview?.querySelectorAll('picture').length,
          sources: preview?.querySelectorAll('picture > source').length,
          sameSource:
            preview?.querySelector('source')?.getAttribute('srcset') ===
            document
              .getElementById('answer2')
              .querySelector('source')
              ?.getAttribute('srcset'),
          imageWidth: bounds?.width,
          imageHeight: bounds?.height,
          contains:
            bounds &&
            outer &&
            bounds.top >= outer.top - 1 &&
            bounds.bottom <= outer.bottom + 1,
        }
      })
      assert.equal(info.textLines, 3)
      assert.equal(info.images, 1)
      assert.equal(info.pictures, 1)
      assert.equal(info.sources, 1)
      assert.equal(info.sameSource, true)
      assert.ok(Math.abs(info.imageHeight - 140) < 2)
      assert.equal(info.contains, true)
      assert.match(info.label, /还有\s*9\s*行/)
      await page(() =>
        window.qa.preview('answer2').scrollIntoView({ block: 'center' }),
      )
      await settle()
      await screenshot('rewrite-image.png')
      return {
        lines: info.textLines,
        imageHeight: info.imageHeight,
        label: info.label,
      }
    },
  )
  await check('折叠预览中的图片点击能调用宿主原图交互', async () => {
    await page(() => window.qa.preview('answer2').querySelector('img').click())
    await settle()
    const info = await page(() => ({
      clicks: window.fixture.imageClicks,
      sourceVisible: window.qa.message('answer2').sourceVisible,
      originalImages: document.getElementById('answer2').querySelectorAll('img')
        .length,
    }))
    assert.deepEqual(info, {
      clicks: 1,
      sourceVisible: true,
      originalImages: 1,
    })
    await clickMessage('answer2')
  })
  await check(
    '含 iframe 和 video 的正文保留原组件，不复制嵌入页面或播放器',
    async () => {
      try {
        await page(() => {
          const source = document.getElementById('answer3')
          window.fixture.liveFrame = document.createElement('iframe')
          window.fixture.liveFrame.srcdoc = '<p>原嵌入页面</p>'
          window.fixture.liveVideo = document.createElement('video')
          window.fixture.liveVideo.controls = true
          source.append(window.fixture.liveFrame, window.fixture.liveVideo)
        })
        await settle()
        const info = await page(() => ({
          sourceVisible: window.qa.message('answer3').sourceVisible,
          frameCount: window.qa.row('answer3').querySelectorAll('iframe')
            .length,
          videoCount: window.qa.row('answer3').querySelectorAll('video').length,
          sameFrame:
            document.getElementById('answer3').querySelector('iframe') ===
            window.fixture.liveFrame,
          sameVideo:
            document.getElementById('answer3').querySelector('video') ===
            window.fixture.liveVideo,
          preview: Boolean(window.qa.preview('answer3')),
        }))
        assert.deepEqual(info, {
          sourceVisible: true,
          frameCount: 1,
          videoCount: 1,
          sameFrame: true,
          sameVideo: true,
          preview: false,
        })
      } finally {
        await page(() => {
          window.fixture.liveFrame?.remove()
          window.fixture.liveVideo?.remove()
        })
        await settle()
      }
    },
  )
  await check('分组步骤与内联步骤默认折叠，每轮默认仅一个按钮', async () => {
    const info = await page(() => ({
      group: window.qa.visible(document.getElementById('groupStep1')),
      inline: window.qa.visible(document.getElementById('inlineStep1')),
      counts: [1, 2].map((turn) => window.qa.stepButtons(turn).length),
      middle: window.qa.visible(document.getElementById('middle2')),
    }))
    assert.equal(info.group, false)
    assert.equal(info.inline, false)
    assert.deepEqual(info.counts, [1, 1])
    assert.equal(info.middle, true)
    return info
  })
  await check('默认步骤按钮恢复 26px 圆形图标并保留无障碍说明', async () => {
    const states = await page(() => [1, 2].map(window.qa.stepState))
    for (const state of states) {
      assert.equal(state.buttons.length, 1)
      const [button] = state.buttons
      assert.equal(button.kind, 'all')
      assert.equal(button.text, '')
      assert.ok(button.label?.trim(), JSON.stringify(button))
      assert.ok(button.svg, JSON.stringify(button))
      assert.ok(Math.abs(button.width - 26) < 0.5, JSON.stringify(button))
      assert.ok(Math.abs(button.height - 26) < 0.5, JSON.stringify(button))
    }
    return states
  })
  await check('合并按钮先展开各段控制条，保持步骤内容收起', async () => {
    await page(() => window.qa.stepButtons(2)[0].click())
    await settle()
    const state = await page(() => window.qa.stepState(2))
    assert.equal(state.lines, 2)
    assert.deepEqual(
      state.buttons.map((button) => button.kind),
      ['single', 'single', 'all', 'every'],
    )
    assert.deepEqual(state.content, [false, false, false])
    return state
  })
  await check('每段控制条只展开或收起自己的步骤块', async () => {
    await page(() =>
      window.qa
        .stepButtons(2)
        .find((button) => button.hasAttribute('data-lf-step-toggle'))
        .click(),
    )
    await settle()
    const opened = await page(() => window.qa.stepState(2))
    assert.equal(opened.lines, 2)
    assert.deepEqual(opened.content, [true, false, false])
    assert.equal(opened.buttons[0].expanded, 'true')
    assert.equal(opened.buttons[1].expanded, 'false')
    await page(() =>
      window.qa.stepLines(2)[0].scrollIntoView({ block: 'center' }),
    )
    await settle()
    await screenshot('legacy-step-controls-spread.png')
    await page(() => window.qa.stepButtons(2)[0].click())
    await settle()
    assert.deepEqual((await page(() => window.qa.stepState(2))).content, [
      false,
      false,
      false,
    ])
  })
  await check('展开全部内容与收起全部内容保留各段控制条', async () => {
    await page(() =>
      window.qa
        .stepButtons(2)
        .find((button) => button.hasAttribute('data-lf-step-every'))
        .click(),
    )
    await settle()
    const opened = await page(() => window.qa.stepState(2))
    assert.equal(opened.lines, 2)
    assert.deepEqual(opened.content, [true, true, true])
    await page(() =>
      window.qa
        .stepButtons(2)
        .find((button) => button.hasAttribute('data-lf-step-every'))
        .click(),
    )
    await settle()
    const closed = await page(() => window.qa.stepState(2))
    assert.equal(closed.lines, 2)
    assert.deepEqual(closed.content, [false, false, false])
  })
  await check('收起控制条会关闭全部内容并重新合并为一个按钮', async () => {
    await page(() => {
      window.qa
        .stepButtons(2)
        .find((button) => button.hasAttribute('data-lf-step-every'))
        .click()
    })
    await settle()
    await page(() =>
      window.qa
        .stepButtons(2)
        .find((button) => button.hasAttribute('data-lf-step-all'))
        .click(),
    )
    await settle()
    const state = await page(() => window.qa.stepState(2))
    assert.equal(state.lines, 1)
    assert.deepEqual(
      state.buttons.map((button) => button.kind),
      ['all'],
    )
    assert.deepEqual(state.content, [false, false, false])
  })
  await check('关闭默认合并后每段控制条可见，并保留各自内容状态', async () => {
    await update({ mergeByDefault: false })
    const state = await page(() => window.qa.stepState(2))
    assert.equal(state.lines, 2)
    assert.deepEqual(state.content, [false, false, false])
    assert.deepEqual(
      state.buttons.map((button) => button.kind),
      ['single', 'single', 'all', 'every'],
    )
    await update({ mergeByDefault: true })
  })
  await check('无文字模式恢复 26px 圆形按钮和三种独立 SVG 图标', async () => {
    await update({ stepLabels: false })
    await page(() => window.qa.stepButtons(2)[0].click())
    await settle()
    const state = await page(() => window.qa.stepState(2))
    assert.equal(state.lines, 2)
    const icons = new Set()
    for (const button of state.buttons) {
      assert.equal(button.text, '')
      assert.ok(button.label?.trim(), JSON.stringify(button))
      assert.ok(button.svg, JSON.stringify(button))
      assert.ok(Math.abs(button.width - 26) < 0.5, JSON.stringify(button))
      assert.ok(Math.abs(button.height - 26) < 0.5, JSON.stringify(button))
      icons.add(button.svg)
    }
    assert.equal(icons.size, 3)
    await page(() =>
      window.qa
        .stepButtons(2)
        .find((button) => button.hasAttribute('data-lf-step-all'))
        .click(),
    )
    await settle()
  })
  await check('启用文字说明后步骤按钮显示 SVG 与 24px 胶囊', async () => {
    await update({ stepLabels: true })
    await page(() => window.qa.stepButtons(2)[0].click())
    await settle()
    const state = await page(() => window.qa.stepState(2))
    for (const button of state.buttons) {
      assert.ok(button.text, JSON.stringify(button))
      assert.ok(button.svg, JSON.stringify(button))
      assert.ok(Math.abs(button.height - 24) < 0.5, JSON.stringify(button))
      assert.ok(button.width > 26, JSON.stringify(button))
    }
    await page(() =>
      window.qa
        .stepButtons(2)
        .find((button) => button.hasAttribute('data-lf-step-all'))
        .click(),
    )
    await settle()
    await update({ stepLabels: false })
  })
  await check('只有一个步骤块时按钮直接展开内容，再点直接收起', async () => {
    const initial = await page(() => window.qa.stepState(1))
    assert.deepEqual(
      initial.buttons.map((button) => button.kind),
      ['all'],
    )
    assert.deepEqual(initial.content, [false])
    await page(() => window.qa.stepButtons(1)[0].click())
    await settle()
    const opened = await page(() => window.qa.stepState(1))
    assert.equal(opened.lines, 1)
    assert.deepEqual(
      opened.buttons.map((button) => button.kind),
      ['all'],
    )
    assert.deepEqual(opened.content, [true])
    await page(() => window.qa.stepButtons(1)[0].click())
    await settle()
    assert.deepEqual((await page(() => window.qa.stepState(1))).content, [
      false,
    ])
  })
  await check(
    '单段已展开后追加或插入步骤块，保留阅读状态并按正文顺序显示控制条',
    async () => {
      try {
        await page(() => {
          const host = document.createElement('div')
          host.id = 'lateStepCase'
          host.innerHTML =
            '<div id="lateStepFirst" class="flowItem member" data-chat-flow-kind="tool-call" data-chat-turn="88" data-chat-anchor-key="late:88:first" data-turn-process-member>原有步骤</div>' +
            '<div class="flowItem" data-chat-flow-kind="assistant-step" data-chat-turn="88" data-chat-anchor-key="late:88:middle"><div class="mdRoot"><div class="mdBody">原有中间说明</div></div></div>'
          document.getElementById('conversation').append(host)
        })
        await settle()
        assert.equal(await page(() => window.qa.stepLines(88).length), 1)
        await page(() => window.qa.stepButtons(88)[0].click())
        await settle()
        assert.equal(
          await page(() =>
            window.qa.visible(document.getElementById('lateStepFirst')),
          ),
          true,
        )
        await page(() => {
          document
            .getElementById('lateStepCase')
            .insertAdjacentHTML(
              'beforeend',
              '<div id="lateStepSecond" class="flowItem member" data-chat-flow-kind="tool-call" data-chat-turn="88" data-chat-anchor-key="late:88:second" data-turn-process-member>后续步骤</div>' +
                '<div class="flowItem" data-chat-flow-kind="assistant-step" data-chat-turn="88" data-chat-anchor-key="late:88:answer"><div class="mdRoot"><div class="mdBody">后续回复</div></div></div>',
            )
        })
        await settle()
        const appended = await page(() => ({
          previous: window.qa
            .stepLines(88)
            .map((line) => line.previousElementSibling.id),
          content: ['lateStepFirst', 'lateStepSecond'].map((id) =>
            window.qa.visible(document.getElementById(id)),
          ),
        }))
        assert.deepEqual(appended.previous, ['lateStepFirst', 'lateStepSecond'])
        assert.deepEqual(appended.content, [true, false])
        await page(() => {
          document
            .getElementById('lateStepCase')
            .insertAdjacentHTML(
              'afterbegin',
              '<div id="lateStepEarlier" class="flowItem member" data-chat-flow-kind="tool-call" data-chat-turn="88" data-chat-anchor-key="late:88:earlier" data-turn-process-member>补入的早期步骤</div>' +
                '<div class="flowItem" data-chat-flow-kind="assistant-step" data-chat-turn="88" data-chat-anchor-key="late:88:early-answer"><div class="mdRoot"><div class="mdBody">早期中间说明</div></div></div>',
            )
        })
        await settle()
        const inserted = await page(() => ({
          previous: window.qa
            .stepLines(88)
            .map((line) => line.previousElementSibling.id),
          content: ['lateStepEarlier', 'lateStepFirst', 'lateStepSecond'].map(
            (id) => window.qa.visible(document.getElementById(id)),
          ),
          allAt: window.qa
            .stepButtons(88)
            .find((button) => button.hasAttribute('data-lf-step-all'))
            .closest('[data-lf-step-line]').previousElementSibling.id,
        }))
        assert.deepEqual(inserted.previous, [
          'lateStepEarlier',
          'lateStepFirst',
          'lateStepSecond',
        ])
        assert.deepEqual(inserted.content, [false, true, false])
        assert.equal(inserted.allAt, 'lateStepSecond')
        await page(() =>
          window.qa
            .stepButtons(88)
            .find((button) => button.hasAttribute('data-lf-step-all'))
            .click(),
        )
        await settle()
        assert.deepEqual(
          await page(() => ({
            previous: window.qa
              .stepLines(88)
              .map((line) => line.previousElementSibling.id),
            content: ['lateStepEarlier', 'lateStepFirst', 'lateStepSecond'].map(
              (id) => window.qa.visible(document.getElementById(id)),
            ),
          })),
          { previous: ['lateStepSecond'], content: [false, false, false] },
        )
        return { appended, inserted }
      } finally {
        await page(() => document.getElementById('lateStepCase')?.remove())
        await settle()
      }
    },
  )
  await check(
    '展开步骤组不会展开内层工具详情，手动关闭详情后扫描仍保持',
    async () => {
      await page(() => {
        const header = document.querySelector('.groupHeader')
        if (header.getAttribute('aria-expanded') === 'true') header.click()
        window.qa.stepButtons(1)[0].click()
      })
      await settle()
      const opened = await page(() => ({
        group: document
          .querySelector('.groupHeader')
          .getAttribute('aria-expanded'),
        detail: document
          .getElementById('toolDetailButton')
          .getAttribute('aria-expanded'),
        detailVisible: window.qa.visible(
          document.getElementById('toolDetailBody'),
        ),
      }))
      assert.deepEqual(opened, {
        group: 'true',
        detail: 'false',
        detailVisible: false,
      })
      await page(() => {
        const detail = document.getElementById('toolDetailButton')
        detail.click()
        detail.click()
        window.controller.scan()
      })
      await settle()
      assert.equal(
        await page(() =>
          document
            .getElementById('toolDetailButton')
            .getAttribute('aria-expanded'),
        ),
        'false',
      )
      await page(() => window.qa.stepButtons(1)[0].click())
      await settle()
    },
  )
  await check(
    '步骤成员转换为最终回复后清理旧折叠标记并显示正文胶囊',
    async () => {
      try {
        await page(() => {
          const row = document.createElement('div')
          row.className = 'flowItem'
          row.id = 'transitionRow'
          row.dataset.chatFlowKind = 'assistant-step'
          row.dataset.chatTurn = '2'
          row.dataset.chatAnchorKey = 'transition:2'
          row.setAttribute('data-turn-process-member', '')
          row.setAttribute('data-turn-process-hidden', '')
          row.innerHTML =
            '<div class="mdRoot"><div class="mdBody" id="transitionBody"></div></div>'
          row.querySelector('.mdBody').textContent = window.fixture.lines(
            '转换回复',
            12,
          )
          window.qa.row('answer2').before(row)
        })
        await settle()
        assert.equal(
          await page(() =>
            document
              .getElementById('transitionRow')
              .getAttribute('data-lf-step-folded'),
          ),
          'collapsed',
        )
        await page(() => {
          const row = document.getElementById('transitionRow')
          row.removeAttribute('data-turn-process-member')
          row.removeAttribute('data-turn-process-hidden')
          row.setAttribute('data-turn-process-answer', '')
        })
        await settle()
        const info = await page(() => ({
          foldedMark: document
            .getElementById('transitionRow')
            .getAttribute('data-lf-step-folded'),
          hidden: document
            .getElementById('transitionRow')
            .getAttribute('hidden'),
          button: Boolean(window.qa.button('transitionBody')),
          previewVisible: window.qa.message('transitionBody').previewVisible,
        }))
        assert.deepEqual(info, {
          foldedMark: null,
          hidden: null,
          button: true,
          previewVisible: true,
        })
      } finally {
        await page(() => document.getElementById('transitionRow')?.remove())
        await settle()
      }
    },
  )
  await check('搜索包含已折叠的双方正文、分组步骤及内联步骤', async () => {
    const counts = await page(() =>
      Object.fromEntries(
        [
          'USER_HIDDEN_NEEDLE',
          'ANSWER_HIDDEN_NEEDLE',
          'IMAGE_HIDDEN_NEEDLE',
          'GROUP_HIDDEN_NEEDLE',
          'INLINE_HIDDEN_NEEDLE',
          'SHARED_MATCH',
        ].map((query) => [query, window.controller.search(query).length]),
      ),
    )
    assert.deepEqual(counts, {
      USER_HIDDEN_NEEDLE: 1,
      ANSWER_HIDDEN_NEEDLE: 1,
      IMAGE_HIDDEN_NEEDLE: 1,
      GROUP_HIDDEN_NEEDLE: 1,
      INLINE_HIDDEN_NEEDLE: 1,
      SHARED_MATCH: 2,
    })
    return counts
  })
  await check('点击正文搜索结果会展开并定位匹配文字', async () => {
    const info = await page(async () => {
      const hit = window.controller.search('ANSWER_HIDDEN_NEEDLE')[0]
      await window.controller.revealAt(hit)
      await new Promise((resolve) => setTimeout(resolve, 140))
      const range = [...(CSS.highlights.get('dsh-fold-match') || [])][0]
      const rect = range?.getBoundingClientRect()
      const scroll = document.getElementById('scroll').getBoundingClientRect()
      return {
        ...window.qa.message('answer1'),
        matchText: range?.toString(),
        matchVisible: Boolean(
          rect && rect.top >= scroll.top && rect.bottom <= scroll.bottom,
        ),
      }
    })
    assert.equal(info.expanded, 'true')
    assert.equal(info.matchText, 'ANSWER_HIDDEN_NEEDLE')
    assert.equal(info.matchVisible, true)
  })
  await check('点击步骤搜索结果会展开对应分组并定位', async () => {
    const info = await page(async () => {
      await window.controller.revealAt(
        window.controller.search('GROUP_HIDDEN_NEEDLE')[0],
      )
      await new Promise((resolve) => setTimeout(resolve, 130))
      const rect = document.getElementById('groupStep1').getBoundingClientRect()
      const scroll = document.getElementById('scroll').getBoundingClientRect()
      return {
        visible: window.qa.visible(document.getElementById('groupStep1')),
        matchText: [
          ...(CSS.highlights.get('dsh-fold-match') || []),
        ][0]?.toString(),
        inScroll: rect.top >= scroll.top && rect.bottom <= scroll.bottom,
      }
    })
    assert.equal(info.visible, true)
    assert.equal(info.matchText, 'GROUP_HIDDEN_NEEDLE')
    assert.equal(info.inScroll, true)
  })
  await check(
    '查找合并步骤会展开相应控制条和命中内容，扫描后状态不变',
    async () => {
      const before = await page(() => window.qa.stepState(2))
      assert.equal(before.lines, 1)
      assert.deepEqual(before.content, [false, false, false])
      const info = await page(async () => {
        await window.controller.revealAt(
          window.controller.search('INLINE_HIDDEN_NEEDLE')[0],
        )
        await new Promise((resolve) => setTimeout(resolve, 130))
        const initial = window.qa.stepState(2)
        window.controller.scan()
        await new Promise((resolve) => setTimeout(resolve, 130))
        window.controller.scan()
        await new Promise((resolve) => setTimeout(resolve, 130))
        const result = window.qa.stepState(2)
        const rect = document
          .getElementById('inlineStep1')
          .getBoundingClientRect()
        const scroll = document.getElementById('scroll').getBoundingClientRect()
        return {
          initial,
          result,
          matchText: [
            ...(CSS.highlights.get('dsh-fold-match') || []),
          ][0]?.toString(),
          inScroll: rect.top >= scroll.top && rect.bottom <= scroll.bottom,
        }
      })
      assert.equal(info.initial.lines, 2)
      assert.deepEqual(info.initial.content, [true, false, false])
      assert.deepEqual(info.result.content, [true, false, false])
      assert.equal(info.result.lines, 2)
      assert.deepEqual(
        info.result.buttons.map((button) => button.kind),
        ['single', 'single', 'all', 'every'],
      )
      assert.equal(info.result.buttons[0].expanded, 'true')
      assert.equal(info.result.buttons[1].expanded, 'false')
      assert.equal(info.matchText, 'INLINE_HIDDEN_NEEDLE')
      assert.equal(info.inScroll, true)
      return info
    },
  )
  await check(
    '浏览器查找隐藏步骤也会展开对应控制条，且不打开其他步骤块',
    async () => {
      await page(() =>
        window.qa
          .stepButtons(2)
          .find((button) => button.hasAttribute('data-lf-step-all'))
          .click(),
      )
      await settle()
      assert.equal((await page(() => window.qa.stepState(2))).lines, 1)
      await page(() =>
        document
          .getElementById('inlineStep2')
          .dispatchEvent(new Event('beforematch', { bubbles: true })),
      )
      await settle()
      await page(() => window.controller.scan())
      await settle()
      const state = await page(() => window.qa.stepState(2))
      assert.equal(state.lines, 2)
      assert.deepEqual(state.content, [false, true, true])
      assert.equal(state.buttons[0].expanded, 'false')
      assert.equal(state.buttons[1].expanded, 'true')
      return state
    },
  )
  await check('同长编辑更新折叠预览与搜索索引', async () => {
    await page(() => {
      const source = document.getElementById('user2')
      source.textContent = source.textContent.replace('用户输入', '全新文字')
    })
    await settle()
    const info = await page(() => ({
      message: window.qa.message('user2'),
      matches: window.controller.search('全新文字').length,
    }))
    assert.ok(info.message.previewText.startsWith('全新文字'))
    assert.equal(info.matches, 1)
  })
  await check('流式追加后余行数与搜索索引随正文更新', async () => {
    const before = await page(() => document.getElementById('scroll').scrollTop)
    await page(() => {
      document
        .getElementById('user2')
        .append(document.createTextNode('\n新流文'))
    })
    await settle()
    const info = await page(() => ({
      message: window.qa.message('user2'),
      matches: window.controller.search('新流文').length,
    }))
    assert.match(info.message.label, /还有\s*10\s*行/)
    assert.equal(info.matches, 1)
    assert.ok(
      Math.abs(
        (await page(() => document.getElementById('scroll').scrollTop)) -
          before,
      ) <= 2,
      '折叠正文追加导致视口跳动',
    )
  })
  await check('宿主替换正文节点后不会丢内容或重复按钮', async () => {
    await page(() => window.fixture.replaceAnswer('answer1'))
    await settle()
    const info = await page(() => ({
      text: document.getElementById('answer1').textContent,
      buttons: window.qa.row('answer1').querySelectorAll('[data-lf-toggle]')
        .length,
      hits: window.controller.search('ANSWER_HIDDEN_NEEDLE').length,
    }))
    assert.match(info.text, /ANSWER_HIDDEN_NEEDLE/)
    assert.equal(info.buttons, 1)
    assert.equal(info.hits, 1)
  })
  await check('新增轮次后前一最新轮按默认策略折叠', async () => {
    await update({ keepLatestOpen: true, collapseAll: false })
    await page(() => window.fixture.addTurn('4'))
    await settle()
    const info = await page(() =>
      ['answer3', 'answer4', 'user4'].map(window.qa.message),
    )
    assert.equal(info[0].expanded, 'false')
    assert.equal(info[1].expanded, 'true')
    assert.equal(info[2].expanded, 'true')
  })
  await check(
    '输入框手柄位于卡片顶部且不占布局高度，工具栏保持原生底部间距',
    async () => {
      const info = await page(() => window.qa.composer())
      assertComposerLayout(info)
      await screenshot('composer-top-default.png')
      return info
    },
  )
  await check('输入框高度 API 可设置并恢复默认', async () => {
    await page(() => window.controller.setHeight(240))
    await settle()
    const changed = await page(() => ({
      state: window.controller.composer(),
      height: document.getElementById('editorScroll').getBoundingClientRect()
        .height,
    }))
    assert.ok(changed.height >= 238, JSON.stringify(changed))
    assertComposerLayout(await page(() => window.qa.composer()))
    await page(() => window.controller.resetHeight())
    await settle()
    const height = await page(
      () =>
        document.getElementById('editorScroll').getBoundingClientRect().height,
    )
    assert.ok(height < 100, `default editor height=${height}`)
    assertComposerLayout(await page(() => window.qa.composer()))
  })
  await check('顶部手柄真实指针拖拽改变输入区高度且工具栏仍贴底', async () => {
    const position = await page(() => {
      const rect = document
        .querySelector('[data-lf-composer-handle]')
        .getBoundingClientRect()
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        height: document.getElementById('editorScroll').getBoundingClientRect()
          .height,
      }
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: position.x,
      y: position.y,
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: position.x,
      y: position.y,
      button: 'left',
      clickCount: 1,
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: position.x,
      y: position.y - 100,
      button: 'left',
      buttons: 1,
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: position.x,
      y: position.y - 100,
      button: 'left',
      clickCount: 1,
    })
    await settle()
    const height = await page(
      () =>
        document.getElementById('editorScroll').getBoundingClientRect().height,
    )
    assert.ok(
      height >= position.height + 80,
      JSON.stringify({ before: position.height, after: height }),
    )
    assertComposerLayout(await page(() => window.qa.composer()))
    await screenshot('composer-top-resized.png')
    return { before: position.height, after: height }
  })
  await check('双击顶部手柄恢复默认高度且工具栏仍贴底', async () => {
    await page(() =>
      document
        .querySelector('[data-lf-composer-handle]')
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    )
    await settle()
    assert.ok(
      await page(
        () =>
          document.getElementById('editorScroll').getBoundingClientRect()
            .height < 100,
      ),
    )
    assertComposerLayout(await page(() => window.qa.composer()))
  })
  await check('输入区高度选择在重载后保留', async () => {
    await page(() => window.controller.setHeight(216))
    await settle()
    await navigate(true)
    const height = await page(
      () =>
        document.getElementById('editorScroll').getBoundingClientRect().height,
    )
    assert.ok(Math.abs(height - 216) < 3, `height=${height}`)
    assertComposerLayout(await page(() => window.qa.composer()))
    return { height }
  })
  await check(
    '关闭输入区调整会移除手柄并恢复原生布局，重新开启仍无底部空白',
    async () => {
      await update({ composerResize: false })
      const disabled = await page(() => window.qa.composer())
      assertComposerLayout(disabled, false)
      assert.ok(disabled.editorHeight < 100, JSON.stringify(disabled))
      await update({ composerResize: true })
      const enabled = await page(() => window.qa.composer())
      assertComposerLayout(enabled)
      assert.ok(
        Math.abs(enabled.editorHeight - 216) < 3,
        JSON.stringify(enabled),
      )
      return { disabled, enabled }
    },
  )
  await check('计时每轮只显示一次并置于最终助手回复之后', async () => {
    await page(() =>
      window.fixture.turnTimers.set({ 1: 9100, 2: 12345, 3: 2300 }),
    )
    await settle()
    const chips = await page(() =>
      [...document.querySelectorAll('[data-lf-turn-timer]')].map((element) => ({
        text: element.textContent,
        turn: element
          .closest('[data-chat-turn]')
          ?.getAttribute('data-chat-turn'),
        answer: element
          .closest('[data-chat-anchor-key]')
          ?.getAttribute('data-chat-anchor-key'),
      })),
    )
    assert.equal(chips.length, 3)
    assert.equal(new Set(chips.map((chip) => chip.turn)).size, 3)
    assert.ok(
      chips.some((chip) => /本轮用时\s*12\.3\s*秒/.test(chip.text)),
      JSON.stringify(chips),
    )
    assert.deepEqual(
      chips.map((chip) => chip.answer),
      ['answer:1', 'answer:2', 'answer:3'],
    )
    return chips
  })
  await check('关闭消息折叠恢复双方原正文且移除预览', async () => {
    await update({ enabled: false })
    try {
      const state = await page(() =>
        ['user1', 'answer1', 'answer2'].map(window.qa.message),
      )
      for (const item of state) {
        assert.equal(item.sourceVisible, true)
        assert.equal(item.previewVisible, false)
      }
    } finally {
      await update({ enabled: true })
    }
  })
  await check('右侧栏比例会改变真实布局宽度', async () => {
    await page(async () => {
      await window.fixture.startRightbar()
      window.fixture.rightbar.setRatio(40)
    })
    await settle()
    const size = await page(() => ({
      frame: document.getElementById('app').getBoundingClientRect().width,
      rightbar: document.getElementById('rightbar').getBoundingClientRect()
        .width,
      main: document.getElementById('main').getBoundingClientRect().width,
    }))
    assert.ok(
      Math.abs(size.rightbar - size.frame * 0.4) < 2,
      JSON.stringify(size),
    )
    assert.ok(size.main > 0)
    return size
  })
  await check(
    '右栏宽度变化后预览保持三行，并按真实换行重新统计余行',
    async () => {
      const original = await page(
        () => document.getElementById('answer1').textContent,
      )
      try {
        await page(() => {
          document.getElementById('answer1').textContent = Array.from(
            { length: 12 },
            (_, index) =>
              `第${index + 1}段：右侧栏宽度调整以后，正文应按照当前可用宽度重新换行，并准确统计余下的行数。`.repeat(
                2,
              ),
          ).join('\n')
        })
        await settle()
        const before = await page(() => window.qa.message('answer1'))
        await page(() => window.fixture.rightbar.setRatio(65))
        await settle()
        const after = await page(() => window.qa.message('answer1'))
        assert.equal(before.textLines, 3)
        assert.equal(after.textLines, 3)
        const remainingBefore = Number(
          before.label.match(/还有\s*(\d+)\s*行/)[1],
        )
        const remainingAfter = Number(after.label.match(/还有\s*(\d+)\s*行/)[1])
        assert.ok(
          remainingAfter > remainingBefore,
          JSON.stringify({ remainingBefore, remainingAfter }),
        )
        await clickMessage('answer1')
        const actual = await page(() => window.qa.message('answer1').textLines)
        assert.equal(remainingAfter, actual - 3)
        return {
          before: remainingBefore,
          after: remainingAfter,
          naturalLines: actual,
        }
      } finally {
        await page((text) => {
          document.getElementById('answer1').textContent = text
          window.fixture.rightbar.setRatio(40)
        }, original)
        await settle()
      }
    },
  )
  await check('关闭右侧栏后主区域回弹，再打开恢复已选比例', async () => {
    await page(() => window.fixture.closeRightbar())
    await settle()
    const closed = await page(() => ({
      main: document.getElementById('main').getBoundingClientRect().width,
      frame: document.getElementById('app').getBoundingClientRect().width,
      rule: document.getElementById('app').getAttribute('data-lf-frame'),
    }))
    assert.ok(Math.abs(closed.main - closed.frame) < 2, JSON.stringify(closed))
    assert.equal(closed.rule, null)
    await page(() => window.fixture.openRightbar())
    await settle()
    const reopened = await page(() => ({
      rightbar: document.getElementById('rightbar').getBoundingClientRect()
        .width,
      frame: document.getElementById('app').getBoundingClientRect().width,
    }))
    assert.ok(
      Math.abs(reopened.rightbar - reopened.frame * 0.4) < 2,
      JSON.stringify(reopened),
    )
    return { closed, reopened }
  })
  await check(
    '宿主手动改变右栏宽度后设置同步，dispose 恢复宿主宽度',
    async () => {
      await page(() =>
        window.fixture.manualRightbarWidth(
          Math.round(
            document.getElementById('app').getBoundingClientRect().width * 0.35,
          ),
        ),
      )
      await settle()
      const ratio = await page(() => window.controller.settings().rightbarRatio)
      assert.equal(ratio, 35)
      await page(() => window.fixture.rightbar.dispose())
      await settle()
      const info = await page(() => ({
        width: document.getElementById('rightbar').getBoundingClientRect()
          .width,
        mark: document.getElementById('app').getAttribute('data-lf-frame'),
        rule: Boolean(document.getElementById('dsh-bubble-fold-frame')),
      }))
      assert.equal(info.width, 300)
      assert.equal(info.mark, null)
      assert.equal(info.rule, false)
    },
  )
  await screenshot('rewrite-final.png')
  await check(
    'dispose 恢复宿主正文、步骤、输入区并清除所有插件控件',
    async () => {
      const info = await page(() => {
        window.controller.dispose()
        return {
          residual: document.querySelectorAll(
            '[data-lf-preview],[data-lf-toggle],[data-lf-step-line],[data-lf-composer-handle],[data-lf-turn-timer]',
          ).length,
          messages: ['user1', 'answer1', 'answer2'].map((id) =>
            window.qa.visible(document.getElementById(id)),
          ),
          steps: ['groupStep1', 'inlineStep1', 'inlineStep2'].map((id) =>
            window.qa.visible(document.getElementById(id)),
          ),
          composerStyle:
            document.getElementById('composerSeat').style.cssText || null,
          originalComposerStyle: window.fixture.originalComposerStyle,
          composerLayout: window.qa.composer(),
          searchContentRetained: document
            .getElementById('answer1')
            .textContent.includes('ANSWER_HIDDEN_NEEDLE'),
        }
      })
      assert.equal(info.residual, 0)
      assert.deepEqual(info.messages, [true, true, true])
      assert.deepEqual(info.steps, [true, true, true])
      assert.equal(info.composerStyle, info.originalComposerStyle)
      assertComposerLayout(info.composerLayout, false)
      assert.ok(info.composerLayout.editorHeight < 100)
      assert.equal(info.searchContentRetained, true)
      return info
    },
  )
  await check('清理后重新启用不会重复初始化或丢失正文', async () => {
    await page(() => window.fixture.restart())
    await settle()
    const info = await page(() => ({
      buttons: window.qa.row('answer1').querySelectorAll('[data-lf-toggle]')
        .length,
      handles: document.querySelectorAll('[data-lf-composer-handle]').length,
      hits: window.controller.search('ANSWER_HIDDEN_NEEDLE').length,
    }))
    assert.deepEqual(info, { buttons: 1, handles: 1, hits: 1 })
  })
  await check(
    '实际 client.js 构建产物可从严格宿主入口启动、交互并完整清理',
    async () => {
      try {
        await page(async () => {
          window.controller.dispose()
          window.fixture.bundleSmoke = {
            requests: [],
            requires: [],
            mounts: 0,
            fibersDisposed: 0,
          }
          window.__ModuleLoader__ = {
            load(registration) {
              window.fixture.bundleRegistration = registration
            },
          }
          await new Promise((resolve, reject) => {
            const script = document.createElement('script')
            script.src = '../client.js?bundle-smoke=' + Date.now()
            script.onload = resolve
            script.onerror = () => reject(new Error('client.js failed to load'))
            document.head.appendChild(script)
          })
          const services = new Map()
          const ctx = {
            get(name) {
              if (!services.has(name))
                throw new Error('Unavailable host service: ' + name)
              return services.get(name)
            },
            inject(names, mount) {
              const available = names.every((name) => services.has(name))
              window.fixture.bundleSmoke.requests.push({ names, available })
              if (available) {
                window.fixture.bundleSmoke.mounts++
                mount(ctx)
              }
              return {
                dispose() {
                  window.fixture.bundleSmoke.fibersDisposed++
                },
              }
            },
          }
          const plugin = window.fixture.bundleRegistration.factory((name) => {
            window.fixture.bundleSmoke.requires.push(name)
            if (name === 'react') return { createElement: () => null }
            throw new Error('Unexpected platform module: ' + name)
          })
          window.fixture.bundleDispose = plugin.apply(ctx)
        })
        await settle()
        const boot = await page(() => ({
          status: window.__DSH_FOLD_POLISH__?.status,
          hits: window.__DSH_FOLD_POLISH__?.search('ANSWER_HIDDEN_NEEDLE')
            .length,
          expanded: window.qa.message('answer1').expanded,
          ...window.fixture.bundleSmoke,
        }))
        assert.equal(boot.status, 'running')
        assert.equal(boot.hits, 1)
        assert.equal(boot.expanded, 'false')
        assert.equal(boot.mounts, 0)
        assert.deepEqual(boot.requires, ['react'])
        assert.equal(boot.requests.length, 5)
        assert.ok(boot.requests.every((request) => !request.available))
        await clickMessage('answer1')
        assert.equal(
          await page(() => window.qa.message('answer1').expanded),
          'true',
        )
        await page(() => window.fixture.bundleDispose())
        await settle()
        const disposed = await page(() => ({
          handle: Boolean(window.__DSH_FOLD_POLISH__),
          controls: document.querySelectorAll(
            '[data-lf-preview],[data-lf-toggle],[data-lf-step-line],[data-lf-composer-handle]',
          ).length,
          sourceVisible: window.qa.visible(document.getElementById('answer1')),
          fibersDisposed: window.fixture.bundleSmoke.fibersDisposed,
        }))
        assert.deepEqual(disposed, {
          handle: false,
          controls: 0,
          sourceVisible: true,
          fibersDisposed: 5,
        })
        return {
          status: boot.status,
          optionalFeaturesWaiting: boot.requests.length,
          hiddenHits: boot.hits,
          cleanups: disposed.fibersDisposed,
        }
      } finally {
        await page(() => window.fixture.bundleDispose?.())
      }
    },
  )
  await check('宿主嵌套滚动布局中展开长步骤后输入框仍位于底部', async () => {
    await navigate(false, true)
    await page(() => {
      const step = document.getElementById('groupStep1')
      const lines = document.createElement('div')
      lines.id = 'hostLongSteps'
      lines.textContent = window.fixture.lines('工具步骤', 120)
      step.append(lines)
      window.controller.rescan()
    })
    await settle()
    await page(() => window.qa.stepButtons('1')[0].click())
    await settle()
    const info = await page(() => window.qa.hostDock())
    assert.ok(
      info.content.height > info.scroll.height * 3,
      JSON.stringify(info),
    )
    assertHostDock(info)
    await screenshot('composer-host-longsteps.png')
    return info
  })
  await check(
    '宿主滚动容器在流式追加及上中下三个位置均保持输入框贴底',
    async () => {
      await page(() => {
        const steps = document.getElementById('hostLongSteps')
        steps.textContent +=
          '\n' + window.fixture.lines('流式追加工具步骤', 100)
        window.controller.rescan()
      })
      await settle()
      const states = []
      for (const position of [0, 0.5, 1]) {
        await page((position) => {
          const scroll = document.getElementById('scroll')
          scroll.scrollTop =
            (scroll.scrollHeight - scroll.clientHeight) * position
        }, position)
        await settle()
        const info = await page(() => window.qa.hostDock())
        assertHostDock(info)
        states.push({
          position,
          top: info.seat.top,
          bottom: info.seat.bottom,
          scrollTop: info.scrollTop,
        })
      }
      return states
    },
  )
  await check(
    '宿主布局中展开与收起超长回复后输入框不会被正文顶到中间',
    async () => {
      await page(() => {
        document.getElementById('answer1').textContent = window.fixture.lines(
          '超长回复',
          160,
        )
        document.getElementById('scroll').scrollTop = 0
        window.controller.rescan()
      })
      await settle()
      const states = []
      for (const open of [true, false, true, false]) {
        await clickMessage('answer1')
        const info = await page(() => window.qa.hostDock())
        assertHostDock(info)
        assert.equal(
          await page(() => window.qa.message('answer1').expanded),
          String(open),
        )
        states.push({
          open,
          top: info.seat.top,
          bottom: info.seat.bottom,
          scrollHeight: info.scrollHeight,
        })
      }
      return states
    },
  )
  await check(
    '展开期间外层消息区暂时保留旧高度时，输入框仍贴底且不改动宿主节点',
    async () => {
      await page(() => {
        const view = document.getElementById('hostViewArea')
        window.fixture.dockNodes = {
          scroll: document.getElementById('scroll'),
          seat: document.getElementById('composerSeat'),
          conversation: document.getElementById('conversation'),
          seatParent: document.getElementById('composerSeat').parentNode,
        }
        view.style.cssText =
          'flex:none; height:160px; min-height:0; overflow:visible'
        document.getElementById('scroll').scrollTop = 0
      })
      try {
        await settle()
        await clickMessage('answer1')
        const info = await page(() => window.qa.hostDock())
        assert.ok(
          info.content.height > info.view.height * 5,
          JSON.stringify(info),
        )
        assertHostDock(info)
        assert.equal(info.scrollTop, 0)
        assert.equal(
          await page(() => {
            const nodes = window.fixture.dockNodes
            return (
              nodes.scroll === document.getElementById('scroll') &&
              nodes.seat === document.getElementById('composerSeat') &&
              nodes.conversation === document.getElementById('conversation') &&
              nodes.seat.parentNode === nodes.seatParent
            )
          }),
          true,
        )
        await screenshot('composer-host-expansion-stale-height.png')
        return info
      } finally {
        await page(() =>
          document.getElementById('hostViewArea').removeAttribute('style'),
        )
        await settle()
      }
    },
  )
  await check(
    '关闭拖拽仍保持底部定位，遮罩和非对话阶段交还原生布局',
    async () => {
      await update({ composerResize: false })
      assertHostDock(await page(() => window.qa.hostDock()))
      assert.equal(
        await page(
          () => document.querySelectorAll('[data-lf-composer-handle]').length,
        ),
        0,
      )
      await page(() => {
        const overlay = document.createElement('div')
        overlay.setAttribute('data-conversation-composer-overlay', '')
        document.getElementById('scroll').append(overlay)
      })
      await settle()
      const overlay = await page(() => {
        const seat = document.getElementById('composerSeat')
        return {
          position: getComputedStyle(seat).position,
          docked: seat.hasAttribute('data-lf-composer-docked'),
          inset: seat.style.getPropertyValue('--lf-composer-top'),
        }
      })
      assert.deepEqual(overlay, {
        position: 'absolute',
        docked: false,
        inset: '',
      })
      await page(() => {
        document.querySelector('[data-conversation-composer-overlay]').remove()
        document
          .getElementById('hostBody')
          .setAttribute('data-content-phase', 'hero')
        document.getElementById('main').setAttribute('data-phase', 'hero')
      })
      await settle()
      assert.equal(
        await page(() =>
          document
            .getElementById('composerSeat')
            .hasAttribute('data-lf-composer-docked'),
        ),
        false,
      )
      await page(() => {
        document
          .getElementById('hostBody')
          .setAttribute('data-content-phase', 'active')
        document.getElementById('main').setAttribute('data-phase', 'active')
        document.getElementById('scroll').scrollTop = 0
      })
      await settle()
      assertHostDock(await page(() => window.qa.hostDock()))
      await update({ composerResize: true })
      return overlay
    },
  )
  await check(
    '窗口缩小后已保存的较高输入区会适配可用高度并保留聊天区域',
    async () => {
      await page(() => window.controller.setHeight(700))
      await settle()
      try {
        await send('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 420,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await settle()
        const info = await page(() => window.qa.hostDock())
        assertHostDock(info, 64)
        assert.ok(info.actions.top >= info.scroll.top, JSON.stringify(info))
        return info
      } finally {
        await send('Emulation.clearDeviceMetricsOverride')
        await settle()
      }
    },
  )
  await check(
    '重载时过大的旧输入区高度会适配窗口，扩大窗口后恢复高度偏好',
    async () => {
      await page(() =>
        localStorage.setItem('dsh.bubble-fold.composer-height', '1400'),
      )
      await navigate(true, true)
      const info = await page(() => window.qa.hostDock())
      assertHostDock(info, 64)
      const value = await page(() =>
        localStorage.getItem('dsh.bubble-fold.composer-height'),
      )
      assert.equal(value, '1400')
      try {
        await send('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 1800,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await settle()
        const enlarged = await page(() => window.qa.hostDock())
        assertHostDock(enlarged, 64)
        assert.equal(enlarged.editor.height, 1400)
        return { initial: info, enlarged }
      } finally {
        await send('Emulation.clearDeviceMetricsOverride')
        await settle()
      }
    },
  )
  await check(
    '宿主输入区临时只读时展开回复和步骤仍保留底部定位及原有手柄',
    async () => {
      await navigate(false, true)
      await page(() => {
        window.fixture.readonlyComposerNodes = {
          card: document.getElementById('composerCard'),
          input: document.getElementById('editor'),
          handle: document.querySelector('[data-lf-composer-handle]'),
        }
        for (const input of document.querySelectorAll('[data-composer-input]'))
          input.setAttribute('contenteditable', 'false')
      })
      try {
        await settle()
        await clickMessage('answer1')
        await page(() => window.qa.stepButtons('1')[0].click())
        await settle()
        const readonly = await page(() => {
          const nodes = window.fixture.readonlyComposerNodes
          return {
            editable: nodes.input.getAttribute('contenteditable'),
            marked: document
              .getElementById('composerSeat')
              .hasAttribute('data-lf-composer-docked'),
            sameCard: nodes.card === document.getElementById('composerCard'),
            sameInput: nodes.input === document.getElementById('editor'),
            sameHandle:
              nodes.handle ===
              document.querySelector('[data-lf-composer-handle]'),
            handles: document.querySelectorAll('[data-lf-composer-handle]')
              .length,
          }
        })
        assert.deepEqual(readonly, {
          editable: 'false',
          marked: true,
          sameCard: true,
          sameInput: true,
          sameHandle: true,
          handles: 1,
        })
        assertHostDock(await page(() => window.qa.hostDock()))
        await page(() => {
          for (const input of document.querySelectorAll(
            '[data-composer-input]',
          ))
            input.setAttribute('contenteditable', 'true')
        })
        await settle()
        const restored = await page(() => ({
          editable: document
            .getElementById('editor')
            .getAttribute('contenteditable'),
          sameHandle:
            window.fixture.readonlyComposerNodes.handle ===
            document.querySelector('[data-lf-composer-handle]'),
          marked: document
            .getElementById('composerSeat')
            .hasAttribute('data-lf-composer-docked'),
        }))
        assert.deepEqual(restored, {
          editable: 'true',
          sameHandle: true,
          marked: true,
        })
        assertComposerLayout(await page(() => window.qa.composer()))
        assertHostDock(await page(() => window.qa.hostDock()))
        return { readonly, restored }
      } finally {
        await page(() => {
          for (const input of document.querySelectorAll(
            '[data-composer-input]',
          ))
            input.setAttribute('contenteditable', 'true')
          window.controller.rescan()
        })
        await settle()
      }
    },
  )
  await check(
    '插件在原生输入区只读时启动也能定位，恢复编辑无需额外消息变更',
    async () => {
      await navigate(false, true)
      await page(() => {
        for (const input of document.querySelectorAll('[data-composer-input]'))
          input.setAttribute('contenteditable', 'false')
        window.fixture.restart()
      })
      try {
        await settle()
        const readonly = await page(() => ({
          editable: document
            .getElementById('editor')
            .getAttribute('contenteditable'),
          handles: document.querySelectorAll('[data-lf-composer-handle]')
            .length,
          marked: document
            .getElementById('composerSeat')
            .hasAttribute('data-lf-composer-docked'),
        }))
        assert.deepEqual(readonly, {
          editable: 'false',
          handles: 1,
          marked: true,
        })
        assertComposerLayout(await page(() => window.qa.composer()))
        assertHostDock(await page(() => window.qa.hostDock()))
        await page(() => {
          for (const input of document.querySelectorAll(
            '[data-composer-input]',
          ))
            input.setAttribute('contenteditable', 'true')
        })
        await settle()
        const restored = await page(() => ({
          editable: document
            .getElementById('editor')
            .getAttribute('contenteditable'),
          handles: document.querySelectorAll('[data-lf-composer-handle]')
            .length,
          marked: document
            .getElementById('composerSeat')
            .hasAttribute('data-lf-composer-docked'),
        }))
        assert.deepEqual(restored, {
          editable: 'true',
          handles: 1,
          marked: true,
        })
        assertHostDock(await page(() => window.qa.hostDock()))
        return { readonly, restored }
      } finally {
        await page(() => {
          for (const input of document.querySelectorAll(
            '[data-composer-input]',
          ))
            input.setAttribute('contenteditable', 'true')
          window.controller.rescan()
        })
        await settle()
      }
    },
  )
  await check(
    '流式追加、只读切换和重复扫描不会写入历史滚动位置或瞬间缩小滚动范围',
    async () => {
      await navigate(false, true)
      await page(() => {
        document
          .getElementById('answer3')
          .parentElement.setAttribute('data-streaming', 'true')
        document.getElementById('answer3').textContent = window.fixture.lines(
          '正在输出',
          160,
        )
        window.controller.setHeight(540)
      })
      await settle()
      await page(() => {
        const root = document.getElementById('scroll')
        root.scrollTop = root.scrollHeight - root.clientHeight - 80
      })
      await settle()
      await installComposerScrollProbe()
      try {
        await page(async () => {
          for (let index = 0; index < 4; index++) {
            document.getElementById('answer3').textContent +=
              '\n' + window.fixture.lines(`继续输出 ${index}`, 2)
            document
              .getElementById('editor')
              .setAttribute('contenteditable', index % 2 ? 'true' : 'false')
            window.controller.rescan()
            await new Promise((resolve) => requestAnimationFrame(resolve))
          }
        })
        await settle()
        const probe = await page(() => window.fixture.scrollProbe.snapshot())
        const detail = assertPassiveComposerScroll(probe)
        assertHostDock(await page(() => window.qa.hostDock()))
        return detail
      } finally {
        await page(() => window.fixture.scrollProbe.dispose())
      }
    },
  )
  await check(
    '定位恢复期间扫描和追加正文不会移除预留高度或写入历史滚动位置',
    async () => {
      await navigate(false, true)
      await page(() => window.controller.setHeight(196))
      await settle()
      await startComposerPositionFault()
      await page(() => {
        document.getElementById('main').classList.add('hostComposerShifted')
        const root = document.getElementById('scroll')
        root.scrollTop = root.scrollHeight - root.clientHeight - 60
      })
      await settle()
      assertComposerRecovery(await composerRecovery(), true)
      await installComposerScrollProbe()
      try {
        await page(async () => {
          for (let index = 0; index < 4; index++) {
            document.getElementById('answer3').textContent += '\n继续输出'
            window.controller.rescan()
            await new Promise((resolve) => requestAnimationFrame(resolve))
          }
        })
        await settle()
        const probe = await page(() => window.fixture.scrollProbe.snapshot())
        const detail = assertPassiveComposerScroll(probe)
        assertComposerRecovery(await composerRecovery(), true)
        assertHostDock(await page(() => window.qa.hostDock()))
        return detail
      } finally {
        await page(() => window.fixture.scrollProbe.dispose())
        await stopComposerPositionFault()
      }
    },
  )
  await check(
    '回答结束后实际滚轮上翻与重复扫描均不会抢回阅读位置',
    async () => {
      await navigate(false, true)
      await page(() => {
        document.getElementById('answer3').textContent = window.fixture.lines(
          '已完成回复',
          160,
        )
        window.controller.setHeight(440)
      })
      await settle()
      const before = await page(() => {
        const root = document.getElementById('scroll')
        root.scrollTop = root.scrollHeight - root.clientHeight
        const rect = root.getBoundingClientRect()
        return { top: root.scrollTop, x: rect.left + 80, y: rect.top + 80 }
      })
      await settle()
      await installComposerScrollProbe()
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: before.x,
        y: before.y,
        deltaX: 0,
        deltaY: -240,
      })
      await settle()
      const readerTop = await page(
        () => document.getElementById('scroll').scrollTop,
      )
      assert.ok(
        readerTop < before.top - 100,
        JSON.stringify({ before, readerTop }),
      )
      try {
        const wheelProbe = await page(() =>
          window.fixture.scrollProbe.snapshot(),
        )
        assert.equal(
          wheelProbe.writes.length,
          0,
          JSON.stringify(wheelProbe.writes[0]),
        )
        await page(async () => {
          window.fixture.scrollProbe.reset()
          for (let index = 0; index < 4; index++) {
            window.controller.rescan()
            await new Promise((resolve) => requestAnimationFrame(resolve))
          }
        })
        await settle()
        const probe = await page(() => window.fixture.scrollProbe.snapshot())
        const detail = assertPassiveComposerScroll(probe)
        assert.ok(Math.abs(detail.top - readerTop) <= 1)
        return { fromBottom: before.top - readerTop, ...detail }
      } finally {
        await page(() => window.fixture.scrollProbe.dispose())
      }
    },
  )
  await check(
    '运行中宿主定位异常时恢复输入框位置，流式追加和步骤展开保留原滚动容器',
    async () => {
      await navigate(false, true)
      await page(() => window.controller.setHeight(196))
      await settle()
      assert.equal(
        await page(
          () =>
            document.querySelectorAll(
              '[data-lf-composer-recovered],[data-lf-composer-reserve]',
            ).length,
        ),
        0,
      )
      await startComposerPositionFault()
      try {
        const states = []
        for (let index = 0; index < 3; index++) {
          await page((index) => {
            document.getElementById('answer3').textContent +=
              '\n' + window.fixture.lines(`继续输出 ${index}`, 12)
            window.qa.stepButtons('1')[0].click()
          }, index)
          await settle()
          const state = await composerRecovery()
          assertComposerRecovery(state, true)
          assert.equal(state.scrollTop, 0, JSON.stringify(state))
          assertHostDock(await page(() => window.qa.hostDock()))
          states.push(state)
        }
        const scrolled = []
        for (const position of [0.5, 1]) {
          const intended = await page((position) => {
            // Relative positioning naturally lands at the floor. Keep a real
            // host displacement there to exercise active recovery while idle.
            if (position === 1)
              document
                .getElementById('main')
                .classList.add('hostComposerShifted')
            const scroll = document.getElementById('scroll')
            scroll.scrollTop =
              (scroll.scrollHeight - scroll.clientHeight) * position
            return scroll.scrollTop
          }, position)
          await settle()
          const state = await composerRecovery()
          assertComposerRecovery(state, true)
          assert.ok(
            Math.abs(state.scrollTop - intended) <= 1,
            JSON.stringify({ intended, state }),
          )
          assertHostDock(await page(() => window.qa.hostDock()))
          scrolled.push({ position, intended, state })
        }
        const idleWrites = await page(async () => {
          await new Promise((resolve) => setTimeout(resolve, 350))
          let writes = 0
          const observer = new MutationObserver((records) => {
            writes += records.length
          })
          observer.observe(document.body, {
            subtree: true,
            attributes: true,
            childList: true,
          })
          await new Promise((resolve) => setTimeout(resolve, 350))
          observer.disconnect()
          return writes
        })
        assert.equal(idleWrites, 0)
        assertComposerRecovery(await composerRecovery(), true)
        await stopComposerPositionFault()
        const restored = await composerRecovery()
        assertComposerRecovery(restored, false)
        assert.equal(restored.position, 'sticky', JSON.stringify(restored))
        assert.ok(
          Math.abs(restored.scrollTop - scrolled.at(-1).intended) <= 1,
          JSON.stringify(restored),
        )
        assertHostDock(await page(() => window.qa.hostDock()))
        return { states, scrolled, idleWrites, restored }
      } finally {
        await stopComposerPositionFault()
      }
    },
  )
  await check(
    '定位恢复期间打开交互遮罩、停用或卸载插件会移除固定定位与预留区',
    async () => {
      await navigate(false, true)
      await startComposerPositionFault()
      try {
        assertComposerRecovery(await composerRecovery(), true)
        await page(() => {
          const overlay = document.createElement('div')
          overlay.setAttribute('data-conversation-composer-overlay', '')
          document.getElementById('composerCard').append(overlay)
        })
        await settle()
        const overlay = await composerRecovery()
        assertComposerRecovery(overlay, false)
        assert.notEqual(overlay.position, 'fixed', JSON.stringify(overlay))
        await page(() =>
          document
            .querySelector('[data-conversation-composer-overlay]')
            .remove(),
        )
        await settle()
        assertComposerRecovery(await composerRecovery(), true)
        await update({ enabled: false })
        const disabled = await composerRecovery()
        assertComposerRecovery(disabled, false)
        assert.equal(disabled.position, 'relative', JSON.stringify(disabled))
        await update({ enabled: true })
        assertComposerRecovery(await composerRecovery(), true)
        await page(() => window.controller.dispose())
        await settle()
        const disposed = await composerRecovery()
        assertComposerRecovery(disposed, false)
        assert.equal(disposed.position, 'relative', JSON.stringify(disposed))
        assert.equal(
          await page(
            () => document.getElementById('composerSeat').style.position,
          ),
          '',
        )
        return { overlay, disabled, disposed }
      } finally {
        await stopComposerPositionFault(true)
      }
    },
  )
  await check(
    '宿主布局空闲时无持续重绘，停用和卸载会清除定位约束',
    async () => {
      const writes = await page(async () => {
        await new Promise((resolve) => setTimeout(resolve, 350))
        let writes = 0
        const observer = new MutationObserver((records) => {
          writes += records.length
        })
        observer.observe(document.body, {
          subtree: true,
          attributes: true,
          childList: true,
        })
        await new Promise((resolve) => setTimeout(resolve, 500))
        observer.disconnect()
        return writes
      })
      assert.equal(writes, 0)
      await update({ enabled: false })
      assert.deepEqual(
        await page(() => {
          const seat = document.getElementById('composerSeat')
          return {
            marked: seat.hasAttribute('data-lf-composer-docked'),
            inset: seat.style.getPropertyValue('--lf-composer-top'),
            height: document.getElementById('editorScroll').style.height,
          }
        }),
        { marked: false, inset: '', height: '' },
      )
      await update({ enabled: true })
      assertHostDock(await page(() => window.qa.hostDock()), 64)
      await page(() => window.controller.dispose())
      await settle()
      assert.equal(
        await page(
          () =>
            document.querySelectorAll(
              '[data-lf-composer-docked],[data-lf-composer-handle]',
            ).length,
        ),
        0,
      )
      assert.equal(
        await page(() =>
          document
            .getElementById('composerSeat')
            .style.getPropertyValue('--lf-composer-top'),
        ),
        '',
      )
      return { idleWrites: writes, restored: true }
    },
  )
  await check('浏览器无未捕获异常', async () => {
    assert.deepEqual(exceptions, [])
  })
} catch (error) {
  results.push({
    name: 'browser harness',
    pass: false,
    error: error.stack || error.message,
  })
  console.error(error)
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      await send('Browser.close')
    } catch {}
    socket.close()
  }
  chrome?.kill()
  server.close()
  for (const item of pending.values()) clearTimeout(item.timeout)
  const report = {
    generatedAt: new Date().toISOString(),
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
    exceptions,
    results,
  }
  await writeFile(
    path.join(artifacts, 'report.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(
    `\n${report.passed} passed; ${report.failed} failed. Report: ${path.join(artifacts, 'report.json')}`,
  )
  process.exitCode = report.failed ? 1 : 0
}
