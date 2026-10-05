// Notifications for a display whose site is closed. The backend decides who is told what, and
// asks this machine's service to do the sending: sealing a message for one browser takes
// cryptography the backend's own functions do not have. Two things are answered here, both only
// to the backend on this machine: the sending itself, and the public key a browser subscribes with.
//
// The keys every notification is signed with are this machine's own. They are made the first
// time one is needed and kept in It's folder, readable by this user alone. A browser's
// subscription is good only for the key it was made with.
import { createHash } from 'node:crypto'
import { AUDIENCE, isPushEndpoint, onThisMachine } from '@it/protocol'
import { createRemoteJWKSet, customFetch, errors, type JWTPayload, jwtVerify } from 'jose'
import webpush from 'web-push'
import { direct, inHome, readJson, writePrivate } from '../lib'

/** A request to a push service as the web-push package makes it: sealed for one browser, and signed with this machine's key. */
export interface Sealed {
  endpoint: string
  headers: Record<string, string>
  body: Uint8Array<ArrayBuffer>
}
/** Takes a sealed request to its push service, and gives back the status the push service answered with. */
export type Carry = (sealed: Sealed) => Promise<number>

export interface PushSettings {
  /** The backend's address for HTTP, where its public keys are read and which names it as the signer. */
  backendSite: string
  /** Told each refusal by its code, for the log. Never anything of the request. */
  refused?: (code: string) => void
  /** Given by a test that stands in for the push service. */
  carry?: Carry
}
export interface Push {
  answer(request: Request, asked: { address: string }): Promise<Response>
}

interface Keys {
  publicKey: string
  privateKey: string
}
export const keysFile = () => inHome('push.json')
function keys(): Keys {
  const kept = readJson<Partial<Keys>>(keysFile())
  if (typeof kept?.publicKey === 'string' && typeof kept.privateKey === 'string') return { publicKey: kept.publicKey, privateKey: kept.privateKey }
  const made = webpush.generateVAPIDKeys()
  writePrivate(keysFile(), made)
  return made
}

/** How long a notification is kept for a browser that cannot be reached, when the backend does not say: an hour, in seconds. */
const KEPT_S = 3600
/** The longest a push service keeps one: four weeks. */
const KEPT_MOST_S = 2_419_200
/** The most text one notification may carry, in bytes. A push service takes about four thousand, sealed. */
const TEXT_MOST = 3000

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })

/** How a sealed request is taken to its push service when no test stands in for one. */
export const carryOut: Carry = async ({ endpoint, headers, body }) => {
  // A push service answers where it was asked. One that sends the request elsewhere is not followed.
  const answered = await fetch(endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10_000) })
  await answered.body?.cancel()
  return answered.status
}

