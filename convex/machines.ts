import { ALIVE, HARNESSES, LIMITS, newer, noWakeHere, QUOTA, UPGRADE_MS, WAKES, wakesOn } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { internalMutation, mutation, query } from './_generated/server'
import { stoppedSince } from './actions'
import { ownMachine, requireMachine, requireOwner } from './lib/authz'
import { fail } from './lib/errors'
import { log } from './lib/log'
import { session } from './schema'
import { lineOf, pairedOf, revokeMachine } from './sessions'

const view = (m: Doc<'machines'>) => ({
  id: m._id,
  name: m.name,
  lastSeenAt: m.lastSeenAt,
  connectorVersion: m.connectorVersion ?? null,
  system: m.system ?? null,
  // Why it hands nothing to an agent for now, though it is there: 'unfit' where it and this It are of versions that do not work together, 'unchecked' where it has not yet been able to ask
  paused: m.paused ?? null,
  off: m.offAt !== undefined,
  latest: m.latest ?? null,
  upgrade: m.upgrade ?? null,
  harnesses: m.harnesses ?? [],
  wanted: m.wanted ?? [],
  // Only where It reopens conversations at all: what was switched on for a machine of another system says nothing
  wakes: wakesOn(m.system) ? (m.wakes ?? []) : [],
  runs: m.runs ?? [],
})

/**
 * The person's machines. Shown, and changed, only in the owner's browser. Beside each is what
 * revoking it would take along: how many paired browsers descend from it, whether the browser
 * that asks is one of them, and how many machines. `runsIt` says that the machine was enrolled
 * by the service itself and with nobody's code: it is the machine It runs on.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const { user, session } = await requireOwner(ctx)
    const all = await ctx.db
      .query('machines')
      .withIndex('by_user', (q) => q.eq('userId', user._id).eq('revoked', false))
      .take(QUOTA.machines)
    const paired = await pairedOf(ctx, user._id)
    return all.map((m) => {
      // The machine itself, and every machine that enrolled with a code it or one of its own asked for
      const line = lineOf(all, [m._id])
      const browsers = paired.filter((s) => s.byMachine && line.has(s.byMachine))
      return {
        ...view(m),
        runsIt: !m.byMachine && !m.bySession,
        descendants: { browsers: browsers.length, mine: browsers.some((s) => s._id === session._id), machines: line.size - 1 },
      }
    })
  },
})

/** The person revokes a machine. What descends from it goes with it. */
export const revoke = mutation({
  args: { machineId: v.id('machines') },
  handler: async (ctx, { machineId }) => {
    const { user } = await requireOwner(ctx)
    const m = await ownMachine(ctx, user._id, machineId)
    // One that was revoked already has nothing left to end
    if (!m.revoked) await revokeMachine(ctx, m, 'person')
    return null
  },
})

export const rename = mutation({
  args: { machineId: v.id('machines'), name: v.string() },
  handler: async (ctx, { machineId, name }) => {
    const { user } = await requireOwner(ctx)
    const m = await ownMachine(ctx, user._id, machineId)
    const clean = name.trim()
    if (!clean || clean.length > LIMITS.machineName) fail('invalid', `A machine name is 1 to ${LIMITS.machineName} characters.`)
    await ctx.db.patch(m._id, { name: clean })
    return null
  },
})

/** The person ticks or unticks one of the harnesses found on a machine. Two in quick succession each change their own harness, and neither undoes the other. */
export const toggle = mutation({
  args: { machineId: v.id('machines'), harness: v.string(), on: v.boolean() },
  handler: async (ctx, { machineId, harness, on }) => {
    const { user } = await requireOwner(ctx)
    const m = await ownMachine(ctx, user._id, machineId)
    if (!(HARNESSES as readonly string[]).includes(harness)) fail('invalid', 'That is not an agent app It knows.')
    const wanted = new Set(m.wanted ?? [])
    if (on) wanted.add(harness)
    else wanted.delete(harness)
    await ctx.db.patch(m._id, { wanted: [...wanted] })
    return null
  },
})

/**
 * The person says whether a closed conversation of one agent app on a machine is reopened when
 * they use a page it made. Reopening runs their agent there with nobody watching, so it is
 * theirs alone to switch on: from a browser paired as their own, and never by a machine, which
 * is to say never by an agent for itself.
 */
