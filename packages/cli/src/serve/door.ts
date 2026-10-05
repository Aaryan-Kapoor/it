// The door: the one thing a browser, another screen or the command reaches. It listens on the
// base port and on the port after it, which pages are shown from, and everything else
// the service runs is behind it and listens on this machine only.
//
// On the base port it serves the site, passes the browser's live connection and the pairing
// routes on to the backend, takes uploads and the backend's own messages for the content
// package, and sends notifications for the backend. On the pages' port every request is the
// content package's. Before any of that it looks at the name a request was sent to: one that is
// not this machine's own is refused, which is what keeps a page on some other site from
// reaching the door by a name that it points at this machine.
//
// A machine that joined from another computer reaches the backend through the door as well:
// the three addresses a function is called at are passed on beside the live connection, and
// nothing else of the backend's own is.
//
// What the door answers is written once, as a function from a request to an answer. How it
// listens is written twice, because the two runtimes this program runs under differ in exactly
// that: under Node it is node:http, and a WebSocket is passed on as the bytes it is; inside the
// standalone program it is Bun's own server, which hands over messages and not bytes, so each
// message is passed on to a connection of the door's own to the backend.
//
// The pages' port is listened on with node:http under both. Bun's own server answers a request
// it cannot read before any of the door's code has run, and an answer from that port that the
// door did not make would not say that it is a sandboxed document. With node:http the door is
// told of such a request under either runtime, and decides what becomes of it.
import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import type { Duplex } from 'node:stream'
import { createContent, pagePolicy } from '@it/content'
import { contentPort, LIMITS, onThisMachine } from '@it/protocol'
import { direct, inHome, Problem } from '../lib'
import type { Backend } from './backend'
import { doorKey, type ServiceConfig } from './config'
import { createPush, type Push } from './push'
import { answerSite, BUILT, hostOf, type Site, spelled } from './site'
import { inTailnet, isLoopback, tailnetName } from './tailnet'

/** The content package: it shows pages on their port, takes uploads, and does what the backend asks of it. */
export type Content = ReturnType<typeof createContent>

/** What the door is made of besides its own code. A test gives a stand-in for any of them; what is not given is the real one. */
export interface DoorParts {
  /**
   * The content package the door hands requests to. One that is given is used as it is and is
   * left open when the door closes: it is for whoever made it to close. A door that is given
   * none makes its own (`makeContent`), and closes its own.
   */
  content?: Content
  site?: Site
  push?: Push
  /**
   * Told when everything of one person's has been deleted from the content package's folder,
   * with that person's id, so that the service can remove what else it keeps of theirs. The
   * backend is told the deletion is done only once this has ended well, and asks again until
   * it has, so it may be told of the same person more than once.
   */
  erased?: (person: string) => void | Promise<void>
  /** How long a request's body is waited for, in milliseconds. */
  patience?: number
  /** What time it is, in milliseconds. */
  now?: () => number
}

/** A request as either way of listening hands it over. */
export interface Arrival {
  method: string
  /** What was asked for, as it was sent: a path and query, or an address written out in full. */
  target: string
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  port: number
  /** The caller's own address, from the connection and never from a header. */
  address: string
}
/**
 * Whether a WebSocket may be passed on to the backend: at which path and with which key, or the
 * status it is refused with and whatever headers go with that.
 */
export type Live = { refuse: number; says?: Record<string, string> } | { path: string; key: string }
/** Why the door turned something away where it listens, and not where it answers: one of its own fixed words. */
export type Turned = 'backend_no_websocket' | 'backend_slow' | 'accept_failed' | 'headers_too_large'
export interface Door {
  /** Answers any request that is not a WebSocket. It never throws. */
  answer(arrival: Arrival): Promise<Response>
  /** `early` is how many bytes had already arrived after the request's headers, where the way of listening can tell. */
  live(arrival: Arrival, early?: number): Live
  /**
   * What an answer carries when it is made where the door listens and not where it answers,
   * by the port it leaves from: on the pages' port, that it is a sandboxed document which
   * nothing may frame, and on the site's port nothing.
   */
  carried(port: number): Record<string, string>
  /**
   * Whether a caller that waits to be told to go on before it sends its body is told so, on
   * the port it asked at. On the site's port it is. On the pages' port it is not: being told
   * to go on is an answer of a kind, and it would be the one thing to leave that port without
   * saying that what the port sends is a sandboxed document. Nothing asked of that port has a
   * body that is read, so the request is answered there as it stands.
   */
  goesOn(port: number): boolean
  /** Writes down that something was turned away where the door listens. */
  turned(why: Turned): void
  /** Closes the content package, where the door made it for itself. */
  close(): Promise<void>
}

// The door listens without TLS, so this is how every request arrives. It is what the backend
// is told in x-forwarded-proto, whatever the caller put in that header.
const SCHEME = 'http'
/** The live connection, at the address the client library asks for it. */
const LIVE = /^\/api\/[A-Za-z0-9][A-Za-z0-9._+-]{0,31}\/sync$/
/**
 * The backend's three addresses for calling one of its functions, which is how a machine that
 * joined from another computer runs them: the machine It runs on asks the backend itself. They
 * and the live connection are all that is passed on under /api/.
 */
const CALLS = new Set(['/api/query', '/api/mutation', '/api/action'])
/** The backend's routes for a browser's session and for machines. Each part of the path is a plain word, so the path means only what it says. */
const WORDS = /^\/(?:session|bridge)(?:\/[A-Za-z0-9._~-]+)+$/
const TO_BACKEND = new Set(['/display/signout', '/.well-known/jwks.json', '/cli/config', '/health'])
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
// Headers that are about the one connection a request or an answer came on, and about a proxy
// on it. They are never passed on, in either direction, and neither is any header that a
// Connection header names as being of that kind.
const ONE_CONNECTION = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authentication-info',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]
// What else of a request goes no further: the name it was sent to, how long its body is and
// whether the caller waits to be told to send it, which the door has settled by reading it, and
// the headers by which a proxy says who asked and how. The door says those itself, so a
// caller's are dropped.
const NOT_PASSED = [...ONE_CONNECTION, 'host', 'content-length', 'expect', 'accept-encoding', 'forwarded', 'via', 'x-real-ip']
// And of an answer: how long it is, which the door says itself of the bytes it sends
const NOT_RETURNED = [...ONE_CONNECTION, 'content-length']
/** What a header's name is made of. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i
/** The most a request may send where only a few words are expected: a code, a key, a ticket. */
const SMALL = 64 * 1024
/** The most the backend sends the content package in one message. */
const CONTROL_MOST = 1024 * 1024
/** The most one call of a function may carry. The largest a machine makes is a page's state beside the names of its files, and is well under this. */
const CALL_MOST = 4 * 1024 * 1024
const PATIENCE_MS = 30_000
/**
 * How much of a request that was answered before it had all arrived is still taken off the
 * connection, and for how long. It is thrown away as it comes and costs no memory. A caller
 * that sends its whole body before it reads anything can read its answer only if the rest was
 * taken, so this is more than the largest body the door ever accepts.
 */
const UNREAD_MOST = 32 * 1024 * 1024
const UNREAD_MS = 2000
/** How long nothing more of such a request may arrive before it is taken to have stopped arriving. */
const UNREAD_QUIET_MS = 250
/** The same time as Bun's own server counts it, in whole seconds. It looks at its connections every four, so one it is told to close closes within that. */
const UNREAD_S = Math.ceil(UNREAD_MS / 1000)
const BACKEND_MS = 30_000
/** An action may check every file of a page, and is waited for longer than the command that asked waits. */
const ACTION_MS = 120_000
/** The most one message of the live connection may be, in either direction. */
const LIVE_MOST = 64 * 1024 * 1024
/** How long the backend is given to agree to a live connection, and the most its agreement may come to. */
const LIVE_OPEN_MS = 10_000
const LIVE_HEAD_MOST = 8 * 1024
/** The version of WebSocket there is, and the key a caller gives with its first request: sixteen bytes in base64. */
const LIVE_VERSION = '13'
const LIVE_KEY = /^[A-Za-z0-9+/]{22}==$/
/** What a message's own framing comes to on its way to the backend, at most. */
const LIVE_FRAME = 14
/** What a browser's WebSocket is closed with when the backend is not taking what it sends: a word to come back later. */
const LIVE_LATER = 1013
/**
 * The most a request's headers may come to. The site's own requests carry what a browser sends
 * of itself and one cookie, the session's, and a program's carry its token: a small part of
 * this. A browser keeps cookies by host name and not by port, so it also sends the door
 * whatever other programs on this machine have set, and this leaves room for a good many of
 * those. It is what either runtime allows when it is told nothing, and is said to both so that
 * they go by one number. A request with more is answered that it has too much.
 */
