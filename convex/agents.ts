// Project agents, an experiment: an agent the person starts from the site in a folder on one of
// their machines, with an agent app that is installed and connected there, and which keeps its
// conversation open from turn to turn. The person says what they want of it here (running or
// stopped, and what to tell it), and the connector on that machine does it and says how it
// stands. A machine offers nothing of this until someone at it has run `it agents on`, and it
// runs an agent only in a folder it named itself: nothing here can name a folder for it.
import { AGENT_APPS, AGENT_STATES, AGENTS, wakesOn } from '@it/protocol'
import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { ownAgent, ownMachine, requireMachine, requireOwner } from './lib/authz'
import { fail } from './lib/errors'
import { quota, rateLimit } from './lib/limits'
import { log } from './lib/log'

/** Whether an agent app is connected on a machine, as the person chose it and as the machine last found it. */
const connectedOn = (m: Doc<'machines'>, app: string) =>
  (m.wanted ?? []).includes(app) && (m.harnesses ?? []).some((h) => h.id === app && (h.addon === 'connected' || h.addon === 'needs_approval'))

/** The apps an agent may be started with on a machine: the ones It can keep a conversation open with, that are connected there. */
const appsOn = (m: Doc<'machines'>) => (wakesOn(m.system) ? AGENT_APPS.filter((app) => connectedOn(m, app)) : [])

/** What a machine offers, or the refusal that says it offers nothing. */
function offerOf(m: Doc<'machines'>): NonNullable<Doc<'machines'>['agents']> {
  if (m.revoked) fail('not_found', 'No such machine.')
  return m.agents ?? fail('invalid', `${m.name} does not offer project agents. Run \`it agents on\` on that machine to try them.`)
}

/** Refuses an app that cannot be started on a machine, with why. */
function mayRun(m: Doc<'machines'>, app: string): void {
  if (!(AGENT_APPS as readonly string[]).includes(app)) fail('invalid', 'It cannot start an agent with that agent app.')
  if (!wakesOn(m.system)) fail('invalid', 'It starts project agents only on Linux and macOS machines.')
  if (!connectedOn(m, app)) fail('invalid', 'Connect that agent app on that machine before starting an agent with it.')
}

/** Refuses where a machine already runs as many agents as it said it may, leaving out the one being started again. */
async function roomOn(ctx: MutationCtx, m: Doc<'machines'>, most: number, but?: Id<'agents'>): Promise<void> {
  const there = await ctx.db
    .query('agents')
    .withIndex('by_machine', (q) => q.eq('machineId', m._id))
    .take(AGENTS.perPerson + 1)
  if (there.filter((a) => a.want === 'run' && a._id !== but).length >= most)
    fail('limit', `${m.name} runs at most ${most} agents at once. Stop one of them first.`)
}

/** A message as it is kept: without the space around it, and refused where it is too long. */
function messageOf(text: string): string {
  const clean = text.trim()
  if (clean.length > AGENTS.messageText) fail('invalid', `A message to an agent is at most ${AGENTS.messageText} characters.`)
  return clean
}

/** The messages that wait for an agent, oldest first. */
const waitingFor = (ctx: QueryCtx | MutationCtx, agentId: Id<'agents'>) =>
  ctx.db
    .query('agentMessages')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .take(AGENTS.waiting + 1)

const view = (a: Doc<'agents'>, waiting: number) => ({
  id: a._id,
  machineId: a.machineId,
  project: a.project,
  name: a.name,
  where: a.where,
  app: a.app,
  want: a.want,
  state: a.state,
  why: a.why ?? null,
  session: a.session ?? null,
  said: a.said ?? null,
  createdAt: a.createdAt,
  changedAt: a.changedAt,
  waiting,
})

