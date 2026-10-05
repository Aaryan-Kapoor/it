// Sending notifications, with a stand-in for the backend's public keys and one for the push
// service. The tokens are made here the way the backend makes them, and what is sealed for a
// browser is opened again here the way a browser opens it, with the browser's own keys.
//
// Nothing here depends on which runtime runs it: `bun test packages/cli/push.test.ts` runs the
// same tests as the standalone program would.
import { createDecipheriv, createECDH, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { onThisMachine } from '@it/protocol'
import { exportJWK, generateKeyPair, importJWK, type JWK, jwtVerify, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { carryOut, createPush, keysFile, type Push, type Sealed } from './src/serve/push'

type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

// ---------- the backend's keys, and tokens as it makes them ----------

let backendSite = ''
let backendKey: Key
let strangersKey: Key
const keys = http.createServer((req, res) => {
  if (req.url !== '/.well-known/jwks.json') return void res.writeHead(404).end()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ keys: published }))
})
let published: JWK[] = []

interface Made {
  key?: Key
  kid?: string
  audience?: string
  issuer?: string
  seconds?: number
  issuedAt?: number
  /** Which of the two things it is for. Null leaves the token naming neither. */
  subject?: string | null
  /** The body it is for, when it is for sending. */
  body?: string
}
const hashOf = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex')
/**
 * A token as the backend makes one for this: its own key, its own address as issuer, the
 * audience "it-push", a minute, the thing it is for as its subject, and for sending, the hash of
 * the body it goes with.
 */
function token(o: Made = {}): Promise<string> {
  const from = o.issuedAt ?? Math.floor(Date.now() / 1000)
  const made = new SignJWT(o.body === undefined ? {} : { h: hashOf(o.body) })
    .setProtectedHeader({ alg: 'ES256', kid: o.kid ?? 'it-test', typ: 'JWT' })
    .setIssuer(o.issuer ?? backendSite)
    .setAudience(o.audience ?? 'it-push')
    .setJti(randomBytes(8).toString('hex'))
    .setIssuedAt(from)
    .setExpirationTime(from + (o.seconds ?? 60))
  const subject = o.subject === undefined ? (o.body === undefined ? 'key' : 'send') : o.subject
  return (subject === null ? made : made.setSubject(subject)).sign(o.key ?? backendKey)
}

// ---------- a browser, and the push service ----------

/** A browser's subscription: the keys it made for itself, and where its push service takes messages for it. */
function browser() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    ecdh,
    auth,
    subscription: {
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('hex')}`,
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    },
  }
}
/** Opens what was sealed for a browser, as the browser does: the text that was sent. */
function opened(sealed: Sealed, to: ReturnType<typeof browser>): string {
  const body = Buffer.from(sealed.body)
  const salt = body.subarray(0, 16)
  const senders = body.subarray(21, 21 + body[20]!)
  const secret = to.ecdh.computeSecret(senders)
  const material = Buffer.from(hkdfSync('sha256', secret, to.auth, Buffer.concat([Buffer.from('WebPush: info\0'), to.ecdh.getPublicKey(), senders]), 32))
  const key = Buffer.from(hkdfSync('sha256', material, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', material, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const sealedText = body.subarray(21 + senders.length)
  const decipher = createDecipheriv('aes-128-gcm', key, nonce)
  decipher.setAuthTag(sealedText.subarray(sealedText.length - 16))
  const text = Buffer.concat([decipher.update(sealedText.subarray(0, sealedText.length - 16)), decipher.final()])
  // The text ends at the last 2: what follows it is padding
  return text.subarray(0, text.lastIndexOf(2)).toString('utf8')
}

/** The push service: it keeps what it was brought, and answers with the status the test has it give. */
const service = {
  brought: [] as Sealed[],
  status: 201 as number | Error,
  carry: async (sealed: Sealed) => {
    service.brought.push(sealed)
    if (service.status instanceof Error) throw service.status
    return service.status
  },
}

let home = ''
const before = { ...process.env }
/** Every refusal's code, as the log would be given it. */
const refused: string[] = []
let push: Push
const here = { address: '127.0.0.1' }

/** A request as the backend makes it: with a token for what is asked, and for the very body sent, unless the test gives another. */
const asking = async (body: unknown, o: { token?: string | null; method?: string; path?: string } = {}) => {
  const text = (o.method ?? 'POST') === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  return new Request(`http://127.0.0.1:20000${o.path ?? '/internal/push'}`, {
    method: o.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? (await token({ body: text }))}` }) },
    body: text,
  })
}
const forKey = (o: { token?: string | null } = {}) => asking(undefined, { ...o, method: 'GET', path: '/internal/push/key' })

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'it-push-'))
  process.env.IT_HOME = home
  backendKey = (await generateKeyPair('ES256', { extractable: true })).privateKey
  strangersKey = (await generateKeyPair('ES256', { extractable: true })).privateKey
  const { d: _private, ...publicPart } = await exportJWK(backendKey)
  published = [{ ...publicPart, kid: 'it-test', alg: 'ES256', use: 'sig' }]
  await new Promise<void>((resolve) => keys.listen(0, '127.0.0.1', resolve))
  backendSite = `http://127.0.0.1:${(keys.address() as net.AddressInfo).port}`
  push = createPush({ backendSite, carry: service.carry, refused: (code) => refused.push(code) })
})
afterAll(async () => {
  keys.closeAllConnections?.()
  await new Promise((resolve) => keys.close(resolve))
  rmSync(home, { recursive: true, force: true })
  for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]
  Object.assign(process.env, before)
})
afterEach(() => {
  service.brought.length = 0
  service.status = 201
  refused.length = 0
})

