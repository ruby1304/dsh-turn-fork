import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2]

if (tag !== `v${pkg.version}`) {
  console.error(`Release tag ${JSON.stringify(tag)} does not match package version v${pkg.version}.`)
  process.exitCode = 1
}

try {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const tagged = execFileSync('git', ['rev-parse', `refs/tags/${tag}^{commit}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
    encoding: 'utf8',
  }).trim()
  if (tagged !== head || dirty !== '') throw new Error('tag/worktree mismatch')
  execFileSync('git', ['rev-parse', '--verify', 'refs/remotes/origin/main'], { stdio: 'ignore' })
  execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'], {
    stdio: 'ignore',
  })
  console.log('Release tag points to a clean commit belonging to origin/main.')
} catch {
  console.error(
    'Release tag must point to the clean checked-out commit and belong to protected origin/main.',
  )
  process.exitCode = 1
}
