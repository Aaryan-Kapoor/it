// The token bridge and the backend's public keys. This is the only place a long-lived
// credential is turned into something the backend believes: it checks the credential itself,
// strictly, and mints a five-minute token for one audience. A machine's credential is the key
// it enrolled with, and a browser's is the session it was paired into.
import { AUDIENCE, PROTOCOL_VERSION } from '@it/protocol'
import { httpRouter } from 'convex/server'
import { ConvexError } from 'convex/values'
import { base64url, createLocalJWKSet, importJWK, type JWK, jwtVerify } from 'jose'
import { internal } from './_generated/api'
import { httpAction } from './_generated/server'
import { doorKey, issuer } from './config'
import { overClashes } from './lib/clash'
import { cookieFor, FAMILY } from './lib/cookie'
import { sha256 } from './lib/hash'
import { kind, log } from './lib/log'
import { mint, publicKeys } from './lib/signing'

/** An answer in JSON, which nothing may keep, with each cookie it sets or clears on a line of its own. */
function json(status: number, body: unknown, cookies: string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' })
  for (const one of cookies) headers.append('set-cookie', one)
  return new Response(JSON.stringify(body), { status, headers })
}

/** What whoever sent a code is told when nothing comes of it: wrong, used and expired are answered alike. */
const WRONG_CODE = 'That code is wrong, used or expired. Ask for a new one.'

/** Reads a JSON object body, or null. Anything else (an array, a string, null, bad JSON) is null. */
async function objectBody(request: Request): Promise<Record<string, unknown> | null> {
  // No route takes more than a key, a proof or a code. Nothing larger is read: the body is taken
  // a piece at a time and given up on the moment it is too long, whatever length it claimed.
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (!Number.isFinite(declared) || declared > 8192 || !request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 8192) {
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
  let body: unknown = null
  try {
    body = JSON.parse(new TextDecoder().decode(all))
  } catch {}
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}
/** A rate limit or other refusal from a mutation, as an HTTP status. */
function refusal(err: unknown, route: string): Response {
  const data = err instanceof ConvexError ? (err.data as { code?: string; message?: string }) : null
  // A rate limit is written down where it is counted (lib/limits.ts)
  if (data?.code === 'rate_limited') return json(429, { error: data.message })
  log('request.failed', { route, kind: kind(err) }, 'error')
  return json(500, { error: 'The request could not be completed.' })
}

const http = httpRouter()

http.route({
  path: '/.well-known/jwks.json',
  method: 'GET',
  handler: httpAction(
    async (ctx) =>
      new Response(JSON.stringify(await publicKeys(ctx)), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } }),
  ),
})

// Whoever asks how It is can tell It's answer from another program's at the same address by `it`
http.route({ path: '/health', method: 'GET', handler: httpAction(async () => json(200, { ok: true, it: true })) })

// What the `it` command needs to know before it has a token: which protocol the backend speaks,
// and the name it signs under, which a machine's proof is made out to. None of it is secret.
http.route({
  path: '/cli/config',
  method: 'GET',
  handler: httpAction(async () => json(200, { protocol: PROTOCOL_VERSION, issuer: issuer() })),
})

