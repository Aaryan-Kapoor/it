// A line that is written only if the transaction that asked for it is kept. A mutation that
// writes something down and then fails has still written it down, though nothing else it did
// was kept; where that would let a caller write a line at will, the line is asked for through
// the scheduler instead, which forgets what a failed mutation asked of it.
import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { log } from './lib/log'

/**
 * That a limit was reached, and by whom, read from the limit's own count (lib/limits.ts). Who
 * it was is the backend's own id for them. Enrolling is counted against the person's subject,
 * which may come before there is an id of ours for them, and that is not written down. A count
 * that has gone by now went with whoever it was kept for, and nothing is said of it.
 */
export const limitReached = internalMutation({
  args: { limit: v.id('rateLimits') },
  handler: async (ctx, { limit }) => {
    const count = await ctx.db.get(limit)
    if (!count) return null
    const rule = count.key.slice(0, count.key.indexOf(':'))
    log('limit.reached', { rule, ...(rule === 'enroll' ? {} : { who: count.who }) }, 'warn')
    return null
  },
})
