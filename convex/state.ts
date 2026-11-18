import { deepMerge, isStoreKey, LIMITS, parseJson, STORE_KEY } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { ref, resolveArtifact } from './artifacts'
import { ownArtifact, requireBrowser, requireCaller, requireMachine } from './lib/authz'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'

// A page's state is two parts kept apart. The agent's part is one record of JSON text, written
// whole whenever the agent changes it. What the page keeps for itself with It.store is a record
// for each name it keeps a value under, so that a page that changes one value writes that value
// alone, and a display that shows the page is sent that value alone. Together they are what
// the agent reads, with what the page keeps under `_page`, and what a page is given as its
// state. The small record of the page's revision counts what the page keeps, so that a change
// is made without reading the rest.
//
// The backend program lets one function read at most 4,096 places in the database, and looking
// a record up by its name, changing it and removing it are each one of them, while a record
// that is added is none. So a change is never made record by record beyond a few thousand of
// them: one that reaches more of what the page already keeps writes all of it afresh, as
// records that are added, and from that revision on the records from before it are no part of
// the state (`keptFrom`). They are removed afterwards, a batch at a time.

type State = Record<string, unknown>
const isObject = (x: unknown): x is State => typeof x === 'object' && x !== null && !Array.isArray(x)

/**
 * How many names a page took its value away from are kept, each with no value, so that a
 * display that still had the value is told it went. Past this they all go at once, and a
 * display whose state is from before then is sent the whole state again.
 */
const GONE_KEPT = 1000
/** A display further behind than this many changed values is sent the whole state rather than what changed. */
const CHANGES_AT_MOST = 2000
/**
 * How many of the records a page already has one change writes to or removes, one by one. A
 * change that reaches more of them writes everything the page keeps afresh, and a display is
 * sent the whole state after it, as it would be after this many changed values anyway.
 */
const IN_PLACE_AT_MOST = CHANGES_AT_MOST
/**
 * How many records left behind by a writing afresh are removed at a time, and how long lies
 * before the first of them and between one batch and the next. The backend program counts what
 * every function writes within any one second, and once that is more than 4 MiB it holds the
 * writes that come next back until the second is over. Writing afresh the most a page may keep
 * comes to about that much by itself. So what it left behind is removed only once that second
 * has passed, and a little at a time: the removing is never what holds another write back.
 */
const LEFT_AT_ONCE = 1000
const LEFT_EVERY_MS = 1500

const encoder = new TextEncoder()
const sizeOf = (text: string) => encoder.encode(text).length
/** What one value comes to in the page's state as JSON: its name in quotes, a colon, the value, and a comma. */
const entryBytes = (key: string, json: string) => sizeOf(key) + sizeOf(json) + 4
/** What a whole state comes to as JSON: the agent's part, and beside it, under `_page`, what the page keeps where it keeps anything. */
const wholeBytes = (agentBytes: number, keys: number, keptBytes: number) => agentBytes + (keys > 0 ? 10 + keptBytes : 0)

const stateRecord = (ctx: QueryCtx | MutationCtx, artifactId: Id<'artifacts'>) =>
  ctx.db
    .query('states')
    .withIndex('by_artifact', (q) => q.eq('artifactId', artifactId))
    .unique()
const revisionRecord = (ctx: QueryCtx | MutationCtx, artifactId: Id<'artifacts'>) =>
  ctx.db
    .query('revisions')
    .withIndex('by_artifact', (q) => q.eq('artifactId', artifactId))
    .unique()
// A record of what a page keeps is part of its state only where it was written at or after the
// revision the page last wrote all of it afresh at (`from`): each of these reads leaves out the
// records from before it, which are waiting to be removed.
const keptUnder = (ctx: QueryCtx | MutationCtx, artifactId: Id<'artifacts'>, key: string, from: number) =>
  ctx.db
    .query('stored')
    .withIndex('by_artifact_key', (q) => q.eq('artifactId', artifactId).eq('key', key).gte('revision', from))
    .unique()
