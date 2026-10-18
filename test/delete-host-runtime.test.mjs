import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
} from 'node:fs'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalConversationDeletion } from '../src/delete-host.js'
import { apply as applyPlugin } from '../index.js'

// Compatibility evidence against the locally installed Host runtime. This suite
// imports library source into an isolated Context; it never contacts the app or
// reads/writes its conversation storage. Other environments skip these checks.
const archive =
  process.env.DSH_HOST_ASAR ||
  (process.env.LOCALAPPDATA
    ? path.join(
        process.env.LOCALAPPDATA,
        'Programs',
        'DeepSeek Harness',
        'resources',
        'app.asar',
      )
    : '')

function archiveReader(file) {
  const fd = openSync(file, 'r')
  const prefix = Buffer.alloc(16)
  readSync(fd, prefix, 0, 16, 0)
  const json = Buffer.alloc(prefix.readUInt32LE(12))
  readSync(fd, json, 0, json.length, 16)
  const header = JSON.parse(json.toString('utf8'))
  const offset = 8 + prefix.readUInt32LE(4)
  return {
    read(key) {
      let item = header
      for (const part of key.split('/')) item = item.files?.[part]
      assert.ok(item, `Installed Host module exists: ${key}`)
      if (item.unpacked)
        return readFileSync(path.join(`${file}.unpacked`, key), 'utf8')
      const buffer = Buffer.alloc(item.size)
      readSync(fd, buffer, 0, buffer.length, offset + Number(item.offset))
      return buffer.toString('utf8')
    },
    close() {
      closeSync(fd)
    },
  }
}

