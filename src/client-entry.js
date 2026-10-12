// DSH client-plugin entry. Built into ../client.js by scripts/build.mjs.
//
// The host calls `registration.factory(require)` with ITS OWN resolver, so:
//
//   1. Keep the `require` parameter and use it for platform modules (`react`).
//      Do not fall back to `window.__ModuleLoader__.require` — it does not exist
//      during activation, and the plugin then dies with
//      "[fold-polish] host module unavailable: react".
//   2. Never hand this bundle's own specifiers to that resolver: the host module
//      table has never heard of "./src/browser.js", and asking it fails with
//      `client-modules: require("./src/browser.js") missed the module table`,
//      which the desktop app reports as a failed application boot.
//
// So: local modules come from the wrapper's MODULES registry (also exposed on
// window.__DSH_BUBBLE_FOLD_MODULES__ for console use); everything else goes to
// the resolver the host passes in.
//
// `dsh.client.immediately: true` in package.json is what puts this row in the
// boot graph — a DOM-only plugin registers no slot, so nothing would ever
// request it and the bundle would never execute without it.
window.__ModuleLoader__.load({
  id: 'dsh-fold-polish',
  factory: (require) => {
    const React = require('react')
    const local = window.__DSH_BUBBLE_FOLD_MODULES__ ?? {}
    const { start } = local['./src/browser.js']
    const fold = local['./src/fold.js']
    const turnTimer = local['./src/turn-timer.js']
    const { createPanel } = local['./src/settings-panel.js']
    const { createFindPanel } = local['./src/find-panel.js']

    /** The find tab's identity in the right sidebar: one id for all three parts. */
    const FIND_TAB_ID = 'bubble-fold-find'
    /** True only once the tab type AND its body really registered. */
    let findTabRegistered = false

    // Derive every browser global from the document's own view. Reading bare
    // `getComputedStyle` / `localStorage` globals only works inside a test
    // harness: in the page `getComputedStyle` is brand-checked, so an unbound
    // reference throws "Illegal invocation" the first time layout is measured.
    const view = document.defaultView ?? window

    let controller = null
    let panelOff = null
    let findTabOff = null
    let findTitleOff = null
    let findPanelOff = null
    /** The find panel asks for focus when it opens; the keydown route sets it. */
    let focusFindInput = null
    /** Two-way sync with the host's right-sidebar width; null when unsupported. */
    let rightbar = null
    /** Per-turn duration store: filled by the snapshot probe, read by the DOM pass. */
    const turnTimers = turnTimer?.createTurnTimerStore?.() ?? null
    /** Off-handle for the invisible shell.overlay probe + its snapshot unsubscribe. */
    let convOff = null
    let timerProbeSub = null

    // Stable api object for the settings tab and the find panel: the components
    // mount on first selection (possibly before or after a restart of the fold),
    // so they reach the controller through indirection, never a captured ref.
    const api = {
      settings: () => controller?.settings() ?? null,
      update: (patch) => controller?.update(patch),
      subscribe: (fn) => controller?.subscribe(fn) ?? (() => {}),
      search: (query) => controller?.search(query) ?? [],
      revealAt: (element) => controller?.revealAt(element),
      // The composer height is a host-CSS knob, not a plugin setting: the settings
      // page reads its range/current value here instead of from `settings()`.
      composer: () => controller?.composer() ?? null,
      setHeight: (value) => controller?.setHeight(value),
      resetHeight: () => controller?.resetHeight(),
      // Right-sidebar width: the percentage lives in the settings, the px in the
      // host's layout store. setRightbarRatio applies it; rightbar() reports what
      // the host actually shows, so the page can say "不支持" on older hosts.
      setRightbarRatio: (ratio) => rightbar?.setRatio(ratio),
      rightbar: () => rightbar?.info() ?? null,
      onFindPanelMounted: (fn) => { focusFindInput = fn }
    }

    const { Panel: FindPanel, Title: FindTitle } = createFindPanel(React, api)

    // Reassigned by apply() to also release the Ctrl+F listener once the
    // desktop key route is installed.
    let disposed = false
    let dispose = () => {
      disposed = true
      panelOff?.()
      findTabOff?.()
      findTitleOff?.()
      findPanelOff?.()
      rightbar?.dispose()
      convOff?.()
      timerProbeSub?.()
      turnTimers?.clear?.()
      convOff = null
      timerProbeSub = null
      panelOff = null
      findTabOff = null
      findTitleOff = null
      findPanelOff = null
      rightbar = null
      focusFindInput = null
      controller?.dispose()
      controller = null
      // Leave no trace of the console handle once the row is gone.
      delete window.__DSH_BUBBLE_FOLD__
      delete window.__DSH_FOLD_POLISH__
    }

    /**
     * Two-way sync between the host's right-sidebar width (px) and the plugin
     * setting `rightbarRatio` (percent of the frame).
     *
     * Verified against the host's own code: `ctx.layout` is a LayoutController
     * whose fields are `panels` (the real store actions), `hasMainPanel`,
     * `panelInfo` (a {getSnapshot,subscribe} facade for the CENTRAL panel only) and
     * `navigation`. There is NO `layoutInfo` and NO `layout.setRightbar` — the
     * width is written through `layout.panels.setRightbar(px)` and can only be
     * READ back from the DOM (the AppFrame's resolved grid tracks), which is also
     * what makes the manual drag observable. Everything is probed defensively, so
     * a host without these internals simply loses this control.
     */
    const makeRightbarControl = (layout, view, doc, getSettings, updateSettings) => {
      let disposed = false
      const panels = layout?.panels ?? null
      const setRightbar = typeof panels?.setRightbar === 'function' ? panels.setRightbar
        : (typeof layout?.setRightbar === 'function' ? layout.setRightbar : null)
      /** The store clamps against its own viewport width; keep it truthful. */
      const setViewport = typeof panels?.setViewportWidth === 'function' ? panels.setViewportWidth : null
      const viewportOf = () => view?.innerWidth || 0
      /**
       * The AppFrame is the grid owning the three columns (sidebar | conversation |
       * right panel). It is identified by its INLINE `grid-template-columns` — the
       * host computes that string and writes it as a style, so it is the one element
       * that carries it inline. Walking up from a random child instead can land on an
       * inner grid and read a completely unrelated width, which then gets treated as
       * the reader's own choice.
       */
      const frameOf = () => {
        if (!doc || typeof doc.querySelectorAll !== 'function') return null
        for (const el of doc.querySelectorAll('div[style]')) {
          try {
            if (el.style && el.style.gridTemplateColumns) return el
          } catch { /* not inspectable */ }
        }
        return null
      }
      /**
       * The right column's width in px. The host's own number is authoritative: the
       * third track is written as `minmax(0px, <rightbarMax>px)`, and reading it back
       * means our picture always matches the store's — the rendered track can be
       * narrower than the max, which would otherwise read as a smaller ratio.
       */
      const rightbarPx = () => {
        const frame = frameOf()
        if (!frame) return 0
        let inline = ''
        try {
          inline = String(frame.style.gridTemplateColumns ?? '')
        } catch { /* ignore */ }
        const maxima = [...inline.matchAll(/minmax\(\s*[^,]+,\s*([\d.]+)px\s*\)/g)]
        const fromInline = maxima.length > 0 ? Number.parseFloat(maxima[maxima.length - 1][1]) : NaN
        if (Number.isFinite(fromInline) && fromInline > 0) return fromInline
        try {
          const sizes = String(view.getComputedStyle(frame).gridTemplateColumns)
            .split(' ')
            .map((part) => Number.parseFloat(part))
            .filter((px) => Number.isFinite(px))
          return sizes.length >= 2 ? sizes[sizes.length - 1] : 0
        } catch {
          return 0
        }
      }
      const ratioNow = () => {
        const viewport = viewportOf()
        const px = rightbarPx()
        if (!(viewport > 0) || !(px > 0)) return null
        return Math.round((px / viewport) * 100)
      }
      // Until our stored value has been applied, observations must not overwrite it:
      // the host reports its own 45% default at startup, and writing that back would
      // silently replace the reader's choice before it ever reached the store.
      /** The px our stylesheet rule is forcing right now (0 = no override in force). */
      let forcedPx = 0
      /** Split "280px minmax(400px, 1fr) minmax(0px, 900px)" on top-level spaces. */
      const splitTracks = (value) => {
        const out = []
        let depth = 0
        let current = ''
        for (const char of String(value ?? '')) {
          if (char === '(') depth += 1
          else if (char === ')') depth -= 1
          if (char === ' ' && depth === 0) {
            if (current) out.push(current)
            current = ''
            continue
          }
          current += char
        }
        if (current) out.push(current)
        return out
      }
      const inlineTracks = (frame) => {
        try {
          return splitTracks(frame?.style?.gridTemplateColumns)
        } catch {
          return []
        }
      }
      /** The host's own third-track maximum: the number the store was asked for. */
      const hostRightbarPx = (frame) => {
        const tracks = inlineTracks(frame)
        const last = tracks[tracks.length - 1] ?? ''
        const maxima = [...last.matchAll(/minmax\(\s*[^,]+,\s*([\d.]+)px\s*\)/g)]
        if (maxima.length > 0) return Number.parseFloat(maxima[maxima.length - 1][1])
        const px = Number.parseFloat(last)
        return Number.isFinite(px) ? px : 0
      }
      const FRAME_MARK = 'data-lf-frame'
      const RULE_ID = 'dsh-bubble-fold-frame'
      /** What the frame is ACTUALLY rendering right now, in px. */
      const renderedPx = () => {
        const frame = frameOf()
        if (!frame) return 0
        try {
          const sizes = String(view.getComputedStyle(frame).gridTemplateColumns)
            .split(' ')
            .map((part) => Number.parseFloat(part))
            .filter((px) => Number.isFinite(px))
          return sizes.length >= 2 ? sizes[sizes.length - 1] : 0
        } catch {
          return 0
        }
      }
      const clearOverride = () => {
        const tag = doc?.getElementById?.(RULE_ID)
        if (tag) tag.textContent = ''
        frameOf()?.removeAttribute?.(FRAME_MARK)
        forcedPx = 0
      }
      /**
       * Force the right column to the chosen width.
       *
       * The host writes that column as `minmax(0px, max)`, which sizes to its
       * CONTENT — so asking the store for a bigger max does not widen anything (the
       * panel keeps its own width). A stylesheet rule with `!important` beats the
       * host's inline style, so the width becomes ours, while the other two tracks
       * are copied from the host verbatim. Collapsed and fullscreen are
       * presentations, not widths, so they are never fought.
       */
      const applyOverride = (px) => {
        const frame = frameOf()
        if (!frame || !doc?.head || typeof doc.createElement !== 'function') return false
        // The plugin's own master switch wins: disabled means the host lays out alone.
        if (getSettings()?.enabled === false) {
          clearOverride()
          return false
        }
        if (frame.hasAttribute?.('data-rightbar-collapsed') || frame.hasAttribute?.('data-rightbar-fullscreen')) {
          clearOverride()
          return false
        }
        const tracks = inlineTracks(frame)
        if (tracks.length < 3) return false
        let tag = doc.getElementById(RULE_ID)
        if (!tag) {
          tag = doc.createElement('style')
          tag.setAttribute('id', RULE_ID)
          doc.head.appendChild(tag)
        }
        const head = tracks.slice(0, tracks.length - 1).join(' ')
        frame.setAttribute(FRAME_MARK, '1')
        tag.textContent = `[${FRAME_MARK}]{grid-template-columns:${head} ${Math.round(px)}px !important}`
        forcedPx = Math.round(px)
        return true
      }
      const applyRatio = (ratio) => {
        const viewport = viewportOf()
        if (!(ratio > 0) || !(viewport > 0)) return false
        const px = Math.round(viewport * ratio / 100)
        // Mark the moment so the observer can tell "the host re-rendered from OUR
        // apply" apart from "the reader dragged the handle".
        lastAppliedAt = Date.now()
        if (setRightbar) {
          try {
            // Keep the store's own idea of the frame width in step: it clamps the
            // request against ITS viewportWidth, which is 0 during boot.
            setViewport?.(viewport)
            setRightbar(px)
          } catch { /* the store refused; the CSS override still decides the width */ }
        }
        return applyOverride(px) || !!setRightbar
      }
      // The frame is not measurable at activation time, the controller (which owns
      // the settings) is created after this control, and the window itself may only
      // settle later — so keep retrying until the width really is in force.
      const timers = []
      const applyStored = (attempt) => {
        if (disposed) return
        const ratio = getSettings()?.rightbarRatio
        if (ratio > 0 && applyRatio(ratio)) return
        if (attempt < 20) {
          timers.push(view.setTimeout(() => applyStored(attempt + 1), 500))
          return
        }
      }
      timers.push(view.setTimeout(() => applyStored(0), 0))

      /**
       * The host re-renders the frame from its own store whenever the reader drags
       * the handle. Our own applies land on the same value we forced, so anything
       * that differs and does not come from an apply in flight is a drag: adopt it
       * (write it back as the ratio) and re-force the width at that size, which is
       * what keeps the drag visible even though our rule owns the layout.
       */
      let lastAppliedAt = 0
      const adoptHostWidth = () => {
        if (disposed) return
        const frame = frameOf()
        const hostPx = hostRightbarPx(frame)
        const viewport = viewportOf()
        if (!(hostPx > 0) || !(viewport > 0)) return
        if (Math.abs(hostPx - forcedPx) <= 2) return
        if (Date.now() - lastAppliedAt < 800) return
        const ratio = Math.max(30, Math.min(70, Math.round((hostPx / viewport) * 100)))
        updateSettings({ rightbarRatio: ratio })
        lastAppliedAt = Date.now()
        applyOverride(Math.round(viewport * ratio / 100))
      }

      /**
       * The frame re-rendered — by the host's handle, by a close/open, or by our own
       * apply. A `!important` rule of ours would otherwise keep the third column
       * reserved after the host CLOSED the panel, which leaves the conversation stuck
       * at half width with the sidebar gone. So: a closed, fullscreen or zero-width
       * column always drops the rule, and a column that comes BACK gets the reader's
       * stored ratio again.
       */
      let wasShown = false
      const onFrameChange = () => {
        if (disposed) return
        const frame = frameOf()
        const collapsed = frame?.hasAttribute?.('data-rightbar-collapsed') === true
        const fullscreen = frame?.hasAttribute?.('data-rightbar-fullscreen') === true
        const hostPx = hostRightbarPx(frame)
        if (collapsed || fullscreen || !(hostPx > 0)) {
          clearOverride()
          wasShown = false
          return
        }
        if (!wasShown) {
          wasShown = true
          const ratio = getSettings()?.rightbarRatio
          if (ratio > 0) {
            lastAppliedAt = Date.now()
            applyRatio(ratio)
            return
          }
        }
        adoptHostWidth()
      }

      // A drag re-renders the frame's inline grid template; a window resize changes
      // what the same ratio means in px. The store exposes no getter, so both are
      // read from the DOM.
      let observer = null
      try {
        const frame = frameOf()
        if (frame && typeof view.MutationObserver === 'function') {
          observer = new view.MutationObserver(() => {
            onFrameChange()
          })
          // `style` alone is not enough: a close may only flip the presentation
          // attributes, and then nothing would ever release the forced column.
          observer.observe(frame, {
            attributes: true,
            attributeFilter: ['style', 'data-rightbar-collapsed', 'data-rightbar-fullscreen']
          })
        }
      } catch { observer = null }
      const onResize = () => {
        if (disposed) return
        view.setTimeout(() => {
          const ratio = getSettings()?.rightbarRatio
          if (ratio > 0) {
            lastAppliedAt = Date.now()
            applyRatio(ratio)
          }
        }, 60)
      }
      try { view.addEventListener('resize', onResize) } catch { /* no window events */ }

      return {
        setRatio(ratio) {
          const clamped = Math.max(30, Math.min(70, Math.round(Number(ratio) || 45)))
          updateSettings({ rightbarRatio: clamped })
          lastAppliedAt = Date.now()
          applyRatio(clamped)
        },
        info() {
          return {
            supported: !!(setRightbar || forcedPx),
            ratio: ratioNow(),
            renderedRatio: (() => {
              const viewport = viewportOf()
              const px = renderedPx()
              return viewport > 0 && px > 0 ? Math.round((px / viewport) * 100) : null
            })(),
            viewport: viewportOf()
          }
        },
        dispose() {
          disposed = true
          clearOverride()
          observer?.disconnect()
          observer = null
          for (const timer of timers) view.clearTimeout(timer)
          try { view.removeEventListener('resize', onResize) } catch { /* ignore */ }
        }
      }
    }

    const plugin = {
      name: 'dsh-fold-polish',
      // `uiConversation` / `sessions` must both be declared: the restricted
      // context only hands out services this row asked for. Without them
      // ctx.get(...) is null and the per-turn timer silently degrades to a
      // settings row with no chip.
      inject: ['slots', 'uiConversation', 'sessions'],
      /**
       * The row is `dsh.client.immediately`, i.e. part of the boot graph: if this
       * throws, the HOST fails to start and the reader gets a "cannot start" dialog
       * instead of an app. So nothing may escape — every optional feature degrades
       * to "not there", the DOM fold keeps working, and the app always comes up.
       */
      apply(ctx) {
        try {
          return plugin.applyRow(ctx)
        } catch (error) {
          console.warn('[fold-polish] 激活时出错，本插件已降级停用（应用不受影响）：', error)
          return dispose
        }
      },
      applyRow(ctx) {
        if (controller !== null) return
        try {
          // The layout service belongs to the shell plugin and may still be
          // activating when this row runs, exactly like sidebarRightTabs — asking
          // once would silently disable the width control for the whole session.
          // So keep asking for a few seconds before giving up.
          const setupRightbar = (attempt) => {
            if (disposed || rightbar) return
            const layout = ctx?.get?.('layout') ?? null
            if (layout) {
              rightbar = makeRightbarControl(layout, view, document, () => controller?.settings(), (patch) => controller?.update(patch))
              return
            }
            if (attempt < 10) view.setTimeout(() => setupRightbar(attempt + 1), 300)
            else console.warn('[fold-polish] 此宿主未暴露 layout 服务，右侧栏占比不可用')
          }
          setupRightbar(0)
          controller = start({
            document,
            localStorage: view.localStorage,
            getComputedStyle: view.getComputedStyle.bind(view),
            requestAnimationFrame: view.requestAnimationFrame.bind(view),
            setTimeout: view.setTimeout.bind(view),
            clearTimeout: view.clearTimeout.bind(view),
            MutationObserver: view.MutationObserver,
            HTMLElement: view.HTMLElement,
            Element: view.Element,
            addEventListener: view.addEventListener.bind(view),
            removeEventListener: view.removeEventListener.bind(view),
            // Stable identity for the floating panel: the real control may be built
            // a moment later (the layout service can activate after this row).
            rightbar: {
              setRatio: (ratio) => rightbar?.setRatio(ratio),
              info: () => rightbar?.info() ?? null
            },
            turnTimers,
            __DSH_BUBBLE_FOLD_MODULES__: { fold, turnTimer }
          }, React)
        } catch (error) {
          // A failed fold must never take the conversation down with it.
          console.warn('[fold-polish] 启动失败，气泡折叠已停用：', error)
          controller = null
        }

        // The settings page lives in the host's Plugins settings section. A
        // missing slots service (an older host) just means no settings tab and no
        // find tab: the fold itself is DOM-only and keeps working.
        const slots = ctx?.slots
        if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
          try {
            panelOff = slots.inject('settings.plugins.tab', () => slots.register({
              name: 'settings.plugins.tab',
              id: 'bubble-fold',
              order: 20,
              label: 'UI 美化',
              inject: () => ({ api })
            }, createPanel(React, api)))
          } catch (error) {
            console.warn('[fold-polish] 设置页注册失败，仅浮层面板可用：', error)
            panelOff = null
          }
        }

        // The find panel is a tab of the RIGHT sidebar (the column the reader
        // already keeps 上下文/文件 in). A tab needs three registrations under one
        // id — the tab type, its body, and its chip — exactly the shape the
        // shipped context and schedule panels use. That registry may still be
        // activating when we are (it belongs to the right-bar package), so keep
        // asking for a few seconds instead of giving up on the first miss.
        const registerFindTab = () => {
          // Only ctx.get() may be used for a service this plugin does not declare:
          // a property read on the restricted context THROWS for unknown names, and
          // a throwing boot row takes the whole app down with it.
          let tabs = null
          try {
            tabs = ctx?.get?.('sidebarRightTabs') ?? null
          } catch {
            tabs = null
          }
          if (!slots || !tabs || typeof tabs.register !== 'function') return false
          try {
            findTabOff = tabs.register({ id: FIND_TAB_ID, kind: FIND_TAB_ID, title: () => '查找' })
            findPanelOff = slots.inject('sidebar.right.pane.tab', () => slots.register({
              name: 'sidebar.right.pane.tab',
              key: FIND_TAB_ID,
              inject: () => ({ api })
            }, FindPanel))
            findTitleOff = slots.inject('sidebar.right.pane.tab.title', () => slots.register({
              name: 'sidebar.right.pane.tab.title',
              key: FIND_TAB_ID
            }, FindTitle))
            findTabRegistered = true
            return true
          } catch (error) {
            console.warn('[fold-polish] 右栏查找注册失败：', error)
            findTabOff?.()
            findPanelOff?.()
            findTitleOff?.()
            findTabOff = null
            findPanelOff = null
            findTitleOff = null
            findTabRegistered = false
            return true
          }
        }
        if (!registerFindTab()) {
          let tries = 0
          const retryFindTab = () => {
            if (findTabRegistered || disposed) return
            let done = false
            try {
              done = registerFindTab()
            } catch (error) {
              // Never let an optional feature reach the host as a failed entry.
              console.warn('[fold-polish] 右栏查找注册出错，已放弃：', error)
              done = true
            }
            if (done) return
            if (++tries >= 10) {
              // Nothing to open later, so Ctrl+F must not touch the layout at all:
              // opening the column without a tab leaves the reader a blank pane.
              console.warn('[fold-polish] 此宿主未暴露 sidebarRightTabs，右栏「查找」不可用')
              return
            }
            view.setTimeout(retryFindTab, 500)
          }
          retryFindTab()
        }

        // Ctrl+F opens the find tab — but only where the platform has no find of
        // its own. The desktop app has none (verified: no findInPage), while a
        // real browser's Ctrl+F already reaches folded content thanks to the
        // until-found work; hijacking it there would be a downgrade.
        const desktopApp = /Electron\//.test(view.navigator?.userAgent ?? '')
        if (desktopApp) {
          const onFindKey = (event) => {
            if (event.key !== 'f' || !event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            if (!findTabRegistered) {
              console.warn('[fold-polish] 查找面板未注册，Ctrl+F 不做任何事（不会打开空面板）')
              return
            }
            let right = null
            try {
              right = ctx?.get?.('sidebarRight') ?? null
            } catch {
              right = null
            }
            let opened = false
            if (right && typeof right.openTab === 'function') {
              try {
                right.openTab(FIND_TAB_ID)
                opened = true
              } catch {
                // A root-scoped face may refuse: the column is opened instead.
              }
            }
            if (!opened) {
              const layout = ctx?.get?.('layout')
              try { layout?.openRightbar?.(true, false) } catch { /* column cannot fit */ }
            }
            // The panel mounts on first open and asks for focus itself.
            view.setTimeout(() => focusFindInput?.(), 80)
          }
          view.addEventListener('keydown', onFindKey, true)
          const prevDispose = dispose
          dispose = () => {
            view.removeEventListener('keydown', onFindKey, true)
            prevDispose()
          }
        }

        // 每轮耗时探针：纯 ctx 驱动，不依赖宿主往组件里注入什么 props。
        // 数据源是 uiConversation 的 chat binding（只读）：binding(sessionId)
        // .target('chat').getSnapshot() 的 legacy.nodes 里，每个已结算的
        // assistant 节点带 turn 与 timing { stepStartTime, completedTime }，
        // 一轮的耗时 = 该轮首个 step 的开始 → 末步的完成（工具间隔也计入）。
        // 当前会话 id 从 sessions 服务取（宿主自己的 inject 就用这个名字），
        // 取不到就保持静默；快照没有订阅接口，所以用低频轮询，且只在
        // 会话/轮次真的变化时重写 store。（数据接法对照 gbeta/dsh-token-speed
        // 实测的 binding/target/getSnapshot 路线，MIT。）
        const setupTurnTimer = (attempt) => {
          if (disposed) return
          let conv = null
          try { conv = ctx?.get?.('uiConversation') ?? null } catch { conv = null }
          if (!conv || typeof conv.binding !== 'function') {
            if (attempt < 10) view.setTimeout(() => setupTurnTimer(attempt + 1), 400)
            else console.warn('[fold-polish] 此宿主未暴露 uiConversation，每轮耗时不可用')
            return
          }
          if (!turnTimers) return
          // 诊断留痕：哪一步取不到，问题就在哪一步。
          const turnTimerDiag = {
            attempts: 0,
            services: {},
            sessionId: null,
            target: null,
            nodes: null,
            durations: null,
            lastError: null,
            polls: 0
          }
          window.__DSH_BUBBLE_FOLD_TURN_TIMER_DIAG__ = turnTimerDiag
          // 当前会话 id：sessions 服务的多个可能形状都试一遍，全部拿不到就
          // 退到"最近一个可用会话"，再不行就静默（徽标缺席，其余功能不受影响）。
          const pickSessionId = () => {
            let sessions = null
            try { sessions = ctx?.get?.('sessions') ?? null } catch { sessions = null }
            if (!sessions) { turnTimerDiag.services.sessions = 'missing'; return null }
            turnTimerDiag.services.sessions = typeof sessions
            turnTimerDiag.services.sessionsKeys = (() => { try { return Object.keys(sessions).slice(0, 20) } catch { return null } })()
            const current = sessions.current ?? sessions.currentId ?? null
            if (typeof current === 'string' && current) return current
            const byId = sessions.byId
            if (byId && typeof byId === 'object') {
              const ids = Object.keys(byId)
              if (ids.length > 0) return ids[ids.length - 1]
            }
            const list = typeof sessions.list === 'function' ? sessions.list() : null
            if (Array.isArray(list) && list.length > 0) {
              const last = list[list.length - 1]
              return typeof last === 'string' ? last : (last?.id ?? null)
            }
            turnTimerDiag.services.sessionsList = list === null ? 'not-array' : list.length
            return null
          }
          let lastSignature = ''
          const pull = () => {
            if (disposed) return
            turnTimerDiag.polls += 1
            const sessionId = pickSessionId()
            turnTimerDiag.sessionId = sessionId
            if (!sessionId) { turnTimers.set({}); return }
            let target = null
            try { target = conv.binding(sessionId).target('chat') } catch (error) { turnTimerDiag.lastError = String(error) }
            turnTimerDiag.target = target ? 'ok' : 'null'
            if (!target) { turnTimers.set({}); return }
            let snapshot = null
            try { snapshot = target.getSnapshot?.() ?? null } catch (error) { turnTimerDiag.lastError = String(error) }
            turnTimerDiag.snapshot = snapshot ? Object.keys(snapshot) : 'null'
            const nodes = snapshot?.legacy?.nodes ?? []
            turnTimerDiag.nodes = Array.isArray(nodes) ? nodes.length : 'not-array'
            const durations = turnTimer.turnDurations(nodes)
            turnTimerDiag.durations = durations
            const signature = sessionId + '|' + JSON.stringify(durations)
            if (signature === lastSignature) return
            lastSignature = signature
            turnTimers.set(durations)
          }
          pull()
          // 低频轮询：一轮对话以秒计，1s 的采样既跟得上也不构成开销。
          let timerPoll = null
          timerProbeSub = () => {
            if (timerPoll) view.clearInterval(timerPoll)
            timerPoll = null
          }
          timerPoll = view.setInterval(pull, 1000)
        }
        setupTurnTimer(0)

        // Console handle: __DSH_BUBBLE_FOLD__.status / .settings() / .stats()
        window.__DSH_BUBBLE_FOLD__ = {
          plugin: 'dsh-bubble-fold',
          status: controller ? 'running' : 'failed',
          rescan: () => controller?.rescan(),
          settings: () => controller?.settings(),
          stats: () => controller?.stats(),
          update: (patch) => controller?.update(patch),
          search: (query) => controller?.search(query),
          revealAt: (element) => controller?.revealAt(element),
          setHeight: (value) => controller?.setHeight(value),
          resetHeight: () => controller?.resetHeight(),
          composer: () => controller?.composer() ?? null,
          dragLog: () => controller?.dragLog() ?? [],
          setRightbarRatio: (ratio) => rightbar?.setRatio(ratio),
          rightbar: () => rightbar?.info() ?? null,
          turnTimer: () => ({
            probe: view.__DSH_BUBBLE_FOLD_TURN_TIMER_DIAG__ ?? null,
            dom: view.__DSH_BUBBLE_FOLD_TURN_TIMER_DOM__ ?? null,
            store: turnTimers?.get?.() ?? null
          }),
          // Diagnostic for the right-sidebar width feature: dumps the host layout
          // service's real shape, so a mis-synced width can be reported precisely.
          layoutDebug: () => {
            const layout = ctx?.get?.('layout') ?? null
            if (!layout) return { layout: null }
            const panels = layout.panels ?? null
            return {
              keys: Object.keys(layout),
              panelKeys: panels ? Object.keys(panels).slice(0, 40) : null,
              setRightbar: typeof panels?.setRightbar,
              rightbar: rightbar?.info() ?? null
            }
          },
          /**
           * Live experiment for the right-bar width: read the frame's grid tracks,
           * call the setter, read them again after two frames. It answers "does this
           * host honour the call, and where does the width actually live?" without a
           * restart cycle.
           */
          layoutTry: async (ratio = 60) => {
            const layout = ctx?.get?.('layout') ?? null
            const panels = layout?.panels ?? null
            const frameOf = () => {
              let node = document.querySelector('[data-composer-seat]') ?? document.querySelector('[data-chat-flow-kind]')
              while (node && node !== document.documentElement) {
                if (getComputedStyle(node).display === 'grid') return node
                node = node.parentElement
              }
              for (const el of document.querySelectorAll('[data-rightbar-fullscreen], [data-rightbar-collapsed], [data-rightbar-instant]')) {
                if (getComputedStyle(el).display === 'grid') return el
              }
              return null
            }
            /** Everything needed to tell the real frame from an inner grid. */
            const census = () => {
              const grids = []
              for (const el of document.querySelectorAll('div')) {
                let style
                try { style = getComputedStyle(el) } catch { continue }
                if (style.display !== 'grid') continue
                const tracks = style.gridTemplateColumns
                if (tracks.split(' ').length < 3) continue
                grids.push({
                  tracks,
                  width: Math.round(el.getBoundingClientRect().width),
                  dataAttrs: [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-')).slice(0, 8),
                  inline: (el.getAttribute('style') ?? '').slice(0, 140)
                })
                if (grids.length >= 5) break
              }
              const find = document.querySelector('[data-lf-find]')
              return {
                viewport: window.innerWidth,
                storedRatio: window.__DSH_BUBBLE_FOLD__?.settings()?.rightbarRatio ?? null,
                findPanelWidth: find ? Math.round(find.getBoundingClientRect().width) : null,
                grids
              }
            }
            const frame = frameOf()
            const before = census()
            const px = Math.round(window.innerWidth * ratio / 100)
            let error = null
            try {
              panels?.setRightbar?.(px)
            } catch (caught) {
              error = String(caught)
            }
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            return {
              keys: layout ? Object.keys(layout) : null,
              setRightbar: typeof panels?.setRightbar,
              ratio,
              px,
              error,
              pickedFrameTracks: frame ? getComputedStyle(frame).gridTemplateColumns : null,
              pickedFrameAttrs: frame ? [...frame.attributes].map((a) => a.name).slice(0, 8) : null,
              before,
              after: census()
            }
          },
          dispose
        }

        // The debug handle keeps its historical name for scripts and docs; the
        // new one is an alias pointing at the same object.
        window.__DSH_FOLD_POLISH__ = window.__DSH_BUBBLE_FOLD__

        return dispose
      },
      dispose
    }

    return plugin
  }
})
