/** Unit tests for the pure host core: folding, planning, config, trust fence, decoding. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IncomingMessage } from 'node:http'
import {
  MAX_REQUEST_BODY_BYTES,
  TURN_FORK_VERSION_EVENT,
  TURN_FORK_VERSION_SCHEMA,
  agentOptionsFrom,
  buildForkSeed,
  closedTurns,
  decodeOperation,
  editPlan,
  isLegacyFormatError,
  isTrustedRequest,
  planOperation,
  readJsonBody,
  rerollPlan,
  retryPlan,
} from '../testing.mjs'

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

/** Fixture log: one header + N turns; each turn has a user message and, optionally, steering. */
function fixture({ steering = false, turns = 2 } = {}) {
  const events = []
  let seq = 0
  const push = (event) => { events.push({ ...event, seq, time: 1000 + seq }); seq += 1 }
  push({ type: 'request/header', data: { header: { config: { provider: 'route-p', model: 'route-m', maxTokens: 8192, reasoningEffort: 'max' } }, reason: 'initial' } })
  for (const turn of Array.from({ length: turns }, (_, index) => index + 1)) {
    push({ type: 'turn/start', data: { turn } })
    push({ type: 'user/message', surfaceOp: 'append', data: mkUser(`prompt ${turn}`) })
    if (steering) {
      push({ type: 'user/message', surfaceOp: 'append', data: mkUser(`steering ${turn}`) })
    }
    push({ type: 'step/start', data: { turn, step: 1 } })
    push({ type: 'assistant/message', surfaceOp: 'append', sourceEventSeqs: [], data: { turn, step: 1, message: mkAssistant(turn) } })
    push({ type: 'step/end', data: { turn, step: 1 } })
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

test('closedTurns preserves every user input of a turn in order (steering fidelity)', () => {
  const turns = closedTurns(fixture({ steering: true }))
  assert.equal(turns.length, 2)
  for (const turn of turns) {
    assert.equal(turn.users.length, 2, 'prompt + steering both survive')
    assert.match(turn.users[0].data.content[0].text, /^prompt/)
    assert.match(turn.users[1].data.content[0].text, /^steering/)
  }
})

test('editPlan cuts before the target turn and replays every downstream input on preserve', () => {
  const events = fixture({ steering: true })
  const plan = editPlan({
    action: 'edit', sessionId: 'src', eventSeq: 2, blockIndex: 0, text: 'fixed', cascade: 'preserve',
  }, closedTurns(events))
  assert.equal(plan.boundary, 0, 'prefix ends at the header event (turn 1 startSeq - 1)')
  assert.equal(plan.queuedUsers.length, 3, 'edited + prompt2 + steering2 (the edited turn\'s own steering is stale)')
  assert.equal(plan.queuedUsers[0].content[0].text, 'fixed')
  assert.equal(plan.queuedUsers[1].content[0].text, 'prompt 2')
  assert.equal(plan.queuedUsers[2].content[0].text, 'steering 2')
  assert.equal(plan.version.effect.operation, 'edit')
  assert.equal(plan.version.effect.before, 'prompt 1')
  assert.equal(plan.version.effect.after, 'fixed')
  assert.equal(plan.version.inverse.kind, 'restore-version')
  assert.equal(plan.version.inverse.sessionId, 'src')
})

test('editPlan with truncate drops downstream inputs entirely', () => {
  const events = fixture({ steering: true })
  const plan = editPlan({
    action: 'edit', sessionId: 'src', eventSeq: 2, blockIndex: 0, text: 'fixed', cascade: 'truncate',
  }, closedTurns(events))
  assert.equal(plan.queuedUsers.length, 1)
  assert.equal(plan.queuedUsers[0].content[0].text, 'fixed')
})

test('retryPlan replays the target turn and (on preserve) everything after it', () => {
  const events = fixture({ steering: true })
  const truncate = retryPlan('src', 2, 'truncate', closedTurns(events))
  assert.equal(truncate.boundary, 7, 'cuts before turn 2 start (seq 8)')
  assert.equal(truncate.queuedUsers.length, 2, 'turn 2 prompt + steering only')
  assert.equal(truncate.queuedUsers[0].content[0].text, 'prompt 2')

  const preserve = retryPlan('src', 2, 'preserve', closedTurns(events))
  assert.equal(preserve.queuedUsers.length, 2, 'no turns after turn 2')
  assert.equal(preserve.version.effect.cascade, 'preserve')
})

test('rerollPlan targets the latest turn with a settled textual reply', () => {
  const events = fixture()
  const plan = rerollPlan('src', closedTurns(events))
  assert.equal(plan.version.effect.targetTurn, 2)
  assert.equal(plan.queuedUsers.length, 1)
  assert.equal(plan.queuedUsers[0].content[0].text, 'prompt 2')
})

test('planOperation rejects non-edit actions inside pure planning is routed by kind', () => {
  const events = fixture()
  const retry = planOperation({ action: 'retry', sessionId: 'src', turn: 1, cascade: 'truncate' }, events)
  assert.equal(retry.version.effect.operation, 'retry')
})

test('buildForkSeed emits a contiguous, ignorable version event at the boundary', () => {
  const events = fixture()
  const plan = planOperation({ action: 'edit', sessionId: 'src', eventSeq: 2, blockIndex: 0, text: 'x', cascade: 'truncate' }, events)
  const seed = buildForkSeed(events, plan.boundary, plan.version)
  seed.events.forEach((event, index) => assert.equal(event.seq, index))
  const version = seed.events[seed.inheritedLength]
  assert.equal(version.type, TURN_FORK_VERSION_EVENT)
  assert.equal(version.ignorable, true)
  assert.equal(version.data.schemaVersion, TURN_FORK_VERSION_SCHEMA)
  assert.equal(version.data.inverse.sessionId, 'src')
})

test('buildForkSeed with boundary -1 forks an empty prefix (first-turn edit)', () => {
  const events = fixture()
  const seed = buildForkSeed(events, -1, {
    schemaVersion: 1,
    effect: { id: 'e', operation: 'edit', cascade: 'truncate', targetTurn: 1, targetEventSeq: 2 },
    inverse: { kind: 'restore-version', sessionId: 'src' },
  })
  assert.equal(seed.inheritedLength, 0)
  assert.equal(seed.events.length, 1)
  assert.equal(seed.events[0].seq, 0)
  assert.equal(seed.events[0].ignorable, true)
})

test('agentOptionsFrom reads provider/model/maxTokens from the LAST request/header', () => {
  const events = fixture()
  const turn2Start = events.findIndex(event => event.type === 'turn/start' && event.data.turn === 2)
  events.splice(turn2Start, 0, {
    type: 'request/header',
    data: { header: { config: { provider: 'new-p', model: 'new-m', maxTokens: 1234, reasoningEffort: 'low' } }, reason: 'change' },
  })
  events.forEach((event, index) => { event.seq = index; event.time = 1000 + index })
  const options = agentOptionsFrom(events)
  assert.deepEqual(options, { provider: 'new-p', model: 'new-m', maxTokens: 1234 })
  // reasoningEffort rides the inherited seed header (asserted on the seed below).
  const plan = planOperation({ action: 'retry', sessionId: 'src', turn: 2, cascade: 'truncate' }, events)
  const seed = buildForkSeed(events, plan.boundary, plan.version)
  const inheritedHeaders = seed.events.filter(event => event.type === 'request/header')
  assert.equal(inheritedHeaders.length, 2, 'request/header history is inherited verbatim')
  assert.equal(inheritedHeaders.at(-1).data.header.config.reasoningEffort, 'low', 'reasoningEffort survives in the seed')
})

test('agentOptionsFrom falls back to agent options and rejects empty routes', () => {
  const options = agentOptionsFrom([], { provider: 'p', model: 'm' })
  assert.deepEqual(options, { provider: 'p', model: 'm' })
  assert.throws(() => agentOptionsFrom([], undefined), /无法从会话历史解析模型路由/)
  assert.throws(() => agentOptionsFrom([], { provider: '', model: '' }), /无法从会话历史解析模型路由/)
})

test('trust fence: same-origin loopback accepted, cross-origin and rebinding rejected', () => {
  const server = { host: '127.0.0.1', port: 3080 }
  assert.equal(isTrustedRequest('http://127.0.0.1:3080', '127.0.0.1:3080', server.host, server.port), true)
  assert.equal(isTrustedRequest('http://localhost:3080', 'localhost:3080', server.host, server.port), true)
  assert.equal(isTrustedRequest(undefined, '127.0.0.1:3080', server.host, server.port), true)
  assert.equal(isTrustedRequest(undefined, 'localhost', server.host, server.port), true)
  // CSRF from a malicious page.
  assert.equal(isTrustedRequest('http://evil.example', '127.0.0.1:3080', server.host, server.port), false)
  // DNS rebinding: attacker hostname resolves to loopback.
  assert.equal(isTrustedRequest('http://evil.example:3080', 'evil.example:3080', server.host, server.port), false)
  assert.equal(isTrustedRequest(undefined, 'evil.example:3080', server.host, server.port), false)
  // Port mismatch on a trusted hostname.
  assert.equal(isTrustedRequest('http://127.0.0.1:5173', '127.0.0.1:5173', server.host, server.port), false)
  // No origin, no host.
  assert.equal(isTrustedRequest(undefined, undefined, server.host, server.port), false)
  // Malformed origin.
  assert.equal(isTrustedRequest('not a url', '127.0.0.1:3080', server.host, server.port), false)
  // All-interfaces deployment is operator opt-in to remote exposure.
  assert.equal(isTrustedRequest('http://whatever.example', 'whatever.example:3080', '0.0.0.0', server.port), true)
})

function incomingRequest({ contentType = 'application/json', body = '{}', contentLength } = {}) {
  const request = new IncomingMessage()
  if (contentLength !== undefined) request.headers['content-length'] = String(contentLength)
  if (contentType !== undefined) request.headers['content-type'] = contentType
  request.push(Buffer.from(body))
  request.push(null)
  return request
}

test('readJsonBody parses JSON and enforces the byte cap', async () => {
  assert.deepEqual(await readJsonBody(incomingRequest({ body: '{"a":1}' })), { a: 1 })
  const big = 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1)
  await assert.rejects(readJsonBody(incomingRequest({ body: big })), /请求体超过/)
  await assert.rejects(
    readJsonBody(incomingRequest({ body: big.slice(0, 64), contentLength: MAX_REQUEST_BODY_BYTES + 1 })),
    /请求体超过/,
  )
  await assert.rejects(readJsonBody(incomingRequest({ body: 'not json' })), SyntaxError)
})

test('decodeOperation validates shapes and accepts all four actions', () => {
  assert.deepEqual(decodeOperation({ action: 'edit', sessionId: 's', eventSeq: 1, blockIndex: 0, text: 't', cascade: 'truncate' }), {
    action: 'edit', sessionId: 's', eventSeq: 1, blockIndex: 0, text: 't', cascade: 'truncate',
  })
  assert.deepEqual(decodeOperation({ action: 'retry', sessionId: 's', turn: 2, cascade: 'preserve' }), {
    action: 'retry', sessionId: 's', turn: 2, cascade: 'preserve',
  })
  assert.deepEqual(decodeOperation({ action: 'reroll', sessionId: 's' }), { action: 'reroll', sessionId: 's' })
  assert.deepEqual(decodeOperation({ action: 'cancel', sessionId: 's' }), { action: 'cancel', sessionId: 's' })
  assert.throws(() => decodeOperation({ action: 'edit', sessionId: 's', eventSeq: -1, blockIndex: 0, text: 't', cascade: 'truncate' }), TypeError)
  assert.throws(() => decodeOperation({ action: 'edit', sessionId: 's', eventSeq: 1, blockIndex: 0, text: 't', cascade: 'nope' }), TypeError)
  assert.throws(() => decodeOperation({ action: 'unknown', sessionId: 's' }), TypeError)
  assert.throws(() => decodeOperation('not an object'), TypeError)
})

test('isLegacyFormatError flags the foreign broken event type', () => {
  const guard = new Error('session "x" contains event type "message-edit/version" (seq 3) unknown to this harness and not marked ignorable')
  guard.name = 'SessionFormatUnsupportedError'
  assert.equal(isLegacyFormatError(guard), true)
  const other = new Error('session "x" contains event type "turn-fork/version" (seq 3) unknown')
  other.name = 'SessionFormatUnsupportedError'
  assert.equal(isLegacyFormatError(other), false)
  assert.equal(isLegacyFormatError(new Error('boom')), false)
})
