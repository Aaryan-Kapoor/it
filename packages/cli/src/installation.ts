import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs'
import path from 'node:path'
import { LICENSE } from './addons.generated'
import { Problem, writePrivate } from './lib'

export const INSTALLATION_FILE = 'installation.json'
// The installers write these same bytes before putting the folder on PATH.
export const INSTALLATION = '{"product":"It","format":1,"about":"This folder holds an installation of It."}\n'

const saidUnread = new Set<string>()

/** Reading a path must not move a damaged record; explicit ownership checks keep it aside. */
function installationRecord(folder: string): boolean | undefined {
  const file = path.join(folder, INSTALLATION_FILE)
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (!stat) return undefined
    if (stat.isFile() && stat.size <= 1024 && readFileSync(file, 'utf8') === INSTALLATION) return true
  } catch {
    // A record that cannot be opened gives no more proof than one with the wrong bytes.
  }
  return false
}

/** A damaged record is kept aside, but never proves that a folder belongs to It. */
export function markedInstallation(folder: string): boolean {
  const marked = installationRecord(folder)
  if (marked !== false) return marked === true
  const file = path.join(folder, INSTALLATION_FILE)
  let kept = INSTALLATION_FILE
  let reason = ''
  try {
    // As with runs.json, never replace an earlier unreadable record. Discovery can still
    // use the installed program and its terms; uninstall requires that independent proof.
    if (lstatSync(`${file}.unreadable`, { throwIfNoEntry: false })) reason = 'An earlier unreadable record is already kept aside.'
    else {
      renameSync(file, `${file}.unreadable`)
      kept += '.unreadable'
    }
  } catch (err) {
    reason = `It could not move the record aside: ${err instanceof Error ? err.message : String(err)}.`
  }
  if (!saidUnread.has(file)) {
    saidUnread.add(file)
    console.error(
      `It could not read installation.json. It is kept as ${kept}.${reason ? ` ${reason}` : ''} The record cannot authorise removal of this folder.`,
    )
  }
  return false
}

/** Login must check before consuming an invite that no unreadable record would prevent marking the joined folder afterwards. */
export function checkInstallationRecord(folder: string): boolean {
  const marked = markedInstallation(folder)
  const file = path.join(folder, INSTALLATION_FILE)
  if (!marked && lstatSync(file, { throwIfNoEntry: false }))
    throw new Problem(`${file} is not the installation record It wrote.`, 'record_unread', 'Inspect the unreadable records before installing It here again.')
  return marked
}

/** Setup deliberately chooses this folder. Existing files are never taken for a marker. */
export function markInstallation(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  if (!checkInstallationRecord(folder)) writePrivate(path.join(folder, INSTALLATION_FILE), INSTALLATION)
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
  // A missing or unreadable marker gives no proof. The program in its own bin can still
  // be recognised with its installed terms, including after an older updater replaced it.
  // A bare program copied to /usr/local/bin keeps the usual default home.
  if (!installationRecord(folder) && !legacyInstallation(folder, real, script)) return undefined
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
