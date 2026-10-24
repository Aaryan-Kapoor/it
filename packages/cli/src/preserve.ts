import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const noWait = new AsyncLocalStorage<boolean>()

/** Background reconciliation leaves busy files for another attempt rather than blocking clicks. */
export function withoutFileWait<T>(change: () => T): T {
  return noWait.run(true, change)
}

/**
 * Retries Windows scanner sharing violations only in the CLI. Three seconds allows a short
 * scan to finish without leaving a command waiting on a persistently locked file. Background
 * reconciliation disables this wait for its whole asynchronous run, including restoration.
 */
function tryFile(change: () => void): void {
  for (let tries = 0; ; tries++) {
    try {
      change()
      return
    } catch (err) {
      if (noWait.getStore() || process.platform !== 'win32' || tries >= 30 || !['EPERM', 'EACCES', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? ''))
        throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

/** Checks hard-link support before preservation, allowing for transient Windows sharing violations. */
export function checkHardLinks(file: string, probe: string): void {
  tryFile(() => linkSync(file, probe))
  tryFile(() => unlinkSync(probe))
}

/** Unresolved originals never expire. Twenty slots bound disk use before a person must review them. */
export const ORIGINAL_LIMIT = 20

function markedFor(note: string, owner: string): boolean {
  return lstatSync(note, { throwIfNoEntry: false })?.isFile() === true && readFileSync(note, 'utf8') === owner
}

/** Identifies this file's recovery folder, or finishes reserving an empty one after an interruption. */
function recoveryFolder(file: string, create: boolean): { target: string; dir: string } | undefined {
  const target = path.join(realpathSync(path.dirname(file)), path.basename(file))
  const dir = `${target}.it-recovery`
  const note = path.join(dir, 'owner.json')
  const owner = JSON.stringify({ itRecovery: 1, target })
  if (create) {
    try {
      mkdirSync(dir, { mode: 0o700 })
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err
    }
  } else if (!lstatSync(dir, { throwIfNoEntry: false })) return undefined
  const unrecognised = () => new Error(`${dir} is not a recovery folder It made. Move it away before trying again`)
  if (!lstatSync(dir).isDirectory()) throw unrecognised()
  if (readdirSync(dir).length === 0) {
    // A process can stop between making the folder and marking it, or between deleting
    // its last marker and removing the empty folder. Only an empty real directory can be
    // claimed this way. Exclusive creation leaves another writer's marker untouched.
    try {
      writeFileSync(note, owner, { flag: 'wx', mode: 0o600 })
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err
    }
  }
  if (!markedFor(note, owner)) throw unrecognised()
  return { target, dir }
}

/**
 * Moves the file itself, including a last-moment save or a symlink, into a private recovery
 * folder beside it. Copying its bytes would leave another read-to-replacement race. Writers
 * with an open handle can still save into this original after it has moved.
 */
export function keepOriginal(file: string): string {
  const { target, dir } = recoveryFolder(file, true)!
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
  // Reserve one of a fixed number of slots by making its folder, so simultaneous changes
  // cannot overwrite a copy or exceed the limit. An interrupted reservation also uses a slot.
  for (let slot = 1; slot <= ORIGINAL_LIMIT; slot++) {
    const place = path.join(dir, String(slot))
    try {
      mkdirSync(place, { mode: 0o700 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw err
    }
    const saved = path.join(place, 'original')
    try {
      // Verify this filesystem can publish without replacing a concurrent save before moving
      // the installed file. Unsupported hard links leave that file in place.
      const probe = path.join(place, 'link-check')
      checkHardLinks(target, probe)
      tryFile(() => renameSync(target, saved))
      return saved
    } catch (err) {
      rmdirSync(place)
      throw err
    }
  }
  throw new Error(`${dir} has ${ORIGINAL_LIMIT} recovery slots in use. Review its originals and remove the numbered folders you no longer need, then try again`)
}

/** Removes the empty recovery folder too, so ordinary updates leave nothing beside an add-on. */
function removeEmptyRecovery(dir: string): void {
  const entries = readdirSync(dir)
  if (entries.length !== 1 || entries[0] !== 'owner.json') return
  const note = path.join(dir, 'owner.json')
  const owner = readFileSync(note, 'utf8')
  tryFile(() => unlinkSync(note))
  try {
    tryFile(() => rmdirSync(dir))
  } catch (err) {
    // A simultaneous change may have reserved a slot. Put its ownership marker back and
    // leave the new original alone; recovery folders are never removed recursively.
    try {
      writeFileSync(note, owner, { flag: 'wx', mode: 0o600 })
    } catch (restored) {
      // The new reservation can already have restored the same marker. Its exclusive
      // write won; accepting that marker must not turn our completed change into a failure.
      if (!(restored instanceof Error && 'code' in restored && restored.code === 'EEXIST' && markedFor(note, owner))) throw restored
    }
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOTEMPTY')) throw err
  }
}

/** Drops an original once the caller has confirmed it is no longer needed to undo the change. */
export function removeOriginal(original: string): void {
  tryFile(() => unlinkSync(original))
  const slot = path.dirname(original)
  tryFile(() => rmdirSync(slot))
  removeEmptyRecovery(path.dirname(slot))
}

/** Removal also clears originals left by interrupted changes, but only when their bytes are still It's own. */
export function removeOwnOriginals(file: string, sha256: string): void {
  const recovery = recoveryFolder(file, false)
  if (!recovery) return
  for (const entry of readdirSync(recovery.dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue
    const slot = path.join(recovery.dir, entry.name)
    // A process can stop after reserving a slot and before moving its original into it.
    if (readdirSync(slot).length === 0) {
      tryFile(() => rmdirSync(slot))
      continue
    }
    const original = path.join(slot, 'original')
    if (!lstatSync(original, { throwIfNoEntry: false })?.isFile()) continue
    if (createHash('sha256').update(readFileSync(original)).digest('hex') === sha256) removeOriginal(original)
  }
  if (lstatSync(recovery.dir, { throwIfNoEntry: false })) removeEmptyRecovery(recovery.dir)
}

/** Publishes only at an unused name. A writer that recreated it after preservation wins. */
export function putAbsent(part: string, target: string): void {
  tryFile(() => linkSync(part, target))
  // The target is already published. Cleanup trouble cannot undo that fact or prevent its ownership from being recorded.
  try {
    tryFile(() => unlinkSync(part))
  } catch {}
}

/** Restores an original only if nothing has been saved under its old name in the meantime. */
export function restoreAbsent(original: string, target: string): void {
  const part = `${target}.it-${randomUUID()}.part`
  let made = false
  try {
    const entry = lstatSync(original)
    if (entry.isDirectory()) {
      // Reserve the name exclusively before copying: a checked rename could replace an
      // empty directory recreated after the check. Keep the saved tree independent too.
      tryFile(() => mkdirSync(target, { mode: 0o700 }))
      // Then what the folder held, each entry under its own name in the one just made, where
      // nothing can be yet. Copying the folder itself onto the one just made is refused by Node
      // 24.22 and later, which takes a destination folder that is there for one in the way
      for (const name of readdirSync(original))
        cpSync(path.join(original, name), path.join(target, name), {
          recursive: true,
          force: false,
          errorOnExist: true,
          verbatimSymlinks: true,
          mode: constants.COPYFILE_EXCL,
        })
      chmodSync(target, entry.mode)
      return
    }
    // A restored file must not share its inode with the saved original: a later in-place
    // save to the live name would otherwise change the recovery copy too.
    if (entry.isSymbolicLink()) {
      // Creating a symlink is already exclusive. Hard-link publication follows the source
      // symlink on some systems, which would restore its target instead of the link itself.
      const link = readlinkSync(original)
      tryFile(() => symlinkSync(link, target))
      return
    }
    copyFileSync(original, part, constants.COPYFILE_EXCL)
    made = true
    putAbsent(part, target)
  } catch {
  } finally {
    if (made)
      try {
        tryFile(() => unlinkSync(part))
      } catch {}
  }
}