export const wake = mutation({
  args: { machineId: v.id('machines'), harness: v.string(), on: v.boolean() },
  handler: async (ctx, { machineId, harness, on }) => {
    const { user } = await requireOwner(ctx)
    const m = await ownMachine(ctx, user._id, machineId)
    if (!(WAKES as readonly string[]).includes(harness)) fail('invalid', 'It cannot reopen a closed conversation of that agent app.')
    if (on && !wakesOn(m.system)) fail('invalid', noWakeHere(m.system))
    const now = m.wakes ?? []
    const is = now.some((w) => w.harness === harness)
    // Switched on again while it is on, it stays on since when it was: nothing older is let in by asking twice
    if (on && !is) await ctx.db.patch(m._id, { wakes: [...now, { harness, since: Date.now() }] })
    if (!on && is) await ctx.db.patch(m._id, { wakes: now.filter((w) => w.harness !== harness) })
    return null
  },
})

/**
 * The person asks, from a browser of their own, for a machine to be brought to the newest
 * version of It. Nothing in the asking says which version or where from: the machine fetches
 * what the place releases are kept says is newest, and checks it as an install does, so the most
 * that someone in the person's browser can do with this is have a machine update itself.
 *
 * The machine It runs on goes first. Another machine at a newer version than that one would ask
 * for functions the backend there does not have yet.
 */
export const upgrade = mutation({
  args: { machineId: v.id('machines') },
  handler: async (ctx, { machineId }) => {
    const { user } = await requireOwner(ctx)
    const m = await ownMachine(ctx, user._id, machineId)
    if (m.revoked) fail('not_found', 'No such machine.')
    if (!newer(m.latest, m.connectorVersion)) fail('conflict', 'That machine knows of no newer version of It than the one it runs.')
    if (m.byMachine || m.bySession) {
      const all = await ctx.db
        .query('machines')
        .withIndex('by_user', (q) => q.eq('userId', user._id).eq('revoked', false))
        .take(QUOTA.machines)
      const runsIt = all.find((x) => !x.byMachine && !x.bySession)
      if (runsIt && newer(m.latest, runsIt.connectorVersion)) fail('conflict', 'Update the machine It runs on first.', { first: true })
    }
    // Asked for again while it is at work, it is the same asking
    if (m.upgrade?.state === 'working' && Date.now() - m.upgrade.at < UPGRADE_MS) return null
    await ctx.db.patch(m._id, { upgrade: { at: Date.now(), state: 'asked', version: m.latest } })
    log('machine.upgrade_asked', { userId: user._id, machineId: m._id })
    return null
  },
})

/** The machine says how far the upgrade it was asked for has got. Only one that was asked for is spoken of. */
export const upgrading = mutation({
  args: {
    state: v.union(v.literal('working'), v.literal('failed'), v.literal('installed'), v.literal('none')),
    why: v.optional(v.string()),
    version: v.optional(v.string()),
  },
  handler: async (ctx, { state, why, version }) => {
    const { machine } = await requireMachine(ctx)
    if (!machine.upgrade) return null
    if (state === 'none') await ctx.db.patch(machine._id, { upgrade: undefined })
    else
      await ctx.db.patch(machine._id, {
        upgrade: { at: machine.upgrade.at, state, ...(why ? { why: why.slice(0, 300) } : {}), version: (version ?? machine.upgrade.version)?.slice(0, 40) },
      })
    return null
  },
})

/** How many conversations a machine may say it is running at once. Its connector runs only a few commands at a time. */
const RUNS_MOST = 20

/** The machine says that it has reopened a conversation, which is running from now until it says otherwise. */
export const runBegan = mutation({
  /** `run` names this run among all there have been of the conversation, so that the ending of an earlier one, told late, does not take this one's place away. */
  args: { for: session, run: v.optional(v.string()), ids: v.optional(v.array(v.string())) },
  handler: async (ctx, { for: s, run, ids }) => {
    const { machine } = await requireMachine(ctx)
    // What it is reopened for may have been stopped while the machine was getting ready: a
    // person who pressed Stop beside a run that was only still listed stopped that, and
    // dropped what was waiting, this run's clicks among it. Looked at in the same step that
    // would say the run is on, so that a stop falls before it and is seen here, or after it
    // and is told to the machine as this run's own.
    // A click that is no longer there, or whose page is not, is not there to be reopened for
    // either: its page was deleted meanwhile, and what the stop said of it went with it.
    for (const id of ids ?? []) {
      const actionId = ctx.db.normalizeId('actions', id)
      const x = actionId ? await ctx.db.get(actionId) : null
      if (!x || x.userId !== machine.userId || !(await ctx.db.get(x.artifactId))) return { stopped: true }
      if (x.route === 'stopped' || (await stoppedSince(ctx, x))) return { stopped: true }
    }
    // And reopening may have been switched off for this app since the machine last heard: it
    // is asked here, where it is kept, and not only of what the machine remembers of it. (A
    // connector that names no clicks is one from before this was asked, and is taken at its word)
    if (ids !== undefined && !(wakesOn(machine.system) && (machine.wakes ?? []).some((w) => w.harness === s.harness))) return { stopped: false, off: true }
    const others = (machine.runs ?? []).filter((r) => r.harness !== s.harness || r.sessionId !== s.id)
    await ctx.db.patch(machine._id, {
      runs: [...others, { harness: s.harness.slice(0, 40), sessionId: s.id.slice(0, 200), since: Date.now(), ...(run ? { run: run.slice(0, 64) } : {}) }].slice(
        -RUNS_MOST,
      ),
    })
    return { stopped: false }
  },
})