// Enrolling another machine: a code that a machine already enrolled, or the owner's browser,
// asked for vouches for a key the new machine made. After this the machine needs nothing but
// that key. (The first machine is enrolled by the service that runs the backend: bridge.ts.)
http.route({
  path: '/bridge/enroll',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await objectBody(request)
    // Nothing that could be a code: it is refused before anything is looked up
    if (!body || typeof body.code !== 'string' || body.code.length > 64) return json(401, { error: 'Send the code this machine was invited with.' })
    const key = body.publicKey as Record<string, unknown> | undefined
    // Only a well-formed public key on the right curve is kept, and only its four public fields.
    // One that is not is refused before the code is looked at, and is not written down: whoever
    // sent it has shown nothing yet.
    if (
      !key ||
      typeof key !== 'object' ||
      key.kty !== 'EC' ||
      key.crv !== 'P-256' ||
      'd' in key ||
      typeof key.x !== 'string' ||
      typeof key.y !== 'string' ||
      key.x.length > 64 ||
      key.y.length > 64
    )
      return json(400, { error: 'Send a P-256 public key.' })
    const publicKey = { kty: 'EC' as const, crv: 'P-256' as const, x: key.x, y: key.y }
    try {
      await importJWK(publicKey as JWK, 'ES256')
    } catch {
      return json(400, { error: 'That is not a valid key.' })
    }
    const codeHash = await sha256(body.code)
    try {
      // Asked again if the backend gave up on it because another call touched the same count at
      // the same instant
      const made = await overClashes(() =>
        ctx.runMutation(internal.bridge.enrollInvited, {
          codeHash,
          name: typeof body.name === 'string' ? body.name : 'machine',
          publicKey,
          ...(typeof body.replaces === 'string' && body.replaces.length <= 64 ? { replaces: body.replaces } : {}),
        }),
      )
      if ('error' in made)
        return made.error === 'code'
          ? json(401, { error: WRONG_CODE })
          : made.error === 'limit'
            ? json(429, { error: 'It has as many machines as it can have. Revoke one on the site.' })
            : json(403, { error: 'Everything It holds is being erased, and no machine is enrolled until that is done.' })
      return json(200, { machine: made.machineId })
    } catch (err) {
      return refusal(err, 'enroll')
    }
  }),
})

// A token: the machine signs "which machine, for this address, now, and this once" with its key
http.route({
  path: '/bridge/token',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await objectBody(request)
    if (!body || typeof body.machine !== 'string' || typeof body.proof !== 'string' || body.machine.length > 64 || body.proof.length > 2000)
      return json(400, { error: 'Send a machine id and a proof.' })
    const m = await ctx.runQuery(internal.bridge.machine, { id: body.machine })
    // Nothing is written down until the caller has proved it holds the machine's key: an id is
    // anybody's to send, as often as they like. Each refusal says which kind it is, so that a
    // machine can tell being revoked from a proof that was merely unlucky.
    if (!m) return json(401, { error: 'Unknown or revoked machine.', reason: 'unknown' })
    let payload: { jti?: unknown; iat?: number }
    try {
      ;({ payload } = await jwtVerify(body.proof, await importJWK(m.publicKey as JWK, 'ES256'), {
        issuer: body.machine,
        audience: `${issuer()}/bridge/token`,
        algorithms: ['ES256'],
        requiredClaims: ['iat', 'jti'],
        maxTokenAge: '60s',
        // A machine's clock may be up to a minute out, either way
        clockTolerance: 60,
      }))
    } catch (err) {
      // A good signature at the wrong time is a clock problem, and the machine should be told
      // so: otherwise it looks exactly like having been revoked
      const code = (err as { code?: string; claim?: string }).code
      const timing = code === 'ERR_JWT_EXPIRED' || (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && (err as { claim?: string }).claim === 'iat')
      // Not written down, though only the holder of the key gets this far: it is refused before
      // the machine's own limit is counted, and the answer says what was wrong
      if (timing) {
        return json(401, { error: 'The proof was made at the wrong time.', reason: 'clock', now: Math.floor(Date.now() / 1000) })
      }
      return json(401, { error: 'The proof does not verify.', reason: 'signature' })
    }
    if (typeof payload.jti !== 'string' || payload.jti.length < 16 || payload.jti.length > 64 || typeof payload.iat !== 'number') {
      return json(401, { error: 'The proof has no usable number.', reason: 'proof' })
    }
    try {
      // Counted against the machine's own limit before anything else, so that what follows is
      // written down no faster than that
      const spent = await overClashes(() =>
        ctx.runMutation(internal.bridge.spend, { machineId: m.id, jti: payload.jti as string, issuedAt: payload.iat as number }),
      )
      // The machine was revoked: said by the mutation, once an hour
      if (spent === 'revoked') return json(401, { error: 'Unknown or revoked machine.', reason: 'revoked' })
      if (spent !== 'ok') {
        // A proof presented twice is either a retry of a request whose answer was lost, or a copy
        log('token.refused', { machineId: m.id, reason: spent }, 'warn')
        return json(401, { error: 'The proof was already used, or is too old.', reason: 'proof' })
      }
    } catch (err) {
      return refusal(err, 'token')
    }
    return json(200, { token: await mint(ctx, AUDIENCE.machine, m.id, { kind: 'machine' }, 300), expires_in: 300 })
  }),
})

