// Rate limits and quotas. A limit is a token bucket kept in a table, taken inside the same
// transaction as the work it guards, so two requests cannot both spend the last token.
import { internal } from '../_generated/api'
import type { MutationCtx } from '../_generated/server'
import { fail } from './errors'
import { log } from './log'

/** perMinute: how fast the bucket refills. burst: how much it holds. */
const RULES = {
  // What a person does on pages. One page gets less than all the person's pages together, so a
  // page that misbehaves cannot use up what every other page needs.
  submitActionPage: { perMinute: 60, burst: 30 },
  submitAction: { perMinute: 120, burst: 60 },
  /** In kilobytes of click data, so that the largest clicks cannot be sent at the fastest rate. */
  actionKilobytes: { perMinute: 512, burst: 4096 },
  storeSetPage: { perMinute: 60, burst: 30 },
  storeSet: { perMinute: 120, burst: 60 },
  mount: { perMinute: 120, burst: 60 },
  publish: { perMinute: 60, burst: 30 },
  finish: { perMinute: 60, burst: 30 },
  patchState: { perMinute: 600, burst: 200 },
  /**
   * In kilobytes of the state as it stands after a write, since every write stores the whole of
   * it again and sends it to every display showing the page. One page gets less than all of them together.
   */
  stateKilobytesPage: { perMinute: 2048, burst: 8192 },
  stateKilobytes: { perMinute: 4096, burst: 16384 },
  /** The same for what a page stores by itself, kept apart so that a page can use up only its own. */
  storeKilobytesPage: { perMinute: 2048, burst: 8192 },
  storeKilobytes: { perMinute: 4096, burst: 16384 },
  notify: { perMinute: 30, burst: 15 },
  show: { perMinute: 60, burst: 30 },
  registerDisplay: { perMinute: 10, burst: 10 },
  enroll: { perMinute: 5, burst: 5 },
  /** Asking for a code to pair a browser, or enrol a machine, with. */
  invite: { perMinute: 10, burst: 10 },
  /** A browser asking for a token for its session. */
  sessionToken: { perMinute: 60, burst: 30 },
  machineToken: { perMinute: 30, burst: 20 },
  export: { perMinute: 2, burst: 2 },
  pushKey: { perMinute: 10, burst: 10 },
  signOut: { perMinute: 20, burst: 10 },
  /** Fetching the token a display keeps for signing out later. Apart from signing out itself, so that one never uses up the other. */
  signOutToken: { perMinute: 30, burst: 30 },
  remove: { perMinute: 120, burst: 60 },
} as const
export type Rule = keyof typeof RULES

export async function rateLimit(ctx: MutationCtx, rule: Rule, who: string, cost = 1): Promise<void> {
  const { perMinute, burst } = RULES[rule]
  const key = `${rule}:${who}`
  const now = Date.now()
  const row = await ctx.db
    .query('rateLimits')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique()
  const tokens = row ? Math.min(burst, row.tokens + ((now - row.updatedAt) / 60_000) * perMinute) : burst
  if (tokens < cost) {
    // Not written down here: a caller past a limit can ask as often as it likes, and each
    // refusal would be a line. It is written down below, when the limit is reached.
    fail('rate_limited', 'Too many requests. Try again shortly.', { retryAfterMs: Math.ceil(((cost - tokens) / perMinute) * 60_000) })
  }
  // The call that leaves too little for another like it is the one that is written down: the
  // next will be refused. Once a minute at most for each limit and each caller, however hard
  // it is pressed, which is why the time of saying so is kept with the count. And only if this
  // call is itself kept: one that goes on to fail gives back what it took, and would say the
  // same again the next time, so the line is left with the scheduler, which a failed call's
  // requests never reach.
  const left = tokens - cost
  const say = left < cost && now - (row?.saidAt ?? 0) >= 60_000
  if (row) await ctx.db.patch(row._id, { who, tokens: left, updatedAt: now, ...(say ? { saidAt: now } : {}) })
  const limit = row?._id ?? (await ctx.db.insert('rateLimits', { key, who, tokens: left, updatedAt: now, ...(say ? { saidAt: now } : {}) }))
  // The line is asked for by the count's own record, which says whose it is: the backend
  // program keeps what a job was started with for days after it has run, and nobody is named there
  if (say) await ctx.scheduler.runAfter(0, internal.logs.limitReached, { limit })
}

/**
 * Removes what was counted against one person, browser, machine or page, under every limit.
 * When its record is erased, so is what was kept under its id here: left alone it would stay
 * until the hourly cleaning found it idle.
 */
export async function forgetCounts(ctx: MutationCtx, who: string): Promise<void> {
  const rows = await ctx.db
    .query('rateLimits')
    .withIndex('by_who', (q) => q.eq('who', who))
    .take(100)
  for (const row of rows) await ctx.db.delete(row._id)
}

/**
 * Whether something that anyone at all can cause, as often as they like, is to be written down
 * this time: once a minute for each such thing, however often it happens. Nothing is counted
 * and nobody is refused, so that it can never stand in the way of whoever is in the right.
 */
export async function saidSeldom(ctx: MutationCtx, what: string): Promise<boolean> {
  const key = `said:${what}`
  const now = Date.now()
  const row = await ctx.db
    .query('rateLimits')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique()
  if (row && now - (row.saidAt ?? 0) < 60_000) return false
  if (row) await ctx.db.patch(row._id, { updatedAt: now, saidAt: now })
  else await ctx.db.insert('rateLimits', { key, tokens: 0, updatedAt: now, saidAt: now })
  return true
}

/** Refuses when the person already has as many of something as there may be. */
export function quota(have: number, max: number, what: string, who?: string): void {
  if (have >= max) log('quota.reached', { what, who, have, max }, 'warn')
  if (have >= max) fail('limit', `It already has the most ${what} it can have (${max}).`)
}
