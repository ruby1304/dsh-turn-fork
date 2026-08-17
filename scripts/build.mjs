import { copyFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: pluginRoot, stdio: 'inherit', env: process.env })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}`))
    })
  })
}

for (const dir of ['dist', 'dist-host', 'dist-testing']) {
  await rm(join(pluginRoot, dir), { recursive: true, force: true })
}
await run(join(pluginRoot, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'])
await run(join(pluginRoot, 'node_modules/.bin/tsdown'), ['--config', 'tsdown.config.ts'])
await copyFile(join(pluginRoot, 'dist-host', 'index.js'), join(pluginRoot, 'index.mjs'))
await copyFile(join(pluginRoot, 'dist-testing', 'testing.js'), join(pluginRoot, 'testing.mjs'))
await copyFile(join(pluginRoot, 'dist', 'client.js'), join(pluginRoot, 'client.js'))
await copyFile(join(pluginRoot, 'dist', 'client.js.map'), join(pluginRoot, 'client.js.map'))
for (const dir of ['dist', 'dist-host', 'dist-testing']) {
  await rm(join(pluginRoot, dir), { recursive: true, force: true })
}