describe('Who may ask for a notification to be sent', () => {
  test('A request that does not carry a token of the backend’s own for this is refused, and nothing is sent', async () => {
    const to = browser()
    const body = JSON.stringify({ subscription: to.subscription, payload: 'hello', ttl: 60 })
    const now = Math.floor(Date.now() / 1000)
    // Each is right in everything but the one thing that is said of it
    const others: [string, null | ((made: Made) => Promise<string> | string)][] = [
      ['none at all', null],
      ['not a token', () => 'not.a.token'],
      ['signed with another key', (made) => token({ ...made, key: strangersKey })],
      ['made for the content package', (made) => token({ ...made, audience: 'it-control' })],
      ['made for a machine', (made) => token({ ...made, audience: 'it-machine' })],
      ['made by another issuer', (made) => token({ ...made, issuer: 'http://127.0.0.1:1' })],
      ['run out', (made) => token({ ...made, issuedAt: now - 300 })],
      ['made to last an hour', (made) => token({ ...made, seconds: 3600 })],
    ]
    for (const [which, carried] of others) {
      expect([which, (await push.answer(await asking(body, { token: carried && (await carried({ body })) }), here)).status]).toEqual([which, 401])
      expect([which, (await push.answer(await forKey({ token: carried && (await carried({})) }), here)).status]).toEqual([which, 401])
    }
    expect(service.brought).toEqual([])
    expect(new Set(refused)).toEqual(new Set(['push_token']))
  })

  test('A token is good for the one thing it names: one for the key sends nothing, and one for sending is given no key', async () => {
    const body = JSON.stringify({ subscription: browser().subscription, payload: 'hello', ttl: 60 })
    const others: [string, string | null][] = [
      ['made for the other of the two', 'key'],
      ['made for neither', 'push'],
      ['naming nothing', null],
    ]
    for (const [which, subject] of others) {
      // Its hash is the body's own, so that only what it is for is wrong with it
      const answer = await push.answer(await asking(body, { token: await token({ body, subject }) }), here)
      expect([which, answer.status, await answer.json()]).toEqual([which, 401, { error: 'push_for_another_route' }])
    }
    for (const subject of ['send', 'push', null]) {
      const answer = await push.answer(await forKey({ token: await token({ subject }) }), here)
      expect([subject, answer.status, await answer.json()]).toEqual([subject, 401, { error: 'push_for_another_route' }])
    }
    // One made for sending carries a body's hash, and is no more a token for the key for that
    expect((await push.answer(await forKey({ token: await token({ body }) }), here)).status).toBe(401)
    expect(service.brought).toEqual([])
    expect(new Set(refused)).toEqual(new Set(['push_for_another_route']))
  })

  test('A token for sending is good for the body it was made for, byte for byte, and for no other', async () => {
    const to = browser()
    const signed = JSON.stringify({ subscription: to.subscription, payload: 'hello', ttl: 60 })
    const others: [string, string, string][] = [
      ['another notification', JSON.stringify({ subscription: to.subscription, payload: 'something else', ttl: 60 }), await token({ body: signed })],
      ['another browser', JSON.stringify({ subscription: browser().subscription, payload: 'hello', ttl: 60 }), await token({ body: signed })],
      // The same when it is read, and not the same bytes
      ['a space more', `${signed} `, await token({ body: signed })],
      ['its fields in another order', JSON.stringify({ ttl: 60, payload: 'hello', subscription: to.subscription }), await token({ body: signed })],
      ['nothing at all', '', await token({ body: signed })],
      ['a token that names no body', signed, await token({ subject: 'send' })],
    ]
    for (const [which, body, carried] of others) {
      const answer = await push.answer(await asking(body, { token: carried }), here)
      expect([which, answer.status, await answer.json()]).toEqual([which, 401, { error: 'push_body_not_the_one_signed' }])
    }
    expect(service.brought).toEqual([])
    expect(new Set(refused)).toEqual(new Set(['push_body_not_the_one_signed']))
    // The hash is of the bytes, whatever they are: text that is more than one byte a letter is sent, and read, as it was signed
    const wide = JSON.stringify({ subscription: to.subscription, payload: 'é ü 漢', ttl: 60 })
    expect((await push.answer(await asking(wide, { token: await token({ body: wide }) }), here)).status).toBe(200)
    expect(opened(service.brought[0]!, to)).toBe('é ü 漢')
  })

  test('A caller that is not on this machine is refused, whatever it carries', async () => {
    const body = { subscription: browser().subscription, payload: 'hello', ttl: 60 }
    const elsewhere = [
      '192.168.7.20',
      '10.0.0.5',
      '203.0.113.9',
      'fe80::1',
      '2001:db8::7',
      '128.0.0.1',
      '1127.0.0.1',
      '127.0.0.1.evil',
      '',
      '::ffff:10.0.0.5',
      '::ffff:127.0.0.1.evil',
      '::fffe:127.0.0.1',
      '::2',
    ]
    for (const address of elsewhere) {
      expect([address, onThisMachine(address)]).toEqual([address, false])
      expect([address, (await push.answer(await asking(body), { address })).status]).toEqual([address, 403])
      expect([address, (await push.answer(await forKey(), { address })).status]).toEqual([address, 403])
    }
    // This machine's own address in either family, and the first of them as it is written when it arrives over the other
    for (const address of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '::ffff:127.8.9.10'])
      expect([address, onThisMachine(address)]).toEqual([address, true])
    expect(service.brought).toEqual([])
  })

  test('When the backend’s keys cannot be read, the caller is told to ask again and not that its token is bad', async () => {
    const lonely = createPush({ backendSite: 'http://127.0.0.1:9', carry: service.carry, refused: (code) => refused.push(code) })
    const body = JSON.stringify({ subscription: browser().subscription, payload: 'hello' })
    const answer = await lonely.answer(await asking(body, { token: await token({ body, issuer: 'http://127.0.0.1:9' }) }), here)
    expect(answer.status).toBe(503)
    expect(service.brought).toEqual([])
    expect(refused).toEqual(['push_backend_keys'])
  })
})

