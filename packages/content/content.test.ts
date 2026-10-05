// The content service's tests, with no browser: what a stranger, a script, or a confused client
// would send. The service is called as the door calls it, with each request, the port it came
// in on and the address it came from. The backend is stood in for by a key pair whose public
// half is served the way the backend serves it.

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import http from 'node:http'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pipeline, Readable } from 'node:stream'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { type Asked, type ContentSettings, createContent, pagePolicy } from './src/index'
import { limit } from './src/limits'
import { createLog } from './src/log'

type Content = ReturnType<typeof createContent>

// The service opens every file and makes every folder through this, so that a test can make
// the disk fail under it, or do something of its own at the moment one is opened or made
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...real, default: real, open: vi.fn(real.open), mkdir: vi.fn(real.mkdir) }
})
/**
 * Holds the service up at the next folder it makes, and gives two things: a promise that the
 * service has got that far, and what lets it go on. So a test can do something else at that
 * very moment, between what the service has looked at and what it is about to write.
 */
async function atTheNextFolder(): Promise<{ reached: Promise<void>; goOn(): void }> {
  const real = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir
  let arrive!: () => void
  let goOn!: () => void
  const reached = new Promise<void>((resolve) => {
    arrive = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    goOn = resolve
  })
  vi.mocked(fsp.mkdir).mockImplementationOnce((async (...given: Parameters<typeof real>) => {
    arrive()
    await waiting
    return real(...given)
  }) as typeof real)
  return { reached, goOn }
}

// The port the site would be on. Nothing listens on it or on the one after it: a request is
// handed to the service with the port it is said to have come in on.
const BASE = 7300
/** The port pages are shown from. */
const PAGES = BASE + 1
const SITE = `http://localhost:${BASE}`
/** What a page may do, word for word: a change to it is a change to what keeps pages apart. */
const SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock'
/** The policy on an answer to a request sent to `localhost`. */
const POLICY = `${SANDBOX}; frame-ancestors ${SITE}`
/** What a browser says it will take when it opens a document. */
const DOCUMENT = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
const now = () => Math.floor(Date.now() / 1000)
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const MEDIA = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))
const INDEX = '<!doctype html><html><head><title>Plan</title></head><body><h1>Private page</h1><script src="asset.js"></script></body></html>'
const USER = 'user1'
const PREFIX = `u/${USER}/page1/1/`
const SEED = { 'index.html': INDEX, 'asset.js': 'window.loaded = true', 'media.bin': MEDIA, 'docs/read me.txt': 'spaces are fine' }

let ISSUER = ''
let keys: http.Server
let root: string
let signer: { privateKey: CryptoKey; jwk: JWK }
let stranger: { privateKey: CryptoKey }
/** The service the tests of the moment are asking. */
let content: Content
/** Everything any service wrote down, a line each, and where in it the service of the moment began. */
const lines: string[] = []
let began = 0
/** Whatever any service printed by itself, which is nothing. */
const printed: string[] = []

/** A service with folders of its own, or with the folders of one that ran before. */
function make(over: Partial<ContentSettings> = {}): { content: Content; settings: ContentSettings } {
  const home = mkdtempSync(path.join(root, 'service-'))
  const settings = {
    dir: path.join(home, 'content'),
    data: path.join(home, 'content-data'),
    basePort: BASE,
    backendSite: ISSUER,
    // The backend's stand-in is asked as any program asks one
    fetch: (address: string, init: RequestInit) => fetch(address, init),
    // Everything a service writes down is kept, so that it can be read back
    say: (line: string) => void lines.push(line),
    ...over,
  }
  return { content: createContent(settings), settings }
}
/** Gives the tests of one group a service of their own, so that each group has its own showings and its own allowances. */
function ownService(seed = true): void {
  beforeAll(async () => {
    began = lines.length
    content = make().content
    if (seed) await seedFiles(PREFIX, SEED)
  })
  afterAll(() => content.close())
}

interface Reply {
  status: number
  headers: Headers
  buf: Buffer
  text: string
  json: () => any
}
interface Init {
  method?: string
  headers?: Record<string, string>
  body?: Buffer | string
  /** Sent without saying how long it is. */
  chunked?: boolean
  /** The host name the request is sent to, the port it comes in on, and the address it comes from. */
  host?: string
  port?: number
  address?: string
  on?: Content
}
function request(port: number, p: string, init: Init): Request {
  const headers = new Headers(init.headers)
  const body = init.body === undefined ? undefined : Buffer.from(init.body)
  if (body && !init.chunked && !headers.has('content-length')) headers.set('content-length', String(body.length))
  return new Request(`http://${init.host ?? 'localhost'}:${port}${p}`, {
    method: init.method ?? 'GET',
    headers,
    ...(body ? { body: init.chunked ? new Blob([body]).stream() : body, duplex: 'half' } : {}),
  } as RequestInit)
}
async function reply(response: Response): Promise<Reply> {
  const buf = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    headers: response.headers,
    buf,
    text: buf.toString(),
    json: () => JSON.parse(buf.toString()),
  }
}
/** A request that came in on the pages' port. */
const show = async (p: string, init: Init = {}) => {
  const port = init.port ?? PAGES
  return reply(await (init.on ?? content).showing(request(port, p, init), { port, address: init.address ?? '127.0.0.1' }))
}
/** A request that came in on the site's port, handed on as the door hands it on: uploads and the backend's messages, and nothing else. */
async function door(p: string, init: Init = {}): Promise<Reply> {
  const asked: Asked = { port: BASE, address: init.address ?? '127.0.0.1' }
  const service = init.on ?? content
  return reply(await (p.startsWith('/control/') ? service.control : service.upload)(request(BASE, p, init), asked))
}
const newMount = () => randomBytes(16).toString('hex')

/** Signs as the backend would. */
function sign(
  audience: string,
  subject: string,
  claims: Record<string, unknown>,
  opts: { seconds?: number; key?: CryptoKey; iat?: number; issuer?: string; noJti?: boolean } = {},
) {
  const iat = opts.iat ?? now()
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.seconds ?? 60))
  if (!opts.noJti) jwt = jwt.setJti(randomUUID())
  return jwt.sign(opts.key ?? signer.privateKey)
}
/** The ticket for a mount. */
const ticket = (mount: string, over: Record<string, unknown> = {}, opts: Parameters<typeof sign>[3] = {}) =>
  sign('it-content', mount, { m: mount, a: 'page1', s: 'plan', v: '1', u: USER, d: 'display1', e: 0, p: PREFIX, ...over }, opts)
/** What the site's frame does with a ticket: it asks for the address the ticket is the last part of. */
const redeem = async (t: string | Promise<string>, init: Init = {}) => show(`/open/${await t}`, init)
/** Where an answer sends whoever asked. */
const sentTo = (r: Reply) => r.headers.get('location') ?? ''
/** A showing that has been opened: its mount, its token, and the path everything of it is under. */
interface Opened {
  m: string
  token: string
  at: string
}
async function open(over: Record<string, unknown> = {}, init: Init = {}): Promise<Opened> {
  const m = newMount()
  const r = await redeem(ticket(m, over), init)
  const token = /^\/s\/([^/]+)\/v\/[0-9]+\/index\.html$/.exec(sentTo(r))?.[1]
  if (r.status !== 303 || !token) throw new Error(`could not open a showing: ${r.status}`)
  return { m, token, at: `/s/${token}` }
}
/** A message from the backend: signed for that operation and for that exact body. */
const control = async (op: string, body: unknown, token?: string, init: Init = {}) => {
  const text = JSON.stringify(body)
  return door(`/control/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token ?? (await sign('it-control', op, { h: sha256(text) }))}` },
    body: text,
    ...init,
  })
}
const entry = (path: string, data: Buffer | string) => ({ path, size: Buffer.from(data).length, sha256: sha256(Buffer.from(data)) })
/** Declares a version's files, as the backend does before it gives out a grant. */
const stage = (prefix: string, files: { path: string; size: number; sha256: string }[]) => control('stage', { prefix, files })
const grantFor = (prefix: string) => sign('it-upload', prefix, { p: prefix }, { seconds: 900 })
async function upload(file: string, data: Buffer | string, over: { grant?: string; sha?: string; prefix?: string; length?: string | null; on?: Content } = {}) {
  const prefix = over.prefix ?? PREFIX
  const headers: Record<string, string> = {
    authorization: `Bearer ${over.grant ?? (await grantFor(prefix))}`,
    'x-it-sha256': over.sha ?? sha256(Buffer.from(data)),
  }
  if (over.length !== undefined && over.length !== null) headers['content-length'] = over.length
  return door(`/upload/${file}`, { method: 'PUT', headers, body: data, on: over.on, ...(over.length === null ? { chunked: true } : {}) })
}
const inAddress = (file: string) => encodeURIComponent(file).replace(/%2F/g, '/')
/** Declares and uploads in one go, for tests that only need files to be there. */
async function seedFiles(prefix: string, files: Record<string, Buffer | string>, on?: Content) {
  const staged = await control(
    'stage',
    {
      prefix,
      files: Object.entries(files).map(([path, data]) => entry(path, data)),
    },
    undefined,
    { on },
  )
  if (staged.status !== 200) throw new Error(`could not declare ${prefix}: ${staged.status}`)
  for (const [path, data] of Object.entries(files)) {
    const r = await upload(inAddress(path), data, { prefix, on })
    if (r.status !== 200) throw new Error(`could not seed ${path}: ${r.status}`)
  }
}

/** The events written down since the service of the moment began: its own lines, which are JSON with a name. */
function written(): Record<string, any>[] {
  const events: Record<string, any>[] = []
  for (const line of lines.slice(began)) {
    if (!line.startsWith('{"event":')) continue
    events.push(JSON.parse(line))
  }
  return events
}
const wrote = (match: (e: Record<string, any>) => boolean) => written().find(match)
/** Every file under a folder, by its path from that folder. */
const filesUnder = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]))
    : []

/**
 * Whether whoever runs the tests may make a link at all. Windows lets only some users, and a
 * test that has to make one to show what is done about it has nothing to show where none can
 * be made: it is left out there, with a line that says so, and no product code is at fault for that.
 */
const canLink = (() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'it-link-'))
  try {
    symlinkSync(dir, path.join(dir, 'link'), 'dir')
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()
if (!canLink)
  console.log(
    '  skip  the tests of a link in the content folder: whoever runs the tests may not make a link on this system, so there is none to show them with',
  )

/** What is arriving at the services that have the folder open: what is in their folders under `tmp` beside the note that says whose each folder is. */
const arrivingUnder = (tmp: string): string[] => filesUnder(tmp).filter((file) => !/^[^/]+\/holder$/.test(file))

/** A clock the test moves by hand, which everything the service reads the time from follows. */
const clock = {
  start: () => void vi.useFakeTimers({ toFake: ['Date'], now: Date.now() }),
  pass: (seconds: number) => void vi.setSystemTime(Date.now() + seconds * 1000),
}
afterEach(() => void vi.useRealTimers())

/**
 * What every answer from the pages' port must carry, whatever it is an answer to: the sandbox,
 * with nothing in it that would give a page the origin of its address or let it out of its
 * frame; no cookie; and what lets a sandboxed page read and embed its own files.
 */
function expectConfined(kind: string, r: { headers: Headers }, policy = POLICY): void {
  const said = r.headers.get('content-security-policy') ?? ''
  expect([kind, said]).toEqual([kind, policy])
  expect([kind, said.startsWith(`${SANDBOX};`)]).toEqual([kind, true])
  for (const word of ['allow-same-origin', 'allow-top-navigation', 'allow-popups-to-escape-sandbox'])
    expect([kind, word, said.includes(word)]).toEqual([kind, word, false])
  expect([kind, r.headers.getSetCookie(), r.headers.has('set-cookie')]).toEqual([kind, [], false])
  expect([
    kind,
    r.headers.get('x-content-type-options'),
    r.headers.get('referrer-policy'),
    r.headers.get('cross-origin-resource-policy'),
    r.headers.get('access-control-allow-origin'),
  ]).toEqual([kind, 'nosniff', 'no-referrer', 'cross-origin', '*'])
}

beforeAll(async () => {
  // The service says what it writes down to whoever made it, and nothing to the program's own output
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const)
    vi.spyOn(console, level).mockImplementation((...said: unknown[]) => void printed.push(String(said[0])))
  const pair = await generateKeyPair('ES256', { extractable: true })
  signer = { privateKey: pair.privateKey as CryptoKey, jwk: { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' } }
  stranger = { privateKey: (await generateKeyPair('ES256')).privateKey as CryptoKey }
  keys = http
    .createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(req.url === '/.well-known/jwks.json' ? JSON.stringify({ keys: [signer.jwk] }) : '{}')
    })
    .listen(0, '127.0.0.1')
  await new Promise((resolve) => keys.once('listening', resolve))
  ISSUER = `http://127.0.0.1:${(keys.address() as net.AddressInfo).port}`
  root = mkdtempSync(path.join(os.tmpdir(), 'it-content-test-'))
})