const keptNow = (ctx: QueryCtx | MutationCtx, artifactId: Id<'artifacts'>, gone: boolean, from: number) =>
  ctx.db
    .query('stored')
    .withIndex('by_artifact_gone', (q) => q.eq('artifactId', artifactId).eq('gone', gone).gte('revision', from))
    .collect()
/** Every record of what a page keeps, the names it took a value away from among them, in one read. */
const keptWhole = (ctx: QueryCtx | MutationCtx, artifactId: Id<'artifacts'>, from: number) =>
  ctx.db
    .query('stored')
    .withIndex('by_artifact_revision', (q) => q.eq('artifactId', artifactId).gte('revision', from))
    .collect()

/**
 * The agent's part of a state written as JSON text, and what the page kept for itself inside it,
 * under `_page`, where the state was last written before each value had a record of its own.
 */
function split(json: string | undefined): { agent: State; inside?: State } {
  const parsed = json === undefined ? {} : parseJson(json)
  const all = isObject(parsed) ? parsed : {}
  if (!Object.hasOwn(all, STORE_KEY)) return { agent: all }
  const { [STORE_KEY]: inside, ...agent } = all
  return { agent, inside: isObject(inside) ? inside : {} }
}

/**
 * What a page keeps for itself, by name, as JSON text: from its records, or from inside the
 * agent's part where it is still there. What is inside the agent's part was kept under any name
 * an agent gave it, and a page could read it under that name, so every name is kept as it is.
 * The rules for a name hold for what is written from now on, and are kept where it is written.
 */
async function keptBy(ctx: QueryCtx | MutationCtx, artifactId: Id<'artifacts'>, inside: State | undefined, from: number): Promise<[string, string][]> {
  if (inside) return Object.entries(inside).map(([k, value]) => [k, JSON.stringify(value)])
  return (await keptNow(ctx, artifactId, false, from)).map((r) => [r.key, r.json ?? 'null'])
}

/** The page's revision: the later of the record of it and the state's own, either of which may be missing. */
const revisionOf = (r: Doc<'revisions'> | null, s: Doc<'states'> | null) => Math.max(r?.revision ?? 0, s?.revision ?? 0)
/**
 * The page's revision, from the small record of it where that counts what the page keeps, which
 * is written with every change, and without reading the state, which can be half a megabyte.
 * A record written before It counted that, or none at all, is read with the state, and the later
 * of the two is the page's: so the revision is the same however it is asked for.
 */
const revisionFrom = async (r: Doc<'revisions'> | null, state: () => Promise<Doc<'states'> | null>) =>
  r?.keys !== undefined ? r.revision : revisionOf(r, await state())

/** A page's whole state, as the agent and the page itself wrote it, and its revision. */
export async function wholeState(ctx: QueryCtx | MutationCtx, artifactId: Id<'artifacts'>): Promise<{ state: State; revision: number }> {
  const [s, r] = await Promise.all([stateRecord(ctx, artifactId), revisionRecord(ctx, artifactId)])
  const { agent, inside } = split(s?.json)
  const kept = await keptBy(ctx, artifactId, inside, r?.keptFrom ?? 0)
  const state = kept.length > 0 ? { ...agent, [STORE_KEY]: Object.fromEntries(kept.map(([k, json]) => [k, parseJson(json)])) } : agent
  return { state, revision: revisionOf(r, s) }
}

/** A page's state, as JSON text, and its revision: what the agent reads, with what the page keeps under `_page`. */
export const get = query({
  args: ref,
  handler: async (ctx, args) => {
    const { user } = await requireCaller(ctx)
    const a = await resolveArtifact(ctx, user._id, args)
    const { state, revision } = await wholeState(ctx, a._id)
    return { json: JSON.stringify(state), revision }
  },
})

/** What a display is sent of a page's state: see `live`. */
export interface Live {
  revision: number
  /** The whole state, where what came before is not to be built on. */
  whole?: true
  /** The agent's part, as JSON text, where it changed. */
  state?: string
  /** What the page keeps, by name, as JSON text, with `null` for a value taken away. */
  kept?: [string, string | null][]
}