describe('Sending a notification', () => {
  test('One that carries the backend’s token is sealed for the browser, signed with this machine’s key and taken to the push service, whose status is passed back', async () => {
    const to = browser()
    const text = JSON.stringify({ title: 'It', body: 'Dinner is ready', url: 'http://localhost/p/dinner', id: 'n1' })
    const answer = await push.answer(await asking({ subscription: to.subscription, payload: text, ttl: 90 }), here)
    expect([answer.status, await answer.json()]).toEqual([200, { status: 201 }])
    expect(answer.headers.get('cache-control')).toBe('no-store')

    expect(service.brought).toHaveLength(1)
    const sealed = service.brought[0]!
    expect(sealed.endpoint).toBe(to.subscription.endpoint)
    expect(sealed.headers).toMatchObject({ TTL: '90', 'Content-Encoding': 'aes128gcm', Urgency: 'normal' })
    // Only the browser can read it, and it reads exactly what was sent
    expect(Buffer.from(sealed.body).toString('latin1')).not.toContain('Dinner')
    expect(opened(sealed, to)).toBe(text)

    // It is signed with the key the site was given to subscribe with, for that push service and no other
    const { key } = (await (await push.answer(await forKey(), here)).json()) as { key: string }
    const [, signed, signer] = /^vapid t=([^,]+), k=(.+)$/.exec(sealed.headers.Authorization ?? '') ?? []
    expect(signer).toBe(key)
    const point = Buffer.from(key, 'base64url')
    const publicKey = await importJWK(
      { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
      'ES256',
    )
    const { payload } = await jwtVerify(signed!, publicKey, { audience: 'https://fcm.googleapis.com' })
    expect(payload.sub).toMatch(/^mailto:/)
  })

  test('Whatever the push service answers is what the backend is told, a subscription that is gone included', async () => {
    const to = browser()
    for (const status of [201, 404, 410, 401, 403, 429, 500]) {
      service.status = status
      const answer = await push.answer(await asking({ subscription: to.subscription, payload: 'hello', ttl: 0 }), here)
      expect([status, answer.status, await answer.json()]).toEqual([status, 200, { status }])
    }
    expect(service.brought.map((sealed) => sealed.headers.TTL)).toEqual(Array(7).fill('0'))
  })

  test('What is to be shown may be given as text or as what the text says, and how long it is kept is an hour when nothing is said', async () => {
    const to = browser()
    await push.answer(await asking({ subscription: to.subscription, payload: { title: 'It', body: 'é ü 漢' } }), here)
    expect(JSON.parse(opened(service.brought[0]!, to))).toEqual({ title: 'It', body: 'é ü 漢' })
    expect(service.brought[0]!.headers.TTL).toBe('3600')
  })

  test('A push service that cannot be reached is said as that, and never as a status it did not give', async () => {
    service.status = new Error('getaddrinfo ENOTFOUND fcm.googleapis.com')
    const answer = await push.answer(await asking({ subscription: browser().subscription, payload: 'hello' }), here)
    expect([answer.status, await answer.json()]).toEqual([502, { error: 'push_service_unreachable' }])
  })

  test('What cannot be sent is refused for what is wrong with it, and nothing is taken anywhere', async () => {
    const to = browser()
    const good = { subscription: to.subscription, payload: 'hello', ttl: 60 }
    const wrong: [string, unknown, number][] = [
      ['not JSON', '{', 400],
      ['a list', [good], 400],
      ['no subscription', { payload: 'hello' }, 400],
      ['no payload', { subscription: to.subscription }, 400],
      ['a subscription with a key missing', { ...good, subscription: { endpoint: to.subscription.endpoint, auth: to.subscription.auth } }, 400],
      ['kept for less than no time', { ...good, ttl: -1 }, 400],
      ['kept for longer than a push service keeps anything', { ...good, ttl: 2_419_201 }, 400],
      ['kept for a time that is not a number of seconds', { ...good, ttl: '60' }, 400],
      // Only a real push service is ever requested: the door is not a way to reach any address someone names
      ['an address that is no push service', { ...good, subscription: { ...to.subscription, endpoint: 'https://evil.example/push' } }, 400],
      ['an address on this machine', { ...good, subscription: { ...to.subscription, endpoint: 'http://127.0.0.1:20000/control/delete' } }, 400],
      ['a push service reached plainly', { ...good, subscription: { ...to.subscription, endpoint: 'http://fcm.googleapis.com/fcm/send/x' } }, 400],
      ['keys that are not a browser’s', { ...good, subscription: { ...to.subscription, p256dh: 'AAAA', auth: 'AAAA' } }, 400],
      ['more text than a notification carries', { ...good, payload: 'x'.repeat(3001) }, 413],
    ]
    for (const [which, body, status] of wrong) expect([which, (await push.answer(await asking(body), here)).status]).toEqual([which, status])
    expect(service.brought).toEqual([])
    // Only these two things are answered at all, each by its own method
    expect((await push.answer(await asking(good, { path: '/internal/push/other' }), here)).status).toBe(404)
    expect((await push.answer(await asking(good, { path: '/internal/push/key' }), here)).status).toBe(404)
    expect((await push.answer(await asking(undefined, { method: 'GET', path: '/internal/push' }), here)).status).toBe(404)
    expect(service.brought).toEqual([])
  })

  test('Nothing of a notification is given to the log: a refusal is a code and nothing else', async () => {
    const to = browser()
    await push.answer(await asking({ subscription: { ...to.subscription, endpoint: 'https://evil.example/secret-endpoint' }, payload: 'secret-text' }), here)
    await push.answer(await asking({ subscription: to.subscription, payload: 'secret-text'.repeat(400) }), here)
    await push.answer(await asking({ subscription: to.subscription, payload: 'secret-text' }, { token: 'secret-token' }), here)
    service.status = new Error('secret-endpoint could not be reached')
    await push.answer(await asking({ subscription: to.subscription, payload: 'secret-text' }), here)
    expect(refused).toEqual(['push_not_a_push_service', 'push_too_long', 'push_token', 'push_service_unreachable'])
  })
})

describe('Taking a sealed request to its push service', () => {
  /** A stand-in for a push service on this machine, and for wherever it might send a request on to. Each keeps what it was brought. */
  const stood = async (answer: (req: http.IncomingMessage, res: http.ServerResponse) => void) => {
    const brought: { method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = []
    const server = http.createServer((req, res) => {
      const pieces: Buffer[] = []
      req
        .on('data', (piece: Buffer) => pieces.push(piece))
        .on('end', () => {
          brought.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(pieces) })
          answer(req, res)
        })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      at: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
      brought,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        }),
    }
  }
  const sealed = (endpoint: string): Sealed => ({ endpoint, headers: { TTL: '60', 'Content-Encoding': 'aes128gcm' }, body: new Uint8Array([1, 2, 3, 250]) })

  test('It is posted as it was sealed, and the push service’s own status is what comes back', async () => {
    const service = await stood((_req, res) => void res.writeHead(201).end('Created'))
    try {
      expect(await carryOut(sealed(`${service.at}/send/abc`))).toBe(201)
      expect(service.brought).toHaveLength(1)
      expect(service.brought[0]).toMatchObject({ method: 'POST', path: '/send/abc', headers: { ttl: '60', 'content-encoding': 'aes128gcm' } })
      expect([...service.brought[0]!.body]).toEqual([1, 2, 3, 250])
    } finally {
      await service.close()
    }
    for (const status of [404, 410, 429, 500]) {
      const refusing = await stood((_req, res) => void res.writeHead(status).end())
      try {
        expect(await carryOut(sealed(`${refusing.at}/send/abc`))).toBe(status)
      } finally {
        await refusing.close()
      }
    }
  })

  test('A push service that sends the request on elsewhere is not followed: nothing is brought to where it points, and it counts as not reached', async () => {
    const elsewhere = await stood((_req, res) => void res.writeHead(201).end())
    for (const status of [301, 302, 303, 307, 308]) {
      const redirecting = await stood((_req, res) => void res.writeHead(status, { location: `${elsewhere.at}/taken` }).end())
      try {
        await expect(carryOut(sealed(`${redirecting.at}/send/abc`))).rejects.toThrow()
        expect([status, redirecting.brought.length, elsewhere.brought]).toEqual([status, 1, []])
      } finally {
        await redirecting.close()
      }
    }
    await elsewhere.close()
    // And asked through the door's own part, such a service is said to be unreachable, never with a status it did not give
    const through = createPush({ backendSite, carry: () => carryOut(sealed('http://127.0.0.1:9/nothing-listens')), refused: (code) => refused.push(code) })
    const answer = await through.answer(await asking({ subscription: browser().subscription, payload: 'hello' }), here)
    expect([answer.status, await answer.json()]).toEqual([502, { error: 'push_service_unreachable' }])
  })
})