/**
 * The person's project agents, and the machines that offer to start one, with the folders and
 * agent apps each offers. Shown only in a browser paired as the owner's, as machines are.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireOwner(ctx)
    const machines = await ctx.db
      .query('machines')
      .withIndex('by_user', (q) => q.eq('userId', user._id).eq('revoked', false))
      .take(25)
    const agents = await ctx.db
      .query('agents')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .take(AGENTS.perPerson)
    const shown = []
    for (const a of agents) {
      // An agent is shown with its machine, by which the site tells whether it is there; one whose machine is gone is not shown
      const m = machines.find((x) => x._id === a.machineId)
      if (m)
        shown.push({
          ...view(a, (await waitingFor(ctx, a._id)).length),
          machine: { name: m.name, lastSeenAt: m.lastSeenAt, off: m.offAt !== undefined, connectorVersion: m.connectorVersion ?? null },
        })
    }
    return {
      machines: machines
        .filter((m) => m.agents)
        .map((m) => ({
          id: m._id,
          name: m.name,
          lastSeenAt: m.lastSeenAt,
          off: m.offAt !== undefined,
          connectorVersion: m.connectorVersion ?? null,
          most: m.agents!.most,
          projects: m.agents!.projects,
          apps: appsOn(m),
        })),
      agents: shown.sort((a, b) => b.createdAt - a.createdAt),
    }
  },
})

/** The person starts an agent in a folder a machine offers, with an agent app connected there, and may give it something to do first. */
export const start = mutation({
  args: { machineId: v.id('machines'), project: v.string(), app: v.string(), text: v.optional(v.string()) },
  handler: async (ctx, { machineId, project, app, text }) => {
    const { user } = await requireOwner(ctx)
    const m = await ownMachine(ctx, user._id, machineId)
    const offered = offerOf(m)
    const folder = offered.projects.find((p) => p.id === project) ?? fail('not_found', `${m.name} does not offer that folder any more.`)
    mayRun(m, app)
    const first = text === undefined ? '' : messageOf(text)
    const mine = await ctx.db
      .query('agents')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .take(AGENTS.perPerson + 1)
    quota(mine.length, AGENTS.perPerson, 'project agents', user._id)
    await roomOn(ctx, m, offered.most)
    await rateLimit(ctx, 'agents', user._id)
    const now = Date.now()
    const agentId = await ctx.db.insert('agents', {
      userId: user._id,
      machineId: m._id,
      project: folder.id,
      name: folder.name,
      where: folder.where,
      app,
      want: 'run',
      round: 1,
      state: 'starting',
      createdAt: now,
      changedAt: now,
    })
    if (first) await ctx.db.insert('agentMessages', { userId: user._id, agentId, text: first, at: now })
    log('agent.started', { userId: user._id, machineId: m._id, agentId, app })
    return { id: agentId }
  },
})

/** The person sends an agent that is running a message, which its machine hands it when it is next free. */
export const send = mutation({
  args: { agentId: v.id('agents'), text: v.string() },
  handler: async (ctx, { agentId, text }) => {
    const { user } = await requireOwner(ctx)
    const a = await ownAgent(ctx, user._id, agentId)
    if (a.want !== 'run') fail('conflict', 'This agent is stopped. Start it again before sending it anything.')
    const clean = messageOf(text)
    if (!clean) fail('invalid', 'Write something to send.')
    if ((await waitingFor(ctx, a._id)).length >= AGENTS.waiting)
      fail('limit', `${AGENTS.waiting} messages are already waiting for this agent. Send more once it has taken those.`)
    await rateLimit(ctx, 'agents', user._id)
    await ctx.db.insert('agentMessages', { userId: user._id, agentId: a._id, text: clean, at: Date.now() })
    return null
  },
})

/**
 * The person stops an agent. Its machine ends its program, and what was waiting for it goes:
 * it was meant for an agent that is running. Its conversation is kept by its app, and is
 * resumed if the person starts it again.
 */
export const stop = mutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, { agentId }) => {
    const { user } = await requireOwner(ctx)
    const a = await ownAgent(ctx, user._id, agentId)
    if (a.want === 'stop') return null
    // Where it has a program there may be one to end, and the machine says once it has
    const open = a.state === 'starting' || a.state === 'ready' || a.state === 'working'
    await ctx.db.patch(a._id, { want: 'stop', state: open ? 'stopping' : 'stopped', why: undefined, changedAt: Date.now() })
    for (const m of await waitingFor(ctx, a._id)) await ctx.db.delete(m._id)
    log('agent.stopped', { userId: user._id, agentId: a._id, by: 'person' })
    return null
  },
})

/**
 * The person starts an agent again: one that is stopped or failed resumes its conversation, and
 * one that is running is ended and resumed. Only in a folder its machine still offers, with an
 * app still connected there, and within what the machine runs at once.
 */
export const restart = mutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, { agentId }) => {
    const { user } = await requireOwner(ctx)
    const a = await ownAgent(ctx, user._id, agentId)
    const m = await ownMachine(ctx, user._id, a.machineId)
    const offered = offerOf(m)
    if (!offered.projects.some((p) => p.id === a.project)) fail('not_found', `${m.name} does not offer that folder any more.`)
    mayRun(m, a.app)
    await roomOn(ctx, m, offered.most, a._id)
    await rateLimit(ctx, 'agents', user._id)
    await ctx.db.patch(a._id, { want: 'run', round: a.round + 1, state: 'starting', why: undefined, changedAt: Date.now() })
    log('agent.restarted', { userId: user._id, agentId: a._id })
    return null
  },
})

/** The person removes an agent that is stopped from the list. Its conversation is still kept by its app, and nothing of it is kept here. */
export const forget = mutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, { agentId }) => {
    const { user } = await requireOwner(ctx)
    const a = await ownAgent(ctx, user._id, agentId)
    if (a.want !== 'stop') fail('conflict', 'Stop this agent before removing it.')
    for (const m of await waitingFor(ctx, a._id)) await ctx.db.delete(m._id)
    await ctx.db.delete(a._id)
    return null
  },
})

/** Ends every agent of a machine and forgets it, with what waits for it: the machine was revoked, and nothing it ran is kept. */
export async function forgetAgentsOf(ctx: MutationCtx, machineId: Id<'machines'>): Promise<number> {
  const there = await ctx.db
    .query('agents')
    .withIndex('by_machine', (q) => q.eq('machineId', machineId))
    .take(AGENTS.perPerson + 1)
  for (const a of there) {
    for (const m of await waitingFor(ctx, a._id)) await ctx.db.delete(m._id)
    await ctx.db.delete(a._id)
  }
  return there.length
}

