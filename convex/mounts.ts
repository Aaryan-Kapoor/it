// Showing a page on a display. Each showing is a mount, and is given exactly one ticket. The
// site puts the ticket in the address of the frame it shows the page in, and the content
// service trades it there for a path nobody can guess, under which that showing's files are
// served. A ticket works once, so the address it was in opens nothing a second time.
import { AUDIENCE } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import { action, internalMutation, mutation } from './_generated/server'
import { prefixOf } from './artifacts'
import { displayByKey, ownArtifact, requireBrowser, speaksFor } from './lib/authz'
import { overClashes } from './lib/clash'
import { counted } from './lib/counted'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'
import { log } from './lib/log'
import { mint } from './lib/signing'

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** How long the site has to ask for a showing's ticket. */
const TICKET_MS = 120_000
/** A page a display shows within this long of an agent asking that display for it is shown at the agent's asking. */
const ASKED_MS = 60_000

export const create = mutation({
  // `picture`: the showing is a card's live preview on the grid, and not the page opened. The
  // site sends it only where `TAKES.pictures` is named, so a call without it is today's call
  args: { artifactId: v.id('artifacts'), displayKey: v.string(), picture: v.optional(v.boolean()) },
  handler: async (ctx, { artifactId, displayKey, picture }) => {
    const c = await requireBrowser(ctx)
    const { user } = c
    // Opening a page is counted against the person, as it always was. A preview is counted
    // against the display it is on, under a limit of its own, so that one screen's grid stands
    // in the way of neither another screen's grid nor of any page being opened
    if (!picture) await rateLimit(ctx, 'mount', user._id)
    const shownOn = picture ? await displayByKey(ctx, c, displayKey) : null
    if (shownOn) await rateLimit(ctx, 'picture', shownOn._id)
    const artifact = await ownArtifact(ctx, user._id, artifactId)
    if (artifact.currentVersion === undefined) fail('not_found', 'That page has nothing published yet.')
    const display = shownOn ?? (await displayByKey(ctx, c, displayKey))
    // A display locked to a page shows that page and no other, whatever site asks. Nor does it
    // show a grid, and so it is given no preview of any page, the one it is locked to included
    if (display.lockedTo && (picture || display.lockedTo.artifactId !== artifactId)) {
      log('mount.refused', { userId: user._id, displayId: display._id, reason: picture ? 'locked_preview' : 'locked' }, 'warn')
      fail('forbidden', picture ? 'A display locked to a page shows no previews.' : 'This display is locked to another page.', { locked: true })
    }
    // An id nobody has used before, for every showing, always
    const mountId = hex(crypto.getRandomValues(new Uint8Array(16)))
    await ctx.db.insert('mounts', {
      userId: user._id,
      displayId: display._id,
      artifactId,
      version: artifact.currentVersion,
      mountId,
      createdAt: Date.now(),
      ticketGiven: false,
      epoch: display.epoch,
      ...(picture ? { picture: true as const } : {}),
    })
    // Counted: that a page was shown, on what kind of screen, and whether an agent had just asked
    // this display for it or the person opened it. A card's preview on the grid is no page shown
    const asked = display.showing?.artifactId === artifactId && Date.now() - display.showing.at < ASKED_MS
    if (!picture) await counted(ctx, 'page.shown', { screen: display.screen ?? 'computer', by: asked ? 'agent' : 'person' })
    return { mountId, version: artifact.currentVersion }
  },
})

export const _take = internalMutation({
  args: { mountId: v.string() },
  handler: async (ctx, { mountId }) => {
    const c = await requireBrowser(ctx)
    const { user } = c
    const m = await ctx.db
      .query('mounts')
      .withIndex('by_mount', (q) => q.eq('mountId', mountId))
      .unique()
    // One ticket per mount, only for the person it was made for, and only while it is fresh
    if (!m || m.userId !== user._id || m.ticketGiven || Date.now() - m.createdAt > TICKET_MS) {
      // The site asks once, at once. A second asking, a late one, or one for a showing that is not
      // this person's is something else asking
      log(
        'ticket.not_given',
        { userId: user._id, reason: !m ? 'no_such_showing' : m.userId !== user._id ? 'not_theirs' : m.ticketGiven ? 'already_given' : 'too_late' },
        'warn',
      )
      fail('conflict', 'No ticket is available for that.')
    }
    const display = await ctx.db.get(m.displayId)
    if (!display) fail('conflict', 'That display is not registered.')
    // A screen is given the ticket only of a showing on itself
    if (!speaksFor(c, display)) {
      log('ticket.not_given', { userId: user._id, displayId: display._id, reason: 'another_display' }, 'warn')
      fail('conflict', 'No ticket is available for that.')
    }
    // The display was signed out after this mount was made: what was asked for before the
    // sign-out gets nothing after it
    if (m.epoch !== display.epoch) {
      log('ticket.not_given', { userId: user._id, displayId: display._id, reason: 'signed_out_since' }, 'warn')
      fail('conflict', 'No ticket is available for that.')
    }
    // Locked since this mount was made, to another page, or made as a preview, which a locked
    // display shows none of: what was asked for before the lock gets nothing after it
    if (display.lockedTo && (m.picture === true || display.lockedTo.artifactId !== m.artifactId)) {
      log('ticket.not_given', { userId: user._id, displayId: display._id, reason: 'locked' }, 'warn')
      fail('conflict', 'No ticket is available for that.')
    }
    const artifact = await ctx.db.get(m.artifactId)
    if (!artifact) fail('conflict', 'That page is gone.')
    await ctx.db.patch(m._id, { ticketGiven: true })
    return {
      m: mountId,
      a: m.artifactId as string,
      s: artifact.slug,
      v: String(m.version),
      u: user._id as string,
      d: display._id as string,
      e: display.epoch,
      p: prefixOf(user._id, m.artifactId, m.version),
    }
  },
})

/** The one ticket for a mount. The site puts it in the address of the frame it shows the page in. */
export const ticket = action({
  args: { mountId: v.string() },
  handler: async (ctx, { mountId }): Promise<{ ticket: string }> => {
    const claims = await overClashes(() => ctx.runMutation(internal.mounts._take, { mountId }))
    return { ticket: await mint(ctx, AUDIENCE.ticket, mountId, claims, 60) }
  },
})
