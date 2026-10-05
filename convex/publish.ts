// Publishing a page, in two steps so that a crash in the middle leaves the old version live:
// `begin` records what is about to be uploaded and returns a grant to upload it; `finish`
// checks the upload with the content service and then switches the page to the new version.
import { AUDIENCE, isSafePath, isSlug, LIMITS, parseJson, QUOTA, RETENTION, STORE_KEY } from '@it/protocol'
import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { action, internalMutation, type MutationCtx, mutation, type QueryCtx } from './_generated/server'
import { prefixOf } from './artifacts'
import { door, site } from './config'
import { removeLater } from './content'
import { artifactBySlug, ownArtifact, requireMachine } from './lib/authz'
import { overClashes } from './lib/clash'
import { fail } from './lib/errors'
import { quota, rateLimit } from './lib/limits'
import { kind, log } from './lib/log'
import { mint } from './lib/signing'
import { bump, tally } from './lib/tally'
import { fileEntry, session } from './schema'
import { noteRevision } from './state'

const beginArgs = {
  slug: v.optional(v.string()),
  title: v.string(),
  files: v.array(fileEntry),
  project: v.optional(v.object({ key: v.string(), name: v.string() })),
  session: v.optional(session),
  agent: v.optional(v.string()),
  /** The page's starting state, as JSON text. Used only if the page has no state yet. */
  state: v.optional(v.string()),
  /** The conversation publishing this takes the page over: clicks on it come to this conversation from now on. */
  take: v.optional(v.boolean()),
}
const UPLOAD_SECONDS = 900
/** How long after a grant was given something might still be written with it. */
export const GRANT_TAIL_MS = (UPLOAD_SECONDS + 300) * 1000

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || 'page'
}

/**
 * Takes an unfinished publish off the books: its record and its share of the quota. If it was
 * the first publish of a page and nothing of that page ever went live, the page's own record
 * goes too, so a publish that failed leaves nothing behind that counts against the person.
 */
/** The state a publish asked its page to start with, taken out of where it was kept. Null if it asked for none. */
async function takeStart(ctx: MutationCtx, versionId: Id<'versions'>): Promise<string | null> {
  const start = await ctx.db
    .query('starts')
    .withIndex('by_version', (q) => q.eq('versionId', versionId))
    .unique()
  if (start) await ctx.db.delete(start._id)
  return start?.json ?? null
}

export async function dropStaging(ctx: MutationCtx, ver: Doc<'versions'>, opts: { keepPage?: boolean } = {}): Promise<void> {
  if (await ctx.db.get(ver.userId)) await bump(ctx, ver.userId, { stagingCount: -1, stagingBytes: -ver.bytes })
  await takeStart(ctx, ver._id)
  await ctx.db.delete(ver._id)
  if (opts.keepPage) return
  const artifact = await ctx.db.get(ver.artifactId)
  if (!artifact || artifact.currentVersion !== undefined) return
  const other = await ctx.db
    .query('versions')
    .withIndex('by_artifact_n', (q) => q.eq('artifactId', artifact._id))
    .first()
  if (other) return
  const state = await ctx.db
    .query('states')
    .withIndex('by_artifact', (q) => q.eq('artifactId', artifact._id))
    .unique()
  if (state) await ctx.db.delete(state._id)
  // A click can have been recorded on it all the same (a notification's button names the page).
  // What was waiting is given back to the person's count, and the clicks go with the page.
  if (artifact.waiting && (await ctx.db.get(artifact.userId))) await bump(ctx, artifact.userId, { waiting: -artifact.waiting })
  await ctx.db.delete(artifact._id)
  await ctx.scheduler.runAfter(0, internal.retention.purgeArtifact, { artifactId: artifact._id })
}

