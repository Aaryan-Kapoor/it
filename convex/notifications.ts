// A notification is the agent speaking to the person outside any one page. It is stored, so it
// survives a reload; it shows as a toast and in a tray; and when the display it is meant for
// does not have the site open, it goes out as a web push (push.ts).
import { LIMITS, MESSAGE } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { madeAt, record } from './actions'
import { aim, nameOf, targetOf } from './lib/aim'
import { artifactBySlug, type Browser, displayByKey, findDisplay, requireBrowser, requireMachine } from './lib/authz'
import { counted } from './lib/counted'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'
import { button } from './schema'
import { revisionNow } from './state'

const LATE_PUSH_MS = 180_000
/** How many notifications a display's tray holds. */
const TRAY = 60

export const send = mutation({
  args: {
    text: v.string(),
    slug: v.optional(v.string()),
    display: v.optional(v.string()),
    displayId: v.optional(v.string()),
    everywhere: v.optional(v.boolean()),
    sticky: v.optional(v.boolean()),
    buttons: v.optional(v.array(button)),
  },
  handler: async (ctx, { text, slug, display, displayId: byId, everywhere, sticky, buttons }) => {
    const { user } = await requireMachine(ctx)
    const target = targetOf({ display, displayId: byId, everywhere })
    await rateLimit(ctx, 'notify', user._id)
    const clean = text.trim()
    if (!clean || clean.length > LIMITS.notificationText) fail('invalid', `A notification is 1 to ${LIMITS.notificationText} characters.`)
    const artifact = slug ? ((await artifactBySlug(ctx, user._id, slug)) ?? fail('not_found', 'No such page.')) : null
    if (buttons?.length) {
      // A button's press comes back as a click on a page, so it needs a page to belong to
      if (!artifact) fail('invalid', 'Buttons need a page for the answer to come back on. Pass its id.')
      if (buttons.length > LIMITS.notificationButtons) fail('limit', `At most ${LIMITS.notificationButtons} buttons.`)
      for (const b of buttons) {
        if (!b.label.trim() || b.label.length > 40 || !/^[A-Za-z0-9_.:-]{1,64}$/.test(b.action))
          fail('invalid', 'A button is a short label and an action name.')
        // Pressing a button records an action of its name, and this name is kept for what a
        // person types above a page: a press would be refused, with the button still offered
        if (b.action === MESSAGE) fail('invalid', `A button may not send an action named ${MESSAGE}, which is what a person types above a page.`)
      }
    }
    // To the display named, by its name or its id, to every display agents may use, or else to
    // the one display the person is most likely using, as a page is shown. Where nothing is open,
    // that is first of all a display that takes notifications, which is how one reaches a closed display
    const aimed = await aim(ctx, user._id, target, { pushed: true })
    // Two displays that came to share a name under an earlier It cannot be told apart by it, and
    // neither is sent it: each has an id of its own. Said without the name, which is the person's
    if ('name' in target && aimed.asked.length > 1)
      fail('conflict', 'More than one display has that name. Send it to one of them by its id, with --on-id; `it displays` lists the ids.', {
        sharedName: true,
      })
    // A display named that cannot take it is sent nothing, and the refusal says why: its pairing
    // ended, or agents may not use it
    if (aimed.to.length === 0 && ('id' in target || 'name' in target))
      fail('forbidden', 'That display takes nothing from agents now.', { notSent: aimed.notShown[0]?.reason ?? 'not_paired' })
    // Where none can take it, nothing is sent either: kept, it would reach the very displays that
    // were left out as soon as one was paired again or opened to agents
    if (aimed.to.length === 0) fail('forbidden', 'No display can take this notification now.', { notSent: 'nowhere' })
    // Sent to every display, it is for the displays that can take it now, and for no display
    // paired later
    const every = 'everywhere' in target
    const displayId: Id<'displays'> | undefined = every ? undefined : aimed.to[0]!._id
    const id = await ctx.db.insert('notifications', {
      userId: user._id,
      text: clean,
      artifactId: artifact?._id,
      displayId,
      ...(every ? { to: aimed.to.map((d) => d._id) } : {}),
      sticky: sticky ?? false,
      buttons: buttons?.length ? buttons : undefined,
      // What the page shows now is what a button of this is about, however much later it is pressed
      ...(artifact && buttons?.length
        ? { contentVersion: artifact.currentVersion ?? 0, stateRevision: await revisionNow(ctx, artifact._id), title: artifact.title }
        : {}),
      createdAt: Date.now(),
    })
    // Pushed now to displays that are closed. A display that was open a moment ago may have just
    // been closed, so a second look a few minutes on pushes to it if nobody has seen this yet.
    await ctx.scheduler.runAfter(0, internal.push.deliver, { notificationId: id })
    await ctx.scheduler.runAfter(LATE_PUSH_MS, internal.push.deliver, { notificationId: id })
    return {
      id,
      displays: aimed.to.map(nameOf),
      displayIds: aimed.to.map((d) => d._id),
      notShown: aimed.notShown,
      ...(aimed.chosen ? { chosen: aimed.chosen } : {}),
    }
  },
})

