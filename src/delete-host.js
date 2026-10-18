import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const SERVICE = 'foldPolish'
const EFFECT = Symbol.for('cordis.effect')
const JOURNAL = '.dsh-fold-polish-delete.json'
const STAGED = '.dsh-fold-polish-delete--'
const GENERATION = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u
const MAGIC = 'dsh-fold-polish/local-conversation-delete/v1'

export class ConversationDeleteError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ConversationDeleteError'
    this.code = `fold-polish/${code}`
    this.details = {}
    this.isDSHRemoteError = true
  }
}

function refuse(code, message) {
  throw new ConversationDeleteError(code, message)
}

function validateId(id) {
  if (
    typeof id !== 'string' ||
    !/^[A-Za-z0-9._-]{1,200}$/u.test(id) ||
    id === '.' ||
    id === '..'
  ) {
    refuse('invalid-session', '对话标识无效。')
  }
  return id
}

async function exists(io, file) {
  try {
    return await io.lstat(file)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Require precisely root/project/session, with no links at any level. */
async function checkedDirectory(io, root, dir, id) {
  root = path.resolve(root)
  dir = path.resolve(dir)
  if (path.dirname(path.dirname(dir)) !== root || path.basename(dir) !== id) {
    refuse('unsafe-storage', '无法确认这条对话的独立本地记录位置，已取消删除。')
  }
  for (const part of [root, path.dirname(dir), dir]) {
    const info = await io.lstat(part)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      path.resolve(await io.realpath(part)) !== part
    ) {
      refuse(
        'unsafe-storage',
        '对话记录目录包含链接或不是独立目录，已取消删除。',
      )
    }
  }
  return dir
}

function assertBackend(persistence) {
  if (
    persistence?.name !== 'session-persistence-jsonl' ||
    typeof persistence.root !== 'string' ||
    !['none', 'zstd', undefined].includes(persistence.compression) ||
    !['findLog', 'stat', 'acquireLease'].every(
      (key) => typeof persistence[key] === 'function',
    ) ||
    !persistence.tracker?.writers ||
    !persistence.coldLogMemo
  ) {
    refuse('unsupported-host', '当前 DSH 的本地记录格式暂不支持删除。')
  }
}

function lifecycleDisposer(ctx, id, agent) {
  const fiber = ctx.get('agentLoop')?.runtime?.ctx?.fiber
  const child = agent.scope?.rawDispose?.[EFFECT]
  if (
    !fiber ||
    agent.scope?.ctx?.fiber?.parent?.fiber !== fiber ||
    !child ||
    !fiber._disposables
  ) {
    refuse(
      'unsupported-lifecycle',
      '当前 DSH 无法安全关闭这条对话，已取消删除。',
    )
  }
  // This exact parent effect owns cancel -> idle -> scope -> writer -> registries.
  // Calling only agent.scope.dispose() leaves the writer and registry alive.
  const matches = [...fiber._disposables].filter((dispose) => {
    const meta = dispose[EFFECT]
    return (
      meta?.label === `agentLoop.scope(${id})` && meta.children?.includes(child)
    )
  })
  if (matches.length !== 1)
    refuse(
      'unsupported-lifecycle',
      '无法确认这条对话的独立生命周期，已取消删除。',
    )
  return matches[0]
}

function assertIdle(ctx, id) {
  const registry = ctx.get('agents')
  const agent = registry.get(id)
  const session = ctx.get('sessions').get(id)
  if (session && (!agent || agent.session !== session))
    refuse('session-busy', '这条对话仍在使用中，请稍后再删除。')
  if (!agent) return undefined
  if (
    agent.status !== 'idle' ||
    agent.inbox?.hasPending ||
    agent.phase?.kind === 'maintenance'
  ) {
    refuse('session-busy', '这条对话正在处理任务，请等待任务结束后再删除。')
  }
  if (
    registry
      .list()
      .some((child) => child !== agent && registry.isOwnedBy(child.id, agent))
  ) {
    refuse('child-busy', '这条对话还有运行中的子对话，请先等待它们结束。')
  }
  return { agent, dispose: lifecycleDisposer(ctx, id, agent) }
}

function snapshotMetadata(registry, id, header) {
  return {
    header,
    memberships: registry.list().flatMap((entity) => {
      const index = entity.record?.sessionIds?.indexOf(id) ?? -1
      return index < 0 ? [] : [{ workspaceId: entity.id, index }]
    }),
    pinnedIndex: registry.pinnedSessionIds.indexOf(id),
    archivedIndex: registry.archivedSessionIds.indexOf(id),
  }
}

function insertAt(ids, id, index) {
  const next = ids.filter((item) => item !== id)
  next.splice(Math.min(index, next.length), 0, id)
  return next
}

/** Change only the selected ID, preserving unrelated stale workspace entries. */
async function updateMetadata(ctx, id, snapshot) {
  const registry = ctx.get('workspaceRegistry')
  await registry.enqueueOperation(async () => {
    const table = registry.requireTable()
    for (const entity of registry.list()) {
      const member = snapshot?.memberships.find(
        (item) => item.workspaceId === entity.id,
      )
      const current = entity.record.sessionIds
      if (snapshot ? !member : !current.includes(id)) continue
      const next = await table.update(entity.id, (record) => ({
        ...record,
        sessionIds: snapshot
          ? insertAt(record.sessionIds, id, member.index)
          : record.sessionIds.filter((item) => item !== id),
        updatedAt: new Date().toISOString(),
      }))
      entity.record = next
    }
    const state = registry.requireState()
    await registry.setState({
      ...state,
      pinnedSessionIds: snapshot
        ? snapshot.pinnedIndex < 0
          ? state.pinnedSessionIds
          : insertAt(state.pinnedSessionIds, id, snapshot.pinnedIndex)
        : state.pinnedSessionIds.filter((item) => item !== id),
      archivedSessionIds: snapshot
        ? snapshot.archivedIndex < 0
          ? state.archivedSessionIds
          : insertAt(state.archivedSessionIds, id, snapshot.archivedIndex)
        : state.archivedSessionIds.filter((item) => item !== id),
    })
  })
  if (snapshot) {
    registry.headers.set(id, snapshot.header)
    if (snapshot.header.cwd) registry.sessionPaths.set(id, snapshot.header.cwd)
  } else {
    registry.headers.delete(id)
    registry.sessionPaths.delete(id)
    registry.missingSessionPaths.delete(id)
    registry.invalidSessionPaths.delete(id)
  }
}

async function removeCache(ctx, id) {
  const cache = ctx.get('sessionProjectionCache')
  const domain = ctx.get('storageDomain')?.get('session_projcache')
  if (domain?.chain) await domain.chain
  const table = cache?.table ?? domain?.table('sessions')
  if (cache && !table?.delete)
    refuse('unsupported-cache', '无法清理这条对话的本地索引。')
  if (table) await table.delete(id)
  const query = ctx.get('sessionQuery')
  // The SQLite engine stores message text in ordinary FTS rows. Purge only this
  // identity under its own mutex; opening its schema does not reconcile others.
  if (query?._serialized) {
    const required = [
      '_ensureReady',
      '_requireDb',
      '_deleteSession',
      '_mainGeneration',
    ]
    if (!required.every((key) => typeof query[key] === 'function')) {
      refuse('unsupported-index', '当前 DSH 无法安全清理这条对话的搜索索引。')
    }
    await query._serialized(undefined, async () => {
      await query._ensureReady(undefined)
      const db = query._requireDb()
      db.exec('BEGIN IMMEDIATE')
      try {
        query._deleteSession('persisted', id)
        query._deleteSession('live', id)
        db.prepare(
          'UPDATE search_state SET global_generation = global_generation + 1 WHERE singleton = 1',
        ).run()
        db.exec('COMMIT')
        query._globalGeneration += 1
        query._localGeneration = Math.max(
          query._localGeneration,
          query._mainGeneration(),
        )
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    })
  }
  query?._observations?.cache?.delete(id)
}

async function writeJournal(io, dir, journal) {
  const file = path.join(dir, JOURNAL)
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await io.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(journal))
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await io.rename(temporary, file)
  } catch (error) {
    await io.unlink(temporary).catch(() => {})
    throw error
  }
}