afterAll(() => {
  keys?.close()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('tickets', () => {
  ownService()

  test('a good ticket opens a showing: whoever asked is sent on to the page under a token nobody can guess, and no cookie is set', async () => {
    const m = newMount()
    const t = await ticket(m)
    const r = await redeem(t)
    expect([r.status, r.buf.length]).toEqual([303, 0])
    expect(sentTo(r)).toMatch(/^\/s\/[A-Za-z0-9_-]{43}\/v\/1\/index\.html$/)
    expect(r.headers.getSetCookie()).toEqual([])
    // The token is made here, of 32 random bytes, and is nothing the ticket held
    const token = sentTo(r).split('/')[2]!
    expect(Buffer.from(token, 'base64url').length).toBe(32)
    expect(t.includes(token) || token.includes(m)).toBe(false)
    // Another showing of the same page, on the same display, is under another
    expect((await open()).token).not.toBe(token)
    expect((await show(sentTo(r), { headers: DOCUMENT })).text).toContain('<h1>Private page</h1>')
  })

  test('a ticket that ran out a moment ago is spent by nobody, though two clocks may differ by that much', async () => {
    began = lines.length
    // Its signature is still taken, since the clock that made it may be a few seconds behind this one
    const late = ticket(newMount(), {}, { iat: now() - 62 })
    const r = await redeem(late)
    expect([r.status, r.buf.length, sentTo(r)]).toEqual([401, 0, ''])
    expect(wrote((e) => e.event === 'ticket.refused' && e.reason === 'expired')).toMatchObject({ u: USER, d: 'display1' })
    // One with a few seconds left is spent as ever
    expect((await redeem(ticket(newMount(), {}, { iat: now() - 55 }))).status).toBe(303)
  })

  test('tickets that are not exactly right are refused', async () => {
    const m = newMount()
    const refused = async (t: Promise<string>) => {
      const r = await redeem(t)
      expect([r.status, r.buf.length, sentTo(r)]).toEqual([401, 0, ''])
    }
    await refused(ticket(m, {}, { key: stranger.privateKey }))
    await refused(ticket(m, {}, { issuer: 'https://someone-else.example' }))
    await refused(ticket(m, {}, { iat: now() - 120 }))
    await refused(ticket(m, {}, { seconds: 3600 }))
    await refused(ticket(m, {}, { noJti: true }))
    await refused(ticket(m, { m: newMount() }))
    await refused(ticket('not-a-mount'))
    await refused(ticket(m, { p: 'elsewhere/' }))
    await refused(ticket(m, { v: 'latest' }))
    await refused(ticket(m, { e: -1 }))
    await refused(ticket(m, { u: undefined }))
    await refused(sign('it-upload', m, { m, a: 'page1', s: 'plan', v: '1', u: USER, d: 'display1', e: 0, p: PREFIX }))
    await refused(sign('it-control', m, { m, a: 'page1', s: 'plan', v: '1', u: USER, d: 'display1', e: 0, p: PREFIX }))
    await refused(Promise.resolve('not.a.ticket'))
    await refused(Promise.resolve('nonsense'))
    // Nothing large is looked at, whatever it claims to hold
    await refused(ticket(m, { padding: 'x'.repeat(4000) }))
    // And a ticket is the last part of the address, with nothing after it
    for (const p of ['/open', '/open/', `/open/${await ticket(m)}/more`]) expect([p.slice(0, 7), (await show(p)).status]).toEqual([p.slice(0, 7), 404])
  })

  test('a ticket is spent only by the request a frame makes: asking in any other way leaves it good', async () => {
    const t = await ticket(newMount())
    expect((await show(`/open/${t}`, { method: 'HEAD' })).status).toBe(404)
    expect((await show(`/open/${t}`, { method: 'OPTIONS' })).status).toBe(404)
    expect((await show(`/open/${t}`, { method: 'POST', body: '{}' })).status).toBe(405)
    expect((await redeem(t)).status).toBe(303)
  })

  test('a ticket works once, even with fifty attempts at the same instant', async () => {
    const t = await ticket(newMount())
    const first = await redeem(t)
    const second = await redeem(t)
    expect([first.status, second.status]).toEqual([303, 401])
    // From fifty addresses at once
    const raced = await ticket(newMount())
    const race = await Promise.all(Array.from({ length: 50 }, (_, i) => redeem(raced, { address: `10.0.0.${i}` })))
    expect(race.filter((r) => r.status === 303).length).toBe(1)
    expect(race.filter((r) => r.status === 401).length).toBe(49)
  })

  test('a ticket works once when two services share the same records and both are asked at the same instant', async () => {
    // As when one is starting while the one before it has not yet stopped
    const one = make()
    const two = createContent(one.settings)
    try {
      await seedFiles(PREFIX, SEED, one.content)
      const t = await ticket(newMount())
      const race = await Promise.all(
        Array.from({ length: 40 }, (_, i) => ({ on: i % 2 ? one.content : two, i })).map(({ on, i }) => redeem(t, { on, address: `10.0.1.${i}` })),
      )
      expect([race.filter((r) => r.status === 303).length, race.filter((r) => r.status === 401).length]).toEqual([1, 39])
      // The showing is the one's that opened it, and the other knows nothing of it
      const keep = `${sentTo(race.find((r) => r.status === 303)!).split('/v/')[0]}/__it/keep`
      const answers = [(await show(keep, { on: one.content })).status, (await show(keep, { on: two })).status]
      expect(answers.sort()).toEqual([204, 401])
    } finally {
      await one.content.close()
      await two.close()
    }
  })

  test('a ticket that was spent stays spent when the service starts again, and the showing it opened is over', async () => {
    const first = make()
    const t = await ticket(newMount())
    const opened = await redeem(t, { on: first.content })
    expect(opened.status).toBe(303)
    const keep = `${sentTo(opened).split('/v/')[0]}/__it/keep`
    expect((await show(keep, { on: first.content })).status).toBe(204)
    await first.content.close()
    // The same folders, and nothing kept in between but what is in them
    const again = createContent(first.settings)
    try {
      expect((await redeem(t, { on: again })).status).toBe(401)
      // A showing is remembered only while the service runs: its page is told so, and the site shows it again
      expect((await show(keep, { on: again })).status).toBe(401)
      expect((await redeem(ticket(newMount()), { on: again })).status).toBe(303)
    } finally {
      await again.close()
    }
  })
})

describe('showings', () => {
  ownService()
  const OTHER = `u/${USER}/page2/1/`
  beforeAll(() => seedFiles(OTHER, { 'index.html': '<h1>Another page</h1>', 'secret.txt': 'ANOTHER_PAGE_SECRET' }))
  const other = () => open({ p: OTHER, a: 'page2', s: 'another' })

  test('a showing’s files are served under its token and nowhere else', async () => {
    const { token, at } = await open()
    expect((await show(`${at}/v/1/asset.js`)).text).toBe('window.loaded = true')
    for (const p of ['/v/1/asset.js', '/asset.js', `/${token}/v/1/asset.js`, `/v/1/asset.js?token=${token}`])
      expect([p.replace(token, 'token'), (await show(p)).status]).toEqual([p.replace(token, 'token'), 404])
    // A token that is not one of this service's, or is not a token at all
    const unknown = randomBytes(32).toString('base64url')
    for (const wrong of [unknown, token.slice(0, 42), `${token}A`, token.toUpperCase(), `${token.slice(0, 42)}.`, 'x', 'v']) {
      const r = await show(`/s/${wrong}/v/1/asset.js`)
      expect([wrong === unknown ? 'unknown' : wrong.replace(token, 'token'), r.status, r.buf.length]).toEqual([
        wrong === unknown ? 'unknown' : wrong.replace(token, 'token'),
        401,
        0,
      ])
    }
    // Under the token, only a file of the page or the address that keeps the showing
    for (const p of ['', '/', '/v/1', '/v/1/', '/v/latest/asset.js', '/asset.js', '/__it/keep/x', '/__it/runtime.js', '/open/x'])
      expect([p, (await show(`${at}${p}`)).status]).toEqual([p, 404])
  })

  test('the token is all that is asked: no cookie and nothing a request says of where it came from changes an answer', async () => {
    const { at } = await open()
    const said: Record<string, string>[] = [
      {},
      { cookie: 'it_session=anything; it_view=anything' },
      // As many cookies as a browser will hold for a host, of any names, as long as a request's headers may be
      { cookie: Array.from({ length: 180 }, (_, i) => `c${i}=${'x'.repeat(340)}`).join('; ') },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
      { 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'no-cors' },
      { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'serviceworker' },
      { origin: 'null' },
      { origin: 'http://evil.example', referer: 'http://evil.example/page' },
      { origin: SITE, referer: `${SITE}/p/plan` },
      { authorization: 'Bearer anything' },
    ]
    for (const headers of said) {
      const named = JSON.stringify(headers).slice(0, 120)
      expect([named, (await show(`${at}/v/1/asset.js`, { headers })).text]).toEqual([named, 'window.loaded = true'])
      expect([named, (await show(`${at}/__it/keep`, { headers })).status]).toEqual([named, 204])
      // And none of it stands in for a token
      const without = await show('/v/1/asset.js', { headers })
      expect([named, without.status, without.buf.length]).toEqual([named, 404, 0])
      expect([named, (await show(`/s/${randomBytes(32).toString('base64url')}/v/1/asset.js`, { headers })).status]).toEqual([named, 401])
    }
  })

  test('a token is good for the page and the version its ticket named, and for no other', async () => {
    const mine = await open()
    const theirs = await other()
    expect((await show(`${theirs.at}/v/1/secret.txt`)).text).toBe('ANOTHER_PAGE_SECRET')
    // The other page's file is not among this showing's, by any path that might be thought to lead to it
    for (const p of ['/v/1/secret.txt', '/v/1/..%2F..%2Fpage2%2F1%2Fsecret.txt', '/v/1/%2e%2e/%2e%2e/page2/1/secret.txt', `/v/1/${OTHER}secret.txt`]) {
      const r = await show(`${mine.at}${p}`)
      expect([p, r.status, r.buf.length]).toEqual([p, 404, 0])
    }
    // A showing is of one version
    expect((await show(`${mine.at}/v/2/index.html`)).status).toBe(404)
    expect((await show(`${mine.at}/v/01/index.html`)).status).toBe(404)
    expect((await show(`${mine.at}/v/1/index.html`)).status).toBe(200)
  })

  test('a showing left open is ended by none of the showings that follow it, and reads none of their files', async () => {
    const first = await open()
    const own = async () => [(await show(`${first.at}/v/1/asset.js`)).status, (await show(`${first.at}/__it/keep`)).status]
    expect(await own()).toEqual([200, 204])
    // Forty more, of another page, each with a token of its own
    const later: Opened[] = []
    for (let i = 0; i < 40; i++) later.push(await other())
    expect(new Set([first.token, ...later.map((s) => s.token)]).size).toBe(41)
    expect(await own()).toEqual([200, 204])
    // What is still running in the first showing's document asks under the only token it holds
    const reached = await show(`${first.at}/v/1/secret.txt`)
    expect([reached.status, reached.buf.length]).toEqual([404, 0])
    // And every one of the forty is still open, the earliest of them included
    for (const s of later) expect((await show(`${s.at}/v/1/secret.txt`)).text).toBe('ANOTHER_PAGE_SECRET')
  })

  test('a ticket made earlier and traded later opens a showing of its own, and ends no other', async () => {
    const delayed = await ticket(newMount())
    const newer = await open()
    const older = await redeem(delayed)
    expect(older.status).toBe(303)
    expect((await show(`${newer.at}/__it/keep`)).status).toBe(204)
    expect((await show(`${newer.at}/v/1/asset.js`)).status).toBe(200)
    expect((await show(sentTo(older))).status).toBe(200)
  })

  test('a showing ends when nothing has asked under it for ten minutes, and asking keeps it', async () => {
    clock.start()
    const kept = await open()
    const idle = await open()
    for (let minutes = 0; minutes < 30; minutes += 3) {
      clock.pass(180)
      expect((await show(`${kept.at}/__it/keep`)).status).toBe(204)
    }
    expect((await show(`${kept.at}/v/1/asset.js`)).status).toBe(200)
    const over = await show(`${idle.at}/v/1/asset.js`)
    expect([over.status, over.buf.length]).toEqual([401, 0])
    expect((await show(`${idle.at}/__it/keep`)).status).toBe(401)
    // A request for a file keeps it as well as the script's own asking does
    clock.pass(599)
    expect((await show(`${kept.at}/v/1/asset.js`)).status).toBe(200)
    clock.pass(599)
    expect((await show(`${kept.at}/__it/keep`)).status).toBe(204)
    clock.pass(600)
    expect((await show(`${kept.at}/__it/keep`)).status).toBe(401)
    // What has ended does not come back by being asked for again
    expect((await show(`${kept.at}/__it/keep`)).status).toBe(401)
  })

  test('a showing ends when it is a day old, however often it was asked under', async () => {
    clock.start()
    const { at } = await open()
    for (let minutes = 5; minutes < 24 * 60; minutes += 5) {
      clock.pass(300)
      const r = await show(`${at}/__it/keep`)
      if (r.status !== 204) throw new Error(`ended after ${minutes} minutes`)
    }
    clock.pass(300)
    expect((await show(`${at}/__it/keep`)).status).toBe(401)
    expect((await show(`${at}/v/1/asset.js`)).status).toBe(401)
  })

  test('the site’s address is worked out for each request, from the host name it was sent to and the site’s port', async () => {
    const { at, token } = await open()
    // A page is told the site's own address. A policy cannot name an IPv6 address, or a name
    // with an underscore in it, so for those it names every host under as much of the name's
    // ending as it can say, on the site's port, and any host where it can say none of it
    for (const [host, site, framedBy = site] of [
      ['localhost', `http://localhost:${BASE}`],
      ['192.168.1.20', `http://192.168.1.20:${BASE}`],
      ['Kitchen-PC.local', `http://kitchen-pc.local:${BASE}`],
      ['[::1]', `http://[::1]:${BASE}`, `http://*:${BASE}`],
      ['[0:0:0:0:0:0:0:1]', `http://[::1]:${BASE}`, `http://*:${BASE}`],
      ['[FD00::12:34]', `http://[fd00::12:34]:${BASE}`, `http://*:${BASE}`],
      ['Living_Room', `http://living_room:${BASE}`, `http://*:${BASE}`],
      ['living_room.local', `http://living_room.local:${BASE}`, `http://*.local:${BASE}`],
      ['It_Review.localhost', `http://it_review.localhost:${BASE}`, `http://*.localhost:${BASE}`],
      ['my_tv.kitchen.home.arpa', `http://my_tv.kitchen.home.arpa:${BASE}`, `http://*.kitchen.home.arpa:${BASE}`],
      ['tv.living_room.local', `http://tv.living_room.local:${BASE}`, `http://*.local:${BASE}`],
      ['tv.living_room', `http://tv.living_room:${BASE}`, `http://*:${BASE}`],
    ] as const) {
      const page = await show(`${at}/v/1/index.html`, { host, headers: DOCUMENT })
      expectConfined(host, page, `${SANDBOX}; frame-ancestors ${framedBy}`)
      expect(page.text).toContain(`window.__IT__={"app":"${site}","id":"plan","version":1,"keep":"/s/${token}/__it/keep"}`)
      expectConfined(host, await show('/nothing', { host }), `${SANDBOX}; frame-ancestors ${framedBy}`)
    }
    // The name a browser sent in its Host header is the one that counts, whatever the request was handed on as
    const handedOn = await show(`${at}/v/1/index.html`, { host: '127.0.0.1', headers: { ...DOCUMENT, host: `screen.home:${PAGES}` } })
    expect(handedOn.text).toContain(`"app":"http://screen.home:${BASE}"`)
    // What is no host name is written nowhere: nothing is served, and nothing may frame the answer
    for (const host of ["x'; script-src *", 'a b', '"', '<script>', 'x/y', '', '[', '-x-', 'a'.repeat(300)]) {
      const r = await show(`${at}/v/1/index.html`, { headers: { ...DOCUMENT, host } })
      expect([host, r.status, r.buf.length]).toEqual([host, 404, 0])
      expectConfined(host, r, `${SANDBOX}; frame-ancestors 'none'`)
    }
  })

  test('the policy is the same words for whoever works it out, and names the site only by a host name', () => {
    expect(pagePolicy(BASE, `localhost:${PAGES}`)).toBe(POLICY)
    expect(pagePolicy(BASE, 'localhost')).toBe(POLICY)
    expect(pagePolicy(BASE, `LOCALHOST:${PAGES}`)).toBe(POLICY)
    expect(pagePolicy(4700, '[fe80::1]:4701')).toBe(`${SANDBOX}; frame-ancestors http://*:4700`)
    expect(pagePolicy(4700, '[::1]:4701', true)).toBe(`${SANDBOX}; frame-ancestors https://*:4700`)
    // A site on the port a browser leaves out is named without it
    expect(pagePolicy(80, 'localhost:81')).toBe(`${SANDBOX}; frame-ancestors http://localhost`)
    expect(pagePolicy(80, '[::1]:81')).toBe(`${SANDBOX}; frame-ancestors http://*`)
    expect(pagePolicy(4700, 'my_pc.local:4701')).toBe(`${SANDBOX}; frame-ancestors http://*.local:4700`)
    expect(pagePolicy(4700, 'my_pc:4701')).toBe(`${SANDBOX}; frame-ancestors http://*:4700`)
    expect(pagePolicy(80, 'my_pc.den.local:81')).toBe(`${SANDBOX}; frame-ancestors http://*.den.local`)
    expect(pagePolicy(4700, 'my_pc.local:4701', true)).toBe(`${SANDBOX}; frame-ancestors https://*.local:4700`)
    expect(pagePolicy(BASE, `localhost:${PAGES}`, true)).toBe(`${SANDBOX}; frame-ancestors https://localhost:${BASE}`)
    for (const host of [null, '', 'a b', "x'; sandbox allow-same-origin", 'x; frame-ancestors *', '*', 'http://x', 'a'.repeat(300)])
      expect([host, pagePolicy(BASE, host)]).toEqual([host, `${SANDBOX}; frame-ancestors 'none'`])
  })

  test('only the port after the site’s is the pages’', async () => {
    const { at } = await open()
    expect((await show(`${at}/v/1/asset.js`)).status).toBe(200)
    for (const port of [BASE, PAGES + 1, BASE + 32, BASE - 1, 0, 80]) {
      const r = await show(`${at}/v/1/asset.js`, { port })
      expect([port, r.status, r.buf.length]).toEqual([port, 404, 0])
      expect([port, (await redeem(ticket(newMount()), { port })).status]).toEqual([port, 404])
    }
  })
})

describe('bytes', () => {
  ownService()
  let at: string
  let token: string
  beforeAll(async () => {
    ;({ at, token } = await open())
  })
  const get = (p: string, headers: Record<string, string> = {}, init: Init = {}) => show(p, { headers, ...init })

  test('nothing is served without a token, and a refusal carries no bytes', async () => {
    for (const p of ['/v/1/index.html', '/v/1/asset.js', '/v/1/media.bin']) {
      const r = await get(`/s/${randomBytes(32).toString('base64url')}${p}`, DOCUMENT)
      expect([r.status, r.buf.length, r.headers.get('content-length')]).toEqual([401, 0, '0'])
    }
    expect((await get(`/s/${'A'.repeat(43)}/v/1/media.bin`, { range: 'bytes=0-9' })).status).toBe(401)
  })

  test('a page opened as a document has It placed first in it, and is told where to keep its showing going', async () => {
    const r = await get(`${at}/v/1/index.html`, DOCUMENT)
    expect(r.status).toBe(200)
    expect(r.text).toContain('<h1>Private page</h1>')
    // Inside <html>, ahead of everything else, the page's own script included
    const html = r.text.indexOf('<html>'),
      it = r.text.indexOf('window.__IT__='),
      own = r.text.indexOf('<script src="asset.js">')
    expect(it).toBeGreaterThan(html)
    expect(it).toBeLessThan(r.text.indexOf('<title>'))
    expect(own).toBeGreaterThan(it)
    expect(r.text).toContain(`window.__IT__={"app":"${SITE}","id":"plan","version":1,"keep":"${at}/__it/keep"}`)
    // How long it is with It in it is not said: that is known only once the whole page has been read
    expect(r.headers.get('content-length')).toBeNull()
    const src = /<script src="(\/__it\/runtime\.[0-9a-f]+\.js)">/.exec(r.text)![1]!
    const runtime = await get(src)
    expect(runtime.status).toBe(200)
    expect(runtime.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(runtime.headers.get('cache-control')).toContain('immutable')
    expect(runtime.text).toContain('it:hello')
    // The script is the same for every page, and holds nothing of any
    expect(runtime.text.includes(token)).toBe(false)
  })

  test('a page’s own script that fetches one of its HTML files is given the file as it was published', async () => {
    expect((await get(`${at}/v/1/index.html`, { accept: '*/*' })).text).toBe(INDEX)
    expect((await get(`${at}/v/1/index.html`)).text).toBe(INDEX)
    expect((await get(`${at}/v/1/index.html`, { accept: 'application/json' })).text).toBe(INDEX)
    // Whatever the browser says the request is for: only what it says it will take is looked at
    expect((await get(`${at}/v/1/index.html`, { accept: '*/*', 'sec-fetch-dest': 'iframe' })).text).toBe(INDEX)
  })

  test('a page with no head or html tag still gets It before its own script', async () => {
    const prefix = `u/${USER}/page2/1/`
    await seedFiles(prefix, { 'index.html': '<h1>bare</h1><script>window.own = true</script>' })
    const bare = await open({ p: prefix, a: 'page2', s: 'bare' })
    const r = await get(`${bare.at}/v/1/index.html`, DOCUMENT)
    expect(r.text.indexOf('window.__IT__=')).toBe('<script>'.length)
    expect(r.text.indexOf('window.__IT__=')).toBeLessThan(r.text.indexOf('window.own'))
  })

  test('a page with no element in it at all still gets It, so that it can say it has loaded', async () => {
    const prefix = `u/${USER}/page3/1/`
    await seedFiles(prefix, { 'index.html': 'only words, and <!-- a comment -->' })
    const words = await open({ p: prefix, a: 'page3', s: 'words' })
    const r = await get(`${words.at}/v/1/index.html`, DOCUMENT)
    expect(r.text.startsWith('only words')).toBe(true)
    expect(r.text.indexOf('window.__IT__=')).toBeGreaterThan(-1)
    expect(r.text).toMatch(/<script src="\/__it\/runtime\.[0-9a-f]+\.js"><\/script>$/)
  })

  test('It goes where a browser would find the page’s first element, whatever comes before it and however the file is read', async () => {
    const prefix = `u/${USER}/page4/1/`
    const tags = /<script>window\.__IT__=.*?<\/script><script src="[^"]+"><\/script>/
    // Each page as it is sent, with a mark where It is. What a browser does not count as an
    // element (a doctype, comments of every shape, a closing tag, a stray "<") is passed over
    const sent: Record<string, string> = {
      'doctype.html': '<!DOCTYPE html>\n<!-- a <b>comment</b> --><html lang="en">@<head><script>1</script></head></html>',
      'quoted.html': `<html data-a="x>y" data-b='<head>' data-c=u/v>@<body><script>1</script></body></html>`,
      'head.html': '<!---><!----><!--a--!><HEAD >@<title>t</title></HEAD>',
      'slash.html': '<html/>@<p>x</p>',
      'other.html': '</p>< 1 <? pi ?><!x>text @<main id="m"><script>1</script></main>',
      'closing.html': `</a=b='>@<script>1</script>'><script>2</script>`,
      'named-like.html': '@<htmlx><head></head></htmlx>',
      // A file is read 64 KB at a time: here the first element's tag lies across the end of one piece
      'across.html': `<!--${'-'.repeat(65_536 - 16)}--><html data-across="${'a>'.repeat(40)}">@<head></head></html>`,
      'late.html': `${'words '.repeat(40_000)}@<p>after a quarter of a megabyte</p>`,
      // A tag the page ends in the middle of is thrown away by a browser: It goes before it
      'unclosed-tag.html': 'words @<html lang="en',
      'unclosed-name.html': 'words @<section',
    }
    const files = Object.fromEntries(Object.entries(sent).map(([name, page]) => [name, page.replace('@', '')]))
    // A comment the page never finished is finished for it, so that It is not read as part of it
    files['unclosed-comment.html'] = '<!-- never closed <html><script>1</script>'
    sent['unclosed-comment.html'] = '<!-- never closed <html><script>1</script>-->@'
    // And a page in UTF-16, which a browser reads as that whatever it is told, is sent as UTF-8
    const marked = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<html><p>é</p></html>', 'utf16le')])
    sent['utf-16.html'] = '<html>@<p>é</p></html>'
    await seedFiles(prefix, { ...files, 'utf-16.html': marked })
    const placed = await open({ p: prefix, a: 'page4', s: 'placed' })
    for (const [name, page] of Object.entries(sent)) {
      const r = await get(`${placed.at}/v/1/${name}`, DOCUMENT)
      expect([name, r.text.replace(tags, '@') === page, tags.exec(r.text)?.index], name).toEqual([name, true, page.indexOf('@')])
      expect([name, r.headers.get('content-type')]).toEqual([name, 'text/html; charset=utf-8'])
    }
    // Fetched by the page's own script, each is the file as it was published
    expect((await get(`${placed.at}/v/1/unclosed-comment.html`)).text).toBe(files['unclosed-comment.html'])
    expect((await get(`${placed.at}/v/1/utf-16.html`)).buf.equals(marked)).toBe(true)
  })

  test('a page that sits still keeps its showing by asking, and can read the answer that says it is over', async () => {
    const mine = await open()
    const fresh = await get(`${mine.at}/__it/keep`)
    expect([fresh.status, fresh.buf.length, fresh.headers.getSetCookie(), fresh.headers.has('content-length')]).toEqual([204, 0, [], false])
    // A sandboxed page is another origin to its own address: it is told the answer only because the answer says any origin may read it
    expect(fresh.headers.get('access-control-allow-origin')).toBe('*')
    clock.start()
    clock.pass(601)
    const over = await get(`${mine.at}/__it/keep`)
    expect([over.status, over.buf.length, over.headers.get('access-control-allow-origin')]).toEqual([401, 0, '*'])
  })

  test('ranges return exactly the bytes asked for', async () => {
    const range = (r: string) => get(`${at}/v/1/media.bin`, { range: r })
    const whole = await get(`${at}/v/1/media.bin`)
    expect([whole.status, whole.headers.get('content-length'), whole.headers.get('accept-ranges'), whole.buf.equals(MEDIA)]).toEqual([
      200,
      '4096',
      'bytes',
      true,
    ])
    const mid = await range('bytes=10-19')
    expect([mid.status, mid.headers.get('content-range'), mid.headers.get('content-length'), mid.buf.equals(MEDIA.subarray(10, 20))]).toEqual([
      206,
      'bytes 10-19/4096',
      '10',
      true,
    ])
    const tail = await range('bytes=-5')
    expect([tail.status, tail.headers.get('content-range'), tail.buf.equals(MEDIA.subarray(4091))]).toEqual([206, 'bytes 4091-4095/4096', true])
    const open = await range('bytes=4090-')
    expect([open.status, open.buf.equals(MEDIA.subarray(4090))]).toEqual([206, true])
    const past = await range('bytes=5000-')
    expect([past.status, past.buf.length, past.headers.get('content-range')]).toEqual([416, 0, 'bytes */4096'])
    const many = await range('bytes=0-1,4-5')
    expect([many.status, many.buf.equals(MEDIA)]).toEqual([200, true])
  })

  test('a part is given only of the very file a request has the rest of', async () => {
    const whole = await get(`${at}/v/1/media.bin`)
    const etag = whole.headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)
    const part = (ifRange: string, range = 'bytes=10-19') => get(`${at}/v/1/media.bin`, { range, 'if-range': ifRange })
    const same = await part(etag)
    expect([same.status, same.headers.get('content-range'), same.buf.equals(MEDIA.subarray(10, 20))]).toEqual([206, 'bytes 10-19/4096', true])
    // It has the rest of some other file, or of this one as it was: it is given the whole of this one as it is
    for (const other of ['"not-this-file"', `W/${etag}`, etag.slice(1, -1), 'Sun, 04 Oct 2026 10:00:00 GMT', '']) {
      const r = await part(other)
      expect([other, r.status, r.headers.get('content-range'), r.buf.equals(MEDIA)]).toEqual([other, 200, null, true])
    }
    // Even where the part it asked for is past the end of this one
    expect((await part('"not-this-file"', 'bytes=9999-')).status).toBe(200)
    expect((await part(etag, 'bytes=9999-')).status).toBe(416)
  })

  test('a page’s HTML is given whole, with It in it for a document, whatever part of it was asked for', async () => {
    const whole = await get(`${at}/v/1/index.html`, DOCUMENT)
    for (const headers of [
      { range: 'bytes=0-' },
      { range: 'bytes=0-9' },
      { range: 'bytes=-5' },
      { range: 'bytes=0-', 'if-range': '"not-this-file"' },
      { range: 'bytes=99999-' },
    ]) {
      const named = JSON.stringify(headers)
      const document = await get(`${at}/v/1/index.html`, { ...DOCUMENT, ...headers })
      expect([named, document.status, document.headers.get('content-range'), document.text]).toEqual([named, 200, null, whole.text])
      expect(document.text).toContain('window.__IT__=')
      expect([named, document.headers.get('accept-ranges'), document.headers.get('content-length')]).toEqual([named, 'none', null])
      // And for the page's own script, the file as it was published, whole as well
      const fetched = await get(`${at}/v/1/index.html`, headers)
      expect([named, fetched.status, fetched.headers.get('content-range'), fetched.headers.get('accept-ranges'), fetched.text]).toEqual([
        named,
        200,
        null,
        'none',
        INDEX,
      ])
    }
    // The file's own mark is said of the file, and never of the file with It in it
    expect([(await get(`${at}/v/1/index.html`)).headers.has('etag'), whole.headers.has('etag')]).toEqual([true, false])
    expect((await get(`${at}/v/1/media.bin`)).headers.get('accept-ranges')).toBe('bytes')
  })

  test('a file larger than a piece is passed on whole, and so is any range of it', async () => {
    const prefix = `u/${USER}/page5/1/`
    const big = randomBytes(300_000)
    await seedFiles(prefix, { 'big.bin': big })
    const large = await open({ p: prefix, a: 'page5', s: 'big' })
    const whole = await get(`${large.at}/v/1/big.bin`)
    expect([whole.status, whole.buf.equals(big)]).toEqual([200, true])
    // Across the end of one piece and the start of the next
    const across = await get(`${large.at}/v/1/big.bin`, { range: 'bytes=65000-200000' })
    expect([across.status, across.headers.get('content-length'), across.buf.equals(big.subarray(65_000, 200_001))]).toEqual([206, '135001', true])
  })

  test('paths are decoded and kept inside the page', async () => {
    expect((await get(`${at}/v/1/docs/read%20me.txt`)).text).toBe('spaces are fine')
    for (const p of ['/v/1/..%2F..%2Fpage2%2F1%2Findex.html', '/v/1/%2e%2e/secret', '/v/1/a//b', '/v/1/%00', '/v/1/%E0%A4%A', '/v/1/docs%5Cread%20me.txt'])
      expect((await get(`${at}${p}`)).status, p).toBe(404)
    expect((await get(`${at}/v/1/missing.txt`)).status).toBe(404)
  })

  test('a request that asks only what the answer would be is given its headers and no bytes', async () => {
    const head = (p: string, headers: Record<string, string> = {}) => get(p, headers, { method: 'HEAD' })
    const file = await head(`${at}/v/1/media.bin`)
    expect([file.status, file.buf.length, file.headers.get('content-length'), file.headers.get('content-type')]).toEqual([
      200,
      0,
      '4096',
      'application/octet-stream',
    ])
    const part = await head(`${at}/v/1/media.bin`, { range: 'bytes=0-9' })
    expect([part.status, part.buf.length, part.headers.get('content-range')]).toEqual([206, 0, 'bytes 0-9/4096'])
    const page = await head(`${at}/v/1/index.html`, DOCUMENT)
    expect([page.status, page.buf.length, page.headers.get('content-length')]).toEqual([
      200,
      0,
      (await get(`${at}/v/1/index.html`, DOCUMENT)).headers.get('content-length'),
    ])
    expect((await head(`${at}/v/1/missing.txt`)).status).toBe(404)
    expect((await head(`/s/${'A'.repeat(43)}/v/1/media.bin`)).status).toBe(401)
    // The file is let go of each time: it can be asked for as often as anyone likes
    for (let i = 0; i < 300; i++) if ((await head(`${at}/v/1/media.bin`)).status !== 200) throw new Error('a file was not let go of')
    const script = await head(/src="(\/__it\/runtime\.[0-9a-f]+\.js)"/.exec((await get(`${at}/v/1/index.html`, DOCUMENT)).text)![1]!)
    expect([script.status, script.buf.length]).toEqual([200, 0])
  })

  test('a page’s script that sends a header of its own is told that it may read, under a live token and nowhere else', async () => {
    const ask = (p: string) =>
      get(p, { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-own' }, { method: 'OPTIONS' })
    const may = await ask(`${at}/v/1/media.bin`)
    expect([may.status, may.buf.length]).toEqual([204, 0])
    expect([
      may.headers.get('access-control-allow-origin'),
      may.headers.get('access-control-allow-methods'),
      may.headers.get('access-control-allow-headers'),
      may.headers.get('access-control-allow-credentials'),
    ]).toEqual(['*', 'GET, HEAD', '*', null])
    for (const p of [`/s/${'A'.repeat(43)}/v/1/media.bin`, '/v/1/media.bin', '/open/x', '/']) {
      const r = await ask(p)
      expect([p, r.status < 300, r.headers.get('access-control-allow-methods')]).toEqual([p, false, null])
    }
  })

  test('nothing is done on the pages’ port but reading: every other method is refused, with what may be asked', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const p of [`${at}/v/1/asset.js`, `${at}/__it/keep`, '/open/x', '/anything']) {
        const r = await show(p, { method, body: 'x' })
        expect([method, p.replace(at, ''), r.status, r.buf.length, r.headers.get('allow')]).toEqual([method, p.replace(at, ''), 405, 0, 'GET, HEAD, OPTIONS'])
      }
    }
    expect((await show(`${at}/v/1/asset.js`)).text).toBe('window.loaded = true')
  })

  test('every kind of answer the pages’ port gives carries the sandbox, sets no cookie, and is kept by no browser', async () => {
    const closed = make().content
    await closed.close()
    const away = make({ backendSite: 'http://127.0.0.1:9' }).content
    const runtime = /src="(\/__it\/runtime\.[0-9a-f]+\.js)"/.exec((await get(`${at}/v/1/index.html`, DOCUMENT)).text)![1]!
    const unknown = `/s/${randomBytes(32).toString('base64url')}`
    const kinds: Record<string, Reply> = {
      'a page': await get(`${at}/v/1/index.html`, DOCUMENT),
      'a file': await get(`${at}/v/1/asset.js`),
      'a part of a file': await get(`${at}/v/1/media.bin`, { range: 'bytes=0-1' }),
      'a part past the end': await get(`${at}/v/1/media.bin`, { range: 'bytes=9999-' }),
      'only the headers': await get(`${at}/v/1/media.bin`, {}, { method: 'HEAD' }),
      'a missing file': await get(`${at}/v/1/nothing`),
      'another version': await get(`${at}/v/2/index.html`),
      'a path that leads out': await get(`${at}/v/1/%2e%2e/secret`),
      'a refused token': await get(`${unknown}/v/1/index.html`, DOCUMENT),
      'a token that is not one': await get('/s/x/v/1/index.html'),
      'keeping a showing': await get(`${at}/__it/keep`),
      'keeping one that is over': await get(`${unknown}/__it/keep`),
      'a ticket taken': await redeem(ticket(newMount())),
      'a ticket refused': await redeem(ticket(newMount(), {}, { key: stranger.privateKey })),
      'a ticket taken twice': await (async () => {
        const t = await ticket(newMount())
        await redeem(t)
        return redeem(t)
      })(),
      'the script It puts in a page': await get(runtime),
      'an earlier script': await get('/__it/runtime.000000000000.js'),
      'may I': await get(`${at}/v/1/asset.js`, { origin: 'null', 'access-control-request-method': 'GET' }, { method: 'OPTIONS' }),
      'may I, with no token': await get(`${unknown}/v/1/asset.js`, { origin: 'null', 'access-control-request-method': 'GET' }, { method: 'OPTIONS' }),
      'a method that is not reading': await show(`${at}/v/1/asset.js`, { method: 'POST', body: 'x' }),
      'a method nobody knows': await show(`${at}/v/1/asset.js`, { method: 'PROPFIND' }),
      'nothing at all': await get('/'),
      'the site’s own routes': await show('/control/revoke', { method: 'POST', body: '{}' }),
      'another port': await get(`${at}/v/1/asset.js`, {}, { port: BASE }),
      'a fault': await redeem(ticket(newMount()), { on: closed }),
      'the backend out of reach': await redeem(ticket(newMount(), {}, { issuer: 'http://127.0.0.1:9' }), { on: away }),
    }
    await away.close()
    expect(Object.fromEntries(Object.entries(kinds).map(([kind, r]) => [kind, r.status]))).toEqual({
      'a page': 200,
      'a file': 200,
      'a part of a file': 206,
      'a part past the end': 416,
      'only the headers': 200,
      'a missing file': 404,
      'another version': 404,
      'a path that leads out': 404,
      'a refused token': 401,
      'a token that is not one': 401,
      'keeping a showing': 204,
      'keeping one that is over': 401,
      'a ticket taken': 303,
      'a ticket refused': 401,
      'a ticket taken twice': 401,
      'the script It puts in a page': 200,
      'an earlier script': 404,
      'may I': 204,
      'may I, with no token': 401,
      'a method that is not reading': 405,
      'a method nobody knows': 405,
      'nothing at all': 404,
      'the site’s own routes': 405,
      'another port': 404,
      'a fault': 500,
      'the backend out of reach': 503,
    })
    for (const [kind, r] of Object.entries(kinds)) {
      expectConfined(kind, r)
      // Only the script It puts in a page, which is the same for every page, may be kept
      expect([kind, r.headers.get('cache-control')]).toEqual([
        kind,
        kind === 'the script It puts in a page' ? 'public, max-age=31536000, immutable' : 'no-store',
      ])
      // An answer that is not a file says nothing
      if (r.status >= 300) expect([kind, r.buf.length, r.headers.get('content-length')]).toEqual([kind, 0, '0'])
    }
  })

  test('what the site’s port answers forbids caching, sniffing, embedding and framing', async () => {
    const kinds: Record<string, Reply> = {
      upload: await door('/upload/x', { method: 'PUT', body: 'x' }),
      control: await door('/control/revoke', { method: 'POST', body: '{}' }),
      'not an upload': await door('/upload/x'),
      asked: await control('revoke', { userId: 'x', displayId: 'y', epoch: 0 }),
    }
    for (const [kind, r] of Object.entries(kinds)) {
      expect([
        kind,
        r.headers.get('cache-control'),
        r.headers.get('x-content-type-options'),
        r.headers.get('referrer-policy'),
        r.headers.get('cross-origin-resource-policy'),
        r.headers.get('content-security-policy'),
        r.headers.get('access-control-allow-origin'),
        r.headers.getSetCookie(),
      ]).toEqual([kind, 'no-store', 'nosniff', 'no-referrer', 'same-origin', "default-src 'none'; frame-ancestors 'none'", null, []])
    }
  })
})

