// Files sent with an action, beside what it carries.
//
// A page puts a file in what an action carries, and the site takes it out and sends it on its
// own, before the action. It asks here for the action's files to be taken, under the id the
// click already has (`prepare`): the files are recorded, declared to the content service, and
// a grant is signed to upload exactly those bytes. The site uploads them through the door, and
// asks again, which finds them there whole. Only then does it send the action, which names the
// record (actions.ts), so that no agent is ever told of a file that has not arrived. Every step
// may be asked again, after a dropped connection or from another tab, and answers as it did,
// or carries on from where it stopped.
//
// The files are kept by the content service, beside the page's versions, and go with their
// action, with their page, or when everything is erased. A machine of the person's reads one
// with a grant signed here (`read`), at the door.
import { AUDIENCE, fileName, fileType, LIMITS, PUBLICATION, QUOTA, RETENTION } from '@it/protocol'
import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { action, internalMutation, internalQuery, type MutationCtx } from './_generated/server'
import { replayAllowed } from './actions'
import { prefixOf } from './artifacts'
import { door } from './config'
import { removeLater } from './content'
import { ownArtifact, requireBrowser, requireMachine } from './lib/authz'
import { overClashes } from './lib/clash'
import { fail } from './lib/errors'
import { rateLimit } from './lib/limits'
import { kind, log } from './lib/log'
import { mint } from './lib/signing'
import { bump, tally } from './lib/tally'

/** Where the content service keeps the files sent with one action: a folder of their own, beside the page's versions. */
export const filesPrefix = (userId: Id<'users'>, artifactId: Id<'artifacts'>, attachmentId: Id<'attachments'>) =>
  `${prefixOf(userId, artifactId)}f${attachmentId}/`
/** What the content service is told of them: each under its number, with its size and checksum. */
const declared = (a: Pick<Doc<'attachments'>, 'files'>) => a.files.map((f, i) => ({ path: String(i + 1), size: f.size, sha256: f.sha256 }))

const asked = v.object({ name: v.string(), type: v.string(), size: v.number(), sha256: v.string() })
const DAY = 86_400_000