/**
 * A page's state as a display keeps it up to date: the whole of it, or, given the revision the
 * display has, only what changed since. The agent's part comes whole when it changed, and what
 * the page keeps comes value by value, with `null` for a value taken away. Each value is JSON
 * text. Asked again with the revision it answered, it answers with that revision alone until
 * the state changes again.
 */
export const live = query({
  args: { artifactId: v.id('artifacts'), since: v.optional(v.number()) },
  handler: async (ctx, { artifactId, since }): Promise<Live> => {
    const { user } = await requireCaller(ctx)
    const a = await resolveArtifact(ctx, user._id, { artifactId })
    const r = await revisionRecord(ctx, a._id)
    // The agent's part is read only when it is to be sent: it can be half a megabyte
    let s: Doc<'states'> | null | undefined
    const state = async () => {
      if (s === undefined) s = await stateRecord(ctx, a._id)
      return s
    }
    const revision = await revisionFrom(r, state)
    if (since === revision) return { revision }
    const whole = async () => {
      const { agent, inside } = split((await state())?.json)
      return { revision, whole: true as const, state: JSON.stringify(agent), kept: await keptBy(ctx, a._id, inside, r?.keptFrom ?? 0) }
    }
    // A display with no state yet, or one from before what is still known of what changed
    if (since === undefined || since > revision || since < (r?.floor ?? 0) || r?.keys === undefined) return whole()
    const changed = await ctx.db
      .query('stored')
      .withIndex('by_artifact_revision', (q) => q.eq('artifactId', a._id).gt('revision', since))
      .take(CHANGES_AT_MOST + 1)
    if (changed.length > CHANGES_AT_MOST) return whole()
    const agentRevision = r.agentRevision ?? (await state())?.revision ?? 0
    return {
      revision,
      ...(agentRevision > since ? { state: JSON.stringify(split((await state())?.json).agent) } : {}),
      kept: changed.map((c) => [c.key, c.gone ? null : (c.json ?? 'null')] as [string, string | null]),
    }
  },
})

/** Where a page's state stands, for a change to it: its records, its revision now and the one the change makes, and what it holds, as counted. */
interface Standing {
  artifactId: Id<'artifacts'>
  r: Doc<'revisions'> | null
  /** The agent's part, where it was read. */
  s?: Doc<'states'> | null
  revision: number
  next: number
  agentAt: number
  agentRevision: number
  agentBytes: number
  keys: number
  keptBytes: number
  gone: number
  floor: number
  /** The revision the page last wrote all it keeps afresh at: a record from before it is no part of the state. */
  from: number
  /** Whether this function has moved values out of the agent's part, into records at `next`. */
  moved?: boolean
}

type Row = Doc<'stored'>
/** The records a change is made against, by name, and whether they are every record of what the page keeps. */
interface Rows {
  under: Map<string, Row>
  whole: boolean
}

/**
 * The records of what a page keeps under the names a change is about. A few names are looked up
 * one by one, so that a page that changes one value reads that value alone. Many are not: all
 * the page keeps is read at once, which is one read of the database however many names there are.
 */
async function rowsUnder(ctx: MutationCtx, at: Standing, names: string[], whole = names.length > LIMITS.storeKeysAtOnce): Promise<Rows> {
  const under = new Map<string, Row>()
  if (whole) for (const row of await keptWhole(ctx, at.artifactId, at.from)) under.set(row.key, row)
  else
    for (const key of names) {
      const row = await keptUnder(ctx, at.artifactId, key, at.from)
      if (row) under.set(key, row)
    }
  return { under, whole }
}

/**
 * Reads where a page's state stands, for a change. A state whose page's values are still inside
 * the agent's part has them moved out into records of their own first, at the revision of the
 * change; and a record of the revision that does not count what the page keeps has it counted
 * afresh.
 */
