import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Retries the sharing violations a scanner can cause on Windows, without replacing a name. */
function tryFile(change: () => void): void {
  for (let tries = 0; ; tries++) {
    try {
      change()
      return
    } catch (err) {
      if (process.platform !== 'win32' || tries >= 30 || !['EPERM', 'EACCES', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

/** Originals are never expired. A full folder stops the next change until its owner reviews it. */
export const ORIGINAL_LIMIT = 20

/**
 * Moves the file itself, including a last-moment save or a symlink, into a private recovery
 * folder beside it. Copying its bytes would leave another read-to-replacement race. Writers
 * with an open handle can still save into this original after it has moved.
 */
export function keepOriginal(file: string): string {
  const target = path.join(realpathSync(path.dirname(file)), path.basename(file))
  const dir = `${target}.it-recovery`
  const note = path.join(dir, 'owner.json')
  const owner = JSON.stringify({ itRecovery: 1, target })
  try {
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(note, owner, { flag: 'wx', mode: 0o600 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    if (
      !lstatSync(dir).isDirectory() ||
      lstatSync(dir).isSymbolicLink() ||
      !lstatSync(note).isFile() ||
      lstatSync(note).isSymbolicLink() ||
      readFileSync(note, 'utf8') !== owner
    )
      throw new Error(`${dir} is not a recovery folder It made. Move it away before trying again`)
  }
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
      tryFile(() => renameSync(target, saved))
      return saved
    } catch (err) {
      rmdirSync(place)
      throw err
    }
  }
  throw new Error(`${dir} has ${ORIGINAL_LIMIT} recovery slots in use. Review its originals and remove the numbered folders you no longer need, then try again`)
}

/** Publishes only at an unused name. A writer that recreated it after preservation wins. */
export function putAbsent(part: string, target: string): void {
  tryFile(() => linkSync(part, target))
  unlinkSync(part)
}

/** Restores an original only if nothing has been saved under its old name in the meantime. */
export function restoreAbsent(original: string, target: string): void {
  try {
    tryFile(() => linkSync(original, target))
  } catch {}
}
