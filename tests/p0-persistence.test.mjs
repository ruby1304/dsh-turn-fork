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
  const inspected = await ctx.sessionPersistence.inspect(childId)
  const tail = await ctx.sessionPersistence.readFrom(childId, fromSeq)
  console.log(JSON.stringify({ ok: true, types: inspected.events.map(e => e.type), tailTypes: tail.events.map(e => e.type) }))
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
      seed: seed.events,
      meta: { parentSession: 'session-source', seedLength: seed.inheritedLength },
    })
    assert.ok(session.events.length >= seed.events.length, 'auto projections may extend the live log')
    // 2) Flush to durable storage.
    const flushed = await harness.ctx.sessions.flush(session)
    assert.equal(flushed, true, 'a durability listener participated')
  } finally {
    await disposeHarness(harness)
  }

  // 3) "Restart": a fresh process cold-reads the persisted log.
  const cold = coldRead(root, childId, seed.inheritedLength)
  assert.equal(cold.ok, true, `cold read must succeed after restart: ${JSON.stringify(cold)}`)
  assert.ok(cold.types.includes(TURN_FORK_VERSION_EVENT), 'version event survives the restart')
  assert.equal(cold.tailTypes[0], TURN_FORK_VERSION_EVENT, 'readFrom(seedLength) starts at the version event')
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
      seed: brokenSeed,
      meta: { parentSession: 'session-source', seedLength: seed.inheritedLength },
    })
    const flushed = await harness.ctx.sessions.flush(session)
    assert.equal(flushed, true, 'live write path accepts the unmarked event (the silent failure mode)')
  } finally {
    await disposeHarness(harness)
  }

  const cold = coldRead(root, childId, seed.inheritedLength)
  assert.equal(cold.ok, false, 'cold read must refuse the unmarked event')
  assert.equal(cold.name, 'SessionFormatUnsupportedError')
  assert.match(cold.message, new RegExp(TURN_FORK_VERSION_EVENT.replace('/', '\\/')))
  rmSync(root, { recursive: true, force: true })
})