async function standing(ctx: MutationCtx, artifactId: Id<'artifacts'>): Promise<Standing> {
  const r = await revisionRecord(ctx, artifactId)
  const from = r?.keptFrom ?? 0
  if (r?.keys !== undefined) {
    return {
      artifactId,
      r,
      revision: r.revision,
      next: r.revision + 1,
      agentAt: r.agentAt ?? 0,
      agentRevision: r.agentRevision ?? r.revision,
      agentBytes: r.agentBytes ?? 2,
      keys: r.keys,
      keptBytes: r.keptBytes ?? 0,
      gone: r.gone ?? 0,
      floor: r.floor ?? 0,
      from,
    }
  }
  const s = await stateRecord(ctx, artifactId)
  const revision = revisionOf(r, s)
  const { agent, inside } = split(s?.json)
  const agentJson = JSON.stringify(agent)
  const rows = await keptWhole(ctx, artifactId, from)
  const live = rows.filter((row) => !row.gone)
  const at: Standing = {
    artifactId,
    r,
    s: s && { ...s, json: agentJson },
    revision,
    next: revision + 1,
    agentAt: r?.agentAt ?? s?.agentAt ?? 0,
    agentRevision: s?.revision ?? 0,
    agentBytes: sizeOf(agentJson),
    keys: live.length,
    keptBytes: live.reduce((n, row) => n + row.bytes, 0),
    gone: rows.length - live.length,
    floor: r?.floor ?? 0,
    from,
  }
  if (inside && s) {
    const moved = await putKept(ctx, at, await keptBy(ctx, artifactId, inside, from), { under: new Map(rows.map((row) => [row.key, row])), whole: true })
    await moved.write()
    at.moved = moved.changed
    await ctx.db.patch(s._id, { json: agentJson })
  }
  return at
}

/**
 * Works out what setting or taking away values the page keeps comes to, at the revision of the
 * change, and counts it in `at`. Nothing is written until `write` is called, so that a change
 * the page may not hold is refused with none of it made. A value set again to what it is
 * already, and one taken away that is not there, are left alone. Says how many bytes the change
 * writes, and whether it changes anything.
 */
async function putKept(
  ctx: MutationCtx,
  at: Standing,
  changes: Iterable<[string, string | null]>,
  rows?: Rows,
): Promise<{ written: number; changed: boolean; write: () => Promise<void> }> {
  const each = [...changes]
  const { under, whole } =
    rows ??
    (await rowsUnder(
      ctx,
      at,
      each.map(([key]) => key),
    ))
  const from = at.from
  const sets: { key: string; json: string; bytes: number; row?: Row }[] = []
  const takes: Row[] = []
  for (const [key, json] of each) {
    const row = under.get(key)
    if (json === null) {
      if (row && !row.gone) takes.push(row)
    } else if (!(row && !row.gone && row.json === json)) sets.push({ key, json, bytes: entryBytes(key, json), row })
  }
  // Names taken away are kept so many at most. Past that they all go, those this change takes
  // away included, and a display whose state is from before this change is sent the whole state,
  // which tells it of every one
  const afresh = at.gone + takes.length > GONE_KEPT
  const revived = sets.filter(({ row }) => row?.gone).length
  // The records there already are that this change writes to or removes. Each is one of the
  // places a function may read, so past a few thousand of them nothing is changed where it is:
  // everything the page keeps after the change is written as records of this revision, and
  // the records from before it are left to be removed afterwards
  const reached = takes.length + sets.filter(({ row }) => row).length + (afresh ? at.gone - revived : 0)
  const all = reached > IN_PLACE_AT_MOST
  // Records this same function wrote at this revision, when it moved values out of the agent's
  // part, would not be left behind by a writing afresh at that revision. So the values are
  // moved out at the one revision, and this change is made at the next
  if (all && at.moved) at.next++
  let written = 0
  for (const row of takes) {
    at.keys--
    at.keptBytes -= row.bytes
    written += sizeOf(row.key)
  }
  for (const { bytes, row } of sets) {
    if (row && !row.gone) at.keptBytes -= row.bytes
    else at.keys++
    at.keptBytes += bytes
    written += bytes
  }
  if (afresh || all) {
    at.gone = 0
    at.floor = at.next
  } else at.gone += takes.length - revived
  if (all) at.from = at.next
  const add = (key: string, json: string, bytes: number) =>
    ctx.db.insert('stored', { artifactId: at.artifactId, key, json, gone: false, revision: at.next, bytes })
  const write = async () => {
    if (all) {
      const kept = new Map<string, { json: string; bytes: number }>()
      for (const row of whole ? under.values() : await keptNow(ctx, at.artifactId, false, from))
        if (!row.gone) kept.set(row.key, { json: row.json ?? 'null', bytes: row.bytes })
      for (const row of takes) kept.delete(row.key)
      for (const { key, json, bytes } of sets) kept.set(key, { json, bytes })
      for (const [key, { json, bytes }] of kept) await add(key, json, bytes)
      await ctx.scheduler.runAfter(LEFT_EVERY_MS, internal.state.forgetLeft, { artifactId: at.artifactId, before: at.next })
      return
    }
    if (afresh)
      for (const row of whole ? [...under.values()].filter((row) => row.gone) : await keptNow(ctx, at.artifactId, true, from)) await ctx.db.delete(row._id)
    for (const row of takes) {
      if (afresh) await ctx.db.delete(row._id)
      else await ctx.db.patch(row._id, { json: undefined, gone: true, revision: at.next, bytes: 0 })
    }
    for (const { key, json, bytes, row } of sets) {
      // A name kept with no value was removed above where everything went afresh
      if (row && !(row.gone && afresh)) await ctx.db.patch(row._id, { json, gone: false, revision: at.next, bytes })
      else await add(key, json, bytes)
    }
  }
  return { written, changed: sets.length > 0 || takes.length > 0 || afresh, write }
}

