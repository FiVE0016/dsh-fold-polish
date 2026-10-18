import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalConversationDeletion } from '../src/delete-host.js'

const GENERATION = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u
const STAGED = '.dsh-fold-polish-delete--'
const JOURNAL = '.dsh-fold-polish-delete.json'

async function fixture(t, io = fs) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-delete-test-'))
  // realpath spelling matters on Windows, including temp-directory aliases.
  const root = await fs.realpath(temp)
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const id = 'chat-target'
  const header = {
    id,
    createdAt: 100,
    version: 4,
    cwd: path.join(root, 'workspace'),
    isSeeded: false,
  }
  const dir = path.join(root, 'project', id)
  const sibling = path.join(root, 'project', 'chat-child')
  await fs.mkdir(dir, { recursive: true })
  await fs.mkdir(sibling, { recursive: true })
  await fs.mkdir(header.cwd)
  const names = [
    'session.jsonl',
    'session.v1.jsonl',
    'session.v4.jsonl',
    'session.v4.jsonl.zstd',
  ]
  for (const name of names)
    await fs.writeFile(path.join(dir, name), JSON.stringify(header))
  await fs.writeFile(path.join(dir, 'attachment.bin'), 'attachment-preserved')
  await fs.writeFile(path.join(dir, 'session.v04.jsonl'), 'unknown-preserved')
  await fs.writeFile(
    path.join(sibling, 'session.v4.jsonl'),
    'self-contained-fork-history',
  )
  await fs.writeFile(
    path.join(header.cwd, 'project.txt'),
    'workspace-preserved',
  )
  const order = []
  const sessions = new Map()
  const agents = new Map()
  const cacheRows = new Map([
    [id, 'body checkpoint'],
    ['chat-child', 'child checkpoint'],
  ])
  const persistedRows = new Map([
    [id, 'body text'],
    ['chat-child', 'child text'],
  ])
  const liveRows = new Map([
    [id, 'body text'],
    ['chat-child', 'child text'],
  ])
  let state = {
    pinnedSessionIds: ['chat-child', id],
    archivedSessionIds: [id],
    workspaceIds: ['workspace'],
  }
  const entity = {
    id: 'workspace',
    record: {
      path: header.cwd,
      sessionIds: ['unknown-stale', id, 'chat-child'],
      updatedAt: 'before',
    },
  }
  const registry = {
    list: () => [entity],
    get pinnedSessionIds() {
      return state.pinnedSessionIds
    },
    get archivedSessionIds() {
      return state.archivedSessionIds
    },
    headers: new Map([
      [id, header],
      ['chat-child', { id: 'chat-child' }],
    ]),
    sessionPaths: new Map([
      [id, header.cwd],
      ['chat-child', header.cwd],
    ]),
    missingSessionPaths: new Set(),
    invalidSessionPaths: new Map(),
    requireTable: () => ({
      update: async (_id, mutate) => {
        order.push('workspace-update')
        return mutate(entity.record)
      },
    }),
    requireState: () => state,
    setState: async (next) => {
      state = next
    },
    enqueueOperation: (fn) => fn(),
  }
  let leaseHeld = false
  const persistence = {
    name: 'session-persistence-jsonl',
    root,
    compression: 'none',
    tracker: { writers: new Map() },
    coldLogMemo: new Map([[id, 'memo']]),
    migrationPreparations: new Map(),
    stat: async (sessionId) => {
      if (sessionId !== id) return undefined
      const present = (await fs.readdir(dir)).some((name) =>
        GENERATION.test(name),
      )
      return present
        ? { header, formatStatus: 'current', revision: 'same' }
        : undefined
    },
    findLog: async () => ({
      sourcePath: path.join(dir, 'session.v4.jsonl'),
      sourceVersion: 4,
    }),
    acquireLease: async (_id, _cwd, actual) => {
      assert.equal(actual, dir)
      assert.equal(leaseHeld, false)
      order.push('lock')
      leaseHeld = true
      return {
        release: async () => {
          order.push('unlock')
          leaseHeld = false
        },
      }
    },
  }
  let globalGeneration = 1
  const query = {
    _observations: {
      cache: new Map([
        [id, 'read cache'],
        ['chat-child', 'child read cache'],
      ]),
    },
    _globalGeneration: 1,
    _localGeneration: 1,
    _serialized: async (_signal, fn) => {
      order.push('index-mutex')
      return fn()
    },
    _ensureReady: async () => {
      order.push('index-open')
    },
    _mainGeneration: () => globalGeneration,
    _deleteSession: (tier, sessionId) => {
      order.push(`index-${tier}`)
      ;(tier === 'persisted' ? persistedRows : liveRows).delete(sessionId)
    },
    _requireDb: () => ({
      exec: (statement) => order.push(statement),
      prepare: () => ({
        run: () => {
          globalGeneration += 1
        },
      }),
    }),
  }
  const services = {
    sessionPersistence: persistence,
    sessions: { get: (key) => sessions.get(key) },
    agents: {
      get: (key) => agents.get(key),
      list: () => [...agents.values()],
      isOwnedBy: (_key, _owner) => false,
    },
    workspaceRegistry: registry,
    sessionController: { agents: { claims: new Map(), resumes: new Map() } },
    sessionProjectionCache: {
      table: {
        delete: async (key) => {
          order.push('cache-delete')
          cacheRows.delete(key)
        },
      },
    },
    sessionQuery: query,
  }
  const ctx = {
    invocation: { peer: { principal: { kind: 'owner' } } },
    get: (key) => services[key],
    waterfall: async (_event, _request, fallback) => fallback(),
    emit: (event, key) => order.push([event, key]),
    logger: { warn: () => {} },
  }
  const service = new LocalConversationDeletion(ctx, io)
  return {
    root,
    dir,
    sibling,
    names,
    id,
    header,
    services,
    service,
    ctx,
    sessions,
    agents,
    entity,
    registry,
    persistence,
    cacheRows,
    persistedRows,
    liveRows,
    query,
    order,
  }
}

