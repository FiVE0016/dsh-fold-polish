// Local conversation deletion is deliberately separate from display folding.
// A row's captured identity survives closing its menu and changing selection.
export function createDeleteController({ remove, getSession, afterDelete }) {
  if (typeof remove !== 'function' || typeof getSession !== 'function')
    throw new TypeError('删除对话功能暂不可用。')
  let disposed = false
  let snapshot = { request: null, busy: false, error: null, notice: null }
  const listeners = new Set()
  const publish = (patch) => {
    if (disposed) return
    snapshot = { ...snapshot, ...patch }
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        /* a view cannot break the deletion result */
      }
    }
  }
  const sessionFor = (sessionId) => {
    const session = getSession(sessionId)
    const identity = session?.id ?? session?.sessionId
    if (!session || (identity !== undefined && identity !== sessionId))
      throw new Error('该对话已不存在，请刷新列表。')
    if (session.blank) throw new Error('空白对话无需删除。')
    if (session.running)
      throw new Error('该对话仍在处理中，请等待处理结束后再删除。')
    return session
  }
  const controller = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    request(sessionId, displayTitle) {
      if (
        disposed ||
        snapshot.busy ||
        typeof sessionId !== 'string' ||
        !sessionId
      )
        return false
      let session
      let error = null
      try {
        session = sessionFor(sessionId)
      } catch (reason) {
        error = errorText(reason)
      }
      publish({
        request: {
          sessionId,
          displayTitle:
            session?.title?.trim() ||
            String(displayTitle ?? '').trim() ||
            '未命名对话',
        },
        busy: false,
        error,
        notice: null,
      })
      return true
    },
    cancel() {
      if (disposed || snapshot.busy) return false
      publish({ request: null, error: null, notice: null })
      return true
    },
    async confirm() {
      if (disposed || snapshot.busy || !snapshot.request) return false
      const request = snapshot.request
      // Set this synchronously: a second click in the same React render cannot
      // issue another destructive request.
      publish({ busy: true, error: null, notice: null })
      try {
        sessionFor(request.sessionId)
        if (disposed) return false
        const result = await remove(request.sessionId)
        if (disposed) return false
        if (result?.deleted !== true || result.sessionId !== request.sessionId)
          throw new Error('未收到该对话的删除确认，请刷新列表后重试。')
        // Once the Host confirms deletion, a refresh failure must never offer
        // the destructive action again as though the deletion itself failed.
        let notice = null
        try {
          notice = (await afterDelete?.(request.sessionId)) || null
        } catch {
          notice = '本地对话记录已删除，列表未能完整刷新，请重新加载应用。'
        }
        if (result.cleanupPending)
          notice = '删除已生效，部分临时记录待清理，请重新加载应用完成清理。'
        publish({ request: null, busy: false, error: null, notice })
        return true
      } catch (reason) {
        publish({ busy: false, error: errorText(reason) })
        return false
      }
    },
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
  return controller
}

function errorText(reason) {
  const code = reason?.code ?? ''
  if (
    code === 'gateway/not-found' ||
    code === 'gateway/unknown-method' ||
    code === 'gateway/service-unavailable'
  )
    return '删除功能尚未加载，请重新加载插件后重试。'
  return reason?.message || '删除失败，请稍后重试。'
}

// This is the same unary carrier and envelope used by ClientRemoteService.
// No remote request is made until the user confirms the named conversation.
export function createDeleteTransport(connection, signal) {
  if (typeof connection?.rpc?.call !== 'function')
    throw new Error('当前应用暂不支持删除本地对话记录。')
  return async (sessionId) => {
    const result = await connection.rpc.call(
      '/api',
      'foldPolish/deleteConversation',
      { args: { sessionId } },
      signal,
    )
    if (!result?.ok) {
      const error = new Error(errorText(result?.error))
      error.code = result?.error?.code
      throw error
    }
    return result.value
  }
}

function selectedSessionId(uiWorkspace, sessions) {
  return (
    uiWorkspace.mainReference?.sessionId ??
    uiWorkspace.selection?.getSnapshot?.()?.sessionId ??
    Object.values(sessions.list.getSnapshot()?.byId ?? {}).find(
      (session) => (session.retainedBy?.mainView ?? 0) > 0,
    )?.id
  )
}