export function createPush(settings: PushSettings): Push {
  const site = settings.backendSite.replace(/\/$/, '')
  // The backend is on this machine, and is asked for its keys on a connection no proxy named in the environment is part of
  const backendKeys = createRemoteJWKSet(new URL(`${site}/.well-known/jwks.json`), {
    cooldownDuration: 10_000,
    cacheMaxAge: 600_000,
    [customFetch]: direct,
  })
  const carry = settings.carry ?? carryOut
  const refuse = (status: number, code: string) => {
    settings.refused?.(code)
    return json(status, { error: code })
  }

  /** What a token says, when the request carries one that the backend made for the service, a minute at most ago. */
  async function fromBackend(request: Request): Promise<JWTPayload | 'no' | 'unknown'> {
    const token = (request.headers.get('authorization') ?? '').match(/^Bearer (\S+)$/)?.[1]
    if (!token) return 'no'
    try {
      const { payload } = await jwtVerify(token, backendKeys, {
        issuer: site,
        audience: AUDIENCE.push,
        algorithms: ['ES256'],
        requiredClaims: ['exp', 'iat'],
        clockTolerance: 5,
      })
      return (payload.exp as number) - (payload.iat as number) <= 65 ? payload : 'no'
    } catch (err) {
      // A token that is not good is refused. Not being able to read the backend's keys is this
      // side's trouble and not the caller's, and is answered as such, so that it is asked again.
      // Only the checker's own verdict on a token counts as the first: a request for the keys
      // that failed is said differently by each runtime, and never as one of those.
      const verdict = err instanceof errors.JOSEError ? err.code : undefined
      return verdict === undefined || ['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC'].includes(verdict) ? 'unknown' : 'no'
    }
  }

  return {
    async answer(request, asked) {
      if (!onThisMachine(asked.address)) return refuse(403, 'push_not_local')
      const path = new URL(request.url).pathname
      const key = path === '/internal/push/key' && request.method === 'GET'
      const send = path === '/internal/push' && request.method === 'POST'
      if (!key && !send) return refuse(404, 'push_no_such_thing')
      const signed = await fromBackend(request)
      if (signed === 'unknown') return refuse(503, 'push_backend_keys')
      if (signed === 'no') return refuse(401, 'push_token')
      // A token is made for one of the two things, which it names, and is good for that one only
      if (signed.sub !== (key ? 'key' : 'send')) return refuse(401, 'push_for_another_route')
      if (key) return json(200, { key: keys().publicKey })

      // And a token for sending is made for one body, whose hash it carries. What arrived is
      // held to it as the bytes it is, before anything is made of them: two bodies that differ
      // in a byte and read the same are not the same body.
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(await request.arrayBuffer())
      } catch {
        return refuse(400, 'push_malformed')
      }
      if (signed.h !== createHash('sha256').update(bytes).digest('hex')) return refuse(401, 'push_body_not_the_one_signed')
      let asking: { subscription?: { endpoint?: unknown; p256dh?: unknown; auth?: unknown }; payload?: unknown; ttl?: unknown } | null = null
      try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) asking = parsed
      } catch {}
      const to = asking?.subscription
      const kept = asking?.ttl === undefined ? KEPT_S : asking.ttl
      if (
        !asking ||
        !to ||
        typeof to.endpoint !== 'string' ||
        typeof to.p256dh !== 'string' ||
        typeof to.auth !== 'string' ||
        asking.payload === undefined ||
        !Number.isInteger(kept) ||
        (kept as number) < 0 ||
        (kept as number) > KEPT_MOST_S
      )
        return refuse(400, 'push_malformed')
      // Checked when the subscription was stored, and again here: this address is about to be requested
      if (to.endpoint.length > 1000 || !isPushEndpoint(to.endpoint)) return refuse(400, 'push_not_a_push_service')
      // Text is sent as it is; anything else as the JSON it is written in
      const text = typeof asking.payload === 'string' ? asking.payload : JSON.stringify(asking.payload)
      if (Buffer.byteLength(text) > TEXT_MOST) return refuse(413, 'push_too_long')

      let sealed: Sealed
      try {
        const made = webpush.generateRequestDetails({ endpoint: to.endpoint, keys: { p256dh: to.p256dh, auth: to.auth } }, text, {
          // Who a push service may write to about what this machine sends. It reaches nobody: the machine is one person's own.
          vapidDetails: { subject: 'mailto:push@it.invalid', ...keys() },
          TTL: kept as number,
          urgency: 'normal',
          contentEncoding: 'aes128gcm',
        })
        const headers: Record<string, string> = {}
        // The length is worked out again by whatever carries the request
        for (const [name, value] of Object.entries(made.headers)) if (name.toLowerCase() !== 'content-length') headers[name] = String(value)
        sealed = { endpoint: made.endpoint, headers, body: new Uint8Array(made.body as Buffer) }
      } catch {
        // The browser's keys are not keys: nothing can be sealed for them
        return refuse(400, 'push_subscription')
      }
      try {
        // The push service's own answer goes back as it is: 404 and 410 say the subscription is
        // gone for good, 401 and 403 that it was made for another key
        return json(200, { status: await carry(sealed) })
      } catch {
        return refuse(502, 'push_service_unreachable')
      }
    },
  }
}
