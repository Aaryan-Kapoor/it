// What the person did on a page is saved in this browser before it is sent, and removed once
// its fate is known. If the tab closes or the browser stops before then, it is sent again under
// the same id the next time that same person has the site open, and the backend treats a
// repeat as the same click.
//
// Each click is kept under a key of its own, named for the person and the page it belongs to.
// So two tabs never overwrite each other's, two pages never overwrite each other's, and one
// person's clicks are never sent, or thrown away, as someone else.
import { type ActionEnvelope, LIMITS } from '@it/protocol'
import type { ConvexReactClient } from 'convex/react'
import { api, displayKey, type Id, letGoOf, note, refusal, timesLetGo, whenLetGo } from './lib'

const PREFIX = 'it.outbox.'
/** How many clicks may be kept unsent in this browser for one person, and how many of those for one page. */
const MAX = 100
const MAX_PER_PAGE = 30
/** How many days a click that could not be sent is kept before it is given up. */
export const UNSENT_DAYS = 7
const MAX_AGE_MS = UNSENT_DAYS * 86400_000
/** A click saved this recently is still its page's to send. */
const FRESH_MS = 10_000
/** How long a tab's hold on a click it is sending lasts without being renewed, and how often it is renewed. */
const HOLD_MS = 15_000
const HOLD_EVERY_MS = 5_000
/** What the site sends for a page: the page's envelope with its data as JSON text. */
export type Sent = Omit<ActionEnvelope, 'payload'> & { payload: string }
interface Entry {
  user: string
  artifactId: string
  envelope: Sent
  at: number
  /** Its page has finished with it and left it here to be sent when it can be. */
  left?: boolean
  /**
   * Until when the tab that saved it is still sending it. That tab moves this forward every few
   * seconds for as long as it is; a tab that has gone stops, and the time runs out. Until it
   * has, no other tab sends the click: it is one request at a time, in whichever tab it is.
   */
  held?: number
}

const keyOf = (user: string, artifactId: string, id: string) => `${PREFIX}${user}.${artifactId}.${id}`

// Whatever shows what became of a click is told the moment what is kept here changes, so that
// it never goes on saying what was true of the click before. Each change is counted, and the
// count is what a view compares to know that it must look again.
let changes = 0
const watchers = new Set<() => void>()
function changed(): void {
  changes++
  for (const fn of watchers) fn()
}
/** Another tab of this browser has kept a click or let go of one, which the browser says to every other tab. */
const elsewhere = (e: StorageEvent): void => {
  if (e.key === null || e.key.startsWith(PREFIX)) changed()
}
/** How many times what is kept here has changed, in this tab or, as far as the browser has said, in another. */
export const outboxChanges = (): number => changes
/** Calls `fn` each time what is kept here changes: at once for this tab's own clicks, and when the browser says another tab has changed it. */
export function watchOutbox(fn: () => void): () => void {
  if (watchers.size === 0) window.addEventListener('storage', elsewhere)
  watchers.add(fn)
  return () => {
    watchers.delete(fn)
    if (watchers.size === 0) window.removeEventListener('storage', elsewhere)
  }
}
/** Keeps a click, or lets go of one, and says so to whatever is watching. */
const put = (key: string, value: string): void => {
  localStorage.setItem(key, value)
  changed()
}
const drop = (key: string): void => {
  localStorage.removeItem(key)
  changed()
}
function entries(user: string): [string, Entry][] {
  const out: [string, Entry][] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(`${PREFIX}${user}.`)) continue
    try {
      out.push([key, JSON.parse(localStorage.getItem(key) ?? '') as Entry])
    } catch {
      note('a saved click could not be read, and was dropped')
      localStorage.removeItem(key)
    }
  }
  return out.sort((a, b) => a[1].at - b[1].at)
}

/**
 * Drops every click kept here that is too old to send, whoever it was kept for and whether or
 * not this browser is paired. Run when the site starts: a click is sent only as the person who
 * made it, so one kept for a person who is never paired here again would otherwise stay for good.
 */
