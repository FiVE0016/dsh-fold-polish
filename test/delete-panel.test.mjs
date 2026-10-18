import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDeleteController,
  createDeleteTransport,
  finishConversationDeletion,
  createDeletePanel,
  installDeleteConversation,
} from '../src/delete-panel.js'

const pending = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup(options = {}) {
  const rows = new Map([
    ['one', { id: 'one', title: '第一个对话', blank: false, running: false }],
    ['two', { id: 'two', title: '第二个对话', blank: false, running: false }],
  ])
  const calls = [],
    refreshed = []
  const controller = createDeleteController({
    getSession: (id) => rows.get(id),
    remove: async (id) => {
      calls.push(id)
      return options.remove
        ? options.remove(id)
        : { sessionId: id, deleted: true }
    },
    afterDelete: async (id) => {
      refreshed.push(id)
      await options.afterDelete?.(id)
    },
  })
  return { controller, rows, calls, refreshed }
}

test('opening and cancelling a named deletion dialog never sends a deletion request', async () => {
  const { controller, calls, refreshed } = setup()
  controller.request('one', '第一个对话')
  assert.equal(controller.getSnapshot().request.sessionId, 'one')
  assert.equal(controller.getSnapshot().request.displayTitle, '第一个对话')
  assert.deepEqual(calls, [])
  controller.cancel()
  assert.equal(controller.getSnapshot().request, null)
  await controller.confirm()
  assert.deepEqual(calls, [])
  assert.deepEqual(refreshed, [])
  controller.dispose()
})

test('confirmation deletes only the captured identity then refreshes the conversation list', async () => {
  const { controller, calls, refreshed } = setup()
  controller.request('one', '第一个对话')
  await controller.confirm()
  assert.deepEqual(calls, ['one'])
  assert.deepEqual(refreshed, ['one'])
  assert.equal(controller.getSnapshot().request, null)
  assert.equal(controller.getSnapshot().busy, false)
  controller.dispose()
})

test('double confirmation and changing the pending target cannot issue a second deletion', async () => {
  const wait = pending()
  const { controller, calls, refreshed } = setup({ remove: () => wait.promise })
  controller.request('one', '第一个对话')
  const first = controller.confirm()
  assert.equal(controller.getSnapshot().busy, true)
  const second = controller.confirm()
  controller.request('two', '第二个对话')
  controller.cancel()
  assert.equal(controller.getSnapshot().request.sessionId, 'one')
  wait.resolve({ sessionId: 'one', deleted: true })
  await Promise.all([first, second])
  assert.deepEqual(calls, ['one'])
  assert.deepEqual(refreshed, ['one'])
  controller.dispose()
})

test('a newly running or already absent conversation fails confirmation without deleting anything', async () => {
  for (const state of ['running', 'missing', 'blank', 'wrong-id']) {
    const { controller, calls, rows, refreshed } = setup()
    controller.request('one', '第一个对话')
    if (state === 'missing') rows.delete('one')
    else
      rows.set('one', {
        ...rows.get('one'),
        ...(state === 'running' ? { running: true } : {}),
        ...(state === 'blank' ? { blank: true } : {}),
        ...(state === 'wrong-id' ? { id: 'two' } : {}),
      })
    await controller.confirm()
    assert.deepEqual(calls, [], state)
    assert.deepEqual(refreshed, [], state)
    assert.equal(controller.getSnapshot().busy, false, state)
    controller.dispose()
  }
})

test('server failure keeps the named dialog open and permits an explicit retry', async () => {
  let fail = true
  const { controller, calls, refreshed } = setup({
    remove: async (id) => {
      if (fail) throw new Error('对话正在使用中，请稍后重试')
      return { sessionId: id, deleted: true }
    },
  })
  controller.request('one', '第一个对话')
  await controller.confirm()
  assert.equal(controller.getSnapshot().request.sessionId, 'one')
  assert.equal(controller.getSnapshot().busy, false)
  assert.match(controller.getSnapshot().error, /正在使用中/)
  assert.deepEqual(refreshed, [])
  fail = false
  await controller.confirm()
  assert.deepEqual(calls, ['one', 'one'])
  assert.deepEqual(refreshed, ['one'])
  assert.equal(controller.getSnapshot().request, null)
  controller.dispose()
})

