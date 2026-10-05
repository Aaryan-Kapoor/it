// A notification is the agent speaking to the person outside any one page. It is stored, so it
// survives a reload; it shows as a toast and in a tray; and when the display it is meant for
// does not have the site open, it goes out as a web push (push.ts).
import { LIMITS } from '@it/protocol'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { type MutationCtx, mutation, query } from './_generated/server'
import { record } from './actions'
import { artifactBySlug, type Browser, displayByKey, findDisplay, requireBrowser, requireMachine } from './lib/authz'
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
    sticky: v.optional(v.boolean()),
    buttons: v.optional(v.array(button)),
  },
  handler: async (ctx, { text, slug, display, sticky, buttons }) => {
    const { user } = await requireMachine(ctx)
    await rateLimit(ctx, 'notify', user._id)
    const clean = text.trim()
    if (!clean || clean.length > LIMITS.notificationText) fail('invalid', `A notification is 1 to ${LIMITS.notificationText} characters.`)
    const artifact = slug ? ((await artifactBySlug(ctx, user._id, slug)) ?? fail('not_found', 'No such page.')) : null
    if (buttons?.length) {
      // A button's press comes back as a click on a page, so it needs a page to belong to
      if (!artifact) fail('invalid', 'Buttons need a page for the answer to come back on. Pass its id.')
      if (buttons.length > LIMITS.notificationButtons) fail('limit', `At most ${LIMITS.notificationButtons} buttons.`)
      for (const b of buttons)
        if (!b.label.trim() || b.label.length > 40 || !/^[A-Za-z0-9_.:-]{1,64}$/.test(b.action))
          fail('invalid', 'A button is a short label and an action name.')
    }
    let displayId: Id<'displays'> | undefined
    if (display) {
      const all = await ctx.db
        .query('displays')
        .withIndex('by_user', (q) => q.eq('userId', user._id))
        .take(50)
      const hit = all.find((d) => (d.name ?? d.generatedName).toLowerCase() === display.trim().toLowerCase())
      displayId = hit?._id ?? fail('not_found', 'No display has that name.', { noSuchDisplay: true })
    }
    const id = await ctx.db.insert('notifications', {
      userId: user._id,
      text: clean,
      artifactId: artifact?._id,
      displayId,
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
    return { id }
  },
})

/** The tray: what this display should show, newest first. */
export const list = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const c = await requireBrowser(ctx)
    const { user } = c
    const display = await findDisplay(ctx, c, key)
    // Read by who it is for, so that what is addressed to another display, or was dismissed,
    // never stands in front of what belongs here: the newest for every display, the newest for
    // this one, and then the newest of the two together.
    const forTarget = (displayId: Id<'displays'> | undefined) =>
      ctx.db
        .query('notifications')
        .withIndex('by_user_target', (q) => q.eq('userId', user._id).eq('displayId', displayId).eq('dismissedAt', undefined))
        .order('desc')
        .take(TRAY)
    const recent = [...(await forTarget(undefined)), ...(display ? await forTarget(display._id) : [])].sort((a, b) => b.createdAt - a.createdAt)
    const slugs = new Map<string, string | null>()
    const out = []
    for (const n of recent) {
      if (out.length >= TRAY) break
      if (n.artifactId && !slugs.has(n.artifactId)) slugs.set(n.artifactId, (await ctx.db.get(n.artifactId))?.slug ?? null)
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
    if (n && n.userId === c.user._id && (!n.displayId || n.displayId === display._id)) out.push(n)
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
    for (const n of mine) if (!n.dismissedAt) await ctx.db.patch(n._id, { dismissedAt: Date.now() })
    return null
  },
})

/** Pressing a notification's button records an ordinary click on its page: one inbox, one set of rules. */
export const answer = mutation({
  args: { id: v.id('notifications'), action: v.string(), displayKey: v.string() },
  handler: async (ctx, { id, action, displayKey }) => {
    const c = await requireBrowser(ctx)
    const { user } = c
    const n = await ctx.db.get(id)
    if (!n || n.userId !== user._id) fail('not_found', 'No such notification.')
    const display = await displayByKey(ctx, c, displayKey)
    // Like the tray it is pressed in, a display answers what is for every display or for itself.
    // This comes before anything is said of the notification: one that is for another display
    // is, to this one, no notification, whatever has become of it.
    if (n.displayId && n.displayId !== display._id) fail('not_found', 'No such notification.')
    if (n.answeredAt) return { actionId: null }
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
    })
    await ctx.db.patch(id, { answeredAt: Date.now(), answer: action, seenAt: n.seenAt ?? Date.now() })
    return { actionId }
  },
})