export function dropOld(): void {
  const old: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(PREFIX)) continue
    try {
      const at = (JSON.parse(localStorage.getItem(key) ?? '') as Partial<Entry>).at
      if (typeof at === 'number' && Date.now() - at <= MAX_AGE_MS) continue
    } catch {}
    old.push(key)
  }
  for (const key of old) localStorage.removeItem(key)
  if (old.length) {
    changed()
    note('saved clicks were too old to send, and were dropped', old.length)
  }
}

const send = (convex: ConvexReactClient, e: Entry) =>
  convex.mutation(api.actions.submit, { artifactId: e.artifactId as Id<'artifacts'>, displayKey: displayKey(), envelope: e.envelope })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** A refusal that says "not now" and nothing about the click itself: slow down, or the page's queue is full at the moment. */
const notNow = (err: unknown) => ['rate_limited', 'limit'].includes(refusal(err).code)
const waitFor = (err: unknown) =>
  Math.max(250, Number((refusal(err) as { retryAfterMs?: number }).retryAfterMs ?? (refusal(err).code === 'limit' ? 30_000 : 1000)))
/** A refusal that will be the same however often the click is sent again. */
const settled = (err: unknown) => ['invalid', 'not_found', 'conflict'].includes(refusal(err).code)

// The clicks this tab is sending this very moment. The sending of what was left over passes
// them by: a click is one request at a time, so that what its page is told is what became of it.
const sending = new Set<string>()

/** For each person, when what could not be sent is to be tried again. */
const retry = new Map<string, { timer: ReturnType<typeof setTimeout>; wait: number }>()

// Whose clicks may be sent right now: the person this browser is paired for. Sending stops the
// moment that is someone else, or nobody: a click is only ever sent as the person who made it.
let pairedFor: string | null = null
/**
 * Whether this person's clicks may be kept and sent here at this moment: the browser is paired
 * for them, and what it kept for them has not been let go of. Once everything of theirs was
 * erased, a tab may take itself for theirs a moment longer, and nothing is kept for them in it.
 */
const theirs = (user: string): boolean => pairedFor === user && !letGoOf(user)
// Which session of theirs it is, and how many pairings this tab has seen. A browser that is
// paired again has a new session, and that is a new pairing even for the same person: what was
// begun under the old one is not finished under it.
let session: string | null = null
let pairings = 0
/** The pairing that is current now, for something that is starting to remember. */
export const thisPairing = (): number => pairings
/**
 * Whether this person is still the one this browser is paired for, and, given the pairing
 * something began under, whether it is still that pairing. Something begun as them, and still
 * going, asks before each step.
 */
export const stillPairedFor = (user: string, since?: number): boolean => theirs(user) && (since === undefined || since === pairings)
/** Whether this browser is paired for anyone now. */
export const pairedForSomeone = (): boolean => pairedFor !== null
export function outboxBelongsTo(user: string | null, under: string | null = null): void {
  if (user !== pairedFor || under !== session) pairings++
  session = under
  if (user === pairedFor) return
  pairedFor = user
  // Whatever was going to be tried again later was for whoever was here before
  for (const r of retry.values()) clearTimeout(r.timer)
  retry.clear()
  // And what was being sent was being sent as them: if they come back, it is theirs to send again
  sending.clear()
}

// One click, one sender, across every tab of this browser. Where the browser has locks that all
// its tabs share, the tab sending a click holds that click's lock from before it is saved until
// its fate is known, however long that takes and whether or not the tab's timers are running;
// the lock goes by itself if the tab is closed. Where it has none, the timed hold kept in the
// entry itself (`held`) does the same job less well.
interface Locks {
  request<T>(name: string, options: { ifAvailable?: boolean }, work: (lock: unknown) => Promise<T>): Promise<T>
}
const locks = (): Locks | undefined => (typeof navigator === 'undefined' ? undefined : (navigator as unknown as { locks?: Locks }).locks)

