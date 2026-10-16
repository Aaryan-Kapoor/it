import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { WAKE_BACK_MS } from '@it/protocol'
import { inHome, Problem, readJson, writePrivate } from './lib'

export interface Offered {
  id: string
  artifact: string
  title: string
  name: string
  payload: string
  at: number
  attended: boolean | null
  session: { harness: string; id: string } | null
  version?: number
  stateRevision?: number
  nowVersion?: number
  nowStateRevision?: number
}
export type Given = { who: string; at: number }
export type WaitCopy = { click: Offered; key: string; given?: Given }
export type MarkFallback = { via: 'codex'; text: string } | { via: 't3'; text: string; thread: string }
/** Delays after each refused short line. The last attempt leaves its text for a hook. */
export const MARK_AGAIN_MS = [20_000, 60_000, 300_000]
export type MarkCopy = {
  id: string
  texts: string[]
  at: number
  fallback?: MarkFallback
  /** Attempts include a send whose answer was lost. A null deadline means retries are exhausted. */
  retry?: { attempts: number; nextAt: number | null }
}
const file = () => inHome('delivery-recovery.json')
const MOST = 200
export const WAITERS_PER_CONVERSATION = 200
const BYTES = 16_000_000
interface Kept {
  version: 1
  machine?: string
  person?: string
  waiters: [string, WaitCopy][]
  marks: [string, MarkCopy[]][]
  accepted: string[]
  returning: string[]
  targets?: [string, string][]
}
const active = new Set<DeliveryRecovery>()

/** Clears recovery before erasure is acknowledged, including a stopped connector's notes. */
export function eraseDeliveryRecovery(person?: string): void {
  const kept = readJson<{ person?: string }>(file())
  for (const store of active) if (store.file === file() && (!person || !store.person || store.person === person)) store.erase()
  if (!person || !kept?.person || kept.person === person) rmSync(file(), { force: true })
  if (!existsSync(path.dirname(file()))) return
  for (const name of readdirSync(path.dirname(file()))) {
    if (!/^delivery-recovery\.json\.\d+\.tmp$/.test(name)) continue
    const temporary = path.join(path.dirname(file()), name)
    const note = readJson<{ person?: string }>(temporary)
    if (!person || !note?.person || note.person === person) rmSync(temporary, { force: true })
  }
}

/** The queue receipt, waiter receipt and mark receipt are independent durable facts. */
export class DeliveryRecovery {
  readonly file = file()
  readonly waiters = new Map<string, WaitCopy>()
  readonly marks = new Map<string, MarkCopy[]>()
  readonly accepted = new Set<string>()
  readonly returning = new Set<string>()
  readonly targets = new Map<string, string>()
  person: string | undefined
  private readonly machine = readJson<{ id?: string }>(inHome('machine.json'))?.id
  onErase: (() => void) | undefined
  erased = false
  private closed = false
  /** Only copies read at startup may be discarded for age or space. No turn is inferred. */
  private readonly restoredWaiters = new Set<string>()

  constructor() {
    if (existsSync(this.file)) {
      try {
        if (statSync(this.file).size > BYTES) throw new Error('too large')
        const data = JSON.parse(readFileSync(this.file, 'utf8')) as Kept
        this.validate(data)
        if (data.machine !== this.machine) {
          rmSync(this.file, { force: true })
        } else this.restore(data)
      } catch {
        throw new Problem(
          `The delivery recovery record in ${this.file} cannot be read.`,
          'record_unread',
          'Restore the record from a copy, or move it aside to allow delivery to try again. Some actions may be repeated.',
        )
      }
    }
    for (const id of this.waiters.keys()) this.restoredWaiters.add(id)
    active.add(this)
  }

  private snapshot(): Kept {
    return {
      version: 1,
      machine: this.machine,
      person: this.person,
      waiters: [...this.waiters],
      marks: [...this.marks],
      accepted: [...this.accepted],
      returning: [...this.returning],
      targets: [...this.targets],
    }
  }

  private restore(data: Kept): void {
    this.person = data.person
    this.waiters.clear()
    for (const [id, copy] of data.waiters) this.waiters.set(id, copy)
    this.marks.clear()
    for (const [key, marks] of data.marks) this.marks.set(key, marks)
    this.accepted.clear()
    for (const id of data.accepted) this.accepted.add(id)
    this.targets.clear()
    for (const [id, key] of data.targets ?? []) this.targets.set(id, key)
    this.returning.clear()
    for (const id of data.returning) this.returning.add(id)
  }

