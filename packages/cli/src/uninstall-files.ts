import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { HARNESSES } from '@it/protocol'
import { ADDONS } from './addons.generated'
import { INSTALLATION_FILE } from './installation'

/** These are individual files It reserves in a marked home. No directory is removed recursively. */
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
  'journal.jsonl',
  'delivery-recovery.json',
  'conversations.json',
  'conversation-notes-erasing',
  'aliases.json',
  'runs.json',
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
  for (const name of [...DATABASE_FILES, 'erased.json']) remove(`backend/${name}`)
  for (const name of children('backend')) {
    const match = COPY.exec(name)
    if (!match) continue
    const note = json(`backend/${name}/copy.json`)
    if (note?.copy !== match[1] || !/^[0-9a-f]{16}$/.test(note.id) || !Number.isSafeInteger(note.order) || typeof note.it !== 'string') continue
    for (const file of DATABASE_FILES) remove(`backend/${name}/${file}`)
    // Storage and any other files remain. Keep the note while anything from this copy remains.
    empty(`backend/${name}/storage`)
    if (children(`backend/${name}`).every((file) => file === 'copy.json')) remove(`backend/${name}/copy.json`)
    empty(`backend/${name}`)
  }
  for (const release of children('backend/bin')) {
    if (!new RegExp(`^${RELEASE}$`).test(release)) continue
    for (const file of ['convex-local-backend', 'convex-local-backend.exe']) remove(`backend/bin/${release}/${file}`)
    empty(`backend/bin/${release}`)
  }
  for (const file of ['content.sqlite', 'content.sqlite-wal', 'content.sqlite-shm', 'content.sqlite-journal']) remove(`content-data/${file}`)
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
  if (!keepAddons) {
    for (const name of ['it', 'it.exe', 'it.cmd', 'it-here', 'it-here.cmd', 'it-service.cmd']) remove(`bin/${name}`)
    for (const id of HARNESSES) {
      const stamp = json(`addons/${id}.json`)
      if (Array.isArray(stamp?.installs) && stamp.installs.length === 0) remove(`addons/${id}.json`)
      for (const [name, expected] of Object.entries(ADDONS[id]?.files ?? {})) {
        const relative = `addons/${id}/${name}`
        const file = installationFile(folder, relative)
        if (!file) continue
        const text = readFileSync(file, 'utf8')
        // The packed home note is filled in at setup. Its ownership statement must still agree.
        if (text === expected || (name.endsWith('it-home.json') && json(relative)?.home === folder && json(relative)?.about === JSON.parse(expected).about)) {
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

/** A shutdown lock can keep the backend folder until cleanup returns. Remove only empty directories after it is released. */
export function finishInstallationRemoval(folder: string): string[] {
  for (const at of [path.join(folder, 'backend'), folder]) {
    if (!lstatSync(at, { throwIfNoEntry: false })?.isDirectory()) continue
    try {
      rmdirSync(at)
    } catch (err) {
      if (!['ENOTEMPTY', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
    }
  }
  return lstatSync(folder, { throwIfNoEntry: false }) ? readdirSync(folder) : []
}