export const _begin = internalMutation({
  args: beginArgs,
  handler: async (ctx, args) => {
    const { user, machine } = await requireMachine(ctx)
    await rateLimit(ctx, 'publish', user._id)
    // A title is one line of text. Characters that are not text (a line break, a NUL) are taken
    // as spaces: a title is put into the message an agent reads, and onto a command line
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
    const title = args.title.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
    if (!title || title.length > LIMITS.title) fail('invalid', `A title is 1 to ${LIMITS.title} characters.`)
    if (args.slug !== undefined && !isSlug(args.slug)) fail('invalid', 'An id is lowercase letters, digits, dots, dashes and underscores, at most 64.')
    if (args.files.length === 0 || args.files.length > LIMITS.filesPerVersion) fail('invalid', `A page has 1 to ${LIMITS.filesPerVersion} files.`)
    const seen = new Set<string>()
    let bytes = 0
    let pathBytes = 0
    for (const f of args.files) {
      // None of these names the file: the CLI checks the same things before it asks, and says
      // which file there, and a refusal's words are kept in the backend's record of what failed
      if (!isSafePath(f.path) || seen.has(f.path)) fail('invalid', 'One of the files has a path that cannot be used, or is listed twice.')
      if (!Number.isInteger(f.size) || f.size < 0 || f.size > LIMITS.fileBytes)
        fail('limit', `One of the files is larger than the ${LIMITS.fileBytes / 1024 / 1024} MB allowed for one file.`)
      if (!/^[0-9a-f]{64}$/.test(f.sha256)) fail('invalid', 'One of the files has no valid checksum.')
      seen.add(f.path)
      bytes += f.size
      pathBytes += new TextEncoder().encode(f.path).length
    }
    if (!seen.has('index.html')) fail('invalid', 'A page needs an index.html.')
    if (bytes > LIMITS.versionBytes) fail('limit', `A page is at most ${LIMITS.versionBytes / 1024 / 1024} MB.`)
    // A version's record holds every path, so together they are kept small enough that many
    // records can be read at once when cleaning up
    if (pathBytes > LIMITS.pathBytesPerVersion) fail('limit', 'The file names of this page are too long taken together. Use shorter paths.')
    if (args.state !== undefined) {
      if (new TextEncoder().encode(args.state).length > LIMITS.stateBytes) fail('limit', 'The starting state is too large.')
      const parsed = parseJson(args.state)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('invalid', 'State is a JSON object.')
    }
    if (args.session && (args.session.harness.length > 40 || args.session.id.length > 200)) fail('invalid', 'That is not a session.')
    // Taking a page over means its clicks come to the conversation that said so, so there has to be one
    if (args.take && !args.session) fail('invalid', 'Taking a page over only works from inside an agent conversation.')

    let projectId: Id<'projects'> | undefined
    if (args.project) {
      const key = args.project.key.slice(0, 200)
      const p = await ctx.db
        .query('projects')
        .withIndex('by_user_key', (q) => q.eq('userId', user._id).eq('key', key))
        .unique()
      if (p) projectId = p._id
      else {
        const have = await ctx.db
          .query('projects')
          .withIndex('by_user_key', (q) => q.eq('userId', user._id))
          .take(QUOTA.projects + 1)
        // Past the limit a page is simply published without a project; nothing an agent did is refused for it
        if (have.length < QUOTA.projects)
          projectId = await ctx.db.insert('projects', { userId: user._id, key, name: args.project.name.slice(0, 120), createdAt: Date.now() })
      }
    }

    const mine = await ctx.db
      .query('artifacts')
      .withIndex('by_user_slug', (q) => q.eq('userId', user._id))
      .take(QUOTA.artifacts + 1)

    const now = Date.now()
    const who = { machineId: machine._id, session: args.session, agent: args.agent?.slice(0, 60), take: args.take === true }
    let artifact = args.slug ? await artifactBySlug(ctx, user._id, args.slug) : null
    if (!artifact) {
      quota(mine.length, QUOTA.artifacts, 'pages', user._id)
      let slug = args.slug ?? slugify(title)
      if (!args.slug) while (mine.some((a) => a.slug === slug)) slug = `${slugify(title)}-${crypto.randomUUID().slice(0, 6)}`
      const id = await ctx.db.insert('artifacts', {
        userId: user._id,
        slug,
        title,
        projectId,
        lastVersion: 0,
        bytes: 0,
        createdAt: now,
        updatedAt: now,
        machineId: machine._id,
        session: args.session,
        agent: who.agent,
      })
      artifact = (await ctx.db.get(id))!
    } else {
      // An earlier publish of this page that was never finished, and whose grant has run out,
      // cannot be completed any more: clear it away now instead of waiting for the hourly sweep
      const stale = await ctx.db
        .query('versions')
        .withIndex('by_artifact_status', (q) => q.eq('artifactId', artifact!._id).eq('status', 'staging'))
        .take(10)
      for (const s of stale) {
        if (now - s.createdAt < GRANT_TAIL_MS) continue
        // The page itself stays: it is about to be published to
        await dropStaging(ctx, s, { keepPage: true })
        await removeLater(ctx, prefixOf(user._id, artifact._id, s.n))
      }
    }
    const n = artifact.lastVersion + 1
    // What is stored, plus what has been declared and not yet finished, plus this. Counted after
    // anything stale was cleared away just above, so an abandoned attempt does not block its own retry.
    const totals = await tally(ctx, user._id)
    const used = mine.reduce((sum, a) => sum + a.bytes, 0) + totals.stagingBytes
    if (used + bytes > QUOTA.bytes) {
      log('quota.reached', { what: 'storage', who: user._id, have: used, max: QUOTA.bytes }, 'warn')
      fail('limit', 'It has no room left for pages. Delete some pages first.')
    }
    quota(totals.stagingCount, QUOTA.staging, 'publishes in progress', user._id)
    await ctx.db.patch(artifact._id, { lastVersion: n })
    const versionId = await ctx.db.insert('versions', {
      artifactId: artifact._id,
      userId: user._id,
      n,
      files: args.files,
      bytes,
      status: 'staging',
      createdAt: now,
      title,
      by: who,
    })
    await bump(ctx, user._id, { stagingCount: 1, stagingBytes: bytes })
    if (args.state !== undefined) {
      // Counted by size like every other write of a page's state, and kept with this publish:
      // it becomes the page's state only if this publish is the one that is shown, and only if
      // the page has none by then. One that is given up on, or loses to a newer one, starts nothing.
      const kilobytes = Math.ceil(new TextEncoder().encode(args.state).length / 1024)
      await rateLimit(ctx, 'stateKilobytesPage', artifact._id, kilobytes)
      await rateLimit(ctx, 'stateKilobytes', user._id, kilobytes)
      await ctx.db.insert('starts', { versionId, artifactId: artifact._id, json: args.state })
    }
    return { artifactId: artifact._id, versionId, slug: artifact.slug, n, prefix: prefixOf(user._id, artifact._id, n), bytes }
  },
})

