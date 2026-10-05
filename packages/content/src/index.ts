// The content service: private viewing, uploads, and the few things the backend asks of it.
//
// Every page is shown from one port, the one after the site's, and nothing that port sends is
// given an origin in a browser. Every answer from it, of every kind, tells the browser to treat
// what it carries as a sandboxed document: one whose origin is its own and is shared with
// nothing. So a page has no cookies and none of the browser's storage, and cannot read the
// site, another page, or an earlier document of itself, however long that document stays open.
//
// With no origin to tell showings apart by, each showing's files are served under a path that
// holds a token nobody can guess. The site frames `/open/<ticket>`, where the ticket is signed
// by the backend and works once. The service checks it, makes the token, remembers what it is
// for, and sends the frame on to the page under `/s/<token>/`. From there the token in the
// path is all that is asked of a request: no cookie is ever set or read, and nothing a request
// says of where it came from is believed or needed.
//
// A token is remembered in memory and nowhere else, so a showing ends when the service stops.
// It also ends when nothing has asked under it for ten minutes, when it is a day old, when its
// display is signed out, and when what it shows is deleted. The script It puts in a page asks
// every few minutes, which keeps the showing of a page that sits still, and tells the site
// when it is over.
//
// The backend and this service share no secret. Everything the backend sends (tickets, upload
// grants, control messages) is signed, and checked here against the backend's public keys.
import { createHash, randomBytes } from 'node:crypto'
import { AUDIENCE, contentPort, contentType, isSafePath, LIMITS, onThisMachine, policyHost, SANDBOX } from '@it/protocol'
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose'
import { createFiles, type Files, nameOf } from './files'
import { createLimits, type Limits } from './limits'
import { createLog, kind, type Log } from './log'
import { withTags } from './page'
import { createRecords, type Records } from './records'
import { RUNTIME, RUNTIME_VERSION } from './runtime.generated'

export interface ContentSettings {
  /** Where page files are kept. */
  dir: string
  /** A folder for the service's own small database. */
  data: string
  /** The port the site is on. Pages are shown from the one after it. */
  basePort: number
  /** The backend's own address for HTTP: where its public keys are read, and the issuer of everything it signs. */
  backendSite: string
  /**
   * How the backend is asked for its public keys, taken and answered as `fetch` is. The backend
   * is on this machine, so whoever runs the service gives a way that no proxy named in the
   * environment is ever part of.
   */
  fetch: (address: string, init: { headers: Headers; signal: AbortSignal }) => Promise<Response>
  /** Takes each line the service writes down, to put it where a person can read it. */
  say: (line: string) => void
  /**
   * Told when everything of one person's has been deleted here, with that person's id, so that
   * whoever runs the service can remove what else it keeps of theirs. It is waited for, and
   * the backend is answered that the deletion is done only once it has ended well: a deletion
   * is asked for again until it is, so this may be told of the same person more than once.
   */
  erased?: (person: string) => void | Promise<void>
}
/** The port a request came in on, and the address of whoever sent it. */
export interface Asked {
  port: number
  address: string
}

/** One showing of a page: what its ticket said, and when it was opened and last asked under. */
interface Showing {
  mount: string
  person: string
  display: string
  /** The display's sign-out number when the ticket was made. */
  epoch: number
  /** The page's id, for the page's own use. */
  page: string
  /** Where this version's bytes are kept. */
  prefix: string
  version: string
  made: number
  used: number
}

interface Service {
  settings: ContentSettings
  files: Files
  records: Records
  limits: Limits
  log: Log
  keys: ReturnType<typeof createRemoteJWKSet>
  /** Every live showing, by the SHA-256 of its token: the tokens themselves are kept nowhere. */
  showings: Map<string, Showing>
  /** When the showings that have ended were last cleared away. */
  swept: number
}

// Where bytes are kept: u/<person>/<page>/<version>/. Each part is a plain id, so a prefix can
// never mean more than it says.
const VERSION_PREFIX = /^u\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[0-9]+\/$/
const ANY_PREFIX = /^u\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]+\/([0-9]+\/)?)?$/
/** Everything of one person's. */
const PERSON_PREFIX = /^u\/([A-Za-z0-9_-]+)\/$/
const MOUNT = /^[0-9a-f]{32}$/
/** A token as it is written in a path: 32 random bytes. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/
/** How long a showing lasts, however often it is asked under. */
const LIFE_S = 24 * 3600
/** The longest a ticket may say it is good for, with the few seconds two clocks may differ by. */
const TICKET_S = 65
/**
 * How long a showing lasts with nothing asked under it. Never less than ten minutes: the script
 * in a page asks every three, and a tab in the background may ask a minute late. A shorter time
 * would run out under a page that is doing everything right, and what was typed into it would
 * be lost.
 */