test('permanent local deletion removes every history generation and exact caches, preserves files and forks', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await f.service.deleteConversation(f.id), {
    sessionId: f.id,
    deleted: true,
  })
  assert.equal(await f.persistence.stat(f.id), undefined)
  assert.deepEqual((await fs.readdir(f.dir)).sort(), [
    'attachment.bin',
    'session.v04.jsonl',
  ])
  assert.equal(
    await fs.readFile(path.join(f.sibling, 'session.v4.jsonl'), 'utf8'),
    'self-contained-fork-history',
  )
  assert.equal(
    await fs.readFile(path.join(f.header.cwd, 'project.txt'), 'utf8'),
    'workspace-preserved',
  )
  assert.deepEqual(f.entity.record.sessionIds, ['unknown-stale', 'chat-child'])
  assert.deepEqual(f.registry.pinnedSessionIds, ['chat-child'])
  assert.deepEqual(f.registry.archivedSessionIds, [])
  for (const rows of [
    f.cacheRows,
    f.persistedRows,
    f.liveRows,
    f.query._observations.cache,
  ]) {
    assert.equal(rows.has(f.id), false)
    assert.equal(rows.has('chat-child'), true)
  }
  assert.equal(f.registry.headers.has(f.id), false)
  assert.equal(f.registry.headers.has('chat-child'), true)
  assert.ok(f.order.indexOf('index-mutex') < f.order.indexOf('index-persisted'))
  assert.deepEqual(f.order.at(-2), ['api-session/removed', f.id])
  const restarted = new LocalConversationDeletion(f.ctx)
  await restarted.recoverPending()
  assert.equal(await f.persistence.stat(f.id), undefined)
})

test('hostile IDs and non-owner calls never touch files or metadata', async (t) => {
  const f = await fixture(t)
  for (const id of [
    '',
    '..',
    '../chat-target',
    '/tmp/a',
    'C:\\test',
    'x\u0000x',
    {},
  ]) {
    await assert.rejects(f.service.deleteConversation(id), {
      code: 'fold-polish/invalid-session',
    })
  }
  f.ctx.invocation.peer.principal.kind = 'guest'
  await assert.rejects(f.service.deleteConversation(f.id), {
    code: 'fold-polish/owner-required',
  })
  assert.deepEqual(f.order, [])
})