/**
 * Removes the records that a page's writing afresh of all it keeps left behind, a batch at a
 * time: those from before the revision it wrote at, which are no part of its state since then.
 */
export const forgetLeft = internalMutation({
  args: { artifactId: v.id('artifacts'), before: v.number() },
  handler: async (ctx, { artifactId, before }) => {
    const left = await ctx.db
      .query('stored')
      .withIndex('by_artifact_revision', (q) => q.eq('artifactId', artifactId).lt('revision', before))
      .take(LEFT_AT_ONCE)
    for (const row of left) await ctx.db.delete(row._id)
    if (left.length === LEFT_AT_ONCE) await ctx.scheduler.runAfter(LEFT_EVERY_MS, internal.state.forgetLeft, { artifactId, before })
    return null
  },
})

/** The refusal of more values than a page may keep. */
const tooMany = (): never => fail('limit', `A page keeps at most ${LIMITS.storeKeys} values with It.store.`)

/** Refuses a change that leaves the page holding more than it may, unless it holds less than it did. */
function withinLimits(before: { keys: number; bytes: number }, at: Standing): void {
  if (at.keys > LIMITS.storeKeys && at.keys > before.keys) tooMany()
  const bytes = wholeBytes(at.agentBytes, at.keys, at.keptBytes)
  if (bytes > LIMITS.stateBytes && bytes > before.bytes) fail('limit', `A page's state is at most ${LIMITS.stateBytes / 1024} KB.`)
}

/** Notes the page's new revision beside what it holds, and returns it. */
async function noteStanding(ctx: MutationCtx, at: Standing): Promise<number> {
  const fields = {
    revision: at.next,
    agentAt: at.agentAt,
    agentRevision: at.agentRevision,
    agentBytes: at.agentBytes,
    keys: at.keys,
    keptBytes: at.keptBytes,
    gone: at.gone,
    floor: at.floor,
    ...(at.from > 0 ? { keptFrom: at.from } : {}),
  }
  if (at.r) await ctx.db.patch(at.r._id, fields)
  else await ctx.db.insert('revisions', { artifactId: at.artifactId, ...fields })
  return at.next
}

/**
 * The page keeps values for itself (It.store): each replaces whatever was under its name, and
 * `null` takes it away. Values are JSON text. Counted by how many bytes it wrote, and by the
 * page's own allowance, never by what its agent may write.
 */