/** Takes an unfinished publish of the caller's off the books, and has whatever reached storage removed. */
async function abandonStaging(ctx: MutationCtx, userId: Id<'users'>, ver: Doc<'versions'> | null): Promise<void> {
  if (!ver || ver.userId !== userId || ver.status !== 'staging') return
  await dropStaging(ctx, ver)
  // The declaration may have been stored even though its answer was lost, and a grant may be
  // out: the folder is emptied now, and again once any grant has run out
  await removeLater(ctx, prefixOf(ver.userId, ver.artifactId, ver.n), { grantMayBeLive: true })
}

/** Undoes a `begin` whose files could not be declared to the content service, so that nothing is left holding quota. */
export const _abandon = internalMutation({
  args: { versionId: v.id('versions') },
  handler: async (ctx, { versionId }) => {
    const { user } = await requireMachine(ctx)
    await abandonStaging(ctx, user._id, await ctx.db.get(versionId))
    return null
  },
})

/**
 * The machine gives up on a publish it began: an upload failed, say. Its share of the quota
 * comes back at once, where it would otherwise be held until the publish is cleared as stale.
 */
export const abandon = mutation({
  // By the page's own id, which `begin` gave out, and never by its name: a name can have been
  // given to another page since
  args: { artifactId: v.id('artifacts'), version: v.number() },
  handler: async (ctx, { artifactId, version }) => {
    const { user } = await requireMachine(ctx)
    await rateLimit(ctx, 'finish', user._id)
    const a = await ctx.db.get(artifactId)
    if (!a || a.userId !== user._id) return null
    const ver = await ctx.db
      .query('versions')
      .withIndex('by_artifact_n', (q) => q.eq('artifactId', a._id).eq('n', version))
      .unique()
    await abandonStaging(ctx, user._id, ver)
    return null
  },
})

