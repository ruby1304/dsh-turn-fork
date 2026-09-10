import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const clientBundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('pins every DSH package relationship and direct lock entry to 0.1.5-rc.1', () => {
  assert.equal(manifest.version, '0.1.4')

  for (const field of ['peerDependencies', 'devDependencies']) {
    const relationships = Object.entries(manifest[field])
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    assert.ok(relationships.length > 0, field)
    for (const [name, version] of relationships) {
      assert.equal(version, '0.1.5-rc.1', `${field}.${name}`)
    }
  }

  assert.equal(lock.packages[''].version, manifest.version)
  for (const name of Object.keys(manifest.devDependencies)
    .filter(name => name.startsWith('@deepseek-ai/dsh-'))) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, '0.1.5-rc.1', name)
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.includes('/@deepseek-ai/dsh-')) {
      assert.equal(entry.version, '0.1.5-rc.1', path)
    }
  }

  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '4.0.2')
  assert.equal(lock.packages['node_modules/@deepseek-ai/cordis']?.version, '4.0.2')
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller'), true)
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'), false)
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-chat',
  ])
  assert.match(clientBundle, /require\("@deepseek-ai\/dsh-client-store"\)/)
  assert.doesNotMatch(clientBundle, /dsh-client-runtime/)
})
