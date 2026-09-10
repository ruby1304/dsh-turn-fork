/** Browser controller for one session's Timeline projection and branch mutations. */
import type {
  ISessions,
  SessionFace,
  SessionListState,
  SessionEventSource,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import {
  TURN_FORK_PATH,
  type AssistantMessageTurn,
  type CascadePolicy,
  type EditableMessageBlock,
  type MutationError,
  type RetryableTurn,
  type TimelinePayload,
  type TurnForkLocaleKey,
  type TurnForkOperation,
  type TurnForkOperationResult,
  type VersionOperation,
  type VersionSummary,
} from '../shared.ts'
import { sessionRevision } from './revision.ts'

/** Browser context narrowed away from the host SessionStore augmentation. */
type ClientContext = Omit<Context, 'sessions'> & { readonly sessions: ISessions }

/** Reactive controller state shared by the Timeline and header entries. */
export interface TurnForkState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  migration: boolean
  pending: VersionOperation | 'cancel' | null
  timeline: TimelinePayload | null
}

/** Merge a burst of turn completions into one refresh. */
const REFRESH_DELAY_MS = 300

/** Plain business face; the renderer binds the reserved source compartment. */
export interface TurnForkFace {
  hooks: { turnFork: ObservableSnapshot<TurnForkState> }
  t: Translate<TurnForkLocaleKey>
  acquire(): () => void
  load(): void
  edit(message: EditableMessageBlock, text: string, cascade: CascadePolicy): Promise<boolean>
  retry(turn: number, cascade: CascadePolicy): Promise<boolean>
  reroll(): Promise<boolean>
  retryByMessageId(messageId: string, cascade: CascadePolicy): Promise<boolean>
  rerollByMessageId(messageId: string): Promise<boolean>
  openVersion(sessionId: string): Promise<void>
  stopBranch(sessionId: string): Promise<boolean>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} 不是对象`)
  }
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} 不是字符串`)
  return value
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} 不是数字`)
  return value
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} 不是布尔值`)
  return value
}

function optionalOperation(value: unknown): VersionOperation | undefined {
  if (value === undefined) return undefined
  if (value === 'edit' || value === 'reroll' || value === 'retry') return value
  throw new TypeError('版本 operation 无效')
}

function optionalCascade(value: unknown): CascadePolicy | undefined {
  if (value === undefined) return undefined
  if (value === 'truncate' || value === 'preserve') return value
  throw new TypeError('版本 cascade 无效')
}

function decodeMessage(value: unknown, index: number): EditableMessageBlock {
  const row = objectValue(value, `messages[${String(index)}]`)
  return {
    key: stringValue(row['key'], '消息 key'),
    turn: numberValue(row['turn'], '消息 turn'),
    eventSeq: numberValue(row['eventSeq'], '消息 eventSeq'),
    blockIndex: numberValue(row['blockIndex'], '消息 blockIndex'),
    kind: 'user',
    text: stringValue(row['text'], '消息 text'),
    time: numberValue(row['time'], '消息 time'),
  }
}

function decodeRetryable(value: unknown, index: number): RetryableTurn {
  const row = objectValue(value, `retryableTurns[${String(index)}]`)
  return {
    turn: numberValue(row['turn'], '回合 turn'),
    userEventSeq: numberValue(row['userEventSeq'], '回合 userEventSeq'),
    preview: stringValue(row['preview'], '回合 preview'),
    time: numberValue(row['time'], '回合 time'),
  }
}

function decodeAssistantTurn(value: unknown, index: number): AssistantMessageTurn {
  const row = objectValue(value, `assistantMessageTurns[${String(index)}]`)
  return {
    messageId: stringValue(row['messageId'], '助手消息 messageId'),
    turn: numberValue(row['turn'], '助手消息 turn'),
    eventSeq: numberValue(row['eventSeq'], '助手消息 eventSeq'),
  }
}

