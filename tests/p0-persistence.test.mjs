/**
 * P0 regression: branch logs must survive a process restart.
 *
 * Reproduces the exact failure mode of the community plugin dsh-message-edit:
 * its `message-edit/version` provenance event lacked the `ignorable` marker,
 * the live write path accepted it, but the persistence layer's cold-read
 * guard (`assertEventsSupported`) rejects the whole log after a restart.
 *
 * This test drives THIS plugin's real fork-seed builder through a real
 * `dsh-session` store and a real `dsh-session-persistence-jsonl` backend,
 * flushes to disk, then cold-reads the log in a FRESH CHILD PROCESS (the
 * restart). A negative control proves the guard is live: the same log with
 * the marker stripped is rejected.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  TURN_FORK_VERSION_EVENT,
  buildForkSeed,
  planOperation,
} from '../testing.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Real fixture: two completed turns with a request header carrying reasoningEffort. */
function sourceEvents() {
  const now = Date.now()
  const mkUser = (id, text) => ({
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  const mkAssistant = (turn) => ({
    id: `assistant-${turn}`,
    role: 'assistant',
    content: [{ type: 'text', text: `answer ${turn}` }],
    source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
  })
  const events = []
  let seq = 0
  const push = (event) => { events.push({ ...event, seq, time: now + seq }); seq += 1 }
  push({ type: 'request/header', data: { header: { config: { provider: 'test-provider', model: 'test-model', maxTokens: 4096, reasoningEffort: 'max' } }, reason: 'initial' } })
  for (const turn of [1, 2]) {
    push({ type: 'turn/start', data: { turn } })
    push({ type: 'user/message', surfaceOp: 'append', data: mkUser(`user-${turn}`, `prompt ${turn}`) })
    push({ type: 'step/start', data: { turn, step: 1 } })
    push({ type: 'assistant/message', surfaceOp: 'append', sourceEventSeqs: [], data: { turn, step: 1, message: mkAssistant(turn) } })
    push({ type: 'step/end', data: { turn, step: 1 } })
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

/** Mount a real session store + JSONL persistence into one context. */
async function mountHarness(root) {
  const ctx = new Context()
  const fibers = []
  fibers.push(ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(JsonlSessionPersistence, { root }))
  return { ctx, fibers }
}

async function disposeHarness(harness) {
  for (const fiber of harness.fibers.reverse()) await fiber.dispose()
}

/**
 * The live log a persisted seeded fork will hold: the library's end-seed marker
 * sits at the inherited cut and the plugin's provenance event follows it. The
 * in-memory append path cannot carry the envelope's `ignorable` marker, so the
 * marked provenance event is rebuilt from the fork seed.
 */
function liveLogWithProvenance(session, seed, options = {}) {
  const log = [...session.snapshotEvents()]
  const source = seed.events[seed.inheritedLength]
  const provenance = { ...source }
  if (options.stripMarker === true) delete provenance.ignorable
  log.push(provenance)
  // The handle seam demands one contiguous batch in seq order.
  return log.map((event, index) => event.seq === index ? event : { ...event, seq: index })
}

/**
 * Persist one live session's exact log through the 0.1.5-rc.1 handle seam.
 *
 * dsh-session@0.1.5-rc.1 states that SessionStore implements no persistence of
 * its own: the agent lifecycle attaches a write handle to each published
 * session, so a session published outside that lifecycle persists nothing.
 * This harness therefore drives the storage contract directly.
 */
async function persistSeed(ctx, header, events, inheritedEventCount) {
  const handle = await ctx.sessionPersistence.create(header, { inheritedEventCount })
  try {
    await handle.append(events)
    await handle.flush()
  } finally {
    await handle.close()
  }
}

/** The child-process cold reader: mounts a FRESH harness on the same root and inspects. */
function coldReadScript() {
  return `
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
const root = process.argv[1]
const childId = process.argv[2]
const fromSeq = Number(process.argv[3])
const ctx = new Context()
ctx.plugin(SessionStore)
await ctx.plugin(JsonlSessionPersistence, { root })
try {
  // 0.1.5-rc.1 replaced inspect/readFrom with the handle seam.
  const handle = await ctx.sessionPersistence.open(childId, 'read')
  try {
    const full = await handle.read(0)
    const tail = await handle.read(fromSeq)
    console.log(JSON.stringify({ ok: true, types: full.events.map(e => e.type), tailTypes: tail.events.map(e => e.type) }))
  } finally {
    await handle.close()
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 300) }))
}
`
}

function coldRead(root, childId, fromSeq) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', coldReadScript(), root, childId, String(fromSeq)], {
    cwd: join(here, '..'),
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.error !== undefined) throw result.error
  const line = result.stdout.trim().split('\n').at(-1) ?? ''
  return JSON.parse(line)
}

test('P0: fork seed marks every custom provenance event ignorable', () => {
  const events = sourceEvents()
  const plan = planOperation({
    action: 'edit',
    sessionId: 'session-source',
    eventSeq: 2,
    blockIndex: 0,
    text: 'corrected prompt 1',
    cascade: 'truncate',
  }, events)
  const seed = buildForkSeed(events, plan.boundary, plan.version)

  assert.equal(seed.inheritedLength, 1, 'boundary cut keeps the request/header prefix only')
  const own = seed.events.filter(event => event.type === TURN_FORK_VERSION_EVENT)
  assert.equal(own.length, 1)
  assert.equal(own[0].seq, seed.inheritedLength)
  assert.equal(own[0].ignorable, true, 'version event MUST be ignorable:true')
  for (const event of seed.events) {
    if (event.type === TURN_FORK_VERSION_EVENT) {
      assert.equal(event.ignorable, true)
    }
  }
  // Contiguity from seq 0.
  seed.events.forEach((event, index) => assert.equal(event.seq, index))
})

test('P0 regression: branch persists, process restarts, cold read succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'turn-fork-p0-'))
  const events = sourceEvents()
  const plan = planOperation({
    action: 'edit',
    sessionId: 'session-source',
    eventSeq: 2,
    blockIndex: 0,
    text: 'corrected prompt 1',
    cascade: 'truncate',
  }, events)
  const seed = buildForkSeed(events, plan.boundary, plan.version)
  const childId = 'session-branch-p0'

  const harness = await mountHarness(root)
  try {
    // 1) Live construction (the plugin's create path): must succeed.
    const session = harness.ctx.sessions.create(childId, {
      seed: seed.events.slice(0, seed.inheritedLength),
      meta: { parentSession: 'session-source', isSeeded: true },
      inheritedEventCount: seed.inheritedLength,
    })
    // dsh-session@0.1.5-rc.1 admits only the inherited prefix as the
    // constructor seed and forbids the plugin event from riding along, so the
    // live session is the prefix and the provenance event is written by the
    // storage path with its envelope marker intact.
    // The library seeds the end-seed marker at the inherited cut; the plugin's
    // provenance event belongs after it and carries the envelope marker.
    const live = liveLogWithProvenance(session, seed)
    assert.equal(live[seed.inheritedLength].type, 'session/end-seed', 'the library seeds the marker at the inherited cut')
    assert.equal(live[seed.inheritedLength + 1].type, TURN_FORK_VERSION_EVENT, 'provenance follows the marker')
    // 2) Persist the live log exactly as the storage seam will receive it.
    await persistSeed(harness.ctx, {
      id: SessionId(childId),
      version: 3,
      createdAt: Date.now(),
      isSeeded: true,
      parentSession: SessionId('session-source'),
    }, live, seed.inheritedLength)
  } finally {
    await disposeHarness(harness)
  }

  // 3) "Restart": a fresh process cold-reads the persisted log.
  const cold = coldRead(root, childId, seed.inheritedLength)
  assert.equal(cold.ok, true, `cold read must succeed after restart: ${JSON.stringify(cold)}`)
  assert.ok(cold.types.includes(TURN_FORK_VERSION_EVENT), 'version event survives the restart')
  // The child-owned tail opens with the library's inherited end-seed marker;
  // the plugin's provenance event follows it.
  assert.equal(cold.tailTypes[0], 'session/end-seed', 'readFrom(inheritedEventCount) starts at the seed marker')
  assert.equal(cold.tailTypes[1], TURN_FORK_VERSION_EVENT, 'provenance trails the seed marker')
  rmSync(root, { recursive: true, force: true })
})

test('P0 negative control: the SAME log without ignorable is rejected after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'turn-fork-p0-neg-'))
  const events = sourceEvents()
  const plan = planOperation({
    action: 'edit',
    sessionId: 'session-source',
    eventSeq: 2,
    blockIndex: 0,
    text: 'corrected prompt 1',
    cascade: 'truncate',
  }, events)
  const seed = buildForkSeed(events, plan.boundary, plan.version)
  // Simulate the community plugin's bug: strip the marker on the written copy.
  const brokenSeed = seed.events.map(event => {
    if (event.type !== TURN_FORK_VERSION_EVENT) return event
    const copy = { ...event }
    delete copy.ignorable
    return copy
  })
  const childId = 'session-branch-broken'

  const harness = await mountHarness(root)
  try {
    const session = harness.ctx.sessions.create(childId, {
      seed: brokenSeed.slice(0, seed.inheritedLength),
      meta: { parentSession: 'session-source', isSeeded: true },
      inheritedEventCount: seed.inheritedLength,
    })
    const live = liveLogWithProvenance(session, seed, { stripMarker: true })
    await persistSeed(harness.ctx, {
      id: SessionId(childId),
      version: 3,
      createdAt: Date.now(),
      isSeeded: true,
      parentSession: SessionId('session-source'),
    }, live, seed.inheritedLength)
  } finally {
    await disposeHarness(harness)
  }

  const cold = coldRead(root, childId, seed.inheritedLength)
  assert.equal(cold.ok, false, 'cold read must refuse the unmarked event')
  // 0.1.5-rc.1 tightened where the refusal fires: the write-path contract
  // validator rejects the unmarked record as corruption before the cold-read
  // vocabulary gate can call it unsupported. Either way the log is refused
  // fail-closed and the offending event type is named.
  assert.ok(
    ['SessionFormatUnsupportedError', 'SessionPersistenceCorruptionError'].includes(cold.name),
    `unexpected refusal type: ${cold.name}`,
  )
  assert.match(cold.message, new RegExp(TURN_FORK_VERSION_EVENT.replace('/', '\\/')))
  rmSync(root, { recursive: true, force: true })
})
