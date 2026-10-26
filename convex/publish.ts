// Publishing a page, in two steps so that a crash in the middle leaves the old version live:
// `begin` records what is about to be uploaded and returns a grant to upload it; `finish`
// checks the upload with the content service and then switches the page to the new version.
import { AUDIENCE, isSafePath, isSlug, LIMITS, PUBLICATION, parseJson, QUOTA, RETENTION, TOUR, TOUR_NAMES } from '@it/protocol'
import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { type ActionCtx, action, internalMutation, internalQuery, type MutationCtx, mutation, type QueryCtx } from './_generated/server'
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
import { adoptTourPage, isTourPage, startTourPage } from './lib/tourPages'
import { expectedOwner, fileEntry, session } from './schema'
import { pageRevision, startState } from './state'

const beginArgs = {
  /** Only the built-in tour asks for this. A matching legacy page may be adopted once. */
  tour: v.optional(v.string()),
  operation: v.optional(v.string()),
  agentExplicit: v.optional(v.boolean()),
  expectedOwner: v.optional(expectedOwner),
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
  /**
   * The conversation publishing this is making a page of its own. Where the id is already
   * another conversation's page, nothing is published: two conversations that each choose the
   * same id would otherwise end with one page, and the first would never hear of it again.
   */
  own: v.optional(v.boolean()),
}
const UPLOAD_SECONDS = PUBLICATION.grantSeconds
/** How long after a grant was given something might still be written with it. */
export const GRANT_TAIL_MS = PUBLICATION.grantTailMs

/**
 * Whether a page is another conversation's than the one publishing: it has been shown, a
 * conversation has it, the machine that conversation is on is still one of the person's, and
 * either the machine or the conversation is not the publisher's. A page nobody has, or whose
 * machine is gone, or that was begun and never shown, is nobody's to keep.
 */
