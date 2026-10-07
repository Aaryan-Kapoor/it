import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export const session = v.object({ harness: v.string(), id: v.string() })
export const fileEntry = v.object({ path: v.string(), size: v.number(), sha256: v.string() })
export const button = v.object({ label: v.string(), action: v.string() })
/**
 * What made a code, and so what made the session or the machine that came of it. `byMachine`
 * is the machine it descends from: the machine that asked for the code, or the one the session
 * that asked for it descends from in its turn. `bySession` is there when it was a session that
 * asked. Revoking a machine ends everything that names it here, and so does the owner ending
 * a session. A session's record goes a day after it ends, and what it let in may stay: that
 * still names the machine the session descended from, which is how it is found from above.
 * Only the machine the service enrols for itself names nothing: nobody invited it.
 */
const invitedBy = { byMachine: v.optional(v.id('machines')), bySession: v.optional(v.id('sessions')) }

export default defineSchema({
  // A person. There is one, whose subject is `owner`, made when the first machine is enrolled.
  users: defineTable({
    subject: v.string(),
    createdAt: v.number(),
    deletedAt: v.optional(v.number()),
  })
    .index('by_subject', ['subject'])
    .index('by_deleted', ['deletedAt']),

  // A person's running totals, kept apart from the person's own record (see lib/tally.ts):
  // clicks not yet handed to an agent, and publishes begun and not finished, by number and by
  // the bytes they declared. Both of the latter count against the quota.
  tallies: defineTable({ userId: v.id('users'), waiting: v.number(), stagingCount: v.number(), stagingBytes: v.number() }).index('by_user', ['userId']),

  // A browser that was paired, for as long as it stays paired. What its cookie holds is a
  // secret that is never kept here: only the hash of it, which is what it is found by.
  sessions: defineTable({
    userId: v.id('users'),
    secretHash: v.string(),
    /** `owner` is a browser paired with `it site`, which may do all a person can. `screen` is another display the owner paired, which may show pages and answer them. */
    role: v.union(v.literal('owner'), v.literal('screen')),
    createdAt: v.number(),
    /** When the browser last asked for a token, to within the hour. A session nothing has asked with for a year is ended. */
    lastSeenAt: v.number(),
    /** When the browser was last given its cookie, which lasts a year from then: at pairing, and again whenever it asks for a token with one more than a day old. */
    cookieAt: v.number(),
    /** Set when the session ends, however it ends. From then on the session is nobody. */
    endedAt: v.optional(v.number()),
    ...invitedBy,
  })
    .index('by_secret', ['secretHash'])
    // Those of a person that have not ended are read with `endedAt` given as nothing
    .index('by_user', ['userId', 'endedAt'])
    .index('by_ended', ['endedAt'])
    .index('by_seen', ['lastSeenAt'])
    .index('by_machine', ['byMachine', 'endedAt'])
    .index('by_session', ['bySession', 'endedAt']),

  // A code that lets one browser in, or one machine. Kept only as its hash, good for ten
  // minutes, and used once.
  invites: defineTable({
    userId: v.id('users'),
    codeHash: v.string(),
    role: v.union(v.literal('owner'), v.literal('screen'), v.literal('machine')),
    createdAt: v.number(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    ...invitedBy,
  })
    .index('by_code', ['codeHash'])
    .index('by_user', ['userId'])
    .index('by_expiry', ['expiresAt'])
    .index('by_machine', ['byMachine', 'expiresAt'])
    .index('by_session', ['bySession', 'expiresAt']),

  // A browser the person has paired, as the display it is. `key` only selects it; it is never a credential.
  displays: defineTable({
    userId: v.id('users'),
    key: v.string(),
    name: v.optional(v.string()),
    generatedName: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    /** Raised when the display is signed out, which it is whenever its session ends, and when it is forgotten. Showings opened before it stop working. */
    epoch: v.number(),
    /** What an agent asked this display to show, and when. */
    showing: v.optional(v.object({ artifactId: v.id('artifacts'), at: v.number() })),
    push: v.optional(v.object({ endpoint: v.string(), p256dh: v.string(), auth: v.string() })),
    /** The session of the browser that registered it: forgetting the display ends that session, and that session ending signs the display out. */
    sessionId: v.id('sessions'),
  })
    .index('by_user', ['userId'])
    .index('by_user_key', ['userId', 'key'])
    .index('by_session', ['sessionId'])
    .index('by_push_endpoint', ['push.endpoint']),

  // A display the person told It to forget. Its key is refused from then on, so a browser that
  // was closed at the time cannot quietly register itself again when it is next opened.
  forgotten: defineTable({ userId: v.id('users'), key: v.string(), at: v.number() })
    .index('by_user_key', ['userId', 'key'])
    .index('by_at', ['at']),

  // A machine where agents run, tied to the key its connector made at enrollment.
  machines: defineTable({
    userId: v.id('users'),
    name: v.string(),
    publicKey: v.object({ kty: v.literal('EC'), crv: v.literal('P-256'), x: v.string(), y: v.string() }),
    revoked: v.boolean(),
    /** When it was revoked, or when cleanup last left its record in place because a page still names it. */
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    connectorVersion: v.optional(v.string()),
    /** When its connector said it was stopping, if it has and has not been heard from since: the machine is off from then, and not only once it has been quiet for a while. */
    offAt: v.optional(v.number()),
    /** What the connector found installed, and what the person asked to be connected. */
    harnesses: v.optional(v.array(v.object({ id: v.string(), version: v.optional(v.string()), addon: v.string(), detail: v.optional(v.string()) }))),
    wanted: v.optional(v.array(v.string())),
    /** The agent apps whose closed conversations may be reopened on this machine for a click, and since when. The person's alone to say, from a browser of their own. */
    wakes: v.optional(v.array(v.object({ harness: v.string(), since: v.number() }))),
    /** The conversations this machine is running now because It reopened them, each since when, and whether someone has asked for it to be stopped. */
    runs: v.optional(v.array(v.object({ harness: v.string(), sessionId: v.string(), since: v.number(), stop: v.optional(v.boolean()) }))),
    /** The last few conversations a person stopped, and when: what was waiting for one by then is not reopened for. */
    stops: v.optional(v.array(v.object({ harness: v.string(), sessionId: v.string(), at: v.number() }))),
    /** The last few conversations that could not be reopened, when, and why in the connector's own words: never what a command printed. */
    fails: v.optional(v.array(v.object({ harness: v.string(), sessionId: v.string(), at: v.number(), why: v.string() }))),
    /** When it was last written down that this machine, revoked, asked for a token: said once an hour and not each time. */
    refusalSaidAt: v.optional(v.number()),
    /** The earlier identity of the same computer whose place this one took, if it took one's. */
    replaces: v.optional(v.id('machines')),
    /** And the later identity that took this one's place, so that what was on its way here finds where to go. */
    replacedBy: v.optional(v.id('machines')),
    ...invitedBy,
  })
    .index('by_user', ['userId', 'revoked'])
    .index('by_revoked', ['revoked', 'revokedAt'])
    .index('by_machine', ['byMachine', 'revoked'])
    .index('by_session', ['bySession', 'revoked']),

  projects: defineTable({
    userId: v.id('users'),
    key: v.string(),
    name: v.string(),
    createdAt: v.number(),
  }).index('by_user_key', ['userId', 'key']),

  // A page. Its bytes are kept by the content service; this is everything else.
  artifacts: defineTable({
    userId: v.id('users'),
    slug: v.string(),
    title: v.string(),
    projectId: v.optional(v.id('projects')),
    currentVersion: v.optional(v.number()),
    lastVersion: v.number(),
    /** The highest version that has ever gone live. A publish below it lost the race and must not go live later. */
    highestLive: v.optional(v.number()),
    bytes: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** Who made it and should hear about clicks: the machine, the conversation, and a label for people. */
    machineId: v.optional(v.id('machines')),
    session: v.optional(session),
    agent: v.optional(v.string()),
    pinned: v.optional(v.boolean()),
    folder: v.optional(v.string()),
    order: v.optional(v.number()),
    /** Clicks on this page not yet handed to an agent. */
    waiting: v.optional(v.number()),
  })
    .index('by_user_slug', ['userId', 'slug'])
    .index('by_user_updated', ['userId', 'updatedAt'])
    // Whether any page still names a machine, which is what keeps a revoked machine's record
    .index('by_machine', ['machineId']),

  versions: defineTable({
    artifactId: v.id('artifacts'),
    userId: v.id('users'),
    n: v.number(),
    files: v.array(fileEntry),
    bytes: v.number(),
    status: v.union(v.literal('staging'), v.literal('live'), v.literal('retired')),
    createdAt: v.number(),
    /** The title this version was published with. It becomes the page's title when the version goes live. */
    title: v.optional(v.string()),
    /** Who published it, and whether they said they were taking the page over. Acted on when the version goes live. */
    by: v.optional(
      v.object({
        machineId: v.id('machines'),
        session: v.optional(session),
        agent: v.optional(v.string()),
        take: v.boolean(),
        /** Published as a page of that conversation's own making: not shown where the id is by then another conversation's page. */
        own: v.optional(v.boolean()),
      }),
    ),
  })
    .index('by_artifact_n', ['artifactId', 'n'])
    .index('by_artifact_status', ['artifactId', 'status', 'n'])
    .index('by_status_created', ['status', 'createdAt']),

  // A page's state, as JSON text. Text, because a page may use any keys it likes and the
  // database's own objects may not.
  // `agentAt` is when the page's agent last changed the state, as opposed to the page itself:
  // it is how the site tells that an agent has answered what was done on the page
  states: defineTable({ artifactId: v.id('artifacts'), userId: v.id('users'), json: v.string(), revision: v.number(), agentAt: v.optional(v.number()) }).index(
    'by_artifact',
    ['artifactId'],
  ),

  // The state a publish asked for its page to start with, kept with that publish until it is
  // shown: a publish that is given up on, or loses to another, starts nothing.
  starts: defineTable({ versionId: v.id('versions'), artifactId: v.id('artifacts'), json: v.string() })
    .index('by_version', ['versionId'])
    .index('by_artifact', ['artifactId']),

  // Which revision each page's state is at, by itself: a state can be half a megabyte, and
  // whoever only needs to know whether it has changed should not have to read it.
  revisions: defineTable({ artifactId: v.id('artifacts'), revision: v.number() }).index('by_artifact', ['artifactId']),

  // Something a person did on a page. Stored before anything tries to deliver it.
  actions: defineTable({
    userId: v.id('users'),
    artifactId: v.id('artifacts'),
    displayId: v.optional(v.id('displays')),
    clientActionId: v.string(),
    name: v.string(),
    /** What the action carried, as JSON text. */
    payload: v.string(),
    contentVersion: v.number(),
    baseStateRevision: v.optional(v.number()),
    /** The page's title as it was at the version the person acted on, kept with the click so that it is still known when that version is gone. Empty where that version's title is not known. */
    title: v.string(),
    /** Whether the person was at the page when it was sent. The site says; the page cannot. */
    attended: v.optional(v.boolean()),
    createdAt: v.number(),
    /** Where the click is on its way to the agent. */
    delivery: v.union(v.literal('pending'), v.literal('leased'), v.literal('handed_off')),
    /** Where it should go: the machine and conversation that own the page. Never changed by delivery. */
    machineId: v.optional(v.id('machines')),
    harness: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    /** Who is delivering it right now, and until when. */
    leaseMachineId: v.optional(v.id('machines')),
    /** The machine that gave up delivering it by itself. Until its page changes hands it is left out of what connectors are offered, and still waits for `it wait` and the site. */
    parkedBy: v.optional(v.id('machines')),
    leaseExpiresAt: v.optional(v.number()),
    route: v.optional(v.string()),
    handedAt: v.optional(v.number()),
    /** What became of the work the click started, as far as It can tell. */
    outcome: v.optional(v.union(v.literal('running'), v.literal('succeeded'), v.literal('failed'), v.literal('unknown'))),
  })
    .index('by_artifact_client', ['artifactId', 'clientActionId'])
    .index('by_route', ['machineId', 'delivery', 'harness', 'sessionId', 'createdAt'])
    .index('by_harness', ['machineId', 'delivery', 'harness', 'createdAt'])
    .index('by_artifact', ['artifactId', 'createdAt'])
    .index('by_artifact_delivery', ['artifactId', 'delivery', 'createdAt'])
    .index('by_user_delivery', ['userId', 'delivery', 'createdAt'])
    .index('by_user_session', ['userId', 'delivery', 'harness', 'sessionId', 'createdAt'])
    // One person's clicks for one conversation by whose they are to deliver, oldest first: with
    // no machine and not set aside, they are the ones any of the person's machines may take
    .index('by_user_route', ['userId', 'delivery', 'harness', 'sessionId', 'machineId', 'parkedBy', 'createdAt'])
    .index('by_delivery_created', ['delivery', 'createdAt'])
    .index('by_delivery_handed', ['delivery', 'handedAt'])
    .index('by_delivery_lease', ['delivery', 'leaseExpiresAt']),

  // One showing of a page on a display. Each gets one ticket.
  mounts: defineTable({
    userId: v.id('users'),
    displayId: v.id('displays'),
    artifactId: v.id('artifacts'),
    version: v.number(),
    mountId: v.string(),
    createdAt: v.number(),
    ticketGiven: v.boolean(),
    /** The display's revocation number when the mount was made. A sign-out since then leaves the mount with no ticket to give. */
    epoch: v.number(),
  })
    .index('by_mount', ['mountId'])
    .index('by_created', ['createdAt'])
    // Whose they are, for erasing everything
    .index('by_user', ['userId']),

  notifications: defineTable({
    userId: v.id('users'),
    text: v.string(),
    artifactId: v.optional(v.id('artifacts')),
    displayId: v.optional(v.id('displays')),
    sticky: v.boolean(),
    buttons: v.optional(v.array(button)),
    /** What its page was showing when it was sent: pressing one of its buttons answers that, whatever the page shows by then. */
    contentVersion: v.optional(v.number()),
    stateRevision: v.optional(v.number()),
    title: v.optional(v.string()),
    createdAt: v.number(),
    seenAt: v.optional(v.number()),
    answeredAt: v.optional(v.number()),
    answer: v.optional(v.string()),
    dismissedAt: v.optional(v.number()),
    /** The displays this has already been pushed to, so a second pass does not push it twice. */
    pushedTo: v.optional(v.array(v.id('displays'))),
  })
    .index('by_user', ['userId', 'createdAt'])
    // What one display's tray holds: what is addressed to it (or to every display) and not dismissed
    .index('by_user_target', ['userId', 'displayId', 'dismissedAt', 'createdAt'])
    .index('by_created', ['createdAt']),

  // Things the content service has been asked to do and has not yet confirmed: ending a
  // display's sessions, deleting stored bytes. Kept until it says done, and tried again until then.
  contentJobs: defineTable({
    op: v.union(v.literal('revoke'), v.literal('delete')),
    body: v.string(),
    attempts: v.number(),
    nextAt: v.number(),
    createdAt: v.number(),
    /** Whose display or files it is about, so that none is left naming a person whose own record has gone. */
    userId: v.id('users'),
    /** For the last step of erasing everything: the person's record, to remove once their bytes are gone. */
    thenDeleteUser: v.optional(v.id('users')),
  })
    .index('by_next', ['nextAt'])
    .index('by_user', ['userId'])
    .index('by_user_to_delete', ['thenDeleteUser']),

  // The key the backend signs with, made the first time one is needed. Only internal functions read this table.
  signingKeys: defineTable({ kid: v.string(), privateJwk: v.any(), publicJwk: v.any(), createdAt: v.number() }),

  // Machine proofs already used, so one cannot be used twice inside its minute.
  spentProofs: defineTable({ key: v.string(), expiresAt: v.number() }).index('by_key', ['key']).index('by_expiry', ['expiresAt']),

  // Token buckets for rate limits.
  rateLimits: defineTable({
    key: v.string(),
    /** Whom or what the bucket counts against, by its id, so that it can go when that record is erased. A line said only so often counts against nobody. */
    who: v.optional(v.string()),
    tokens: v.number(),
    updatedAt: v.number(),
    /** When it was last written down that this limit had been reached, so that it is said once a minute and not each time. */
    saidAt: v.optional(v.number()),
  })
    .index('by_key', ['key'])
    .index('by_who', ['who'])
    .index('by_updated', ['updatedAt']),

  // Whether the service answers other devices on the person's network, and the addresses it is
  // reached at there, as the service last said. `wanted` is what its settings asked for when
  // it said so, which is not the same where it could not listen on the network. With it, what
  // the service said of itself: whether It is registered to start by itself (`background`), and
  // whether counts of its use are being sent (`usage`). Neither is there while it has not said.
  // One row.
  network: defineTable({
    on: v.boolean(),
    wanted: v.boolean(),
    addresses: v.array(v.string()),
    background: v.optional(v.boolean()),
    usage: v.optional(v.boolean()),
  }),
})
