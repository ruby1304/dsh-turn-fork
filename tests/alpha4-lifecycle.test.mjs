/** alpha.4 lifecycle contract: optional webServer may arrive after plugin load. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import * as TurnFork from '../index.mjs'

const FIXTURE_SESSION_ID = 'fixture-alpha4-session'

function fixtureServices() {
  const record = {
    header: { version: 0, id: FIXTURE_SESSION_ID, createdAt: 1_700_000_000_000, isSeeded: false },
    live: false,
    persisted: true,
  }
  return {
    sessions: {
      get: () => undefined,
      flush: async () => {},
    },
    agents: {
      get: () => undefined,
    },
    sessionQuery: {
      traceSession: async (sessionId) => {
        assert.equal(sessionId, FIXTURE_SESSION_ID)
        return { complete: true, root: record, target: record, ancestors: [], descendants: [] }
      },
      readSession: async (sessionId) => {
        assert.equal(sessionId, FIXTURE_SESSION_ID)
        return { session: record.header, inheritedEventCount: 0, events: [] }
      },
    },
  }
}

function provideRequired(ctx) {
  const services = fixtureServices()
  return Object.entries(services).map(([service, value]) => ctx.provide(service, value))
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail(message)
}

async function disposeAll(disposers) {
  for (const dispose of disposers.reverse()) await dispose()
}

test('headless alpha.4 profile loads without webServer', async () => {
  const ctx = new Context()
  const serviceDisposers = provideRequired(ctx)
  const plugin = await ctx.plugin(TurnFork)
  try {
    assert.notEqual(plugin.store, undefined, 'plugin reached the active state')
    assert.equal(ctx.get('webServer'), undefined)
  } finally {
    await plugin.dispose()
    await disposeAll(serviceDisposers)
  }
})

test('delayed alpha.4 webServer injection registers exact GET /turn-fork JSON route', async () => {
  const ctx = new Context()
  const serviceDisposers = provideRequired(ctx)
  const plugin = await ctx.plugin(TurnFork)
  let registeredRoute
  let routeDisposeCount = 0
  const webServer = {
    host: '127.0.0.1',
    port: 30_980,
    register(route) {
      registeredRoute = route
      return () => {
        registeredRoute = undefined
        routeDisposeCount += 1
      }
    },
  }
  const disposeWebServer = ctx.provide('webServer', webServer)
  let webServerDisposed = false

  try {
    await eventually(
      () => registeredRoute !== undefined,
      'route was not registered after delayed webServer injection',
    )
    assert.equal(registeredRoute.kind, 'exact')
    assert.equal(registeredRoute.path, '/turn-fork')

    const captured = { status: undefined, headers: undefined, body: undefined }
    const response = {
      writeHead(status, headers) {
        captured.status = status
        captured.headers = headers
        return this
      },
      end(body) {
        captured.body = body === undefined ? '' : String(body)
        return this
      },
    }
    await registeredRoute.handler({
      method: 'GET',
      url: `/turn-fork?sessionId=${FIXTURE_SESSION_ID}`,
      headers: { host: `${webServer.host}:${String(webServer.port)}` },
    }, response)

    assert.equal(captured.status, 200, captured.body)
    assert.match(captured.headers['content-type'], /^application\/json\b/)
    assert.doesNotMatch(captured.body, /<!doctype/i)
    const payload = JSON.parse(captured.body)
    assert.equal(payload.sessionId, FIXTURE_SESSION_ID)
    assert.deepEqual(payload.messages, [])
    assert.deepEqual(payload.retryableTurns, [])
    assert.deepEqual(payload.assistantMessageTurns, [])
    assert.deepEqual(payload.undoStack, [])
    assert.deepEqual(payload.redoSessionIds, [])
    assert.deepEqual(payload.running, [])
    assert.deepEqual(payload.versions, [{
      sessionId: FIXTURE_SESSION_ID,
      createdAt: 1_700_000_000_000,
      depth: 0,
      current: true,
      onCurrentEffectPath: true,
    }])

    await disposeWebServer()
    webServerDisposed = true
    await eventually(() => routeDisposeCount === 1, 'route disposer did not run')
  } finally {
    if (!webServerDisposed) await disposeWebServer()
    await plugin.dispose()
    await disposeAll(serviceDisposers)
  }
})

test('0.1.5-rc.1 POST fork uses snapshotEvents and the exact inherited constructor seed', async () => {
  const ctx = new Context()
  const events = [
    {
      type: 'request/header', seq: 0, time: 1,
      data: { header: { config: { provider: 'fixture-provider', model: 'fixture-model', maxTokens: 4096 } }, reason: 'initial' },
    },
    { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
    {
      type: 'user/message', seq: 2, time: 3, surfaceOp: 'append',
      data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    },
    { type: 'step/start', seq: 3, time: 4, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', seq: 4, time: 5, surfaceOp: 'append', sourceEventSeqs: [],
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'hi' }],
          source: { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' },
        },
      },
    },
    { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  let snapshotReads = 0
  let createOptions
  let flushedSession
  const queued = []
  const appended = []
  const childSession = {
    id: 'child-session',
    append(type, data) { appended.push({ type, data }) },
  }
  const childHandle = {
    agent: {
      session: childSession,
      followup(message) { queued.push(message) },
    },
    async dispose() {},
  }
  const sourceSession = {
    id: FIXTURE_SESSION_ID,
    header: {
      version: 0,
      id: FIXTURE_SESSION_ID,
      createdAt: 1_700_000_000_000,
      isSeeded: false,
      cwd: '/tmp/fixture-workspace',
    },
    snapshotEvents() {
      snapshotReads += 1
      return events
    },
  }
  const services = {
    sessions: {
      get: id => id === FIXTURE_SESSION_ID ? sourceSession : undefined,
      async flush(session) { flushedSession = session },
    },
    agents: {
      get: () => undefined,
      async create(options) {
        createOptions = options
        return childHandle
      },
    },
    sessionQuery: {
      traceSession: async () => { throw new Error('traceSession is not used without a workspace registry') },
      readSession: async () => { throw new Error('live source must use snapshotEvents') },
    },
  }
  const serviceDisposers = Object.entries(services).map(([service, value]) => ctx.provide(service, value))
  const plugin = await ctx.plugin(TurnFork)
  let registeredRoute
  const disposeWebServer = ctx.provide('webServer', {
    host: '127.0.0.1',
    port: 30_980,
    register(route) {
      registeredRoute = route
      return () => { registeredRoute = undefined }
    },
  })

  try {
    await eventually(() => registeredRoute !== undefined, 'POST route was not registered')
    const body = JSON.stringify({ action: 'reroll', sessionId: FIXTURE_SESSION_ID })
    const request = new PassThrough()
    request.method = 'POST'
    request.url = '/turn-fork'
    request.headers = {
      host: '127.0.0.1:30980',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    }
    request.end(body)
    const captured = {}
    const response = {
      writeHead(status, headers) { captured.status = status; captured.headers = headers; return this },
      end(value) { captured.body = value === undefined ? '' : String(value); return this },
    }
    await registeredRoute.handler(request, response)

    assert.equal(captured.status, 200, captured.body)
    assert.equal(snapshotReads, 1)
    assert.equal(createOptions.meta.parentSession, FIXTURE_SESSION_ID)
    assert.equal(createOptions.meta.isSeeded, true)
    assert.equal('seedLength' in createOptions.meta, false)
    assert.equal(createOptions.inheritedEventCount, 1)
    assert.deepEqual(createOptions.agentOptions, {
      provider: 'fixture-provider', model: 'fixture-model', maxTokens: 4096,
    })
    // dsh-session@0.1.5-rc.1 requires a seeded session's constructor seed to
    // equal its inherited prefix exactly; the plugin-owned version event is
    // appended by the seed build, not smuggled through the constructor.
    assert.equal(createOptions.seed.length, 1)
    assert.equal(createOptions.seed[0].type, 'request/header')
    // The library seeds its end-seed marker; the plugin appends its own
    // provenance event to the constructed session.
    assert.equal(appended.length, 1)
    assert.equal(appended[0].type, 'turn-fork/version')
    assert.equal(flushedSession, childSession)
    assert.equal(queued.length, 1)
    assert.equal(queued[0].content[0].text, 'hello')
    assert.equal(JSON.parse(captured.body).queuedTurns, 1)
  } finally {
    await disposeWebServer()
    await plugin.dispose()
    await disposeAll(serviceDisposers)
  }
})