export async function keep(
  ctx: MutationCtx,
  userId: Id<'users'>,
  artifactId: Id<'artifacts'>,
  changes: Map<string, string | null>,
): Promise<{ revision: number }> {
  const at = await standing(ctx, artifactId)
  const before = { keys: at.keys, bytes: wholeBytes(at.agentBytes, at.keys, at.keptBytes) }
  const put = await putKept(ctx, at, changes)
  // Nothing changed, and nothing was moved out of the agent's part: the page is where it was
  if (!put.changed && at.r?.keys !== undefined) return { revision: at.revision }
  withinLimits(before, at)
  const kilobytes = Math.max(1, Math.ceil(put.written / 1024))
  await rateLimit(ctx, 'storeKilobytesPage', artifactId, kilobytes)
  await rateLimit(ctx, 'storeKilobytes', userId, kilobytes)
  await put.write()
  return { revision: await noteStanding(ctx, at) }
}

/** What an agent's change does to what the page keeps for itself: merged into it, value by value, or put in place of all of it. */
type KeptChange = { merge: State } | { replace: State }

/**
 * The agent changes its part of a page's state, and with it, where it says so, what the page
 * keeps for itself. Counted by how much it wrote: its whole part, which is written again, and
 * any value of the page's it changed.
 */
export async function write(
  ctx: MutationCtx,
  userId: Id<'users'>,
  artifactId: Id<'artifacts'>,
  next: (current: State) => unknown,
  { baseRevision, kept }: { baseRevision?: number; kept?: KeptChange } = {},
) {
  const at = await standing(ctx, artifactId)
  if (baseRevision !== undefined && baseRevision !== at.revision) fail('conflict', 'The state changed since you read it.', { revision: at.revision })
  const s = at.s === undefined ? await stateRecord(ctx, artifactId) : at.s
  const before = { keys: at.keys, bytes: wholeBytes(at.agentBytes, at.keys, at.keptBytes) }
  const after = next(split(s?.json).agent)
  // The agent's part never holds what the page keeps: that is said apart, in `kept`
  const agent = isObject(after) ? Object.fromEntries(Object.entries(after).filter(([k]) => k !== STORE_KEY)) : {}
  const json = JSON.stringify(agent)
  let put: Awaited<ReturnType<typeof putKept>> | undefined
  if (kept) {
    const changes = new Map<string, string | null>()
    const given = 'merge' in kept ? kept.merge : kept.replace
    namesTheKept(given)
    // What the page keeps is read once for all of the change: every record of it where the
    // change puts something in place of it all, or names more values than are looked up one by one
    const rows = await rowsUnder(ctx, at, Object.keys(given), 'replace' in kept ? true : undefined)
    if ('replace' in kept) {
      for (const row of rows.under.values()) if (!row.gone && !Object.hasOwn(given, row.key)) changes.set(row.key, null)
      for (const [key, value] of Object.entries(given)) changes.set(key, value === null ? null : JSON.stringify(value))
    } else {
      for (const [key, value] of Object.entries(given)) {
        const row = rows.under.get(key)
        const merged = deepMerge(row && !row.gone ? parseJson(row.json ?? 'null') : undefined, value)
        changes.set(key, merged === undefined ? null : JSON.stringify(merged))
      }
    }
    put = await putKept(ctx, at, changes, rows)
  }
  at.agentBytes = sizeOf(json)
  at.agentRevision = at.next
  at.agentAt = Date.now()
  // Before anything of the change is written: one the page may not hold leaves the state as it was
  withinLimits(before, at)
  // Counted by size as well as by number: a large state written over and over is refused.
  // An agent's writes and a page's own are counted apart: a page that saves on every
  // keystroke uses up what pages may write, and never what its agent may
  const kilobytes = Math.max(1, Math.ceil((at.agentBytes + (put?.written ?? 0)) / 1024))
  await rateLimit(ctx, 'stateKilobytesPage', artifactId, kilobytes)
  await rateLimit(ctx, 'stateKilobytes', userId, kilobytes)
  await put?.write()
  if (s) await ctx.db.patch(s._id, { json, revision: at.next, agentAt: at.agentAt })
  else await ctx.db.insert('states', { artifactId, userId, json, revision: at.next, agentAt: at.agentAt })
  return { revision: await noteStanding(ctx, at) }
}