const HEADERS_MOST = 16 * 1024
/** How long nothing may move on a connection inside the standalone program before it is closed, in seconds. It is longer than any answer takes to begin. */
const IDLE_S = 60
/** A refusal is said once every ten minutes for each kind, with how many more there were in between. */
const QUIET_MS = 600_000
/** Where a code is traded, for a browser's session and for a machine's place, and where a browser asks what one is for. */
const CODES = new Set(['/session/redeem', '/session/code', '/bridge/enroll'])
/** How many codes one address may have refused in a minute before it is asked to wait out the rest of it, and how many addresses are counted at once. */
const WRONG_MOST = 10
const WRONG_MS = 60_000
const WRONG_KEPT = 10_000

/** An answer of the door's own: a few words of JSON that no browser keeps. */
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  })

/** An address as the system gives it, with an IPv4 address written as one even when it came over IPv6. */
const addressOf = (given: string | undefined | null): string => (given ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '')

/**
 * An address written out in full, taken apart: the name and the port as a Host header's are, and
 * whatever follows them. Only an address that is reached as the door is, without TLS, is one at
 * all here. Two addresses are the same place when their names and ports are the same, however
 * each was spelled.
 */
function placeOf(address: string): { name: string; port: number; rest: string } | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is.exec(address)
  const host = m && m[1]!.toLowerCase() === SCHEME ? hostOf(m[2]!) : null
  return host ? { ...host, rest: m![3]! } : null
}

/**
 * The names this machine answers to. Its own three always. When the network is on, every
 * address it has on its networks, its host name, and that name as a home network looks it up.
 * A machine's addresses change as it moves between networks, so they are read again when the
 * last reading is a few seconds old. Kept to the tailnet, the names are the machine's addresses
 * there, its host name, and its name on the tailnet.
 */
function knownNames(network: boolean, tailnet = false): (name: string) => boolean {
  const own = new Set(['localhost', '127.0.0.1', '[::1]'])
  let others = new Set<string>()
  let readAt = 0
  return (name) => {
    if (own.has(name)) return true
    if (!network) return false
    if (Date.now() - readAt > 5000) {
      readAt = Date.now()
      others = new Set()
      for (const addresses of Object.values(os.networkInterfaces()))
        for (const a of addresses ?? []) {
          // Kept to the tailnet, the machine answers to its addresses there and to no other it has
          if (tailnet && !inTailnet(a.address)) continue
          others.add(a.family === 'IPv6' ? spelled(`[${a.address.split('%')[0]}]`) : a.address)
        }
      const host = os.hostname().toLowerCase()
      if (host) others.add(host)
      if (host && !host.includes('.') && !tailnet) others.add(`${host}.local`)
      // And to the name it has on the tailnet, where Tailscale says what that is
      const there = tailnet ? tailnetName() : undefined
      if (there) others.add(there)
    }
    return others.has(name)
  }
}

/** The names in a header that is a list of them, such as Connection: each in lower case, and nothing that is not a name. */
const namesIn = (list: string | null): string[] =>
  (list ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => HEADER_NAME.test(name))

/** A request's or an answer's headers as they go on: without the ones given, and without any that its own Connection header names. */
function passedOn(from: Headers, without: string[]): Headers {
  const headers = new Headers(from)
  for (const name of [...namesIn(from.get('connection')), ...without]) headers.delete(name)
  return headers
}

/** How many bytes a request says its body is, when it says. */
function declared(headers: Headers): number | null {
  const said = headers.get('content-length')
  return said !== null && /^\d{1,15}$/.test(said) ? Number(said) : null
}

/** Whether a request says that it carries a body: a length that is not nothing, or that it comes in pieces. */
const carries = (headers: Headers): boolean => headers.has('transfer-encoding') || !['0', null].includes(headers.get('content-length'))

/** A body as it arrives, cut off once it is longer than it may be or has taken longer than it may. Whoever reads it is told by an error. */
function held(body: ReadableStream<Uint8Array>, most: number, ms: number): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let size = 0
  let late = false
  const timer = setTimeout(() => {
    late = true
    void reader.cancel().catch(() => {})
  }, ms)
  timer.unref?.()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (late) throw new Error('the body took too long to arrive')
        if (done) {
          clearTimeout(timer)
          controller.close()
          return
        }
        size += value.byteLength
        if (size > most) throw new Error('the body is longer than it may be')
        controller.enqueue(value)
      } catch (err) {
        clearTimeout(timer)
        void reader.cancel().catch(() => {})
        controller.error(err)
      }
    },
    cancel(reason) {
      clearTimeout(timer)
      return reader.cancel(reason)
    },
  })
}

/** Says a thing about the door seldom: once, and then not again for ten minutes, however often it happens. */
function seldomSaid(say: (line: string) => void): (code: string) => void {
  const last = new Map<string, { at: number; held: number }>()
  return (code) => {
    const before = last.get(code)
    if (before && Date.now() - before.at < QUIET_MS) {
      before.held += 1
      return
    }
    last.set(code, { at: Date.now(), held: 0 })
    say(`door refused a request (${code})${before?.held ? `; ${before.held} more like it since this was last said` : ''}`)
  }
}

/**
 * The content package as the door makes one for itself: its folders under the service's own,
 * the port pages are shown from counted from the service's, the backend on this machine asked
 * for its keys on a connection no proxy is part of, and what it writes down said where the door
 * says its own lines. `erased` is told as `DoorParts.erased` says.
 *
 * A showing is remembered in the package's memory and nowhere else. So whoever runs the service
 * makes the package once and gives it to every door it opens, and a page that is open stays
 * shown when the door is closed and opened anew, as it is when the network is turned on or off.
 * Whether the network is on is nothing to the package: only the port is read of the settings.
 */
export function makeContent(config: ServiceConfig, backend: Backend, say: (line: string) => void, erased?: DoorParts['erased']): Content {
  return createContent({
    dir: inHome('content'),
    data: inHome('content-data'),
    basePort: config.port,
    backendSite: backend.site.replace(/\/$/, ''),
    fetch: direct,
    say,
    erased,
  })
}