async function rollback(io, dir, journal) {
  for (const name of journal.files) {
    const original = path.join(dir, name)
    const staged = path.join(dir, STAGED + name)
    const info = await exists(io, staged)
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        refuse('unsafe-recovery', '待恢复的对话记录不是独立的普通文件。')
      if (await exists(io, original))
        refuse(
          'recovery-conflict',
          '记录恢复遇到冲突，请保留此对话并稍后重试。',
        )
      await io.rename(staged, original)
    } else {
      const originalInfo = await exists(io, original)
      if (!originalInfo)
        refuse(
          'recovery-missing',
          '部分对话记录缺失，已保留恢复记录，请稍后检查。',
        )
      if (
        !originalInfo.isFile() ||
        originalInfo.isSymbolicLink() ||
        originalInfo.nlink !== 1
      )
        refuse('unsafe-recovery', '待恢复的原始记录不是独立的普通文件。')
    }
  }
}

export class LocalConversationDeletion {
  constructor(ctx, io = fs) {
    this.ctx = ctx
    this.io = io
    this.pending = new Set()
    this.tasks = new Set()
    this.closing = false
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SERVICE,
      namespace: SERVICE,
    })
    Object.defineProperty(this, Symbol.for('cordis.tracker'), {
      value: { associate: SERVICE, property: 'ctx' },
    })
  }

  async deleteConversation(sessionId, signal) {
    const invocation = this.ctx.invocation
    if (invocation?.peer?.principal?.kind !== 'owner')
      refuse('owner-required', '只有当前设备的拥有者可以删除本地对话。')
    if (this.closing)
      refuse('plugin-closing', '插件正在重新加载，请稍后再删除。')
    const id = validateId(sessionId)
    if (this.pending.has(id)) refuse('delete-busy', '这条对话正在删除中。')
    this.pending.add(id)
    let finish
    const task = new Promise((resolve) => {
      finish = resolve
    })
    this.tasks.add(task)
    try {
      await this.ready
      return await this.deleteOne(id, signal)
    } finally {
      this.pending.delete(id)
      this.tasks.delete(task)
      finish()
    }
  }

  async deleteOne(id, signal) {
    const ctx = this.ctx
    const io = this.io
    const persistence = ctx.get('sessionPersistence')
    assertBackend(persistence)
    signal?.throwIfAborted()
    if (persistence.migrationPreparations?.size)
      refuse('migration-busy', '本地记录正在升级，请稍后再删除。')
    const controller = ctx.get('sessionController')
    if (
      controller?.agents?.claims?.has(id) ||
      controller?.agents?.resumes?.has(id)
    )
      refuse('session-busy', '这条对话正在打开中，请稍后再删除。')
    const activity = await ctx.waterfall(
      'workspace/session-activity',
      { sessionId: id },
      () => Promise.resolve([]),
    )
    if (activity.length)
      refuse('session-busy', '这条对话仍有任务在运行，请等待结束后再删除。')
    const live = assertIdle(ctx, id)
    const before = await persistence.stat(id, { signal })
    if (!before) refuse('not-found', '这条对话的本地记录已经不存在。')
    if (before.formatStatus !== 'current')
      refuse('legacy-record', '请先打开这条旧版对话完成记录升级，再删除。')
    if (before.header.id !== id || before.header.origin === 'subagent')
      refuse('unsupported-session', '这类子任务记录不能从普通对话菜单删除。')
    const selected = await persistence.findLog(id, signal)
    if (!selected)
      refuse('not-materialized', '这条对话尚未保存为独立记录，请稍后重试。')
    const dir = await checkedDirectory(
      io,
      persistence.root,
      path.dirname(selected.sourcePath),
      id,
    )
    const metadata = snapshotMetadata(
      ctx.get('workspaceRegistry'),
      id,
      before.header,
    )
    if (await exists(io, path.join(dir, JOURNAL)))
      refuse('recovery-required', '上次删除尚未完成，请重新加载插件后重试。')
    signal?.throwIfAborted()
    const latest = assertIdle(ctx, id)
    if (
      latest?.agent !== live?.agent ||
      controller?.agents?.claims?.has(id) ||
      controller?.agents?.resumes?.has(id)
    )
      refuse('session-busy', '对话状态已变化，请稍后重试。')
    if (latest) await latest.dispose()
    if (
      ctx.get('sessions').get(id) ||
      ctx.get('agents').get(id) ||
      persistence.tracker.writers.has(id)
    )
      refuse('session-busy', '未能安全关闭这条对话，本地记录尚未删除。')
    const lease = await persistence.acquireLease(id, before.header.cwd, dir)
    let committed = false
    let result
    try {
      await checkedDirectory(io, persistence.root, dir, id)
      const after = await persistence.stat(id)
      if (
        !after ||
        after.header.createdAt !== before.header.createdAt ||
        after.header.id !== id
      )
        refuse('session-changed', '对话记录已经变化，请重新确认后删除。')
      if (persistence.tracker.writers.has(id) || ctx.get('sessions').get(id))
        refuse('session-busy', '这条对话又被打开了，请稍后再删除。')
      if (
        persistence.migrationPreparations?.size ||
        controller?.agents?.claims?.has(id) ||
        controller?.agents?.resumes?.has(id)
      )
        refuse('session-busy', '对话记录正在使用中，请稍后重试。')
      const files = (await io.readdir(dir)).filter((name) =>
        GENERATION.test(name),
      )
      if (!files.includes(path.basename(selected.sourcePath)))
        refuse('session-changed', '对话记录已经变化，请重新确认。')
      for (const name of files) {
        const info = await io.lstat(path.join(dir, name))
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          refuse(
            'unsafe-storage',
            '对话记录文件不是独立的普通文件，已取消删除。',
          )
        if (typeof persistence.readGenerationHeader === 'function') {
          const version = Number(
            /^session(?:\.v([1-9][0-9]*))?\.jsonl/u.exec(name)[1] ?? 0,
          )
          const generation = await persistence.readGenerationHeader(
            { sourcePath: path.join(dir, name), sourceVersion: version },
            id,
          )
          if (generation?.header?.id !== id)
            refuse(
              'unsafe-storage',
              '对话记录中存在无法确认归属的旧版本文件，已取消删除。',
            )
        }
        if (await exists(io, path.join(dir, STAGED + name)))
          refuse('recovery-required', '发现未完成的删除操作，请重新加载插件。')
      }
      const journal = { magic: MAGIC, phase: 'prepared', id, files, metadata }
      await writeJournal(io, dir, journal)
      try {
        for (const name of files)
          await io.rename(path.join(dir, name), path.join(dir, STAGED + name))
        persistence.coldLogMemo.delete(id)
        await updateMetadata(ctx, id)
        await removeCache(ctx, id)
        journal.phase = 'committed'
        await writeJournal(io, dir, journal)
        committed = true
      } catch (error) {
        try {
          await rollback(io, dir, journal)
          await updateMetadata(ctx, id, metadata)
          await io.unlink(path.join(dir, JOURNAL))
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            '删除未完成，已保留恢复记录；请重新加载插件。',
          )
        }
        throw error
      }
      // No recursive removal: preserve attachments and every unknown artifact.
      let cleanupPending = false
      try {
        for (const name of files) await io.unlink(path.join(dir, STAGED + name))
        await io.unlink(path.join(dir, JOURNAL))
      } catch (error) {
        cleanupPending = true
        ctx.logger?.warn(
          `对话已移除，剩余记录将在重新加载插件时清理：${error.message}`,
        )
      }
      persistence.coldLogMemo.delete(id)
      try {
        ctx.emit('api-session/removed', id)
      } catch (error) {
        ctx.logger?.warn(error.message)
      }
      result = {
        sessionId: id,
        deleted: true,
        ...(cleanupPending ? { cleanupPending: true } : {}),
      }
      return result
    } finally {
      try {
        await lease.release()
      } catch (error) {
        if (!committed) throw error
        if (result) result.cleanupPending = true
        ctx.logger?.warn(`对话已移除，但记录锁释放失败：${error.message}`)
      }
    }
  }

  async recoverPending() {
    const ctx = this.ctx
    const io = this.io
    const persistence = ctx.get('sessionPersistence')
    assertBackend(persistence)
    const root = persistence.root
    const rootInfo = await exists(io, root)
    if (!rootInfo) return
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return
    for (const project of await io.readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue
      const projectPath = path.join(root, project.name)
      for (const session of await io.readdir(projectPath, {
        withFileTypes: true,
      })) {
        if (!session.isDirectory() || session.isSymbolicLink()) continue
        const dir = path.join(projectPath, session.name)
        const journalPath = path.join(dir, JOURNAL)
        const info = await exists(io, journalPath)
        if (!info) continue
        if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
          refuse('unsafe-recovery', '无法安全读取未完成的对话删除记录。')
        const journal = JSON.parse(await io.readFile(journalPath, 'utf8'))
        if (
          journal.magic !== MAGIC ||
          validateId(journal.id) !== session.name ||
          !['prepared', 'committed'].includes(journal.phase) ||
          !Array.isArray(journal.files) ||
          !journal.files.length ||
          new Set(journal.files).size !== journal.files.length ||
          !journal.files.every(
            (name) => typeof name === 'string' && GENERATION.test(name),
          ) ||
          journal.metadata?.header?.id !== journal.id ||
          !Array.isArray(journal.metadata.memberships) ||
          !journal.metadata.memberships.every(
            (member) =>
              typeof member.workspaceId === 'string' &&
              Number.isSafeInteger(member.index) &&
              member.index >= 0,
          ) ||
          ![journal.metadata.pinnedIndex, journal.metadata.archivedIndex].every(
            (index) => Number.isSafeInteger(index) && index >= -1,
          )
        ) {
          refuse('unsafe-recovery', '未完成的对话删除记录格式无效。')
        }
        await checkedDirectory(io, root, dir, journal.id)
        if (
          ctx.get('sessions').get(journal.id) ||
          persistence.tracker.writers.has(journal.id)
        )
          refuse(
            'recovery-busy',
            '上次删除的对话正在使用中，请关闭应用后再重新加载。',
          )
        const lease = await persistence.acquireLease(
          journal.id,
          journal.metadata.header.cwd,
          dir,
        )
        try {
          await checkedDirectory(io, root, dir, journal.id)
          if (
            ctx.get('sessions').get(journal.id) ||
            persistence.tracker.writers.has(journal.id)
          )
            refuse(
              'recovery-busy',
              '上次删除的对话正在使用中，请稍后重新加载。',
            )
          const currentFiles = (await io.readdir(dir)).filter((name) =>
            GENERATION.test(name),
          )
          if (
            journal.phase === 'committed'
              ? currentFiles.length
              : currentFiles.some((name) => !journal.files.includes(name))
          ) {
            refuse(
              'recovery-conflict',
              '这条对话出现了新的记录，已停止自动清理。',
            )
          }
          if (journal.phase === 'prepared') {
            await rollback(io, dir, journal)
            await updateMetadata(ctx, journal.id, journal.metadata)
          } else {
            await updateMetadata(ctx, journal.id)
            await removeCache(ctx, journal.id)
            for (const name of journal.files) {
              const file = path.join(dir, STAGED + name)
              const fileInfo = await exists(io, file)
              if (!fileInfo) continue
              if (
                !fileInfo.isFile() ||
                fileInfo.isSymbolicLink() ||
                fileInfo.nlink !== 1
              )
                refuse(
                  'unsafe-recovery',
                  '待清理的记录文件不是独立的普通文件。',
                )
              await io.unlink(file)
            }
            ctx.emit('api-session/removed', journal.id)
          }
          persistence.coldLogMemo.delete(journal.id)
          await io.unlink(journalPath)
        } finally {
          await lease.release()
        }
      }
    }
  }
}

Object.defineProperty(
  LocalConversationDeletion.prototype,
  '@deepseek-ai/dsh-typert-protocol/remote-methods',
  {
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        Object.freeze({
          method: 'deleteConversation',
          invocation: Object.freeze({ kind: 'direct' }),
          resources: Object.freeze({ session: (sessionId) => sessionId }),
        }),
      ]),
    }),
  },
)

export function installLocalConversationDeletion(ctx) {
  if (!Object.hasOwn(ctx.root.reflect.props, 'invocation'))
    ctx.root.accessor('invocation', { get: () => undefined })
  const service = new LocalConversationDeletion(ctx)
  service.ready = service.recoverPending()
  service.ready.catch((error) =>
    ctx.logger.warn(`本地对话删除恢复未完成：${error.message}`),
  )
  ctx.provide(SERVICE, service)
  // Effects unwind in reverse: finish accepted requests before withdrawing the
  // endpoint on plugin reload. Provider failure still has the durable journal.
  ctx.effect(
    () => async () => {
      service.closing = true
      await Promise.allSettled([service.ready, ...service.tasks])
    },
    'foldPolish.pendingDeletes',
  )
  return service
}