/**
 * A publish's starting state, put in where the agent's part of the page's state is empty: a
 * state that holds only what the page keeps for itself is no state of the agent's. What the
 * page keeps stays as it is, and only where it keeps nothing does what the starting state says
 * under `_page` become what it keeps.
 */
export async function startState(ctx: MutationCtx, userId: Id<'users'>, artifactId: Id<'artifacts'>, start: string): Promise<void> {
  // Looked at before anything is moved: a page whose agent has written to it is left as it is
  if (Object.keys(split((await stateRecord(ctx, artifactId))?.json).agent).length > 0) return
  const at = await standing(ctx, artifactId)
  const s = at.s === undefined ? await stateRecord(ctx, artifactId) : at.s
  const { agent, inside } = split(start)
  const put = inside && at.keys === 0 ? await putKept(ctx, at, await keptBy(ctx, artifactId, inside, at.from)) : undefined
  const json = JSON.stringify(agent)
  at.agentBytes = sizeOf(json)
  at.agentRevision = at.next
  // A starting state is held to how many values a page may keep, as every other change is
  if (put && at.keys > LIMITS.storeKeys) tooMany()
  // Each half was within the limit by itself. Together they may not be, and a state over the
  // limit could never be changed again: the publish is refused, and nothing of it is kept.
  if (wholeBytes(at.agentBytes, at.keys, at.keptBytes) > LIMITS.stateBytes)
    fail('limit', `The starting state and what the page has stored for itself are together more than ${LIMITS.stateBytes / 1024} KB.`)
  await put?.write()
  if (s) await ctx.db.patch(s._id, { json, revision: at.next })
  else await ctx.db.insert('states', { artifactId, userId, json, revision: at.next })
  await noteStanding(ctx, at)
}

/**
 * The revision a page's state is at, as `revisionFrom` reads it. A page with no state at all is
 * at revision 0, which is where the script in a page starts counting too.
 */
export async function revisionNow(ctx: QueryCtx | MutationCtx, artifactId: Id<'artifacts'>): Promise<number> {
  return revisionFrom(await revisionRecord(ctx, artifactId), () => stateRecord(ctx, artifactId))
}

/** Removes every value a page keeps for itself, a batch at a time, for a page that is going. True when there may be more. */
export async function forgetKept(ctx: MutationCtx, artifactId: Id<'artifacts'>, most: number): Promise<boolean> {
  const rows = await ctx.db
    .query('stored')
    .withIndex('by_artifact_key', (q) => q.eq('artifactId', artifactId))
    .take(most)
  for (const row of rows) await ctx.db.delete(row._id)
  return rows.length === most
}

/** Refuses names of what a page keeps that a page could never store under. */
function namesTheKept(given: State): void {
  for (const key of Object.keys(given))
    if (!isStoreKey(key)) fail('invalid', `"${STORE_KEY}" holds what the page keeps for itself, under names of 1 to 64 letters, digits, dashes or underscores.`)
}
/**
 * Refuses what an agent says, in a patch or a starting state, that the page keeps for itself,
 * unless it is what a page could keep: an object of values under names a page may store under,
 * or null, which takes all of it away. Where it is all the page is to keep (`whole`), as in a
 * starting state, it is held to how many values a page may keep as well, before anything of the
 * page is sent. A patch is not: it may name values that are not there, to take them away.
 */
export function checkKept(given: unknown, whole = false): void {
  if (given === null) return
  if (!isObject(given)) fail('invalid', `"${STORE_KEY}" holds what the page keeps for itself: an object of its values by name, or null to take them all away.`)
  namesTheKept(given)
  if (whole && Object.keys(given).length > LIMITS.storeKeys) tooMany()
}

