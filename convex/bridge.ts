// The database half of the token bridge (the HTTP half is in http.ts), and enrolment. Internal:
// the bridge's own HTTP actions call these after they have checked what was presented, and the
// service that runs the backend calls `enroll` for the machine it runs on.
import { LIMITS, QUOTA } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server'
import { rateLimit } from './lib/limits'
import { log } from './lib/log'
import { invitedBy, inviteFor } from './sessions'

const publicKey = v.object({ kty: v.literal('EC'), crv: v.literal('P-256'), x: v.string(), y: v.string() })
type Key = Doc<'machines'>['publicKey']
const sameKey = (a: Key, b: Key) => a.x === b.x && a.y === b.y
const activeOf = (ctx: MutationCtx, user: Doc<'users'>) =>
  ctx.db
    .query('machines')
    .withIndex('by_user', (q) => q.eq('userId', user._id).eq('revoked', false))
    .take(QUOTA.machines)

/**
 * Records a new machine for a person. Says so when they already have as many as they may.
 * `by` is what asked for the code the machine enrolled with: nothing, for the machine the
 * service enrols for itself.
 */
async function record(
  ctx: MutationCtx,
  user: Doc<'users'>,
  m: { name: string; publicKey: Key; replaces?: string },
  by: Pick<Doc<'machines'>, 'byMachine' | 'bySession'> = {},
) {
  const active = await activeOf(ctx, user)
  // The same key asked for a second time is the same machine: the first answer was lost on
  // its way back, and the machine is asking again
  const same = active.find((x) => sameKey(x.publicKey, m.publicKey))
  if (same) return { machineId: same._id }
  if (active.length >= QUOTA.machines) {
    log('enroll.refused', { userId: user._id, reason: 'machine_quota', have: active.length }, 'warn')
    return { error: 'limit' as const }
  }
  const now = Date.now()
  const machineId = await ctx.db.insert('machines', {
    userId: user._id,
    name: m.name.trim().slice(0, LIMITS.machineName) || 'machine',
    publicKey: m.publicKey,
    revoked: false,
    createdAt: now,
    lastSeenAt: now,
    ...by,
  })
  // The same computer enrolling again: the pages its conversations made, and the clicks
  // waiting on them, go to its new identity. Only from an identity of this same person that
  // has been given up or revoked, so nothing live is ever taken this way.
  const before = m.replaces ? ctx.db.normalizeId('machines', m.replaces) : null
  const old = before ? await ctx.db.get(before) : null
  const inherits = Boolean(old && old.userId === user._id && old.revoked)
  if (old && inherits) {
    await ctx.db.patch(machineId, { replaces: old._id })
    // The old identity is told who took its place: a hand-over still on its way to it, from
    // an identity before it, then goes on to this one
    await ctx.db.patch(old._id, { replacedBy: machineId })
    // And from the identities that one had replaced in its turn: a computer enrolled twice
    // in quick succession may have been replaced before it had taken over what was to be
    // its own, and what it never took over is still with the one before it
    let from: typeof old | null = old
    for (let back = 0; from && from.userId === user._id && from.revoked && back < 5; back++) {
      await ctx.scheduler.runAfter(0, internal.machines.inherit, { from: from._id, to: machineId })
      from = from.replaces ? await ctx.db.get(from.replaces) : null
    }
  }
  // An identity named as the one this replaces, that is not this person's or was never given up, is passed over
  log('machine.enrolled', { userId: user._id, machineId, ...(inherits && old ? { replaces: old._id } : m.replaces ? { replacesIgnored: true } : {}) })
  return { machineId }
}

/**
 * Enrols a machine for the person with this subject. This is how the service that runs the
 * backend enrols the machine it runs on, as `owner`: only the service holds the key that
 * internal functions are called with. The first machine makes the person, since there is
 * nobody before it.
 */
