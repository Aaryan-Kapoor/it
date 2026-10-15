import { randomBytes } from 'node:crypto'
import { parseJson } from '@it/protocol'
import { direct } from '../lib'

interface Session {
  token: string
  session: string
  user: string
  role: string
}
interface Start {
  owner: string
  exportedAt: number
  displays: unknown[]
  pages: string[]
}
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
const reply = (status: number, error: string) => Response.json({ error }, { status, headers: HEADERS })
class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Downloads use one batch at a time and the browser's own file download, including in Firefox over plain HTTP. */
export function recordExports(site: string, api: string, doorKey: string, now = Date.now) {
  const running = new Set<AbortController>()
  const sessions = new Set<string>()
  const waiting = new Map<string, { session: string; start: Start; stop: AbortController; release: () => void; claimed: () => void; expires: number }>()
  const failed = (error: unknown) =>
    error instanceof Refused ? reply(error.status, error.message) : reply(502, 'The records could not be read. Try again shortly.')
  const ask = async (url: string, headers: HeadersInit, body: unknown, signal: AbortSignal) => {
    signal.throwIfAborted()
    const response = await direct(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    if (!response.ok) throw new Refused(response.status === 401 ? 401 : 502, 'The records could not be read. Check your pairing and try again.')
    return response.json()
  }
  const session = async (cookie: string, signal: AbortSignal): Promise<Session> => {
    const who = (await ask(
      `${site}/session/token`,
      { cookie, 'x-it-site': '1', 'x-it-door': doorKey, 'x-forwarded-proto': 'http', 'content-type': 'application/json' },
      {},
      signal,
    )) as Session
    if (who.role !== 'owner' || !who.token || !who.session || !who.user) throw new Refused(403, 'Only a browser paired as yours may download the records.')
    return who
  }
  const call = async <T>(who: Session, name: string, args: unknown, signal: AbortSignal, mutation = false): Promise<T> => {
    const result = await ask(
      `${api}/api/${mutation ? 'mutation' : 'query'}`,
      { authorization: `Bearer ${who.token}`, 'content-type': 'application/json' },
      { path: `account:${name}`, args, format: 'json' },
      signal,
    )
    if (result.status !== 'success') throw new Refused(409, 'The export could not continue. Check your pairing and try again shortly.')
    return result.value as T
  }

  return {
    async prepare(cookie: string, expected: string, signal?: AbortSignal): Promise<Response> {
      // This limit includes preparation, unclaimed links and slow downloads. Nothing grows with history length.
      if (running.size >= 8) return reply(429, 'Other exports are still running. Cancel one in Downloads or try again shortly.')
      const stop = new AbortController()
      running.add(stop)
      const abort = () => stop.abort()
      signal?.addEventListener('abort', abort, { once: true })
      let id = ''
      let ownerSession = ''
      let timer: ReturnType<typeof setTimeout> | undefined
      const release = () => {
        clearTimeout(timer)
        waiting.delete(id)
        running.delete(stop)
        if (ownerSession) sessions.delete(ownerSession)
        stop.abort()
      }
      try {
        signal?.throwIfAborted()
        const who = await session(cookie, stop.signal)
        if (who.session !== expected) throw new Refused(409, 'This browser has been paired again. Start the download again.')
        if (sessions.has(who.session)) throw new Refused(429, 'An export is already waiting or downloading. Check Downloads or try again in a minute.')
        sessions.add(who.session)
        ownerSession = who.session
        const start = await call<Start>(who, 'exportStart', {}, stop.signal, true)
        if (start.owner !== who.user) throw new Error('Export owner changed.')
        id = randomBytes(24).toString('hex')
        const expires = now() + 60_000
        timer = setTimeout(release, 60_000)
        waiting.set(id, { session: who.session, start, stop, release, claimed: () => clearTimeout(timer), expires })
        return Response.json({ download: `/session/export/${id}` }, { headers: HEADERS })
      } catch (error) {
        release()
        return failed(error)
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },

    async download(id: string, cookie: string, signal?: AbortSignal): Promise<Response> {
      const kept = waiting.get(id)
      if (!kept || kept.expires <= now()) {
        kept?.release()
        return reply(404, 'This download link has expired or was already used. Start the download again.')
      }
      // Claimed before any await, so two requests can never start the same download.
      waiting.delete(id)
      kept.claimed()
      const { stop, start, release } = kept
      const abort = () => stop.abort()
      signal?.addEventListener('abort', abort, { once: true })
      const done = () => {
        signal?.removeEventListener('abort', abort)
        release()
      }
      try {
        signal?.throwIfAborted()
        let who = await session(cookie, stop.signal)
        if (who.session !== kept.session || who.user !== start.owner) throw new Refused(403, 'Start the download from the browser that requested it.')
        let refreshed = now()
        const query = async <T>(name: string, args: unknown) => {
          if (now() - refreshed >= 240_000) {
            const next = await session(cookie, stop.signal)
            if (next.session !== who.session || next.user !== who.user) throw new Error('Export session ended.')
            who = next
            refreshed = now()
          }
          return call<T>(who, name, args, stop.signal)
        }
        const records = async function* () {
          yield `{\n"exportedAt": ${start.exportedAt},\n"displays": ${JSON.stringify(start.displays)},\n"machines": [`
          async function* list<T>(name: string, args: object, key: string, shape: (item: T) => unknown) {
            let first = true
            for (let cursor: string | null = null; ; ) {
              const batch: { [key: string]: T[] | string | null } = await query(name, { ...args, cursor })
              const items = batch[key] as T[]
              for (const item of items) {
                yield `${first ? '' : ','}\n${JSON.stringify(shape(item))}`
                first = false
              }
              if (batch.next === null) break
              cursor = batch.next as string
            }
          }
          yield* list('exportMachines', { owner: start.owner }, 'machines', (item) => item)
          yield '\n],\n"pages": ['
          let first = true
          for (const artifactId of start.pages) {
            const page = await query<{ state: string }>('exportPage', { artifactId })
            yield `${first ? '' : ','}\n${JSON.stringify({ ...page, state: parseJson(page.state) ?? {} }).slice(0, -1)},"actions": [`
            first = false
            yield* list<{ payload: string }>('exportActions', { artifactId }, 'actions', (item) => ({ ...item, payload: parseJson(item.payload) ?? null }))
            yield '\n]}'
          }
          yield '\n],\n"notifications": ['
          yield* list('exportNotifications', { owner: start.owner }, 'notifications', (item) => item)
          yield '\n],\n"complete": true\n}\n'
        }
        const iterator = records()
        const encoder = new TextEncoder()
        let pending: Promise<IteratorResult<string, void>> | undefined
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                stop.signal.throwIfAborted()
                pending ??= iterator.next()
                let timer: ReturnType<typeof setTimeout> | undefined
                const next = await Promise.race([
                  pending,
                  new Promise<null>((resolve) => {
                    timer = setTimeout(() => resolve(null), 1_000)
                  }),
                ]).finally(() => clearTimeout(timer))
                if (next === null) {
                  // Whitespace keeps a stalled query's download responsive to cancellation in browsers
                  // that do not report it until more bytes arrive. Each yielded record is whole JSON.
                  stop.signal.throwIfAborted()
                  controller.enqueue(encoder.encode('\n'))
                  return
                }
                pending = undefined
                stop.signal.throwIfAborted()
                if (next.done) {
                  controller.close()
                  done()
                } else controller.enqueue(encoder.encode(next.value))
              } catch (error) {
                // An interrupted response is never closed successfully, nor given a complete marker.
                controller.error(error)
                done()
                void iterator.return(undefined)
              }
            },
            cancel() {
              done()
              void iterator.return(undefined)
            },
          },
          { highWaterMark: 0 },
        )
        return new Response(body, {
          headers: {
            ...HEADERS,
            'content-type': 'application/json',
            'content-disposition': `attachment; filename="it-export-${new Date(start.exportedAt).toISOString().slice(0, 10)}.json"`,
          },
        })
      } catch (error) {
        done()
        return failed(error)
      }
    },
    close() {
      for (const value of waiting.values()) value.release()
      for (const stop of running) stop.abort()
    },
  }
}
