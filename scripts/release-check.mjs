// Run by `npm version` (the `preversion` script): a release must start from a clean,
// fully pushed master. Exits non-zero with a message when it doesn't.
import { execFileSync } from 'node:child_process'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

function fail(message) {
  console.error(`Release stopped: ${message}`)
  process.exit(1)
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'master') fail(`on branch "${branch}", releases are made from master.`)

if (git('status', '--porcelain')) fail('the working tree has uncommitted changes.')

try {
  git('fetch', 'origin', 'master')
} catch {
  fail('could not fetch origin/master.')
}

const [ahead, behind] = git('rev-list', '--left-right', '--count', 'HEAD...origin/master')
  .split(/\s+/)
  .map(Number)
if (behind) fail(`master is ${behind} commit(s) behind origin/master. Pull first.`)
if (ahead) fail(`master is ${ahead} commit(s) ahead of origin/master. Push first.`)

console.log('master is clean and in sync with origin/master.')