// Clicks this browser would not store (its storage is full, or switched off) and that have not
// been answered yet, each by when it was made. They exist only in this tab, and the page's bar
// says so while there are any.
const unkept = new Map<string, number[]>()
const unkeptKey = (user: string, artifactId: string) => `${user}.${artifactId}`
/** How many of this person's clicks on one page are on their way with no copy kept in this browser. */
export const unsaved = (user: string, artifactId: string) => unkept.get(unkeptKey(user, artifactId))?.length ?? 0
/** Whether anything done on any page is on its way with no copy kept in this browser: it is in this tab alone, and loading the site afresh would lose it. */
export const anyUnsaved = (): boolean => [...unkept.values()].some((made) => made.length > 0)

// What was kept in this browser was let go of: everything, or what was one person's where the
// browser is kept for another by now. What this tab holds of it in memory goes too: nothing of
// theirs is tried again later, and no click of theirs is counted as on its way. Whatever shows
// what became of a click is told, since none of those is kept any more.
whenLetGo((person, whole) => {
  for (const [user, r] of retry) {
    if (!whole && user !== person) continue
    clearTimeout(r.timer)
    retry.delete(user)
  }
  for (const key of [...unkept.keys()]) if (whole || (person !== null && key.startsWith(`${person}.`))) unkept.delete(key)
  changed()
})

/**
 * Saves, sends, and resolves once It has accepted the click. Throws with a message for the
 * person when it is refused, or when it can neither be kept safe nor sent.
 *
 * `stillThere` says whether the document that sent it is still the one showing. A click is
 * kept in this browser only while nobody has been told what became of it. If the page is told
 * it was accepted, or told it failed, the click is gone from here: one the person saw fail is
 * never sent again later behind their back. If the page has gone by the time a refusal comes
 * back, nobody was told anything, so the click stays, and is sent when it can be, unless the
 * refusal is one that would be the same every time. And if the browser has been paired for
 * someone else meanwhile, it is neither sent as them nor thrown away: it waits for its own person.
 */
export async function submit(
  convex: ConvexReactClient,
  user: string,
  artifactId: string,
  envelope: Sent,
  stillThere: () => boolean = () => true,
  /**
   * Whether the person was at the page, when that cannot be said at once. The click is saved
   * first, as one the page sent by itself, and this is waited for only then: nothing that takes
   * time stands between a click and its being kept.
   */
  judge?: () => Promise<boolean>,
): Promise<{ actionId: string }> {
  if (new TextEncoder().encode(envelope.payload).length > LIMITS.actionPayloadBytes)
    throw new Error(`An action carries at most ${LIMITS.actionPayloadBytes / 1024} KB.`)
  // The same rules the backend applies, applied before anything is stored here
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(envelope.clientActionId) || !/^[A-Za-z0-9_.:-]{1,64}$/.test(envelope.name))
    throw new Error('That is not an action this page can send.')
  if (!Number.isInteger(envelope.contentVersion) || (envelope.baseStateRevision !== undefined && !Number.isInteger(envelope.baseStateRevision)))
    throw new Error('That is not an action this page can send.')
  const key = keyOf(user, artifactId, envelope.clientActionId)
  const shared = locks()
  // Held from here until the click is accepted, refused, or left behind for later
  return shared
    ? shared.request(key, {}, () => sendNow(convex, user, artifactId, envelope, key, stillThere, judge))
    : sendNow(convex, user, artifactId, envelope, key, stillThere, judge)
}

