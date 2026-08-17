/**
 * Host half of Turn Fork: turn-atomic message editing, retry, reroll, and
 * version-tree navigation for DeepSeek Harness conversations.
 *
 * Design anchors (see README for the full rationale):
 * - Every branch is a turn-atomic fork of the source session's completed
 *   prefix, created through the official `agents.create` transaction seam
 *   (the same primitive the official `session.fork` RPC uses internally).
 * - The durable version-provenance event is `ignorable: true`, so branch
 *   logs survive the persistence layer's cold-read vocabulary guard after a
 *   process restart (the P0 regression the community plugin failed).
 * - Model fidelity: provider/model/maxTokens derive from the source's last
 *   `request/header`; reasoningEffort/adapterDefaults ride the inherited
 *   header events inside the seed.
 * - The HTTP route sits behind an Origin/Host trust fence with a bounded
 *   request body.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { PresetBearingSession } from '@deepseek-ai/dsh-agent-presets'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  TURN_FORK_PATH,
  type CancelOperationResult,
  type MutationError,
  type TurnForkOperation,
  type TurnForkOperationResult,
} from './shared.ts'
import {
  agentOptionsFrom,
  buildForkSeed,
  decodeOperation,
  isLegacyFormatError,
  isTrustedRequest,
  planOperation,
  readJsonBody,
} from './host/core.ts'
import { projectTimeline, type PersistenceReaderFace } from './host/lineage.ts'

/** Stable Cordis plugin name. */
export const name = 'turn-fork'

/**
 * Hard dependencies: the fork transaction and timeline projection.
 * `webServer` and `workspaceRegistry` are optional — headless profiles
 * provide neither, and the plugin still loads (no HTTP route, no workspace
 * attach) instead of stalling the whole composition.
 */
export const inject = [
  'sessions',
  'agents',
  'sessionQuery',
]

type OperationInverse = () => void | Promise<void>

/** Everything a fork needs from its source: live session or cold snapshot. */
interface ForkSource {
  id: SessionId
  header: SessionHeader
  events: readonly SessionEvent[]
}

function presetIdOf(session: PresetBearingSession, events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return session.header.agentPreset
}

/** Resolve the workspace a fork inherits, mirroring the official fork's
 * resolution: direct attachment first, then lineage ancestors when the source
 * is a subagent-origin session. Absent registry (headless) means no attach. */
async function sourceWorkspace(ctx: Context, source: ForkSource): Promise<Workspace | undefined> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  const workspaces = registry.list()
  const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
  if (direct !== undefined || source.header.origin !== 'subagent') return direct
  const lineage = await ctx.sessionQuery.traceSession(source.id)
  for (const ancestor of lineage.ancestors) {
    const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
    if (workspace !== undefined) return workspace
  }
  return undefined
}