const IDLE_S = 600
/** How often the showings that have ended are cleared out of memory. */
const SWEEP_S = 60
/** How many files one request to delete removes at most. The backend asks again while there are more. */
const REMOVED_AT_ONCE = 10_000
const now = () => Math.floor(Date.now() / 1000)
const enc = new TextEncoder()

// ---------- replies ----------

/** Headers for every reply on the site's port: nothing to cache, sniff, embed or frame. */
const PLAIN: Record<string, string> = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...PLAIN, 'content-type': 'application/json', ...headers } })
/** A refusal never carries bytes, and never says why in a way that helps a guesser. */
const deny = (status = 401, headers: Record<string, string> = {}) => new Response(null, { status, headers: { ...PLAIN, 'content-length': '0', ...headers } })

// ---------- what the pages' port tells a browser ----------
//
// The sandbox is the whole of what keeps one page from another, so it is said on every answer
// the pages' port gives: a file, a refusal, a redirect, a fault. A document that arrives with it
// has an origin of its own, in the site's frame or in a tab by itself, and so does every
// document it loads or window it opens.
//
// A sandboxed document is another origin even to its own files. A page's module scripts, its
// fonts and what it fetches are only given to it if the answer says any origin may read them,
// and its plain scripts, styles and pictures only if the answer says another origin may embed
// them. Both are said on every answer. Neither gives anything away: there is no cookie for a
// browser to send along, and whoever asks under a token already holds everything the token is
// good for.

/** A host as a `Host` header names it, without its port: a name, an address, or an address in brackets. */
const HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9_](?:[a-z0-9._-]*[a-z0-9_])?)(?::[0-9]{1,5})?$/i
/**
 * The site's own address as the browser that sent a request knows it: the host name the request
 * was sent to, on the site's port. Null when what was sent is no host name, since it is about
 * to be written into a header and into a page.
 *
 * `inPolicy` asks for the address as a policy can name it. A policy can name a host only in
 * letters, digits, dots and hyphens. An IPv6 address is none of those, and neither is a
 * machine's name with an underscore in it: no browser takes either as a source, and with one
 * written there nothing may frame the answer, the site included. Where the site was reached by
 * such a name, the site's port is named on every host under the longest ending of the name
 * that a policy can say, or on any host where it can say none of it, which is as near as a
 * policy comes to it.
 */
function siteAt(basePort: number, named: string | null, secure: boolean, inPolicy = false): string | null {
  const host = named !== null && named.length <= 260 ? HOST.exec(named)?.[1]?.toLowerCase() : undefined
  if (!host) return null
  try {
    const site = new URL(`${secure ? 'https' : 'http'}://${host}:${basePort}`)
    const said = policyHost(site.hostname)
    return inPolicy && said !== site.hostname ? `${site.protocol}//${said}${site.port ? `:${site.port}` : ''}` : site.origin
  } catch {
    return null
  }
}
/**
 * The policy every answer from the pages' port carries: the sandbox, and that only the site may
 * frame it. The site's address is worked out from the `Host` header of the request being
 * answered, and with none that can be read nothing may frame the answer at all.
 */
export function pagePolicy(basePort: number, host: string | null, secure = false): string {
  return `sandbox ${SANDBOX}; frame-ancestors ${siteAt(basePort, host, secure, true) ?? "'none'"}`
}
/** Headers for every answer on the pages' port. */
const paged = (policy: string): Record<string, string> => ({
  'content-security-policy': policy,
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'cross-origin',
  'access-control-allow-origin': '*',
})

// ---------- signatures ----------