async function sendNow(
  convex: ConvexReactClient,
  user: string,
  artifactId: string,
  envelope: Sent,
  key: string,
  stillThere: () => boolean,
  judge?: () => Promise<boolean>,
): Promise<{ actionId: string }> {
  const mine = () => theirs(user)
  if (!mine()) throw new Error('This browser’s pairing has ended.')
  // What is kept here for the person may be let go of while the click is on its way, and from
  // then on nothing of it is kept again: not by the hold, not for later, whatever becomes of the click
  const began = timesLetGo(user)
  const letGo = () => timesLetGo(user) !== began
  const entry: Entry = { user, artifactId, envelope, at: Date.now(), held: Date.now() + HOLD_MS }
  // Too many already unsent means something is wrong, and one more would only push an older one
  // out. One page may hold only part of what the browser keeps, so it cannot crowd out the rest.
  const waiting = entries(user)
  if (waiting.length >= MAX || waiting.filter(([, e]) => e.artifactId === artifactId).length >= MAX_PER_PAGE)
    throw new Error('Too many actions are still waiting to be sent from this browser. Check the connection.')
  let kept = false
  // Noted as being sent before it is kept, so that whatever is told of the change finds it so
  sending.add(key)
  try {
    put(key, JSON.stringify(entry))
    kept = true
  } catch {
    // This browser will not store it (its storage is full, or switched off). Without a
    // connection it could only sit in memory and be lost with the tab, so the person is told
    // now, while they can still do something about it. With one it is sent, and until it is
    // answered the page's bar says that it is not saved here and the tab must stay open.
    if (!convex.connectionState().isWebSocketConnected) {
      sending.delete(key)
      throw new Error('This could not be saved or sent. Check the connection and try again.')
    }
    unkept.set(unkeptKey(user, artifactId), [...(unkept.get(unkeptKey(user, artifactId)) ?? []), entry.at])
    changed()
  }
  let keep = false
  // The hold is kept up for as long as this tab is sending the click, so that the tab beside it
  // leaves it alone however long that takes
  const holding = kept
    ? setInterval(() => {
        entry.held = Date.now() + HOLD_MS
        try {
          if (!letGo() && localStorage.getItem(key) !== null) localStorage.setItem(key, JSON.stringify(entry))
        } catch {}
      }, HOLD_EVERY_MS)
    : undefined
  try {
    if (judge) {
      entry.envelope = { ...envelope, attended: await judge() }
      if (kept && !letGo()) {
        try {
          localStorage.setItem(key, JSON.stringify(entry))
        } catch {}
      }
    }
    for (let attempt = 0; ; attempt++) {
      // Never as anyone but the person who clicked
      if (!mine()) {
        keep = true
        throw new Error('This browser’s pairing has ended.')
      }
      try {
        return await send(convex, entry)
      } catch (err) {
        if (!mine() || (!stillThere() && !settled(err))) {
          // Nobody was told what became of it: it stays, and is sent when it can be
          keep = true
          throw err
        }
        // Told "not now": waited out a few times, since the person did click
        if (!notNow(err) || attempt >= 3 || waitFor(err) > 5000) throw err
        await sleep(waitFor(err))
      }
    }
  } finally {
    clearInterval(holding)
    sending.delete(key)
    // Kept for later only while what is kept here is still kept: let go of meanwhile, the click went with the rest
    const stays = kept && keep && !letGo()
    if (kept && !stays) localStorage.removeItem(key)
    // Left behind for later: marked, so that the sending of what is left does not wait for a
    // page that has finished with it
    if (stays) {
      try {
        localStorage.setItem(key, JSON.stringify({ ...entry, left: true, held: undefined }))
      } catch {}
    }
    if (!kept) {
      const others = [...(unkept.get(unkeptKey(user, artifactId)) ?? [])]
      const at = others.indexOf(entry.at)
      if (at >= 0) others.splice(at, 1)
      unkept.set(unkeptKey(user, artifactId), others)
    }
    changed()
    if (stays) void drain(convex, user)
  }
}