describe('sign-outs', () => {
  ownService(false)

  test("raising a display's number ends its showings and refuses its older tickets, and the number never goes down", async () => {
    const user = `user-${randomUUID()}`
    const prefix = `u/${user}/page/1/`
    await seedFiles(prefix, { 'index.html': INDEX })
    const claims = { u: user, d: 'kitchen', p: prefix }
    const { at } = await open(claims)
    const study = await open({ ...claims, d: 'study' })
    expect((await show(`${at}/v/1/index.html`)).status).toBe(200)
    expect((await control('revoke', { userId: user, displayId: 'kitchen', epoch: 3 })).json()).toEqual({ epoch: 3 })
    const over = await show(`${at}/v/1/index.html`)
    expect([over.status, over.buf.length]).toEqual([401, 0])
    expect((await show(`${at}/__it/keep`)).status).toBe(401)
    expect((await redeem(ticket(newMount(), { ...claims, e: 2 }))).status).toBe(401)
    expect((await redeem(ticket(newMount(), { ...claims, e: 3 }))).status).toBe(303)
    expect((await control('revoke', { userId: user, displayId: 'kitchen', epoch: 1 })).json()).toEqual({ epoch: 3 })
    // Another display of the same person is unaffected
    expect((await show(`${study.at}/v/1/index.html`)).status).toBe(200)
    expect((await redeem(ticket(newMount(), { ...claims, d: 'study', e: 0 }))).status).toBe(303)
  })

  test('a sign-out that never reached the service takes effect with the next ticket that carries it', async () => {
    const user = `user-${randomUUID()}`
    const prefix = `u/${user}/page/1/`
    await seedFiles(prefix, { 'index.html': INDEX })
    const claims = { u: user, d: 'hall', p: prefix }
    const { at } = await open(claims)
    expect((await show(`${at}/v/1/index.html`)).status).toBe(200)
    // The person signed out. The backend raised the number to 1, and its message to the service was lost.
    // They pair the browser again and open a page: its ticket says 1.
    const after = await open({ ...claims, e: 1 })
    // The showing from before the sign-out is over, and the one after it is not
    expect((await show(`${at}/v/1/index.html`)).status).toBe(401)
    expect((await show(`${at}/__it/keep`)).status).toBe(401)
    expect((await show(`${after.at}/v/1/index.html`)).status).toBe(200)
  })

  test('a sign-out is remembered when the service starts again', async () => {
    const first = make()
    const user = `user-${randomUUID()}`
    const claims = { u: user, d: 'porch' }
    expect((await redeem(ticket(newMount(), claims), { on: first.content })).status).toBe(303)
    expect((await control('revoke', { userId: user, displayId: 'porch', epoch: 2 }, undefined, { on: first.content })).status).toBe(200)
    await first.content.close()
    const again = createContent(first.settings)
    try {
      expect((await redeem(ticket(newMount(), { ...claims, e: 1 }), { on: again })).status).toBe(401)
      expect((await control('revoke', { userId: user, displayId: 'porch', epoch: 1 }, undefined, { on: again })).json()).toEqual({ epoch: 2 })
      expect((await redeem(ticket(newMount(), { ...claims, e: 2 }), { on: again })).status).toBe(303)
    } finally {
      await again.close()
    }
  })
})