const dataModule = (source) =>
  `data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=isolated-host-runtime.js\n`).toString('base64')}`
let runtime
async function hostRuntime() {
  if (runtime) return runtime
  const reader = archiveReader(archive)
  try {
    const source = (name) =>
      reader.read(`dsh/node_modules/@deepseek-ai/${name}/lib/index.js`)
    const cosmos = dataModule(source('cosmokit'))
    const cordisUrl = dataModule(
      source('cordis').replaceAll(
        '"@deepseek-ai/cosmokit"',
        JSON.stringify(cosmos),
      ),
    )
    const scopeUrl = dataModule(
      source('dsh-scope').replaceAll(
        '"@deepseek-ai/cordis"',
        JSON.stringify(cordisUrl),
      ),
    )
    const protocolUrl = dataModule(
      source('dsh-typert-protocol').replaceAll(
        '"@deepseek-ai/cordis"',
        JSON.stringify(cordisUrl),
      ),
    )
    const schemastery = dataModule(
      reader
        .read('dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs')
        .replaceAll('"@deepseek-ai/cosmokit"', JSON.stringify(cosmos)),
    )
    // No connection/webServer service is provided, so these transports must not
    // instantiate. The dispatcher, argument binding and error codec are real.
    const forbiddenWebsocket = dataModule(
      'export default class WebSocket { constructor() { throw Error("Network disabled in isolated runtime test") } }; export class WebSocketServer { constructor() { throw Error("Network disabled in isolated runtime test") } }',
    )
    let gatewaySource = source('dsh-api-gateway')
    for (const [specifier, url] of [
      ['@deepseek-ai/cordis', cordisUrl],
      ['@deepseek-ai/dsh-typert-protocol', protocolUrl],
      ['@deepseek-ai/dsh-deque', dataModule(source('dsh-deque'))],
      ['@deepseek-ai/dsh-timeout', dataModule(source('dsh-timeout'))],
      ['@deepseek-ai/schemastery', schemastery],
      ['ws', forbiddenWebsocket],
    ])
      gatewaySource = gatewaySource.replaceAll(
        JSON.stringify(specifier),
        JSON.stringify(url),
      )
    const [cordis, scope, protocol, gateway] = await Promise.all([
      import(cordisUrl),
      import(scopeUrl),
      import(protocolUrl),
      import(dataModule(gatewaySource)),
    ])
    const agentLoopSource = source('dsh-agent-loop')
    const prepareStart = agentLoopSource.indexOf(
      '\tprepare(ownerCtx, id, options, session, callerSignal, handle, parentAgent) {',
    )
    const prepareEnd = agentLoopSource.indexOf(
      '\n\t/**\n\t* Create an agent and session under one caller-supplied identity',
      prepareStart,
    )
    assert.ok(
      prepareStart > 0 && prepareEnd > prepareStart,
      'Installed Host factory preparation has the verified source boundary',
    )
    const prepareModule = await import(
      dataModule(
        `export function factory(ReactLoopAgent, assertAgentOptions, INACTIVE_STATES, throwCollectedFailures) { return class ExtractedAgentFactory { ${agentLoopSource.slice(prepareStart, prepareEnd)} } }`,
      )
    )
    runtime = {
      ...cordis,
      ...scope,
      ...protocol,
      ...gateway,
      actualPrepareFactory: prepareModule.factory,
    }
    return runtime
  } finally {
    reader.close()
  }
}

const skip = !archive || !existsSync(archive)

test(
  'installed Cordis carries owner invocation and actual Typert reads deletion markers',
  { skip },
  async () => {
    const { Context, remoteMethods } = await hostRuntime()
    const ctx = new Context()
    ctx.accessor('invocation', { get: () => undefined })
    const service = new LocalConversationDeletion(ctx)
    service.ready = Promise.resolve()
    service.deleteOne = async (sessionId) => ({
      sessionId,
      deleted: true,
      principal: service.ctx.invocation?.peer?.principal?.kind,
    })
    ctx.provide('foldPolish', service)
    const markers = remoteMethods(service)
    assert.equal(markers.length, 1)
    assert.equal(markers[0].method, 'deleteConversation')
    assert.deepEqual(markers[0].invocation, { kind: 'direct' })
    assert.equal(
      markers[0].resources.session('sample-session'),
      'sample-session',
    )
    assert.equal(service.typertRemote.namespace, 'foldPolish')
    assert.equal(service.typertRemote.service, service)

    let reached = 0
    service.deleteOne = async function (sessionId) {
      reached += 1
      return {
        sessionId,
        deleted: true,
        principal: this.ctx.invocation.peer.principal.kind,
      }
    }
    const owner = ctx.extend({
      invocation: { peer: { principal: { kind: 'owner' } } },
    })
    assert.deepEqual(
      await owner.get('foldPolish').deleteConversation('sample-session'),
      {
        sessionId: 'sample-session',
        deleted: true,
        principal: 'owner',
      },
    )
    const guest = ctx.extend({
      invocation: { peer: { principal: { kind: 'grant' } } },
    })
    await assert.rejects(
      guest.get('foldPolish').deleteConversation('sample-session'),
      { code: 'fold-polish/owner-required' },
    )
    assert.equal(reached, 1)
    await ctx.fiber.dispose()
  },
)

test(
  'installed Gateway source-mode binds flat payload, signal and owner context with real boundary errors',
  { skip },
  async () => {
    const { Context, TypertGatewayService } = await hostRuntime()
    const ctx = new Context()
    ctx.accessor('invocation', { get: () => undefined })
    ctx.provide('typert', {
      local: { get: () => undefined, hasSeen: () => false },
      lookups: { definitions: () => [], get: () => undefined },
      contexts: { getHost: () => undefined },
      resources: { entries: () => [['session', 'sessionId']] },
    })
    ctx.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) })
    const service = new LocalConversationDeletion(ctx)
    service.ready = Promise.resolve()
    const signal = new AbortController().signal
    let reached = 0
    service.deleteOne = async function (sessionId, observedSignal) {
      reached += 1
      assert.equal(observedSignal, signal)
      assert.equal(this.ctx.invocation.peer.principal.kind, 'owner')
      return { sessionId, deleted: true }
    }
    ctx.provide('foldPolish', service)
    const gateway = new TypertGatewayService(ctx, {
      websocketHeartbeatIntervalMs: 1000,
      streamInboxBytes: 1024,
    })
    const owner = {
      signal: new AbortController().signal,
      principal: { kind: 'owner' },
    }
    const call = (
      payload,
      peer = owner,
      endpoint = 'foldPolish/deleteConversation',
    ) => gateway.dispatchRpc(endpoint, payload, signal, peer)
    try {
      assert.equal(
        gateway.claimsEndpoint('foldPolish/deleteConversation'),
        true,
      )
      assert.deepEqual(await call({ args: { sessionId: 'sample-session' } }), {
        ok: true,
        value: { sessionId: 'sample-session', deleted: true },
      })
      assert.equal(reached, 1)
      const cases = [
        [{ args: { sessionId: '../outside' } }, 'fold-polish/invalid-session'],
        [{ args: { sessionId: {} } }, 'fold-polish/invalid-session'],
        [{ args: {} }, 'fold-polish/invalid-session'],
        [
          { args: { sessionId: 'sample-session', unexpected: 1 } },
          'gateway/arguments-invalid',
        ],
        [{ sessionId: 'sample-session' }, 'gateway/internal'],
      ]
      for (const [payload, code] of cases) {
        const result = await call(payload)
        assert.equal(result.ok, false)
        assert.equal(result.error.code, code)
      }
      const guest = {
        signal: new AbortController().signal,
        principal: { kind: 'grant', grantId: 'synthetic-grant' },
      }
      const denied = await call(
        { args: { sessionId: 'sample-session' } },
        guest,
      )
      assert.equal(denied.ok, false)
      assert.equal(denied.error.code, 'fold-polish/owner-required')
      assert.equal(reached, 1)
      const unknown = await call(
        { args: { sessionId: 'sample-session' } },
        owner,
        'foldPolish/unknown',
      )
      assert.equal(unknown.ok, false)
      assert.equal(unknown.error.code, 'gateway/invocation-unavailable')
    } finally {
      await ctx.fiber.dispose()
    }
  },
)

test(
  'installed Cordis exact parent lifecycle closes writer before synthetic records are removed',
  { skip },
  async () => {
    const { Context, createScope } = await hostRuntime()
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'dsh-delete-host-runtime-'),
    )
    const id = 'runtime-session'
    const dir = path.join(root, 'synthetic-project', id)
    await fs.mkdir(dir, { recursive: true })
    const log = path.join(dir, 'session.v4.jsonl')
    await fs.writeFile(log, 'synthetic test record')
    const ctx = new Context()
    let loopCtx
    const loopFiber = ctx.plugin((child) => {
      loopCtx = child
    })
    await Promise.resolve(loopFiber)
    const header = { id, createdAt: 1, cwd: root, isSeeded: false, version: 4 }
    const session = { id, header }
    const sessions = new Map([[id, session]])
    const agents = new Map()
    const writers = new Map([[id, {}]])
    const events = []
    const scope = createScope(loopCtx, id)
    const agent = {
      id,
      status: 'idle',
      inbox: { hasPending: false },
      session,
      scope,
    }
    agents.set(id, agent)
    let lifecycleComplete = false
    loopCtx.effect(function* () {
      yield scope.rawDispose
      yield async () => {
        events.push('lifecycle')
        await scope.dispose()
        await Promise.resolve()
        writers.delete(id)
        agents.delete(id)
        sessions.delete(id)
        lifecycleComplete = true
      }
    }, `agentLoop.scope(${id})`)
    const state = {
      workspaceIds: [],
      pinnedSessionIds: [],
      archivedSessionIds: [],
    }
    ctx.provide('agentLoop', { runtime: { ctx: loopCtx } })
    ctx.provide('agents', {
      get: (key) => agents.get(key),
      list: () => [...agents.values()],
      isOwnedBy: () => false,
    })
    ctx.provide('sessions', { get: (key) => sessions.get(key) })
    ctx.provide('workspaceRegistry', {
      list: () => [],
      pinnedSessionIds: [],
      archivedSessionIds: [],
      headers: new Map([[id, header]]),
      sessionPaths: new Map(),
      missingSessionPaths: new Set(),
      invalidSessionPaths: new Map(),
      enqueueOperation: (operation) => operation(),
      requireTable: () => ({}),
      requireState: () => state,
      setState: async () => {},
    })
    ctx.provide('sessionPersistence', {
      name: 'session-persistence-jsonl',
      root,
      compression: 'none',
      tracker: { writers },
      coldLogMemo: new Map(),
      findLog: async () => ({
        sourcePath: log,
        sourceVersion: 4,
        currentPath: log,
      }),
      stat: async () => ({ header, formatStatus: 'current' }),
      acquireLease: async () => {
        assert.equal(lifecycleComplete, true)
        assert.equal(writers.has(id), false)
        assert.equal(await fs.readFile(log, 'utf8'), 'synthetic test record')
        events.push('lease')
        return {
          release: async () => {
            events.push('release')
          },
        }
      },
    })
    ctx.accessor('invocation', { get: () => undefined })
    const service = new LocalConversationDeletion(ctx)
    service.ready = Promise.resolve()
    const io = {
      ...fs,
      unlink: async (file) => {
        assert.equal(lifecycleComplete, true)
        return fs.unlink(file)
      },
    }
    service.io = io
    ctx.provide('foldPolish', service)
    const owner = ctx.extend({
      invocation: { peer: { principal: { kind: 'owner' } } },
    })
    try {
      assert.deepEqual(await owner.get('foldPolish').deleteConversation(id), {
        sessionId: id,
        deleted: true,
      })
      assert.deepEqual(events, ['lifecycle', 'lease', 'release'])
      assert.equal(sessions.has(id), false)
      assert.equal(agents.has(id), false)
      assert.deepEqual(await fs.readdir(dir), [])
    } finally {
      await ctx.fiber.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

test(
  'installed AgentLoop.prepare actual teardown drains driver, closes a real temporary writer and detaches before lease',
  { skip },
  async () => {
    const { Context, createScope, actualPrepareFactory } = await hostRuntime()
    const temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), 'dsh-delete-prepare-runtime-'),
    )
    const root = await fs.realpath(temporary)
    const id = 'actual-prepare-session'
    const dir = path.join(root, 'synthetic-project', id)
    await fs.mkdir(dir, { recursive: true })
    const log = path.join(dir, 'session.v4.jsonl')
    await fs.writeFile(log, 'synthetic actual-prepare record')
    const fileHandle = await fs.open(log, 'r+')
    const ctx = new Context()
    let loopCtx
    const loopFiber = ctx.plugin((child) => {
      loopCtx = child
    })
    await Promise.resolve(loopFiber)
    const header = { id, createdAt: 1, cwd: root, isSeeded: false, version: 4 }
    const session = { id, header }
    const sessions = new Map()
    const agents = new Map()
    const writers = new Map([[id, fileHandle]])
    const order = []
    ctx.provide('sessions', {
      get: (key) => sessions.get(key),
      enter(value) {
        sessions.set(value.id, value)
        return () => {
          order.push('detach-session')
          sessions.delete(value.id)
        }
      },
      announce() {},
    })
    ctx.provide('agents', {
      get: (key) => agents.get(key),
      list: () => [...agents.values()],
      isOwnedBy: () => false,
      enter(value) {
        agents.set(value.id, value)
        return () => {
          order.push('detach-agent')
          agents.delete(value.id)
        }
      },
      async announce() {},
    })
    class DriverWithoutModel {
      constructor(context, agentId, options, value) {
        this.id = agentId
        this.options = options
        this.session = value
        this.scope = createScope(context, this)
        this.ctx = this.scope.ctx
        this.status = 'idle'
        this.inbox = { hasPending: false }
        this.phase = { kind: 'idle' }
        this.ctx.effect(() => () => {
          order.push('scope')
        })
      }
      cancel(cause) {
        assert.equal(cause.kind, 'disposed')
        order.push('cancel')
      }
      async whenIdle() {
        await Promise.resolve()
        order.push('idle')
      }
    }
    const Factory = actualPrepareFactory(
      DriverWithoutModel,
      () => {},
      new Set([4, 5]),
      (failures) => {
        if (failures.length) throw new AggregateError(failures)
      },
    )
    const factory = new Factory()
    factory.runtime = { ctx: loopCtx }
    factory.ownership = {
      signal: new AbortController().signal,
      isActive: () => true,
      track: () => () => {
        order.push('untrack')
      },
    }
    ctx.provide('agentLoop', factory)
    const prepared = factory.prepare(ctx, id, {}, session, undefined, {
      async close() {
        await fileHandle.close()
        writers.delete(id)
        order.push('writer-close')
      },
    })
    await prepared.publish('startup')
    const state = {
      workspaceIds: [],
      pinnedSessionIds: [],
      archivedSessionIds: [],
    }
    ctx.provide('workspaceRegistry', {
      list: () => [],
      pinnedSessionIds: [],
      archivedSessionIds: [],
      headers: new Map([[id, header]]),
      sessionPaths: new Map(),
      missingSessionPaths: new Set(),
      invalidSessionPaths: new Map(),
      enqueueOperation: (operation) => operation(),
      requireTable: () => ({}),
      requireState: () => state,
      setState: async () => {},
    })
    ctx.provide('sessionPersistence', {
      name: 'session-persistence-jsonl',
      root,
      compression: 'none',
      tracker: { writers },
      coldLogMemo: new Map(),
      findLog: async () => ({
        sourcePath: log,
        sourceVersion: 4,
        currentPath: log,
      }),
      stat: async () => ({ header, formatStatus: 'current' }),
      acquireLease: async () => {
        assert.equal(fileHandle.fd, -1)
        assert.equal(sessions.has(id), false)
        assert.equal(agents.has(id), false)
        assert.deepEqual(order, [
          'cancel',
          'idle',
          'scope',
          'writer-close',
          'detach-agent',
          'detach-session',
          'untrack',
        ])
        order.push('lease')
        return {
          release: async () => {
            order.push('release')
          },
        }
      },
    })
    ctx.accessor('invocation', { get: () => undefined })
    const deletion = new LocalConversationDeletion(ctx)
    deletion.ready = Promise.resolve()
    ctx.provide('foldPolish', deletion)
    const owner = ctx.extend({
      invocation: { peer: { principal: { kind: 'owner' } } },
    })
    try {
      assert.deepEqual(await owner.get('foldPolish').deleteConversation(id), {
        sessionId: id,
        deleted: true,
      })
      assert.deepEqual(await fs.readdir(dir), [])
      assert.deepEqual(order.slice(-2), ['lease', 'release'])
    } finally {
      await ctx.fiber.dispose()
      await fileHandle.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

test(
  'plugin optional injection mounts and unmounts with actual installed Cordis',
  { skip },
  async () => {
    const { Context } = await hostRuntime()
    const temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), 'dsh-delete-mount-runtime-'),
    )
    const ctx = new Context()
    const fiber = ctx.plugin(applyPlugin)
    assert.equal(ctx.get('foldPolish'), undefined)
    const providers = {
      sessionPersistence: {
        name: 'session-persistence-jsonl',
        root: temporary,
        compression: 'none',
        tracker: { writers: new Map() },
        coldLogMemo: new Map(),
        findLog: async () => undefined,
        stat: async () => undefined,
        acquireLease: async () => {
          throw Error(
            'No lease should be acquired during empty synthetic recovery',
          )
        },
      },
      sessions: { get: () => undefined },
      agents: {},
      workspaceRegistry: {},
      typert: {},
      agentLoop: {},
      sessionController: {},
      sessionQuery: {},
      storageDomain: {},
    }
    let releaseAccepted
    try {
      for (const [name, value] of Object.entries(providers))
        ctx.provide(name, value)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(ctx.get('foldPolish'), undefined)
      ctx.provide('sessionProjectionCache', {})
      for (
        let attempt = 0;
        !ctx.get('foldPolish') && attempt < 10;
        attempt += 1
      )
        await new Promise((resolve) => setImmediate(resolve))
      const service = ctx.get('foldPolish')
      assert.ok(service)
      await service.ready
      assert.equal(service.pending.size, 0)
      let entered
      const hasEntered = new Promise((resolve) => {
        entered = resolve
      })
      const acceptedGate = new Promise((resolve) => {
        releaseAccepted = resolve
      })
      service.deleteOne = async (sessionId) => {
        entered()
        await acceptedGate
        return { sessionId, deleted: true }
      }
      const owner = ctx.extend({
        invocation: { peer: { principal: { kind: 'owner' } } },
      })
      const caller = owner.get('foldPolish')
      const accepted = caller.deleteConversation('accepted-before-reload')
      await hasEntered
      let unloadFinished = false
      const unloading = Promise.resolve(fiber.dispose()).then(() => {
        unloadFinished = true
      })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(unloadFinished, false)
      assert.equal(service.closing, true)
      assert.equal(service.tasks.size, 1)
      await assert.rejects(caller.deleteConversation('new-during-reload'), {
        code: 'fold-polish/plugin-closing',
      })
      releaseAccepted()
      assert.deepEqual(await accepted, {
        sessionId: 'accepted-before-reload',
        deleted: true,
      })
      await unloading
      assert.equal(service.tasks.size, 0)
      assert.equal(service.pending.size, 0)
      assert.equal(ctx.get('foldPolish'), undefined)
    } finally {
      releaseAccepted?.()
      await ctx.fiber.dispose()
      await fs.rm(temporary, { recursive: true, force: true })
    }
  },
)
