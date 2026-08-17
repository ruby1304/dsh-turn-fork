/**
 * Per-assistant-message actions, rendered inside the official
 * `conversation.chat.assistant-actions` slot (the message's IconActions row):
 * retry the message's turn, and regenerate when the message is the tail of
 * the latest turn. No DOM injection, no text guessing.
 */
import { useEffect, type ReactElement } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnForkFace } from './controller.ts'
import styles from './AssistantMessageActions.module.css'

type AssistantActionsProps = PropsRuntime<'conversation.chat.assistant-actions'> & InjectFace<TurnForkFace>

export function AssistantMessageActions(props: AssistantActionsProps): ReactElement | null {
  const face: InjectFace<TurnForkFace> = props
  const { t } = face
  const snapshot = face.useTurnFork(value => value)
  const messageId = props.messageId

  useEffect(() => {
    const release = face.acquire()
    face.load()
    return release
  }, [face.acquire, face.load])

  const timeline = snapshot.timeline
  if (timeline === null) return null
  const busy = snapshot.pending !== null
  const entry = timeline.assistantMessageTurns.find(candidate => candidate.messageId === messageId)
  if (entry === undefined) return null

  const turnEntries = timeline.assistantMessageTurns.filter(candidate => candidate.turn === entry.turn)
  const tailOfTurn = turnEntries.at(-1)?.messageId === messageId
  const lastTurnWithAssistant = timeline.assistantMessageTurns.at(-1)?.turn
  const canReroll = tailOfTurn && entry.turn === lastTurnWithAssistant

  return (
    <>
      <button
        type="button"
        className={styles.action}
        disabled={busy}
        title={t('retryTurn', { turn: entry.turn })}
        onClick={() => void face.retryByMessageId(messageId, 'truncate')}
      >
        ↶
      </button>
      {canReroll && (
        <button
          type="button"
          className={styles.action}
          disabled={busy}
          title={t('rerollTurn')}
          onClick={() => void face.rerollByMessageId(messageId)}
        >
          ↻
        </button>
      )}
    </>
  )
}