/**
 * Whether a notification belongs to a display: one sent to it, or one sent to every display that
 * it was among when that was sent. A display that agents may not use is shown none of what went
 * to every display. An earlier It kept no list of who a notification to every display went to:
 * such a one is for each display that was there when it was sent.
 */
export function isFor(n: Doc<'notifications'>, d: Doc<'displays'>): boolean {
  if (n.displayId) return n.displayId === d._id
  if (d.agentsOff) return false
  return n.to ? n.to.includes(d._id) : d.createdAt <= n.createdAt
}

/** How many of what went to every display a tray reads at most, looking for the ones that are for its display. */
const BROADCASTS_READ = 1000

/**
 * The newest of what went to every display that is for this one, up to a tray's worth. What went
 * to every display is kept in one list for all of them, with whom each was for, so the ones for
 * other displays are passed over until a tray's worth is found: a display closed to agents for a
 * while, while many went to the others, still has what was sent to it before. Nothing sent
 * before the display was there can be for it, so the reading stops there, and it never reads
 * more than `BROADCASTS_READ`. A display closed to agents is shown none of it, and reads none.
 */
async function broadcastsFor(ctx: QueryCtx, userId: Id<'users'>, display: Doc<'displays'>): Promise<Doc<'notifications'>[]> {
  if (display.agentsOff) return []
  const out: Doc<'notifications'>[] = []
  let read = 0
  for await (const n of ctx.db
    .query('notifications')
    .withIndex('by_user_target', (q) => q.eq('userId', userId).eq('displayId', undefined).eq('dismissedAt', undefined).gte('createdAt', display.createdAt))
    .order('desc')) {
    if (isFor(n, display)) out.push(n)
    if (out.length >= TRAY || ++read >= BROADCASTS_READ) break
  }
  return out
}

/** The tray: what this display should show, newest first. */
export const list = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const c = await requireBrowser(ctx)
    const { user } = c
    const display = await findDisplay(ctx, c, key)
    // Read by who it is for, so that what is addressed to another display, or was dismissed,
    // never stands in front of what belongs here: the newest for this display, the newest of
    // what went to every display that this one was among, and then the newest of the two together.
    const forThis = display
      ? await ctx.db
          .query('notifications')
          .withIndex('by_user_target', (q) => q.eq('userId', user._id).eq('displayId', display._id).eq('dismissedAt', undefined))
          .order('desc')
          .take(TRAY)
      : []
    const recent = [...(display ? await broadcastsFor(ctx, user._id, display) : []), ...forThis].sort((a, b) => b.createdAt - a.createdAt)
    const slugs = new Map<string, string | null>()
    const out = []
    for (const n of recent) {
      if (out.length >= TRAY) break
      if (display && !isFor(n, display)) continue
      if (!display && n.displayId === undefined) continue
      if (n.artifactId && !slugs.has(n.artifactId)) slugs.set(n.artifactId, (await ctx.db.get(n.artifactId))?.slug ?? null)
      // What was sent about a page that has since been deleted is shown no more. Deleting the
      // page puts away its notices in bounded steps. Until those finish, none offers a
      // button that can answer nothing.
      if (n.artifactId && slugs.get(n.artifactId) === null) continue
      out.push({
        id: n._id,
        text: n.text,
        slug: n.artifactId ? (slugs.get(n.artifactId) ?? null) : null,
        sticky: n.sticky,
        buttons: n.buttons ?? [],
        at: n.createdAt,
        seen: n.seenAt !== undefined,
        answer: n.answer ?? null,
      })
    }
    return out
  },
})