/** Records the files of one click, or finds them where they were recorded before. Says which they are, and whether each was there already. */
export const _prepare = internalMutation({
  args: {
    artifactId: v.id('artifacts'),
    clientActionId: v.string(),
    files: v.array(asked),
    replayUntil: v.optional(v.number()),
    expectedSession: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ id: Id<'attachments'>; prefix: string; files: ReturnType<typeof declared>; stored: boolean; fresh: boolean }> => {
    const c = await requireBrowser(ctx, args.expectedSession)
    const artifact = await ownArtifact(ctx, c.user._id, args.artifactId)
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(args.clientActionId)) fail('invalid', 'That is not an action id.')
    // Each asking, the first or a later one, is counted: a later one has the content service read the files back
    await rateLimit(ctx, 'attachAsk', c.user._id)
    // The same rules the site keeps, kept here as well: nothing reaches the content service that one action may not carry
    if (args.files.length === 0) fail('invalid', 'There is no file to send.')
    if (args.files.length > LIMITS.actionFiles) fail('limit', `An action carries at most ${LIMITS.actionFiles} files.`)
    for (const f of args.files) {
      if (!Number.isInteger(f.size) || f.size < 0) fail('invalid', 'That is not a file’s size.')
      if (f.size > LIMITS.actionFileBytes) fail('limit', `A file sent with an action is at most ${LIMITS.actionFileBytes / 1024 / 1024} MB.`)
      if (!/^[0-9a-f]{64}$/.test(f.sha256)) fail('invalid', 'That is not a file’s checksum.')
    }
    const bytes = args.files.reduce((n, f) => n + f.size, 0)
    if (bytes > LIMITS.actionFilesBytes) fail('limit', `The files sent with one action come to at most ${LIMITS.actionFilesBytes / 1024 / 1024} MB.`)
    const files = args.files.map((f) => ({ name: fileName(f.name), type: fileType(f.type), size: f.size, sha256: f.sha256 }))
    // Asked before: the same click, sent again after a dropped connection, from another tab, or
    // once its files have been uploaded. It is answered with what was recorded, as long as these
    // are the same files: a click is one click, with one set of files
    const kept = await ctx.db
      .query('attachments')
      .withIndex('by_artifact_client', (q) => q.eq('artifactId', artifact._id).eq('clientActionId', args.clientActionId))
      .first()
    if (kept) {
      const same = kept.files.length === files.length && kept.files.every((f, i) => f.size === files[i]!.size && f.sha256 === files[i]!.sha256)
      if (!same) fail('conflict', 'Those are not the files this action was sent with.')
      return { id: kept._id, prefix: filesPrefix(kept.userId, kept.artifactId, kept._id), files: declared(kept), stored: kept.stored, fresh: false }
    }
    // A click that has been accepted already took its files with it, and one that carried none takes none now
    if (
      await ctx.db
        .query('actions')
        .withIndex('by_artifact_client', (q) => q.eq('artifactId', artifact._id).eq('clientActionId', args.clientActionId))
        .first()
    )
      fail('conflict', 'That action was already sent, without these files.')
    // A saved click is sent only until the deadline it was given before it was first sent, as its action is
    await replayAllowed(ctx, c, artifact._id, args.clientActionId, args.replayUntil)
    await rateLimit(ctx, 'attachPage', artifact._id)
    await rateLimit(ctx, 'fileKilobytes', c.user._id, Math.max(1, Math.ceil(bytes / 1024)))
    if ((await tally(ctx, c.user._id)).fileBytes + bytes > QUOTA.actionFileBytes) {
      log('quota.reached', { what: 'bytes of files sent with actions', who: c.user._id, max: QUOTA.actionFileBytes }, 'warn')
      fail(
        'limit',
        `It already holds ${QUOTA.actionFileBytes / 1024 / 1024 / 1024} GB of files sent from pages, which is as much as it keeps. Each goes with its action, a week after an agent was given it.`,
      )
    }
    const id = await ctx.db.insert('attachments', {
      userId: c.user._id,
      artifactId: artifact._id,
      clientActionId: args.clientActionId,
      files,
      bytes,
      stored: false,
      createdAt: Date.now(),
    })
    await bump(ctx, c.user._id, { fileBytes: bytes })
    return { id, prefix: filesPrefix(c.user._id, artifact._id, id), files: declared({ files }), stored: false, fresh: true }
  },
})

/** The content service has said that it holds every file of these whole. */
export const _stored = internalMutation({
  args: { id: v.id('attachments') },
  handler: async (ctx, { id }) => {
    const a = await ctx.db.get(id)
    if (a && !a.stored) await ctx.db.patch(id, { stored: true })
    return null
  },
})

/**
 * Takes the files of one click, before the click is sent. Answers whether they are all kept
 * whole already, and where they are not, which of them are still to come, by their numbers, and
 * a grant to upload those to the door's `/upload/<number>` at the address the site was reached at.
 */
export const prepare = action({
  args: {
    artifactId: v.id('artifacts'),
    clientActionId: v.string(),
    files: v.array(asked),
    replayUntil: v.optional(v.number()),
    expectedSession: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ id: Id<'attachments'>; stored: boolean; missing?: number[]; grant?: string }> => {
    const r = await overClashes(() => ctx.runMutation(internal.files._prepare, args))
    if (r.stored) return { id: r.id, stored: true }
    let missing = r.files.map((_, i) => i + 1)
    try {
      // Recorded before, and not yet known to be whole: they may have arrived since they were last
      // asked about, all of them or some, and only what has not is to be sent again
      if (!r.fresh) {
        const found = await ctx.runAction(internal.content.verify, { prefix: r.prefix, files: r.files })
        if (found.ok) {
          await overClashes(() => ctx.runMutation(internal.files._stored, { id: r.id }))
          return { id: r.id, stored: true }
        }
        const named = new Set(found.missing)
        const still = missing.filter((n) => named.has(String(n)))
        // What the content service says is there that was not declared is no file of these: all of them are sent again
        if (still.length > 0 && still.length === found.missing.length) missing = still
      }
      // Declared again each time it is asked, which declares the same files: a declaration that was lost on its way is made good
      await ctx.runAction(internal.content.stage, { prefix: r.prefix, files: r.files })
    } catch (err) {
      log('files.unavailable', { attachment: r.id, kind: kind(err) }, 'error')
      throw new ConvexError({ code: 'unavailable', message: 'The file could not be sent just now. It is kept, and sent again in a moment.' })
    }
    return { id: r.id, stored: false, missing, grant: await mint(ctx, AUDIENCE.upload, r.prefix, { p: r.prefix }, PUBLICATION.grantSeconds) }
  },
})