async function anothers(ctx: MutationCtx, a: Doc<'artifacts'>, by: { machineId: Id<'machines'>; session?: { harness: string; id: string } }): Promise<boolean> {
  if (a.currentVersion === undefined || a.session === undefined || !a.machineId) return false
  const owner = await ctx.db.get(a.machineId)
  if (!owner || owner.revoked) return false
  return a.machineId !== by.machineId || a.session.harness !== by.session?.harness || a.session.id !== by.session?.id
}
/** What is said where a page that a conversation meant to make is another's. The command that asked says whose, and what can be done. */
const ANOTHERS = 'A page with that id belongs to another conversation.'
const TOUR_CONFLICT =
  'This id belongs to a page that the tour does not own, or the page changed while the tour was publishing. Nothing was replaced. Keep the page, or ask the person before deleting it with it delete.'

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
  if (ver.publicationId && (await ctx.db.get(ver.publicationId))) await ctx.db.patch(ver.publicationId, { abandoned: true })
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
  args: { ...beginArgs, requestHash: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { user, machine } = await requireMachine(ctx)
    if (args.operation !== undefined) {
      if (!/^[a-zA-Z0-9_-]{16,100}$/.test(args.operation)) fail('invalid', 'That is not a publication identity.')
      const previous = await ctx.db
        .query('publications')
        .withIndex('by_user_key', (q) => q.eq('userId', user._id).eq('key', args.operation!))
        .unique()
      if (previous) {
        if (previous.machineId !== machine._id || previous.requestHash !== args.requestHash)
          fail('conflict', 'That publication identity was used for another request.')
        if (previous.abandoned) fail('conflict', 'That publication was abandoned.')
        const a = await ownArtifact(ctx, user._id, previous.artifactId)
        const ver = await ctx.db
          .query('versions')
          .withIndex('by_artifact_n', (q) => q.eq('artifactId', a._id).eq('n', previous.version))
          .unique()
        if (!previous.result && (!ver || Date.now() >= previous.createdAt + PUBLICATION.budgetMs)) fail('conflict', 'That publication has expired.')
        return {
          artifactId: a._id,
          versionId: ver?._id,
          slug: a.slug,
          n: previous.version,
          prefix: prefixOf(user._id, a._id, previous.version),
          bytes: ver?.bytes ?? 0,
          operation: previous.key,
          deadline: previous.createdAt + PUBLICATION.budgetMs,
          result: previous.result,
        }
      }
    }
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
    if (args.expectedOwner && (!args.take || !args.session)) fail('invalid', 'An expected owner requires a takeover from a conversation.')
    if (args.take && !args.session) fail('invalid', 'Taking a page over only works from inside an agent conversation.')

    if (args.tour !== undefined && (!TOUR_NAMES.includes(args.tour) || args.slug !== `${TOUR.prefix}${args.tour}` || args.state === undefined))
      fail('invalid', 'A tour publication needs a known tour page id and its starting state.')

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
    // Making a page of one's own is a conversation's to do: from a plain terminal there is none to keep a page for
    const own = args.own === true && args.take !== true && args.session !== undefined
    const who = {
      machineId: machine._id,
      session: args.session,
      agent: args.agent?.slice(0, 60),
      take: args.take === true,
      agentExplicit: args.agentExplicit,
      expectedOwner: args.expectedOwner,
      ...(own ? { own: true } : {}),
    }
    let artifact = args.slug ? await artifactBySlug(ctx, user._id, args.slug) : null
    if (artifact && args.tour !== undefined && !isTourPage(artifact, args.tour)) {
      const adopted = await adoptTourPage(ctx, artifact, args.tour, title, args.state!)
      if (!adopted) fail('conflict', TOUR_CONFLICT)
      artifact = adopted
    }
    if (args.expectedOwner && (!artifact || !ownerMatches(artifact, args.expectedOwner)))
      fail('conflict', 'The page changed owner. Read it before publishing again.')
    // Refused before anything is begun, and again when it is shown, in case two began it together
    if (artifact && own && (await anothers(ctx, artifact, who))) {
      log('publish.refused', { reason: 'anothers', userId: user._id, artifactId: artifact._id }, 'warn')
      fail('conflict', ANOTHERS, { anothers: true })
    }
    if (!artifact) {
      quota(mine.length, QUOTA.artifacts, 'pages', user._id)
      let slug = args.slug ?? slugify(title)
      if (!args.slug) while (mine.some((a) => a.slug === slug)) slug = `${slugify(title)}-${crypto.randomUUID().slice(0, 6)}`
      const id = await ctx.db.insert('artifacts', {
        tour: args.tour === undefined ? null : { name: args.tour, identity: crypto.randomUUID() },
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
    const operation = args.operation ?? crypto.randomUUID()
    const publicationId = await ctx.db.insert('publications', {
      userId: user._id,
      machineId: machine._id,
      key: operation,
      requestHash: args.requestHash,
      artifactId: artifact._id,
      version: n,
      createdAt: now,
    })
    const versionId = await ctx.db.insert('versions', {
      ...(args.tour === undefined
        ? {}
        : {
            tour: {
              name: args.tour,
              identity: artifact.tour!.identity,
              version: artifact.currentVersion,
              revision: await pageRevision(ctx, artifact._id),
            },
          }),
      publicationId,
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
    return {
      artifactId: artifact._id,
      versionId,
      slug: artifact.slug,
      n,
      prefix: prefixOf(user._id, artifact._id, n),
      bytes,
      operation,
      deadline: now + PUBLICATION.budgetMs,
      result: undefined,
    }
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
  handler: async (
    ctx,
    args,
  ): Promise<{ artifactId: Id<'artifacts'>; slug: string; version: number; operation: string; deadline: number; upload: { url: string; grant: string } }> => {
    const requestHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(args)))), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('')
    const r = await overClashes(() => ctx.runMutation(internal.publish._begin, { ...args, requestHash }))
    return prepared(ctx, r, args.files, args.operation !== undefined)
  },
})

/** Recovers exactly the files and ownership intent saved by begin. */
export const _resume = internalQuery({
  args: { operation: v.string() },
  handler: async (ctx, { operation }) => {
    const { user, machine } = await requireMachine(ctx)
    const previous = await ctx.db
      .query('publications')
      .withIndex('by_user_key', (q) => q.eq('userId', user._id).eq('key', operation))
      .unique()
    if (!previous || previous.machineId !== machine._id) fail('not_found', 'That publication is not recorded.')
    if (previous.abandoned) fail('conflict', 'That publication was abandoned.')
    const a = await ownArtifact(ctx, user._id, previous.artifactId)
    const ver = await ctx.db
      .query('versions')
      .withIndex('by_artifact_n', (q) => q.eq('artifactId', a._id).eq('n', previous.version))
      .unique()
    if (!previous.result && (!ver || Date.now() >= previous.createdAt + PUBLICATION.budgetMs)) fail('conflict', 'That publication has expired.')
    return {
      artifactId: a._id,
      versionId: ver?._id,
      slug: a.slug,
      n: previous.version,
      prefix: prefixOf(user._id, a._id, previous.version),
      operation: previous.key,
      deadline: previous.createdAt + PUBLICATION.budgetMs,
      result: previous.result,
      files: ver?.files ?? [],
    }
  },
})
export const resume = action({
  args: { operation: v.string() },
  handler: async (ctx, args): Promise<Prepared> => {
    const r = await ctx.runQuery(internal.publish._resume, args)
    return prepared(ctx, r, r.files)
  },
})
type Prepared = { artifactId: Id<'artifacts'>; slug: string; version: number; operation: string; deadline: number; upload: { url: string; grant: string } }
async function prepared(
  ctx: ActionCtx,
  r: {
    artifactId: Id<'artifacts'>
    versionId?: Id<'versions'>
    slug: string
    n: number
    prefix: string
    operation: string
    deadline: number
    result?: Doc<'publications'>['result']
  },
  files: Doc<'versions'>['files'],
  recoverable = true,
): Promise<Prepared> {
  if (r.result)
    return {
      artifactId: r.artifactId,
      slug: r.slug,
      version: r.n,
      operation: r.operation,
      deadline: r.deadline,
      upload: { url: `${door()}/upload/`, grant: '' },
    }

  try {
    // The content service is told exactly which files to expect, so the grant allows those and nothing else
    await ctx.runAction(internal.content.stage, { prefix: r.prefix, files })
  } catch (err) {
    log('publish.unavailable', { step: 'stage', artifactId: r.artifactId, version: r.n, kind: kind(err) }, 'error')
    // A caller may have lost this reply and resumed the same named publication already.
    // Keep its staging version for recovery or expiry; a late failure must not erase it.
    if (!recoverable) await overClashes(() => ctx.runMutation(internal.publish._abandon, { versionId: r.versionId! }))
    throw new ConvexError({ code: 'unavailable', message: 'The page could not be prepared for upload. Try again in a moment.' })
  }
  const grant = await mint(
    ctx,
    AUDIENCE.upload,
    r.prefix,
    { p: r.prefix },
    Math.max(1, Math.ceil((r.deadline - Date.now()) / 1000) + UPLOAD_SECONDS - PUBLICATION.budgetMs / 1000),
  )
  return { artifactId: r.artifactId, slug: r.slug, version: r.n, operation: r.operation, deadline: r.deadline, upload: { url: `${door()}/upload/`, grant } }
}

function ownerMatches(a: Doc<'artifacts'>, expected: { machineId: Id<'machines'>; session: { harness: string; id: string } }): boolean {
  return a.machineId === expected.machineId && a.session?.harness === expected.session.harness && a.session.id === expected.session.id
}
async function receipt(ctx: QueryCtx, artifactId: Id<'artifacts'>, version: number) {
  return ctx.db
    .query('publications')
    .withIndex('by_artifact_n', (q) => q.eq('artifactId', artifactId).eq('version', version))
    .unique()
}
async function recorded(ctx: QueryCtx, userId: Id<'users'>, artifactId: Id<'artifacts'>, version: number) {
  await ownArtifact(ctx, userId, artifactId)
  return (await receipt(ctx, artifactId, version))?.result
}

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
    const result = await recorded(ctx, user._id, artifactId, version)
    if (result) return { result }
    await rateLimit(ctx, 'finish', user._id)
    const { ver } = await staged(ctx, user._id, artifactId, version)
    if (Date.now() >= ver.createdAt + PUBLICATION.budgetMs) fail('conflict', 'That publication has expired.')
    return { waiting: { prefix: prefixOf(user._id, artifactId, version), files: ver.files } }
  },
})

