/** Timeline tab: message editor, turn retry/reroll, version tree, undo/redo. */
import { useEffect, useState, type ReactElement } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CascadePolicy, EditableMessageBlock } from '../shared.ts'
import type { TurnForkFace } from './controller.ts'
import styles from './TurnForkTimelineView.module.css'

type ViewProps = PropsRuntime<'conversation.view'> & InjectFace<TurnForkFace>

/** The bound inject face (useTurnFork synthesized from the hooks compartment). */
type BoundFace = InjectFace<TurnForkFace>

interface EditorState {
  block: EditableMessageBlock
  text: string
  cascade: CascadePolicy
}

function EditPanel({
  editor,
  face,
  onChangeText,
  onChangeCascade,
  close,
}: {
  editor: EditorState
  face: BoundFace
  onChangeText: (text: string) => void
  onChangeCascade: (cascade: CascadePolicy) => void
  close: () => void
}): ReactElement {
  const { t } = face
  const [saving, setSaving] = useState(false)
  const snapshot = face.useTurnFork(value => value)
  const laterTurns = snapshot.timeline === null
    ? 0
    : snapshot.timeline.retryableTurns.filter(turn => turn.turn > editor.block.turn).length

  const save = (): void => {
    if (saving) return
    setSaving(true)
    void face.edit(editor.block, editor.text, editor.cascade).then((applied) => {
      if (!applied) setSaving(false)
    })
  }

  return (
    <div className={styles.editor}>
      <div className={styles.editorTitle}>{t('editorTitle', { turn: editor.block.turn })}</div>
      <label className={styles.editorLabel}>
        {t('editorLabel')}
        <textarea
          className={styles.editorInput}
          value={editor.text}
          placeholder={t('editorPlaceholder')}
          onChange={event => onChangeText(event.target.value)}
        />
      </label>
      <div className={styles.cascadeRow}>
        <span className={styles.cascadeLabel}>{t('cascadeLabel')}</span>
        {(['truncate', 'preserve'] as const).map((policy) => {
          const active = editor.cascade === policy
          return (
            <button
              key={policy}
              type="button"
              className={active ? styles.cascadeChoiceActive : styles.cascadeChoice}
              onClick={() => onChangeCascade(policy)}
              title={policy === 'truncate' ? t('cascadeTruncateHint') : t('cascadePreserveHint')}
            >
              {policy === 'truncate' ? t('cascadeTruncate') : t('cascadePreserve')}
            </button>
          )
        })}
      </div>
      {editor.cascade === 'preserve' && laterTurns > 0 && (
        <div className={styles.costHint}>{t('cascadeCostHint', { count: laterTurns })}</div>
      )}
      <div className={styles.editorFooter}>
        <button type="button" className={styles.primary} disabled={saving} onClick={save}>
          {t('save')}
        </button>
        <button type="button" disabled={saving} onClick={close}>
          {t('cancel')}
        </button>
      </div>
    </div>
  )
}

function VersionRow({
  depth,
  sessionId,
  summary,
  face,
}: {
  depth: number
  sessionId: string
  summary: string
  face: BoundFace
}): ReactElement | null {
  const snapshot = face.useTurnFork(value => value)
  const timeline = snapshot.timeline
  if (timeline === null) return null
  const version = timeline.versions.find(candidate => candidate.sessionId === sessionId)
  const running = timeline.running.includes(sessionId)
  const current = version?.current === true
  return (
    <div
      className={styles.versionRow}
      style={{ marginLeft: `${String(depth * 16)}px` }}
      data-current={current ? 'true' : 'false'}
    >
      <span className={styles.versionSummary}>{summary}</span>
      {current && <span className={styles.badge}>{face.t('current')}</span>}
      {running && (
        <span className={styles.runningBadge} title={face.t('runningWarning')}>
          ⚠ {face.t('branch')}
        </span>
      )}
      <span className={styles.versionActions}>
        {running && (
          <button type="button" className={styles.stopButton} onClick={() => void face.stopBranch(sessionId)}>
            {face.t('stopBranch')}
          </button>
        )}
        {!current && (
          <button type="button" onClick={() => void face.openVersion(sessionId)}>
            {face.t('openVersion')}
          </button>
        )}
      </span>
    </div>
  )
}