test('running target, child runtime, migrations and pending activation fail before teardown', async (t) => {
  const f = await fixture(t)
  f.agents.set(f.id, { id: f.id, status: 'running' })
  await assert.rejects(f.service.deleteConversation(f.id), {
    code: 'fold-polish/session-busy',
  })
  f.agents.clear()
  f.persistence.migrationPreparations.set('other', {})
  await assert.rejects(f.service.deleteConversation(f.id), {
    code: 'fold-polish/migration-busy',
  })
  f.persistence.migrationPreparations.clear()
  for (const key of ['claims', 'resumes']) {
    f.services.sessionController.agents[key].set(f.id, Promise.resolve())
    await assert.rejects(f.service.deleteConversation(f.id), {
      code: 'fold-polish/session-busy',
    })
    f.services.sessionController.agents[key].clear()
  }
  assert.deepEqual(f.order, [])
})

test('malformed source location and symlink directories are refused before closing a session', async (t) => {
  const f = await fixture(t)
  f.persistence.findLog = async () => ({
    sourcePath: path.join(f.root, 'session.v4.jsonl'),
  })
  await assert.rejects(f.service.deleteConversation(f.id), {
    code: 'fold-polish/unsafe-storage',
  })
  const linkDir = path.join(f.root, 'project', 'chat-link')
  await fs.symlink(f.dir, linkDir, 'junction')
  f.persistence.stat = async () => ({
    header: { ...f.header, id: 'chat-link' },
    formatStatus: 'current',
  })
  f.persistence.findLog = async () => ({
    sourcePath: path.join(linkDir, 'session.v4.jsonl'),
  })
  await assert.rejects(f.service.deleteConversation('chat-link'), {
    code: 'fold-polish/unsafe-storage',
  })
  assert.deepEqual(f.order, [])
})

test('foreign writer lease failure leaves all local records intact', async (t) => {
  const f = await fixture(t)
  f.persistence.acquireLease = async () => {
    throw Error('writer held')
  }
  await assert.rejects(f.service.deleteConversation(f.id), /writer held/)
  for (const name of f.names) await fs.access(path.join(f.dir, name))
  assert.ok(f.entity.record.sessionIds.includes(f.id))
})

test('second staging failure restores all generations and membership', async (t) => {
  let staged = 0
  const io = {
    ...fs,
    rename: async (from, to) => {
      if (path.basename(to).startsWith(STAGED) && ++staged === 2)
        throw Error('stage failure')
      return fs.rename(from, to)
    },
  }
  const f = await fixture(t, io)
  await assert.rejects(f.service.deleteConversation(f.id), /stage failure/)
  for (const name of f.names) await fs.access(path.join(f.dir, name))
  assert.deepEqual(f.entity.record.sessionIds, [
    'unknown-stale',
    f.id,
    'chat-child',
  ])
  assert.equal(
    (await fs.readdir(f.dir)).some(
      (name) => name.startsWith(STAGED) || name === JOURNAL,
    ),
    false,
  )
})

test('cache failure restores history and exact target membership without reporting success', async (t) => {
  const f = await fixture(t)
  f.services.sessionProjectionCache.table.delete = async () => {
    throw Error('cache denied')
  }
  await assert.rejects(f.service.deleteConversation(f.id), /cache denied/)
  for (const name of f.names) await fs.access(path.join(f.dir, name))
  assert.deepEqual(f.entity.record.sessionIds, [
    'unknown-stale',
    f.id,
    'chat-child',
  ])
  assert.deepEqual(f.registry.pinnedSessionIds, ['chat-child', f.id])
  assert.deepEqual(f.registry.archivedSessionIds, [f.id])
  assert.equal(
    f.order.some(
      (item) => Array.isArray(item) && item[0] === 'api-session/removed',
    ),
    false,
  )
})

test('post-commit cleanup failure reports logical removal and completes on restart', async (t) => {
  let fail = true
  const io = {
    ...fs,
    unlink: async (file) => {
      if (fail && path.basename(file).startsWith(STAGED))
        throw Object.assign(Error('access denied'), { code: 'EACCES' })
      return fs.unlink(file)
    },
  }
  const f = await fixture(t, io)
  assert.deepEqual(await f.service.deleteConversation(f.id), {
    sessionId: f.id,
    deleted: true,
    cleanupPending: true,
  })
  assert.equal(await f.persistence.stat(f.id), undefined)
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.dir, JOURNAL), 'utf8')).phase,
    'committed',
  )
  fail = false
  await new LocalConversationDeletion(f.ctx, io).recoverPending()
  assert.deepEqual((await fs.readdir(f.dir)).sort(), [
    'attachment.bin',
    'session.v04.jsonl',
  ])
})

