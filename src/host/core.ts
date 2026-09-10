/**
 * Pure, context-free host core of Turn Fork: turn folding, operation
 * planning, fork-seed construction, model-config derivation, HTTP trust
 * fencing, and request decoding. Everything here is importable by the test
 * suite without a live Cordis context.
 */
import type { IncomingMessage } from 'node:http'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import {
  TURN_FORK_VERSION_EVENT,
  TURN_FORK_VERSION_SCHEMA,
  type CascadePolicy,
  type EditOperation,
  type RetryOperation,
  type RerollOperation,
  type TurnForkOperation,
  type TurnForkVersionData,
} from '../shared.ts'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Durable branch provenance owned by the turn-fork plugin. */
    'turn-fork/version': TurnForkVersionData
  }
}

/** Event type written by the broken dsh-message-edit releases (< 0.2.4 fix). */
export const LEGACY_MESSAGE_EDIT_EVENT = 'message-edit/version'

export type TurnForkVersionEvent = SessionEvent<'turn-fork/version'>

/** Request bodies are tiny operations; 64 KiB is generous and bounds memory. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024

/** Loopback hostnames accepted by the HTTP trust fence. */
const TRUSTED_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

// ---------------------------------------------------------------------------
// Turn folding
// ---------------------------------------------------------------------------

export interface ClosedTurn {
  turn: number
  startSeq: number
  endSeq: number
  /** ALL user-origin inputs of the turn, in log order (steering preserved). */
  users: SessionEvent<'user/message'>[]
  assistants: SessionEvent<'assistant/message'>[]
}

/** Fold complete turn brackets; an open tail is deliberately absent. */
export function closedTurns(events: readonly SessionEvent[]): ClosedTurn[] {
  const result: ClosedTurn[] = []
  let current: Omit<ClosedTurn, 'endSeq'> | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = {
        turn: event.data.turn,
        startSeq: event.seq,
        users: [],
        assistants: [],
      }
      continue
    }
    if (current === undefined) continue
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      // Steering and every later input of the same turn are preserved in
      // order instead of being reduced to the first message.
      current.users.push(event)
      continue
    }
    if (event.type === 'assistant/message' && event.data.turn === current.turn) {
      current.assistants.push(event)
      continue
    }
    if (event.type === 'turn/end' && event.data.turn === current.turn) {
      result.push({ ...current, endSeq: event.seq })
      current = undefined
    }
  }
  return result
}

/** Deep-cloned user message with a fresh durable identity. */
export function cloneUser(message: UserMessage, content: ContentBlock[] = structuredClone(message.content)): UserMessage {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user' as const,
    content: Object.freeze(content),
    source: Object.freeze({ kind: 'user' as const }),
  }) as UserMessage
}

function replaceTextBlock(content: readonly ContentBlock[], blockIndex: number, text: string): ContentBlock[] {
  const block = content[blockIndex]
  if (block?.type !== 'text') throw new TypeError('所选内容块不是可编辑文本。')
  return content.map((candidate, index) => index === blockIndex
    ? { ...candidate, text } as ContentBlock
    : structuredClone(candidate))
}

/** Every user input of the turns at `fromIndex` and later, in order. */
function usersFrom(turns: readonly ClosedTurn[], fromIndex: number): UserMessage[] {
  return turns.slice(fromIndex).flatMap(turn => turn.users.map(event => cloneUser(event.data)))
}

// ---------------------------------------------------------------------------
// Operation planning
// ---------------------------------------------------------------------------

export interface OperationPlan {
  /** Inclusive inherited boundary (target turn's startSeq - 1; -1 = empty). */
  boundary: number
  version: TurnForkVersionData
  queuedUsers: UserMessage[]
}

function pairVersionEffect(sourceSessionId: SessionId, effect: Omit<TurnForkVersionData['effect'], 'id'>): TurnForkVersionData {
  return {
    schemaVersion: TURN_FORK_VERSION_SCHEMA,
    effect: { ...effect, id: crypto.randomUUID() },
    inverse: { kind: 'restore-version', sessionId: sourceSessionId },
  }
}

function turnContaining(turns: readonly ClosedTurn[], eventSeq: number): ClosedTurn | undefined {
  return turns.find(turn => eventSeq > turn.startSeq && eventSeq < turn.endSeq)
}

export function editPlan(operation: EditOperation, turns: readonly ClosedTurn[]): OperationPlan {
  const turn = turnContaining(turns, operation.eventSeq)
  if (turn === undefined) throw new Error('所选消息不属于已落定回合。')
  const event = turn.users.find(candidate => candidate.seq === operation.eventSeq)
  if (event === undefined) throw new Error('所选消息不存在或不可编辑。')
  const before = event.data.content[operation.blockIndex]
  if (before?.type !== 'text') throw new Error('所选用户消息块不是文本。')
  const edited = cloneUser(event.data, replaceTextBlock(event.data.content, operation.blockIndex, operation.text))
  const turnIndex = turns.findIndex(candidate => candidate === turn)
  const later = operation.cascade === 'preserve' ? usersFrom(turns, turnIndex + 1) : []
  return {
    boundary: turn.startSeq - 1,
    version: pairVersionEffect(operation.sessionId as SessionId, {
      operation: 'edit',
      cascade: operation.cascade,
      targetTurn: turn.turn,
      targetEventSeq: event.seq,
      targetBlockIndex: operation.blockIndex,
      before: before.text,
      after: operation.text,
    }),
    queuedUsers: [edited, ...later],
  }
}