/** What the door answers, however it is listened for. */
export function makeDoor(config: ServiceConfig, backend: Backend, say: (line: string) => void, parts: DoorParts = {}): Door {
  const site = backend.site.replace(/\/$/, '')
  const itself = doorKey(config)
  const api = backend.api.replace(/\/$/, '')
  const patience = parts.patience ?? PATIENCE_MS
  // Every code said here is one of this file's or of push.ts's own words
  const noted = seldomSaid(say)
  const content = parts.content ?? makeContent(config, backend, say, parts.erased)
  const push = parts.push ?? createPush({ backendSite: site, refused: noted })
  const files = parts.site ?? BUILT
  const known = knownNames(config.network, config.tailnet === true)
  // Kept to the tailnet, a caller is answered only from an address of the tailnet, or from this
  // machine itself: a device on another network this machine is on gets nothing, whatever name it asks for
  const answered = (address: string) => !config.tailnet || isLoopback(address) || inTailnet(address)
  const now = parts.now ?? Date.now

  // Codes that were refused, counted for each address that sent them by itself. An address that
  // has had ten refused in a minute is answered here for the rest of that minute, and the
  // backend is not asked: whoever tries codes is slowed down, and nobody else is, wherever they
  // ask from. Only so many addresses are counted at once, the ones counted longest going first.
  //
  // A code that has been sent on and not yet answered may still be refused, so it is counted
  // as if it had been until its answer is known. However many an address sends together, no
  // more of them reach the backend than it has left of its ten.
  const wrong = new Map<string, { count: number; since: number }>()
  const unanswered = new Map<string, number>()
  const counted = (address: string) => {
    const kept = wrong.get(address)
    if (kept && now() - kept.since >= WRONG_MS) wrong.delete(address)
    return wrong.get(address)
  }
  const refusedCode = (address: string) => {
    const kept = counted(address)
    if (kept) kept.count += 1
    else {
      if (wrong.size >= WRONG_KEPT) wrong.delete(wrong.keys().next().value!)
      wrong.set(address, { count: 1, since: now() })
    }
  }

  /** A refusal: a status and one fixed word for why. Nothing of what was asked is repeated, here or in the log. */
  const refuse = (status: number, code: string, headers: Record<string, string> = {}) => {
    noted(code)
    return json(status, { error: code }, headers)
  }
  /** Whether a request was sent to a name this machine answers to, on the port it arrived at, from somewhere it answers. */
  const named = (a: Arrival): boolean => {
    const host = hostOf(a.headers.get('host'))
    return host !== null && host.port === a.port && known(host.name) && answered(a.address)
  }
  /**
   * Where a request asks for, as an address. One that was sent written out in full is taken
   * when it names the very place the request was sent to, and refused when it names another.
   */
  const addressed = (a: Arrival): URL | null => {
    const host = hostOf(a.headers.get('host'))
    if (!host) return null
    let asked = a.target
    if (!asked.startsWith('/')) {
      const full = placeOf(asked)
      if (!full || full.name !== host.name || full.port !== host.port) return null
      asked = full.rest
    }
    if (!asked.startsWith('/')) return null
    try {
      return new URL(`${SCHEME}://${a.headers.get('host')}${asked}`)
    } catch {
      return null
    }
  }
  /** Whether a request comes from the door's own pages: its Origin is the place the request itself names, and nothing more than a place. */
  const fromHere = (a: Arrival): boolean => {
    const host = hostOf(a.headers.get('host'))
    const origin = placeOf(a.headers.get('origin') ?? '')
    return host !== null && origin !== null && origin.rest === '' && origin.name === host.name && origin.port === host.port
  }
  /**
   * Whether a request comes from a page of some other site. A browser names the page's origin
   * on every WebSocket it opens and on every request that is not a plain read, and a page
   * cannot leave it out. A request that names none was made by a program, which could have
   * named any it liked: nothing is kept from a program by asking it for one.
   */
  const fromElsewhere = (a: Arrival): boolean => a.headers.get('origin') !== null && !fromHere(a)

  /** A small body, read whole. One that is longer than it may be, or that does not arrive in time, is given up on. */
  async function whole(a: Arrival, most: number): Promise<Uint8Array<ArrayBuffer> | 'too_large' | 'too_slow'> {
    const length = declared(a.headers)
    if (length !== null && length > most) return 'too_large'
    if (!a.body) return new Uint8Array(0)
    const reader = a.body.getReader()
    const pieces: Uint8Array[] = []
    let size = 0
    let late = false
    const timer = setTimeout(() => {
      late = true
      void reader.cancel().catch(() => {})
    }, patience)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (late) return 'too_slow'
        if (done) break
        size += value.byteLength
        if (size > most) {
          void reader.cancel().catch(() => {})
          return 'too_large'
        }
        pieces.push(value)
      }
    } catch {
      // Whoever was sending it went away
      return 'too_slow'
    } finally {
      clearTimeout(timer)
    }
    const all = new Uint8Array(size)
    let at = 0
    for (const piece of pieces) {
      all.set(piece, at)
      at += piece.byteLength
    }
    return all
  }
  const unread = (why: 'too_large' | 'too_slow') => refuse(why === 'too_large' ? 413 : 408, why)

  /**
   * A request for the backend's HTTP port, sent on as it came and answered as the backend
   * answers. It is sent on a connection of the door's own to the backend, which no proxy named
   * in the environment is ever part of: what goes with it is the door's key and whatever the
   * caller proved itself by, and neither is for anything but the backend on this machine.
   */
  async function toBackend(a: Arrival, url: URL): Promise<Response> {
    const bodiless = a.method === 'GET' || a.method === 'HEAD'
    const body = bodiless ? undefined : await whole(a, SMALL)
    if (typeof body === 'string') return unread(body)
    const headers = passedOn(a.headers, NOT_PASSED)
    const forwarded: string[] = []
    headers.forEach((_value, name) => {
      if (name.startsWith('x-forwarded-')) forwarded.push(name)
    })
    for (const name of forwarded) headers.delete(name)
    headers.set('x-forwarded-proto', SCHEME)
    // The backend answers about a session only what the door passed on. A caller's own word for it is not the door's
    headers.set('x-it-door', itself)
    // The answer goes back as the bytes the backend sent, so it is asked to send them as they are
    headers.set('accept-encoding', 'identity')
    let answered: Response
    let bytes: ArrayBuffer
    try {
      // An answer that sends the caller elsewhere comes back as it is: nothing is asked of wherever it names
      answered = await direct(`${site}${url.pathname}${url.search}`, { method: a.method, headers, body, signal: AbortSignal.timeout(BACKEND_MS) })
      bytes = await answered.arrayBuffer()
    } catch {
      return refuse(502, 'backend_unreachable')
    }
    const says = passedOn(answered.headers, NOT_RETURNED)
    const empty = a.method === 'HEAD' || [204, 205, 304].includes(answered.status)
    if (!empty) says.set('content-length', String(bytes.byteLength))
    return new Response(empty ? null : bytes, { status: answered.status, headers: says })
  }

  /**
   * A call of one of the backend's functions, sent on to the port the backend takes them at
   * and answered as it answers. The backend does for a caller only what the caller's token
   * allows, which is what it does for the same call made over the live connection.
   *
   * A browser must not be made to call by a page of another site. Such a page's origin is
   * refused. And the call has to say that it is JSON: a page cannot send that to another origin
   * without the browser first asking whether it may, and nothing here ever says that it may.
   * The backend's own answer says so to whoever asks, so of what it answers only the answer
   * itself goes back, and only what a call is made of goes on: no cookie reaches the backend.
   *
   * A caller is a machine or a browser, with the token it was given, or nobody. The backend
   * also takes its administrator's key in the same place, which runs any function, the
   * internal ones included. That is the service's own to use, and it asks the backend itself:
   * nothing that names itself so is passed on from here.
   */
  async function toCall(a: Arrival, path: string): Promise<Response> {
    if (a.method !== 'POST') return refuse(405, 'call_method', { allow: 'POST' })
    if (fromElsewhere(a)) return refuse(403, 'foreign_origin')
    if (!/^application\/json\s*(;|$)/i.test(a.headers.get('content-type') ?? '')) return refuse(415, 'call_type')
    const who = a.headers.get('authorization')
    if (who !== null && !/^Bearer [A-Za-z0-9._~+/=-]+$/.test(who)) return refuse(403, 'call_as')
    const body = await whole(a, CALL_MOST)
    if (typeof body === 'string') return unread(body)
    const headers = new Headers({ 'content-type': 'application/json', 'accept-encoding': 'identity' })
    if (who !== null) headers.set('authorization', who)
    const client = a.headers.get('convex-client')
    if (client !== null) headers.set('convex-client', client)
    let answered: Response
    let bytes: ArrayBuffer
    try {
      // As with the backend's other port: on a connection of the door's own, and never on to wherever an answer names
      answered = await direct(`${api}${path}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(path === '/api/action' ? ACTION_MS : BACKEND_MS),
      })
      bytes = await answered.arrayBuffer()
    } catch {
      return refuse(502, 'backend_unreachable')
    }
    const packed = answered.headers.get('content-encoding')
    return new Response([204, 205, 304].includes(answered.status) ? null : bytes, {
      status: answered.status,
      headers: {
        'content-type': answered.headers.get('content-type') ?? 'application/json',
        'content-length': String(bytes.byteLength),
        // Said only by a backend that packed its answer though it was asked not to
        ...(packed === null ? {} : { 'content-encoding': packed }),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  /** A request for the backend that may carry a code. Where it does, the caller's address is held to so many refusals a minute. */
  async function coded(a: Arrival, url: URL): Promise<Response> {
    if (a.method !== 'POST' || !CODES.has(url.pathname)) return toBackend(a, url)
    const kept = counted(a.address)
    const refused = kept?.count ?? 0
    const waiting = unanswered.get(a.address) ?? 0
    // With ten refused it waits out the rest of the minute. With fewer, and the rest of the ten
    // not yet answered, it waits a moment for those.
    if (refused + waiting >= WRONG_MOST)
      return refuse(429, 'too_many_wrong_codes', {
        'retry-after': String(kept && refused >= WRONG_MOST ? Math.max(1, Math.ceil((kept.since + WRONG_MS - now()) / 1000)) : 1),
      })
    unanswered.set(a.address, waiting + 1)
    try {
      const answered = await toBackend(a, url)
      if (answered.status === 401) refusedCode(a.address)
      return answered
    } finally {
      // However it ended, it is not waited for any more
      const left = (unanswered.get(a.address) ?? 1) - 1
      if (left > 0) unanswered.set(a.address, left)
      else unanswered.delete(a.address)
    }
  }

  /** A request for the content package, with the caller's address beside it. */
  async function toContent(which: 'showing' | 'upload' | 'control', a: Arrival, url: URL, body: BodyInit | null): Promise<Response> {
    const request = new Request(url, {
      method: a.method,
      headers: a.headers,
      body,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit)
    try {
      return await content[which](request, { port: a.port, address: a.address })
    } catch {
      return refuse(500, 'content_failed')
    }
  }

  async function route(a: Arrival): Promise<Response> {
    if (!named(a)) {
      noted('unknown_host')
      return new Response(
        `It does not answer to this name. Open it as http://localhost:${config.port} on the machine it runs on, or by one of that machine's own addresses once it has been told to listen to the network.\n`,
        { status: 421, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } },
      )
    }
    if (!METHODS.has(a.method)) return refuse(405, 'method')
    const url = addressed(a)
    if (!url) return refuse(400, 'bad_request')
    const path = url.pathname
    const bodiless = a.method === 'GET' || a.method === 'HEAD'

    // The pages' port: everything on it is the content package's
    if (a.port !== config.port) {
      const body = bodiless ? null : await whole(a, SMALL)
      return typeof body === 'string' ? unread(body) : toContent('showing', a, url, body)
    }

    // Under /api/ the backend also has the routes that load functions, change its settings and
    // read what it stores as its administrator. None of them can be reached from here: the
    // addresses that are passed on are named, and everything else is refused whatever it is.
    if (path === '/api' || path.startsWith('/api/')) {
      if (a.method === 'GET' && LIVE.test(path)) return json(426, { error: 'websocket_only' }, { upgrade: 'websocket' })
      if (CALLS.has(path)) return toCall(a, path)
      return refuse(404, 'api_path')
    }
    if (path.startsWith('/session/')) {
      // A session is a cookie, and a browser sends a cookie whichever page asks. Only the site's
      // own pages may: a page an agent wrote is shown from another port, and so has another origin.
      if (a.method !== 'POST') return refuse(405, 'session_method', { allow: 'POST' })
      if (!fromHere(a)) return refuse(403, 'foreign_origin')
      return WORDS.test(path) ? coded(a, url) : refuse(404, 'no_such_thing')
    }
    if (path.startsWith('/bridge/')) {
      // The command asks these, and names no origin. A page of another site, whose browser was made to ask, names its own
      if (fromElsewhere(a)) return refuse(403, 'foreign_origin')
      return WORDS.test(path) ? coded(a, url) : refuse(404, 'no_such_thing')
    }
    if (TO_BACKEND.has(path)) return toBackend(a, url)

    if (path.startsWith('/upload/')) {
      if (a.method !== 'PUT') return refuse(405, 'upload_method', { allow: 'PUT' })
      const length = declared(a.headers)
      if (length === null) return refuse(411, 'length_required')
      if (length > LIMITS.fileBytes) return unread('too_large')
      // A file is passed on as it arrives, for as many bytes as it said and no more
      return toContent('upload', a, url, a.body ? held(a.body, length, patience * 20) : null)
    }
    if (path.startsWith('/control/')) {
      if (a.method !== 'POST') return refuse(405, 'control_method', { allow: 'POST' })
      // Only the backend sends these, and it is on this machine
      if (!onThisMachine(a.address)) return refuse(403, 'not_local')
      const body = await whole(a, CONTROL_MOST)
      return typeof body === 'string' ? unread(body) : toContent('control', a, url, body)
    }
    if (path === '/internal' || path.startsWith('/internal/')) {
      if (!onThisMachine(a.address)) return refuse(403, 'not_local')
      const body = bodiless ? null : await whole(a, SMALL)
      if (typeof body === 'string') return unread(body)
      return push.answer(new Request(url, { method: a.method, headers: a.headers, body }), { address: a.address })
    }
    return answerSite(files, a.method, path, a.headers)
  }

  /**
   * An answer as it leaves the pages' port, whatever made it: the content package, a refusal of
   * the door's own, or a fault. It tells the browser that what it carries is a sandboxed
   * document, which is the whole of what keeps one page from another, and it sets no cookie.
   * Only the site may frame it, at the name the request was sent to when that is one of this
   * machine's, and nothing may when it is not.
   */
  const policyFor = (a: Arrival): string => pagePolicy(config.port, named(a) ? a.headers.get('host') : null)
  const confined = (a: Arrival, response: Response): Response => {
    const headers = new Headers(response.headers)
    headers.set('content-security-policy', policyFor(a))
    headers.delete('set-cookie')
    return new Response(response.body, { status: response.status, headers })
  }

  return {
    async answer(a) {
      const response = await route(a).catch(() => refuse(500, 'fault'))
      return a.port === config.port ? response : confined(a, response)
    },
    live(a, early = 0) {
      // A refusal on the pages' port is an answer from it like any other, and says what they all say
      const no = (status: number, code: string, says: Record<string, string> = {}): Live => {
        noted(code)
        return { refuse: status, says: a.port === config.port ? says : { ...says, 'content-security-policy': policyFor(a) } }
      }
      if (!named(a)) return no(421, 'unknown_host')
      const path = addressed(a)?.pathname
      if (path === undefined) return no(400, 'bad_request')
      if (a.port !== config.port || a.method !== 'GET' || !LIVE.test(path)) return no(404, 'websocket_path')
      // The backend believes whoever holds a token. A page on another site has none, but nothing
      // of another site is let near the connection at all. One that names no origin is a
      // program's: the command on a machine that joined from elsewhere, and its connector.
      if (fromElsewhere(a)) return no(403, 'foreign_origin')
      // The backend is asked only for what is a WebSocket's first request in every part, so that
      // it has nothing to refuse, and nothing to read after it. A request that has a body is not
      // one, and neither is one with anything on its heels: a WebSocket's caller says nothing
      // more until it has been answered.
      const said = (name: string) => a.headers.get(name) ?? ''
      if (!/^websocket$/i.test(said('upgrade')) || !namesIn(said('connection')).includes('upgrade')) return no(400, 'not_a_handshake')
      if (a.headers.has('content-length') || a.headers.has('transfer-encoding')) return no(400, 'handshake_body')
      if (said('sec-websocket-version') !== LIVE_VERSION) return no(426, 'websocket_version', { upgrade: 'websocket', 'sec-websocket-version': LIVE_VERSION })
      const key = said('sec-websocket-key')
      if (!LIVE_KEY.test(key)) return no(400, 'websocket_key')
      if (early > 0) return no(400, 'handshake_early')
      return { path, key }
    },
    carried: (port): Record<string, string> => (port === config.port ? {} : { 'content-security-policy': pagePolicy(config.port, null) }),
    goesOn: (port) => port === config.port,
    turned: (why) => noted(why),
    // Only a content package the door made for itself is the door's to close
    close: async () => {
      if (!parts.content) await content.close()
    },
  }
}