export const enroll = internalMutation({
  args: {
    subject: v.string(),
    name: v.string(),
    publicKey,
    /** The identity this computer had before, if it is enrolling again. */
    replaces: v.optional(v.string()),
  },
  handler: async (ctx, { subject, ...m }) => {
    await rateLimit(ctx, 'enroll', subject)
    let user = await ctx.db
      .query('users')
      .withIndex('by_subject', (q) => q.eq('subject', subject))
      .unique()
    if (user?.deletedAt) {
      log('enroll.refused', { userId: user._id, reason: 'everything_erased' }, 'warn')
      return { error: 'deleted' as const }
    }
    if (!user) user = (await ctx.db.get(await ctx.db.insert('users', { subject, createdAt: Date.now() })))!
    return record(ctx, user, m)
  },
})

/** Enrols another machine, for the person whose invite the code names. The code is used up only if a machine comes of it. */
export const enrollInvited = internalMutation({
  args: { codeHash: v.string(), name: v.string(), publicKey, replaces: v.optional(v.string()) },
  handler: async (ctx, { codeHash, ...m }) => {
    const used = await ctx.db
      .query('invites')
      .withIndex('by_code', (q) => q.eq('codeHash', codeHash))
      .first()
    if (used?.role === 'machine' && used.usedAt !== undefined && used.expiresAt > Date.now()) {
      // The code was used, by this very key: the answer was lost on its way back, and the machine is asking again
      const owner = await ctx.db.get(used.userId)
      const same = owner && !owner.deletedAt ? (await activeOf(ctx, owner)).find((x) => sameKey(x.publicKey, m.publicKey)) : undefined
      if (same) return { machineId: same._id }
    }
    const named = await inviteFor(ctx, codeHash, ['machine'])
    if (!named) return { error: 'code' as const }
    const user = await ctx.db.get(named.userId)
    if (!user || user.deletedAt) return { error: 'deleted' as const }
    await rateLimit(ctx, 'enroll', user.subject)
    const made = await record(ctx, user, m, invitedBy(named))
    if ('machineId' in made) await ctx.db.patch(named._id, { usedAt: Date.now() })
    return made
  },
})

export const machine = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const machineId = ctx.db.normalizeId('machines', id)
    const m = machineId ? await ctx.db.get(machineId) : null
    return m ? { id: m._id, publicKey: m.publicKey, revoked: m.revoked } : null
  },
})

/**
 * Spends a proof's number. 'ok' the first time; ever after, and for one that cannot be spent, why not. The proof's age is judged
 * here, in the same transaction, so a request that stalled cannot spend one whose record has
 * already been cleaned away.
 */
export const spend = internalMutation({
  args: { machineId: v.id('machines'), jti: v.string(), issuedAt: v.number() },
  handler: async (ctx, { machineId, jti, issuedAt }) => {
    // A machine whose record has gone since its proof was read, as it has when everything was
    // erased meanwhile, is counted nowhere: a count under its id would be all that named it
    const m = await ctx.db.get(machineId)
    if (!m) return 'revoked' as const
    await rateLimit(ctx, 'machineToken', machineId)
    if (m.revoked) {
      // It holds its key still, and has proved so: a revoked machine that goes on asking is
      // worth knowing about, once an hour and not each time it asks
      if (Date.now() - (m.refusalSaidAt ?? 0) >= 3_600_000) {
        await ctx.db.patch(m._id, { refusalSaidAt: Date.now() })
        log('token.refused', { machineId: m._id, reason: 'revoked' }, 'warn')
      }
      return 'revoked' as const
    }
    // A proof is good for two minutes around the backend's own clock, which allows a machine's
    // clock to be a minute out either way. Its number is remembered for longer than that.
    const expiresAt = issuedAt * 1000 + 130_000
    if (expiresAt <= Date.now()) return 'too_old' as const
    const key = `${machineId}:${jti}`
    if (
      await ctx.db
        .query('spentProofs')
        .withIndex('by_key', (q) => q.eq('key', key))
        .first()
    )
      return 'already_used' as const
    await ctx.db.insert('spentProofs', { key, expiresAt: expiresAt + 60_000 })
    return 'ok' as const
  },
})