// ---------- a browser's session ----------

const YEAR_S = 31_536_000
/** What a browser is told when nothing it presented is a session that is still paired. */
const NOT_PAIRED = 'This browser is not paired.'
/**
 * How a session's cookie is kept: sent to addresses under `/session` and no others, out of
 * reach of any script, and never sent with a request that another site caused. It is not kept
 * to https: the site is reached over plain http, on the machine itself and across a home
 * network alike.
 */
const KEPT = 'HttpOnly; SameSite=Strict; Path=/session'
/** The cookie one session is held in (lib/cookie.ts), for a year from now. */
const cookie = (sessionId: string, secret: string) => `${cookieFor(sessionId)}=${secret}; ${KEPT}; Max-Age=${YEAR_S}`
/** The same cookie cleared, by its name: what a browser is sent for a session that is over. */
const cleared = (name: string) => `${name}=; ${KEPT}; Max-Age=0`
/** What a session's secret looks like: 32 random bytes, as they are written in a cookie. */
const SECRET = /^[A-Za-z0-9_-]{43}$/
/** What the name of a session's cookie looks like. */
const NAMED = /^[A-Za-z0-9_]{1,80}$/
/** How many of the family's cookies are looked at in one request. No browser keeps more for one host. */
const LOOKED_AT = 200
/**
 * Every cookie of the family that a request presents and that is shaped like a session's: its
 * name, what it holds, and the hash that is looked up by, in the order sent. There may be
 * several, since each session has its own and a browser may still hold those of sessions that
 * are over. Which of them is a session is for the lookup to say (sessions.ts).
 */
async function presented(request: Request): Promise<{ name: string; secret: string; hash: string }[]> {
  const held = new Map<string, string>()
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const [name, secret] = [part.slice(0, at).trim(), part.slice(at + 1).trim()]
    if (name.startsWith(FAMILY) && NAMED.test(name) && SECRET.test(secret) && !held.has(name)) held.set(name, secret)
  }
  return Promise.all([...held].slice(0, LOOKED_AT).map(async ([name, secret]) => ({ name, secret, hash: await sha256(secret) })))
}
/** The same, as the lookup is given it: never the secret itself. */
const named = (held: { name: string; hash: string }[]) => held.map(({ name, hash }) => ({ name, hash }))
/** Whether two strings are the same, taking as long to say so wherever they first differ. */
function same(a: string, b: string): boolean {
  let differs = a.length ^ b.length
  for (let i = 0; i < a.length; i++) differs |= a.charCodeAt(i) ^ b.charCodeAt(i % (b.length || 1))
  return differs === 0
}
/**
 * The session routes are the site's own to call, and it calls them through the door. A header
 * of our own says it is the site calling: a form, or a page somewhere else, cannot send one
 * without the browser first asking whether it may, and nothing here ever says that it may. A
 * second header is the door's, with words only the door and this backend hold, so that a
 * browser sent to this backend's own port, where the door looked at nothing, is refused whatever
 * it sends.
 */
const notTheSite = (request: Request): Response | null =>
  request.headers.get('x-it-site') === '1' && same(request.headers.get('x-it-door') ?? '', doorKey())
    ? null
    : json(403, { error: 'Only the site may ask this.' })