// One drain at a time for each person. A drain asked for while one is running is run again
// when that one ends, and one person's never stands in the way of another's.
const draining = new Map<string, { again: boolean }>()
/**
 * Sends whatever is still kept for this person: clicks that were on their way when the tab
 * closed or the connection went, and so never got an answer. It carries on until there is
 * nothing left, waiting when told "not now", and stops at once if the browser is paired for
 * someone else. A click that cannot be sent for a reason that says nothing about the click (the
 * backend is in trouble, say) is stepped past, so that it does not hold up the ones behind it,
 * and everything still left is tried again a while later, by itself.
 */
export async function drain(convex: ConvexReactClient, user: string): Promise<void> {
  const running = draining.get(user)
  if (running) {
    running.again = true
    return
  }
  const state = { again: false }
  draining.set(user, state)
  const mine = () => theirs(user)
  const pending = retry.get(user)
  if (pending) clearTimeout(pending.timer)
  let troubled = false
  /** How long until the first of the clicks that were passed by may be looked at again. Nothing, when none was. */
  let fresh = 0
  const sooner = (wait: number) => {
    fresh = fresh ? Math.min(fresh, wait) : wait
  }
  try {
    // Clicks passed by, and until when: one that another tab holds, or that is too fresh, is
    // looked at again once that is over, and one that met trouble not again in this sending
    const stepped = new Map<string, number>()
    // How often each click has met trouble in this sending
    const troubles = new Map<string, number>()
    const passedBy = (key: string) => (stepped.get(key) ?? 0) > Date.now()
    // Pages that said "not now", and until when. Their clicks wait their time, in the order they
    // were made, and the clicks for every other page are sent meanwhile: one page that is always
    // told to slow down holds up nobody else's.
    const notNow = new Map<string, number>()
    const waits = (e: Entry) => (notNow.get(e.artifactId) ?? 0) > Date.now()
    for (let rounds = 0; rounds < 500 && mine(); rounds++) {
      const left = entries(user).filter(([key]) => !passedBy(key))
      const next = left.find(([, e]) => !waits(e))
      if (!next) {
        // Nothing can be sent this moment. If a page said when to come back, that is waited
        // for, and not past the moment a click that was passed by may be looked at again:
        // a page that keeps being told to slow down does not keep the others waiting on it
        const until = Math.min(...left.map(([, e]) => notNow.get(e.artifactId) ?? Number.POSITIVE_INFINITY))
        if (!Number.isFinite(until)) break
        const sooner = Math.min(until, ...[...stepped.values()].filter((at) => Number.isFinite(at) && at > Date.now()))
        await sleep(Math.max(0, sooner - Date.now()))
        continue
      }
      const [key, entry] = next
      if (Date.now() - entry.at > MAX_AGE_MS) {
        note('a saved click was too old to send, and was dropped')
        drop(key)
        continue
      }
      // Saved a moment ago: the page that sent it may still be sending it, or still working
      // out whether the person was there. It is left for that, and looked at again later.
      if (sending.has(key)) {
        stepped.set(key, Date.now() + 2000)
        sooner(2000)
        continue
      }
      // Another tab is sending it this moment
      if (!entry.left && entry.held !== undefined && entry.held > Date.now()) {
        stepped.set(key, entry.held)
        sooner(entry.held - Date.now())
        continue
      }
      if (!entry.left && Date.now() - entry.at < FRESH_MS) {
        stepped.set(key, entry.at + FRESH_MS)
        sooner(FRESH_MS - (Date.now() - entry.at))
        continue
      }
      // Sent only by whoever holds the click's lock. If another tab holds it, that tab is
      // sending it this moment, and it is passed by. Once held, the entry is read again: the
      // tab that had it may have finished with it in the meantime.
      const shared = locks()
      const outcome = shared
        ? await shared.request(key, { ifAvailable: true }, async (lock) => (lock ? replay(convex, user, key) : 'busy'))
        : await replay(convex, user, key)
      if (outcome === 'trouble') {
        // Left for a while and tried again, a little longer each time: trouble passes, and a
        // click must not wait on it for as long as some other page is being told to slow down
        const tries = (troubles.get(key) ?? 0) + 1
        troubles.set(key, tries)
        stepped.set(key, Date.now() + Math.min(5000 * 2 ** (tries - 1), 60_000))
        troubled = true
      } else if (outcome === 'busy') {
        stepped.set(key, Date.now() + 5000)
        sooner(5000)
      } else if (outcome === 'stop') break
      else if (typeof outcome === 'number') notNow.set(entry.artifactId, Date.now() + outcome)
    }
  } finally {
    draining.delete(user)
  }
  if (!mine()) return
  if (state.again) return drain(convex, user)
  // Whatever is still here when the sending stops, for whatever reason, is tried again later:
  // as soon as a click left to its page is old enough, and otherwise less and less often, for
  // a display nobody is standing at
  if (entries(user).length === 0) {
    retry.delete(user)
    return
  }
  const wait = troubled || !fresh ? Math.min((pending?.wait ?? 2500) * 2, 300_000) : fresh + 100
  retry.set(user, { wait: troubled || !fresh ? wait : (pending?.wait ?? 2500), timer: setTimeout(() => void drain(convex, user), wait) })
}