/** One file an action carried, for a machine of the person's: where it is kept, and what it is. */
export const _toRead = internalQuery({
  args: { id: v.string(), number: v.number() },
  handler: async (ctx, { id, number }) => {
    const { user } = await requireMachine(ctx)
    const actionId = ctx.db.normalizeId('actions', id)
    const x = actionId ? await ctx.db.get(actionId) : null
    if (!x || x.userId !== user._id) fail('not_found', 'No such action.')
    const files = x.files ?? []
    if (!x.attachment || files.length === 0) fail('not_found', 'That action carried no file.')
    const f = Number.isInteger(number) ? files[number - 1] : undefined
    if (!f)
      fail(
        'not_found',
        files.length === 1 ? 'That action carried one file, number 1.' : `That action carried ${files.length} files: give a number from 1 to ${files.length}.`,
      )
    const kept = await ctx.db.get(x.attachment)
    if (!kept?.stored) fail('not_found', 'That action’s files are not kept any more.')
    return { prefix: filesPrefix(x.userId, x.artifactId, kept._id), number, name: f.name, type: f.type, bytes: f.size, sha256: f.sha256 }
  },
})

/** A grant to read one file an action carried, for the machine that asks, with what the file is. It is read from the door at `/download/<number>`. */
export const read = action({
  args: { id: v.string(), number: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ url: string; grant: string; number: number; name: string; type: string; bytes: number; sha256: string }> => {
    const { prefix, ...file } = await ctx.runQuery(internal.files._toRead, { id: args.id, number: args.number ?? 1 })
    // Long enough for the reading to begin, which is all it is checked for
    const grant = await mint(ctx, AUDIENCE.download, prefix, { p: prefix }, 120)
    return { url: `${door()}/download/${file.number}`, grant, ...file }
  },
})

/**
 * Lets go of the files of one action, or of a click that was never accepted: their record, what
 * they counted against the person, and their bytes, which the content service is asked to
 * remove until it says it has. `bytesToo` is false where the bytes go anyway, with their page's
 * folder or with everything of the person's.
 */
export async function letGoOfFiles(ctx: MutationCtx, id: Id<'attachments'> | undefined, { bytesToo = true } = {}): Promise<void> {
  const a = id ? await ctx.db.get(id) : null
  if (!a) return
  await ctx.db.delete(a._id)
  if (await ctx.db.get(a.userId)) await bump(ctx, a.userId, { fileBytes: -a.bytes })
  if (bytesToo) await removeLater(ctx, filesPrefix(a.userId, a.artifactId, a._id))
}

/** Daily: the files of clicks that were never accepted, once no browser could still send those clicks. */
export const sweepUnattached = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query('attachments')
      .withIndex('by_unattached', (q) => q.eq('actionId', undefined).lt('createdAt', Date.now() - RETENTION.unattachedFileDays * DAY))
      .take(50)
    for (const a of old) await letGoOfFiles(ctx, a._id)
    if (old.length === 50) await ctx.scheduler.runAfter(0, internal.files.sweepUnattached, {})
    if (old.length) log('sweep.files', { neverSent: old.length })
    return old.length
  },
})