/** Step one: declare the files. Returns where to upload them and a grant that allows it. */
export const begin = action({
  args: beginArgs,
  handler: async (ctx, args): Promise<{ artifactId: Id<'artifacts'>; slug: string; version: number; upload: { url: string; grant: string } }> => {
    const r = await overClashes(() => ctx.runMutation(internal.publish._begin, args))
    try {
      // The content service is told exactly which files to expect, so the grant allows those and nothing else
      await ctx.runAction(internal.content.stage, { prefix: r.prefix, files: args.files })
    } catch (err) {
      log('publish.unavailable', { step: 'stage', artifactId: r.artifactId, version: r.n, kind: kind(err) }, 'error')
      await overClashes(() => ctx.runMutation(internal.publish._abandon, { versionId: r.versionId }))
      throw new ConvexError({ code: 'unavailable', message: 'The page could not be prepared for upload. Try again in a moment.' })
    }
    const grant = await mint(ctx, AUDIENCE.upload, r.prefix, { p: r.prefix }, UPLOAD_SECONDS)
    return { artifactId: r.artifactId, slug: r.slug, version: r.n, upload: { url: `${door()}/upload/`, grant } }
  },
})

async function staged(ctx: QueryCtx, userId: Id<'users'>, artifactId: Id<'artifacts'>, version: number) {
  const a = await ownArtifact(ctx, userId, artifactId)
  const ver = await ctx.db
    .query('versions')
    .withIndex('by_artifact_n', (q) => q.eq('artifactId', a._id).eq('n', version))
    .unique()
  if (ver?.status !== 'staging') fail('conflict', 'That version is not waiting to be published.')
  return { a, ver }
}

/** Counts the attempt before the content service is asked anything, so that asking again and again is not free. */
export const _gate = internalMutation({
  args: { artifactId: v.id('artifacts'), version: v.number() },
  handler: async (ctx, { artifactId, version }) => {
    const { user } = await requireMachine(ctx)
    await rateLimit(ctx, 'finish', user._id)
    const { ver } = await staged(ctx, user._id, artifactId, version)
    return { prefix: prefixOf(user._id, artifactId, version), files: ver.files }
  },
})

