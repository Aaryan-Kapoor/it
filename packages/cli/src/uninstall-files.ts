import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { removeAbandonedUploads } from '@it/content'
import { HARNESSES } from '@it/protocol'
import { ADDONS } from './addons.generated'
import { INSTALLATION_FILE } from './installation'
import { withInstallerLock } from './installer-lock'
import { home, Problem } from './lib'
import { aloneAt, holderRuns, startOf } from './serve/backend'
import { addonHookCommand, itHomeWritten } from './setup'

/** These are individual files It reserves in a marked home. */
const ROOT_FILES = [
  'service.json',
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
const DATABASE_FILES = ['db.sqlite3', 'db.sqlite3-wal', 'db.sqlite3-shm', 'db.sqlite3-journal', 'data.json']
const RELEASE = 'precompiled-\\d{4}-\\d{2}-\\d{2}-[0-9a-f]{7,40}'
const COPY = new RegExp(`^(before-(?:${RELEASE}(?:-functions-[0-9a-f]{12})?|functions-[0-9a-f]{12}))(?:\\.[0-9a-f]{16}\\.(?:part|old))?$`)
const LOCK_SUFFIX = /^(?:\.after\.(?:[0-9a-f]{16}|unread-\d+-\d+))?(?:\.[0-9a-f]{16}\.tmp)?$/
const LOCKS: Record<string, string[]> = {
  '': ['connector.lock', 'setup.lock', 'enrol.lock'],
  addons: ['setup.lock'],
  bin: ['it.upgrade.lock', 'it.exe.upgrade.lock'],
}
const lockRecord = (value: any): value is { pid: number; started: string; where: string; holder: string } =>
  Number.isInteger(value?.pid) &&
  value.pid > 0 &&
  typeof value.started === 'string' &&
  typeof value.where === 'string' &&
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

/** An updater or setup must finish before uninstall changes the program. Its lock also recovers interrupted lock-taking. */
export async function withInstallationLock<T>(folder: string, run: () => Promise<T>): Promise<T> {
  return withInstallerLock(folder, () => withProgramLock(folder, run))
}

async function withProgramLock<T>(folder: string, run: () => Promise<T>): Promise<T> {
  if (!lstatSync(path.join(folder, 'bin'), { throwIfNoEntry: false })?.isDirectory()) return run()
  const relative = `bin/${process.platform === 'win32' ? 'it.exe' : 'it'}.upgrade.lock`
  const file = path.join(folder, relative)
  if (lstatSync(file, { throwIfNoEntry: false })) {
    let recognised = false
    try {
      recognised = !!installationFile(folder, relative) && lockRecord(JSON.parse(readFileSync(file, 'utf8')))
    } catch {}
    if (!recognised && lstatSync(file, { throwIfNoEntry: false }))
      throw new Problem('The program lock is not a recognised lock record. The installation files were kept.', 'invalid')
  }
  return aloneAt(file, run)
}

/** Removes known files and then empty directories. Unknown and linked entries are left in place. */
export function removeInstallationFiles(folder: string, keepAddons: boolean): string[] {
  const remove = (relative: string) => {
    const file = installationFile(folder, relative)
    if (file) unlinkSync(file)
  }
  const json = (relative: string): any => {
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
  // Empty directories are removed only along the paths of files that were recognized.
  const prune = (relative: string) => {
    const parts = relative.split('/').slice(0, -1)
    while (parts.length) {
      empty(parts.join('/'))
      parts.pop()
    }
  }
  for (const name of ROOT_FILES) remove(name)
  // Atomic writes reserve sidecars only beside these fixed records, never arbitrary filenames.
  const records: Record<string, string[]> = {
    '': [...ROOT_FILES.filter((name) => name.endsWith('.json')), 'updates-off', 'conversation-notes-erasing', ...(!keepAddons ? [INSTALLATION_FILE] : [])],
    backend: ['erased.json'],
    ...(!keepAddons ? { addons: ['asked-for.json', ...HARNESSES.map((id) => `${id}.json`)] } : {}),
  }
  for (const [dir, names] of Object.entries(records)) {
    for (const name of dir ? children(dir) : readdirSync(folder)) {
      const sidecar = /^(.*)\.([1-9]\d*)\.tmp$/.exec(name)
      if (sidecar && names.includes(sidecar[1]!) && abandoned(sidecar[2]!)) remove(dir ? `${dir}/${name}` : name)
    }
  }
  for (const name of [...DATABASE_FILES, 'erased.json']) remove(`backend/${name}`)
  for (const name of children('backend')) {
    const match = COPY.exec(name)
    if (!match) continue
    const note = json(`backend/${name}/copy.json`)
    if (
      note?.copy !== match[1] ||
      typeof note.id !== 'string' ||
      !/^[0-9a-f]{16}$/.test(note.id) ||
      typeof note.made !== 'number' ||
      !Number.isSafeInteger(note.order) ||
      typeof note.it !== 'string' ||
      (note.erased !== undefined && note.erased !== true)
    )
      continue
    for (const file of DATABASE_FILES) remove(`backend/${name}/${file}`)
    // Storage and any other files remain. Keep the note while anything from this copy remains.
    empty(`backend/${name}/storage`)
    if (children(`backend/${name}`).every((file) => file === 'copy.json')) remove(`backend/${name}/copy.json`)
    empty(`backend/${name}`)
  }
  for (const release of children('backend/bin')) {
    if (!new RegExp(`^${RELEASE}$`).test(release)) continue
    for (const file of ['convex-local-backend', 'convex-local-backend.exe']) remove(`backend/bin/${release}/${file}`)
    for (const file of children(`backend/bin/${release}`)) {
      const part = /^convex-local-backend(?:\.exe)?\.(\d+)\.part$/.exec(file)
      if (part && abandoned(part[1]!)) remove(`backend/bin/${release}/${file}`)
    }
    empty(`backend/bin/${release}`)
  }
  for (const file of ['content.sqlite', 'content.sqlite-wal', 'content.sqlite-shm', 'content.sqlite-journal']) remove(`content-data/${file}`)
  const uploads = directory('content/tmp')
  if (uploads) removeAbandonedUploads(uploads)
  // A manifest gives the exact filenames of a page. No glob can mistake an unknown sibling for one.
  for (const user of children('content/manifest/u')) {
    for (const page of children(`content/manifest/u/${user}`)) {
      for (const version of children(`content/manifest/u/${user}/${page}`)) {
        const prefix = `u/${user}/${page}/${version}`
        const manifest = `content/manifest/${prefix}/files.json`
        const files = json(manifest)
        if (
          !Array.isArray(files) ||
          !files.every((f) => typeof f?.path === 'string' && Number.isSafeInteger(f.size) && f.size >= 0 && /^[0-9a-f]{64}$/.test(f.sha256))
        )
          continue
        for (const file of files) {
          const name = createHash('sha256').update(file.path).digest('hex')
          remove(`content/${prefix}/${name}`)
          prune(`content/${prefix}/${name}`)
        }
        remove(manifest)
        prune(manifest)
      }
    }
  }
  remove('logs/it.log')
  remove('logs/it.log.1')
  for (const name of children('logs')) if (/^reopened-\d+-\d+\.txt$/.test(name)) remove(`logs/${name}`)
  for (const [directory, names] of Object.entries(LOCKS)) {
    for (const name of directory ? children(directory) : readdirSync(folder)) {
      const lock = names.find((base) => name.startsWith(base) && LOCK_SUFFIX.test(name.slice(base.length)))
      if (!lock) continue
      const relative = directory ? `${directory}/${name}` : name
      const owner = json(relative)
      if (lockRecord(owner) && !holderRuns(owner)) remove(relative)
    }
  }
  if (!keepAddons) {
    for (const name of ['it', 'it.exe', 'it.cmd', 'it-here', 'it-here.cmd', 'it-service.cmd']) remove(`bin/${name}`)
    for (const name of children('bin')) {
      if (/^it\.old\.\d+\.exe$/.test(name)) remove(`bin/${name}`)
      // A download is staged before taking the program lock. Keep it while its updater
      // is alive; that updater checks the installed program again before replacement.
      const staged = /^\.it-upgrade-(\d+)(?:\.exe)?(?:\.\1\.part)?$/.exec(name)
      if (staged && abandoned(staged[1]!)) remove(`bin/${name}`)
    }
    remove('addons/asked-for.json')
    const homes = [...new Set([folder, path.resolve(home())])]
    for (const id of HARNESSES) {
      const stamp = json(`addons/${id}.json`)
      if (Array.isArray(stamp?.installs) && stamp.installs.length === 0) remove(`addons/${id}.json`)
      for (const [name, expected] of Object.entries(ADDONS[id]?.files ?? {})) {
        const relative = `addons/${id}/${name}`
        const file = installationFile(folder, relative)
        if (!file) continue
        const text = readFileSync(file, 'utf8')
        const sourceMatches = homes.some((at) => text === itHomeWritten(expected, at))
        const homeMatches =
          path.basename(name) === 'it-home.json' && homes.some((at) => text === `${JSON.stringify({ ...JSON.parse(expected), home: at }, null, 1)}\n`)
        const hookMatches =
          name.endsWith('hooks.json') &&
          homes.some((at) =>
            ['it', 'it.exe', 'it.cmd', 'it-here', 'it-here.cmd'].some(
              (bin) => text === expected.replaceAll(JSON.stringify(`it hook ${id}`), JSON.stringify(addonHookCommand(id, path.join(at, 'bin', bin)))),
            ),
          )
        // Setup fills in the home and hook addresses. Recognize only those exact transformations.
        if (text === expected || sourceMatches || homeMatches || hookMatches) {
          remove(relative)
          prune(relative)
        }
      }
      remove(`addons/${id}.hooks-seen`)
      empty(`addons/${id}`)
    }
    remove(INSTALLATION_FILE)
  }
  for (const dir of [
    'backend/storage',
    'backend/bin',
    'backend',
    'content/manifest/u',
    'content/manifest',
    'content/u',
    'content/tmp',
    'content',
    'content-data',
    'logs',
    'addons',
    'bin',
  ])
    empty(dir)
  return finishInstallationRemoval(folder)
}

/** Program and shutdown locks keep their folders until cleanup returns. Remove only empty directories after they are released. */
export function finishInstallationRemoval(folder: string): string[] {
  for (const at of [path.join(folder, 'bin'), path.join(folder, 'backend'), folder]) {
    if (!lstatSync(at, { throwIfNoEntry: false })?.isDirectory()) continue
    try {
      rmdirSync(at)
    } catch (err) {
      if (!['ENOTEMPTY', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
    }
  }
  return lstatSync(folder, { throwIfNoEntry: false }) ? readdirSync(folder) : []
}