export function retryPlan(
  sessionId: SessionId,
  turnNumber: number,
  cascade: CascadePolicy,
  turns: readonly ClosedTurn[],
): OperationPlan {
  const turnIndex = turns.findIndex(turn => turn.turn === turnNumber)
  const turn = turns[turnIndex]
  if (turn === undefined || turn.users.length === 0) throw new Error('所选回合没有可重放的用户输入。')
  const first = turn.users[0]
  if (first === undefined) throw new Error('所选回合没有可重放的用户输入。')
  return {
    boundary: turn.startSeq - 1,
    version: pairVersionEffect(sessionId, {
      operation: 'retry',
      cascade,
      targetTurn: turn.turn,
      targetEventSeq: first.seq,
    }),
    queuedUsers: cascade === 'preserve' ? usersFrom(turns, turnIndex) : usersFrom(turns, turnIndex).slice(0, turn.users.length),
  }
}

export function rerollPlan(sessionId: SessionId, turns: readonly ClosedTurn[]): OperationPlan {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn === undefined || turn.users.length === 0) continue
    const target = turn.assistants.findLast(event => event.data.message.content.some(isTextualBlock))
    if (target === undefined) continue
    return {
      boundary: turn.startSeq - 1,
      version: pairVersionEffect(sessionId, {
        operation: 'reroll',
        cascade: 'truncate',
        targetTurn: turn.turn,
        targetEventSeq: target.seq,
      }),
      queuedUsers: usersFrom(turns, index).slice(0, turn.users.length),
    }
  }
  throw new Error('当前会话没有可重生成的已落定助手回复。')
}

export function isTextualBlock(block: ContentBlock | undefined): block is Extract<ContentBlock, { type: 'text' | 'reasoning' }> {
  return block?.type === 'text' || block?.type === 'reasoning'
}

export function planOperation(operation: TurnForkOperation, events: readonly SessionEvent[]): OperationPlan {
  const turns = closedTurns(events)
  switch (operation.action) {
    case 'edit':
      return editPlan(operation, turns)
    case 'reroll':
      return rerollPlan(operation.sessionId as SessionId, turns)
    case 'retry':
      return retryPlan(operation.sessionId as SessionId, operation.turn, operation.cascade, turns)
    default:
      throw new TypeError('action 必须是 edit、retry 或 reroll。')
  }
}

// ---------------------------------------------------------------------------
// Fork seed construction
// ---------------------------------------------------------------------------

export interface ForkSeed {
  events: SessionEvent[]
  /** Number of inherited (source) events; the version event sits at this seq. */
  inheritedLength: number
}

/**
 * Build the child session seed: the source log's completed prefix up to the
 * boundary, plus this plugin's version-provenance event.
 *
 * The provenance event is marked `ignorable: true`: it is purely
 * informational for reconstruction, and the persistence layer's cold-read
 * guard (`assertEventsSupported`) must admit it after a process restart —
 * this is the P0 regression this plugin is built around.
 */
export function buildForkSeed(
  sourceEvents: readonly SessionEvent[],
  boundary: number,
  version: TurnForkVersionData,
): ForkSeed {
  const events: SessionEvent[] = []
  if (boundary !== -1) {
    const boundaryEvent = sourceEvents[boundary]
    if (boundary < 0 || boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
      throw new Error('分支边界不是连续会话事件。')
    }
    for (const event of sourceEvents.slice(0, boundary + 1)) events.push(event)
  }
  const inheritedLength = events.length
  const versionEvent: TurnForkVersionEvent = {
    type: TURN_FORK_VERSION_EVENT,
    seq: SessionSeq(events.length),
    time: Date.now(),
    data: version,
    ignorable: true,
  }
  events.push(versionEvent)
  return { events, inheritedLength }
}

// ---------------------------------------------------------------------------
// Model configuration derivation
// ---------------------------------------------------------------------------

/**
 * Derive the child agent's creation options from the source log.
 *
 * `provider`/`model`/`maxTokens` are the only AgentOptions fields; the
 * remaining request fidelity (`reasoningEffort`, `adapterDefaults`) rides the
 * inherited `request/header` events inside the seed: the agent loop resolves
 * the persisted header's config on its first request (verified against
 * `dsh-agent-loop`'s `buildRequest`), so it survives the fork without being
 * reconstructible here.
 */
