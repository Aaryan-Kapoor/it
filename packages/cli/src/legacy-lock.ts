import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'

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
