import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))

test('pins every DSH package relationship and direct lock entry to 0.1.1-rc.2', () => {
  assert.equal(manifest.version, '0.1.2')

  for (const field of ['peerDependencies', 'devDependencies']) {
    const relationships = Object.entries(manifest[field])
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    assert.ok(relationships.length > 0, field)
    for (const [name, version] of relationships) {
      assert.equal(version, '0.1.1-rc.2', `${field}.${name}`)
    }
  }

  assert.equal(lock.packages[''].version, manifest.version)
  for (const name of Object.keys(manifest.devDependencies)
    .filter(name => name.startsWith('@deepseek-ai/dsh-'))) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, '0.1.1-rc.2', name)
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.includes('/@deepseek-ai/dsh-')) {
      assert.equal(entry.version, '0.1.1-rc.2', path)
    }
  }
})