export async function finishConversationDeletion({
  sessionId,
  sessions,
  workspaces,
  uiWorkspace,
  signal,
}) {
  if (signal?.aborted) return null
  let incomplete = false
  const wasCurrent = selectedSessionId(uiWorkspace, sessions) === sessionId
  if (wasCurrent) {
    try {
      uiWorkspace.clearMain()
    } catch {
      incomplete = true
    }
  }
  // The Host also broadcasts this event. The local call closes the small gap
  // between its durable acknowledgement and that event reaching this renderer.
  try {
    if (sessions.list.getSnapshot()?.byId?.[sessionId])
      sessions.handleSessionRemoved?.(sessionId)
    await sessions.refresh()
  } catch {
    incomplete = true
  }
  // Only replace the selection that was actually deleted. A user navigating
  // elsewhere while the request completes must keep their new selection.
  if (
    !signal?.aborted &&
    wasCurrent &&
    selectedSessionId(uiWorkspace, sessions) === undefined
  ) {
    try {
      const archived = new Set(
        workspaces.list.getSnapshot()?.archivedSessionIds ?? [],
      )
      const next = Object.values(sessions.list.getSnapshot()?.byId ?? {})
        .filter(
          (session) =>
            session.id !== sessionId &&
            !session.blank &&
            session.origin !== 'subagent' &&
            !archived.has(session.id),
        )
        .sort(
          (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
        )[0]
      if (next) await uiWorkspace.openSession(next.id)
    } catch {
      incomplete = true
    }
  }
  return incomplete
    ? '本地对话记录已删除，列表未能完整刷新，请重新加载应用。'
    : null
}

export function createDeletePanel(React, primitives, controller) {
  const h = React.createElement
  const { MenuItemButton, Modal, Button } = primitives ?? {}
  if (!MenuItemButton || !Modal || !Button)
    throw new Error('当前应用暂不支持删除对话菜单。')
  const danger = { color: 'var(--dsw-alias-state-error-primary, #d45b60)' }

  function MenuItem({ sessionId, displayTitle, useMenuOpenState }) {
    const menu = useMenuOpenState?.()
    return h(
      MenuItemButton,
      {
        danger: true,
        separatorBefore: true,
        icon: h(
          'svg',
          {
            width: 14,
            height: 14,
            viewBox: '0 0 24 24',
            fill: 'none',
            'aria-hidden': true,
          },
          h('path', {
            d: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
        onSelect: () => {
          menu?.[1]?.(false)
          controller.request(sessionId, displayTitle)
        },
      },
      h('span', { 'data-lf-delete-menu': '1' }, '删除对话…'),
    )
  }

  function Dialog() {
    const [state, setState] = React.useState(controller.getSnapshot)
    React.useEffect(() => {
      const update = () => setState(controller.getSnapshot())
      const off = controller.subscribe(update)
      update()
      return off
    }, [])
    if (!state.request && !state.notice) return null
    const close = () => controller.cancel()
    const confirming = Boolean(state.request)
    return h(
      Modal,
      {
        open: true,
        onClose: close,
        closeLabel: '关闭',
        title: confirming ? '删除本地对话记录？' : '对话已删除',
        description: confirming
          ? `将永久删除“${state.request.displayTitle}”的本地对话记录，并从列表中移除。此操作无法撤销。`
          : undefined,
        footer: h(
          React.Fragment,
          null,
          h(
            Button,
            { variant: 'outline', disabled: state.busy, onClick: close },
            confirming ? '取消' : '关闭',
          ),
          confirming
            ? h(
                Button,
                {
                  variant: 'outline',
                  style: danger,
                  disabled: state.busy,
                  'data-lf-delete-confirm': '1',
                  onClick: () => void controller.confirm(),
                },
                state.busy ? '正在删除…' : '删除本地记录',
              )
            : null,
        ),
      },
      h(
        'div',
        {
          'data-lf-delete-dialog': '1',
          style: { fontSize: 13, lineHeight: 1.6 },
        },
        confirming ? h('p', null, '工作区文件、附件和其他对话会保留。') : null,
        state.busy ? h('div', { role: 'status' }, '正在删除本地记录…') : null,
        state.error
          ? h('div', { role: 'alert', style: danger }, state.error)
          : null,
        state.notice ? h('div', { role: 'status' }, state.notice) : null,
      ),
    )
  }
  return { MenuItem, Dialog }
}

export function installDeleteConversation({
  React,
  primitives,
  slots,
  connection,
  sessions,
  workspaces,
  uiWorkspace,
}) {
  if (!slots?.inject || !slots?.register) return () => {}
  const lifetime = new AbortController()
  const controller = createDeleteController({
    remove: createDeleteTransport(connection, lifetime.signal),
    getSession: (id) => sessions.list.getSnapshot()?.byId?.[id],
    afterDelete: (sessionId) =>
      finishConversationDeletion({
        sessionId,
        sessions,
        workspaces,
        uiWorkspace,
        signal: lifetime.signal,
      }),
  })
  const { MenuItem, Dialog } = createDeletePanel(React, primitives, controller)
  const cleanups = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    controller.dispose()
    lifetime.abort()
    for (const off of cleanups.reverse()) {
      try {
        off?.()
      } catch {
        /* remove the remaining contribution even if one slot has gone away */
      }
    }
  }
  const register = (name, id, component, order) =>
    slots.inject(name, () => slots.register({ name, id, order }, component))
  try {
    // This is also the menu rendered by recents and workspace-grouped rows.
    cleanups.push(
      register(
        'sidebar.workspaces.session.menu.item',
        'fold-polish-delete',
        MenuItem,
        500,
      ),
    )
    cleanups.push(
      register('shell.overlay', 'fold-polish-delete-confirm', Dialog, 500),
    )
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