export const _finish = internalMutation({
  args: { artifactId: v.id('artifacts'), version: v.number() },
  handler: async (ctx, { artifactId, version }) => {
    const { user } = await requireMachine(ctx)
    const result = await recorded(ctx, user._id, artifactId, version)
    if (result) return result
    const { a, ver } = await staged(ctx, user._id, artifactId, version)
    if (Date.now() >= ver.createdAt + PUBLICATION.budgetMs) fail('conflict', 'That publication has expired.')
    const remember = async (done: {
      slug: string
      version: number
      superseded: boolean
      anothers?: boolean
      ownerChanged?: boolean
      tourConflict?: boolean
      elsewhere?: boolean
      took?: boolean
    }) => {
      const result = { ...done, url: `${site()}/p/${done.slug}` }
      const existing = await receipt(ctx, artifactId, version)
      if (existing) await ctx.db.patch(existing._id, { result })
      else {
        const { machine } = await requireMachine(ctx)
        await ctx.db.insert('publications', {
          userId: user._id,
          machineId: machine._id,
          key: crypto.randomUUID(),
          artifactId,
          version,
          createdAt: Date.now(),
          result,
        })
      }
      return result
    }
    // Either way this publish is over
    await bump(ctx, user._id, { stagingCount: -1, stagingBytes: -ver.bytes })
    if (
      ver.tour !== undefined &&
      (!isTourPage(a, ver.tour.name) ||
        a.tour?.identity !== ver.tour.identity ||
        a.currentVersion !== ver.tour.version ||
        (await pageRevision(ctx, a._id)) !== ver.tour.revision)
    ) {
      await takeStart(ctx, ver._id)
      await ctx.db.delete(ver._id)
      await removeLater(ctx, prefixOf(user._id, a._id, version), { grantMayBeLive: true })
      return remember({ slug: a.slug, version: a.currentVersion ?? version, superseded: false, tourConflict: true })
    }
    // Two conversations began a page of the same id at the same moment, and the other finished
    // first: the page is its own, and this publish is put away unshown. Looked at before
    // whether a newer publish finished first, which the other's may also be: what this
    // conversation has to be told is whose page it is, and not to read it and publish again.
    if (ver.by?.expectedOwner && !ownerMatches(a, ver.by.expectedOwner)) {
      await takeStart(ctx, ver._id)
      await ctx.db.delete(ver._id)
      await removeLater(ctx, prefixOf(user._id, a._id, version), { grantMayBeLive: true })
      return remember({ slug: a.slug, version: a.currentVersion ?? version, superseded: false, ownerChanged: true })
    }
    if (ver.by?.own && (await anothers(ctx, a, ver.by))) {
      await takeStart(ctx, ver._id)
      await ctx.db.delete(ver._id)
      await removeLater(ctx, prefixOf(user._id, a._id, version), { grantMayBeLive: true })
      log('publish.refused', { reason: 'anothers', userId: user._id, artifactId: a._id, at: 'finish' }, 'warn')
      return remember({ slug: a.slug, version: a.currentVersion ?? version, superseded: false, anothers: true })
    }
    // A slower publish must not replace a newer one that finished first, even if the page has
    // since been rolled back to something older
    if ((a.highestLive ?? 0) > version) {
      await takeStart(ctx, ver._id)
      await ctx.db.delete(ver._id)
      await removeLater(ctx, prefixOf(user._id, a._id, version), { grantMayBeLive: true })
      return remember({ slug: a.slug, version: a.currentVersion ?? version, superseded: true })
    }
    const live = await ctx.db
      .query('versions')
      .withIndex('by_artifact_status', (q) => q.eq('artifactId', a._id).eq('status', 'live'))
      .take(10)
    for (const x of live) await ctx.db.patch(x._id, { status: 'retired' })
    await ctx.db.patch(ver._id, { status: 'live' })
    // Tour publication resets only the page checked above. An ordinary starting state fills
    // a page that has none; it never replaces the agent's existing state.
    const start = await takeStart(ctx, ver._id)
    if (ver.tour !== undefined && start !== null) {
      await startTourPage(ctx, a, ver.tour.name, start)
    } else if (start !== null) {
      // A state that holds only what the page stored for itself is no state of the agent's:
      // the starting state goes in beside it, and what the page stored stays
      await startState(ctx, user._id, a._id, start)
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
    // A conversation that made the page as its own has it too, where nobody did: by here the
    // page was not another conversation's, so it was made from a plain terminal.
    const owner = a.machineId ? await ctx.db.get(a.machineId) : null
    const moves =
      ver.by !== undefined &&
      (!owner || owner.revoked || ver.by.take || ver.by.own || a.currentVersion === undefined) &&
      (ver.by.machineId !== a.machineId || JSON.stringify(ver.by.session) !== JSON.stringify(a.session))
    await ctx.db.patch(a._id, {
      tour: ver.tour === undefined ? null : { name: ver.tour.name, identity: ver.tour.identity },
      currentVersion: version,
      highestLive: version,
      bytes,
      updatedAt: Date.now(),
      title: ver.title ?? a.title,
      ...(ver.by?.agentExplicit &&
      ver.by.agent !== undefined &&
      ver.by.machineId === a.machineId &&
      ver.by.session?.harness === a.session?.harness &&
      ver.by.session?.id === a.session?.id
        ? { agent: ver.by.agent }
        : {}),
      ...(moves ? { machineId: ver.by!.machineId, session: ver.by!.session, agent: ver.by!.agent ?? a.agent } : {}),
    })
    // Clicks already waiting on the page go where the page went
    if (moves) await ctx.scheduler.runAfter(0, internal.actions.readdress, { artifactId: a._id })
    // A conversation that published a page which stays another conversation's is told so. Left
    // unsaid, it tells its person "click and I will answer", and the clicks go to a conversation
    // that may have been closed the day before.
    const elsewhere =
      !moves &&
      ver.by?.session !== undefined &&
      a.session !== undefined &&
      (ver.by.machineId !== a.machineId || JSON.stringify(ver.by.session) !== JSON.stringify(a.session))
    // And one that took a page which another conversation had is told that too: what is done on it comes to it now
    const took = moves && a.currentVersion !== undefined && a.session !== undefined && ver.by?.session !== undefined
    return remember({ slug: a.slug, version, superseded: false, ...(elsewhere ? { elsewhere: true } : {}), ...(took ? { took: true } : {}) })
  },
})

/** Step two, after the uploads: check them, then switch the page to the new version. */
export const finish = action({
  args: { artifactId: v.id('artifacts'), version: v.number() },
  handler: async (ctx, args): Promise<{ slug: string; version: number; url: string; elsewhere?: boolean; took?: boolean }> => {
    const gate = await overClashes(() => ctx.runMutation(internal.publish._gate, args))
    if (gate.result) return outcome(gate.result)
    const waiting = gate.waiting!
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
    return outcome(done)
  },
})

/** How long an unfinished publish is kept before the sweep removes it. */
export const STAGING_MS = RETENTION.stagingHours * 3_600_000

function outcome(done: NonNullable<Doc<'publications'>['result']>) {
  if (done.tourConflict) fail('conflict', TOUR_CONFLICT)
  if (done.superseded) fail('conflict', 'A newer publish of this page finished first, so this one was not shown. Read the page before publishing again.')
  if (done.anothers) fail('conflict', ANOTHERS, { anothers: true })
  if (done.ownerChanged) fail('conflict', 'The page changed owner. Read it before publishing again.')
  return { slug: done.slug, version: done.version, url: done.url, ...(done.elsewhere ? { elsewhere: true } : {}), ...(done.took ? { took: true } : {}) }
}
