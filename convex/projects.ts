// A project is the repository or folder an agent was working in when it made a page. The one
// thing a person decides for a project is whether a conversation that has been closed may be
// reopened when they use one of its pages. Reopening runs their agent on their machine while
// they are away from it, so it is theirs alone to allow: from a browser paired as their own,
// and never by a machine, which is to say never by an agent.
import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireOwner } from './lib/authz'
import { fail } from './lib/errors'

/** Every project the person's pages were made in, with whether a closed conversation may be reopened for it. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireOwner(ctx)
    const all = await ctx.db
      .query('projects')
      .withIndex('by_user_key', (q) => q.eq('userId', user._id))
      .collect()
    return all.map((p) => ({ id: p._id, name: p.name, wake: p.wake === true })).sort((a, b) => a.name.localeCompare(b.name))
  },
})

/** Allows, or stops allowing, a closed conversation to be reopened for what is done on a project's pages. */
export const setWake = mutation({
  args: { projectId: v.id('projects'), wake: v.boolean() },
  handler: async (ctx, { projectId, wake }) => {
    const { user } = await requireOwner(ctx)
    const project = await ctx.db.get(projectId)
    if (!project || project.userId !== user._id) fail('not_found', 'No such project.')
    await ctx.db.patch(projectId, { wake })
    return null
  },
})
