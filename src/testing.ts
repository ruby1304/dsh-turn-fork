/**
 * Test surface: the pure host logic, exported without a Cordis context so
 * the test suite (node:test, real dsh-session/dsh-session-persistence) can
 * exercise planning, seed construction, the trust fence, and the lineage
 * projection directly.
 */
export {
  TURN_FORK_PATH,
  TURN_FORK_VERSION_EVENT,
  TURN_FORK_VERSION_SCHEMA,
  TURN_FORK_VIEW_ORDER,
} from './shared.ts'
export type {
  CascadePolicy,
  VersionOperation,
  VersionEffect,
  VersionInverse,
  TurnForkVersionData,
  EditableMessageBlock,
  AssistantMessageTurn,
  RetryableTurn,
  VersionSummary,
  TimelinePayload,
  EditOperation,
  RetryOperation,
  RerollOperation,
  CancelOperation,
  TurnForkOperation,
  TurnForkOperationResult,
  MutationResult,
  MutationError,
  TurnForkLocaleKey,
} from './shared.ts'
export {
  LEGACY_MESSAGE_EDIT_EVENT,
  MAX_REQUEST_BODY_BYTES,
  closedTurns,
  cloneUser,
  editPlan,
  retryPlan,
  rerollPlan,
  isTextualBlock,
  planOperation,
  buildForkSeed,
  agentOptionsFrom,
  isTrustedRequest,
  isLegacyFormatError,
  readJsonBody,
  decodeOperation,
} from './host/core.ts'
export type { ClosedTurn, OperationPlan, ForkSeed } from './host/core.ts'
export {
  ownVersionEvent,
  projectTimeline,
  isTurnTailAssistant,
} from './host/lineage.ts'
export type { LineageDeps, PersistenceReaderFace, VersionProjection } from './host/lineage.ts'
export { sessionRevision } from './client/revision.ts'