describe('what is remembered', () => {
  /** How many rows a service's own database holds of one kind, read through a connection of the test's own. */
  function rows(settings: ContentSettings, table: 'signed_out' | 'spent' | 'deleted'): number {
    const sqlite = process.getBuiltinModule('Bun' in globalThis ? 'bun:sqlite' : 'node:sqlite') as unknown as Record<
      string,
      new (
        file: string,
      ) => { prepare(sql: string): { get(): { n: number | bigint }; finalize?(): void }; close(): void }
    >
    const db = new ('Bun' in globalThis ? sqlite.Database! : sqlite.DatabaseSync!)(path.join(settings.data, 'content.sqlite'))
    const count = db.prepare(`SELECT count(*) AS n FROM ${table}`)
    try {
      return Number(count.get().n)
    } finally {
      // The statement first, without which Bun's module goes on holding the database open
      count.finalize?.()
      db.close()
    }
  }

  test('a service that is closed has let go of its database: of the three files an open one keeps, the one that is the database is left', async () => {
    const own = make()
    try {
      await control('revoke', { userId: USER, displayId: 'd0', epoch: 2 }, undefined, { on: own.content })
      expect(readdirSync(own.settings.data).sort()).toEqual(['content.sqlite', 'content.sqlite-shm', 'content.sqlite-wal'])
    } finally {
      await own.content.close()
    }
    // Held open, the two beside it would be there still, and on Windows the folder could not be
    // removed. The SQLite that macOS has, which Bun uses there, leaves the two where they are
    // when a database is closed, by its own setting: there only the database itself is looked for
    const left = readdirSync(own.settings.data)
    if (process.platform === 'darwin' && 'Bun' in globalThis) expect(left).toContain('content.sqlite')
    else expect(left).toEqual(['content.sqlite'])
    expect(rows(own.settings, 'signed_out')).toBe(1)
  })

  test('a sign-out is remembered for as long as anything from before it could still be good, and is then cleared away', async () => {
    clock.start()
    began = lines.length
    const own = make()
    const on = own.content
    try {
      const user = `user-${randomUUID()}`
      const prefix = `u/${user}/page/1/`
      await seedFiles(prefix, { 'index.html': INDEX }, on)
      const claims = { u: user, p: prefix }
      // A showing opened a moment before its display is signed out, and a ticket made then and not yet used
      const before = await open({ ...claims, d: 'd0' }, { on })
      for (let i = 0; i < 100; i++)
        expect((await control('revoke', { userId: user, displayId: `d${i}`, epoch: 2 }, undefined, { on })).json()).toEqual({ epoch: 2 })
      expect(rows(own.settings, 'signed_out')).toBe(100)
      expect((await show(`${before.at}/__it/keep`, { on })).status).toBe(401)
      // A day on, which is as long as any showing lasts: the number has not gone down
      clock.pass(24 * 3600)
      expect((await redeem(ticket(newMount(), { ...claims, d: 'd1', e: 1 }), { on })).status).toBe(401)
      expect((await control('revoke', { userId: user, displayId: 'd1', epoch: 1 }, undefined, { on })).json()).toEqual({ epoch: 2 })
      expect(rows(own.settings, 'signed_out')).toBe(100)
      // Past that, and past the minute a ticket lasts, nothing from before the sign-outs is left
      // to refuse. The backend gives a display its number with every ticket, so the next one says it again.
      clock.pass(3600)
      const next = await open({ ...claims, d: 'd1', e: 2 }, { on })
      expect((await show(`${next.at}/v/1/index.html`, { on })).status).toBe(200)
      expect(rows(own.settings, 'signed_out')).toBe(1)
      // Said as something learned, and not as word that was lost: nothing was known to compare it with
      expect(wrote((e) => e.event === 'revocation.learned' && e.d === 'd1')).toEqual({
        event: 'revocation.learned',
        u: user,
        d: 'd1',
        from: 0,
        to: 2,
        by: 'ticket',
      })
      // A lower number is remembered here, so a higher one in a ticket means word of a sign-out was lost
      await open({ ...claims, d: 'd1', e: 3 }, { on })
      expect(wrote((e) => e.event === 'revocation.learned' && e.to === 3)).toMatchObject({ level: 'warn', from: 2 })
      // And the showing from before it is over
      expect((await show(`${next.at}/v/1/index.html`, { on })).status).toBe(401)
    } finally {
      await on.close()
    }
  })

  test('a deletion is remembered for an hour, and is then cleared away', async () => {
    clock.start()
    const own = make()
    const on = own.content
    try {
      const person = `u/forgotten-${randomUUID()}/`
      for (let n = 0; n < 20; n++) expect((await control('delete', { prefix: `${person}page${n}/` }, undefined, { on })).status).toBe(200)
      expect(rows(own.settings, 'deleted')).toBe(20)
      // Within the hour each is still refused, and none has been cleared away
      clock.pass(3500)
      expect((await control('stage', { prefix: `${person}page0/1/`, files: [entry('index.html', 'x')] }, undefined, { on })).status).toBe(409)
      expect(rows(own.settings, 'deleted')).toBe(20)
      // Past it, the next deletion clears them: only that one is left
      clock.pass(200)
      expect((await control('delete', { prefix: `${person}another/` }, undefined, { on })).status).toBe(200)
      expect(rows(own.settings, 'deleted')).toBe(1)
    } finally {
      await on.close()
    }
  })

  test('every change to what is remembered is on the disk before it is answered: the database is told to wait for that', async () => {
    const bun = 'Bun' in globalThis
    type Opened = { exec(sql: string): unknown; prepare(sql: string): { get(): unknown } }
    const sqlite = process.getBuiltinModule(bun ? 'bun:sqlite' : 'node:sqlite') as unknown as Record<string, { prototype: Opened }>
    const database = (bun ? sqlite.Database! : sqlite.DatabaseSync!).prototype
    const exec = database.exec
    const set: unknown[] = []
    // What the connection the service opens is set to, asked of that very connection once it has been set up
    database.exec = function (this: Opened, sql: string) {
      const done = exec.call(this, sql)
      if (/PRAGMA synchronous/.test(sql)) set.push(this.prepare('PRAGMA synchronous').get(), this.prepare('PRAGMA journal_mode').get())
      return done
    }
    try {
      await make().content.close()
    } finally {
      database.exec = exec
    }
    // Two is the word for waiting until the disk has it
    expect(set).toEqual([{ synchronous: 2 }, { journal_mode: 'wal' }])
  })

  test('a spent ticket is remembered until it could not be used anyway, and is then cleared away', async () => {
    clock.start()
    const own = make()
    const on = own.content
    try {
      const tickets = await Promise.all(Array.from({ length: 30 }, () => ticket(newMount())))
      for (const t of tickets) expect((await redeem(t, { on })).status).toBe(303)
      expect(rows(own.settings, 'spent')).toBe(30)
      clock.pass(30)
      expect((await redeem(tickets[0]!, { on })).status).toBe(401)
      clock.pass(600)
      expect((await redeem(ticket(newMount()), { on })).status).toBe(303)
      expect(rows(own.settings, 'spent')).toBe(1)
    } finally {
      await on.close()
    }
  })
})

describe('what only the backend may ask', () => {
  ownService()

  test("control messages need the backend's signature, for control, for that very operation and that very body", async () => {
    const body = { userId: 'x', displayId: 'y', epoch: 1 }
    const h = sha256(JSON.stringify(body))
    expect((await control('revoke', body, 'nonsense')).status).toBe(401)
    expect((await control('revoke', body, await sign('it-control', 'revoke', { h }, { key: stranger.privateKey }))).status).toBe(401)
    expect((await control('revoke', body, await sign('it-content', 'revoke', { h }))).status).toBe(401)
    expect((await control('revoke', body, await sign('it-control', 'delete', { h }))).status).toBe(401)
    expect((await control('revoke', body, await sign('it-control', 'revoke', { h }, { iat: now() - 600 }))).status).toBe(401)
    expect((await door('/control/revoke', { method: 'POST', body: JSON.stringify(body) })).status).toBe(401)
    // A message that was signed for one body cannot be sent with another
    expect((await control('revoke', { ...body, epoch: 99 }, await sign('it-control', 'revoke', { h }))).status).toBe(401)
    expect((await control('revoke', body, await sign('it-control', 'revoke', {}))).status).toBe(401)
    expect((await control('revoke', body, await sign('it-control', 'revoke', { h }))).status).toBe(200)
    expect((await control('revoke', { userId: 'x' })).status).toBe(400)
    // And they are not the pages' port's to take
    const onThePagesPort = await show('/control/revoke', {
      method: 'POST',
      headers: { authorization: `Bearer ${await sign('it-control', 'revoke', { h })}` },
      body: JSON.stringify(body),
    })
    expect(onThePagesPort.status).toBe(405)
  })

  test('a message that did not come from this machine is not looked at, however it is signed', async () => {
    const body = { userId: 'x', displayId: 'away', epoch: 5 }
    for (const address of ['192.168.1.9', '10.0.0.1', '::ffff:192.168.1.9', 'fe80::1', '127.0.0.1.evil.example', '']) {
      const r = await control('revoke', body, undefined, { address })
      expect([address, r.status, r.buf.length]).toEqual([address, 404, 0])
    }
    // Nothing was raised
    expect((await control('revoke', { ...body, epoch: 0 })).json()).toEqual({ epoch: 0 })
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53'])
      expect((await control('revoke', body, undefined, { address })).json(), address).toEqual({ epoch: 5 })
  })

  test('a version’s files can only be declared whole and well formed', async () => {
    const prefix = `u/${USER}/declare/1/`
    const ok = [entry('index.html', 'x')]
    expect((await stage(prefix, ok)).status).toBe(200)
    expect((await stage(`u/${USER}/declare/`, ok)).status).toBe(400)
    expect((await stage(prefix, [])).status).toBe(400)
    expect((await stage(prefix, [{ path: '../x', size: 1, sha256: sha256('x') }])).status).toBe(400)
    expect((await stage(prefix, [{ path: 'x', size: -1, sha256: sha256('x') }])).status).toBe(400)
    expect((await stage(prefix, [{ path: 'x', size: 1, sha256: 'nope' }])).status).toBe(400)
  })

  test('verify reports files that are missing, the wrong size, changed, or there without having been declared', async () => {
    const files = [
      entry('index.html', INDEX),
      entry('asset.js', 'window.loaded = true'),
      entry('media.bin', MEDIA),
      entry('docs/read me.txt', 'spaces are fine'),
    ]
    expect((await control('verify', { prefix: PREFIX, files })).json()).toEqual({ ok: true, missing: [] })
    const bad = [
      files[0]!,
      files[2]!,
      { path: 'never-uploaded.js', size: 1, sha256: sha256('x') },
      { path: 'asset.js', size: 999, sha256: sha256('window.loaded = true') },
      { path: 'docs/read me.txt', size: 15, sha256: sha256('different') },
    ]
    expect((await control('verify', { prefix: PREFIX, files: bad })).json()).toEqual({
      ok: false,
      missing: ['never-uploaded.js', 'asset.js', 'docs/read me.txt'],
    })
    expect((await control('verify', { prefix: PREFIX, files: files.slice(0, 3) })).json()).toEqual({ ok: false, missing: ['(not declared) docs/read me.txt'] })
    expect((await control('verify', { prefix: `u/${USER}/page1/`, files })).status).toBe(400)
  })

  test('verify reads what is on the disk now, so a file that was changed there after it arrived is found out', async () => {
    const own = make()
    try {
      const prefix = `u/${USER}/kept/1/`
      const files = [entry('index.html', 'as it was published')]
      expect((await control('stage', { prefix, files }, undefined, { on: own.content })).status).toBe(200)
      expect((await upload('index.html', 'as it was published', { prefix, on: own.content })).status).toBe(200)
      expect((await control('verify', { prefix, files }, undefined, { on: own.content })).json()).toEqual({ ok: true, missing: [] })
      // The same length, and other words
      const [kept] = filesUnder(path.join(own.settings.dir, 'u'))
      writeFileSync(path.join(own.settings.dir, 'u', kept!), 'as it was publishe!')
      expect((await control('verify', { prefix, files }, undefined, { on: own.content })).json()).toEqual({ ok: false, missing: ['index.html'] })
    } finally {
      await own.content.close()
    }
  })

  test('delete removes everything under a prefix and nothing beside it, and refuses a prefix that is too wide', async () => {
    const user = `user-${randomUUID()}`
    const keep = `u/${user}/keep/1/`,
      gone = `u/${user}/gone/1/`
    await seedFiles(keep, { 'index.html': 'keep' })
    await seedFiles(gone, { 'index.html': 'gone', 'deep/file.txt': 'gone too' })
    // Two files, and the list of what was declared for them
    expect((await control('delete', { prefix: `u/${user}/gone/` })).json()).toEqual({ removed: 3, more: false })
    // With the declaration gone, the grant for that version allows nothing any more
    expect((await upload('index.html', 'gone', { prefix: gone })).status).toBe(403)
    expect((await control('verify', { prefix: gone, files: [] })).json()).toEqual({ ok: true, missing: [] })
    const one = (prefix: string, text: string) =>
      control('verify', { prefix, files: [{ path: 'index.html', size: text.length, sha256: sha256(text) }] }).then((r) => r.json().ok)
    expect([await one(keep, 'keep'), await one(gone, 'gone')]).toEqual([true, false])
    for (const prefix of ['', 'u/', '/', 'u', `u/${user}`, `u/${user}/../`, 'elsewhere/x/', '../', `u/${user}/keep/1/../../`])
      expect((await control('delete', { prefix })).status, prefix).toBe(400)
    // Asked again, there is nothing left to remove
    expect((await control('delete', { prefix: `u/${user}/gone/` })).json()).toEqual({ removed: 0, more: false })
    // Everything of one person's goes the same way
    expect((await control('delete', { prefix: `u/${user}/` })).json()).toEqual({ removed: 2, more: false })
    expect(await one(keep, 'keep')).toBe(false)
  })
})

describe('everything of one person’s, deleted', () => {
  test('is told to whoever runs the service once the last of it is gone, by the person’s id, and of nothing less than a whole person', async () => {
    const told: string[] = []
    const own = make({ erased: (person) => void told.push(person) })
    const on = own.content
    try {
      const person = `erased-${randomUUID()}`
      await seedFiles(`u/${person}/page/1/`, { 'index.html': 'x' }, on)
      await seedFiles(`u/${person}/page/2/`, { 'index.html': 'y' }, on)
      await seedFiles(`u/${person}/another/1/`, { 'index.html': 'z' }, on)
      // A version and a page are not a person
      expect((await control('delete', { prefix: `u/${person}/page/1/` }, undefined, { on })).status).toBe(200)
      expect((await control('delete', { prefix: `u/${person}/page/` }, undefined, { on })).status).toBe(200)
      expect(told).toEqual([])
      expect((await control('delete', { prefix: `u/${person}/` }, undefined, { on })).json()).toEqual({ removed: 2, more: false })
      expect(told).toEqual([person])
      // Asked again, as the backend asks until it is answered, it is told again
      expect((await control('delete', { prefix: `u/${person}/` }, undefined, { on })).json()).toEqual({ removed: 0, more: false })
      expect(told).toEqual([person, person])
      // A message that does not check out tells nothing
      expect((await control('delete', { prefix: `u/${person}/` }, 'nonsense', { on })).status).toBe(401)
      expect((await control('delete', { prefix: `u/${person}/` }, undefined, { on, address: '192.168.1.9' })).status).toBe(404)
      expect(told).toHaveLength(2)
    } finally {
      await on.close()
    }
  })

  test('is not answered as done while whoever runs the service could not do its part, so that the backend asks again', async () => {
    let fails = true
    const told: string[] = []
    const own = make({
      erased: async (person) => {
        told.push(person)
        if (fails) throw Object.assign(new Error('a private path'), { code: 'EBUSY' })
      },
    })
    const on = own.content
    began = lines.length
    try {
      const person = `erased-${randomUUID()}`
      await seedFiles(`u/${person}/page/1/`, { 'index.html': 'x' }, on)
      const failed = await control('delete', { prefix: `u/${person}/` }, undefined, { on })
      expect([failed.status, failed.buf.length]).toEqual([500, 0])
      // Written down by the kind of trouble it was, and nothing of its own words
      expect(written().at(-1)).toMatchObject({ event: 'unexpected', level: 'error', part: 'control', kind: 'EBUSY' })
      expect(JSON.stringify(written())).not.toContain('a private path')
      fails = false
      expect((await control('delete', { prefix: `u/${person}/` }, undefined, { on })).json()).toEqual({ removed: 0, more: false })
      expect(told).toEqual([person, person])
    } finally {
      await on.close()
    }
  })
})

