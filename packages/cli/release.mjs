// Builds the standalone programs: one file for each system, with nothing else to install.
//   node packages/cli/release.mjs [--tag=v0.2.0]
// With a tag, the release is refused unless the tag is the version the source says it is.
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
// One version, said the same in every place: the program's own word for itself, the site's,
// and `latest.json`, which an installed It compares its own with
const { version } = await import('../../scripts/version.mjs')
let VERSION
try {
  VERSION = version()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
const tag = process.argv.find((word) => word.startsWith('--tag='))?.slice(6)
if (tag !== undefined && tag !== `v${VERSION}`) {
  console.error(`the tag of a release is "v" and its version, and the source says it is ${VERSION}, which the tag ${tag} is not`)
  process.exit(1)
}
// What each program carries inside it is written first: the add-ons, the tour, the site, and
// the backend functions. The site and the script every page is given are built here, from the
// source as it is now: a site built before the last change to it would be packed as it was.
const top = path.join(here, '../..')
execFileSync(process.execPath, [path.join(top, 'packages/runtime/build.mjs')], { cwd: top, stdio: ['ignore', 'ignore', 'inherit'] })
execFileSync('npm', ['run', '-s', 'build', '-w', 'web'], { cwd: top, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' })
await import('./addons.mjs')
await import('./tour.mjs')
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
// Which version these are, for an installed It that asks whether a newer one is out. In the
// checksums like everything else, so that an upgrade knows the file it read is the release's.
writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify({ version: VERSION })}\n`)
sums.push(
  `${createHash('sha256')
    .update(readFileSync(path.join(out, 'latest.json')))
    .digest('hex')}  latest.json`,
)
writeFileSync(path.join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`)