export function TurnForkTimelineView(props: ViewProps): ReactElement {
  const face: BoundFace = props
  const { t } = face
  const snapshot = face.useTurnFork(value => value)
  const [editor, setEditor] = useState<EditorState | null>(null)

  useEffect(() => {
    const release = face.acquire()
    face.load()
    return release
  }, [face.acquire, face.load])

  const timeline = snapshot.timeline
  const busy = snapshot.pending !== null

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>{t('viewLabel')}</span>
        <span className={styles.description}>{t('viewDescription')}</span>
        <span className={styles.headerActions}>
          {timeline !== null && timeline.undoStack[0] !== undefined && (
            <button type="button" disabled={busy} onClick={() => void face.openVersion(timeline.undoStack[0] ?? '')}>
              ↶ {t('undo')}
            </button>
          )}
          {timeline !== null && timeline.redoSessionIds[0] !== undefined && (
            <button type="button" disabled={busy} onClick={() => void face.openVersion(timeline.redoSessionIds[0] ?? '')}>
              ↷ {t('redo')}
            </button>
          )}
          {timeline !== null && (
            <button type="button" disabled={busy} onClick={() => void face.reroll()}>
              {t('reroll')}
            </button>
          )}
        </span>
      </div>

      {snapshot.status === 'error' && (
        <div className={snapshot.migration ? styles.migration : styles.error}>
          <div>{snapshot.migration ? t('migrateUnsupported') : `${t('statusError')}：${snapshot.error ?? ''}`}</div>
          {!snapshot.migration && (
            <button type="button" onClick={() => face.load()}>
              {t('retryLoad')}
            </button>
          )}
        </div>
      )}
      {snapshot.status === 'loading' && <div className={styles.notice}>{t('statusLoading')}</div>}
      {timeline !== null && timeline.running.length > 0 && (
        <div className={styles.runningBanner}>{t('runningBranches', { list: timeline.running.join(', ') })}</div>
      )}
      {snapshot.error !== null && snapshot.status === 'ready' && (
        <div className={styles.error}>{t('errorOperation', { error: snapshot.error })}</div>
      )}
      {editor !== null && (
        <EditPanel
          editor={editor}
          face={face}
          onChangeText={text => setEditor(previous => previous === null ? previous : { ...previous, text })}
          onChangeCascade={cascade => setEditor(previous => previous === null ? previous : { ...previous, cascade })}
          close={() => setEditor(null)}
        />
      )}
      {timeline === null && snapshot.status === 'ready' && (
        <div className={styles.notice}>{t('timelineUnavailable')}</div>
      )}

      {timeline !== null && (
        <div className={styles.sections}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{t('sectionMessages')}</h3>
            {timeline.messages.length === 0 && <div className={styles.notice}>{t('emptyMessages')}</div>}
            {timeline.messages.map(message => (
              <div key={message.key} className={styles.row}>
                <span className={styles.rowTitle}>{t('versionTurn', { turn: message.turn })}</span>
                <span className={styles.rowBody}>{message.text}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setEditor({ block: message, text: message.text, cascade: 'truncate' })}
                >
                  {t('edit')}
                </button>
              </div>
            ))}
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{t('sectionTurns')}</h3>
            {timeline.retryableTurns.length === 0 && <div className={styles.notice}>{t('noMessages')}</div>}
            {timeline.retryableTurns.map(turn => (
              <div key={turn.turn} className={styles.row}>
                <span className={styles.rowTitle}>{t('versionTurn', { turn: turn.turn })}</span>
                <span className={styles.rowBody}>{turn.preview}</span>
                <button
                  type="button"
                  disabled={busy}
                  title={t('cascadeTruncateHint')}
                  onClick={() => void face.retry(turn.turn, 'truncate')}
                >
                  {t('retry')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  title={t('cascadePreserveHint')}
                  onClick={() => void face.retry(turn.turn, 'preserve')}
                >
                  {`${t('retry')} + ${t('cascadePreserve')}`}
                </button>
              </div>
            ))}
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{t('sectionVersions')}</h3>
            <div className={styles.versionNote}>{t('deleteUnsupported')}</div>
            {timeline.versions.map((version) => {
              let summary: string
              if (version.operation === undefined) {
                summary = `${t('rootVersion')} · ${version.sessionId}`
              } else if (version.operation === 'edit') {
                summary = `${t('versionEdit')} · ${t('versionTurn', { turn: version.targetTurn ?? 0 })}`
                if (version.before !== undefined && version.after !== undefined) {
                  summary += ` (${t('versionFrom')} “${version.before}” ${t('versionTo')} “${version.after}”)`
                }
              } else if (version.operation === 'retry') {
                summary = t('versionRetry', { turn: version.targetTurn ?? 0 })
              } else {
                summary = t('versionReroll', { turn: version.targetTurn ?? 0 })
              }
              return (
                <VersionRow
                  key={version.sessionId}
                  depth={version.depth}
                  sessionId={version.sessionId}
                  summary={summary}
                  face={face}
                />
              )
            })}
          </section>
        </div>
      )}
    </div>
  )
}