// ---------- listening ----------

interface Listening {
  stop(): Promise<void>
}
type Listen = (address: string, port: number, door: Door, api: URL, patience: number) => Promise<Listening>
/** Whether this is the standalone program, which Bun runs. */
const standalone = 'Bun' in globalThis

/** A request's headers as they were sent, every one of them, or null when one of them is not a header at all. */
function headersOf(req: http.IncomingMessage): Headers | null {
  const headers = new Headers()
  try {
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!)
  } catch {
    return null
  }
  return headers
}

/**
 * A request's body with node:http, as a stream that reads from the connection only when it is
 * read itself. `letGo` ends that: what is still on its way is taken off the connection and
 * thrown away, so that whoever sent it can read the answer. That is done for so many bytes and
 * so long, and no further, and it answers whether the whole body had arrived by then.
 * `arriving` lasts for as long as more of the body keeps coming: until it has all arrived, the
 * request is over, or nothing of it has come for a moment.
 */
function bodyOf(req: http.IncomingMessage): { stream: ReadableStream<Uint8Array>; letGo(): Promise<boolean>; arriving(): Promise<void> } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let reading = false
  let gone = false
  const onData = (chunk: Buffer) => {
    controller.enqueue(chunk)
    if ((controller.desiredSize ?? 0) <= 0) req.pause()
  }
  const onEnd = () => {
    stop()
    controller.close()
  }
  const onError = (err: unknown) => {
    stop()
    controller.error(err)
  }
  const stop = () => {
    reading = false
    req.off('data', onData).off('end', onEnd).off('error', onError)
  }
  const letGo = (): Promise<boolean> => {
    gone = true
    stop()
    if (req.complete || req.destroyed) return Promise.resolve(req.complete)
    return new Promise((resolve) => {
      let left = UNREAD_MOST
      const count = (chunk: Buffer) => {
        left -= chunk.length
        if (left < 0) done()
      }
      const done = () => {
        clearTimeout(timer)
        req.off('data', count).off('end', done).off('close', done)
        resolve(req.complete)
      }
      const timer = setTimeout(done, UNREAD_MS)
      req.on('data', count).on('end', done).on('close', done)
      req.resume()
    })
  }
  const arriving = (): Promise<void> =>
    new Promise((resolve) => {
      if (req.complete || req.destroyed) return resolve()
      const done = () => {
        clearTimeout(timer)
        req.off('data', more).off('end', done).off('close', done)
        resolve()
      }
      let timer = setTimeout(done, UNREAD_QUIET_MS)
      const more = () => {
        clearTimeout(timer)
        timer = setTimeout(done, UNREAD_QUIET_MS)
      }
      req.on('data', more).on('end', done).on('close', done)
    })
  // Nothing is asked of the stream ahead of whoever reads it, so a body nobody reads is not begun
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c
      },
      pull() {
        if (gone) return
        if (!reading) {
          reading = true
          req.on('data', onData).on('end', onEnd).on('error', onError)
        }
        req.resume()
      },
      cancel() {
        stop()
        req.pause()
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, letGo, arriving }
}