/**
 * Sends one kept click again, as the person it belongs to. Says what became of it: 'done' when
 * it is kept no more (accepted, refused for good, or already gone), a number of milliseconds
 * to wait when told to slow down, 'trouble' when it should be left for later, and 'stop' when
 * the browser is paired for someone else.
 */
async function replay(convex: ConvexReactClient, user: string, key: string): Promise<'done' | 'trouble' | 'stop' | number> {
  const mine = () => theirs(user)
  let entry: Entry
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return 'done'
    entry = JSON.parse(raw) as Entry
  } catch {
    drop(key)
    return 'done'
  }
  // Asked again here, and not only before the click's lock was asked for: the lock is given
  // later, and by then the browser may be paired for someone else, as whom this click must not be sent
  if (!mine()) return 'stop'
  try {
    await send(convex, entry)
    // Removed only as the person who sent it: if the browser was paired for someone else
    // meanwhile, the answer was not about this person's click
    if (!mine()) return 'stop'
    drop(key)
    return 'done'
  } catch (err) {
    if (!mine()) return 'stop'
    if (settled(err)) {
      note('a saved click was refused for good, and was dropped', refusal(err).code)
      drop(key)
      return 'done'
    }
    // Told to slow down: waited out, and the same click is tried again
    if (refusal(err).code === 'rate_limited') return Math.min(waitFor(err), 60_000)
    // Not paired at this moment, the backend in trouble, the page's queue full, or
    // something about this one entry: it waits, and the ones behind it are tried
    return 'trouble'
  }
}

/** How many of this person's clicks on one page have not been answered yet. */
export const unsent = (user: string, artifactId: string) => entries(user).filter(([, e]) => e.artifactId === artifactId).length

/**
 * How long after it was made a click is said to be on its way. A connection can be open and
 * carry nothing, as a phone's does in a pocket, so one that says it is there is believed only
 * for this long: a click not taken by then is said not to have been sent, until it is taken.
 */
const ON_ITS_WAY_MS = 4000
/**
 * Until when this person's clicks on one page may be said to be on their way: so long after the
 * oldest of them was made, and only while this tab is sending every one of them at this moment.
 * Null when there is none, and when one of them is kept here to be sent later: a click made
 * since does not make that one any more sent than it was.
 */
export function onItsWayUntil(user: string, artifactId: string): number | null {
  const kept = entries(user).filter(([, e]) => e.artifactId === artifactId)
  if (kept.some(([key]) => !sending.has(key))) return null
  const made = [...kept.map(([, e]) => e.at), ...(unkept.get(unkeptKey(user, artifactId)) ?? [])]
  return made.length ? Math.min(...made) + ON_ITS_WAY_MS : null
}
