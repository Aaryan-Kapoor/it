import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { WAKE_BACK_MS } from '@it/protocol'
import { inHome, readJson, writePrivateAsync } from './lib'

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
// Two hundred is the connector's existing bound on unresolved handoffs. Keep the same
// bound for marks and acceptance receipts, and restore it for waiter copies across all
// conversations, so a machine with many open conversations has a bounded backlog too.
export const RECEIPTS_MOST = 200
export const WAITERS_MOST = 200
export const WAITERS_PER_CONVERSATION = 200
// Two hundred maximum-size clicks use about 6.4 MB. The rest leaves room for mark text
// and claim ids; this also bounds what startup will read from a damaged record.
const BYTES = 16_000_000
// Returned claims include a previous connector's unanswered requests, not just its live
// handoffs. Allow a large recovery backlog, but reject an implausibly large damaged record.
const CLAIMS_MOST = 100_000
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
  if (!person || !kept?.person || kept.person === person) {
    rmSync(file(), { force: true })
    rmSync(`${file()}.unreadable`, { force: true })
  }
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
  private data: {
    waiters: Map<string, WaitCopy>
    marks: Map<string, MarkCopy[]>
    accepted: Set<string>
    returning: Set<string>
    targets: Map<string, string>
    person: string | undefined
  } = {
    waiters: new Map<string, WaitCopy>(),
    marks: new Map<string, MarkCopy[]>(),
    accepted: new Set<string>(),
    returning: new Set<string>(),
    targets: new Map<string, string>(),
    person: undefined,
  }
  get waiters(): ReadonlyMap<string, Readonly<WaitCopy>> {
    return this.data.waiters
  }
  get marks(): ReadonlyMap<string, readonly MarkCopy[]> {
    return this.data.marks
  }
  get accepted(): ReadonlySet<string> {
    return this.data.accepted
  }
  get returning(): ReadonlySet<string> {
    return this.data.returning
  }
  get targets(): ReadonlyMap<string, string> {
    return this.data.targets
  }
  get person(): string | undefined {
    return this.data.person
  }
  private pending: Promise<void> = Promise.resolve()
  // Unchanged click payloads and mark texts are not serialised on each receipt. Only their
  // containing entry changes when its owner, waiter receipt or retry deadline changes.
  private readonly encoded = new WeakMap<object, string>()
  private readonly machine = readJson<{ id?: string }>(inHome('machine.json'))?.id
  onErase: (() => void) | undefined
  erased = false
  private closed = false
  /** Only copies read at startup may be discarded for age or space. No turn is inferred. */
  private readonly restoredWaiters = new Set<string>()

  constructor(say: (message: string) => void = console.error) {
    if (existsSync(this.file)) {
      try {
        if (statSync(this.file).size > BYTES) throw new Error('too large')
        const data = JSON.parse(readFileSync(this.file, 'utf8')) as Kept
        this.validate(data)
        if (data.machine !== this.machine) {
          rmSync(this.file, { force: true })
        } else this.restore(data)
      } catch {
        let moved = false
        try {
          if (!existsSync(`${this.file}.unreadable`)) {
            renameSync(this.file, `${this.file}.unreadable`)
            moved = true
          }
        } catch {
          // An unreadable bookkeeping file must not stop delivery even if its folder is
          // temporarily unwritable. Say where the original remains, once at startup.
        }
        say(
          `The delivery recovery record could not be read; ${moved ? 'it was kept as delivery-recovery.json.unreadable' : 'it remains in delivery-recovery.json'}. Delivery continues; a repeated click has the same id.`,
        )
      }
    }
    for (const id of this.waiters.keys()) this.restoredWaiters.add(id)
    active.add(this)
  }

  private restore(data: Kept): void {
    this.data = {
      person: data.person,
      waiters: new Map(data.waiters),
      marks: new Map(data.marks),
      accepted: new Set(data.accepted),
      returning: new Set(data.returning),
      targets: new Map(data.targets),
    }
  }

  private validate(data: Kept): void {
    const strings = (xs: unknown): xs is string[] => Array.isArray(xs) && xs.every((x) => typeof x === 'string')
    if ((data.person !== undefined && typeof data.person !== 'string') || (data.machine !== undefined && typeof data.machine !== 'string'))
      throw new Error('invalid')
    if (data.version !== 1 || !strings(data.accepted) || !strings(data.returning) || !Array.isArray(data.waiters) || !Array.isArray(data.marks))
      throw new Error('invalid')
    if (data.marks.flatMap(([, marks]) => marks).length > RECEIPTS_MOST || data.accepted.length > RECEIPTS_MOST || data.returning.length > CLAIMS_MOST)
      throw new Error('full')
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

  /** New copies may replace restored ones, whose app queues already hold the clicks. */
  waiterRoom(key: string, pending: ReadonlyMap<string, string>, follow: (key: string) => string): number {
    const own = new Set([...this.waiters].filter(([, copy]) => follow(copy.key) === key).map(([id]) => id))
    const live = new Set([...this.waiters.keys()].filter((id) => !this.restoredWaiters.has(id)))
    for (const [id, target] of pending) {
      live.add(id)
      if (follow(target) === key) own.add(id)
    }
    return Math.max(0, Math.min(WAITERS_PER_CONVERSATION - own.size, WAITERS_MOST - live.size))
  }

  /**
   * A missing session after restart says nothing about its turn. Restored copies keep the
   * existing one-day lookback, while a turn heard to end releases its copies immediately.
   */
  pruneWaiters(now = Date.now(), ended: (key: string, restored: boolean) => boolean = () => false): Promise<void> {
    return this.change((data) => {
      for (const [id, copy] of data.waiters)
        if (ended(copy.key, this.restoredWaiters.has(id)) || (this.restoredWaiters.has(id) && now - copy.click.at >= WAKE_BACK_MS)) data.waiters.delete(id)
    })
  }

  keepWaiters(clicks: readonly Offered[], key: string): Promise<void> {
    return this.change((data) => {
      for (const click of clicks) {
        const kept = data.waiters.get(click.id)
        if (!kept || kept.key !== key || this.encode(kept.click) !== this.encode(click)) data.waiters.set(click.id, { click, key })
      }
    })
  }

  dropWaiters(ids: readonly string[]): Promise<void> {
    return this.change((data) => {
      for (const id of ids) data.waiters.delete(id)
    })
  }

  printed(who: string, ids: readonly string[]): Promise<void> {
    return this.change((data) => {
      for (const id of ids) if (data.waiters.get(id)?.given?.who === who) data.waiters.delete(id)
    })
  }

  giveWaiters(who: string, now: number, choose: (copy: Readonly<WaitCopy>, id: string) => boolean): Promise<void> {
    return this.change((data) => {
      for (const [id, copy] of data.waiters) {
        if (!choose(copy, id) || copy.given?.who === who) continue
        data.waiters.set(id, { ...copy, given: { who, at: now } })
      }
    })
  }

  session(key: string, was?: string, turnChanged = false): Promise<void> {
    return this.change((data) => {
      for (const [id, copy] of data.waiters) {
        if (copy.key !== key && copy.key !== was) continue
        if (turnChanged) data.waiters.delete(id)
        else if (copy.key !== key) data.waiters.set(id, { ...copy, key })
      }
      if (was && was !== key) {
        const marks = data.marks.get(was)
        if (marks) {
          data.marks.delete(was)
          data.marks.set(key, [...(data.marks.get(key) ?? []), ...marks])
        }
      }
    })
  }

  claim(ids: readonly string[], key: string): Promise<void> {
    return this.change((data) => {
      for (const id of ids) {
        data.returning.add(id)
        data.targets.set(id, key)
      }
    })
  }

  recover(ids: readonly string[], routes: readonly [string, string][], person?: string): Promise<void> {
    return this.change((data) => {
      if (person !== undefined) data.person = person
      for (const id of ids) data.returning.add(id)
      for (const [id, key] of routes) data.targets.set(id, key)
    })
  }

  retire(ids: readonly string[], current: () => boolean = () => true): Promise<void> {
    return this.change((data) => {
      if (!current()) return
      for (const id of ids) {
        data.returning.delete(id)
        data.targets.delete(id)
      }
    })
  }

  confirm(id: string, retire: () => boolean): Promise<void> {
    return this.change((data) => {
      data.accepted.delete(id)
      if (retire()) {
        data.returning.delete(id)
        data.targets.delete(id)
      }
    })
  }

  accept(ids: readonly string[], sent: { id: string; printed?: boolean; given?: Given }, waiting?: { clicks: readonly Offered[]; key: string }): Promise<void> {
    return this.change((data) => {
      for (const id of ids) data.accepted.add(id)
      if (waiting) {
        for (const click of waiting.clicks) if (!data.waiters.has(click.id)) data.waiters.set(click.id, { click, key: waiting.key })
      }
      const copy = data.waiters.get(sent.id)
      if (sent.printed) data.waiters.delete(sent.id)
      else if (copy && sent.given && copy.given?.who !== sent.given.who) data.waiters.set(sent.id, { ...copy, given: sent.given })
    })
  }

  async addMark(key: string, entry: MarkCopy): Promise<boolean> {
    let added = false
    await this.change(
      (data) => {
        if ([...data.marks.values()].reduce((n, marks) => n + marks.length, 0) >= RECEIPTS_MOST) return
        data.marks.set(key, [...(data.marks.get(key) ?? []), entry])
        added = true
      },
      () => {
        added = false
      },
    )
    return added
  }

  removeMarks(key: string, ids: readonly string[]): Promise<void> {
    return this.change((data) => {
      const marks = data.marks.get(key)
      if (!marks) return
      const left = marks.filter((mark) => !ids.includes(mark.id))
      if (left.length === marks.length) return
      if (left.length) data.marks.set(key, left)
      else data.marks.delete(key)
    })
  }

  removeMark(id: string): Promise<void> {
    return this.change((data) => {
      for (const [key, marks] of data.marks) {
        if (!marks.some((mark) => mark.id === id)) continue
        const left = marks.filter((mark) => mark.id !== id)
        if (left.length) data.marks.set(key, left)
        else data.marks.delete(key)
      }
    })
  }

  retryMark(id: string, retry: NonNullable<MarkCopy['retry']>): Promise<void> {
    return this.change((data) => {
      for (const [key, marks] of data.marks) {
        const mark = marks.find((mark) => mark.id === id)
        if (!mark || (mark.retry?.attempts === retry.attempts && mark.retry.nextAt === retry.nextAt)) continue
        data.marks.set(
          key,
          marks.map((mark) => (mark.id === id ? { ...mark, retry } : mark)),
        )
      }
    })
  }

  private encode(value: object): string {
    let text = this.encoded.get(value)
    if (text === undefined) {
      text = JSON.stringify(value)
      this.encoded.set(value, text)
    }
    return text
  }

  private waiterText(id: string, copy: WaitCopy): string {
    let text = this.encoded.get(copy)
    if (text === undefined) {
      text = `[${JSON.stringify(id)},{"key":${JSON.stringify(copy.key)},"click":${this.encode(copy.click)}${copy.given ? `,"given":${this.encode(copy.given)}` : ''}}]`
      this.encoded.set(copy, text)
    }
    return text
  }

  private pieces(data: typeof this.data): string[] {
    // Payloads and mark text are encoded once. Building the surrounding JSON needs only
    // small strings, even when the private record is near its byte bound.
    const parts = [JSON.stringify({ version: 1, machine: this.machine, person: data.person }).slice(0, -1), ',"waiters":[']
    for (const [id, copy] of data.waiters) {
      if (parts.at(-1) !== ',"waiters":[') parts.push(',')
      parts.push(this.waiterText(id, copy))
    }
    parts.push('],"marks":[')
    for (const [key, marks] of data.marks) {
      if (parts.at(-1) !== '],"marks":[') parts.push(',')
      parts.push(`[${JSON.stringify(key)},[${marks.map((mark) => this.encode(mark)).join(',')}]]`)
    }
    parts.push(
      `],"accepted":${JSON.stringify([...data.accepted])},"returning":${JSON.stringify([...data.returning])},"targets":${JSON.stringify([...data.targets])}}`,
    )
    return parts
  }

  /** Serial changes share immutable entries; failed saves never publish their draft. */
  private change(change: (data: typeof this.data) => void, whenFull?: () => void): Promise<void> {
    const saved = this.pending.then(async () => {
      if (this.stopped) throw new Error('delivery recovery is closed')
      const before = this.data
      const data = {
        person: before.person,
        waiters: new Map(before.waiters),
        marks: new Map(before.marks),
        accepted: new Set(before.accepted),
        returning: new Set(before.returning),
        targets: new Map(before.targets),
      }
      change(data)
      const oldest = [...data.waiters].filter(([id]) => this.restoredWaiters.has(id)).sort((a, b) => a[1].click.at - b[1].click.at)
      while (data.waiters.size > WAITERS_MOST && oldest.length) data.waiters.delete(oldest.shift()![0])
      const sameMap = <K, V>(a: Map<K, V>, b: Map<K, V>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
      const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((id) => b.has(id))
      if (
        data.person === before.person &&
        sameMap(data.waiters, before.waiters) &&
        sameMap(data.marks, before.marks) &&
        sameMap(data.targets, before.targets) &&
        sameSet(data.accepted, before.accepted) &&
        sameSet(data.returning, before.returning)
      )
        return
      let pieces = this.pieces(data)
      let bytes = pieces.reduce((n, part) => n + Buffer.byteLength(part), 0)
      let evicted = false
      while (bytes > BYTES && oldest.length) {
        const [id, copy] = oldest.shift()!
        data.waiters.delete(id)
        bytes -= Buffer.byteLength(this.waiterText(id, copy)) + (data.waiters.size ? 1 : 0)
        evicted = true
      }
      if (bytes > BYTES || data.waiters.size > WAITERS_MOST || data.accepted.size > RECEIPTS_MOST || data.returning.size > CLAIMS_MOST) {
        // A mark that cannot fit uses the normal short line. Its failed draft must not
        // discard existing copies or keep an unrelated conversation from receiving a click.
        if (whenFull) return whenFull()
        throw new Error('delivery recovery is full')
      }
      // Rebuild only once after eviction; scanning the whole record for each removed
      // copy would make a full record expensive precisely when it needs to shed copies.
      if (evicted) pieces = this.pieces(data)
      await writePrivateAsync(this.file, pieces, () => !this.stopped)
      if (this.stopped) throw new Error('delivery recovery is closed')
      this.data = data
      for (const id of this.restoredWaiters) if (!data.waiters.has(id)) this.restoredWaiters.delete(id)
    })
    // Each caller receives its own failure. A failed save must not prevent the next retry.
    this.pending = saved.catch(() => {})
    return saved
  }

  get stopped(): boolean {
    return this.closed || this.erased
  }

  erase(): void {
    this.erased = true
    this.data.waiters.clear()
    this.restoredWaiters.clear()
    this.data.marks.clear()
    this.data.accepted.clear()
    this.data.returning.clear()
    this.data.targets.clear()
    this.onErase?.()
  }

  async close(): Promise<void> {
    this.closed = true
    active.delete(this)
    await this.pending
  }
}