describe('This machine’s keys for notifications', () => {
  test('The key a browser subscribes with is answered to the backend, and is the same one every time and after a restart', async () => {
    const first = await push.answer(await forKey(), here)
    expect(first.status).toBe(200)
    const { key } = (await first.json()) as { key: string }
    // A point on the curve, as a browser takes it
    expect(Buffer.from(key, 'base64url')).toHaveLength(65)
    expect(((await (await push.answer(await forKey(), here)).json()) as { key: string }).key).toBe(key)
    const restarted = createPush({ backendSite, carry: service.carry })
    expect(((await (await restarted.answer(await forKey(), here)).json()) as { key: string }).key).toBe(key)
    // And it is the key notifications are signed with
    await restarted.answer(await asking({ subscription: browser().subscription, payload: 'hello' }), here)
    expect(service.brought[0]!.headers.Authorization).toContain(`k=${key}`)
  })

  test('The keys are kept in It’s folder, in a file only this user can read', async () => {
    await push.answer(await forKey(), here)
    expect(keysFile()).toBe(path.join(home, 'push.json'))
    const kept = JSON.parse(readFileSync(keysFile(), 'utf8')) as { publicKey: string; privateKey: string }
    expect(Buffer.from(kept.privateKey, 'base64url')).toHaveLength(32)
    // Windows takes no such word from a program: there the file is as private as the folder it is in
    if (process.platform !== 'win32') expect(statSync(keysFile()).mode & 0o777).toBe(0o600)
  })

  test('A keys file that cannot be read as keys is replaced by new ones, kept the same way', async () => {
    const { key: was } = (await (await push.answer(await forKey(), here)).json()) as { key: string }
    writeFileSync(keysFile(), '{"publicKey": 7}')
    const { key } = (await (await push.answer(await forKey(), here)).json()) as { key: string }
    expect(key).not.toBe(was)
    expect(Buffer.from(key, 'base64url')).toHaveLength(65)
    if (process.platform !== 'win32') expect(statSync(keysFile()).mode & 0o777).toBe(0o600)
  })
})