export const _finish = internalMutation({
  args: { artifactId: v.id('artifacts'), version: v.number() },
  handler: async (ctx, { artifactId, version }) => {
    const { user } = await requireMachine(ctx)
    const { a, ver } = await staged(ctx, user._id, artifactId, version)
    // Either way this publish is over
    await bump(ctx, user._id, { stagingCount: -1, stagingBytes: -ver.bytes })
    // A slower publish must not replace a newer one that finished first, even if the page has
    // since been rolled back to something older
    if ((a.highestLive ?? 0) > version) {
      await takeStart(ctx, ver._id)
      await ctx.db.delete(ver._id)
      await removeLater(ctx, prefixOf(user._id, a._id, version), { grantMayBeLive: true })
      return { slug: a.slug, version: a.currentVersion ?? version, superseded: true }
    }
    const live = await ctx.db
      .query('versions')
      .withIndex('by_artifact_status', (q) => q.eq('artifactId', a._id).eq('status', 'live'))
      .take(10)
    for (const x of live) await ctx.db.patch(x._id, { status: 'retired' })
    await ctx.db.patch(ver._id, { status: 'live' })
    // The state this publish asked to start with becomes the page's, in the same step as the
    // publish itself, if the page has none: a starting state is never laid over one that is there
    const start = await takeStart(ctx, ver._id)
    if (start !== null) {
      const state = await ctx.db
        .query('states')
        .withIndex('by_artifact', (q) => q.eq('artifactId', a._id))
        .unique()
      if (!state) {
        await ctx.db.insert('states', { artifactId: a._id, userId: user._id, json: start, revision: 1 })
        await noteRevision(ctx, a._id, 1)
      } else {
        // A state that holds only what the page stored for itself is no state of the agent's:
        // the starting state goes in beside it, and what the page stored stays
        const now = parseJson(state.json)
        const own = now !== null && typeof now === 'object' && !Array.isArray(now) ? (now as Record<string, unknown>) : {}
        if (Object.keys(own).every((k) => k === STORE_KEY)) {
          const begun = parseJson(start)
          const json = JSON.stringify({ ...(begun !== null && typeof begun === 'object' && !Array.isArray(begun) ? begun : {}), ...own })
          // Each half was within the limit by itself. Together they may not be, and a state over
          // the limit could never be changed again: the publish is refused, and nothing of it is kept.
          if (new TextEncoder().encode(json).length > LIMITS.stateBytes)
            fail('limit', `The starting state and what the page has stored for itself are together more than ${LIMITS.stateBytes / 1024} KB.`)
          await ctx.db.patch(state._id, { json, revision: state.revision + 1 })
          await noteRevision(ctx, a._id, state.revision + 1)
        }
      }
    }
    // Keep the newest few; the rest go, bytes included
    const retired = await ctx.db
      .query('versions')
      .withIndex('by_artifact_status', (q) => q.eq('artifactId', a._id).eq('status', 'retired'))
      .order('desc')
      .take(LIMITS.versionsKept + 10)
    let bytes = ver.bytes
    for (const [i, x] of retired.entries()) {
      if (i < LIMITS.versionsKept - 1) {
        bytes += x.bytes
        continue
      }
      await ctx.db.delete(x._id)
      await removeLater(ctx, prefixOf(user._id, a._id, x.n))
    }
    // The conversation that made a page keeps it. A later publish from elsewhere changes the
    // content but not who hears about clicks, unless the page has no owner any more (its
    // machine was revoked) or the publisher said it is taking the page over. Decided here, once
    // the publish has succeeded, so that one that fails changes nothing.
    // A page that has never been shown belongs to whoever first publishes it to the end: one
    // who began it and gave up has made nothing, and another conversation that began the same
    // id meanwhile and finished is the one that made the page.
    const owner = a.machineId ? await ctx.db.get(a.machineId) : null
    const moves =
      ver.by !== undefined &&
      (!owner || owner.revoked || ver.by.take || a.currentVersion === undefined) &&
      (ver.by.machineId !== a.machineId || JSON.stringify(ver.by.session) !== JSON.stringify(a.session))
    await ctx.db.patch(a._id, {
      currentVersion: version,
      highestLive: version,
      bytes,
      updatedAt: Date.now(),
      title: ver.title ?? a.title,
      ...(moves ? { machineId: ver.by!.machineId, session: ver.by!.session, agent: ver.by!.agent ?? a.agent } : {}),
    })
    // Clicks already waiting on the page go where the page went
    if (moves) await ctx.scheduler.runAfter(0, internal.actions.readdress, { artifactId: a._id })
    return { slug: a.slug, version, superseded: false }
  },
})

/** Step two, after the uploads: check them, then switch the page to the new version. */
export const finish = action({
  args: { artifactId: v.id('artifacts'), version: v.number() },
  handler: async (ctx, args): Promise<{ slug: string; version: number; url: string }> => {
    const waiting = await overClashes(() => ctx.runMutation(internal.publish._gate, args))
    let checked: { ok: boolean; missing: string[] }
    try {
      checked = await ctx.runAction(internal.content.verify, waiting)
    } catch (err) {
      log('publish.unavailable', { step: 'verify', artifactId: args.artifactId, version: args.version, kind: kind(err) }, 'error')
      throw new ConvexError({ code: 'unavailable', message: 'The upload could not be checked just now. Try again in a moment.' })
    }
    if (!checked.ok) {
      log('publish.refused', { reason: 'not_intact', artifactId: args.artifactId, version: args.version, files: checked.missing.length }, 'warn')
      fail('invalid', `${checked.missing.length === 1 ? 'One file' : `${checked.missing.length} files`} did not arrive intact. Publish again.`)
    }
    const done = await overClashes(() => ctx.runMutation(internal.publish._finish, args))
    // A newer publish of the same page finished first, and this one was put away unshown. Its
    // agent is told so: told "published", it would wait for clicks on something nobody can see.
    if (done.superseded) fail('conflict', 'A newer publish of this page finished first, so this one was not shown. Read the page before publishing again.')
    return { slug: done.slug, version: done.version, url: `${site()}/p/${done.slug}` }
  },
})

/** How long an unfinished publish is kept before the sweep removes it. */
export const STAGING_MS = RETENTION.stagingHours * 3_600_000