function decodeVersion(value: unknown, index: number): VersionSummary {
  const row = objectValue(value, `versions[${String(index)}]`)
  const operation = optionalOperation(row['operation'])
  const cascade = optionalCascade(row['cascade'])
  const targetTurn = row['targetTurn'] === undefined ? undefined : numberValue(row['targetTurn'], '版本 targetTurn')
  const before = row['before'] === undefined ? undefined : stringValue(row['before'], '版本 before')
  const after = row['after'] === undefined ? undefined : stringValue(row['after'], '版本 after')
  return {
    sessionId: stringValue(row['sessionId'], '版本 sessionId'),
    ...row['parentSessionId'] === undefined
      ? {}
      : { parentSessionId: stringValue(row['parentSessionId'], '版本 parentSessionId') },
    ...row['effectId'] === undefined
      ? {}
      : { effectId: stringValue(row['effectId'], '版本 effectId') },
    ...row['inverseSessionId'] === undefined
      ? {}
      : { inverseSessionId: stringValue(row['inverseSessionId'], '版本 inverseSessionId') },
    createdAt: numberValue(row['createdAt'], '版本 createdAt'),
    depth: numberValue(row['depth'], '版本 depth'),
    current: booleanValue(row['current'], '版本 current'),
    onCurrentEffectPath: booleanValue(row['onCurrentEffectPath'], '版本 onCurrentEffectPath'),
    ...operation === undefined ? {} : { operation },
    ...cascade === undefined ? {} : { cascade },
    ...targetTurn === undefined ? {} : { targetTurn },
    ...before === undefined ? {} : { before },
    ...after === undefined ? {} : { after },
  }
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} 不是数组`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  return arrayValue(value, label).map((item, index) => stringValue(item, `${label}[${String(index)}]`))
}

function decodeTimeline(value: unknown): TimelinePayload {
  const data = objectValue(value, 'Timeline 响应')
  return {
    sessionId: stringValue(data['sessionId'], 'Timeline sessionId'),
    messages: arrayValue(data['messages'], 'Timeline messages').map(decodeMessage),
    retryableTurns: arrayValue(data['retryableTurns'], 'Timeline retryableTurns').map(decodeRetryable),
    assistantMessageTurns: arrayValue(data['assistantMessageTurns'], 'Timeline assistantMessageTurns').map(decodeAssistantTurn),
    versions: arrayValue(data['versions'], 'Timeline versions').map(decodeVersion),
    undoStack: stringArray(data['undoStack'], 'Timeline undoStack'),
    redoSessionIds: stringArray(data['redoSessionIds'], 'Timeline redoSessionIds'),
    running: stringArray(data['running'], 'Timeline running'),
  }
}

function lineageRevision(snapshot: SessionListState, sessionId: SessionId): string {
  let root = sessionId
  const ancestorIds = new Set<SessionId>()
  while (!ancestorIds.has(root)) {
    ancestorIds.add(root)
    const parent = snapshot.byId[root]?.parentId
    if (parent === undefined || snapshot.byId[parent] === undefined) break
    root = parent
  }

  const connected: string[] = []
  for (const rawId of Object.keys(snapshot.byId).sort()) {
    const id = rawId as SessionId
    const seen = new Set<SessionId>()
    let cursor: SessionId | undefined = id
    while (cursor !== undefined && !seen.has(cursor)) {
      if (cursor === root) {
        connected.push(`${id}>${snapshot.byId[id]?.parentId ?? ''}`)
        break
      }
      seen.add(cursor)
      cursor = snapshot.byId[cursor]?.parentId
    }
  }
  return connected.join('|')
}

/** One stable controller is shared by all entries mounted for the same session. */
export class TurnForkController {
  readonly store: SnapshotStore<TurnForkState> = createSnapshotStore<TurnForkState>({
    status: 'idle',
    error: null,
    migration: false,
    pending: null,
    timeline: null,
  })

  readonly face: TurnForkFace
  private generation = 0
  private readonly ctx: ClientContext
  private readonly sessions: ISessions
  private sessionSource: SessionFace | undefined
  private sessionSourceDispose: (() => void) | undefined
  private eventSource: SessionEventSource | undefined
  private eventSourceDispose: (() => void) | undefined
  private sessionRevision: string | undefined
  private listRevision = ''
  private refreshScheduled = false
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private observing = false
  private readonly navigationWaits = new Set<() => void>()
  private disposeObservation: (() => Promise<void>) | undefined = undefined
  private inflight: Promise<void> | null = null
  private rerunAfter = false
  private abort: AbortController | null = null
  private disposed = false
  private users = 0

  constructor(
    ctx: ClientContext,
    private readonly sessionId: SessionId,
    private readonly t: Translate<TurnForkLocaleKey>,
  ) {
    this.ctx = ctx
    this.sessions = ctx.sessions
    this.face = {
      hooks: { turnFork: this.store },
      t: this.t,
      acquire: () => {
        this.users += 1
        if (this.users === 1 && this.disposed) this.revive()
        return () => this.release()
      },
      load: () => { void this.load() },
      edit: (message, text, cascade) => this.mutate({
        action: 'edit',
        sessionId: this.sessionId,
        eventSeq: message.eventSeq,
        blockIndex: message.blockIndex,
        text,
        cascade,
      }),
      retry: (turn, cascade) => this.mutate({
        action: 'retry',
        sessionId: this.sessionId,
        turn,
        cascade,
      }),
      reroll: () => this.mutate({ action: 'reroll', sessionId: this.sessionId }),
      retryByMessageId: (messageId, cascade) => this.retryForMessageId(messageId, cascade),
      rerollByMessageId: messageId => this.rerollForMessageId(messageId),
      openVersion: sessionId => this.openWhenListed(sessionId as SessionId),
      stopBranch: sessionId => this.cancelBranch(sessionId as SessionId),
    }
    this.observe()
  }

  private observe(): void {
    this.disposeObservation = this.ctx.effect(
      () => this.observeDependencies(),
      `turn-fork: observe ${this.sessionId}`,
    )
  }

  private release(): void {
    this.users -= 1
    if (this.users <= 0) this.dispose()
  }

  /** Tear subscriptions down once no mounted entry uses this controller. */
  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
      this.refreshScheduled = false
    }
    this.abort?.abort()
    this.abort = null
    void this.disposeObservation?.()
    this.disposeObservation = undefined
  }

  /** Re-observe after a transient zero; the retained store keeps old data
   * until the immediate refetch below commits. */
  private revive(): void {
    this.disposed = false
    this.observe()
    this.refresh()
  }

  /** Bind to replaceable value sources instead of retaining a Session object. */
  private observeDependencies(): () => void {
    this.observing = true
    this.listRevision = lineageRevision(this.sessions.list.getSnapshot(), this.sessionId)
    this.bindSessionSource()
    const disposeList = this.sessions.list.subscribe(() => {
      const rebound = this.bindSessionSource()
      const nextRevision = lineageRevision(this.sessions.list.getSnapshot(), this.sessionId)
      if (nextRevision === this.listRevision && !rebound) return
      this.listRevision = nextRevision
      this.invalidate()
    })
    return () => {
      this.observing = false
      this.generation += 1
      disposeList()
      this.sessionSourceDispose?.()
      this.eventSourceDispose?.()
      this.sessionSourceDispose = undefined
      this.eventSourceDispose = undefined
      this.sessionSource = undefined
      this.eventSource = undefined
      this.sessionRevision = undefined
      for (const cancel of [...this.navigationWaits]) cancel()
    }
  }

  private bindSessionSource(): boolean {
    const binding = this.sessions.binding(this.sessionId)
    const source = binding?.session
    const events = binding?.eventSource
    if (source === this.sessionSource && events === this.eventSource) return false
    this.sessionSourceDispose?.()
    this.eventSourceDispose?.()
    this.sessionSource = source
    this.eventSource = events
    this.sessionRevision = source === undefined
      ? undefined
      : sessionRevision(source.getSnapshot(), events?.getSnapshot().revision ?? 0)
    const invalidateSource = (): void => {
      if (this.sessionSource !== source || this.eventSource !== events || source === undefined) return
      const revision = sessionRevision(source.getSnapshot(), events?.getSnapshot().revision ?? 0)
      if (revision === this.sessionRevision) return
      this.sessionRevision = revision
      this.invalidate()
    }
    this.sessionSourceDispose = source?.subscribe(() => {
      invalidateSource()
    })
    this.eventSourceDispose = events?.subscribe(invalidateSource)
    return true
  }

  private invalidate(): void {
    if (!this.observing || this.store.getSnapshot().status === 'idle' || this.refreshScheduled) return
    this.refreshScheduled = true
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      this.refreshScheduled = false
      if (this.observing && this.store.getSnapshot().status !== 'idle') this.refresh()
    }, REFRESH_DELAY_MS)
  }

  /** Invalidation-driven refetch: one in-flight request absorbs the demand
   * and commits a single rerun once it settles. */
  private refresh(): void {
    if (this.disposed) return
    if (this.inflight !== null) {
      this.rerunAfter = true
      return
    }
    void this.load()
  }

  /** Refetch the full value-level projection; concurrent callers share one
   * request, and an invalidation during flight schedules exactly one rerun. */
  async load(): Promise<void> {
    if (this.disposed) return
    if (this.inflight !== null) return this.inflight
    const generation = ++this.generation
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
      state.migration = false
    })
    const run = this.performLoad(generation, abort)
    this.inflight = run
    try {
      await run
    } finally {
      if (this.inflight === run) this.inflight = null
      if (this.rerunAfter && !this.disposed) {
        this.rerunAfter = false
        void this.load()
      }
    }
  }

  private async performLoad(generation: number, abort: AbortController): Promise<void> {
    try {
      const response = await fetch(`${TURN_FORK_PATH}?sessionId=${encodeURIComponent(this.sessionId)}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: abort.signal,
      })
      const value = await response.json() as unknown
      if (!response.ok) {
        const body = objectValue(value, '错误响应') as unknown as Partial<MutationError>
        throw Object.assign(new Error(typeof body.error === 'string' ? body.error : `请求失败：HTTP ${String(response.status)}`), {
          migration: body.migration === true,
        })
      }
      const timeline = decodeTimeline(value)
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'ready'
        state.error = null
        state.migration = false
        state.timeline = timeline
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = messageOf(error)
        state.migration = error instanceof Error && (error as Error & { migration?: boolean }).migration === true
      })
    }
  }

  /** Refresh only controllers whose projection has already been requested. */
  refreshIfLoaded(): void {
    if (this.disposed || this.store.getSnapshot().status === 'idle') return
    this.refresh()
  }

  private turnOfMessage(messageId: string): number | undefined {
    const timeline = this.store.getSnapshot().timeline
    if (timeline === null) return undefined
    return timeline.assistantMessageTurns.find(entry => entry.messageId === messageId)?.turn
  }

  private async retryForMessageId(messageId: string, cascade: CascadePolicy): Promise<boolean> {
    const turn = this.turnOfMessage(messageId)
    if (turn === undefined) return false
    return this.mutate({ action: 'retry', sessionId: this.sessionId, turn, cascade })
  }

  private async rerollForMessageId(messageId: string): Promise<boolean> {
    const timeline = this.store.getSnapshot().timeline
    if (timeline === null) return false
    const entries = timeline.assistantMessageTurns.filter(entry => entry.messageId === messageId)
    const entry = entries[0]
    if (entry === undefined) return false
    const lastTurn = timeline.assistantMessageTurns.at(-1)?.turn
    if (entry.turn !== lastTurn) return false
    const tailOfTurn = timeline.assistantMessageTurns
      .filter(candidate => candidate.turn === entry.turn)
      .at(-1)?.messageId
    if (tailOfTurn !== messageId) return false
    return this.mutate({ action: 'reroll', sessionId: this.sessionId })
  }

  private async mutate(operation: TurnForkOperation): Promise<boolean> {
    const current = this.store.getSnapshot()
    if (current.pending !== null || current.status !== 'ready') return false
    this.store.update((state) => {
      state.pending = operation.action === 'cancel' ? 'cancel' : operation.action
      state.error = null
    })
    try {
      const response = await fetch(TURN_FORK_PATH, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(operation),
      })
      const value = await response.json() as unknown
      if (!response.ok) {
        const body = objectValue(value, '错误响应') as unknown as Partial<MutationError>
        throw new Error(typeof body.error === 'string' ? body.error : `请求失败：HTTP ${String(response.status)}`)
      }
      const result = objectValue(value, '操作响应') as unknown as TurnForkOperationResult
      if (this.disposed) return true
      this.store.update((state) => { state.pending = null })
      if (operation.action === 'cancel') return true
      await this.openWhenListed(result.sessionId as SessionId)
      return true
    } catch (error) {
      if (this.disposed) return false
      this.store.update((state) => {
        state.pending = null
        state.error = messageOf(error)
      })
      return false
    }
  }

  private async cancelBranch(sessionId: SessionId): Promise<boolean> {
    const confirmed = window.confirm(this.t('stopBranchConfirm'))
    if (!confirmed) return false
    this.store.update((state) => { state.pending = 'cancel' })
    try {
      const response = await fetch(TURN_FORK_PATH, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'cancel', sessionId }),
      })
      const value = await response.json() as unknown
      if (!response.ok) {
        const body = objectValue(value, '错误响应') as unknown as Partial<MutationError>
        throw new Error(typeof body.error === 'string' ? body.error : `请求失败：HTTP ${String(response.status)}`)
      }
      this.store.update((state) => { state.pending = null })
      this.refresh()
      return true
    } catch (error) {
      this.store.update((state) => {
        state.pending = null
        state.error = messageOf(error)
      })
      return false
    }
  }

  /** Session-list publication is the reactive dependency for navigation. */
  private openWhenListed(sessionId: SessionId): Promise<void> {
    if (this.sessions.list.getSnapshot().byId[sessionId] !== undefined) {
      this.sessions.open(sessionId)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let settled = false
      let dispose = (): void => {}
      const finish = (open: boolean): void => {
        if (settled) return
        settled = true
        dispose()
        this.navigationWaits.delete(cancel)
        if (open) this.sessions.open(sessionId)
        resolve()
      }
      const cancel = (): void => { finish(false) }
      this.navigationWaits.add(cancel)
      dispose = this.sessions.list.subscribe(() => {
        if (this.sessions.list.getSnapshot().byId[sessionId] === undefined) return
        finish(true)
      })
      if (this.sessions.list.getSnapshot().byId[sessionId] !== undefined) finish(true)
    })
  }
}
