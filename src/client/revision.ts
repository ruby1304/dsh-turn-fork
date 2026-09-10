import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'

/** Revision fence covering both Session state and its separately stored event window. */
export function sessionRevision(snapshot: SessionSnapshot, eventRevision: number): string {
  return [snapshot.openState, snapshot.removed, snapshot.hasMore, eventRevision].join('|')
}