/** Something this service depends on did not answer. The caller is told to try again, and it is logged by its reason. */
class Unavailable extends Error {
  constructor(
    readonly reason: 'backend_keys' | 'storage',
    /** What kind of trouble it was, when the system gave it a code. */
    readonly kind?: string,
  ) {
    super(reason)
  }
}
/** What the checker says of a token when the trouble is fetching the backend's keys, and not the token. */
const KEYS_TROUBLE = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC'])
/** Checks something the backend signed: its signature, who signed it, who it is for, and that it is unexpired. */
async function fromBackend(
  it: Service,
  token: string | null | undefined,
  audience: string,
  /** Told why a token was refused, for the log: the checker's own code for it, never the token. */
  why: (reason: string) => void = () => {},
): Promise<Record<string, unknown> | null> {
  if (!token) {
    why('none_sent')
    return null
  }
  try {
    const { payload } = await jwtVerify(token, it.keys, {
      issuer: it.settings.backendSite,
      audience,
      algorithms: ['ES256'],
      requiredClaims: ['exp', 'iat', 'jti', 'sub'],
      clockTolerance: 5,
    })
    return payload
  } catch (err) {
    // A token that is not good is refused. Not being able to fetch the backend's keys is this
    // side's trouble, not the caller's, and is answered as such, so that the caller tries again.
    if (!(err instanceof errors.JOSEError) || KEYS_TROUBLE.has(err.code)) throw new Unavailable('backend_keys', kind(err))
    why(err.code)
    return null
  }
}
const bearer = (request: Request) => (request.headers.get('authorization') ?? '').match(/^Bearer (\S+)$/)?.[1] ?? null

// ---------- showings ----------

/** What a token is remembered under. */
const under = (token: string) => createHash('sha256').update(token).digest('base64url')
const ended = (s: Showing, at: number) => at - s.used >= IDLE_S || at - s.made >= LIFE_S

/**
 * Counts one request against a limit. The key is written down beside the limit's name, and is
 * always something this service or the backend signed, never anything a caller chose.
 */
function limited(it: Service, name: keyof Limits, key: string): boolean {
  if (!it.limits[name](key)) return false
  it.log.seldom('rate_limited', `${name}:${key}`, { limiter: name, key })
  return true
}

/**
 * Whether everything of a person's was deleted, which the records say for as long as anything
 * signed for them before that could still be good. From then on nothing is counted under
 * their id and nothing is remembered of having been said about them: what is refused for it
 * is said under one name for all such refusals, with no id in it.
 */
const erased = (it: Service, person: string): boolean => it.records.wasDeleted(`u/${person}/`)
/** Lets go of what this service counted under a person's id, and of what it remembers having said about them. */
function forgetPerson(it: Service, person: string): void {
  for (const limit of Object.values(it.limits)) limit.forget(person)
  it.log.forget(person)
}

/** The showing a token is for, if it is still going: checked against the clock, against sign-outs, and against what was deleted. */
function showingOf(it: Service, token: string): Showing | 'slow down' | null {
  if (!TOKEN.test(token)) return null
  const key = under(token)
  const s = it.showings.get(key)
  if (!s) return null
  const at = now()
  if (ended(s, at)) {
    it.showings.delete(key)
    return null
  }
  // Counted before anything is looked up: a page that asks without end is slowed down, for that
  // showing only, and costs the records nothing
  if (limited(it, 'READS', `${s.person}:${s.display}:${s.mount}`)) return 'slow down'
  // And by person: any number of showings together may ask only so much
  if (limited(it, 'READS_PERSON', s.person)) return 'slow down'
  // Signed out since it was opened
  if (s.epoch < it.records.signedOut(s.person, s.display)) {
    it.showings.delete(key)
    it.log.seldom('showing.refused', `${s.person}:${s.display}`, { reason: 'signed_out', u: s.person, d: s.display }, 'info')
    return null
  }
  // What it shows was deleted since. The service that was told so ended its own showings then;
  // this is how one that was not told, with the same folder open, learns of it
  if (it.records.wasDeleted(s.prefix)) {
    it.showings.delete(key)
    // Where it was everything of the person's, this is how this service hears of it, and it lets go of what it held under their id as the one that was told did
    if (erased(it, s.person)) {
      forgetPerson(it, s.person)
      it.log.seldom('showing.refused', 'deleted', { reason: 'deleted' }, 'info')
    } else it.log.seldom('showing.refused', `${s.person}:${s.display}`, { reason: 'deleted', u: s.person, d: s.display }, 'info')
    return null
  }
  s.used = at
  return s
}

