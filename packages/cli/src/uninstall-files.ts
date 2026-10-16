import { lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INSTALLATION_FILE } from './installation'
import { withInstallerLock } from './installer-lock'
import { Problem } from './lib'
import { aloneAt, holderRuns, startOf } from './serve/backend'

/** These are individual files It reserves in a marked home. */
export const ROOT_FILES = [
  'service.json',
  'startup.json',
  'startup.json.unreadable',
  'installation.json.unreadable',
  'machine.json',
  'machine.pending.json',
  'token.json',
  'push.json',
  'left.json',
  'was.json',
  'updates-off',
  'releases.json',
  'connector.json',
  'connector.sock',
  'heard.json',
  'journal.jsonl',
  'delivery-recovery.json',
  'delivery-recovery.json.unreadable',
  'conversations.json',
  'conversation-notes-erasing',
  'aliases.json',
  'runs.json',
  'runs.json.unreadable',
  'cut-off.json',
  'stopped.json',
  'service.stop',
  'telemetry.json',
  'telemetry-off',
  'usage.jsonl',
  'usage.jsonl.taken',
  'telemetry-sending',
  'LICENSE.md',
  'THIRD_PARTY_NOTICES.md',
]
// These folders hold only It's own files. The top level can also hold a person's files
// if IT_HOME was set to a project by mistake, so only that level uses a file list.
export const ROOT_FOLDERS = ['backend', 'content', 'content-data', 'logs', 'publication-pending', 'addons', 'bin']
const LOCK_SUFFIX = /^(?:\.after\.(?:[0-9a-f]{16}|unread-\d+-\d+))?(?:\.[0-9a-f]{16}\.tmp)?$/
export const ROOT_LOCKS = ['connector.lock', 'setup.lock', 'enrol.lock']
const LOCKS: Record<string, string[]> = {
  '': ROOT_LOCKS,
  addons: ['setup.lock'],
  bin: ['it.upgrade.lock', 'it.exe.upgrade.lock'],
}
const lockRecord = (value: unknown): value is { pid: number; started: string; where: string; holder: string } =>
  typeof value === 'object' &&
  value !== null &&
  'pid' in value &&
  typeof value.pid === 'number' &&
  Number.isInteger(value.pid) &&
  value.pid > 0 &&
  'started' in value &&
  typeof value.started === 'string' &&
  'where' in value &&
  typeof value.where === 'string' &&
  'holder' in value &&
  typeof value.holder === 'string' &&
  /^[0-9a-f]{16}$/.test(value.holder)

/** A file is reached only through real directories. Even a dangling link remains the person's. */
export function installationFile(folder: string, relative: string): string | undefined {
  const parts = relative.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\'))) return undefined
  let at = folder
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part)
    if (!lstatSync(at, { throwIfNoEntry: false })?.isDirectory()) return undefined
  }
  at = path.join(at, parts[parts.length - 1]!)
  const stat = lstatSync(at, { throwIfNoEntry: false })
  return stat && (stat.isFile() || stat.isSocket()) ? at : undefined
}

/** Setup, login and uninstall take these locks in the same order, including when the command runs from source and has no program lock. */
export async function withInstallationLock<T>(folder: string, run: () => Promise<T>): Promise<T> {
  // A setup can be waiting for the person's answers, and an add-on can be waiting for its
  // app. Refuse immediately while either is busy, with the installation still whole.
  return withRecordLock(
    folder,
    'setup.lock',
    () =>
      withInstallerLock(folder, () =>
        withProgramLock(folder, () => {
          const addons = lstatSync(path.join(folder, 'addons'), { throwIfNoEntry: false })
          if (addons && !addons.isDirectory()) return run()
          return withRecordLock(folder, 'addons/setup.lock', run, 0)
        }),
      ),
    0,
  )
}

async function withProgramLock<T>(folder: string, run: () => Promise<T>): Promise<T> {
  if (!lstatSync(path.join(folder, 'bin'), { throwIfNoEntry: false })?.isDirectory()) return run()
  const relative = `bin/${process.platform === 'win32' ? 'it.exe' : 'it'}.upgrade.lock`
  return withRecordLock(folder, relative, run)
}

async function withRecordLock<T>(folder: string, relative: string, run: () => Promise<T>, forMs?: number): Promise<T> {
  const file = path.join(folder, relative)
  if (lstatSync(file, { throwIfNoEntry: false })) {
    let recognised = false
    try {
      recognised = !!installationFile(folder, relative) && lockRecord(JSON.parse(readFileSync(file, 'utf8')))
    } catch {}
    if (!recognised && lstatSync(file, { throwIfNoEntry: false }))
      throw new Problem(`${relative} is not a recognised lock record. The installation files were kept.`, 'invalid')
  }
  return aloneAt(file, run, forMs)
}

