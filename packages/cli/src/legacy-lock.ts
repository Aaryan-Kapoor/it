import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, rmSync } from 'node:fs'
import { writeFlushed } from './lib'
import { makeOnce } from './serve/config'

/** Identifies only an empty ordinary file older than the legacy format's recovery age. */
export function legacyEmptyLock(file: string, ageMs: number): string | undefined {
  try {
    const seen = lstatSync(file, { bigint: true })
    if (!seen.isFile() || seen.size !== 0n || BigInt(Date.now()) * 1_000_000n - seen.mtimeNs <= BigInt(ageMs) * 1_000_000n) return undefined
    // Recoverers share a claim for this file. A replacement or a changed timestamp needs its own.
    const identity = `${seen.dev}:${seen.ino}:${seen.mtimeNs}:${seen.ctimeNs}:${seen.birthtimeNs}`
    return `legacy-${createHash('sha256').update(identity).digest('hex')}`
  } catch {
    return undefined
  }
}

interface Owner {
  pid: number
  holder: string
}
// Conversation notes use sixteen hexadecimal digits; telemetry uses a version-four UUID.
const HOLDER = /^(?:[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
/** Reads only a small ordinary owner record, without following links or waiting on a pipe. */
function ownerOf(file: string): Owner | undefined {
  let fd: number | undefined
  try {
    const named = lstatSync(file, { bigint: true })
    if (!named.isFile()) return undefined
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = fstatSync(fd, { bigint: true })
    // Both owner formats fit well within a kilobyte. A larger file is not a lock record.
    if (!opened.isFile() || opened.size > 1024n || opened.ino !== named.ino || opened.dev !== named.dev) return undefined
    const bytes = Buffer.alloc(Number(opened.size))
    let got = 0
    while (got < bytes.length) {
      const n = readSync(fd, bytes, got, bytes.length - got, null)
      if (!n) break
      got += n
    }
    const owner: unknown = JSON.parse(bytes.toString('utf8', 0, got))
    if (
      owner &&
      typeof owner === 'object' &&
      'pid' in owner &&
      typeof owner.pid === 'number' &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      'holder' in owner &&
      typeof owner.holder === 'string' &&
      HOLDER.test(owner.holder)
    )
      return { pid: owner.pid, holder: owner.holder }
  } catch {
    // An unreadable record has an unknown owner, so it must stay in place.
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
// Only an invocation that has finished can be recovered while its process is still alive.
const abandoned = new Set<string>()
function release(file: string, holder: string): void {
  const key = `${file}\0${holder}`
  abandoned.add(key)
  if (ownerOf(file)?.holder === holder) rmSync(file, { force: true })
  abandoned.delete(key)
}
function gone(file: string, owner: Owner): boolean {
  if (owner.pid === process.pid && abandoned.has(`${file}\0${owner.holder}`)) return true
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (err) {
    // Permission errors and reused process numbers keep the lock held.
    return err instanceof Error && 'code' in err && err.code === 'ESRCH'
  }
}
/**
 * Takes a lock once, without waiting for a live or unknown owner. Both callers run on the
 * connector's event loop and arrange their own later attempts. Empty legacy
 * files retain the recovery age of their caller; recorded owners are never judged by age.
 * A recoverer first takes a claim named for the old holder, and checks that holder again
 * before replacing it. A recoverer that dies leaves another such claim to recover.
 */
export function claimLock(file: string, legacyAgeMs: number, holder: string): (() => void) | undefined {
  const owner: Owner = { pid: process.pid, holder }
  const whole = `${file}.${holder}.tmp`
  const make = (name: string): boolean => {
    writeFlushed(whole, JSON.stringify(owner))
    try {
      return makeOnce(whole, name)
    } catch (err) {
      // Publication can succeed before removing the temporary name fails. A failed release
      // remembers the finished invocation so the next call can recover it in this process.
      release(name, holder)
      throw err
    }
  }
  try {
    try {
      if (!make(file)) {
        const seen = ownerOf(file)
        const legacy = seen ? undefined : legacyEmptyLock(file, legacyAgeMs)
        if (seen ? !gone(file, seen) : !legacy) return undefined
        let word = seen?.holder ?? legacy!
        const earlier: { file: string; holder: string }[] = []
        let held = false
        // Bound work on the event loop if repeated crashes have left a long chain of claims.
        // Twenty claims is the existing recovery limit; a longer chain is left untouched.
        for (let attempt = 0; attempt < 20; attempt++) {
          const after = `${file}.after.${word}`
          if (make(after)) {
            try {
              if (seen ? ownerOf(file)?.holder !== seen.holder : legacyEmptyLock(file, legacyAgeMs) !== legacy) return undefined
              writeFlushed(whole, JSON.stringify(owner))
              renameSync(whole, file)
              held = true
              for (const old of earlier) release(old.file, old.holder)
            } finally {
              release(after, holder)
            }
            break
          }
          const claimant = ownerOf(after)
          if (!claimant || !gone(after, claimant)) return undefined
          earlier.push({ file: after, holder: claimant.holder })
          word = claimant.holder
        }
        if (!held) return undefined
      }
      // Reporting settings can retire a marker independently. Never adopt its replacement.
      if (ownerOf(file)?.holder !== holder) return undefined
    } finally {
      rmSync(whole, { force: true })
    }
  } catch (err) {
    release(file, holder)
    throw err
  }
  return () => release(file, holder)
}