  private validate(data: Kept): void {
    const strings = (xs: unknown): xs is string[] => Array.isArray(xs) && xs.every((x) => typeof x === 'string')
    if ((data.person !== undefined && typeof data.person !== 'string') || (data.machine !== undefined && typeof data.machine !== 'string'))
      throw new Error('invalid')
    if (data.version !== 1 || !strings(data.accepted) || !strings(data.returning) || !Array.isArray(data.waiters) || !Array.isArray(data.marks))
      throw new Error('invalid')
    if (data.marks.flatMap(([, marks]) => marks).length > MOST || data.accepted.length > MOST || data.returning.length > 100_000) throw new Error('full')
    if (data.targets !== undefined && (!Array.isArray(data.targets) || data.targets.some(([id, key]) => typeof id !== 'string' || typeof key !== 'string')))
      throw new Error('invalid')
    for (const [id, copy] of data.waiters) {
      const c = copy.click
      if (
        typeof id !== 'string' ||
        c.id !== id ||
        typeof copy.key !== 'string' ||
        !Number.isFinite(c.at) ||
        ![c.artifact, c.title, c.name, c.payload].every((s) => typeof s === 'string') ||
        (c.session !== null && (typeof c.session.harness !== 'string' || typeof c.session.id !== 'string')) ||
        (copy.given !== undefined && (typeof copy.given.who !== 'string' || !Number.isFinite(copy.given.at)))
      )
        throw new Error('invalid')
    }
    for (const [key, marks] of data.marks) {
      if (typeof key !== 'string' || !Array.isArray(marks)) throw new Error('invalid')
      for (const m of marks) {
        if (typeof m.id !== 'string' || !strings(m.texts) || !Number.isFinite(m.at)) throw new Error('invalid')
        const fallback = m.fallback
        if (
          fallback !== undefined &&
          (typeof fallback.text !== 'string' ||
            (fallback.via !== 'codex' && fallback.via !== 't3') ||
            (fallback.via === 'codex' && !key.startsWith('codex:')) ||
            (fallback.via === 't3' && typeof fallback.thread !== 'string'))
        )
          throw new Error('invalid')
        const retry = m.retry
        if (
          retry !== undefined &&
          (!fallback ||
            !retry ||
            !Number.isSafeInteger(retry.attempts) ||
            retry.attempts < 1 ||
            retry.attempts > MARK_AGAIN_MS.length + 1 ||
            (retry.attempts === MARK_AGAIN_MS.length + 1 ? retry.nextAt !== null : retry.nextAt === null || !Number.isFinite(retry.nextAt)))
        )
          throw new Error('invalid')
      }
    }
  }

  get hasMarkRoom(): boolean {
    return [...this.marks.values()].reduce((n, marks) => n + marks.length, 0) < MOST
  }

  /**
   * Reuse the one-day click lookback for reopening a conversation. Before these records,
   * restart lost every waiter copy; the app queue and normal claim recovery kept the click.
   * Its timestamp survives repeated restarts, and its acceptance and mark receipts stay put.
   */
  pruneWaiters(now = Date.now()): void {
    const expired = [...this.restoredWaiters].filter((id) => {
      const copy = this.waiters.get(id)
      return copy && now - copy.click.at >= WAKE_BACK_MS
    })
    if (expired.length)
      this.change(() => {
        for (const id of expired) this.waiters.delete(id)
      })
  }

  /** Nothing changes in memory if its durable replacement could not be written. */
  change(change: () => void): void {
    if (this.closed || this.erased) throw new Error('delivery recovery is closed')
    const before = structuredClone(this.snapshot())
    try {
      change()
      const after = this.snapshot()
      this.validate(after)
      let text = JSON.stringify(after)
      let bytes = Buffer.byteLength(text)
      if (bytes > BYTES) {
        // A different conversation must not be refused because restored copies use the
        // record's safety bound. Drop the oldest copies only, retaining every other receipt.
        const oldest = [...this.waiters].filter(([id]) => this.restoredWaiters.has(id)).sort((a, b) => a[1].click.at - b[1].click.at)
        for (const [id, copy] of oldest) {
          this.waiters.delete(id)
          bytes -= Buffer.byteLength(JSON.stringify([id, copy])) + (this.waiters.size ? 1 : 0)
          if (bytes <= BYTES) break
        }
        text = JSON.stringify(this.snapshot())
        if (Buffer.byteLength(text) > BYTES) throw new Error('delivery recovery is full')
      }
      if (text !== JSON.stringify(before)) writePrivate(this.file, text)
      for (const id of this.restoredWaiters) if (!this.waiters.has(id)) this.restoredWaiters.delete(id)
    } catch (error) {
      this.restore(before)
      throw error
    }
  }

  get stopped(): boolean {
    return this.closed || this.erased
  }

  erase(): void {
    this.erased = true
    this.waiters.clear()
    this.restoredWaiters.clear()
    this.marks.clear()
    this.accepted.clear()
    this.returning.clear()
    this.targets.clear()
    this.onErase?.()
  }

  close(): void {
    this.closed = true
    active.delete(this)
  }
}