/**
 * Writes an answer out with node:http, a piece at a time and no faster than it is taken. When
 * whoever asked goes away part of the way through, what was being sent is let go of, so that
 * whatever it was reading from is closed. That they have gone is told by the connection the
 * request came on as well as by the answer: inside the standalone program the answer itself
 * never says so.
 *
 * `cut` ends it from outside, whatever it is waiting for: what was being sent is let go of and
 * the connection is closed, though whoever asked has taken only a part of the answer or none.
 *
 * `before` is waited for between the last piece of the answer and its end. node:http closes a
 * connection whose caller asked for that as soon as the answer on it has ended, whatever the
 * caller is still sending, and a connection closed with something unread on it is reset: the
 * caller may then be told of the reset and never of the answer.
 */
async function send(req: http.IncomingMessage, res: http.ServerResponse, response: Response, cut?: AbortSignal, before?: Promise<unknown>): Promise<void> {
  const says: Record<string, string | string[]> = {}
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') says[name] = value
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length) says['set-cookie'] = cookies
  const reader = response.body?.getReader()
  const letGo = () => void reader?.cancel().catch(() => {})
  const { socket } = req
  let ended = false
  const gone = () => ended || res.destroyed || socket.destroyed
  /** Whatever is being waited for at this moment, to be woken when the answer is cut. */
  const waits = new Set<() => void>()
  /** Waits for one thing the answer may say, or for whoever asked to have gone, or for the answer to be cut. */
  const until = (said: 'drain' | 'finish') =>
    new Promise<void>((resolve) => {
      const on = () => {
        res.off(said, on).off('close', on)
        socket.off('close', on)
        waits.delete(on)
        resolve()
      }
      res.on(said, on).on('close', on)
      socket.on('close', on)
      waits.add(on)
    })
  const end = () => {
    ended = true
    letGo()
    res.destroy()
    socket.destroy()
    for (const wake of [...waits]) wake()
  }
  if (cut?.aborted) end()
  cut?.addEventListener('abort', end, { once: true })
  // Let go of at once when the connection closes, and not only when the next piece is ready: what is being read from may be slow to give one
  socket.once('close', letGo)
  try {
    if (gone()) return letGo()
    res.writeHead(response.status, says)
    if (req.method === 'HEAD' || !reader) letGo()
    else
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (gone()) return letGo()
        if (!res.write(value)) await until('drain')
      }
  } catch {
    // What was being sent failed part of the way: the connection is cut, so that a part is never taken for the whole
    letGo()
    res.destroy()
    return
  } finally {
    socket.off('close', letGo)
    if (gone()) cut?.removeEventListener('abort', end)
  }
  if (gone()) return
  if (before) {
    await before
    if (gone()) return
  }
  const finished = until('finish')
  res.end()
  await finished
  cut?.removeEventListener('abort', end)
}

/**
 * Refuses a WebSocket where a connection that asked for one is the door's own to close. The
 * answer is written, with the headers it was given, and what the caller is still sending is
 * taken off the connection and thrown away for a moment, so that the answer can be read. Then
 * the connection is closed, whether or not the caller has closed its own end of it.
 *
 * Inside the standalone program such a connection cannot be written to as the bytes it is: it
 * is closed all the same, with nothing said on it.
 */
function turnAway(socket: Duplex, head: string[]): void {
  const lines = [...head, 'Connection: close', 'Content-Length: 0']
  let left = UNREAD_MOST
  const timer = setTimeout(() => socket.destroy(), UNREAD_MS)
  socket.once('close', () => clearTimeout(timer))
  socket.on('data', (piece: Buffer) => {
    left -= piece.length
    if (left < 0) socket.destroy()
  })
  socket.end(`${lines.join('\r\n')}\r\n\r\n`)
}

/**
 * What the backend answered a WebSocket's first request with, when it is its agreement to the
 * one whose key was this: the answer the caller is given, in the door's own words, with what
 * the backend agreed to about extensions and protocol. Null for any other answer, and for one
 * that is not written as an answer is.
 */
