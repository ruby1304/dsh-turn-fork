/**
 * Version-lineage projection: reads the live/persisted logs of one session's
 * known family tree and projects the Timeline payload (editable blocks,
 * retryable turns, version summaries, undo/redo stacks).
 *
 * Dependencies are injected as narrow faces so the projection can be unit
 * tested without a live Cordis context.
 */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLineageNode, SessionRecord, SessionLineageTrace } from '@deepseek-ai/dsh-session-query'
import {
  TURN_FORK_VERSION_EVENT,
  TURN_FORK_VERSION_SCHEMA,
  type AssistantMessageTurn,
  type EditableMessageBlock,
  type RetryableTurn,
  type TimelinePayload,
  type VersionSummary,
} from '../shared.ts'
import { closedTurns, isTextualBlock, type ClosedTurn, type TurnForkVersionEvent } from './core.ts'

export interface PersistenceReaderFace {
  inspect(sessionId: SessionId): Promise<{ events: readonly SessionEvent[] }>
  readFrom(sessionId: SessionId, fromSeq: number): Promise<{ events: readonly SessionEvent[] }>
}

export interface LineageDeps {
  sessions: { get(id: SessionId): { events: readonly SessionEvent[] } | undefined }
  agents: { get(id: SessionId): { status: 'idle' | 'running' } | undefined }
  sessionQuery: {
    traceSession(id: SessionId): Promise<SessionLineageTrace>
    readSession(id: SessionId): Promise<{ events: SessionEvent[] }>
  }
  sessionPersistence?: PersistenceReaderFace
}

interface LineageEntry {
  record: SessionRecord
  depth: number
}

export interface VersionProjection {
  effectId: string
  inverseSessionId: string
  time: number
  operation: TurnForkVersionEvent['data']['effect']['operation']
  cascade: TurnForkVersionEvent['data']['effect']['cascade']
  targetTurn: number
  targetEventSeq: number
  targetBlockIndex?: number
  before?: string
  after?: string
}

/** The one version effect this session itself contributed (past its seed). */
export function ownVersionEvent(
  header: SessionRecord['header'],
  events: readonly SessionEvent[],
): VersionProjection | undefined {
  const inherited = header.seedLength ?? 0
  const ownEvents = events.filter((event): event is TurnForkVersionEvent => (
    event.type === TURN_FORK_VERSION_EVENT && event.seq >= inherited
  ))
  if (ownEvents.length === 0) return undefined
  if (ownEvents.length > 1) {
    throw new Error(`会话 ${header.id} 包含多个自身版本效果。`)
  }
  const event = ownEvents[0]
  if (event === undefined) return undefined
  const parent = header.parentSession
  const version = event.data
  if (version.schemaVersion > TURN_FORK_VERSION_SCHEMA) {
    throw new Error(`会话 ${header.id} 的版本效果由更新版本的插件写入（schema ${String(version.schemaVersion)}）。`)
  }
  if (version.inverse.kind !== 'restore-version'
    || parent === undefined
    || version.inverse.sessionId !== parent) {
    throw new Error(`会话 ${header.id} 的版本效果与逆不匹配。`)
  }
  return {
    effectId: version.effect.id,
    inverseSessionId: version.inverse.sessionId,
    time: event.time,
    operation: version.effect.operation,
    cascade: version.effect.cascade,
    targetTurn: version.effect.targetTurn,
    targetEventSeq: version.effect.targetEventSeq,
    ...version.effect.targetBlockIndex === undefined ? {} : { targetBlockIndex: version.effect.targetBlockIndex },
    ...version.effect.before === undefined ? {} : { before: version.effect.before },
    ...version.effect.after === undefined ? {} : { after: version.effect.after },
  }
}

function flattenLineage(
  root: SessionRecord,
  descendants: readonly SessionLineageNode[],
): LineageEntry[] {
  const result: LineageEntry[] = [{ record: root, depth: 0 }]
  const visit = (nodes: readonly SessionLineageNode[], depth: number): void => {
    const ordered = [...nodes].sort((left, right) => (
      left.session.header.createdAt - right.session.header.createdAt
      || String(left.session.header.id).localeCompare(String(right.session.header.id))
    ))
    for (const node of ordered) {
      result.push({ record: node.session, depth })
      visit(node.descendants, depth + 1)
    }
  }
  visit(descendants, 1)
  return result
}

/** Bounded parallel inspection of persisted branches. */
const TIMELINE_READ_CONCURRENCY = 4

async function mapConcurrent<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T)
    }
  }
  const workers = Math.min(TIMELINE_READ_CONCURRENCY, items.length)
  await Promise.all(Array.from({ length: workers }, () => run()))
  return results
}

/** Full log for one session: live borrow, persisted inspection, query fallback. */
async function readCurrentLog(deps: LineageDeps, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  const live = deps.sessions.get(sessionId)
  if (live !== undefined) return live.events
  if (deps.sessionPersistence !== undefined) return (await deps.sessionPersistence.inspect(sessionId)).events
  return (await deps.sessionQuery.readSession(sessionId)).events
}

/** Own-version scan window for one lineage node: the tail from the seed boundary. */
async function versionLog(
  deps: LineageDeps,
  record: SessionRecord,
): Promise<readonly SessionEvent[]> {
  const inherited = record.header.seedLength ?? 0
  const live = deps.sessions.get(record.header.id)
  if (live !== undefined) return live.events.slice(inherited)
  if (deps.sessionPersistence !== undefined) {
    return (await deps.sessionPersistence.readFrom(record.header.id, inherited)).events
  }
  return (await deps.sessionQuery.readSession(record.header.id)).events.slice(inherited)
}