/** The notifications among `ids` that are this person's and belong in this display's tray. */
async function shownOn(ctx: MutationCtx, c: Browser, key: string, ids: Id<'notifications'>[]) {
  const display = await displayByKey(ctx, c, key)
  const out = []
  for (const id of ids.slice(0, 100)) {
    const n = await ctx.db.get(id)
    if (n && n.userId === c.user._id && isFor(n, display)) out.push(n)
  }
  return out
}

/** The person opened the tray on this display. Only what the tray was actually showing is marked: `ids` says what that was. */
export const seen = mutation({
  args: { key: v.string(), ids: v.array(v.id('notifications')) },
  handler: async (ctx, { key, ids }) => {
    for (const n of await shownOn(ctx, await requireBrowser(ctx), key, ids)) if (!n.seenAt) await ctx.db.patch(n._id, { seenAt: Date.now() })
    return null
  },
})

/** Dismisses notifications this display's tray is showing: one, or all of those it shows. */
export const dismiss = mutation({
  args: { key: v.string(), ids: v.array(v.id('notifications')) },
  handler: async (ctx, { key, ids }) => {
    const mine = await shownOn(ctx, await requireBrowser(ctx), key, ids)
    if (ids.length === 1 && mine.length === 0) fail('not_found', 'No such notification.')
    for (const n of mine)
      if (!n.dismissedAt) {
        await ctx.db.patch(n._id, { dismissedAt: Date.now() })
        // Counted where it was put away unanswered: one that was answered has been counted as that
        if (!n.answeredAt) await counted(ctx, 'notification.ended', { how: 'dismissed', pushed: (n.pushedTo?.length ?? 0) > 0 })
      }
    return null
  },
})

/** Pressing a notification's button records an ordinary click on its page: one inbox, one set of rules. */
export const answer = mutation({
  args: {
    id: v.id('notifications'),
    action: v.string(),
    displayKey: v.string(),
    expectedSession: v.optional(v.string()),
    /** When the person pressed it, by the backend's clock as the browser knew it, and how far out that can be (see `madeAt` in actions.ts). */
    madeAt: v.optional(v.number()),
    madeWithin: v.optional(v.number()),
  },
  handler: async (ctx, { id, action, displayKey, expectedSession, madeAt: said, madeWithin }) => {
    const c = await requireBrowser(ctx, expectedSession)
    const { user } = c
    const n = await ctx.db.get(id)
    if (!n || n.userId !== user._id) fail('not_found', 'No such notification.')
    const display = await displayByKey(ctx, c, displayKey)
    // Like the tray it is pressed in, a display answers what is for every display or for itself.
    // This comes before anything is said of the notification: one that is for another display
    // is, to this one, no notification, whatever has become of it.
    if (!isFor(n, display)) fail('not_found', 'No such notification.')
    if (n.answeredAt) return { actionId: null }
    if (expectedSession === undefined)
      fail('conflict', 'Reload It before answering this notification, so the request belongs to your current pairing.', { reload: true })
    // A notification has buttons only where it was sent about a page, and it then says which version and state of the page it was sent about
    if (!n.artifactId || n.contentVersion === undefined || n.stateRevision === undefined || !n.buttons?.some((b) => b.action === action))
      fail('invalid', 'That is not one of its buttons.')
    const artifact = await ctx.db.get(n.artifactId)
    if (!artifact) fail('not_found', 'The page this was about is gone.')
    const { actionId } = await record(ctx, artifact, {
      displayId: display._id,
      clientActionId: `notification:${String(id).replace(/[^A-Za-z0-9_.-]/g, '_')}`,
      name: action,
      payload: JSON.stringify({ notification: n.text }),
      attended: true,
      // The version and the state the notification was sent about, not the ones the page has reached since
      contentVersion: n.contentVersion,
      baseStateRevision: n.stateRevision,
      ...(n.title === undefined ? {} : { title: n.title }),
      madeAt: madeAt(c, said, madeWithin),
    })
    await ctx.db.patch(id, { answeredAt: Date.now(), answer: action, seenAt: n.seenAt ?? Date.now() })
    // Counted: that a notification was answered, from what kind of screen, and whether it had been pushed to a closed one
    await counted(ctx, 'notification.ended', { how: 'answered', pushed: (n.pushedTo?.length ?? 0) > 0 })
    await counted(ctx, 'answer.sent', { screen: display.screen ?? 'computer', from: 'notification' })
    return { actionId }
  },
})