test('a malformed success or response naming another conversation never changes the list', async () => {
  for (const result of [
    null,
    {},
    { sessionId: 'two', deleted: true },
    { sessionId: 'one', deleted: false },
  ]) {
    const { controller, refreshed } = setup({ remove: () => result })
    controller.request('one', '第一个对话')
    await controller.confirm()
    assert.deepEqual(refreshed, [])
    assert.equal(controller.getSnapshot().request.sessionId, 'one')
    assert.ok(controller.getSnapshot().error)
    assert.equal(controller.getSnapshot().busy, false)
    controller.dispose()
  }
})

test('unmount during a deletion cannot navigate or update the disposed confirmation UI', async () => {
  const wait = pending()
  const { controller, calls, refreshed } = setup({ remove: () => wait.promise })
  controller.request('one', '第一个对话')
  const first = controller.confirm()
  controller.dispose()
  wait.resolve({ sessionId: 'one', deleted: true })
  await first
  controller.request('two', '第二个对话')
  await controller.confirm()
  assert.deepEqual(calls, ['one'])
  assert.deepEqual(refreshed, [])
})

test('a completed deletion with a list-refresh error cannot be retried as a new deletion', async () => {
  const { controller, calls } = setup({
    afterDelete: () => {
      throw new Error('列表同步失败')
    },
  })
  controller.request('one', '第一个对话')
  await controller.confirm()
  assert.equal(controller.getSnapshot().request, null)
  assert.equal(controller.getSnapshot().busy, false)
  await controller.confirm()
  assert.deepEqual(calls, ['one'])
  controller.dispose()
})

test('post-commit cleanup pending is a successful deletion with a visible notice, not a destructive retry', async () => {
  const { controller, calls, refreshed } = setup({
    remove: async (id) => ({
      sessionId: id,
      deleted: true,
      cleanupPending: true,
    }),
  })
  controller.request('one', '第一个对话')
  await controller.confirm()
  assert.equal(controller.getSnapshot().request, null)
  assert.equal(controller.getSnapshot().error, null)
  assert.match(controller.getSnapshot().notice, /临时记录待清理/)
  assert.deepEqual(refreshed, ['one'])
  await controller.confirm()
  assert.deepEqual(calls, ['one'])
  controller.dispose()
})

test('synchronous teardown from a busy notification cannot send a deletion after disposal', async () => {
  const { controller, calls } = setup()
  controller.request('one', '第一个对话')
  controller.subscribe(() => {
    if (controller.getSnapshot().busy) controller.dispose()
  })
  await controller.confirm()
  assert.deepEqual(calls, [])
})

test('deletion transport uses the existing authenticated API carrier with only a session identity', async () => {
  const requests = []
  const remove = createDeleteTransport({
    rpc: {
      call: async (...args) => {
        requests.push(args)
        return { ok: true, value: { sessionId: 'one', deleted: true } }
      },
    },
  })
  assert.deepEqual(requests, [])
  assert.deepEqual(await remove('one'), { sessionId: 'one', deleted: true })
  const [[path, method, body]] = requests
  assert.equal(path, '/api')
  assert.equal(method, 'foldPolish/deleteConversation')
  assert.deepEqual(body, { args: { sessionId: 'one' } })
})

test('transport errors stay errors instead of presenting a false deletion success', async () => {
  for (const response of [
    { ok: false, error: { code: 'fold-polish/busy', message: '对话仍在运行' } },
    { value: { sessionId: 'one', deleted: true } },
    null,
  ]) {
    const remove = createDeleteTransport({
      rpc: { call: async () => response },
    })
    await assert.rejects(() => remove('one'))
  }
})

function selectionFixture(selected = 'one') {
  const rows = {
    one: { id: 'one', title: '删除目标', blank: false, updatedAt: 1 },
    two: { id: 'two', title: '保留对话', blank: false, updatedAt: 2 },
    child: { id: 'child', origin: 'subagent', blank: false, updatedAt: 100 },
    archived: { id: 'archived', blank: false, updatedAt: 200 },
    blank: { id: 'blank', blank: true, updatedAt: 300 },
  }
  const events = []
  const sessions = {
    list: { getSnapshot: () => ({ byId: rows }) },
    handleSessionRemoved(id) {
      events.push(['remove', id])
      delete rows[id]
    },
    async refresh() {
      events.push(['refresh'])
    },
  }
  const uiWorkspace = {
    mainReference: selected ? { sessionId: selected } : undefined,
    clearMain() {
      events.push(['clear'])
      this.mainReference = undefined
    },
    async openSession(id) {
      events.push(['open', id])
      this.mainReference = { sessionId: id }
    },
  }
  const workspaces = {
    list: { getSnapshot: () => ({ archivedSessionIds: ['archived'] }) },
  }
  const finish = (signal) =>
    finishConversationDeletion({
      sessionId: 'one',
      sessions,
      workspaces,
      uiWorkspace,
      signal,
    })
  return { rows, events, sessions, workspaces, uiWorkspace, finish }
}

