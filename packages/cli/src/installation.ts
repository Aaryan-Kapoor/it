import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { LICENSE } from './addons.generated'
import { Problem, writePrivate } from './lib'

export const INSTALLATION_FILE = 'installation.json'
// The installers write these same bytes before putting the folder on PATH.
export const INSTALLATION = '{"product":"It","format":1,"about":"This folder holds an installation of It."}\n'

/** A marker is a regular file, never a link. An unreadable record cannot become a legacy installation. */
export function markedInstallation(folder: string): boolean {
  const file = path.join(folder, INSTALLATION_FILE)
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (!stat) return false
    if (stat.isFile() && stat.size <= 1024 && readFileSync(file, 'utf8') === INSTALLATION) return true
  } catch {
    // An unreadable record is the same refusal as one whose bytes are not the record.
  }
  throw new Problem(
    `${file} is not the installation record It wrote.`,
    'record_unread',
    'Restore the record from a backup, or inspect this folder and move the record aside before installing It there again. Nothing was removed.',
  )
}

/** Setup deliberately chooses this folder. Existing files are never taken for a marker. */
export function markInstallation(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  if (!markedInstallation(folder)) writePrivate(path.join(folder, INSTALLATION_FILE), INSTALLATION)
}

/** A standalone program belongs to its real bin folder. A PATH symlink cannot assign it another home. */
export function installationHome(program = process.execPath, script = program === process.execPath ? process.argv[1] : undefined): string | undefined {
  if (script && /\.(m?js|ts)$/.test(script)) return undefined
  let real: string
  try {
    real = realpathSync(program)
  } catch {
    return undefined
  }
  const bin = path.basename(path.dirname(real))
  if (!/^it(?:\.exe)?$/i.test(path.basename(real)) || (process.platform === 'win32' ? bin.toLowerCase() : bin) !== 'bin') return undefined
  const folder = path.dirname(path.dirname(real))
  // A corrupt marker refuses discovery. A markerless legacy program in its own bin is
  // recognized with its installed terms, including after an older updater replaced it.
  // A bare program copied to /usr/local/bin keeps the usual default home.
  if (!markedInstallation(folder) && !legacyInstallation(folder, real, script)) return undefined
  // A folder junction is the same installation, but its spelling is what PATH and the
  // service registration retain. An executable symlink alone never assigns another home.
  const named = path.resolve(program)
  const namedFolder = path.dirname(path.dirname(named))
  try {
    if (lstatSync(named).isFile() && path.basename(path.dirname(named)).toLowerCase() === 'bin' && realpathSync(namedFolder) === folder) return namedFolder
  } catch {}
  return folder
}

/** The running program and its installed terms identify a legacy home. JSON shapes alone do not. */
export function legacyInstallation(folder: string, program = process.execPath, script = program === process.execPath ? process.argv[1] : undefined): boolean {
  if (script && /\.(m?js|ts)$/.test(script)) return false
  try {
    const bin = path.join(folder, 'bin')
    const executable = path.join(bin, process.platform === 'win32' ? 'it.exe' : 'it')
    return (
      lstatSync(executable).isFile() &&
      realpathSync(bin) === path.join(realpathSync(folder), 'bin') &&
      realpathSync(executable) === realpathSync(program) &&
      lstatSync(path.join(folder, 'LICENSE.md')).isFile() &&
      readFileSync(path.join(folder, 'LICENSE.md'), 'utf8') === LICENSE &&
      lstatSync(path.join(folder, 'THIRD_PARTY_NOTICES.md')).isFile()
    )
  } catch {
    return false
  }
}
