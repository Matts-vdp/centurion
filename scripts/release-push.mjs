// Run by `npm version` (the `postversion` script): push the version commit and its tag.
// If the push fails, the commit and tag exist locally; say how to finish or undo.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

try {
  execFileSync('git', ['push', '--follow-tags'], { stdio: 'inherit' })
} catch {
  console.error(
    `\nPush failed. The version commit and tag v${version} exist locally.\n` +
      `  Finish:  git push --follow-tags\n` +
      `  Abandon: git tag -d v${version} && git reset --hard HEAD~1`,
  )
  process.exit(1)
}
console.log(`\nPushed v${version}. The Release workflow now builds and publishes it.`)