describe('a version that was deleted', () => {
  ownService(false)

  test('stays deleted: the message that declared its files, sent again, declares nothing, and its grant uploads nothing', async () => {
    const prefix = `u/${USER}/replayed/1/`
    const data = 'revived'
    const body = { prefix, files: [entry('index.html', data)] }
    const message = await sign('it-control', 'stage', { h: sha256(JSON.stringify(body)) })
    const grant = await grantFor(prefix)
    expect((await control('stage', body, message)).status).toBe(200)
    expect((await upload('index.html', data, { prefix, grant })).status).toBe(200)
    expect((await control('delete', { prefix })).json()).toEqual({ removed: 2, more: false })
    expect((await upload('index.html', data, { prefix, grant })).status).toBe(403)
    // The very message, while it is still good: it arrived late, or someone kept it
    const again = await control('stage', body, message)
    expect([again.status, again.buf.length]).toEqual([409, 0])
    expect((await upload('index.html', data, { prefix, grant })).status).toBe(403)
    // Nor does one the backend signs afresh
    expect((await control('stage', body)).status).toBe(409)
    expect((await upload('index.html', data, { prefix, grant })).status).toBe(403)
    expect(wrote((e) => e.event === 'control.refused' && e.reason === 'version_deleted')).toMatchObject({ op: 'stage' })
    expect((await control('verify', { prefix, files: [] })).json()).toEqual({ ok: true, missing: [] })
    // Another version of the same page is declared as usual
    expect((await stage(`u/${USER}/replayed/2/`, [entry('index.html', data)])).status).toBe(200)
  })

  test('deleted at the very moment its files are being declared: nothing stays declared, and a message that comes after writes nothing at all', async () => {
    const own = make()
    const on = own.content
    began = lines.length
    try {
      const prefix = `u/${USER}/raced/1/`
      const body = { prefix, files: [entry('index.html', 'x')] }
      // The message has been looked at, and its version was not deleted then. Before anything is written, it is
      const held = await atTheNextFolder()
      const staging = control('stage', body, undefined, { on })
      await held.reached
      expect((await control('delete', { prefix }, undefined, { on })).json()).toEqual({ removed: 0, more: false })
      held.goOn()
      const staged = await staging
      expect([staged.status, staged.buf.length]).toEqual([409, 0])
      expect(wrote((e) => e.event === 'control.refused' && e.reason === 'version_deleted')).toMatchObject({ op: 'stage' })
      // What was written in between is gone again, and nothing can be uploaded under it
      expect(filesUnder(path.join(own.settings.dir, 'manifest'))).toEqual([])
      expect((await upload('index.html', 'x', { prefix, on })).status).toBe(403)
      // Told again now that it is deleted, the service does not so much as make a folder
      const made = vi.mocked(fsp.mkdir).mock.calls.length
      expect((await control('stage', body, undefined, { on })).status).toBe(409)
      expect(vi.mocked(fsp.mkdir).mock.calls.length).toBe(made)
    } finally {
      await on.close()
    }
  })

  test('deleted at the very moment one of its files is arriving: the file is not kept', async () => {
    const own = make()
    const on = own.content
    began = lines.length
    try {
      const prefix = `u/${USER}/arriving/1/`
      expect((await control('stage', { prefix, files: [entry('index.html', 'hello')] }, undefined, { on })).status).toBe(200)
      // The upload has read what was declared, and found its file there. Before it writes anything, the version is deleted
      const held = await atTheNextFolder()
      const uploading = upload('index.html', 'hello', { prefix, on })
      await held.reached
      expect((await control('delete', { prefix }, undefined, { on })).json()).toEqual({ removed: 1, more: false })
      held.goOn()
      const uploaded = await uploading
      expect([uploaded.status, uploaded.buf.length]).toEqual([403, 0])
      expect(wrote((e) => e.event === 'upload.refused' && e.reason === 'version_deleted_meanwhile')).toMatchObject({ prefix })
      // Neither the file nor the folders made for it are left
      expect(filesUnder(path.join(own.settings.dir, 'u'))).toEqual([])
      expect(existsSync(path.join(own.settings.dir, 'u', USER, 'arriving'))).toBe(false)
      expect(arrivingUnder(path.join(own.settings.dir, 'tmp'))).toEqual([])
    } finally {
      await on.close()
    }
  })

  test('takes nothing new when it was its page, or its person, that was deleted', async () => {
    const files = [entry('index.html', 'x')]
    const person = `u/gone-${randomUUID()}/`
    expect((await stage(`${person}page/1/`, files)).status).toBe(200)
    expect((await control('delete', { prefix: `${person}page/` })).status).toBe(200)
    expect((await stage(`${person}page/1/`, files)).status).toBe(409)
    expect((await stage(`${person}page/2/`, files)).status).toBe(409)
    // Another page of the same person is untouched
    expect((await stage(`${person}another/1/`, files)).status).toBe(200)
    expect((await control('delete', { prefix: person })).status).toBe(200)
    expect((await stage(`${person}another/2/`, files)).status).toBe(409)
    expect((await stage(`${person}new/1/`, files)).status).toBe(409)
    // And a person whose name only begins the same is another person
    expect((await stage(`${person.slice(0, -1)}x/page/1/`, files)).status).toBe(200)
  })

  test('ends every showing of it at once, and a ticket made for it opens nothing, whether it was the version, its page or its person that was deleted', async () => {
    const person = `shown-${randomUUID()}`
    const [first, second, beside] = [`u/${person}/page/1/`, `u/${person}/page/2/`, `u/${person}/another/1/`]
    await seedFiles(first, { 'index.html': 'FIRST' })
    await seedFiles(second, { 'index.html': 'SECOND' })
    await seedFiles(beside, { 'index.html': 'BESIDE' })
    // A person whose name only begins the same is another person
    const neighbour = `u/${person}x/page/1/`
    await seedFiles(neighbour, { 'index.html': 'NEIGHBOUR' })
    const of = (prefix: string) => ({ u: prefix.split('/')[1]!, p: prefix, v: prefix.split('/')[3]! })
    const [one, two, other, next] = [await open(of(first)), await open(of(second)), await open(of(beside)), await open(of(neighbour))]
    const going = async (shown: Opened) => (await show(`${shown.at}/__it/keep`)).status
    // Tickets the site was given and has not yet used
    const [forFirst, forSecond, forBeside] = [ticket(newMount(), of(first)), ticket(newMount(), of(second)), ticket(newMount(), of(beside))]
    expect([await going(one), await going(two), await going(other), await going(next)]).toEqual([204, 204, 204, 204])

    // One version: its showing is over, and the document that is still open hears so when it asks to be kept
    expect((await control('delete', { prefix: first })).status).toBe(200)
    expect([await going(one), (await show(`${one.at}/v/1/index.html`)).status]).toEqual([401, 401])
    expect((await redeem(forFirst)).status).toBe(401)
    expect([await going(two), await going(other)]).toEqual([204, 204])
    // Its page: every version's
    expect((await control('delete', { prefix: `u/${person}/page/` })).status).toBe(200)
    expect([await going(two), (await show(`${two.at}/v/2/index.html`)).status]).toEqual([401, 401])
    expect((await redeem(forSecond)).status).toBe(401)
    // Nor does a ticket signed after it was deleted open anything
    expect((await redeem(ticket(newMount(), of(second)))).status).toBe(401)
    expect(await going(other)).toBe(204)
    // Its person: everything of theirs
    expect((await control('delete', { prefix: `u/${person}/` })).status).toBe(200)
    expect(await going(other)).toBe(401)
    expect((await redeem(forBeside)).status).toBe(401)
    // And nobody else's
    expect([await going(next), (await show(`${next.at}/v/1/index.html`)).text]).toEqual([204, 'NEIGHBOUR'])
    expect((await redeem(ticket(newMount(), of(neighbour)))).status).toBe(303)
    // It is written down that they ended, and why a ticket was refused
    expect(wrote((e) => e.event === 'control.delete' && e.prefix === first)).toMatchObject({ showings: 1 })
    expect(wrote((e) => e.event === 'control.delete' && e.prefix === `u/${person}/page/`)).toMatchObject({ showings: 1 })
    expect(wrote((e) => e.event === 'ticket.refused' && e.reason === 'deleted')).toMatchObject({ u: person, d: 'display1' })
  })

  test('ends a showing that another service has open on the same folder, which was not the one told of the deletion', async () => {
    const one = make()
    const two = createContent(one.settings)
    try {
      const prefix = `u/shared-${randomUUID()}/page/1/`
      await seedFiles(prefix, { 'index.html': 'x' }, one.content)
      const shown = await open({ u: prefix.split('/')[1]!, p: prefix }, { on: one.content })
      expect((await show(`${shown.at}/__it/keep`, { on: one.content })).status).toBe(204)
      expect((await control('delete', { prefix }, undefined, { on: two })).status).toBe(200)
      expect((await show(`${shown.at}/__it/keep`, { on: one.content })).status).toBe(401)
      expect((await show(`${shown.at}/v/1/index.html`, { on: one.content })).status).toBe(401)
      expect(wrote((e) => e.event === 'showing.refused' && e.reason === 'deleted')).toMatchObject({ d: 'display1' })
    } finally {
      await one.content.close()
      await two.close()
    }
  })

  test('is still deleted when the service starts again', async () => {
    const first = make()
    const prefix = `u/${USER}/remembered/1/`
    const body = { prefix, files: [entry('index.html', 'x')] }
    const message = await sign('it-control', 'stage', { h: sha256(JSON.stringify(body)) })
    expect((await control('stage', body, message, { on: first.content })).status).toBe(200)
    expect((await control('delete', { prefix }, undefined, { on: first.content })).status).toBe(200)
    await first.content.close()
    const again = createContent(first.settings)
    try {
      expect((await control('stage', body, message, { on: again })).status).toBe(409)
      expect((await upload('index.html', 'x', { prefix, on: again })).status).toBe(403)
    } finally {
      await again.close()
    }
  })

  test('is remembered for longer than anything signed before it was deleted stays good', async () => {
    clock.start()
    const prefix = `u/${USER}/later/1/`
    const body = { prefix, files: [entry('index.html', 'x')] }
    const message = await sign('it-control', 'stage', { h: sha256(JSON.stringify(body)) })
    const grant = await grantFor(prefix)
    expect((await control('stage', body, message)).status).toBe(200)
    expect((await control('delete', { prefix })).status).toBe(200)
    // The grant is good for a quarter of an hour, and the message for a minute
    clock.pass(16 * 60)
    expect((await control('stage', body)).status).toBe(409)
    expect((await control('stage', body, message)).status).toBe(401)
    expect((await upload('index.html', 'x', { prefix, grant })).status).toBe(401)
  })
})