/**
 * What the connector on a machine is to do: its agents, with what the person wants of each and
 * what waits for each. It subscribes to this. An agent that is not listed is not to run.
 */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const { machine } = await requireMachine(ctx)
    const there = await ctx.db
      .query('agents')
      .withIndex('by_machine', (q) => q.eq('machineId', machine._id))
      .take(AGENTS.perPerson)
    const agents = []
    for (const a of there)
      agents.push({
        id: a._id,
        project: a.project,
        app: a.app,
        want: a.want,
        round: a.round,
        state: a.state,
        session: a.session ?? null,
        messages: a.want === 'run' ? (await waitingFor(ctx, a._id)).slice(0, AGENTS.waiting).map((m) => ({ id: m._id, text: m.text })) : [],
      })
    return { agents }
  },
})

const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The machine says which folders it offers to start an agent in and how many may run there at
 * once, or, with nothing, that it offers none: someone at it turned the experiment off. An agent
 * in a folder it no longer offers is stopped, and says why.
 */
export const offer = mutation({
  args: {
    offer: v.union(v.null(), v.object({ most: v.number(), projects: v.array(v.object({ id: v.string(), name: v.string(), where: v.string() })) })),
  },
  handler: async (ctx, { offer }) => {
    const { machine } = await requireMachine(ctx)
    const kept = offer
      ? {
          most: Math.max(1, Math.min(AGENTS.mostAllowed, Math.floor(Number.isFinite(offer.most) ? offer.most : AGENTS.most))),
          projects: offer.projects
            .filter((p) => PROJECT_ID.test(p.id))
            .slice(0, AGENTS.projects)
            .map((p) => ({ id: p.id, name: p.name.slice(0, 120), where: p.where.slice(0, 300) })),
        }
      : undefined
    if (JSON.stringify(kept) !== JSON.stringify(machine.agents)) await ctx.db.patch(machine._id, { agents: kept })
    const there = await ctx.db
      .query('agents')
      .withIndex('by_machine', (q) => q.eq('machineId', machine._id))
      .take(AGENTS.perPerson + 1)
    for (const a of there) {
      if (a.want !== 'run' || kept?.projects.some((p) => p.id === a.project)) continue
      const why = kept ? `${machine.name} does not offer this folder any more.` : `Project agents were turned off on ${machine.name}.`
      await ctx.db.patch(a._id, { want: 'stop', state: 'stopped', why, changedAt: Date.now() })
      for (const m of await waitingFor(ctx, a._id)) await ctx.db.delete(m._id)
      log('agent.stopped', { userId: machine.userId, agentId: a._id, by: kept ? 'folder_withdrawn' : 'turned_off' })
    }
    return null
  },
})

/**
 * The machine says how one of its agents stands: its state, why where it could not run, the
 * conversation it is once its app has made one, and what it last said. What is said of an
 * earlier round, from before the person started it again, is not about it as it is now. The
 * answer says whether the agent is still there, and what the person wants of it.
 */
export const report = mutation({
  args: {
    agentId: v.id('agents'),
    round: v.number(),
    state: v.string(),
    why: v.optional(v.string()),
    session: v.optional(v.string()),
    said: v.optional(v.string()),
  },
  handler: async (ctx, { agentId, round, state, why, session, said }) => {
    const { machine } = await requireMachine(ctx)
    const a = await ctx.db.get(agentId)
    if (!a || a.machineId !== machine._id) return { gone: true }
    if (round !== a.round) return { gone: false, want: a.want, stale: true }
    if (!(AGENT_STATES as readonly string[]).includes(state)) fail('invalid', 'That is not a state an agent can be in.')
    if (session !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(session)) fail('invalid', 'That is not a conversation id.')
    const now = Date.now()
    await ctx.db.patch(a._id, {
      state,
      // Why it was stopped, where It knows, is kept when its machine says it has stopped it
      why: why ? why.slice(0, AGENTS.whyText) : state === 'stopped' && a.want === 'stop' ? a.why : undefined,
      ...(session !== undefined ? { session } : {}),
      ...(said ? { said: { text: said.slice(0, AGENTS.saidText), at: now } } : {}),
      changedAt: now,
    })
    if (state === 'failed') log('agent.failed', { userId: machine.userId, agentId: a._id })
    return { gone: false, want: a.want }
  },
})

/** The machine has handed these messages to their agent: they are not kept any longer. */
export const taken = mutation({
  args: { agentId: v.id('agents'), ids: v.array(v.id('agentMessages')) },
  handler: async (ctx, { agentId, ids }) => {
    const { machine } = await requireMachine(ctx)
    const a = await ctx.db.get(agentId)
    if (!a || a.machineId !== machine._id) return null
    for (const id of ids.slice(0, AGENTS.waiting)) {
      const m = await ctx.db.get(id)
      if (m && m.agentId === a._id) await ctx.db.delete(m._id)
    }
    return null
  },
})