function agreement(head: string, key: string): string | null {
  const [first = '', ...lines] = head.split('\r\n')
  if (!/^HTTP\/1\.1 101(?: [\t -~]*)?$/.test(first)) return null
  const said = new Map<string, string[]>()
  for (const line of lines) {
    const colon = line.indexOf(':')
    const [name, value] = [line.slice(0, Math.max(colon, 0)).toLowerCase(), line.slice(colon + 1).trim()]
    if (!HEADER_NAME.test(name) || !/^[\t -~]*$/.test(value)) return null
    said.set(name, [...(said.get(name) ?? []), value])
  }
  /** What a header says: null when it is not there, and undefined when it is there more than once, which none of these may be. */
  const one = (name: string) => {
    const all = said.get(name)
    return all === undefined ? null : all.length === 1 ? all[0]! : undefined
  }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  const [extensions, protocol] = [one('sec-websocket-extensions'), one('sec-websocket-protocol')]
  if (!/^websocket$/i.test(one('upgrade') ?? '') || !namesIn(one('connection') ?? '').includes('upgrade')) return null
  if (one('sec-websocket-accept') !== accept || extensions === undefined || protocol === undefined) return null
  const answer = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`]
  if (extensions !== null) answer.push(`Sec-WebSocket-Extensions: ${extensions}`)
  if (protocol !== null) answer.push(`Sec-WebSocket-Protocol: ${protocol}`)
  return `${answer.join('\r\n')}\r\n\r\n`
}

/**
 * With node:http: under Node both ports, with a WebSocket passed on to the backend as the bytes
 * it is, and inside the standalone program the pages' port, where no WebSocket is ever carried.
 *
 * Nothing is answered here that the door did not write. A request that names nobody, or that
 * expects something the door does not know of, is the door's to answer like any other, and
 * what is no request at all is told to the door and not answered by what reads requests.
 */
const listenNode: Listen = (address, port, door, api, patience) => {
  const carried = new Set<Duplex>()
  const server = http.createServer({
    // Only a WebSocket is carried on. Any other request that offers to change protocol is answered as the plain request it also is.
    shouldUpgradeCallback: (req) => /^websocket$/i.test(req.headers.upgrade ?? ''),
    maxHeaderSize: HEADERS_MOST,
    requireHostHeader: false,
    // Headers that do not arrive, and a request that never ends, are given up on
    headersTimeout: 15_000,
    requestTimeout: patience * 20 + 60_000,
  })
  // Inside the standalone program a connection on which nothing moves is closed, as it is on the site's port there
  if (standalone) server.setTimeout(IDLE_S * 1000)
  /** The headers of an answer written as the bytes it is, with what every such answer carries on this port. */
  const written = (status: number, says: Record<string, string>): string[] => [
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}`,
    ...Object.entries({ ...door.carried(port), ...says }).map(([name, value]) => `${name}: ${value}`),
  ]
  const arrivalOf = (req: http.IncomingMessage, headers: Headers, body: ReadableStream<Uint8Array> | null): Arrival => ({
    method: req.method ?? '',
    target: req.url ?? '',
    headers,
    body,
    port,
    address: addressOf(req.socket.remoteAddress),
  })
  /** `unsent` says that the caller has sent none of its body, and waits to be told to go on, which it is not. */
  const answer = (req: http.IncomingMessage, res: http.ServerResponse, unsent = false) => {
    const headers = headersOf(req)
    // A request of any method may carry a body. The door reads none for one that only asks for
    // something, and what such a request carries all the same is let go of like any other.
    const body = bodyOf(req)
    const asks = req.method === 'GET' || req.method === 'HEAD'
    const said = !headers || carries(headers)
    let whole = false
    void (
      headers
        ? door.answer(arrivalOf(req, headers, asks || unsent ? null : body.stream))
        : Promise.resolve(new Response(null, { status: 400, headers: door.carried(port) }))
    )
      .then(async (response) => {
        // The answer goes out while what the caller is still sending is taken off the connection
        // and thrown away, for a moment: a connection closed with something unread on it is
        // reset, and a reset can reach the caller before the answer does. A request that had
        // not all arrived by the end of that moment is not waited for any further, and neither is its
        // caller: the connection is closed however much of the answer is still to be taken, so
        // that a caller who is slow to take it holds the connection for no more time than any other.
        //
        // A caller that asked for its connection to be closed after the answer is given the
        // answer at once like any other, and only the answer's end is kept back for as long as
        // more of what it was sending keeps arriving, since the connection goes with that end.
        const cut = new AbortController()
        if (!standalone) {
          const taken = body.letGo()
          const last = !res.shouldKeepAlive && !unsent
          const sent = send(req, res, response, cut.signal, last ? Promise.race([body.arriving(), taken]) : undefined)
          whole = await taken
          if (!whole) {
            // An end that was still kept back is written first, where the answer had got that far
            if (last) await new Promise((turn) => setImmediate(turn))
            cut.abort()
          }
          return sent
        }
        // Inside the standalone program nothing more of a request is handed over once it has
        // been answered, so there what it carries is taken first, and the answer is then given
        // as long again to be taken. A request that says it carries nothing is left as it came:
        // it is by the request that a caller's going away is told there, and only for as long
        // as the request has not been read to its end.
        // A caller that waits to be told to go on has sent nothing to take, and is answered at once.
        whole = unsent ? false : said ? await body.letGo() : true
        const late = whole ? undefined : setTimeout(() => cut.abort(), UNREAD_MS)
        return send(req, res, response, cut.signal).finally(() => clearTimeout(late))
      })
      .catch(() => res.destroy())
      // Inside the standalone program nothing tells for certain whether a body has arrived, so
      // there the connection of any request that says it carries one is closed once it is answered.
      .finally(() => (!whole || (said && standalone)) && req.socket.destroy())
  }
  // A request that expects something other than to be told to go on is answered as the request it is
  server.on('request', (req, res) => answer(req, res)).on('checkExpectation', (req, res) => answer(req, res))
  // One that expects to be told to go on is told so where the door says such a thing, and its
  // body is then read like any other. Where the door does not, nothing is said before the answer
  // itself, which is given to the request as it stands, with none of its body.
  server.on('checkContinue', (req, res) => {
    if (!door.goesOn(port)) return answer(req, res, true)
    res.writeContinue()
    answer(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    // From here on the connection is the door's alone: nothing else hears what goes wrong on it, or closes it
    carried.add(socket)
    socket.on('error', () => {}).once('close', () => carried.delete(socket))
    const headers = headersOf(req)
    const live: Live = headers ? door.live(arrivalOf(req, headers, null), head.length) : { refuse: 400 }
    if ('refuse' in live) return turnAway(socket, written(live.refuse, live.says ?? {}))
    // The backend is asked for the connection in the door's own words, with only what a
    // WebSocket is agreed by taken from the browser's: no cookie and no other header goes on
    const lines = [
      `GET ${live.path} HTTP/1.1`,
      `Host: ${api.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Version: ${LIVE_VERSION}`,
      `Sec-WebSocket-Key: ${live.key}`,
    ]
    for (const name of ['sec-websocket-extensions', 'sec-websocket-protocol', 'user-agent']) {
      const value = headers!.get(name)
      if (value !== null) lines.push(`${name}: ${value}`)
    }
    const up = net.connect(Number(api.port), api.hostname.replace(/^\[|\]$/g, ''))
    carried.add(up)
    // Until the backend has agreed, nothing is read from the caller, so nothing of the caller's
    // can go on: the request above is all the backend is sent. What it answers is read here,
    // for so many bytes and so long. Anything but its agreement, and its connection is closed
    // and the caller told only that the backend would not. A backend that refuses keeps its
    // connection open for the next request, and no caller is ever to write that request.
    let state: 'asking' | 'carrying' | 'over' = 'asking'
    let answer = Buffer.alloc(0)
    const end = () => {
      state = 'over'
      clearTimeout(waiting)
      carried.delete(up)
      up.destroy()
      socket.destroy()
    }
    const refuse = () => {
      if (state !== 'asking') return
      state = 'over'
      clearTimeout(waiting)
      carried.delete(up)
      up.destroy()
      door.turned('backend_no_websocket')
      turnAway(socket, written(502, {}))
    }
    const waiting = setTimeout(refuse, Math.min(LIVE_OPEN_MS, patience))
    const read = (piece: Buffer) => {
      answer = Buffer.concat([answer, piece])
      const cut = answer.indexOf('\r\n\r\n')
      if (cut < 0 ? answer.length > LIVE_HEAD_MOST : cut > LIVE_HEAD_MOST) return refuse()
      if (cut < 0) return
      up.off('data', read).pause()
      const agreed = agreement(answer.subarray(0, cut).toString('latin1'), live.key)
      if (agreed === null) return refuse()
      state = 'carrying'
      clearTimeout(waiting)
      socket.write(agreed)
      // What the backend said straight after agreeing is the first of what it has to say
      if (answer.length > cut + 4) socket.write(answer.subarray(cut + 4))
      answer = Buffer.alloc(0)
      // From here on it is the two ends' own business how long nothing is said. Each is read
      // only as fast as the other takes it, so a slow end holds up the other and nothing is kept.
      socket.pipe(up)
      up.pipe(socket)
    }
    up.once('connect', () => {
      up.setNoDelay(true)
      up.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    up.on('data', read)
    up.on('error', () => {}).once('close', () => (state === 'asking' ? refuse() : end()))
    socket.once('close', end)
  })
  // What is no request at all is given no answer: its connection is closed, and nothing that
  // reads requests answers in the door's place. The one exception is a request whose headers
  // are longer than are taken: that is said, for as long as the caller can still be written
  // to. Node tells of every further piece of such a request as it told of the first. Each is
  // let pass, for a moment, so that the caller can finish what it was sending and read the
  // answer. Inside the standalone program the connection cannot be written to by then, and is
  // closed like the rest.
  const leaving = new WeakSet<Duplex>()
  server.on('clientError', (err, socket) => {
    if (leaving.has(socket)) return
    if ((err as { code?: string }).code !== 'HPE_HEADER_OVERFLOW' || !socket.writable) return void socket.destroy()
    leaving.add(socket)
    door.turned('headers_too_large')
    const body = JSON.stringify({ error: 'headers_too_large' })
    const timer = setTimeout(() => socket.destroy(), UNREAD_MS)
    socket.once('close', () => clearTimeout(timer))
    socket.end(
      [
        ...written(431, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }),
        'Connection: close',
        `Content-Length: ${body.length}`,
        '',
        body,
      ].join('\r\n'),
    )
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port, host: address, ipv6Only: address.includes(':') }, () => {
      // Once it listens, the one thing that can still go wrong with the port is that a
      // connection could not be taken. That is one caller's loss and is written down: the port
      // is listened on as before, and nothing ends because of it.
      server.off('error', reject).on('error', () => door.turned('accept_failed'))
      resolve({
        // Every connection is closed first and the port after them: asked the other way round,
        // node:http inside the standalone program waits for whoever still holds a connection
        stop: () =>
          new Promise((stopped) => {
            for (const side of carried) side.destroy()
            server.closeAllConnections()
            server.close(() => stopped())
          }),
      })
    })
  })
}