describe('uploads', () => {
  ownService(false)

  test('an upload needs a grant for that very folder', async () => {
    const prefix = `u/${USER}/up/1/`
    await stage(prefix, [entry('index.html', 'hello')])
    expect((await upload('index.html', 'hello', { prefix })).status).toBe(200)
    expect((await upload('index.html', 'hello', { prefix, grant: 'nonsense' })).status).toBe(401)
    expect((await upload('index.html', 'hello', { prefix, grant: await sign('it-content', prefix, { p: prefix }) })).status).toBe(401)
    expect((await upload('index.html', 'hello', { prefix, grant: await sign('it-upload', prefix, { p: prefix }, { key: stranger.privateKey }) })).status).toBe(
      401,
    )
    expect((await upload('index.html', 'hello', { prefix, grant: await sign('it-upload', 'u/other/x/1/', { p: prefix }) })).status).toBe(401)
    expect((await upload('index.html', 'hello', { prefix, grant: await sign('it-upload', 'u/', { p: 'u/' }) })).status).toBe(401)
    expect((await upload('index.html', 'hello', { prefix, grant: await sign('it-upload', '../../x/1/', { p: '../../x/1/' }) })).status).toBe(401)
  })

  test('a grant allows exactly the files that were declared: that path, that size, those bytes', async () => {
    const prefix = `u/${USER}/exact/1/`
    await stage(prefix, [entry('index.html', 'hello'), entry('app.js', 'let a = 1')])
    // Nothing that was not declared, however small
    expect((await upload('extra.js', 'x', { prefix })).status).toBe(403)
    expect((await upload('index.htm', 'hello', { prefix })).status).toBe(403)
    for (const p of ['..%2Fescape.html', '%2Fabsolute', 'a%2F..%2F..%2Fb']) expect((await upload(p, 'x', { prefix })).status).toBe(403)
    // Not a different size, not other bytes, not a checksum of the sender's choosing
    expect((await upload('index.html', 'hello world', { prefix })).status).toBe(400)
    expect((await upload('index.html', 'HELLO', { prefix })).status).toBe(400)
    expect((await upload('index.html', 'HELLO', { prefix, sha: sha256('hello') })).status).toBe(400)
    expect((await upload('index.html', 'hello', { prefix, sha: 'not-a-checksum' })).status).toBe(400)
    // Nor more or fewer bytes than it said it would send
    expect((await upload('index.html', 'hello and more', { prefix, sha: sha256('hello'), length: '5' })).status).toBe(400)
    expect((await upload('index.html', 'hell', { prefix, sha: sha256('hello'), length: '5' })).status).toBe(400)
    // And it must say how long it is: a body of unknown length is not read
    expect((await upload('index.html', 'hello', { prefix, length: null })).status).toBe(400)
    // A version with no declaration at all accepts nothing
    expect((await upload('index.html', 'hello', { prefix: `u/${USER}/undeclared/1/` })).status).toBe(403)
    // None of that left anything behind
    expect((await control('verify', { prefix, files: [] })).json()).toEqual({ ok: true, missing: [] })
    expect((await upload('index.html', 'hello', { prefix })).status).toBe(200)
    expect((await upload('app.js', 'let a = 1', { prefix })).status).toBe(200)
    expect((await control('verify', { prefix, files: [entry('index.html', 'hello'), entry('app.js', 'let a = 1')] })).json().ok).toBe(true)
  })

  test('a version cannot be changed once it is live: the same grant can only write the same bytes again', async () => {
    const prefix = `u/${USER}/sealed/1/`
    const grant = await grantFor(prefix)
    await stage(prefix, [entry('index.html', 'the verified page')])
    expect((await upload('index.html', 'the verified page', { prefix, grant })).status).toBe(200)
    expect((await control('verify', { prefix, files: [entry('index.html', 'the verified page')] })).json().ok).toBe(true)
    // After verification, with the grant still good for minutes
    expect((await upload('index.html', 'the replaced page', { prefix, grant })).status).toBe(400)
    expect((await upload('index.html', 'the replaced page', { prefix, grant, sha: sha256('the verified page') })).status).toBe(400)
    expect((await upload('late-addition.js', 'x', { prefix, grant })).status).toBe(403)
    expect((await upload('index.html', 'the verified page', { prefix, grant })).status).toBe(200)
    expect((await control('verify', { prefix, files: [entry('index.html', 'the verified page')] })).json().ok).toBe(true)
  })

  test('an empty file can be published like any other', async () => {
    const prefix = `u/${USER}/empties/1/`
    await stage(prefix, [entry('empty.css', ''), entry('index.html', INDEX)])
    expect((await upload('empty.css', '', { prefix, length: '0' })).status).toBe(200)
    expect((await upload('index.html', INDEX, { prefix })).status).toBe(200)
    expect((await control('verify', { prefix, files: [entry('empty.css', ''), entry('index.html', INDEX)] })).json()).toEqual({ ok: true, missing: [] })
    const { at } = await open({ p: prefix })
    const empty = await show(`${at}/v/1/empty.css`)
    expect([empty.status, empty.buf.length, empty.headers.get('content-type')]).toEqual([200, 0, 'text/css; charset=utf-8'])
  })

  test('a file’s name cannot lead out of the folder, whatever it holds', async () => {
    const own = make()
    try {
      const on = own.content
      const prefix = `u/${USER}/names/1/`
      // A name that climbs out, starts at the root, or hides a way out is never declared, and never stored
      for (const bad of [
        '../escape.txt',
        '../../../escape.txt',
        '/etc/escape.txt',
        'a/../../escape.txt',
        'a\\..\\..\\escape.txt',
        'a/./b',
        'a//b',
        'x\0y',
        '..',
        '.',
      ])
        expect((await control('stage', { prefix, files: [entry(bad, 'x')] }, undefined, { on })).status, bad).toBe(400)
      // Names a page may have, each of which some filesystem would take to mean something else:
      // a way up spelled in a way nothing decodes, a drive, a device, two that differ only in
      // case, one that is also a folder's, one as long as a path may be
      const odd: Record<string, string> = {
        '..%2f..%2fescape.txt': 'percent signs are only characters',
        '...': 'three dots',
        '~': 'home',
        'C:escape.txt': 'a drive',
        con: 'a device',
        'aux.txt': 'another',
        'Read.me': 'capitals',
        'read.me': 'and none',
        dir: 'a file',
        'dir/inside': 'and a folder of the same name',
        'trailing dot.': 'a dot at the end',
        ' leading space': 'a space at the start',
        [`${'long'.repeat(70)}/${'x'.repeat(19)}`]: 'three hundred bytes',
        'ünïcödé/файл.txt': 'other alphabets',
      }
      const files = Object.entries(odd).map(([p, data]) => entry(p, data))
      expect((await control('stage', { prefix, files }, undefined, { on })).status).toBe(200)
      for (const [p, data] of Object.entries(odd)) expect((await upload(inAddress(p), data, { prefix, on })).status, p).toBe(200)
      expect((await control('verify', { prefix, files }, undefined, { on })).json()).toEqual({ ok: true, missing: [] })
      // Each comes back as it went in
      const { at } = await open({ p: prefix }, { on })
      for (const [p, data] of Object.entries(odd)) {
        const r = await show(`${at}/v/1/${inAddress(p)}`, { on })
        expect([p, r.status, r.text]).toEqual([p, 200, data])
      }
      // And what is on the disk is one plain file for each, in the version's own folder, under a
      // name that holds nothing of the path: nothing beside the folder, and nothing above it
      const home = path.dirname(own.settings.dir)
      expect(readdirSync(home).sort()).toEqual(['content', 'content-data'])
      expect(readdirSync(own.settings.dir).sort()).toEqual(['manifest', 'tmp', 'u'])
      const kept = filesUnder(path.join(own.settings.dir, 'u'))
      expect(kept.length).toBe(files.length)
      for (const f of kept) expect(f).toMatch(new RegExp(`^${USER}/names/1/[0-9a-f]{64}$`))
      // A page is private on the disk as well: its files and its folders are the person's alone
      // to read. That is looked at where a file has a mode that says who may read it. Windows
      // keeps that in another way, and gives every file the same mode whoever may read it, so
      // there the modes are not looked at, and no test here says who may read a file on it.
      if (process.platform !== 'win32') {
        const mode = (...parts: string[]) => statSync(path.join(own.settings.dir, ...parts)).mode & 0o777
        expect([mode('u', kept[0]!), mode('manifest', 'u', USER, 'names', '1', 'files.json')]).toEqual([0o600, 0o600])
        for (const folder of [[], ['u'], ['u', USER, 'names', '1'], ['manifest', 'u', USER], ['tmp']]) expect(mode(...folder) & 0o077, folder.join('/')).toBe(0)
        expect(statSync(own.settings.data).mode & 0o077).toBe(0)
      }
      expect(filesUnder(path.join(own.settings.dir, 'manifest'))).toEqual([`u/${USER}/names/1/files.json`])
      expect(arrivingUnder(path.join(own.settings.dir, 'tmp'))).toEqual([])
      expect(readdirSync(root).filter((name) => !name.startsWith('service-'))).toEqual([])
    } finally {
      await own.content.close()
    }
  })

  test('an upload that is refused, or cut short, leaves nothing on the disk', async () => {
    const own = make()
    try {
      const on = own.content
      const prefix = `u/${USER}/partial/1/`
      await control('stage', { prefix, files: [entry('index.html', 'hello')] }, undefined, { on })
      expect((await upload('index.html', 'HELLO', { prefix, sha: sha256('hello'), on })).status).toBe(400)
      // The sender stops part of the way through
      const cut = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(Buffer.from('he'))
          controller.error(new Error('the connection dropped'))
        },
      })
      const headers = { authorization: `Bearer ${await grantFor(prefix)}`, 'x-it-sha256': sha256('hello'), 'content-length': '5' }
      const broken = await on.upload(
        new Request(`http://localhost:${BASE}/upload/index.html`, { method: 'PUT', headers, body: cut, duplex: 'half' } as RequestInit),
        {
          port: BASE,
          address: '127.0.0.1',
        },
      )
      expect(broken.status).toBe(400)
      expect(filesUnder(path.join(own.settings.dir, 'u'))).toEqual([])
      expect(arrivingUnder(path.join(own.settings.dir, 'tmp'))).toEqual([])
    } finally {
      await own.content.close()
    }
  })

  test('what was still arriving at a service that has ended is cleared away when another starts, and what is arriving at one that is running is left', async () => {
    const own = make()
    await own.content.close()
    const tmp = path.join(own.settings.dir, 'tmp')
    // A program that has ended: its number is no running program's
    const ended = spawnSync(process.execPath, ['-e', '']).pid
    // And one that is running, which is not this one
    const running = process.ppid
    /** A folder as a service of that program would have left it: under the name a service gives one, with the note that says so, and half a file. */
    const left = (pid: number) => {
      const name = `${pid}-${randomUUID()}`
      mkdirSync(path.join(tmp, name), { recursive: true })
      writeFileSync(path.join(tmp, name, 'holder'), name)
      writeFileSync(path.join(tmp, name, 'half-a-file'), 'half')
      return name
    }
    const theirs = left(running)
    left(ended)
    // This very program's number, from an earlier life of it
    left(process.pid)
    const again = createContent(own.settings)
    try {
      const names = readdirSync(tmp)
      expect(names.filter((name) => name !== theirs)).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-[0-9a-f-]{36}$`))])
      expect(arrivingUnder(tmp)).toEqual([`${theirs}/half-a-file`])
    } finally {
      await again.close()
    }
    // It takes its own away when it closes, and still not the other's
    expect(readdirSync(tmp)).toEqual([theirs])
  })

  test('nothing in the folder for what is arriving is removed but a folder a service made there: whatever else is in it is somebody’s own, whatever it is called', async () => {
    const own = make()
    await own.content.close()
    const tmp = path.join(own.settings.dir, 'tmp')
    const ended = spawnSync(process.execPath, ['-e', '']).pid
    const named = () => `${ended}-${randomUUID()}`
    const outside = mkdtempSync(path.join(root, 'outside-'))
    writeFileSync(path.join(outside, 'valuable.txt'), 'KEEP')
    // A folder and a file of a person's own
    mkdirSync(path.join(tmp, 'family-photos'))
    writeFileSync(path.join(tmp, 'family-photos', 'precious'), 'not made by It')
    writeFileSync(path.join(tmp, 'a-stray-file'), 'stray')
    // A folder under the name a service gives one, of a program that has ended, with no note in it
    const noted = { none: named(), another: named(), aFolder: named(), long: named() }
    mkdirSync(path.join(tmp, noted.none))
    writeFileSync(path.join(tmp, noted.none, 'mine'), 'kept here by hand')
    // One whose note is for a folder of another name, as a copy of a folder would hold
    mkdirSync(path.join(tmp, noted.another))
    writeFileSync(path.join(tmp, noted.another, 'holder'), named())
    // One whose note is no file, and one whose note says more than the name
    mkdirSync(path.join(tmp, noted.aFolder, 'holder'), { recursive: true })
    mkdirSync(path.join(tmp, noted.long))
    writeFileSync(path.join(tmp, noted.long, 'holder'), `${noted.long}\n`)
    // A file under such a name
    const file = named()
    writeFileSync(path.join(tmp, file), 'a file')
    // And a link under such a name, to a folder elsewhere that holds the very note, where whoever runs the tests may make a link
    const link = named()
    if (canLink) {
      writeFileSync(path.join(outside, 'holder'), link)
      symlinkSync(outside, path.join(tmp, link), 'dir')
    }
    const before = readdirSync(tmp).sort()
    for (const runs of [1, 2]) {
      const again = createContent(own.settings)
      await again.close()
      expect([runs, readdirSync(tmp).sort()]).toEqual([runs, before])
    }
    expect(filesUnder(path.join(tmp, 'family-photos'))).toEqual(['precious'])
    expect(readFileSync(path.join(tmp, noted.none, 'mine'), 'utf8')).toBe('kept here by hand')
    expect(readFileSync(path.join(outside, 'valuable.txt'), 'utf8')).toBe('KEEP')
    if (canLink) expect(lstatSync(path.join(tmp, link)).isSymbolicLink()).toBe(true)
  })

  test('a disk that fails as a file is made safe, closed or moved leaves nothing of the file behind', async () => {
    const own = make()
    const on = own.content
    const tmp = path.join(own.settings.dir, 'tmp')
    const prefix = `u/${USER}/disk/1/`
    const real = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open
    await control('stage', { prefix, files: [entry('index.html', 'hello'), entry('other.html', 'other')] }, undefined, { on })
    /** Opens files as usual, with one thing a file being written is asked to do made to fail as a full disk does. */
    const failing = (what: 'sync' | 'close' | 'write') =>
      vi.mocked(fsp.open).mockImplementation(async (...args: Parameters<typeof real>) => {
        const handle = await real(...args)
        if (args[1] !== 'wx') return handle
        const usual = handle[what].bind(handle) as (...given: unknown[]) => Promise<unknown>
        ;(handle as unknown as Record<string, unknown>)[what] = async (...given: unknown[]) => {
          // A file is still closed when closing it is what fails, as the system does it
          if (what === 'close') await usual(...given)
          throw Object.assign(new Error('a private word about the disk'), { code: 'ENOSPC' })
        }
        return handle
      })
    try {
      const before = written().length
      for (const what of ['sync', 'close', 'write'] as const) {
        failing(what)
        const r = await upload('index.html', 'hello', { prefix, on })
        expect([what, r.status, r.buf.length]).toEqual([what, 503, 0])
        expect([what, arrivingUnder(tmp), filesUnder(path.join(own.settings.dir, 'u'))]).toEqual([what, [], []])
      }
      // Said as the disk's trouble, by its kind and with none of its words
      const said = written().slice(before)
      expect(said.at(-1)).toMatchObject({ event: 'unavailable', level: 'error', part: 'upload', reason: 'storage', kind: 'ENOSPC' })
      expect(JSON.stringify(said)).not.toMatch(/private word/)
      // And what is declared for a version leaves nothing behind either when it cannot be kept
      failing('sync')
      expect((await control('stage', { prefix: `u/${USER}/disk/2/`, files: [entry('index.html', 'x')] }, undefined, { on })).status).toBe(500)
      expect(arrivingUnder(tmp)).toEqual([])
    } finally {
      vi.mocked(fsp.open).mockImplementation(real)
    }
    // With the disk as it should be, the same upload goes through
    expect((await upload('index.html', 'hello', { prefix, on })).status).toBe(200)
    await on.close()
  })

  test('a second service started on the same folders leaves what is arriving at the first', async () => {
    const one = make()
    const tmp = path.join(one.settings.dir, 'tmp')
    const prefix = `u/${USER}/two-services/1/`
    const data = 'one whole upload'
    const files = [entry('index.html', data)]
    await control('stage', { prefix, files }, undefined, { on: one.content })
    let send!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        send = controller
      },
    })
    const headers = { authorization: `Bearer ${await grantFor(prefix)}`, 'x-it-sha256': sha256(data), 'content-length': String(data.length) }
    const arriving = one.content.upload(
      new Request(`http://localhost:${BASE}/upload/index.html`, { method: 'PUT', headers, body, duplex: 'half' } as RequestInit),
      { port: BASE, address: '127.0.0.1' },
    )
    send.enqueue(Buffer.from(data.slice(0, 9)))
    // Part of the file is on the disk, and the rest has not come
    for (let i = 0; i < 400 && arrivingUnder(tmp).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(arrivingUnder(tmp).length).toBe(1)
    const two = createContent(one.settings)
    try {
      expect(arrivingUnder(tmp).length).toBe(1)
      send.enqueue(Buffer.from(data.slice(9)))
      send.close()
      expect((await arriving).status).toBe(200)
      for (const on of [one.content, two]) expect((await control('verify', { prefix, files }, undefined, { on })).json()).toEqual({ ok: true, missing: [] })
      // And the second takes uploads of its own beside it
      const other = `u/${USER}/two-services/2/`
      await seedFiles(other, { 'index.html': 'through the second' }, two)
      expect(arrivingUnder(tmp)).toEqual([])
    } finally {
      await two.close()
      await one.content.close()
    }
    expect(readdirSync(tmp)).toEqual([])
  })
})

