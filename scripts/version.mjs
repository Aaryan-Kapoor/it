// The version of It is written in several places, and all of them must say the same: the
// program says one of them of itself, the site shows another, and a release names a third in
// `latest.json`, which is what an installed It compares its own with.
//   node scripts/version.mjs            says the version, and fails where the places disagree
//   node scripts/version.mjs 0.2.0      writes that version in every place
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['packages/cli', 'packages/content', 'packages/protocol', 'packages/runtime', 'web'].map((folder) => `${folder}/package.json`)
const PROGRAM = 'packages/cli/src/lib.ts'
const SAID = /^export const VERSION = '([^']*)'$/m

/** Every place the version is written, and what it says there. */
export function versions() {
  const found = PACKAGES.map((file) => ({ file, version: JSON.parse(readFileSync(path.join(root, file), 'utf8')).version }))
  found.push({ file: PROGRAM, version: SAID.exec(readFileSync(path.join(root, PROGRAM), 'utf8'))?.[1] })
  return found
}

/** The one version every place says. Throws, naming each place, where they do not agree or it is not three numbers. */
export function version() {
  const found = versions()
  const said = found[0].version
  if (found.some((one) => one.version !== said) || !/^\d+\.\d+\.\d+$/.test(String(said)))
    throw new Error(
      `the version of It must be the same three numbers everywhere it is written, and it is:\n${found.map((one) => `  ${one.file}: ${one.version}`).join('\n')}\n\`node scripts/version.mjs <version>\` writes one in every place`,
    )
  return said
}

function write(to) {
  if (!/^\d+\.\d+\.\d+$/.test(to)) throw new Error(`a version is three numbers with dots between, like 0.2.0, and "${to}" is not`)
  for (const file of PACKAGES) {
    const at = path.join(root, file)
    writeFileSync(at, readFileSync(at, 'utf8').replace(/^( {2}"version": ")[^"]*(")/m, `$1${to}$2`))
  }
  const at = path.join(root, PROGRAM)
  writeFileSync(at, readFileSync(at, 'utf8').replace(SAID, `export const VERSION = '${to}'`))
  // The record of what is installed names each of these packages with its version too
  const lock = path.join(root, 'package-lock.json')
  const record = JSON.parse(readFileSync(lock, 'utf8'))
  for (const file of PACKAGES) {
    const one = record.packages?.[path.posix.dirname(file)]
    if (one) one.version = to
  }
  writeFileSync(lock, `${JSON.stringify(record, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2]) write(process.argv[2])
    console.log(version())
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