/** An agent changes a page's state: a merge by default, a replacement when asked. Never republishes anything. */
export const patch = mutation({
  args: { slug: v.string(), /** JSON text of an object. */ patch: v.string(), replace: v.optional(v.boolean()), baseRevision: v.optional(v.number()) },
  handler: async (ctx, { slug, patch, replace, baseRevision }) => {
    const { user } = await requireMachine(ctx)
    await rateLimit(ctx, 'patchState', user._id)
    const a = await resolveArtifact(ctx, user._id, { slug })
    if (patch.length > LIMITS.stateBytes * 2) fail('limit', 'That patch is too large.')
    const change = parseJson(patch)
    if (!isObject(change)) fail('invalid', 'A patch is a JSON object.')
    // What it says under `_page` is what the page keeps for itself: merged into it value by
    // value, or, replacing the state, put in place of it. `null` there takes all of it away,
    // and a replacement that does not name it leaves the page keeping nothing
    const { agent, inside } = split(patch)
    const named = Object.hasOwn(change, STORE_KEY)
    if (named) checkKept(change[STORE_KEY])
    const kept: KeptChange | undefined =
      replace || (named && change[STORE_KEY] === null) ? { replace: inside ?? {} } : named ? { merge: inside ?? {} } : undefined
    return write(ctx, user._id, a._id, (current) => (replace ? agent : deepMerge(current, agent)), { baseRevision, kept })
  },
})

/** Reads what a page sent to keep, as names and JSON text: each a name a page may store under, each value JSON of no more than a stored value may be. */
function toKeep(entries: { key: string; value: string }[]): Map<string, string | null> {
  if (entries.length === 0 || entries.length > LIMITS.storeKeysAtOnce) fail('invalid', `One write keeps 1 to ${LIMITS.storeKeysAtOnce} values.`)
  const changes = new Map<string, string | null>()
  let total = 0
  for (const { key, value } of entries) {
    if (!isStoreKey(key)) fail('invalid', 'A store key is 1 to 64 letters, digits, dashes or underscores.')
    const bytes = sizeOf(value)
    if (bytes > LIMITS.storeValueBytes) fail('limit', `A stored value is at most ${LIMITS.storeValueBytes / 1024} KB.`)
    // What one write sets can never be more than a whole state may hold
    total += bytes
    if (total > LIMITS.stateBytes) fail('limit', `A page's state is at most ${LIMITS.stateBytes / 1024} KB.`)
    const parsed = parseJson(value)
    if (parsed === undefined) fail('invalid', 'A stored value must be JSON.')
    // Written again from what was read, so that what is kept is JSON as JSON writes it
    changes.set(key, parsed === null ? null : JSON.stringify(parsed))
  }
  return changes
}

/**
 * The page keeps values for itself (It.store), several at once: what the page set within a
 * moment of each other, the last value for each name. Each replaces whatever was under its name,
 * and the value `null` takes it away. The page's revision after it is answered.
 */
export const store = mutation({
  args: { artifactId: v.id('artifacts'), changes: v.array(v.object({ key: v.string(), /** JSON text. */ value: v.string() })) },
  handler: async (ctx, { artifactId, changes }) => {
    const { user } = await requireBrowser(ctx)
    const a = await ownArtifact(ctx, user._id, artifactId)
    await rateLimit(ctx, 'storeSetPage', a._id)
    await rateLimit(ctx, 'storeSet', user._id)
    return keep(ctx, user._id, a._id, toKeep(changes))
  },
})

/** The page keeps one value for itself (It.store), as `store` does with one. */
export const storeSet = mutation({
  args: { artifactId: v.id('artifacts'), key: v.string(), /** JSON text. */ value: v.string() },
  handler: async (ctx, { artifactId, key, value }) => {
    const { user } = await requireBrowser(ctx)
    const a = await ownArtifact(ctx, user._id, artifactId)
    await rateLimit(ctx, 'storeSetPage', a._id)
    await rateLimit(ctx, 'storeSet', user._id)
    return keep(ctx, user._id, a._id, toKeep([{ key, value }]))
  },
})
