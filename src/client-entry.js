// DSH owns the platform resolver. Local sources come only from our bundle.
window.__ModuleLoader__.load({
  id: 'dsh-fold-polish',
  factory: (require) => {
    const local = window.__DSH_BUBBLE_FOLD_MODULES__ ?? {}
    let runtime = null
    const service = (ctx, name) => {
      try {
        return ctx?.get?.(name) ?? null
      } catch {
        return null
      }
    }
    const plugin = {
      name: 'dsh-fold-polish',
      inject: [],
      apply(ctx) {
        if (runtime) return runtime.dispose
        const cleanups = []
        let controller = null
        let rightbar = null
        let disposed = false
        let handle = null
        const listeners = new Set()
        const notify = () => {
          if (disposed) return
          for (const fn of [...listeners]) {
            try {
              fn()
            } catch {
              /* isolate consumers */
            }
          }
        }
        const release = (off) => {
          try {
            const result = off?.()
            result?.catch?.(() => {})
          } catch {
            /* isolate features */
          }
        }
        const dispose = () => {
          if (disposed) return
          disposed = true
          for (const off of cleanups.reverse()) release(off)
          try {
            rightbar?.dispose()
          } catch {
            /* continue restoring the DOM */
          }
          try {
            controller?.dispose()
          } catch {
            /* never escape into boot */
          }
          listeners.clear()
          if (window.__DSH_BUBBLE_FOLD__ === handle)
            delete window.__DSH_BUBBLE_FOLD__
          if (window.__DSH_FOLD_POLISH__ === handle)
            delete window.__DSH_FOLD_POLISH__
          runtime = null
        }
        runtime = { dispose }
        const attempt = (label, fn) => {
          try {
            return fn()
          } catch (error) {
            console.warn(`[fold-polish] ${label}不可用：`, error)
            return null
          }
        }
        // Cordis inject() owns optional feature lifetimes. It waits for late
        // services and tears each feature down when its provider disappears.
        const feature = (label, names, install) =>
          attempt(label, () => {
            const mount = (scope) => {
              if (disposed) return
              const off = attempt(label, () => install(scope))
              notify()
              return () => {
                release(off)
                notify()
              }
            }
            let inject = null
            try {
              inject = ctx?.inject
            } catch {
              /* minimal/older host */
            }
            if (typeof inject === 'function') {
              const fiber = inject.call(ctx, names, mount)
              cleanups.push(() => fiber?.dispose?.())
            } else if (names.every((name) => service(ctx, name))) {
              cleanups.push(mount(ctx))
            }
          })
        // Throwing from an immediate client row aborts the application's boot.
        try {
          const React = require('react')
          const doc = document
          const view = doc.defaultView ?? window
          const turnTimer = local['./src/turn-timer.js']
          const timers = turnTimer?.createTurnTimerStore?.()
          const bind = (name) =>
            typeof view[name] === 'function' ? view[name].bind(view) : undefined
          const environment = {
            document: doc,
            getComputedStyle: bind('getComputedStyle'),
            requestAnimationFrame: bind('requestAnimationFrame'),
            cancelAnimationFrame: bind('cancelAnimationFrame'),
            setTimeout: bind('setTimeout'),
            clearTimeout: bind('clearTimeout'),
            MutationObserver: view.MutationObserver,
            ResizeObserver: view.ResizeObserver,
            HTMLElement: view.HTMLElement,
            Element: view.Element,
            addEventListener: bind('addEventListener'),
            removeEventListener: bind('removeEventListener'),
            turnTimers: timers,
            rightbar: {
              setRatio: (value) => rightbar?.setRatio(value),
              info: () => rightbar?.info() ?? null,
            },
            __DSH_BUBBLE_FOLD_MODULES__: {
              fold: local['./src/fold.js'],
              turnTimer,
            },
          }
          attempt('偏好保存', () => {
            environment.localStorage = view.localStorage
          })
          controller = attempt('消息折叠', () =>
            local['./src/browser.js'].start(environment, React),
          )
          if (controller) cleanups.push(controller.subscribe(notify))
          const api = {
            settings: () => controller?.settings() ?? null,
            update: (patch) => controller?.update(patch),
            subscribe: (fn) => {
              listeners.add(fn)
              return () => listeners.delete(fn)
            },
            search: (query) => controller?.search(query) ?? [],
            revealAt: (element) => controller?.revealAt(element),
            composer: () => controller?.composer() ?? null,
            setHeight: (value) => controller?.setHeight(value),
            resetHeight: () => controller?.resetHeight(),
            setRightbarRatio: (value) => rightbar?.setRatio(value),
            rightbar: () => rightbar?.info() ?? { supported: false },
          }
          if (controller)
            feature('右栏宽度', ['layout'], (scope) => {
              const instance = local['./src/rightbar.js'].createRightbarControl(
                {
                  layout: service(scope, 'layout'),
                  view,
                  document: doc,
                  getSettings: api.settings,
                  updateSettings: api.update,
                },
              )
              rightbar = instance
              const off = controller.subscribe(() => instance.refresh())
              return () => {
                off()
                instance.dispose()
                if (rightbar === instance) rightbar = null
              }
            })
          const registerSlot = (slots, name, options, component) => {
            if (!slots?.inject || !slots?.register) return
            return slots.inject(name, () =>
              slots.register({ name, ...options }, component),
            )
          }
          feature('设置面板', ['slots'], (scope) =>
            registerSlot(
              service(scope, 'slots'),
              'settings.plugins.tab',
              {
                id: 'bubble-fold',
                order: 20,
                label: 'UI 美化',
                inject: () => ({ api }),
              },
              local['./src/settings-panel.js'].createPanel(React, api),
            ),
          )
          feature(
            '删除本地对话记录',
            ['slots', 'connection', 'sessions', 'uiWorkspace', 'workspaces'],
            (scope) =>
              local['./src/delete-panel.js'].installDeleteConversation({
                React,
                primitives: require('@deepseek-ai/dsh-client-ui-primitives'),
                slots: service(scope, 'slots'),
                connection: service(scope, 'connection'),
                sessions: service(scope, 'sessions'),
                uiWorkspace: service(scope, 'uiWorkspace'),
                workspaces: service(scope, 'workspaces'),
              }),
          )
          let findTabRegistered = false
          feature('查找面板', ['slots', 'sidebarRightTabs'], (scope) => {
            const slots = service(scope, 'slots')
            const tabs = service(scope, 'sidebarRightTabs')
            if (!slots?.inject || !slots?.register || !tabs?.register) return
            const id = 'bubble-fold-find'
            const { Panel, Title } = local[
              './src/find-panel.js'
            ].createFindPanel(React, api)
            const seats = []
            const off = () => {
              for (const releaseSeat of seats.reverse()) release(releaseSeat)
              findTabRegistered = false
            }
            try {
              seats.push(
                tabs.register({
                  id,
                  kind: id,
                  priority: 'extension',
                  title: () => '查找',
                  guide: [
                    {
                      id: 'find',
                      order: 20,
                      title: () => '查找',
                      description: () => '搜索本会话（含折叠内容）',
                    },
                  ],
                }),
              )
              seats.push(
                registerSlot(
                  slots,
                  'sidebar.right.pane.tab',
                  { key: id, inject: () => ({ api }) },
                  Panel,
                ),
              )
              seats.push(
                registerSlot(
                  slots,
                  'sidebar.right.pane.tab.title',
                  { key: id },
                  Title,
                ),
              )
              findTabRegistered = true
              return off
            } catch (error) {
              off()
              throw error
            }
          })
          if (timers)
            feature('每轮耗时', ['uiConversation', 'sessions'], (scope) =>
              turnTimer.watchTurnTimers({
                document: doc,
                view,
                conversation: service(scope, 'uiConversation'),
                sessions: service(scope, 'sessions'),
                store: timers,
              }),
            )
          handle = {
            ...api,
            status: controller ? 'running' : 'failed',
            get findTabRegistered() {
              return findTabRegistered
            },
            plugin: 'dsh-fold-polish',
            rescan: () => controller?.rescan?.(),
            stats: () => controller?.stats?.(),
            turnTimer: () => timers?.get() ?? {},
            dispose,
          }
          window.__DSH_BUBBLE_FOLD__ = window.__DSH_FOLD_POLISH__ = handle
          return dispose
        } catch (error) {
          console.warn('[fold-polish] 启动失败，插件已停用：', error)
          dispose()
          return () => {}
        }
      },
      dispose() {
        runtime?.dispose()
      },
    }
    return plugin
  },
})