// ---- inside the standalone program ----

/**
 * A request's body as Bun's own server gives it, behind a stream of the door's own. What the
 * door stops reading is not let go of by that: `letGo` does it, as it does with node:http, for
 * so many bytes and so long, and answers whether the whole body had arrived by then.
 */
function bodyIn(body: ReadableStream<Uint8Array>): { stream: ReadableStream<Uint8Array>; letGo(): Promise<boolean> } {
  const reader = body.getReader()
  let whole = false
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
          whole = true
          controller.close()
        } else controller.enqueue(value)
      },
    },
    { highWaterMark: 0 },
  )
  const letGo = async (): Promise<boolean> => {
    let left = UNREAD_MOST
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), UNREAD_MS)
    })
    try {
      while (!whole && left >= 0) {
        const piece = await Promise.race([reader.read(), late])
        if (piece === null) break
        if (piece.done) whole = true
        else left -= piece.value.byteLength
      }
    } catch {
      // Whoever was sending it went away
    } finally {
      clearTimeout(timer)
    }
    if (!whole) void reader.cancel().catch(() => {})
    return whole
  }
  return { stream, letGo }
}

/**
 * An answer that is given a moment to be taken and no more than that. Bun closes a connection that
 * stands still for so long, and one on which an answer is cut off part of the way, so between
 * them a caller that takes its answer a little at a time is held to the same moment as one
 * that takes none of it.
 */
function hurried(response: Response): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  let out: ReadableStreamDefaultController<Uint8Array> | undefined
  let over = false
  const timer = setTimeout(() => {
    over = true
    void reader.cancel().catch(() => {})
    try {
      out?.error(new Error('the answer was not taken in time'))
    } catch {}
  }, UNREAD_MS)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      out = controller
    },
    async pull(controller) {
      const piece = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (over) return
      if (!piece.done) return controller.enqueue(piece.value)
      clearTimeout(timer)
      over = true
      controller.close()
    },
    cancel(reason) {
      clearTimeout(timer)
      over = true
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: response.status, headers: response.headers })
}

/** A WebSocket of the door's own to the backend, as Bun gives one: it can also ask the other end to say it is there, and be closed at once with nothing said. */
type BunClient = WebSocket & { ping(data: string): void; terminate(): void }
/** A WebSocket a browser opened, as Bun hands it over, with what the door keeps beside it. */
interface BunSocket {
  data: {
    /** The door's own connection to the backend for this browser, which was open before the browser's was agreed to. */
    up: BunClient
    /** What the backend said before the browser's connection was there to be told it. */
    early: (string | ArrayBuffer)[] | null
    /** How many bytes of the browser's have been handed to the backend's connection, and how many of them the backend is known to have taken. */
    handed: number
    taken: number
    /** The count the backend has been asked to say it has reached, while it has not yet said so. */
    asked: number | null
    /** Set once either end has closed, so that closing the other is not answered by closing the first again. */
    over: boolean
  }
  send(data: string | ArrayBuffer | Uint8Array): number
  close(code?: number, reason?: string): void
  terminate(): void
}
interface BunServer {
  stop(closeActiveConnections?: boolean): Promise<void>
  requestIP(request: Request): { address: string } | null
  /** Closes the connection a request came on once nothing has moved on it for so many seconds. */
  timeout(request: Request, seconds: number): void
  upgrade(request: Request, options: { data: BunSocket['data'] }): boolean
}
/** What Bun gives a program it runs, as far as the door uses it. Under Node there is no such thing. */
declare const Bun:
  | undefined
  | {
      serve(options: {
        hostname: string
        port: number
        reusePort: boolean
        ipv6Only: boolean
        development: boolean
        idleTimeout: number
        maxRequestBodySize: number
        fetch(request: Request, server: BunServer): Promise<Response | undefined> | Response | undefined
        error(error: unknown): Response
        websocket: {
          maxPayloadLength: number
          backpressureLimit: number
          closeOnBackpressureLimit: boolean
          open(ws: BunSocket): void
          message(ws: BunSocket, message: string | Uint8Array): void
          close(ws: BunSocket, code: number, reason: string): void
        }
      }): BunServer
    }

// The codes a WebSocket may be closed with. Whoever opened one may only give the first kind;
// whoever was asked for one may give the second as well. The rest are never sent: they only
// ever describe a connection that broke.
const fromOpener = (code: number) => code === 1000 || (code >= 3000 && code <= 4999)
const fromAsked = (code: number) => fromOpener(code) || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code))