function editableMessages(turns: readonly ClosedTurn[]): EditableMessageBlock[] {
  const result: EditableMessageBlock[] = []
  for (const turn of turns) {
    for (const event of turn.users) {
      for (const [blockIndex, block] of event.data.content.entries()) {
        if (block.type !== 'text') continue
        result.push({
          key: `${String(event.seq)}:${String(blockIndex)}`,
          turn: turn.turn,
          eventSeq: event.seq,
          blockIndex,
          kind: 'user',
          text: block.text,
          time: event.time,
        })
      }
    }
  }
  return result
}

function retryableTurns(turns: readonly ClosedTurn[]): RetryableTurn[] {
  return turns.flatMap((turn): RetryableTurn[] => {
    const first = turn.users[0]
    if (first === undefined) return []
    return [{
      turn: turn.turn,
      userEventSeq: first.seq,
      preview: first.data.content
        .filter((block): block is Extract<(typeof first.data.content)[number], { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n'),
      time: first.time,
    }]
  })
}

function assistantMessageTurns(turns: readonly ClosedTurn[]): AssistantMessageTurn[] {
  const result: AssistantMessageTurn[] = []
  for (const turn of turns) {
    for (const event of turn.assistants) {
      result.push({
        messageId: event.data.message.id,
        turn: turn.turn,
        eventSeq: event.seq,
      })
    }
  }
  return result
}

/** Project the complete Timeline payload for one session. */
export async function projectTimeline(deps: LineageDeps, sessionId: SessionId): Promise<TimelinePayload> {
  const targetTrace = await deps.sessionQuery.traceSession(sessionId)
  const rootId = targetTrace.complete
    ? targetTrace.root.header.id
    : targetTrace.ancestors.at(-1)?.header.id ?? sessionId
  const rootTrace = rootId === sessionId ? targetTrace : await deps.sessionQuery.traceSession(rootId)
  const lineage = flattenLineage(rootTrace.target, rootTrace.descendants)
  const logs = await mapConcurrent(lineage, async ({ record }): Promise<readonly SessionEvent[]> => {
    if (record.header.id === sessionId) return readCurrentLog(deps, sessionId)
    if (record.header.parentSession === undefined) return []
    return versionLog(deps, record)
  })
  const recordsById = new Map(lineage.map(({ record }) => [record.header.id, record]))
  const currentPath = new Set<SessionId>()
  let pathId: SessionId | undefined = sessionId
  while (pathId !== undefined && !currentPath.has(pathId)) {
    currentPath.add(pathId)
    pathId = recordsById.get(pathId)?.header.parentSession
  }

  const versions: VersionSummary[] = lineage.map(({ record, depth }, index) => {
    const version = ownVersionEvent(record.header, logs[index] ?? [])
    return {
      sessionId: record.header.id,
      ...record.header.parentSession === undefined ? {} : { parentSessionId: record.header.parentSession },
      ...version === undefined ? {} : {
        effectId: version.effectId,
        inverseSessionId: version.inverseSessionId,
      },
      createdAt: version?.time ?? record.header.createdAt,
      depth,
      current: record.header.id === sessionId,
      onCurrentEffectPath: currentPath.has(record.header.id),
      ...version === undefined ? {} : {
        operation: version.operation,
        cascade: version.cascade,
        targetTurn: version.targetTurn,
        ...version.before === undefined ? {} : { before: version.before },
        ...version.after === undefined ? {} : { after: version.after },
      },
    }
  })
  const effectIds = new Set<string>()
  for (const version of versions) {
    if (version.effectId === undefined) continue
    if (effectIds.has(version.effectId)) throw new Error(`版本效果 ${version.effectId} 重复。`)
    effectIds.add(version.effectId)
  }

  const versionsById = new Map(versions.map(version => [version.sessionId, version]))
  const undoStack: string[] = []
  let undoCursor = versionsById.get(sessionId)
  while (undoCursor?.inverseSessionId !== undefined) {
    const inverseId = undoCursor.inverseSessionId
    if (undoStack.includes(inverseId)) throw new Error('版本效果逆链包含循环。')
    if (!versionsById.has(inverseId)) throw new Error(`恢复目标 ${inverseId} 不在可见版本树中。`)
    undoStack.push(inverseId)
    undoCursor = versionsById.get(inverseId)
  }
  const redoSessionIds = versions
    .filter(version => version.inverseSessionId === sessionId)
    .map(version => version.sessionId)

  const currentIndex = versions.findIndex(version => version.current)
  const currentLog = logs[currentIndex]
  if (currentIndex < 0 || currentLog === undefined) throw new Error('当前版本不在版本树中。')
  const turns = closedTurns(currentLog)
  const running: string[] = []
  for (const entry of lineage) {
    const agent = deps.agents.get(entry.record.header.id)
    if (agent?.status === 'running') running.push(entry.record.header.id)
  }

  return {
    sessionId,
    messages: editableMessages(turns),
    retryableTurns: retryableTurns(turns),
    assistantMessageTurns: assistantMessageTurns(turns),
    versions,
    undoStack,
    redoSessionIds,
    running,
  }
}

/** Whether one assistant message is the tail of its turn's settled replies. */
export function isTurnTailAssistant(turns: readonly ClosedTurn[], eventSeq: number): boolean {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn === undefined) continue
    const matching = turn.assistants.findLast(event => event.seq === eventSeq)
    if (matching === undefined) continue
    const tail = turn.assistants.at(-1)
    return tail !== undefined && tail.seq === eventSeq && isTextualBlock(tail.data.message.content.find(block => isTextualBlock(block)))
  }
  return false
}
