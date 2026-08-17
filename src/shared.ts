/**
 * Shared value-level contracts between the Turn Fork host and client halves.
 * Side-effect free: types plus string/number constants only.
 */

/** Same-origin endpoint owned by the Turn Fork host plugin. */
export const TURN_FORK_PATH = '/turn-fork'

/** Timeline sits between Trajectory (10) and Prompt Studio (20). */
export const TURN_FORK_VIEW_ORDER = 15

/** Durable event type carrying one version's effect/inverse pair. */
export const TURN_FORK_VERSION_EVENT = 'turn-fork/version'

/** Current durable event schema for structurally paired version effects. */
export const TURN_FORK_VERSION_SCHEMA = 1

/** Downstream-history policy after a historical turn changes. */
export type CascadePolicy = 'truncate' | 'preserve'

/** User-visible operation represented by one child version. */
export type VersionOperation = 'edit' | 'reroll' | 'retry'

/** Forward half of one atomic version effect. */
export interface VersionEffect {
  id: string
  operation: VersionOperation
  cascade: CascadePolicy
  targetTurn: number
  targetEventSeq: number
  targetBlockIndex?: number
  before?: string
  after?: string
}

/** Inverse half generated together with a version effect. */
export interface VersionInverse {
  kind: 'restore-version'
  sessionId: string
}

/** Durable effect/inverse pair appended to each branch created by this plugin. */
export interface TurnForkVersionData {
  schemaVersion: number
  effect: VersionEffect
  inverse: VersionInverse
}

/** One editable user text block of the current session. */
export interface EditableMessageBlock {
  key: string
  turn: number
  eventSeq: number
  blockIndex: number
  kind: 'user'
  text: string
  time: number
}

/** Turn membership of one finalized assistant message (messageId -> turn). */
export interface AssistantMessageTurn {
  messageId: string
  turn: number
  eventSeq: number
}

/** One completed message-triggered turn eligible for Retry. */
export interface RetryableTurn {
  turn: number
  userEventSeq: number
  preview: string
  time: number
}

/** One session version in the complete known lineage tree. */
export interface VersionSummary {
  sessionId: string
  parentSessionId?: string
  effectId?: string
  inverseSessionId?: string
  createdAt: number
  depth: number
  current: boolean
  onCurrentEffectPath: boolean
  operation?: VersionOperation
  cascade?: CascadePolicy
  targetTurn?: number
  before?: string
  after?: string
}

/** Complete value-level projection consumed by the Timeline and header controls. */
export interface TimelinePayload {
  sessionId: string
  messages: EditableMessageBlock[]
  retryableTurns: RetryableTurn[]
  assistantMessageTurns: AssistantMessageTurn[]
  versions: VersionSummary[]
  /** Atomic inverses from the current version outward, in application order. */
  undoStack: string[]
  /** Direct child effects that can be re-applied from the current version. */
  redoSessionIds: string[]
  /** Lineage session ids that currently have a live running agent. */
  running: string[]
}

/** Edit one user text block and regenerate from its turn boundary. */
export interface EditOperation {
  action: 'edit'
  sessionId: string
  eventSeq: number
  blockIndex: number
  text: string
  cascade: CascadePolicy
}

/** Regenerate any selected historical turn. */
export interface RetryOperation {
  action: 'retry'
  sessionId: string
  turn: number
  cascade: CascadePolicy
}

/** Regenerate the latest completed turn's assistant reply. */
export interface RerollOperation {
  action: 'reroll'
  sessionId: string
}

/** Stop a live branch's running agent (undo/redo write-conflict control). */
export interface CancelOperation {
  action: 'cancel'
  sessionId: string
}

/** Mutation accepted by the host route. */
export type TurnForkOperation = EditOperation | RetryOperation | RerollOperation | CancelOperation

/** Host acknowledgement after a child Agent has been published and queued. */
export interface TurnForkOperationResult {
  sessionId: string
  queuedTurns: number
  /** True when the source session's agent was running while this branch forked. */
  sourceRunning: boolean
}

/** Host acknowledgement for a cancellation request. */
export interface CancelOperationResult {
  cancelled: boolean
  running: boolean
}

export type MutationResult = TurnForkOperationResult | CancelOperationResult

/**
 * Host-route error body. `retryable` distinguishes user-fixable requests from
 * platform state errors; `migration` flags lineage logs written by the broken
 * dsh-message-edit event format (unknown type, no ignorable marker), which the
 * persistence layer refuses to cold-read.
 */
export interface MutationError {
  error: string
  retryable: boolean
  migration?: boolean
}

/** Bundle-level locale namespace key union (dictionaries ship zh + en). */
export type TurnForkLocaleKey =
  | 'viewLabel'
  | 'viewDescription'
  | 'statusLoading'
  | 'statusError'
  | 'retryLoad'
  | 'sectionMessages'
  | 'sectionTurns'
  | 'sectionVersions'
  | 'emptyMessages'
  | 'edit'
  | 'editUserMessage'
  | 'editorTitle'
  | 'editorLabel'
  | 'editorPlaceholder'
  | 'save'
  | 'cancel'
  | 'cascadeLabel'
  | 'cascadeTruncate'
  | 'cascadeTruncateHint'
  | 'cascadePreserve'
  | 'cascadePreserveHint'
  | 'cascadeCostHint'
  | 'retry'
  | 'retryTurn'
  | 'reroll'
  | 'rerollTurn'
  | 'undo'
  | 'redo'
  | 'current'
  | 'branch'
  | 'rootVersion'
  | 'versionEdit'
  | 'versionRetry'
  | 'versionReroll'
  | 'versionTurn'
  | 'versionFrom'
  | 'versionTo'
  | 'openVersion'
  | 'cannotNavigateSelf'
  | 'runningWarning'
  | 'runningBranches'
  | 'stopBranch'
  | 'stopBranchConfirm'
  | 'stopped'
  | 'noRunning'
  | 'migrateUnsupported'
  | 'errorOperation'
  | 'deleteUnsupported'
  | 'noMessages'
  | 'timelineUnavailable'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'turn-fork': TurnForkLocaleKey
  }
}