describe('an upload that goes on past what it said', () => {
  ownService(false)

  test('is stopped as soon as it has sent more than was declared, and is not read to its end', async () => {
    const prefix = `u/${USER}/toolong/1/`
    await stage(prefix, [entry('index.html', 'hello')])
    began = lines.length
    let [asked, letGo] = [0, false]
    // It says five bytes, as was declared, sends more than that, and then never ends
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        asked += 1
        if (asked === 1) return controller.enqueue(Buffer.from('hello, and a good deal more than was said'))
        return new Promise<void>(() => {})
      },
      cancel() {
        letGo = true
      },
    })
    const sent = new Request(`http://localhost:${BASE}/upload/index.html`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${await grantFor(prefix)}`, 'x-it-sha256': sha256('hello'), 'content-length': '5' },
      body,
      duplex: 'half',
    } as RequestInit)
    const answered = await Promise.race([content.upload(sent, { port: BASE, address: '127.0.0.1' }), new Promise<null>((r) => setTimeout(() => r(null), 3000))])
    expect(answered?.status).toBe(400)
    expect(letGo).toBe(true)
    expect(wrote((e) => e.event === 'upload.refused' && e.reason === 'size_differs')).toMatchObject({ prefix })
    // Nothing of it is kept, where files are kept or where they arrive
    expect((await control('verify', { prefix, files: [entry('index.html', 'hello')] })).json()).toEqual({ ok: false, missing: ['index.html'] })
  })
})

// Left out where whoever runs the tests may not make a link: see `canLink`
describe.skipIf(!canLink)('a link in the content folder', () => {
  // Nothing the service does makes one. These are put there by hand, as someone with the
  // machine's files could, each pointing at a folder outside the content folder.
  let own: ReturnType<typeof make>
  let on: Content
  let outside: string
  const said = () => written().filter((e) => e.event === 'unexpected' || e.event === 'unavailable')
  beforeAll(async () => {
    began = lines.length
    own = make()
    on = own.content
    outside = mkdtempSync(path.join(root, 'outside-'))
    mkdirSync(path.join(outside, 'page', '1'), { recursive: true })
    writeFileSync(path.join(outside, 'valuable.txt'), 'KEEP')
    writeFileSync(path.join(outside, 'page', '1', 'valuable.txt'), 'KEEP TOO')
  })
  afterAll(() => on.close())
  const intact = () => [readFileSync(path.join(outside, 'valuable.txt'), 'utf8'), readFileSync(path.join(outside, 'page', '1', 'valuable.txt'), 'utf8')]
  const sha = (name: string) => createHash('sha256').update(name).digest('hex')

  test('where a page’s folder should be: nothing is deleted through it, and deleting what holds it removes the link and nothing it points to', async () => {
    mkdirSync(path.join(own.settings.dir, 'u', 'linker'), { recursive: true })
    const link = path.join(own.settings.dir, 'u', 'linker', 'linked')
    symlinkSync(outside, link, 'dir')
    for (const prefix of ['u/linker/linked/', 'u/linker/linked/1/']) {
      const r = await control('delete', { prefix }, undefined, { on })
      expect([prefix, r.status, r.buf.length]).toEqual([prefix, 500, 0])
    }
    expect(intact()).toEqual(['KEEP', 'KEEP TOO'])
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    // What is written down is the kind of trouble, and nothing of where
    expect(said().at(-1)).toMatchObject({ event: 'unexpected', level: 'error', part: 'control', kind: 'LINKED' })
    expect(JSON.stringify(said())).not.toMatch(/outside|linker|valuable/)
    // The person's own folder is a folder. Deleting it removes the link in it, as the link it is
    expect((await control('delete', { prefix: 'u/linker/' }, undefined, { on })).json()).toEqual({ removed: 1, more: false })
    expect(existsSync(path.join(own.settings.dir, 'u', 'linker'))).toBe(false)
    expect(intact()).toEqual(['KEEP', 'KEEP TOO'])
  })

  test('where a person’s folder should be: nothing is declared, uploaded, checked or read through it', async () => {
    symlinkSync(outside, path.join(own.settings.dir, 'u', 'person'), 'dir')
    mkdirSync(path.join(own.settings.dir, 'manifest', 'u'), { recursive: true })
    symlinkSync(outside, path.join(own.settings.dir, 'manifest', 'u', 'person'), 'dir')
    const prefix = 'u/person/page/1/'
    const files = [entry('valuable.txt', 'KEEP TOO'), entry('new.txt', 'new')]
    expect((await control('stage', { prefix, files }, undefined, { on })).status).toBe(500)
    expect((await control('verify', { prefix, files }, undefined, { on })).status).toBe(500)
    expect((await upload('new.txt', 'new', { prefix, on })).status).toBe(500)
    // A showing whose files would be there is given none of what the link leads to
    renameSync(path.join(outside, 'page', '1', 'valuable.txt'), path.join(outside, 'page', '1', sha('valuable.txt')))
    const { at } = await open({ p: prefix, u: 'person' }, { on })
    const r = await show(`${at}/v/1/valuable.txt`, { on })
    expect([r.status, r.buf.length]).toEqual([500, 0])
    expectConfined('a fault', r)
    renameSync(path.join(outside, 'page', '1', sha('valuable.txt')), path.join(outside, 'page', '1', 'valuable.txt'))
    // Nor is anything deleted through it. That it was to be deleted is noted all the same, and its showing is over
    expect((await control('delete', { prefix }, undefined, { on })).status).toBe(500)
    expect((await show(`${at}/__it/keep`, { on })).status).toBe(401)
    expect(intact()).toEqual(['KEEP', 'KEEP TOO'])
    expect(readdirSync(outside).sort()).toEqual(['page', 'valuable.txt'])
    expect(readdirSync(path.join(outside, 'page', '1'))).toEqual(['valuable.txt'])
  })

  test('where a file should be: it is no file, and deleting the version removes the link and not what it points to', async () => {
    const prefix = `u/${USER}/withlink/1/`
    await seedFiles(prefix, { 'real.txt': 'a real file' }, on)
    // A link under the name a declared file would be kept by, to a file outside
    symlinkSync(path.join(outside, 'valuable.txt'), path.join(own.settings.dir, 'u', USER, 'withlink', '1', sha('linked.txt')), 'file')
    // And a link to a folder, among the version's files
    symlinkSync(outside, path.join(own.settings.dir, 'u', USER, 'withlink', '1', 'folder'), 'dir')
    const { at } = await open({ p: prefix }, { on })
    expect((await show(`${at}/v/1/real.txt`, { on })).text).toBe('a real file')
    const through = await show(`${at}/v/1/linked.txt`, { on })
    expect([through.status, through.buf.length]).toEqual([404, 0])
    // It is not counted among what is stored, and is not checked as if it were
    const checked = await control('verify', { prefix, files: [entry('real.txt', 'a real file'), entry('linked.txt', 'KEEP')] }, undefined, { on })
    expect(checked.json()).toEqual({ ok: false, missing: ['linked.txt'] })
    expect((await control('delete', { prefix }, undefined, { on })).json()).toEqual({ removed: 4, more: false })
    expect(existsSync(path.join(own.settings.dir, 'u', USER, 'withlink', '1'))).toBe(false)
    expect(intact()).toEqual(['KEEP', 'KEEP TOO'])
  })

  // Without the system's own word for it, on Windows, a file is opened by what was looked at a moment before
  test.skipIf(process.platform === 'win32')(
    'put where a file was between the look at the file and the opening of it: it is not followed, and nothing it points to is given',
    async () => {
      const prefix = `u/${USER}/swapped/1/`
      await seedFiles(prefix, { 'real.txt': 'a real file' }, on)
      const kept = path.join(own.settings.dir, 'u', USER, 'swapped', '1', sha('real.txt'))
      const { at } = await open({ p: prefix }, { on })
      const real = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open
      // The file was looked at, and was a file. As it is opened it is one no more: a link to a file outside is there
      vi.mocked(fsp.open).mockImplementationOnce((async (...given: Parameters<typeof real>) => {
        rmSync(kept)
        symlinkSync(path.join(outside, 'valuable.txt'), kept, 'file')
        return real(...given)
      }) as typeof real)
      const r = await show(`${at}/v/1/real.txt`, { on })
      expect([r.status, r.buf.length]).toEqual([404, 0])
      expectConfined('a link put where a file was', r)
      expect(lstatSync(kept).isSymbolicLink()).toBe(true)
      expect((await control('delete', { prefix }, undefined, { on })).json()).toEqual({ removed: 2, more: false })
      expect(intact()).toEqual(['KEEP', 'KEEP TOO'])
    },
  )

  test('the content folder itself may be reached through a link, as a person may keep it elsewhere', async () => {
    const kept = mkdtempSync(path.join(root, 'kept-elsewhere-'))
    const link = path.join(root, `link-${randomUUID()}`)
    symlinkSync(kept, link, 'dir')
    const through = make({ dir: path.join(link, 'content') }).content
    try {
      const prefix = `u/${USER}/through/1/`
      await seedFiles(prefix, { 'index.html': INDEX }, through)
      const { at } = await open({ p: prefix }, { on: through })
      expect((await show(`${at}/v/1/index.html`, { on: through })).text).toBe(INDEX)
      expect((await control('delete', { prefix }, undefined, { on: through })).json()).toEqual({ removed: 2, more: false })
    } finally {
      await through.close()
    }
  })
})

describe('anything else', () => {
  ownService()

  test('a path the service has no use for is told nothing, on the pages’ port or on the site’s', async () => {
    for (const p of [
      '/',
      '/health',
      '/install.sh',
      '/latest/SHA256SUMS',
      '/v/1',
      '/v/1/index.html',
      '/boot',
      '/session',
      '/session/check',
      '/__it/keep',
      '/__it/runtime.js',
      '/.well-known/jwks.json',
      '/s',
      '/s/',
    ]) {
      const r = await show(p)
      expect([p, r.status, r.buf.length]).toEqual([p, 404, 0])
    }
    // An upload or a message from the backend is the site's port's to take, never the pages'
    expect((await show('/upload/x', { method: 'PUT', body: 'x' })).status).toBe(405)
    expect((await show('/upload/x')).status).toBe(404)
    expect((await door('/upload/x')).status).toBe(404)
    expect((await door('/upload/', { method: 'PUT', body: 'x' })).status).toBe(404)
    expect((await door('/health')).status).toBe(404)
    expect((await door('/control/revoke')).status).toBe(404)
    expect((await door('/control/anything', { method: 'POST', body: '{}' })).status).toBe(404)
  })
})

describe('everything of one person’s, deleted', () => {
  test('takes with it what was counted under their id and what was remembered of having been said about them, and nobody else’s', async () => {
    // A count is kept under whose it is: a person, a showing of theirs on a display, a version of a page of theirs
    const reads = limit(2)
    const keys = ['erased', 'erased:display:mount', 'upload:u/erased/page/1/', 'upload:erased']
    for (const key of [...keys, 'stays', 'upload:u/stays/erased-page/1/x']) expect([reads(key), reads(key), reads(key)]).toEqual([false, false, true])
    reads.forget('erased')
    // Each of theirs is counted afresh, as one never counted is, and another person's is as it was
    for (const key of keys) expect([key, reads(key)]).toEqual([key, false])
    expect([reads('stays'), reads('upload:u/stays/erased-page/1/x')]).toEqual([true, true])

    // What was said about them is said again at once when it happens again: nothing is remembered of having said it
    const said: string[] = []
    const log = createLog((line) => said.push(line))
    log.seldom('showing.refused', 'erased:display', { u: 'erased' })
    log.seldom('showing.refused', 'erased:display', { u: 'erased' })
    log.seldom('showing.refused', 'stays:display', { u: 'stays' })
    expect(said).toHaveLength(2)
    log.forget('erased')
    log.seldom('showing.refused', 'erased:display', { u: 'erased' })
    log.seldom('showing.refused', 'stays:display', { u: 'stays' })
    expect(said.map((line) => JSON.parse(line))).toEqual([
      { event: 'showing.refused', level: 'warn', u: 'erased' },
      { event: 'showing.refused', level: 'warn', u: 'stays' },
      { event: 'showing.refused', level: 'warn', u: 'erased' },
    ])
  })

  /**
   * What a service holds in its memory under an id: each count of a limit and each line it
   * remembers having said, by the name it is kept under. The service keeps them in maps of its
   * own, which are found here as they are first written to.
   */
  function memory() {
    const maps = new Set<Map<unknown, unknown>>()
    const set = Map.prototype.set
    const watching = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (typeof key === 'string' && value !== null && typeof value === 'object' && ('count' in value || 'held' in value)) maps.add(this)
      return set.call(this, key, value)
    })
    return {
      /** The names of what is kept that have this id as one of their parts. */
      naming: (id: string) =>
        [...maps]
          .flatMap((map) => [...map.keys()])
          .filter((key): key is string => typeof key === 'string' && key.split(/[:/]/).includes(id))
          .sort(),
      stop: () => watching.mockRestore(),
    }
  }
  /** Gives a person everything the service counts and remembers under an id: files uploaded, a showing read from, an upload refused and a ticket tried twice. */
  async function busy(person: string, on: Content) {
    const prefix = `u/${person}/page/1/`
    await seedFiles(prefix, { 'index.html': 'x' }, on)
    const m = newMount()
    const t = await ticket(m, { u: person, p: prefix })
    const opened = await redeem(t, { on })
    expect([opened.status, (await show(`${sentTo(opened).split('/v/')[0]}/__it/keep`, { on })).status]).toEqual([303, 204])
    expect([(await upload('undeclared.txt', 'x', { prefix, on })).status, (await redeem(t, { on })).status]).toEqual([403, 401])
    return { prefix, m, under: sentTo(opened).split('/v/')[0]! }
  }

  test('is done by the service itself when the last of their files has gone: every count and every remembered line under their id goes, no other person’s does, and asking again changes nothing', async () => {
    const kept = memory()
    const on = make().content
    try {
      const [erased, stays] = [`erased-${randomUUID()}`, `stays-${randomUUID()}`]
      const theirs = await busy(erased, on)
      await busy(stays, on)
      // Reads by showing and by person, uploads by version and by person, and the two refusals that were said
      expect(kept.naming(erased)).toEqual(
        [
          erased,
          `${erased}:display1:${theirs.m}`,
          `upload:${erased}`,
          `upload:${theirs.prefix}`,
          `ticket.refused:${erased}:display1:spent`,
          `upload.refused:${theirs.prefix}:not_declared`,
        ].sort(),
      )
      const others = kept.naming(stays)
      expect(others).toHaveLength(6)
      expect((await control('delete', { prefix: `u/${erased}/` }, undefined, { on })).json()).toMatchObject({ more: false })
      expect([kept.naming(erased), kept.naming(stays)]).toEqual([[], others])
      // Asked again, as the backend asks until it is answered
      expect((await control('delete', { prefix: `u/${erased}/` }, undefined, { on })).json()).toEqual({ removed: 0, more: false })
      expect([kept.naming(erased), kept.naming(stays)]).toEqual([[], others])
    } finally {
      kept.stop()
      await on.close()
    }
  })

  test('counts nothing afterwards, and remembers nothing, under the id of a person whose grant to upload or whose ticket was made before', async () => {
    const kept = memory()
    const on = make().content
    began = lines.length
    try {
      const person = `erased-${randomUUID()}`
      const { prefix } = await busy(person, on)
      const [grant, late] = [await grantFor(prefix), await ticket(newMount(), { u: person, p: prefix })]
      expect((await control('delete', { prefix: `u/${person}/` }, undefined, { on })).status).toBe(200)
      const before = written().length
      // The grant is good for a quarter of an hour yet, and the ticket for a minute: each is refused, as often as it is tried
      for (let n = 0; n < 3; n++) {
        expect([(await upload('index.html', 'x', { prefix, grant, on })).status, (await upload('undeclared.txt', 'x', { prefix, grant, on })).status]).toEqual([
          403, 403,
        ])
        expect((await redeem(late, { on })).status).toBe(401)
      }
      expect(kept.naming(person)).toEqual([])
      // Each is said once, by what it was refused for, with nothing of whose it was
      expect(written().slice(before)).toEqual([
        { event: 'upload.refused', level: 'warn', reason: 'deleted' },
        { event: 'ticket.refused', level: 'warn', reason: 'deleted' },
      ])
      // A version of a page that was deleted, of a person who is still there, is refused and said as ever
      const stays = `stays-${randomUUID()}`
      const theirs = await busy(stays, on)
      expect((await control('delete', { prefix: theirs.prefix }, undefined, { on })).status).toBe(200)
      expect((await upload('index.html', 'x', { prefix: theirs.prefix, on })).status).toBe(403)
      expect(kept.naming(stays)).toEqual(expect.arrayContaining([`upload:${stays}`, `upload:${theirs.prefix}`, `upload.refused:${theirs.prefix}:not_declared`]))
    } finally {
      kept.stop()
      await on.close()
    }
  })

  test('counts nothing for an upload whose grant was still being checked when the last of the person’s files went', async () => {
    const kept = memory()
    let release!: () => void
    const held = new Promise<void>((go) => {
      release = go
    })
    // Two services with the one folder: the first is slow to read the backend's keys, and the second is the one told to delete
    const first = make({
      fetch: async (address: string, init: RequestInit) => {
        await held
        return fetch(address, init)
      },
    })
    const second = createContent({ ...first.settings, fetch: (address: string, init: RequestInit) => fetch(address, init) })
    try {
      const person = `erased-${randomUUID()}`
      const prefix = `u/${person}/page/1/`
      await seedFiles(prefix, { 'index.html': 'x' }, second)
      expect(kept.naming(person)).not.toEqual([])
      const uploading = upload('index.html', 'x', { prefix, on: first.content })
      await new Promise((r) => setTimeout(r, 20))
      expect((await control('delete', { prefix: `u/${person}/` }, undefined, { on: second })).json()).toMatchObject({ more: false })
      expect(kept.naming(person)).toEqual([])
      release()
      expect((await uploading).status).toBe(403)
      expect(kept.naming(person)).toEqual([])
    } finally {
      kept.stop()
      await first.content.close()
      await second.close()
    }
  })

  test('is learned of by a service that was not the one told, from what marks the files as removed, and it lets go of what it held under their id then', async () => {
    const kept = memory()
    const first = make()
    const second = createContent(first.settings)
    try {
      const person = `erased-${randomUUID()}`
      const { under, prefix, m } = await busy(person, first.content)
      expect(kept.naming(person)).toContain(`${person}:display1:${m}`)
      // The other service, with the same folder open, is the one the backend tells
      expect((await control('delete', { prefix: `u/${person}/` }, undefined, { on: second })).json()).toMatchObject({ more: false })
      expect(kept.naming(person)).not.toEqual([])
      // The first learns of it the next time its showing asks to be kept, refuses, and holds nothing more under their id
      expect((await show(`${under}/__it/keep`, { on: first.content })).status).toBe(401)
      expect(kept.naming(person)).toEqual([])
      expect((await upload('index.html', 'x', { prefix, on: first.content })).status).toBe(403)
      expect(kept.naming(person)).toEqual([])
    } finally {
      kept.stop()
      await first.content.close()
      await second.close()
    }
  })
})

describe('limits', () => {
  ownService()

  test('a page that asks without end is slowed down, for that showing only', async () => {
    const greedy = await open({ u: 'greedy' })
    const sameDisplay = await open({ u: 'greedy' })
    const otherDisplay = await open({ u: 'greedy', d: 'display2' })
    const someoneElse = await open()
    const statuses: number[] = []
    // Fifty at a time until it is told to slow down. The allowance is for a minute from the first one counted
    for (let sent = 0; sent < 4000 && !statuses.includes(429); sent += 50) {
      const batch = await Promise.all(Array.from({ length: 50 }, () => show(`${greedy.at}/__it/keep`)))
      statuses.push(...batch.map((r) => r.status))
    }
    expect(statuses.filter((n) => n === 204).length).toBe(3000)
    expect(statuses.filter((n) => n === 429).length).toBe(50)
    // The refusal carries nothing, and the page's bytes are refused the same way
    const refused = await show(`${greedy.at}/v/1/index.html`, { headers: DOCUMENT })
    expect([refused.status, refused.buf.length]).toEqual([429, 0])
    expectConfined('slowed down', refused)
    // Another showing on the same display is not held up: one page cannot use up what the next one needs
    expect((await show(`${sameDisplay.at}/__it/keep`)).status).toBe(204)
    // Nor is the same person on another display, or another person
    expect((await show(`${otherDisplay.at}/__it/keep`)).status).toBe(204)
    expect((await show(`${someoneElse.at}/v/1/asset.js`)).status).toBe(200)
  })

  test('everything one person has open is slowed down together past what a person may ask, though no showing of theirs has asked too much', async () => {
    // Twelve showings on twelve displays, each asking well within what one showing may
    const crowd = await Promise.all(Array.from({ length: 12 }, (_, n) => open({ u: 'crowded', d: `display${n}` })))
    const someoneElse = await open({ u: 'alone' })
    const statuses = crowd.map(() => [] as number[])
    const keep = (shown: Opened) => content.showing(request(PAGES, `${shown.at}/__it/keep`, {}), { port: PAGES, address: '127.0.0.1' }).then((r) => r.status)
    for (let round = 0; round < 26; round++)
      for (const [n, shown] of crowd.entries()) statuses[n]!.push(...(await Promise.all(Array.from({ length: 100 }, () => keep(shown)))))
    const all = statuses.flat()
    // 2,600 from each, which is 31,200: the first 30,000 are answered and the rest are not
    expect(statuses.every((of) => of.length === 2600)).toBe(true)
    expect([all.filter((n) => n === 204).length, all.filter((n) => n === 429).length]).toEqual([30_000, 1200])
    expect(await keep(crowd[0]!)).toBe(429)
    expect(wrote((e) => e.event === 'rate_limited' && e.key === 'crowded')).toMatchObject({ limiter: 'READS_PERSON' })
    // And nobody else is slowed by it
    expect(await keep(someoneElse)).toBe(204)
  }, 60_000)

  test('what is asked without a showing’s token is counted against no showing, however much of it there is', async () => {
    const mine = await open({ u: 'patient' })
    // What another page in the same browser, or anyone who can reach the port, can send: far
    // more than a showing is allowed in a minute, at addresses that are not this showing's
    const guess = `/s/${randomBytes(32).toString('base64url')}`
    const forged = await ticket(newMount(), {}, { key: stranger.privateKey })
    for (let sent = 0; sent < 3400; sent += 200) {
      const batch = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          show([`${guess}/__it/keep`, `${guess}/v/1/index.html`, '/open/nonsense', `/open/${forged}`][i % 4]!, {
            headers: { cookie: 'it_view=anything', referer: `http://localhost:${PAGES}${mine.at}/v/1/index.html` },
          }),
        ),
      )
      if (batch.some((r) => r.status !== 401)) throw new Error('something was answered that should not have been')
    }
    // The showing's own page is still answered, and a new one still opens from the same address
    expect((await show(`${mine.at}/v/1/asset.js`)).status).toBe(200)
    expect((await show(`${mine.at}/__it/keep`)).status).toBe(204)
    expect((await redeem(ticket(newMount()))).status).toBe(303)
  })

  test('uploads are counted by the version they are for, and a version that sends too many is slowed down by itself', async () => {
    const prefix = `u/uploader/busy/1/`
    await stage(prefix, [entry('index.html', 'hello')])
    const grant = await grantFor(prefix)
    const statuses: number[] = []
    // Each is counted before it is looked at, so one that will be refused for what it holds counts like any other
    for (let sent = 0; sent < 1600; sent += 100)
      statuses.push(...(await Promise.all(Array.from({ length: 100 }, () => upload('not-declared.js', 'x', { prefix, grant })))).map((r) => r.status))
    expect([statuses.filter((n) => n === 403).length, statuses.filter((n) => n === 429).length]).toEqual([1500, 100])
    expect((await upload('index.html', 'hello', { prefix, grant })).status).toBe(429)
    // Another version of the same person's is not held up
    const other = `u/uploader/calm/1/`
    await stage(other, [entry('index.html', 'hello')])
    expect((await upload('index.html', 'hello', { prefix: other })).status).toBe(200)
  })
})