test('deleting a different conversation refreshes its row without changing the current selection', async () => {
  const env = selectionFixture('two')
  assert.equal(await env.finish(), null)
  assert.deepEqual(env.events, [['remove', 'one'], ['refresh']])
  assert.equal(env.uiWorkspace.mainReference.sessionId, 'two')
  assert.ok(env.rows.two)
})

test('after deleting the displayed conversation a normal retained conversation is selected', async () => {
  const env = selectionFixture()
  assert.equal(await env.finish(), null)
  assert.deepEqual(env.events, [
    ['clear'],
    ['remove', 'one'],
    ['refresh'],
    ['open', 'two'],
  ])
  assert.equal(env.uiWorkspace.mainReference.sessionId, 'two')
})

test('a selection change during list refresh is preserved', async () => {
  const env = selectionFixture()
  const wait = pending()
  env.sessions.refresh = () => wait.promise
  const operation = env.finish()
  env.uiWorkspace.mainReference = { sessionId: 'different-user-selection' }
  wait.resolve()
  await operation
  assert.equal(
    env.uiWorkspace.mainReference.sessionId,
    'different-user-selection',
  )
  assert.equal(
    env.events.some((event) => event[0] === 'open'),
    false,
  )
})

test('unloading the feature while refreshing cannot open another conversation', async () => {
  const env = selectionFixture()
  const wait = pending(),
    lifetime = new AbortController()
  env.sessions.refresh = () => wait.promise
  const operation = env.finish(lifetime.signal)
  lifetime.abort()
  wait.resolve()
  await operation
  assert.equal(
    env.events.some((event) => event[0] === 'open'),
    false,
  )
})

test('failed asynchronous navigation reports incomplete refresh without an unhandled rejection', async () => {
  const env = selectionFixture()
  env.uiWorkspace.openSession = async () => {
    throw new Error('navigation unavailable')
  }
  assert.match(await env.finish(), /已删除.*刷新/)
  assert.equal(env.rows.one, undefined)
  assert.ok(env.rows.two)
})

const fakeReact = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children,
  }),
  useState: (initial) => [
    typeof initial === 'function' ? initial() : initial,
    () => {},
  ],
  useEffect() {},
}
const primitives = {
  MenuItemButton: 'menu-item',
  Modal: 'modal',
  Button: 'button',
}

test('the native menu opens an independent named dialog and cancel leaves records untouched', () => {
  const { controller, calls } = setup()
  const panel = createDeletePanel(fakeReact, primitives, controller)
  let menuOpen = true
  const item = panel.MenuItem({
    sessionId: 'one',
    displayTitle: '第一个对话',
    useMenuOpenState: () => [
      menuOpen,
      (value) => {
        menuOpen = value
      },
    ],
  })
  assert.equal(item.type, 'menu-item')
  item.props.onSelect()
  assert.equal(menuOpen, false)
  const dialog = panel.Dialog()
  assert.equal(dialog.type, 'modal')
  assert.match(dialog.props.description, /第一个对话/)
  assert.equal(dialog.props.open, true)
  assert.deepEqual(calls, [])
  dialog.props.onClose()
  assert.equal(controller.getSnapshot().request, null)
  assert.deepEqual(calls, [])
  controller.dispose()
})

test('optional menu installation cleans up its first slot if the overlay slot fails', () => {
  const registered = [],
    removed = []
  const slots = {
    inject(name, mount) {
      mount()
      return () => removed.push(name)
    },
    register(options) {
      registered.push(options.name)
      if (options.name === 'shell.overlay')
        throw new Error('overlay unavailable')
      return () => {}
    },
  }
  const env = selectionFixture()
  assert.throws(
    () =>
      installDeleteConversation({
        React: fakeReact,
        primitives,
        slots,
        connection: {
          rpc: {
            call() {
              throw new Error('unexpected request')
            },
          },
        },
        sessions: env.sessions,
        workspaces: env.workspaces,
        uiWorkspace: env.uiWorkspace,
      }),
    /overlay unavailable/,
  )
  assert.deepEqual(registered, [
    'sidebar.workspaces.session.menu.item',
    'shell.overlay',
  ])
  assert.deepEqual(removed, ['sidebar.workspaces.session.menu.item'])
})