// What a code is for, asked before it is traded: 200 with `role`, `owner` or `screen`, for a
// code that would pair a browser now, and 401 for any other, in the words a refused code is
// answered with. The code is not used by being asked about.
http.route({
  path: '/session/code',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const refused = notTheSite(request)
    if (refused) return refused
    const body = await objectBody(request)
    if (!body || typeof body.code !== 'string' || body.code.length > 64) return json(400, { error: 'Send a code.' })
    try {
      const role = await overClashes(async () => ctx.runMutation(internal.sessions._codeFor, { codeHash: await sha256(body.code as string) }))
      return role ? json(200, { role }) : json(401, { error: WRONG_CODE })
    } catch (err) {
      return refusal(err, 'code')
    }
  }),
})

// Pairing: the code a browser was given is traded, once, for a session. The answer carries the
// session only as a cookie, named for that session. A code for a screen that arrives with the
// owner's own session is answered 409 with the code `already_owner`, and is not spent: the site
// says that the address is for the other screen.
http.route({
  path: '/session/redeem',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const refused = notTheSite(request)
    if (refused) return refused
    const body = await objectBody(request)
    if (!body || typeof body.code !== 'string' || body.code.length > 64) return json(400, { error: 'Send a code.' })
    // The secret is made here, and only its hash goes any further
    const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
    const [codeHash, secretHash] = [await sha256(body.code), await sha256(secret)]
    // Whatever session this browser holds already ends when the new one begins
    const held = await presented(request)
    try {
      const made = await overClashes(() => ctx.runMutation(internal.sessions._redeem, { codeHash, secretHash, presented: named(held) }))
      if (!made) return json(401, { error: WRONG_CODE })
      if ('refused' in made)
        return json(409, {
          error: 'This browser is already paired as the owner’s. The code is for another screen, and has not been used.',
          code: 'already_owner',
        })
      // The new session's cookie comes first, and then the clearing of those that are over
      return json(200, { ok: true }, [cookie(made.sessionId, secret), ...made.over.map(cleared)])
    } catch (err) {
      return refusal(err, 'redeem')
    }
  }),
})

// A token: the browser's session earns it one that says whose it is, which session, and which
// kind of browser. The site asks again before it runs out. A browser whose cookie is more than
// a day old is given it again with the answer, for a year from then: a pairing that is used
// does not run out. The cookie given again is that session's own, whatever else the browser
// holds by the time the answer reaches it, and the cookie of a session that is over is cleared.
http.route({
  path: '/session/token',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const refused = notTheSite(request)
    if (refused) return refused
    const held = await presented(request)
    if (held.length === 0) return json(401, { error: NOT_PAIRED })
    let found: { session: { sessionId: string; userId: string; role: 'owner' | 'screen'; renew: boolean } | null; over: string[] }
    try {
      found = await overClashes(() => ctx.runMutation(internal.sessions._present, { presented: named(held) }))
    } catch (err) {
      return refusal(err, 'session')
    }
    const s = found.session
    const cookies = found.over.map(cleared)
    // None of it is a session that has not ended
    if (!s) return json(401, { error: NOT_PAIRED }, cookies)
    const token = await mint(ctx, AUDIENCE.browser, s.userId, { kind: 'browser', sid: s.sessionId, role: s.role }, 300)
    const again = s.renew ? held.find((h) => h.name === cookieFor(s.sessionId)) : undefined
    return json(200, { token, expiresIn: 300, user: s.userId, session: s.sessionId, role: s.role }, [
      ...(again ? [cookie(s.sessionId, again.secret)] : []),
      ...cookies,
    ])
  }),
})