/** Inside the standalone program, the site's port: Bun's own server, and a WebSocket passed on a message at a time. */
const listenBun: Listen = async (address, port, door, api, patience) => {
  /** The WebSockets the backend has not yet agreed to: for each, what gives up on it. */
  const asking = new Set<(said: boolean) => void>()
  /** Asks the backend to say when it has taken everything handed to it so far. One such question is out at a time. */
  const reached = (d: BunSocket['data']) => {
    d.asked = d.handed
    d.up.ping(String(d.handed))
  }
  // Bun has one limit on headers for every server in the program, and this is where it is kept
  ;(http as { maxHeaderSize: number }).maxHeaderSize = HEADERS_MOST
  const server = Bun!.serve({
    hostname: address,
    port,
    // Said outright: a port that something else holds is a failure here, never a port shared
    reusePort: false,
    ipv6Only: address.includes(':'),
    // Nothing of a fault is ever shown to whoever asked
    development: false,
    // A connection on which nothing moves for this many seconds is closed, which is also how
    // headers that stop arriving are given up on
    idleTimeout: IDLE_S,
    maxRequestBodySize: LIMITS.fileBytes + SMALL,
    async fetch(request, server) {
      const body = request.body ? bodyIn(request.body) : null
      const arrival: Arrival = {
        method: request.method,
        target: request.url,
        headers: request.headers,
        body: body?.stream ?? null,
        port,
        address: addressOf(server.requestIP(request)?.address),
      }
      // Once an answer has been handed over, nothing more can be done about the connection it
      // goes out on. So what the caller is still sending is taken off the connection first, for
      // so many bytes and so long, and then the answer is given. A request that was still
      // arriving after that is not waited for: its connection is closed, as soon as Bun looks.
      // So is one that says it carries a body where Bun hands none over, as it does for a
      // request that only asks for something: nothing tells whether that body has arrived.
      const answered = async (response: Response): Promise<Response> => {
        if (body ? await body.letGo() : !carries(request.headers)) return response
        // And not for longer because its caller is slow to take the answer: what of the answer
        // has not gone when the moment is over is cut off, which closes the connection too
        server.timeout(request, UNREAD_S)
        return hurried(response)
      }
      // Only a WebSocket is carried on. Any other request that offers to change protocol is answered as the plain request it also is.
      if (!/^websocket$/i.test(request.headers.get('upgrade') ?? '') || !namesIn(request.headers.get('connection')).includes('upgrade'))
        return answered(await door.answer(arrival))
      const live = door.live({ ...arrival, body: null })
      if ('refuse' in live) return answered(new Response(null, { status: live.refuse, headers: live.says }))
      // The backend is asked first, on a connection of the door's own, and the browser is
      // agreed with only once the backend has agreed, within so long. A browser says nothing
      // until it is agreed with, so there is nothing of its to keep meanwhile, and it is never
      // told yes with nobody behind the door.
      return new Promise<Response | undefined>((answer) => {
        const up = new WebSocket(`ws://${api.host}${live.path}`) as BunClient
        up.binaryType = 'arraybuffer'
        const data: BunSocket['data'] = { up, early: [], handed: 0, taken: 0, asked: null, over: false }
        const settle = (how: Response | undefined) => {
          clearTimeout(waiting)
          asking.delete(refuse)
          answer(how)
        }
        /** The backend would not, or the door is closing: its connection is closed at once, and the caller is told only that. */
        const refuse = (said: boolean) => {
          if (!asking.has(refuse)) return
          if (said) door.turned('backend_no_websocket')
          settle(new Response(null, { status: 502 }))
          try {
            up.terminate()
          } catch {}
        }
        asking.add(refuse)
        const waiting = setTimeout(() => refuse(true), Math.min(LIVE_OPEN_MS, patience))
        up.onerror = () => {}
        up.onclose = () => refuse(true)
        up.onmessage = (event) => {
          data.early?.push(event.data as string | ArrayBuffer)
        }
        up.onopen = () => {
          if (!asking.has(refuse)) return
          // A caller that went away meanwhile has no connection left to become a WebSocket
          let agreed = false
          try {
            agreed = server.upgrade(request, { data })
          } catch {}
          settle(agreed ? undefined : new Response(null, { status: 400 }))
          if (!agreed) up.terminate()
        }
      })
    },
    error: () => new Response(null, { status: 500 }),
    websocket: {
      // The backend sends a whole page's state in one message
      maxPayloadLength: LIVE_MOST,
      // A browser that takes what it is sent too slowly is cut off, and connects again. Nothing
      // is ever left out of what it is sent: it would go on with a picture that is wrong.
      backpressureLimit: LIVE_MOST,
      closeOnBackpressureLimit: true,
      open(ws) {
        const { up } = ws.data
        for (const said of ws.data.early ?? []) ws.send(said)
        ws.data.early = null
        up.onmessage = (event) => {
          ws.send(event.data as string | ArrayBuffer)
        }
        // The backend answers a ping when it has read everything that was sent before it
        up.addEventListener('pong', (event) => {
          const d = ws.data
          if (d.asked === null || Buffer.from((event as MessageEvent).data as ArrayBuffer).toString() !== String(d.asked)) return
          d.taken = d.asked
          d.asked = null
          if (d.handed > d.taken) reached(d)
        })
        up.onclose = (event) => {
          if (ws.data.over) return
          ws.data.over = true
          // The backend's own reason goes on to the browser, which decides by it how soon to try again
          try {
            if (fromAsked(event.code)) ws.close(event.code, event.reason)
            else ws.close(1011)
          } catch {
            ws.terminate()
          }
        }
      },
      message(ws, message) {
        const d = ws.data
        if (d.over) return
        // Bun does not say how much of what it was handed is still waiting to be written, so it
        // is counted here: what was handed over, less what the backend has said it has taken.
        // No more than one message of the largest size may be waiting. A browser cannot be made
        // to wait, so past that both ends are closed: the browser's with a word to come back
        // later, and the backend's at once and with none, since a word would wait behind
        // everything it has not taken.
        const size = (typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength) + LIVE_FRAME
        if (d.handed - d.taken + size > LIVE_MOST + LIVE_FRAME) {
          d.over = true
          door.turned('backend_slow')
          try {
            d.up.terminate()
          } catch {}
          try {
            ws.close(LIVE_LATER)
          } catch {
            ws.terminate()
          }
          return
        }
        d.up.send(message as string | ArrayBuffer)
        d.handed += size
        if (d.asked === null) reached(d)
      },
      close(ws, code, reason) {
        if (ws.data.over) return
        ws.data.over = true
        try {
          if (fromOpener(code)) ws.data.up.close(code, reason)
          else ws.data.up.close()
        } catch {}
      },
    },
  })
  return {
    // Bun closes the port and every connection on it as it is asked to. What it promises is
    // not waited for: it goes on counting a WebSocket that the door itself closed, and so may
    // never say that it is done.
    stop: async () => {
      for (const refuse of [...asking]) refuse(false)
      void server.stop(true).catch(() => {})
    },
  }
}

const HINT = 'It listens on one port and on the one after it. Stop whatever is using this one, or choose another first port by setting IT_PORT.'
function cannotListen(port: number, err: unknown): Problem {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'EADDRINUSE') return new Problem(`Port ${port} is already in use on this machine, so It cannot listen on it.`, 'port_taken', HINT)
  return new Problem(`It could not listen on port ${port}${typeof code === 'string' && /^[A-Z_]+$/.test(code) ? ` (${code})` : ''}.`, 'cannot_listen', HINT)
}

/**
 * Whether this machine can be listened on at an address at all. It is tried on a port the
 * system picks, which nothing can be holding, so that failing means the address and never the
 * port: the two runtimes do not say the same thing about why a port could not be had.
 */
const hasAddress = (address: string) =>
  new Promise<boolean>((resolve) => {
    // Whoever connects in the moment it is open is let go of at once, so that closing it waits for nobody
    const tried = net.createServer((socket) => socket.destroy())
    tried.once('error', () => resolve(false))
    tried.listen({ port: 0, host: address, ipv6Only: address.includes(':') }, () => tried.close(() => resolve(true)))
  })

/**
 * Opens the door: the base port and the one after it, on this machine only, or on every address
 * it has when the network is on. Both families of address are listened on, each by itself, so
 * that a caller's address is always the one it has. A machine without IPv6 is listened on
 * without it.
 *
 * Inside the standalone program node:http cannot be told to listen on IPv6 alone, and on every
 * address of that family it takes callers of both. So with the network on the pages' port is
 * listened on once there, and a caller's IPv4 address arrives written as an IPv6 one, which is
 * read back as what it is.
 */
export async function startDoor(
  config: ServiceConfig,
  backend: Backend,
  say: (line: string) => void,
  parts: DoorParts = {},
): Promise<{ stop(): Promise<void> }> {
  const door = makeDoor(config, backend, say, parts)
  const api = new URL(backend.api)
  const [four, six] = config.network ? ['0.0.0.0', '::'] : ['127.0.0.1', '::1']
  const both = await hasAddress(six)
  const addresses = both ? [four, six] : [four]
  const ports: { port: number; listen: Listen; addresses: string[] }[] = [
    { port: config.port, listen: standalone ? listenBun : listenNode, addresses },
    { port: contentPort(config.port), listen: listenNode, addresses: standalone && config.network && both ? [six] : addresses },
  ]
  const open: Listening[] = []
  const close = async () => {
    await Promise.all(open.map((listening) => listening.stop().catch(() => {})))
    await door.close().catch(() => {})
  }
  try {
    for (const { port, listen, addresses } of ports)
      for (const address of addresses)
        open.push(
          await listen(address, port, door, api, parts.patience ?? PATIENCE_MS).catch((err) => {
            throw cannotListen(port, err)
          }),
        )
  } catch (err) {
    // What was opened before the port that could not be had is closed again
    await close()
    throw err
  }
  say(
    `door open on port ${config.port} (${!config.network ? 'the network is off: this machine only' : config.tailnet ? 'the network is on: this machine’s tailnet only' : 'the network is on: every address this machine has'})`,
  )
  return {
    async stop() {
      await close()
      say('door closed')
    },
  }
}
