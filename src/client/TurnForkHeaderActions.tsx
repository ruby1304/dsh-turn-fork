/** Compact session-header controls: undo, redo, regenerate. */
import { useEffect, type ReactElement } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnForkFace } from './controller.ts'
import styles from './TurnForkHeaderActions.module.css'

type HeaderProps = PropsRuntime<'conversation.session.header.actions'> & InjectFace<TurnForkFace>

export function TurnForkHeaderActions(props: HeaderProps): ReactElement | null {
  const face: InjectFace<TurnForkFace> = props
  const { t } = face
  const snapshot = face.useTurnFork(value => value)

  useEffect(() => {
    const release = face.acquire()
    face.load()
    return release
  }, [face.acquire, face.load])

  const timeline = snapshot.timeline
  if (timeline === null) return null
  const busy = snapshot.pending !== null
  const undoId = timeline.undoStack[0]
  const redoId = timeline.redoSessionIds[0]
  const running = timeline.running.length > 0

  return (
    <>
      {undoId !== undefined && (
        <button
          type="button"
          className={styles.action}
          disabled={busy}
          title={`${t('undo')} → ${undoId}`}
          onClick={() => void face.openVersion(undoId)}
        >
          ↶ {t('undo')}
        </button>
      )}
      {redoId !== undefined && (
        <button
          type="button"
          className={styles.action}
          disabled={busy}
          title={`${t('redo')} → ${redoId}`}
          onClick={() => void face.openVersion(redoId)}
        >
          ↷ {t('redo')}
        </button>
      )}
      <button
        type="button"
        className={styles.action}
        disabled={busy}
        title={t('rerollTurn')}
        onClick={() => void face.reroll()}
      >
        ↻ {t('reroll')}
      </button>
      {running && (
        <span className={styles.runningDot} title={t('runningBranches', { list: timeline.running.join(', ') })}>
          ⚠
        </span>
      )}
    </>
  )
}
