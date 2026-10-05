// The one place that decides who a caller is and what is theirs. Every public function starts
// here, and anything this does not positively recognise is nobody.
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { issuer } from '../config'
import { fail } from './errors'
import { log } from './log'

type Ctx = QueryCtx | MutationCtx

export type Caller = { kind: 'browser'; user: Doc<'users'>; session: Doc<'sessions'> } | { kind: 'machine'; user: Doc<'users'>; machine: Doc<'machines'> }
export type Browser = Extract<Caller, { kind: 'browser' }>

export async function caller(ctx: Ctx): Promise<Caller | null> {
  const id = await ctx.auth.getUserIdentity()
  // Only a token the backend made itself is believed (auth.config.ts), and it says which kind of caller it was made for
  if (!id || id.issuer !== issuer()) return null
  if (id.kind === 'machine') {
    // A machine is looked up on every call, so revoking it takes effect at once, whatever its
    // token still says.
    const machineId = ctx.db.normalizeId('machines', id.subject)
    const machine = machineId ? await ctx.db.get(machineId) : null
    // A machine still presenting a token after it was revoked, or after everything was erased,
    // is refused like anyone unknown, and written down: its token is good for five minutes yet
    if (machine?.revoked) log('auth.refused', { reason: 'machine_revoked', machineId: machine._id }, 'warn')
    if (!machine || machine.revoked) return null
    const user = await ctx.db.get(machine.userId)
    if (user?.deletedAt) log('auth.refused', { reason: 'everything_erased', machineId: machine._id, userId: user._id }, 'warn')
    if (!user || user.deletedAt) return null
    return { kind: 'machine', user, machine }
  }
  if (id.kind === 'browser') {
    // A browser is the session it was paired into, looked up on every call, so ending the
    // session takes effect at once, whatever its token still says. Not written down: a browser
    // that has just signed out asks once more with every page it had open.
    const sessionId = typeof id.sid === 'string' ? ctx.db.normalizeId('sessions', id.sid) : null
    const session = sessionId ? await ctx.db.get(sessionId) : null
    if (!session || session.endedAt !== undefined || session.userId !== id.subject) return null
    const user = await ctx.db.get(session.userId)
    if (!user || user.deletedAt) return null
    return { kind: 'browser', user, session }
  }
  return null
}

export async function requireCaller(ctx: Ctx): Promise<Caller> {
  return (await caller(ctx)) ?? fail('unauthenticated', 'This browser is not paired with It, or this machine is not enrolled.')
}
export async function requireBrowser(ctx: Ctx): Promise<Browser> {
  const c = await requireCaller(ctx)
  return c.kind === 'browser' ? c : fail('forbidden', 'Only a paired browser can do this.')
}
export async function requireMachine(ctx: Ctx): Promise<Extract<Caller, { kind: 'machine' }>> {
  const c = await requireCaller(ctx)
  return c.kind === 'machine' ? c : fail('forbidden', 'Only an enrolled machine can do this.')
}

// Two kinds of browser. The owner's is one paired with `it site`, on the machine It runs on or
// on a machine that joined it, and may do everything a person can. A screen is another display
// the owner paired: it may show pages and answer them, be a display and name itself, take and
// answer notifications, and sign itself out. Whatever changes what the person has, or says what
// else they have, is the owner's.
const OWNER_ONLY = 'Only a browser paired with `it site` can do this.'

export async function requireOwner(ctx: Ctx): Promise<Browser> {
  const c = await requireBrowser(ctx)
  return c.session.role === 'owner' ? c : fail('forbidden', OWNER_ONLY)
}
/** A machine, or the owner's browser: any caller there is but a paired screen. */
export async function requireMachineOrOwner(ctx: Ctx): Promise<Caller> {
  const c = await requireCaller(ctx)
  return c.kind === 'machine' || c.session.role === 'owner' ? c : fail('forbidden', OWNER_ONLY)
}
/** Whether this browser may act for that display: the owner's may for any, and a screen only for the one its own session registered. */
export const speaksFor = (c: Browser, d: Doc<'displays'>): boolean => c.session.role === 'owner' || d.sessionId === c.session._id

// Ownership. A record that belongs to someone else is reported exactly like one that does not
// exist, so that nothing can be learned by guessing ids. The caller cannot tell the two apart;
// the log can, because asking for another person's record by its id is not a thing the site
// or the CLI ever does.
const others = (userId: Id<'users'>, what: string, record: { _id: string; userId: Id<'users'> } | null): void => {
  if (record && record.userId !== userId) log('access.denied', { userId, what, id: record._id }, 'warn')
}

export async function ownArtifact(ctx: Ctx, userId: Id<'users'>, id: Id<'artifacts'>): Promise<Doc<'artifacts'>> {
  const a = await ctx.db.get(id)
  others(userId, 'page', a)
  return a && a.userId === userId ? a : fail('not_found', 'No such page.')
}
export async function artifactBySlug(ctx: Ctx, userId: Id<'users'>, slug: string): Promise<Doc<'artifacts'> | null> {
  return ctx.db
    .query('artifacts')
    .withIndex('by_user_slug', (q) => q.eq('userId', userId).eq('slug', slug))
    .unique()
}
export async function ownDisplay(ctx: Ctx, userId: Id<'users'>, id: Id<'displays'>): Promise<Doc<'displays'>> {
  const d = await ctx.db.get(id)
  others(userId, 'display', d)
  return d && d.userId === userId ? d : fail('not_found', 'No such display.')
}
/**
 * The display a browser says it is, by the key it keeps, or null. The key only selects: it is
 * no credential, and a screen that names another display's is told there is no such display.
 */
export async function findDisplay(ctx: Ctx, c: Browser, key: string): Promise<Doc<'displays'> | null> {
  const d = await ctx.db
    .query('displays')
    .withIndex('by_user_key', (q) => q.eq('userId', c.user._id).eq('key', key))
    .unique()
  return d && speaksFor(c, d) ? d : null
}
export async function displayByKey(ctx: Ctx, c: Browser, key: string): Promise<Doc<'displays'>> {
  return (await findDisplay(ctx, c, key)) ?? fail('not_found', 'This display is not registered.')
}
export async function ownSession(ctx: Ctx, userId: Id<'users'>, id: Id<'sessions'>): Promise<Doc<'sessions'>> {
  const s = await ctx.db.get(id)
  others(userId, 'session', s)
  return s && s.userId === userId ? s : fail('not_found', 'No such paired browser.')
}
export async function ownMachine(ctx: Ctx, userId: Id<'users'>, id: Id<'machines'>): Promise<Doc<'machines'>> {
  const m = await ctx.db.get(id)
  others(userId, 'machine', m)
  return m && m.userId === userId ? m : fail('not_found', 'No such machine.')
}
