// Builds the standalone programs: one file for each system, with nothing else to install.
//   node packages/cli/release.mjs
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64']
// The programs carry a copy of Bun inside them, and the third-party notices say which Bun: the
// version CI pins, in the one build of it that the notices' own record names by what that Bun
// reports of itself. So the programs are built with that build and no other, by hand as on CI,
// and this is looked at before anything is written or removed.
const pinned = /^\s*BUN_VERSION:\s*(\S+)\s*$/m.exec(readFileSync(path.join(here, '../../.github/workflows/it.yml'), 'utf8'))?.[1]
const record = path.join(here, `../../scripts/notices/bun-${pinned}/sources.json`)
let described
try {
  described = JSON.parse(readFileSync(record, 'utf8')).bun.reports
} catch {}
if (typeof described !== 'string' || !described) {
  console.error(
    `the programs are built with the Bun that THIRD_PARTY_NOTICES.md describes, and ${path.relative(process.cwd(), record)} does not say which Bun that is`,
  )
  process.exit(1)
}
const have = execFileSync('bun', ['--revision'], { encoding: 'utf8' }).trim()
if (have !== described) {
  console.error(
    `the programs are built with the Bun that reports itself as ${described}, which is what THIRD_PARTY_NOTICES.md describes, and this Bun reports itself as ${have}`,
  )
  process.exit(1)
}
// What each program carries inside it is written first: the add-ons, the site, and the backend functions
await import('./addons.mjs')
await import('./site.mjs')
const { FUNCTIONS_HASH } = await import('../../scripts/functions.mjs')
const out = path.join(here, 'dist/bin')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const sums = []
for (const target of TARGETS) {
  const name = `it-${target}${target.startsWith('windows') ? '.exe' : ''}`
  execFileSync('bun', ['build', path.join(here, 'src/main.ts'), '--compile', '--minify', `--target=bun-${target}`, '--outfile', path.join(out, name)], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const program = readFileSync(path.join(out, name))
  // A program without the backend functions in it could start a backend and give it nothing
  // to run. The functions are written into it with their hash beside them, so the hash is there
  // only if they are.
  if (!program.includes(FUNCTIONS_HASH)) {
    console.error(`${name} does not carry the backend functions`)
    process.exit(1)
  }
  sums.push(`${createHash('sha256').update(program).digest('hex')}  ${name}`)
  console.log(`built ${name}`)
}
// The terms and the notices of what the programs include go beside them, so that whoever takes
// a program from here takes those too, and so do the two install scripts. All are in the
// checksums like the programs.
for (const [name, from] of [
  ['LICENSE.md', 'LICENSE.md'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  // The install scripts too, so that a release holds everything an install asks for
  ['install.sh', 'install/install.sh'],
  ['install.ps1', 'install/install.ps1'],
]) {
  copyFileSync(path.join(here, '../..', from), path.join(out, name))
  sums.push(
    `${createHash('sha256')
      .update(readFileSync(path.join(out, name)))
      .digest('hex')}  ${name}`,
  )
}
writeFileSync(path.join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`)