/** Reads a small body as text, refusing one that is larger than it has any reason to be. */
async function smallBody(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (!Number.isFinite(declared) || declared > max || !request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

// ---------- bytes ----------

/** One range: "bytes=a-b", "bytes=a-" or "bytes=-n". Anything else is ignored, which the standard allows. */
function parseRange(header: string | null, size: number): { offset: number; length: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '')
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0) return 'unsatisfiable'
    start = Math.max(size - n, 0)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { offset: start, length: end - start + 1 }
}

/** An answer on the pages' port that carries no bytes. */
type Bare = (status: number, headers?: Record<string, string>) => Response

/** The two tags that put `It` in a page: what the page is, and the script itself. */
function itTags(site: string, token: string, s: Showing): Uint8Array {
  const config = JSON.stringify({ app: site, id: s.page, version: Number(s.version), keep: `/s/${token}/__it/keep` }).replace(/</g, '\\u003c')
  return enc.encode(`<script>window.__IT__=${config}</script><script src="/__it/runtime.${RUNTIME_VERSION}.js"></script>`)
}

/** One of a showing's files, or as much of it as was asked for. */
async function serveBytes(
  it: Service,
  request: Request,
  at: { site: string; token: string; showing: Showing; says: Record<string, string>; bare: Bare },
  version: string,
  rawPath: string,
): Promise<Response> {
  const s = at.showing
  // A showing is of one version: the one its ticket named
  if (version !== s.version) return at.bare(404)
  let file: string
  try {
    file = decodeURIComponent(rawPath)
  } catch {
    return at.bare(404)
  }
  if (!isSafePath(file)) return at.bare(404)
  const stored = await it.files.open(s.prefix, file)
  if (!stored) return at.bare(404)
  const type = contentType(file)
  const html = type.startsWith('text/html')
  const headers: Record<string, string> = { ...at.says, 'content-type': type, 'accept-ranges': html ? 'none' : 'bytes', etag: stored.etag }
  /** The answer itself, or for a request that asks only what the answer would be, its headers and no bytes. */
  const give = async (status: number, bytes: () => ReadableStream<Uint8Array>) => {
    if (request.method !== 'HEAD') return new Response(bytes(), { status, headers })
    await stored.close()
    return new Response(null, { status, headers })
  }
  // A page's HTML is given whole or not at all. What a browser opens as a document is not the
  // file as it is stored, since It is put into it, and a part of the one is no part of the other.
  // A part of any other file is given only of the file as it is: a request that says which
  // file it has the rest of, and has another, is given the whole of this one.
  const sameFile = (request.headers.get('if-range') ?? stored.etag) === stored.etag
  const range = html || !sameFile ? null : parseRange(request.headers.get('range'), stored.size)
  if (range === 'unsatisfiable') {
    await stored.close()
    return at.bare(416, { 'content-range': `bytes */${stored.size}` })
  }
  if (range) {
    headers['content-range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${stored.size}`
    headers['content-length'] = String(range.length)
    return give(206, () => stored.bytes(range))
  }
  // A browser opening a document says that it will take HTML, and that is when It is put in the
  // page. A page that fetches one of its own HTML files is given the file as it was published.
  if (html && (request.headers.get('accept') ?? '').includes('text/html')) {
    const tags = itTags(at.site, at.token, s)
    // What is sent is the file with It in it, which the file's own mark does not describe. Nor is
    // it said how long it is: that is known only once the whole page has been read.
    delete headers.etag
    return give(200, () => withTags(stored.bytes(), tags))
  }
  headers['content-length'] = String(stored.size)
  return give(200, () => stored.bytes())
}

// ---------- the pages' port ----------

/** Trades a ticket for a showing, and sends whoever asked on to the page under its token. */
async function open(it: Service, ticket: string, bare: Bare): Promise<Response> {
  // A ticket is under two kilobytes. Nothing larger is looked at.
  let reason = 'shape'
  const t =
    ticket.length > 4000
      ? null
      : await fromBackend(it, ticket, AUDIENCE.ticket, (code) => {
          reason = code
        })
  const ok =
    t &&
    typeof t.m === 'string' &&
    MOUNT.test(t.m) &&
    t.sub === t.m &&
    (t.exp as number) - (t.iat as number) <= TICKET_S &&
    ['a', 'v', 's', 'u', 'd', 'p'].every((k) => typeof t[k] === 'string') &&
    /^[0-9]+$/.test(t.v as string) &&
    Number.isInteger(t.e) &&
    (t.e as number) >= 0 &&
    VERSION_PREFIX.test(t.p as string)
  if (!ok) {
    // Not a ticket the backend made for a showing: forged, altered or expired. Anyone can send
    // one as often as they like, so it is said by its reason alone
    it.log.seldom('ticket.refused', reason, { reason })
    return bare(401)
  }
  const mount = t.m as string
  const who = { u: t.u as string, d: t.d as string }
  const epoch = t.e as number
  // Both at once, so that nothing can come between: the ticket is spent, and what it says of
  // sign-outs is taken in.
  const traded = it.records.together(() => {
    const known = it.records.signedOut(who.u, who.d)
    if (epoch < known) return { is: 'from_before_a_sign_out' as const, known }
    // A ticket made after a sign-out carries the new number. If word of that sign-out never
    // arrived here, this is how it arrives: showings from before it end now.
    if (epoch > known) it.records.raise(who.u, who.d, epoch)
    // A ticket made before its page was deleted opens nothing after
    if (it.records.wasDeleted(t.p as string)) return { is: 'deleted' as const, known }
    return { is: it.records.spend(t.jti as string, t.exp as number), known }
  })
  // With a lower number remembered, word of a sign-out was lost on its way here. With none, the
  // sign-out was long enough ago to be remembered no more, or its word was lost: either way
  // the ticket has now said it.
  if (traded.is !== 'from_before_a_sign_out' && epoch > traded.known)
    it.log.log('revocation.learned', { ...who, from: traded.known, to: epoch, by: 'ticket' }, traded.known > 0 ? 'warn' : 'info')
  if (traded.is !== 'ok') {
    // From before a sign-out; for something deleted; or presented a second time, which is a retry whose first answer was lost, or a copy
    const why = traded.is === 'spent' ? 'already_used' : traded.is
    if (erased(it, who.u)) it.log.seldom('ticket.refused', 'deleted', { reason: 'deleted' })
    else it.log.seldom('ticket.refused', `${who.u}:${who.d}:${traded.is}`, { mount, ...who, reason: why })
    return bare(401)
  }
  const at = now()
  if (at - it.swept >= SWEEP_S) {
    it.swept = at
    for (const [key, s] of it.showings) if (ended(s, at)) it.showings.delete(key)
  }
  const token = randomBytes(32).toString('base64url')
  it.showings.set(under(token), {
    mount,
    person: who.u,
    display: who.d,
    epoch,
    page: t.s as string,
    prefix: t.p as string,
    version: t.v as string,
    made: at,
    used: at,
  })
  // The one line that says a display opened a page
  it.log.log('showing.opened', { ...who, page: t.a as string, version: t.v as string, mount })
  return bare(303, { location: `/s/${token}/v/${t.v}/index.html` })
}

async function showing(it: Service, request: Request, asked: Asked, bare: Bare, says: Record<string, string>, site: string | null): Promise<Response> {
  // A page is told where the site is, from the name the request was sent to. What is no host
  // name is written nowhere, so a request without one is answered with nothing.
  if (asked.port !== contentPort(it.settings.basePort) || !site) return bare(404)
  const { method } = request
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return bare(405, { allow: 'GET, HEAD, OPTIONS' })
  const path = new URL(request.url).pathname
  const reads = method !== 'OPTIONS'

  if (reads && path === `/__it/runtime.${RUNTIME_VERSION}.js`) {
    // The same for every page, and named after what is in it: the one answer a browser may keep
    const headers = { ...says, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' }
    return new Response(method === 'HEAD' ? null : RUNTIME, { headers })
  }

  const ticket = method === 'GET' ? path.match(/^\/open\/([^/]+)$/)?.[1] : undefined
  if (ticket) return open(it, ticket, bare)

  const held = path.match(/^\/s\/([^/]+)\/(.+)$/)
  if (!held) return bare(404)
  const token = held[1]!
  const rest = held[2]!
  const s = showingOf(it, token)
  if (s === 'slow down') return bare(429)
  if (!s) return bare(401)

  // A page's script that sends a header of its own makes the browser ask first whether it may.
  // It may read: nothing here is ever changed by a request.
  if (method === 'OPTIONS')
    return bare(204, { 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': '*', 'access-control-max-age': '600' })

  // The script in the page asks this every few minutes while the page is open, so a page that
  // sits still keeps its showing. A refusal tells it the showing is over, and the site shows the
  // page again.
  if (rest === '__it/keep') return bare(204)

  const file = rest.match(/^v\/([0-9]+)\/(.+)$/)
  if (file) return serveBytes(it, request, { site, token, showing: s, says, bare }, file[1]!, file[2]!)
  return bare(404)
}

// ---------- uploads, for machines ----------

async function upload(it: Service, request: Request): Promise<Response> {
  const named = new URL(request.url).pathname.match(/^\/upload\/(.+)$/)
  if (request.method !== 'PUT' || !named) return deny(404)
  let reason = 'shape'
  const grant = await fromBackend(it, bearer(request), AUDIENCE.upload, (code) => {
    reason = code
  })
  if (!grant || typeof grant.p !== 'string' || grant.sub !== grant.p || !VERSION_PREFIX.test(grant.p)) {
    // Anyone can send an upload with no grant, or a made-up one, as often as they like
    it.log.seldom('upload.refused', `grant:${reason}`, { reason: `grant:${reason}` })
    return deny()
  }
  const prefix = grant.p
  const person = prefix.split('/')[1]!
  /** Refuses the upload and says why, with where it was going and never which file: or with neither, once everything of the person's was deleted. */
  const refuse = (status: number, why: string) => {
    if (erased(it, person)) it.log.seldom('upload.refused', 'deleted', { reason: 'deleted' })
    else it.log.seldom('upload.refused', `${prefix}:${why}`, { prefix, reason: why })
    return deny(status)
  }
  // A grant is good for a quarter of an hour, and may outlast the person it was made for. What
  // marks their files as removed is looked at first, before anything is counted under their id
  if (erased(it, person)) return refuse(403, 'deleted')
  // By person before anything is looked up, and by version: many versions at once must not
  // add up to more than one person may ask of the disk
  if (limited(it, 'UPLOADS_PERSON', `upload:${person}`)) return deny(429)
  if (limited(it, 'UPLOADS', `upload:${prefix}`)) return deny(429)
  let file: string
  try {
    file = decodeURIComponent(named[1]!)
  } catch {
    return refuse(400, 'bad_path')
  }
  // The grant allows exactly the files the backend declared for this version: each at its
  // declared path, with its declared size and its declared checksum. So nothing undeclared can
  // be stored, the total is what was counted against the quota, and writing a file a second
  // time, even after the version went live, can only write the same bytes again. What was
  // declared is read each time: once a version is deleted its declaration goes too, and from
  // that moment nothing more may be written under it.
  const declared = isSafePath(file) ? (await it.files.declared(prefix))?.get(file) : undefined
  if (!declared) return refuse(403, 'not_declared')
  const length = request.headers.get('content-length')
  if (length === null || Number(length) !== declared.size || request.headers.get('x-it-sha256') !== declared.sha256) return refuse(400, 'not_as_declared')
  // A file may be empty, and a request for one may arrive with no body at all
  if (!request.body && declared.size !== 0) return refuse(400, 'no_body')
  // The bytes are checked against the size and the checksum as they arrive, and a file is put
  // in place only when it is whole and right. Bytes that are not what was declared are the
  // caller's mistake. Anything else is the disk's trouble, and the caller is told to try again.
  const written = await it.files.write(prefix, file, request.body, declared).catch((err) => {
    throw new Unavailable('storage', kind(err))
  })
  // If the version was deleted while this was arriving, its declaration is gone, and what was
  // just written would be left behind with nothing pointing at it. It is taken out again.
  if (written === 'no_folder') return refuse(403, 'version_deleted_meanwhile')
  if (written !== 'ok') return refuse(400, written)
  if (!(await it.files.declared(prefix))) {
    await it.files.remove(prefix, file)
    return refuse(403, 'version_deleted_meanwhile')
  }
  return json(200, { ok: true })
}

// ---------- what the backend asks ----------

async function control(it: Service, request: Request, asked: Asked): Promise<Response> {
  const op = new URL(request.url).pathname.match(/^\/control\/(revoke|stage|verify|delete)$/)?.[1]
  if (request.method !== 'POST' || !op) return deny(404)
  // Only the backend sends these. One that does not check out is either someone trying the
  // door or a fault between the two halves of the service, and either way wants looking at.
  const refuse = (status: number, reason: string) => {
    // And anyone can send one of these with no signature at all, as often as they like
    it.log.seldom('control.refused', `${op}:${reason}`, { op, reason }, 'error')
    return deny(status)
  }
  // The backend runs on this machine, and asks from it. Nothing from anywhere else is looked at.
  if (!onThisMachine(asked.address)) return refuse(404, 'not_this_machine')
  let reason = 'for_another_operation'
  const signed = await fromBackend(it, bearer(request), AUDIENCE.control, (code) => {
    reason = code
  })
  if (!signed || signed.sub !== op) return refuse(401, reason)
  // The signature covers the body too: a message cannot be replayed with different contents
  const text = await smallBody(request, 512 * 1024)
  if (text === null) return refuse(400, 'body_too_long')
  if (signed.h !== createHash('sha256').update(text).digest('hex')) return refuse(401, 'body_not_the_one_signed')
  let body: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch {}
  if (!body) return refuse(400, 'malformed')

  if (op === 'revoke') {
    if (typeof body.userId !== 'string' || typeof body.displayId !== 'string' || !Number.isInteger(body.epoch)) return refuse(400, 'malformed')
    const epoch = it.records.raise(body.userId, body.displayId, body.epoch as number)
    it.log.log('control.revoke', { u: body.userId, d: body.displayId, epoch })
    return json(200, { epoch })
  }
  if (typeof body.prefix !== 'string' || !ANY_PREFIX.test(body.prefix)) return refuse(400, 'malformed')
  const prefix = body.prefix
  const files = Array.isArray(body.files) ? (body.files as { path: unknown; size: unknown; sha256: unknown }[]) : []

  if (op === 'stage') {
    // The backend declares a version's files before it gives anyone a grant to upload them
    if (!VERSION_PREFIX.test(prefix) || files.length === 0 || files.length > LIMITS.filesPerVersion) return refuse(400, 'malformed')
    const clean: { path: string; size: number; sha256: string }[] = []
    for (const f of files) {
      if (!isSafePath(f.path) || !Number.isInteger(f.size) || (f.size as number) < 0 || (f.size as number) > LIMITS.fileBytes) return refuse(400, 'malformed')
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return refuse(400, 'malformed')
      clean.push({ path: f.path, size: f.size as number, sha256: f.sha256 })
    }
    // A version that was deleted stays deleted: a message to declare its files that arrives
    // after, late or sent a second time, declares nothing. It is asked again once the files are
    // declared, in case the version was deleted in between: the deletion is noted before
    // anything is removed, so one of the two always finds the other.
    if (it.records.wasDeleted(prefix)) return refuse(409, 'version_deleted')
    await it.files.declare(prefix, clean)
    if (it.records.wasDeleted(prefix)) {
      await it.files.clear(prefix, REMOVED_AT_ONCE)
      return refuse(409, 'version_deleted')
    }
    it.log.log('control.stage', { prefix, files: clean.length })
    return json(200, { ok: true })
  }

  if (op === 'verify') {
    if (!VERSION_PREFIX.test(prefix)) return refuse(400, 'malformed')
    // What is stored under the version is read back from the disk: every file there, its size,
    // and the checksum of the bytes it holds now
    const stored = await it.files.stored(prefix)
    const wanted = new Set<string>()
    const missing: string[] = []
    for (const f of files.slice(0, LIMITS.filesPerVersion)) {
      const name = isSafePath(f.path) ? nameOf(f.path) : null
      if (name) wanted.add(name)
      const intact = name !== null && stored.get(name) === f.size && (await it.files.checksum(prefix, name)) === f.sha256
      if (!intact) missing.push(String(f.path))
    }
    // Nothing may be there that was not declared. What is there is known by the path it was declared under
    const extra = [...stored.keys()].filter((name) => !wanted.has(name))
    const paths = new Map<string, string>()
    if (extra.length > 0) for (const path of (await it.files.declared(prefix))?.keys() ?? []) paths.set(nameOf(path), path)
    it.log.log('control.verify', { prefix, ok: missing.length === 0 && extra.length === 0, missing: missing.length, notDeclared: extra.length })
    return json(200, {
      ok: missing.length === 0 && extra.length === 0,
      missing: [...missing, ...extra.map((name) => `(not declared) ${paths.get(name) ?? 'a file declared earlier'}`)].slice(0, 50),
    })
  }

  // delete: everything under the prefix, so many at a time, and what was declared for it. The
  // backend asks again while `more` is true. That it was deleted is noted first, so that
  // nothing is declared under it again and no ticket opens it, and every showing of it ends at
  // once: a document that is still open is told so the next time it asks to be kept.
  it.records.deleted(prefix)
  let ended = 0
  for (const [key, s] of it.showings) if (s.prefix.startsWith(prefix) && it.showings.delete(key)) ended += 1
  const { removed, more } = await it.files.clear(prefix, REMOVED_AT_ONCE)
  it.log.log('control.delete', { prefix, removed, more, showings: ended })
  // With the last of a whole person's files gone, what this service counted and remembered
  // saying under their id is let go of, and whoever runs the service is told
  const person = more ? undefined : PERSON_PREFIX.exec(prefix)?.[1]
  if (person !== undefined) {
    forgetPerson(it, person)
    await it.settings.erased?.(person)
  }
  return json(200, { removed, more })
}

// ---------- entry ----------

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'])
/** Answers a request, and whatever goes wrong while doing so. */
async function answer(
  it: Service,
  part: 'a showing' | 'upload' | 'control',
  request: Request,
  work: () => Promise<Response>,
  /** The answer when it cannot be done: one that carries no bytes, in the headers of the port it is given on. */
  cannot: (status: number) => Response = deny,
): Promise<Response> {
  try {
    return await work()
  } catch (err) {
    // Said in the log, so that a wrong setting does not look the same as a forged token: which
    // part and which method, and what kind of trouble it was. Never the address asked for,
    // and never the error's own words, which can quote what was sent.
    const method = METHODS.has(request.method) ? request.method : 'other'
    const unavailable = err instanceof Unavailable
    it.log.seldom(
      unavailable ? 'unavailable' : 'unexpected',
      `${part}:${method}:${unavailable ? err.reason : kind(err)}`,
      { part, method, ...(unavailable ? { reason: err.reason, kind: err.kind } : { kind: kind(err) }) },
      'error',
    )
    return cannot(unavailable ? 503 : 500)
  }
}

/**
 * The content service, for whoever listens on its ports. A request that came in on the pages'
 * port is `showing`'s; `PUT /upload/...` and `POST /control/...` on the site's port are
 * `upload`'s and `control`'s. Each is told the port the request came in on and the address it
 * came from, which no header is trusted to say.
 */
export function createContent(settings: ContentSettings): {
  showing(request: Request, asked: Asked): Promise<Response>
  upload(request: Request, asked: Asked): Promise<Response>
  control(request: Request, asked: Asked): Promise<Response>
  close(): Promise<void>
} {
  if (!Number.isInteger(settings.basePort) || settings.basePort < 1) throw new Error('The content service needs the port the site is on.')
  const backendSite = settings.backendSite.replace(/\/+$/, '')
  const it: Service = {
    settings: { ...settings, backendSite },
    files: createFiles(settings.dir),
    records: createRecords(settings.data, LIFE_S + TICKET_S),
    limits: createLimits(),
    log: createLog(settings.say),
    keys: createRemoteJWKSet(new URL(`${backendSite}/.well-known/jwks.json`), {
      cooldownDuration: 10_000,
      cacheMaxAge: 600_000,
      [customFetch]: (address, init) => settings.fetch(address, { headers: init.headers, signal: init.signal }),
    }),
    showings: new Map(),
    swept: now(),
  }
  return {
    showing(request, asked) {
      // Worked out before anything else, and put on whatever is answered, a fault included
      const url = new URL(request.url)
      const secure = url.protocol === 'https:'
      const host = request.headers.get('host') ?? url.host
      const says = paged(pagePolicy(settings.basePort, host, secure))
      // An answer with no bytes says so, but for the one status that by its nature has none
      const bare: Bare = (status, headers = {}) =>
        new Response(null, { status, headers: { ...says, ...(status === 204 ? {} : { 'content-length': '0' }), ...headers } })
      return answer(it, 'a showing', request, () => showing(it, request, asked, bare, says, siteAt(settings.basePort, host, secure)), bare)
    },
    upload: (request) => answer(it, 'upload', request, () => upload(it, request)),
    control: (request, asked) => answer(it, 'control', request, () => control(it, request, asked)),
    async close() {
      it.showings.clear()
      it.files.close()
      it.records.close()
    },
  }
}