async function recoverInverses(inverses: OperationInverse[]): Promise<void> {
  const failures: unknown[] = []
  for (const inverse of inverses.reverse()) {
    try {
      await inverse()
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, '版本操作恢复失败。')
}

/**
 * Create the child agent: seed = completed source prefix + ignorable version
 * event; meta carries the official lineage fields; setup re-resolves the
 * source's agent preset. Flush durability before the child is published to
 * the caller; any later failure rolls the child back.
 */
async function createChildAgent(
  ctx: Context,
  source: ForkSource,
  childId: SessionId,
  boundary: number,
  version: ReturnType<typeof planOperation>['version'],
  options: AgentOptions,
): Promise<AgentHandle> {
  const seed = buildForkSeed(source.events, boundary, version)
  const presets = ctx.get('agentPresets')
  const presetId = presets !== undefined ? presetIdOf({ header: source.header, events: source.events } as PresetBearingSession, source.events) : undefined
  let agentPreset: string | undefined
  let setup: AgentSetup | undefined
  if (presets !== undefined && presetId !== undefined) {
    const resolved = (await presets.resolve(presetId)).id
    agentPreset = resolved
    setup = async (agentCtx) => { await presets.mount(agentCtx, resolved) }
  }
  const child = await ctx.agents.create({
    sessionId: childId,
    seed: seed.events,
    meta: {
      ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
      parentSession: source.id,
      seedLength: seed.inheritedLength,
      ...agentPreset === undefined ? {} : { agentPreset },
    },
    agentOptions: options,
    ...setup === undefined ? {} : { setup },
  })
  try {
    await ctx.sessions.flush(child.agent.session)
    return child
  } catch (error: unknown) {
    await child.dispose()
    throw error
  }
}

/** One fork transaction with registered inverses for every side effect. */
async function forkTransaction(
  ctx: Context,
  source: ForkSource,
  operation: TurnForkOperation,
  fallbackOptions: AgentOptions | undefined,
  sourceRunning: boolean,
): Promise<TurnForkOperationResult> {
  const childId = `session-${crypto.randomUUID()}` as SessionId
  const inverses: OperationInverse[] = []
  try {
    const plan = planOperation(operation, source.events)
    const options = agentOptionsFrom(source.events, fallbackOptions)
    const child = await createChildAgent(ctx, source, childId, plan.boundary, plan.version, options)
    inverses.push(() => child.dispose())

    const workspace = await sourceWorkspace(ctx, source)
    if (workspace !== undefined) {
      await workspace.attachSession(childId)
      inverses.push(() => workspace.detachSession(childId))
    }
    for (const message of plan.queuedUsers) child.agent.followup(message)

    inverses.length = 0
    return { sessionId: childId, queuedTurns: plan.queuedUsers.length, sourceRunning }
  } catch (error: unknown) {
    try {
      await recoverInverses(inverses)
    } catch (recoveryError: unknown) {
      throw new AggregateError([error, recoveryError], '版本操作及其恢复均失败。')
    }
    throw error
  }
}

/**
 * Fork a new branch from the source session.
 *
 * Concurrency model: when the source has a live agent, the read + fork run
 * inside its maintenance seat so the snapshot cannot interleave with the
 * running loop (a live source without an agent, or a cold persisted source,
 * is immutable and needs no serialization).
 */
async function runFork(ctx: Context, operation: TurnForkOperation): Promise<TurnForkOperationResult> {
  const sourceId = operation.sessionId as SessionId
  const liveAgent = ctx.agents.get(sourceId)
  const sourceRunning = liveAgent?.status === 'running'
  const live = ctx.sessions.get(sourceId)

  if (live === undefined) {
    const snapshot = await ctx.sessionQuery.readSession(sourceId)
    return forkTransaction(ctx, { id: snapshot.session.id, header: snapshot.session, events: snapshot.events }, operation, undefined, sourceRunning)
  }
  const source: ForkSource = { id: live.id, header: live.header, events: live.events }
  if (liveAgent === undefined) return forkTransaction(ctx, source, operation, undefined, sourceRunning)
  return liveAgent.runMaintenance(() => forkTransaction(ctx, source, operation, liveAgent.options, sourceRunning))
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

function respondError(response: ServerResponse, status: number, error: unknown): void {
  const body: MutationError = {
    error: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
  if (isLegacyFormatError(error)) {
    body.migration = true
    body.error = '该分支由旧版 dsh-message-edit 写入，其版本事件缺少 ignorable 标记，持久层拒绝读取。'
      + '请见 README 的迁移说明（upstream 修复前无法自愈）。'
  }
  respondJson(response, status, body)
}

async function handleRoute(
  ctx: Context,
  webServer: import('@deepseek-ai/dsh-host-webserver').WebServer,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!isTrustedRequest(request.headers.origin, request.headers.host, webServer.host, webServer.port)) {
    respondError(response, 403, new Error('请求未通过信任检查（Origin/Host 不允许）。'))
    return
  }
  try {
    if (request.method === 'GET') {
      const url = new URL(request.url ?? TURN_FORK_PATH, 'http://turn-fork.local')
      const rawId = url.searchParams.get('sessionId')
      if (rawId === null || rawId.length === 0) throw new TypeError('sessionId 必须是非空字符串。')
      const persistence = ctx.get('sessionPersistence') as PersistenceReaderFace | undefined
      respondJson(response, 200, await projectTimeline({
        sessions: ctx.sessions,
        agents: ctx.agents,
        sessionQuery: ctx.sessionQuery,
        ...persistence === undefined ? {} : { sessionPersistence: persistence },
      }, rawId as SessionId))
      return
    }
    if (request.method === 'POST') {
      const contentType = String(request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') throw new TypeError('POST 请求必须携带 application/json。')
      const operation = decodeOperation(await readJsonBody(request))
      if (operation.action === 'cancel') {
        const agent = ctx.agents.get(operation.sessionId as SessionId)
        const running = agent?.status === 'running'
        if (agent !== undefined) agent.cancel({ kind: 'user' })
        const result: CancelOperationResult = { cancelled: true, running }
        respondJson(response, 200, result)
        return
      }
      respondJson(response, 200, await runFork(ctx, operation))
      return
    }
    response.writeHead(405)
    response.end()
  } catch (error: unknown) {
    const status = error instanceof TypeError ? 400 : 409
    respondError(response, status, error)
  }
}

/** Register the reversible route contribution. Without a web server
 * (headless profile) the plugin stays loaded with no HTTP surface. */
export function apply(ctx: Context): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: TURN_FORK_PATH,
    handler: (request, response) => handleRoute(ctx, webServer, request, response),
  }), 'turn-fork: HTTP route')
}

export { closedTurns, isLegacyFormatError, isTrustedRequest, MAX_REQUEST_BODY_BYTES, readJsonBody } from './host/core.ts'
export { projectTimeline } from './host/lineage.ts'
export type { LineageDeps } from './host/lineage.ts'