describe('the backend’s keys', () => {
  test('when they cannot be fetched, a caller is told to try again, not that its token is bad, and what is written is the kind of trouble and none of its words', async () => {
    // Nothing listens at this address
    const away = 'http://127.0.0.1:9'
    const other = make({ backendSite: away }).content
    try {
      const m = newMount()
      const good = await sign('it-content', m, { m, a: 'page1', s: 'plan', v: '1', u: USER, d: 'display1', e: 0, p: PREFIX }, { issuer: away })
      expect((await redeem(good, { on: other })).status).toBe(503)
      const grant = await sign('it-upload', PREFIX, { p: PREFIX }, { issuer: away, seconds: 900 })
      expect((await upload('index.html', INDEX, { grant, on: other })).status).toBe(503)
      // What is plainly not a token is still refused outright
      expect((await redeem('nonsense', { on: other })).status).toBe(401)
      const line = wrote((e) => e.event === 'unavailable' && e.part === 'a showing')
      expect(line).toMatchObject({ method: 'GET', reason: 'backend_keys' })
      expect(Object.keys(line!).sort()).toEqual(['event', 'kind', 'level', 'method', 'part', 'reason'])
      expect(JSON.stringify(written().filter((e) => e.event === 'unavailable'))).not.toMatch(/127\.0\.0\.1|fetch failed|ECONNREFUSED: /)
    } finally {
      await other.close()
    }
  })

  test('a trailing slash on the backend’s address changes nothing', async () => {
    const other = make({ backendSite: `${ISSUER}/` }).content
    try {
      expect((await redeem(ticket(newMount()), { on: other })).status).toBe(303)
    } finally {
      await other.close()
    }
  })
})

describe('settings', () => {
  test('a service is not made without the site’s port', () => {
    const settings = { dir: path.join(root, 'never'), data: path.join(root, 'never-data'), basePort: BASE, backendSite: ISSUER, say: () => {} }
    expect(() => createContent({ ...settings, basePort: Number.NaN })).toThrow()
    expect(() => createContent({ ...settings, basePort: 0 })).toThrow()
    expect(existsSync(settings.dir)).toBe(false)
  })
})

describe('what is written down', () => {
  ownService()

  test('a showing that opens, a ticket tried twice, a forged one, and what the backend asked are each a line, with ids and no credential', async () => {
    const m = newMount()
    const t = await ticket(m, { a: 'page-for-the-log', d: 'display-for-the-log' })
    const first = await redeem(t)
    expect(first.status).toBe(303)
    const opened = wrote((e) => e.event === 'showing.opened' && e.mount === m)
    expect(opened).toMatchObject({ u: USER, d: 'display-for-the-log', page: 'page-for-the-log', version: '1' })
    expect(Object.keys(opened!).sort()).toEqual(['d', 'event', 'mount', 'page', 'u', 'version'])
    expect((await redeem(t)).status).toBe(401)
    expect(wrote((e) => e.event === 'ticket.refused' && e.mount === m)).toMatchObject({ reason: 'already_used', u: USER })
    const forged = await ticket(newMount(), {}, { key: stranger.privateKey })
    expect((await redeem(forged)).status).toBe(401)
    // A refusal a stranger can cause as often as they like is said by its reason, once in a while
    expect(Object.keys(wrote((e) => e.event === 'ticket.refused' && e.reason === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED')!).sort()).toEqual([
      'event',
      'level',
      'reason',
    ])

    // A showing that is asked under after its display was signed out
    const token = sentTo(first).split('/')[2]!
    expect((await control('revoke', { userId: USER, displayId: 'display-for-the-log', epoch: 1 })).status).toBe(200)
    expect((await show(`/s/${token}/__it/keep`)).status).toBe(401)
    expect(wrote((e) => e.event === 'showing.refused' && e.reason === 'signed_out')).toMatchObject({ u: USER, d: 'display-for-the-log' })
    // A token nobody here made is not a line at all: anyone can send one
    const before = written().length
    expect((await show(`/s/${randomBytes(32).toString('base64url')}/__it/keep`)).status).toBe(401)
    expect(written().length).toBe(before)

    // What the backend asks, and what is refused because it did not come from the backend
    expect((await control('revoke', { userId: 'user-for-the-log', displayId: 'd1', epoch: 3 })).status).toBe(200)
    expect(wrote((e) => e.event === 'control.revoke' && e.u === 'user-for-the-log')).toMatchObject({ d: 'd1', epoch: 3 })
    const body = { userId: 'user-for-the-log', displayId: 'd1', epoch: 9 }
    const signedForAnother = await sign('it-control', 'revoke', { h: sha256(JSON.stringify({ ...body, epoch: 4 })) })
    expect((await control('revoke', body, signedForAnother)).status).toBe(401)
    expect(wrote((e) => e.event === 'control.refused' && e.reason === 'body_not_the_one_signed')).toMatchObject({ op: 'revoke' })
    expect((await control('revoke', body, undefined, { address: '192.168.1.77' })).status).toBe(404)
    expect(wrote((e) => e.event === 'control.refused' && e.reason === 'not_this_machine')).toMatchObject({ op: 'revoke' })

    // An upload that is refused says where it was going and why, and not which file
    const prefix = `u/${USER}/page-for-the-log/1/`
    await stage(prefix, [entry('a private name.txt', 'declared')])
    expect((await upload('another%20private%20name.txt', 'x', { prefix })).status).toBe(403)
    expect(wrote((e) => e.event === 'upload.refused' && e.prefix === prefix)).toMatchObject({ reason: 'not_declared' })
    expect((await upload('a%20private%20name.txt', 'declare!', { prefix, sha: sha256('declared') })).status).toBe(400)
    expect(wrote((e) => e.event === 'upload.refused' && e.prefix === prefix && e.reason === 'bytes_differ')).toBeTruthy()
    expect((await control('verify', { prefix, files: [entry('a private name.txt', 'declared')] })).json().ok).toBe(false)
    expect(wrote((e) => e.event === 'control.verify' && e.prefix === prefix)).toMatchObject({ ok: false, missing: 1, notDeclared: 0 })

    const all = lines.join('\n')
    expect(written().length).toBeGreaterThan(8)
    // Neither the ticket nor the token it was traded for, which is as good as the page itself
    for (const secret of [t, t.split('.')[2]!, token, forged, signedForAnother, 'private name', 'eyJ', '192.168.1.77', '127.0.0.1'])
      expect(all.includes(secret), `a line holds ${secret.slice(0, 12)}`).toBe(false)
  })

  test('every line goes to whoever made the service, as one JSON object, and none to the program’s own output', async () => {
    const said: string[] = []
    const own = make({ say: (line) => void said.push(line) }).content
    try {
      expect((await redeem(ticket(newMount()), { on: own })).status).toBe(303)
      expect((await redeem('not.a.ticket', { on: own })).status).toBe(401)
      expect((await control('revoke', { userId: 'u', displayId: 'd', epoch: 1 }, 'nonsense', { on: own })).status).toBe(401)
      const events = said.map((line) => JSON.parse(line) as Record<string, unknown>)
      // What happened is a line; what was refused says that someone may ask about it; what needs a person to look says so
      expect(events.map((e) => [e.event, e.level])).toEqual([
        ['showing.opened', undefined],
        ['ticket.refused', 'warn'],
        ['control.refused', 'error'],
      ])
      for (const line of said) expect(line).toMatch(/^\{"event":"[a-z_.]+"[^\n]*\}$/)
    } finally {
      await own.close()
    }
    expect(printed).toEqual([])
    // A line that cannot be taken costs whoever asked nothing
    const deaf = make({
      say: () => {
        throw new Error('the log is full')
      },
    }).content
    try {
      expect((await redeem(ticket(newMount()), { on: deaf })).status).toBe(303)
      expect((await redeem('not.a.ticket', { on: deaf })).status).toBe(401)
    } finally {
      await deaf.close()
    }
  })

  test('what anyone can send as often as they like is said once in a while, not each time', async () => {
    const count = (event: string, reason: string) => written().filter((e) => e.event === event && e.reason === reason).length
    const before = {
      control: count('control.refused', 'none_sent'),
      upload: count('upload.refused', 'grant:none_sent'),
      away: count('control.refused', 'not_this_machine'),
      ticket: count('ticket.refused', 'ERR_JWS_INVALID'),
    }
    // No signature and no grant: nothing is checked, and nothing limits how often this is asked
    const many = (one: () => Promise<Reply>) => Promise.all(Array.from({ length: 200 }, one))
    const refused = await many(() => door('/control/revoke', { method: 'POST', body: '{}' }))
    const uploads = await many(() => door('/upload/x.txt', { method: 'PUT', body: 'x' }))
    const away = await many(() => door('/control/revoke', { method: 'POST', body: '{}', address: `192.168.7.${Math.floor(Math.random() * 250)}` }))
    const tickets = await many(() => redeem('not.a.ticket', { address: `192.168.8.${Math.floor(Math.random() * 250)}` }))
    expect([...new Set([...refused, ...uploads, ...tickets].map((r) => r.status))]).toEqual([401])
    expect([...new Set(away.map((r) => r.status))]).toEqual([404])
    expect(wrote((e) => e.event === 'control.refused' && e.reason === 'none_sent')).toMatchObject({ op: 'revoke' })
    // One line when it began, and at most one more if the ten seconds ran out part of the way through
    expect(count('control.refused', 'none_sent') - before.control).toBeLessThanOrEqual(2)
    expect(count('upload.refused', 'grant:none_sent') - before.upload).toBeLessThanOrEqual(2)
    expect(count('control.refused', 'not_this_machine') - before.away).toBeLessThanOrEqual(2)
    expect(count('upload.refused', 'grant:none_sent')).toBeGreaterThan(0)
    expect(count('ticket.refused', 'ERR_JWS_INVALID') - before.ticket).toBeGreaterThan(0)
    expect(count('ticket.refused', 'ERR_JWS_INVALID') - before.ticket).toBeLessThanOrEqual(2)
  })

  test('a page that is slowed down is said once, not once for every request', async () => {
    const { at } = await open({ u: 'user-slowed-for-the-log' })
    let slowed = 0
    for (let i = 0; i < 40 && slowed < 300; i++) {
      const batch = await Promise.all(Array.from({ length: 100 }, () => show(`${at}/__it/keep`)))
      slowed += batch.filter((r) => r.status === 429).length
    }
    expect(slowed).toBeGreaterThanOrEqual(300)
    const said = written().filter((e) => e.event === 'rate_limited' && String(e.key).includes('user-slowed-for-the-log'))
    expect(said[0]).toMatchObject({ limiter: 'READS' })
    // Hundreds of refusals are a line or two: one for each ten seconds it went on
    expect(said.length).toBeLessThanOrEqual(2)
  })

  test('a service that has been closed answers that it cannot, and what is written is the kind of trouble and none of its words', async () => {
    const closed = make().content
    await closed.close()
    const before = written().length
    const r = await redeem(ticket(newMount()), { on: closed })
    expect([r.status, r.buf.length]).toEqual([500, 0])
    const line = written()
      .slice(before)
      .find((e) => e.event === 'unexpected')
    expect(line).toMatchObject({ part: 'a showing', method: 'GET' })
    expect(Object.keys(line!).sort()).toEqual(['event', 'kind', 'level', 'method', 'part'])
    expect([line!.level, String(line!.kind)]).toEqual(['error', 'RECORDS_CLOSED'])
  })
})

describe('behind a real server', () => {
  // The service as the door runs it: a server on the site's port and one on the pages', each
  // handing a request on with the port it came in on and the address it came from. The ports
  // are the system's to choose. The pages' port must be the one after the site's, so the site's
  // is taken to be the one before whichever the system gave the pages.
  let pages: http.Server
  let site: http.Server
  let behind: Content
  let S = 0
  let D = 0

  /** Hands a request on to the service and its answer back, a piece at a time both ways. */
  const serve = (handle: (request: Request, asked: Asked) => Promise<Response>) =>
    new Promise<http.Server>((resolve) => {
      const server = http.createServer(async (req, res) => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        const sends = req.method !== 'GET' && req.method !== 'HEAD'
        const asked = new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method,
          headers,
          ...(sends ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
        } as RequestInit)
        const response = await handle(asked, { port: req.socket.localPort!, address: req.socket.remoteAddress! })
        res.writeHead(response.status, [...response.headers].flat())
        // A reader that goes away part of the way through ends the reading of the file as well
        if (response.body) pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res, () => {})
        else res.end()
      })
      server.listen(0, '127.0.0.1', () => resolve(server))
    })

  beforeAll(async () => {
    pages = await serve((request, asked) => behind.showing(request, asked))
    S = (pages.address() as net.AddressInfo).port
    behind = make({ basePort: S - 1 }).content
    site = await serve((request, asked) => (new URL(request.url).pathname.startsWith('/control/') ? behind.control : behind.upload)(request, asked))
    D = (site.address() as net.AddressInfo).port
  })
  afterAll(async () => {
    pages?.close()
    site?.close()
    await behind?.close()
  })

  test('a page is declared, uploaded, opened with a ticket and read, range and all, over HTTP', async () => {
    const prefix = `u/${USER}/served/1/`
    const film = randomBytes(200_000)
    const files = [entry('index.html', INDEX), entry('film.mp4', film)]
    const body = JSON.stringify({ prefix, files })
    const staged = await fetch(`http://127.0.0.1:${D}/control/stage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await sign('it-control', 'stage', { h: sha256(body) })}` },
      body,
    })
    expect(staged.status).toBe(200)
    const grant = await grantFor(prefix)
    for (const [name, data] of [
      ['index.html', Buffer.from(INDEX)],
      ['film.mp4', film],
    ] as const) {
      const put = await fetch(`http://127.0.0.1:${D}/upload/${name}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${grant}`, 'x-it-sha256': sha256(data) },
        body: data,
      })
      expect([name, put.status]).toEqual([name, 200])
    }
    // An upload that does not say how long it is, as one sent a piece at a time does not
    const unsized = await new Promise<number>((resolve, reject) => {
      const sending = http.request(
        { host: '127.0.0.1', port: D, path: '/upload/index.html', method: 'PUT', headers: { authorization: `Bearer ${grant}`, 'x-it-sha256': sha256(INDEX) } },
        (res) => res.resume().on('end', () => resolve(res.statusCode!)),
      )
      sending.on('error', reject)
      sending.write(INDEX.slice(0, 20))
      sending.end(INDEX.slice(20))
    })
    expect(unsized).toBe(400)

    const t = await sign('it-content', 'a'.repeat(32), { m: 'a'.repeat(32), a: 'served', s: 'served', v: '1', u: USER, d: 'display1', e: 0, p: prefix })
    const here = `http://127.0.0.1:${S}`
    const policy = `${SANDBOX}; frame-ancestors http://127.0.0.1:${S - 1}`
    const traded = await fetch(`${here}/open/${t}`, { redirect: 'manual' })
    expect([traded.status, traded.headers.getSetCookie()]).toEqual([303, []])
    expectConfined('the ticket taken', traded, policy)
    const first = traded.headers.get('location')!
    expect(first).toMatch(/^\/s\/[A-Za-z0-9_-]{43}\/v\/1\/index\.html$/)
    const at = `${here}${first.split('/v/')[0]}`

    // As a frame opens it, and as a browser follows the answer to a ticket
    const page = await fetch(`${here}${first}`, { headers: DOCUMENT })
    expectConfined('the page', page, policy)
    expect(await page.text()).toContain(
      `window.__IT__={"app":"http://127.0.0.1:${S - 1}","id":"served","version":1,"keep":"${first.split('/v/')[0]}/__it/keep"}`,
    )
    const whole = await fetch(`${at}/v/1/film.mp4`)
    expect([whole.status, whole.headers.get('content-type'), whole.headers.get('content-length')]).toEqual([200, 'video/mp4', '200000'])
    expectConfined('the film', whole, policy)
    expect(Buffer.from(await whole.arrayBuffer()).equals(film)).toBe(true)
    const part = await fetch(`${at}/v/1/film.mp4`, { headers: { range: 'bytes=100000-100999' } })
    expect([part.status, part.headers.get('content-range'), part.headers.get('content-length')]).toEqual([206, 'bytes 100000-100999/200000', '1000'])
    expect(Buffer.from(await part.arrayBuffer()).equals(film.subarray(100_000, 101_000))).toBe(true)
    const head = await fetch(`${at}/v/1/film.mp4`, { method: 'HEAD' })
    expect([head.status, head.headers.get('content-length'), (await head.arrayBuffer()).byteLength]).toEqual([200, '200000', 0])
    // The same address without the token, or with another, shows nothing
    const copied = await fetch(`${here}/v/1/index.html`, { headers: DOCUMENT })
    expect([copied.status, (await copied.arrayBuffer()).byteLength]).toEqual([404, 0])
    const guessed = await fetch(`${here}/s/${randomBytes(32).toString('base64url')}/v/1/index.html`, { headers: DOCUMENT })
    expect([guessed.status, (await guessed.arrayBuffer()).byteLength]).toEqual([401, 0])
    expectConfined('a guess', guessed, policy)
    // A reader that stops part of the way through a file leaves the service able to serve it again
    const dropped = await fetch(`${at}/v/1/film.mp4`)
    await dropped.body!.cancel()
    expect((await fetch(`${at}/v/1/film.mp4`, { headers: { range: 'bytes=0-0' } })).status).toBe(206)
  })
})