test('post-commit release error never turns a completed deletion into a failed request', async (t) => {
  const f = await fixture(t)
  f.persistence.acquireLease = async () => ({
    release: async () => {
      throw Error('release failed')
    },
  })
  assert.deepEqual(await f.service.deleteConversation(f.id), {
    sessionId: f.id,
    deleted: true,
    cleanupPending: true,
  })
  assert.equal(await f.persistence.stat(f.id), undefined)
})

test('mismatched lifecycle metadata refuses an idle live target without touching its scope', async (t) => {
  const f = await fixture(t)
  let touched = false
  const agent = {
    id: f.id,
    status: 'idle',
    session: { id: f.id },
    scope: {
      dispose: () => {
        touched = true
      },
    },
  }
  f.agents.set(f.id, agent)
  f.sessions.set(f.id, agent.session)
  await assert.rejects(f.service.deleteConversation(f.id), {
    code: 'fold-polish/unsupported-lifecycle',
  })
  assert.equal(touched, false)
  for (const name of f.names) await fs.access(path.join(f.dir, name))
})

test('runtime-owned child rejects deletion even when the parent is idle', async (t) => {
  const f = await fixture(t)
  const parent = { id: f.id, status: 'idle' }
  const child = { id: 'chat-child', status: 'idle' }
  f.agents.set(f.id, parent)
  f.agents.set(child.id, child)
  f.services.agents.isOwnedBy = (id, owner) =>
    id === child.id && owner === parent
  await assert.rejects(f.service.deleteConversation(f.id), {
    code: 'fold-polish/child-busy',
  })
  assert.deepEqual(f.order, [])
})

test('a rollback interrupted by an I/O failure is completed safely on plugin restart', async (t) => {
  let staged = 0
  const io = {
    ...fs,
    rename: async (from, to) => {
      if (path.basename(to).startsWith(STAGED) && ++staged === 2) {
        throw Error('second staging failed')
      }
      if (path.basename(from).startsWith(STAGED)) {
        throw Error('rollback temporarily blocked')
      }
      return fs.rename(from, to)
    },
  }
  const f = await fixture(t, io)
  await assert.rejects(f.service.deleteConversation(f.id), /删除未完成/)
  const journal = JSON.parse(
    await fs.readFile(path.join(f.dir, JOURNAL), 'utf8'),
  )
  assert.equal(journal.phase, 'prepared')
  await new LocalConversationDeletion(f.ctx).recoverPending()
  for (const name of f.names) await fs.access(path.join(f.dir, name))
  assert.deepEqual(f.entity.record.sessionIds, [
    'unknown-stale',
    f.id,
    'chat-child',
  ])
  assert.equal(
    (await fs.readdir(f.dir)).some((name) => name.startsWith(STAGED)),
    false,
  )
})

test('committed recovery refuses to delete a newly created record under the same ID', async (t) => {
  const io = {
    ...fs,
    unlink: async (file) => {
      if (path.basename(file).startsWith(STAGED)) throw Error('cleanup blocked')
      return fs.unlink(file)
    },
  }
  const f = await fixture(t, io)
  assert.equal((await f.service.deleteConversation(f.id)).cleanupPending, true)
  const newRecord = path.join(f.dir, 'session.v4.jsonl')
  await fs.writeFile(newRecord, 'new lifecycle must remain')
  await assert.rejects(new LocalConversationDeletion(f.ctx).recoverPending(), {
    code: 'fold-polish/recovery-conflict',
  })
  assert.equal(
    await fs.readFile(newRecord, 'utf8'),
    'new lifecycle must remain',
  )
})

test('linked history files are refused and no other file is removed', async (t) => {
  const f = await fixture(t)
  const original = path.join(f.dir, 'session.v4.jsonl')
  const external = path.join(f.root, 'external-copy.txt')
  await fs.link(original, external)
  await assert.rejects(f.service.deleteConversation(f.id), {
    code: 'fold-polish/unsafe-storage',
  })
  assert.equal(await fs.readFile(external, 'utf8'), JSON.stringify(f.header))
  for (const name of f.names) await fs.access(path.join(f.dir, name))
})
