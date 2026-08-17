/** Unit tests for the version-lineage projection with stubbed service faces. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ownVersionEvent, projectTimeline } from '../testing.mjs'

let uid = 0
const mkUser = (text) => ({
  id: `user-${uid += 1}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
const mkAssistant = (turn) => ({
  id: `assistant-${turn}-${uid += 1}`,
  role: 'assistant',
  content: [{ type: 'text', text: `answer ${turn}` }],
  source: { kind: 'model', provider: 'p', model: 'm' },
})

/** A two-turn completed log, seqs contiguous from 0. */
function turnLog() {
  const events = []
  let seq = 0
  const push = (event) => { events.push({ ...event, seq, time: 1000 + seq }); seq += 1 }
  for (const turn of [1, 2]) {
    push({ type: 'turn/start', data: { turn } })
    push({ type: 'user/message', surfaceOp: 'append', data: mkUser(`prompt ${turn}`) })
    push({ type: 'step/start', data: { turn, step: 1 } })
    push({ type: 'assistant/message', surfaceOp: 'append', sourceEventSeqs: [], data: { turn, step: 1, message: mkAssistant(turn) } })
    push({ type: 'step/end', data: { turn, step: 1 } })
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

function versionEvent(seq, time, effectId, inverseSessionId) {
  return {
    type: 'turn-fork/version', seq, time, ignorable: true,
    data: {
      schemaVersion: 1,
      effect: { id: effectId, operation: 'edit', cascade: 'truncate', targetTurn: 1, targetEventSeq: 1, before: 'old', after: 'new' },
      inverse: { kind: 'restore-version', sessionId: inverseSessionId },
    },
  }
}

function buildLineage() {
  const rootLog = turnLog()
  const root = {
    header: { id: 'session-root', createdAt: 1000, seedLength: 0 },
    live: false, persisted: true,
  }

  const branchLog = [...rootLog.slice(0, 2), versionEvent(2, 2000, 'effect-branch', 'session-root')]
  for (const event of turnLog().slice(2)) branchLog.push({ ...event, seq: branchLog.length, time: 3000 + branchLog.length })
  const branch = {
    header: { id: 'session-branch', parentSession: 'session-root', seedLength: 2, createdAt: 2500 },
    live: false, persisted: true,
  }

  const branch2Log = [...branchLog.slice(0, 1), versionEvent(1, 4000, 'effect-branch-2', 'session-branch')]
  const branch2 = {
    header: { id: 'session-branch-2', parentSession: 'session-branch', seedLength: 1, createdAt: 4500 },
    live: false, persisted: true,
  }

  const lineage = {
    root,
    branch,
    branchLog,
    branch2,
    branch2Log,
    descendants: [{
      session: branch,
      descendants: [{ session: branch2, descendants: [] }],
    }],
  }
  return lineage
}

function stubDeps(lineage, { current = 'session-branch', running = [] } = {}) {
  const records = {
    'session-root': lineage.root,
    'session-branch': lineage.branch,
    'session-branch-2': lineage.branch2,
  }
  return {
    sessions: { get: () => undefined },
    agents: {
      get: (id) => running.includes(id) ? { status: 'running' } : undefined,
    },
    sessionQuery: {
      traceSession: async (id) => {
        const target = records[id]
        const root = lineage.root
        const ancestors = id === 'session-root' ? []
          : id === 'session-branch' ? [lineage.root]
            : [lineage.branch, lineage.root]
        return { complete: true, root, target, ancestors, descendants: lineage.descendants }
      },
      readSession: async (id) => {
        if (id === 'session-root') return { session: lineage.root.header, events: turnLog() }
        if (id === 'session-branch') return { session: lineage.branch.header, events: lineage.branchLog }
        if (id === 'session-branch-2') return { session: lineage.branch2.header, events: lineage.branch2Log }
        throw new Error(`unknown ${id}`)
      },
    },
    sessionPersistence: {
      inspect: async (id) => ({ events: records[id] === lineage.root ? turnLog() : records[id] === lineage.branch ? lineage.branchLog : lineage.branch2Log }),
      readFrom: async (id, fromSeq) => {
        const log = id === 'session-branch' ? lineage.branchLog : lineage.branch2Log
        return { events: log.slice(fromSeq) }
      },
    },
  }
}

test('ownVersionEvent validates schema, inverse pairing, and effect identity', () => {
  const { branch, branchLog } = buildLineage()
  const projection = ownVersionEvent(branch.header, branchLog)
  assert.equal(projection.effectId, 'effect-branch')
  assert.equal(projection.inverseSessionId, 'session-root')
  assert.equal(projection.operation, 'edit')
  assert.equal(projection.before, 'old')
  assert.equal(projection.after, 'new')

  // Future schema version refuses to be interpreted.
  const futureLog = [...branchLog]
  futureLog[2] = { ...versionEvent(2, 2000, 'e', 'session-root'), data: { ...versionEvent(2, 2000, 'e', 'session-root').data, schemaVersion: 99 } }
  assert.throws(() => ownVersionEvent(branch.header, futureLog), /更新版本/)

  // Inverse mismatch is structural corruption.
  const mismatched = [...branchLog]
  mismatched[2] = { ...versionEvent(2, 2000, 'e', 'session-root'), data: { ...versionEvent(2, 2000, 'e', 'session-root').data, inverse: { kind: 'restore-version', sessionId: 'other' } } }
  assert.throws(() => ownVersionEvent(branch.header, mismatched), /不匹配/)

  // A log with no own version event projects undefined.
  assert.equal(ownVersionEvent(branch.header, branchLog.slice(0, 2)), undefined)
})

test('projectTimeline builds versions, undo/redo stacks, messages, and running flags', async () => {
  const lineage = buildLineage()
  const payload = await projectTimeline(stubDeps(lineage, { running: ['session-branch'] }), 'session-branch')

  assert.equal(payload.sessionId, 'session-branch')
  assert.deepEqual(payload.versions.map(version => version.sessionId), ['session-root', 'session-branch', 'session-branch-2'])
  assert.deepEqual(payload.undoStack, ['session-root'])
  assert.deepEqual(payload.redoSessionIds, ['session-branch-2'])
  assert.deepEqual(payload.running, ['session-branch'])

  const currentVersion = payload.versions.find(version => version.sessionId === 'session-branch')
  assert.equal(currentVersion.current, true)
  assert.equal(currentVersion.operation, 'edit')
  assert.equal(currentVersion.before, 'old')
  assert.equal(currentVersion.after, 'new')
  assert.equal(currentVersion.parentSessionId, 'session-root')

  const rootVersion = payload.versions.find(version => version.sessionId === 'session-root')
  assert.equal(rootVersion.operation, undefined)
  assert.equal(rootVersion.current, false)
  assert.equal(rootVersion.onCurrentEffectPath, true)

  assert.equal(payload.messages.length, 2)
  assert.equal(payload.messages[0].text, 'prompt 1')
  assert.equal(payload.retryableTurns.length, 2)
  assert.equal(payload.assistantMessageTurns.length, 2)
  assert.equal(payload.assistantMessageTurns[0].turn, 1)
})

test('projectTimeline from the root exposes no undo and children as redo', async () => {
  const lineage = buildLineage()
  const payload = await projectTimeline(stubDeps(lineage, { current: 'session-root' }), 'session-root')
  assert.deepEqual(payload.undoStack, [])
  assert.deepEqual(payload.redoSessionIds, ['session-branch'])
  assert.equal(payload.versions.find(version => version.sessionId === 'session-root').current, true)
})