/**
 * And that the conversation it reopened has ended. With none named, that nothing it reopened is
 * running, which is so when its connector starts. Where it ran, anything said earlier of why it
 * could not be reopened is taken back.
 */
export const runEnded = mutation({
  args: { for: v.optional(session), ok: v.optional(v.boolean()), run: v.optional(v.string()) },
  handler: async (ctx, { for: s, ok, run }) => {
    const { machine } = await requireMachine(ctx)
    const now = machine.runs ?? []
    // Only the run that is named is over: another of the same conversation that has begun since
    // stays as it is. An ending that names none is of a run that was begun with no name, as an
    // earlier It begins them, and never of one that has a name.
    const left = s ? now.filter((r) => r.harness !== s.harness || r.sessionId !== s.id || r.run !== run) : []
    const fails = machine.fails ?? []
    const stillFailed = s && ok ? fails.filter((f) => f.harness !== s.harness || f.sessionId !== s.id) : fails
    if (left.length !== now.length || stillFailed.length !== fails.length) await ctx.db.patch(machine._id, { runs: left, fails: stillFailed })
    return null
  },
})

/** The machine says that a conversation could not be reopened, and why, in its connector's own words: the page then says so to the person. */
export const wakeFailed = mutation({
  args: { for: session, why: v.string() },
  handler: async (ctx, { for: s, why }) => {
    const { machine } = await requireMachine(ctx)
    const others = (machine.fails ?? []).filter((f) => f.harness !== s.harness || f.sessionId !== s.id)
    await ctx.db.patch(machine._id, {
      fails: [...others, { harness: s.harness.slice(0, 40), sessionId: s.id.slice(0, 200), at: Date.now(), why: why.slice(0, 300) }].slice(-RUNS_MOST),
    })
    return null
  },
})

/** Which harnesses are to be connected, chosen on the machine itself by `it setup`. */
export const choose = mutation({
  args: { harnesses: v.array(v.string()) },
  handler: async (ctx, { harnesses }) => {
    const { machine } = await requireMachine(ctx)
    const known = harnesses.filter((h) => (HARNESSES as readonly string[]).includes(h))
    await ctx.db.patch(machine._id, { wanted: [...new Set(known)] })
    return null
  },
})

/** The machine gives up its own access. Its key is useless from here on, and what descends from it goes with it, as when the person revokes it. */
export const leave = mutation({
  args: {},
  handler: async (ctx) => {
    const { machine } = await requireMachine(ctx)
    await revokeMachine(ctx, machine, 'itself')
    return null
  },
})

/** The pages one identity of a computer made go to the identity that replaced it, a batch at a time, and their waiting clicks with them. */
export const inherit = internalMutation({
  args: { from: v.id('machines'), to: v.id('machines'), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { from, to, cursor }) => {
    // The identity these were to go to may itself have been replaced since, more than once:
    // they go to whichever identity of the computer is live now, however many came between
    let heir = await ctx.db.get(to)
    const passed = new Set<string>()
    while (heir?.revoked && heir.replacedBy && !passed.has(heir._id) && passed.size < 100) {
      passed.add(heir._id)
      heir = await ctx.db.get(heir.replacedBy)
    }
    if (!heir || heir.revoked) return null
    const owner = heir.userId
    const batch = await ctx.db
      .query('artifacts')
      .withIndex('by_user_slug', (q) => q.eq('userId', owner))
      .paginate({ cursor: cursor ?? null, numItems: 100 })
    for (const a of batch.page) {
      if (a.machineId !== from) continue
      await ctx.db.patch(a._id, { machineId: heir._id })
      await ctx.scheduler.runAfter(0, internal.actions.readdress, { artifactId: a._id })
    }
    if (!batch.isDone) await ctx.scheduler.runAfter(0, internal.machines.inherit, { from, to: heir._id, cursor: batch.continueCursor })
    return null
  },
})