/** Removes known root files and whole owned folders, keeping the locks until their holders release them. */
export function removeInstallationFiles(folder: string, keepAddons: boolean): string[] {
  const remove = (relative: string) => {
    const file = installationFile(folder, relative)
    if (file) unlinkSync(file)
  }
  const json = (relative: string): unknown => {
    const file = installationFile(folder, relative)
    if (!file) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return undefined
    }
  }
  const directory = (relative: string): string | undefined => {
    const parts = relative.split('/')
    if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\'))) return undefined
    let at = folder
    for (const part of parts) {
      at = path.join(at, part)
      if (!lstatSync(at, { throwIfNoEntry: false })?.isDirectory()) return undefined
    }
    return at
  }
  const children = (relative: string): string[] => {
    const at = directory(relative)
    return at ? readdirSync(at) : []
  }
  const abandoned = (pid: string): boolean => {
    const number = Number(pid)
    return Number.isSafeInteger(number) && number > 0 && startOf(number) === null
  }
  const empty = (relative: string) => {
    const at = directory(relative)
    if (!at) return
    try {
      rmdirSync(at)
    } catch (err) {
      if (!['ENOTEMPTY', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
    }
  }
  for (const name of ROOT_FILES) remove(name)
  // Atomic writes reserve sidecars only beside these fixed records, never arbitrary filenames.
  const records = [
    ...ROOT_FILES.filter((name) => name.endsWith('.json')),
    'updates-off',
    'conversation-notes-erasing',
    ...(!keepAddons ? [INSTALLATION_FILE] : []),
  ]
  for (const name of readdirSync(folder)) {
    const sidecar = /^(.*)\.([1-9]\d*)\.tmp$/.exec(name)
    if (sidecar && records.includes(sidecar[1]!) && abandoned(sidecar[2]!)) remove(name)
    // The shell installer records the process and machine that made each staging folder.
    // Apply its own cleanup rule here too: only a dead local owner proves the downloads
    // are abandoned. An old.* file may be the only copy of something moved aside, so a
    // folder holding one stays for the person to recover, as it does on the next install.
    if (!name.startsWith('.install.')) continue
    const stage = directory(name)
    const owner = installationFile(folder, `${name}/owner`)
    if (!stage || !owner) continue
    const held = /^([1-9]\d*) ([^\r\n]+)\n/.exec(readFileSync(owner, 'utf8'))
    if (held && held[2] === os.hostname() && abandoned(held[1]!) && !children(name).some((file) => file.startsWith('old.'))) {
      rmSync(stage, { recursive: true, force: true })
    }
  }
  for (const [directory, names] of Object.entries(LOCKS)) {
    for (const name of directory ? children(directory) : readdirSync(folder)) {
      const lock = names.find((base) => name.startsWith(base) && LOCK_SUFFIX.test(name.slice(base.length)))
      if (!lock) continue
      const relative = directory ? `${directory}/${name}` : name
      const owner = json(relative)
      if (lockRecord(owner) && !holderRuns(owner)) remove(relative)
    }
  }
  for (const dir of ROOT_FOLDERS) {
    if (keepAddons && (dir === 'addons' || dir === 'bin')) continue
    const at = directory(dir)
    if (!at) continue
    // Uninstall holds these locks through removal. Deleting one would let a service or
    // updater start again before this command has finished. Its holder removes it on exit;
    // finishInstallationRemoval then takes away the empty folder. Internal links are
    // unlinked by rmSync, which never follows them to files outside this installation.
    for (const name of children(dir)) {
      if (dir === 'backend' && (name === 'lock' || (name.startsWith('lock') && LOCK_SUFFIX.test(name.slice(4))))) continue
      if (LOCKS[dir]?.some((lock) => name.startsWith(lock) && LOCK_SUFFIX.test(name.slice(lock.length)))) continue
      rmSync(path.join(at, name), { recursive: true, force: true })
    }
    empty(dir)
  }
  if (!keepAddons) remove(INSTALLATION_FILE)
  return finishInstallationRemoval(folder)
}

/** Add-on, program and shutdown locks keep their folders until cleanup returns. Remove only empty directories after they are released. */
export function finishInstallationRemoval(folder: string): string[] {
  for (const at of [path.join(folder, 'bin'), path.join(folder, 'backend'), path.join(folder, 'addons'), folder]) {
    if (!lstatSync(at, { throwIfNoEntry: false })?.isDirectory()) continue
    try {
      rmdirSync(at)
    } catch (err) {
      if (!['ENOTEMPTY', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
    }
  }
  return lstatSync(folder, { throwIfNoEntry: false }) ? readdirSync(folder) : []
}
