/** rc.8 lifecycle contract: optional webServer may arrive after plugin load. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as TurnFork from '../index.mjs'

const FIXTURE_SESSION_ID = 'fixture-rc8-session'

function fixtureServices() {
  const record = {
    header: { id: FIXTURE_SESSION_ID, createdAt: 1_700_000_000_000 },
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
        return { session: record.header, events: [] }
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

test('headless rc.8 profile loads without webServer', async () => {
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

test('delayed rc.8 webServer injection registers exact GET /turn-fork JSON route', async () => {
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

    assert.equal(captured.status, 200)
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