/** What the connector on this machine should be doing. It subscribes to this. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const { machine } = await requireMachine(ctx)
    return view(machine)
  },
})

/** The harnesses found on a machine, as it reports them, and as they are kept: only the ones It knows, and nothing long. */
const found = v.array(v.object({ id: v.string(), version: v.optional(v.string()), addon: v.string(), detail: v.optional(v.string()) }))
const kept = (harnesses: { id: string; version?: string; addon: string; detail?: string }[]) =>
  harnesses
    .filter((h) => (HARNESSES as readonly string[]).includes(h.id))
    .slice(0, HARNESSES.length)
    .map((h) => ({ id: h.id, version: h.version?.slice(0, 40), addon: h.addon.slice(0, 40), detail: h.detail?.slice(0, 600) }))

/**
 * `it setup` says what it found on the machine, so that the site can show it before a connector
 * has ever run there. It says nothing about a connector: when the machine was last heard from
 * and which connector it runs are the connector's own to say (`report`), and are what the site
 * reads to call a machine online.
 */
export const inventory = mutation({
  args: { harnesses: found },
  handler: async (ctx, { harnesses }) => {
    const { machine } = await requireMachine(ctx)
    const clean = kept(harnesses)
    if (JSON.stringify(machine.harnesses ?? []) !== JSON.stringify(clean)) await ctx.db.patch(machine._id, { harnesses: clean })
    return null
  },
})

/** The connector reports what it found on the machine, and that it is alive. */
export const report = mutation({
  args: { connectorVersion: v.string(), harnesses: found, latest: v.optional(v.string()), system: v.optional(v.string()), paused: v.optional(v.string()) },
  handler: async (ctx, { connectorVersion, harnesses, latest, system, paused }) => {
    const { machine } = await requireMachine(ctx)
    const clean = kept(harnesses)
    // The newest version it has learned of is kept until it learns of another: a report made before it has looked says nothing of it
    const knows = latest === undefined ? machine.latest : latest.slice(0, 40)
    // What it runs on is kept as it last said: a report from a connector that does not say leaves it as it was
    const on = system === undefined ? machine.system : system.slice(0, 20)
    // A connector of another version than the last is what an upgrade that was asked for was for, and ends it
    const moved = machine.connectorVersion !== undefined && machine.connectorVersion !== connectorVersion
    // Whether it hands nothing over for now, and why: said by a connector that says it at
    // all, with an empty word where it is not so. A report that does not say leaves it as it
    // was, as the plainer report does that a connector falls back on for a while after one of
    // its reports was refused, which a moment without a connection is enough for. Only a
    // connector of another version that does not say is taken not to be paused.
    const held = paused === undefined ? (moved ? undefined : machine.paused) : paused ? paused.slice(0, 20) : undefined
    const same =
      JSON.stringify(machine.harnesses ?? []) === JSON.stringify(clean) &&
      machine.connectorVersion === connectorVersion &&
      machine.latest === knows &&
      machine.system === on &&
      machine.paused === held
    // Written each time it says so, less a little for a report that comes a moment early: the
    // site calls a machine off once it has been quiet for a few of these
    if (!same || machine.offAt !== undefined || Date.now() - machine.lastSeenAt > ALIVE.everyMs - 5_000) {
      await ctx.db.patch(machine._id, {
        harnesses: clean,
        connectorVersion: connectorVersion.slice(0, 40),
        lastSeenAt: Date.now(),
        offAt: undefined,
        latest: knows,
        system: on,
        paused: held,
        ...(moved ? { upgrade: undefined } : {}),
      })
    }
    return null
  },
})

/**
 * The connector says that it has been asked to stop. Its machine is off from this moment, so
 * that a click on one of its pages is said to be waiting for the machine, and not for a
 * conversation that is taken to be closed. The next report, from the connector that starts
 * next, undoes it.
 */
export const stopping = mutation({
  args: {},
  handler: async (ctx) => {
    const { machine } = await requireMachine(ctx)
    await ctx.db.patch(machine._id, { offAt: Date.now() })
    return null
  },
})