// Signing out: the browser names the session it means to end, and that session ends at once,
// whatever tokens it was given, when the request comes with that session's own cookie. A tab
// left open from before the browser was paired again names a session the browser holds no
// more: nothing is ended, and the answer is 409 with the code `another_session`. With no cookie
// that is a session still paired there is nothing to end, and the answer is 401. Whichever it
// is, the cookie of the session that was named is cleared once that session is over, and no
// other session's cookie is touched.
http.route({
  path: '/session/end',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const refused = notTheSite(request)
    if (refused) return refused
    const body = await objectBody(request)
    if (!body || typeof body.session !== 'string' || !body.session || body.session.length > 64) return json(400, { error: 'Send the session to end.' })
    const held = await presented(request)
    if (held.length === 0) return json(401, { error: NOT_PAIRED })
    let said: { ended: 'ended' | 'another' | 'none'; over: string[] }
    try {
      said = await overClashes(() => ctx.runMutation(internal.sessions._end, { presented: named(held), session: body.session as string }))
    } catch (err) {
      // The browser keeps its cookie, so that it can ask again
      log('session.end_failed', { kind: kind(err) }, 'error')
      return json(503, { error: 'Try again shortly.' })
    }
    const cookies = said.over.map(cleared)
    if (said.ended === 'none') return json(401, { error: NOT_PAIRED }, cookies)
    if (said.ended === 'another')
      return json(409, { error: 'This browser has been paired again since, and the session it holds was not ended.', code: 'another_session' }, cookies)
    return json(200, { ok: true }, cookies)
  }),
})

// Whether It still holds anything for a person, asked by a browser that finds it is not paired,
// of the person it was last paired for: 200 with `there`, which is false once everything has
// been erased. The browser then lets go of what it kept for them. It asks by that person's id,
// which it was given with its tokens and which nobody could guess.
http.route({
  path: '/session/person',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const refused = notTheSite(request)
    if (refused) return refused
    const body = await objectBody(request)
    if (!body || typeof body.person !== 'string' || !body.person || body.person.length > 64) return json(400, { error: 'Send the person.' })
    try {
      return json(200, { there: await ctx.runQuery(internal.sessions._personThere, { person: body.person }) })
    } catch (err) {
      return refusal(err, 'person')
    }
  }),
})

// A display signs itself out with a token it was given while its browser was paired (see
// displays.signOutToken). The browser may not be paired when it presents it, so this asks for
// nothing but the token.
http.route({
  path: '/display/signout',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await objectBody(request)
    if (!body || typeof body.token !== 'string' || body.token.length > 4000) return json(400, { error: 'Send a token.' })
    // Only a token that is not one is refused for good. Trouble on this side (the keys could
    // not be read, the sign-out could not be recorded) is answered as trouble, so that the
    // browser keeps its token and presents it again.
    let claims: { sub?: unknown; u?: unknown; e?: unknown }
    let keys: Awaited<ReturnType<typeof publicKeys>>
    try {
      keys = await publicKeys(ctx)
    } catch (err) {
      log('signout_token.failed', { reason: 'keys', kind: kind(err) }, 'error')
      return json(503, { error: 'Try again shortly.' })
    }
    try {
      claims = (
        await jwtVerify(body.token, createLocalJWKSet(keys), {
          issuer: issuer(),
          audience: AUDIENCE.signOut,
          algorithms: ['ES256'],
          requiredClaims: ['exp', 'sub'],
        })
      ).payload
    } catch {
      // Anyone can send something that is not a token, and whoever once held a real one can
      // send it again after it has run out, as often as they like: neither is written down
      return json(401, { error: 'Not a sign-out token.' })
    }
    if (typeof claims.sub !== 'string' || typeof claims.u !== 'string' || !Number.isInteger(claims.e)) {
      log('signout_token.refused', { reason: 'claims' }, 'warn')
      return json(401, { error: 'Not a sign-out token.' })
    }
    try {
      // Done, or already done: either way there is nothing more for the browser to do. Which
      // of the two it was is written down by the mutation.
      await overClashes(() =>
        ctx.runMutation(internal.displays._signOutByToken, { displayId: claims.sub as string, userId: claims.u as string, epoch: claims.e as number }),
      )
    } catch (err) {
      log('signout_token.failed', { reason: 'record', kind: kind(err) }, 'error')
      return json(503, { error: 'Try again shortly.' })
    }
    return json(200, { ok: true })
  }),
})

export default http