export function agentOptionsFrom(
  events: readonly SessionEvent[],
  fallback?: AgentOptions,
): AgentOptions {
  const config = events.findLast(event => event.type === 'request/header')?.data.header.config
  const provider = config?.provider ?? fallback?.provider
  const model = config?.model ?? fallback?.model
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
    throw new Error('无法从会话历史解析模型路由。')
  }
  const maxTokens = config?.maxTokens ?? fallback?.maxTokens
  return {
    provider,
    model,
    ...maxTokens === undefined ? {} : { maxTokens },
  }
}

// ---------------------------------------------------------------------------
// HTTP trust fence
// ---------------------------------------------------------------------------

/**
 * Reject cross-site (CSRF / DNS-rebinding) requests before any session data
 * is read or any branch is forked. The official `/api` channel applies the
 * same manual check; `webServer.register` performs none on its own.
 *
 * Policy:
 * - `Origin` present (browser): must be http(s) on a trusted loopback
 *   hostname, and its port must equal the server's listening port. When the
 *   deployment listens on all interfaces (`0.0.0.0`), the operator has
 *   explicitly opted into remote exposure and the origin check is relaxed
 *   (same trust decision as the core API surface).
 * - `Origin` absent (curl, same-origin simple GET): the `Host` header must
 *   name a trusted loopback hostname; the port is not checked (a local
 *   client can reach any port anyway, and DNS rebinding is caught by the
 *   hostname check).
 */
export function isTrustedRequest(
  origin: string | undefined,
  host: string | undefined,
  serverHost: '127.0.0.1' | '0.0.0.0',
  serverPort: number,
): boolean {
  if (origin !== undefined) {
    if (serverHost === '0.0.0.0') return true
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      return false
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (!TRUSTED_HOSTNAMES.has(url.hostname)) return false
    const originPort = url.port === '' ? (url.protocol === 'http:' ? 80 : 443) : Number(url.port)
    return originPort === serverPort
  }
  if (host === undefined) return false
  const withoutPort = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return TRUSTED_HOSTNAMES.has(withoutPort ?? '')
}

/** True when the rejection names the legacy non-ignorable foreign event. */
export function isLegacyFormatError(error: unknown): boolean {
  return error instanceof Error
    && error.name === 'SessionFormatUnsupportedError'
    && error.message.includes(LEGACY_MESSAGE_EDIT_EVENT)
}

// ---------------------------------------------------------------------------
// Request decoding (bounded)
// ---------------------------------------------------------------------------

class BodyTooLargeError extends Error {
  constructor() {
    super(`请求体超过 ${MAX_REQUEST_BODY_BYTES} 字节上限。`)
    this.name = 'BodyTooLargeError'
  }
}

/** Read a JSON body with a hard byte cap (checked before and during read). */
export function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(request.headers['content-length'] ?? '0')
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
      reject(new BodyTooLargeError())
      return
    }
    const chunks: Uint8Array[] = []
    let total = 0
    request.on('data', (chunk: Uint8Array) => {
      total += chunk.length
      if (total > MAX_REQUEST_BODY_BYTES) {
        reject(new BodyTooLargeError())
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const decoder = new TextDecoder()
      const parts: string[] = []
      for (const chunk of chunks) parts.push(decoder.decode(chunk, { stream: true }))
      parts.push(decoder.decode())
      try {
        resolve(JSON.parse(parts.join('')) as unknown)
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Mutation decoding
// ---------------------------------------------------------------------------

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('请求体必须是 JSON 对象。')
  }
  return value as Record<string, unknown>
}

function sessionIdOf(value: unknown): SessionId {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('sessionId 必须是非空字符串。')
  return value as SessionId
}

function integerOf(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} 必须是非负安全整数。`)
  }
  return value as number
}

function cascadeOf(value: unknown): CascadePolicy {
  if (value !== 'truncate' && value !== 'preserve') throw new TypeError('cascade 必须是 truncate 或 preserve。')
  return value
}

export function decodeOperation(value: unknown): TurnForkOperation {
  const record = objectValue(value)
  const sessionId = sessionIdOf(record['sessionId'])
  switch (record['action']) {
    case 'edit':
      if (typeof record['text'] !== 'string') throw new TypeError('text 必须是字符串。')
      return {
        action: 'edit',
        sessionId,
        eventSeq: integerOf(record['eventSeq'], 'eventSeq'),
        blockIndex: integerOf(record['blockIndex'], 'blockIndex'),
        text: record['text'],
        cascade: cascadeOf(record['cascade']),
      }
    case 'reroll':
      return { action: 'reroll', sessionId }
    case 'retry':
      return {
        action: 'retry',
        sessionId,
        turn: integerOf(record['turn'], 'turn'),
        cascade: cascadeOf(record['cascade']),
      }
    case 'cancel':
      return { action: 'cancel', sessionId }
    default:
      throw new TypeError('action 必须是 edit、retry、reroll 或 cancel。')
  }
}

export type { EditOperation, RetryOperation, RerollOperation }
