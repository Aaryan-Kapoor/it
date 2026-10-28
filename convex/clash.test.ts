// @vitest-environment node
// Many callers at once, against the real backend program. What is counted against a person is
// kept in one record for all of their tabs, browsers and machines, and a display, a session and
// a showing are each one record too. Of the callers that would write the same record at the
// same moment the backend program lets one through and gives up on the others, and a function
// that an action or a route runs is then for the action or the route to ask again
// (lib/clash.ts). So every caller is to be answered: with what it asked for, or with a refusal
// that says why. The stand-in backend the other tests here run on never gives up on a write,
// which is why these start the program itself, in a folder and on ports of their own.
// With them is one thing more that only the program itself can show: how it orders a field
// that a record does not have, which the order of clicks and stops leans on (actions.ts).
// The 120 calls run in bursts of 40 because the backend program admits 64 concurrent actions
// and answers with an uncoded error beyond that limit. Each burst still exceeds the largest
// allowance of 30, so callers contend for the same record without exhausting action capacity.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { backendLeftOn, isBackendOn } from '../e2e/lib.mjs'
import { backendAt } from '../packages/cli/src/lib'
import { RELEASE } from '../packages/cli/src/serve/config'
import { bases } from '../packages/cli/test-ports'

const here = path.dirname(fileURLToPath(import.meta.url))
/** The program as `npm run generate` builds it, with these functions in it. */
const it = path.join(here, '../packages/cli/dist/it.mjs')
/** The backend program on this machine: the one IT_BACKEND_BIN names, or the one the `convex` package keeps. */
const program = [process.env.IT_BACKEND_BIN, path.join(os.homedir(), '.cache/convex/binaries', RELEASE, 'convex-local-backend')].find(
  (file): file is string => Boolean(file) && existsSync(file!),
)

/**
 * The base port everything is counted from: one of this file's own blocks, held for as long as
 * the service that is started on it runs, so that no other run of the tests takes the same one.
 */
const ports = bases(29_200, 20)
const until = async (what: () => boolean | Promise<boolean>, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await what()) return true
  return false
}
/** How many of each answer there were. */
const tally = (answers: (string | number)[]) => {
  const count: Record<string, number> = {}
  for (const a of answers) count[a] = (count[a] ?? 0) + 1
  return count
}

// Left out where the backend program is not on this machine, and on Windows, where the service is not run as a program by these tests
if (!program) console.log('  skip  the tests of many callers at once: the backend program is not on this machine, and IT_BACKEND_BIN names none')
else if (process.platform === 'win32')
  console.log('  skip  the tests of many callers at once: they run the service as a program, which these tests do not do on Windows')
describe.skipIf(!program || process.platform === 'win32')('many callers at once, against the real backend program', () => {
  let folder: string
  let origin: string
  let service: ChildProcess | undefined
  const env = () => ({
    PATH: path.join(folder, 'commands'),
    HOME: folder,
    IT_HOME: path.join(folder, 'it'),
    IT_PORT: new URL(origin).port,
    IT_BACKEND_BIN: program!,
    IT_TELEMETRY_ENABLED: 'false',
    IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
    IT_HARNESSES: 'none',
  })
  /** Runs the program to its end, and gives what it printed where it ended well. */
  const ran = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [it, ...args], { cwd: folder, env: env(), stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout!.on('data', (piece: Buffer) => (out += piece))
      child.once('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`it ${args[0]} ended with ${code}`))))
    })

  beforeAll(async () => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-clash-'))
    mkdirSync(path.join(folder, 'commands'))
    symlinkSync(process.execPath, path.join(folder, 'commands', 'node'))
    origin = `http://127.0.0.1:${await ports.next()}`
    await ran(['setup', '--none', '--no-service'])
    service = spawn(process.execPath, [it, 'serve', '--log', path.join(folder, 'service.log')], { cwd: folder, env: env(), stdio: 'ignore' })
    const log = () => (existsSync(path.join(folder, 'service.log')) ? readFileSync(path.join(folder, 'service.log'), 'utf8') : '')
    // Where it does not start, what it wrote down says why
    expect([await until(() => /^\S+ connector \S+ started/m.test(log()), 90_000), log()]).toEqual([true, expect.any(String)])
  }, 120_000)
  /** Sign-outs also start background work that calls back through the door. */
  const workFinished = async () => {
    const { adminKey } = JSON.parse(readFileSync(path.join(folder, 'it/service.json'), 'utf8')) as { adminKey: string }
    const { api } = backendAt(Number(new URL(origin).port))
    const signal = AbortSignal.timeout(10_000)
    const rows = async (table: string) => {
      const response = await fetch(`${api}/api/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Convex ${adminKey}` },
        body: JSON.stringify({
          path: '_system/cli/tableData',
          args: { table, order: 'desc', paginationOpts: { numItems: 100, cursor: null } },
          format: 'json',
        }),
        signal,
      })
      const result = (await response.json()) as { status: string; value: { isDone: boolean; page: { state?: { kind: string } }[] } }
      if (result.status !== 'success' || !result.value.isDone) throw new Error('the background work could not be read in full')
      return result.value.page
    }
    // Seeing an empty job table alone is not enough: the action deleting its job can still
    // be running. Wait for both while the door and backend can still answer each other.
    return await until(async () => {
      if ((await rows('contentJobs')).length) return false
      return (await rows('_scheduled_functions')).every((row) => row.state?.kind !== 'pending' && row.state?.kind !== 'inProgress')
    }, 10_000)
  }
  afterAll(async () => {
    let drained = true
    let left: number | undefined
    let stuck: string | undefined
    try {
      if (service && service.exitCode === null && service.signalCode === null) {
        try {
          drained = await workFinished()
        } finally {
          const gone = new Promise<true>((resolve) => service!.once('exit', () => resolve(true)))
          service.kill('SIGTERM')
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            if (
              !(await Promise.race([
                gone,
                new Promise<false>((resolve) => {
                  timer = setTimeout(() => resolve(false), 45_000)
                }),
              ]))
            ) {
              stuck = readFileSync(path.join(folder, 'service.log'), 'utf8').trimEnd().split('\n').slice(-12).join('\n')
              service.kill('SIGKILL')
              await gone
            }
          } finally {
            clearTimeout(timer)
          }
        }
      }
    } finally {
      if (folder) {
        const home = path.join(folder, 'it')
        left = backendLeftOn(home)
        // A failed stop must not leave this test's detached backend running, or remove its
        // database while it is still using it. Check the folder as well as the process number.
        if (left !== undefined) {
          process.kill(left, 'SIGKILL')
          await until(() => !isBackendOn(home, left), 2000)
        }
        if (backendLeftOn(home) === undefined) rmSync(folder, { recursive: true, force: true })
      }
      await ports.release()
    }
    expect(left, 'the service left its backend running').toBeUndefined()
    expect(drained, 'the sign-out work had not finished before the service was stopped').toBe(true)
    expect(stuck, 'the service had not stopped 45 seconds after it was asked to').toBeUndefined()
  }, 60_000)

  /** What the site sends with everything it asks of the session's routes. */
  const site = () => ({ origin, 'x-it-site': '1', 'content-type': 'application/json' })
  /** A browser paired as the owner's, registered as a display, and one function of the backend's called as it. */
  async function paired() {
    const code = new URL((JSON.parse(await ran(['site', '--no-open', '--json'])) as { url: string }).url).hash.slice(1)
    const redeemed = await fetch(`${origin}/session/redeem`, { method: 'POST', headers: site(), body: JSON.stringify({ code }) })
    expect(redeemed.status).toBe(200)
    const cookie = redeemed.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
    const told = (await (await fetch(`${origin}/session/token`, { method: 'POST', headers: { ...site(), cookie } })).json()) as {
      token: string
      session: string
    }
    /** Answers with what the function gave, or with the code of its refusal, or with `no code` where it failed and said nothing. */
    const asks = async (kind: 'mutation' | 'action', fn: string, args: Record<string, unknown>) => {
      const r = await fetch(`${origin}/api/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${told.token}` },
        body: JSON.stringify({ path: fn, args, format: 'json' }),
      })
      const said = (await r.json()) as { status: string; value?: unknown; errorData?: { code?: string } }
      return said.status === 'success' ? { value: said.value } : { refused: said.errorData?.code ?? 'no code' }
    }
    const key = crypto.randomUUID()
    expect(await asks('mutation', 'displays:register', { key, userAgent: 'a test' })).toHaveProperty('value')
    return { cookie, session: told.session, key, asks }
  }
  const outcome = (said: { value: unknown } | { refused: string }) => ('refused' in said ? said.refused : 'answered')
  /** Forty callers exceed the largest allowance of thirty, but fit within the backend's 64-action limit. Every call is made once. */
  const bursts = async <T>(count: number, call: () => Promise<T>): Promise<T[]> => {
    const answers: T[] = []
    while (answers.length < count) answers.push(...(await Promise.all(Array.from({ length: Math.min(40, count - answers.length) }, call))))
    return answers
  }

  test('every tab that fetches the token its display signs out with is given one, or told it has asked too often', async () => {
    const browser = await paired()
    const answers = await bursts(120, () => browser.asks('action', 'displays:signOutToken', { key: browser.key }).then(outcome))
    const { answered, rate_limited, ...other } = tally(answers)
    expect(other).toEqual({})
    // As many as the limit lets through at once, and no fewer for having asked together
    expect([answered! >= 30, answered! + rate_limited!]).toEqual([true, 120])
  }, 120_000)

  test('every tab that asks for the key notifications are subscribed with is given it, or told it has asked too often', async () => {
    const browser = await paired()
    const answers = await bursts(120, () => browser.asks('action', 'push:publicKey', {}).then(outcome))
    const { answered, rate_limited, ...other } = tally(answers)
    expect(other).toEqual({})
    expect([answered! >= 10, answered! + rate_limited!]).toEqual([true, 120])
  }, 120_000)

  test('every tab that presents a display’s sign-out token is told it was taken, and the display is signed out once', async () => {
    const browser = await paired()
    // The person's tabs have just asked for as many of these as may be had at once, so this one is waited for
    let given: { value?: unknown; refused?: string } = {}
    expect(
      await until(async () => {
        given = await browser.asks('action', 'displays:signOutToken', { key: browser.key })
        return given.value !== undefined
      }, 30_000),
    ).toBe(true)
    const { token: presented, raisesTo } = given.value as { token: string; raisesTo: number }
    const answers = await Promise.all(
      Array.from({ length: 60 }, () =>
        fetch(`${origin}/display/signout`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: presented }),
        }).then(async (r) => {
          await r.arrayBuffer()
          return r.status
        }),
      ),
    )
    expect(tally(answers)).toEqual({ 200: 60 })
    expect(await browser.asks('mutation', 'displays:register', { key: browser.key, userAgent: 'a test' })).toMatchObject({ value: { id: expect.any(String) } })
    const mine = (await fetch(`${origin}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token(browser.cookie)}` },
      body: JSON.stringify({ path: 'displays:mine', args: { key: browser.key }, format: 'json' }),
    }).then((r) => r.json())) as { value: { epoch: number } }
    expect(mine.value.epoch).toBe(raisesTo)
  }, 120_000)

  test('every tab that ends the browser’s session is answered: one that it ended, and the rest that it is over', async () => {
    const browser = await paired()
    const answers = await Promise.all(
      Array.from({ length: 60 }, () =>
        fetch(`${origin}/session/end`, {
          method: 'POST',
          headers: { ...site(), cookie: browser.cookie },
          body: JSON.stringify({ session: browser.session }),
        }).then(async (r) => {
          await r.arrayBuffer()
          return r.status
        }),
      ),
    )
    expect(tally(answers)).toEqual({ 200: 1, 401: 59 })
  }, 120_000)

  test('a committed publication whose replies are lost is recovered without uploading or replacing a newer version', async () => {
    let lost = 3
    let uploads = 0
    const calls: string[] = []
    const proxy = createServer(async (req, res) => {
      try {
        const pieces: Buffer[] = []
        for await (const piece of req) pieces.push(Buffer.from(piece))
        const body = Buffer.concat(pieces)
        const fn = req.url === '/api/action' ? (JSON.parse(body.toString()) as { path: string }).path : ''
        if (fn) calls.push(fn)
        if (req.url?.startsWith('/upload/')) uploads++
        const answer = await fetch(`${origin}${req.url}`, {
          method: req.method,
          headers: {
            ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
            ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
            ...(req.headers['x-it-sha256'] ? { 'x-it-sha256': String(req.headers['x-it-sha256']) } : {}),
          },
          ...(body.length ? { body } : {}),
        })
        let data = Buffer.from(await answer.arrayBuffer())
        if (fn === 'publish:begin' || fn === 'publish:resume') {
          const said = JSON.parse(data.toString())
          if (said.status === 'success') {
            said.value.upload.url = `${address}/upload/`
            data = Buffer.from(JSON.stringify(said))
          }
        }
        // The real backend has answered after committing. Only the caller's reply is lost.
        if (fn === 'publish:finish' && lost-- > 0) return res.destroy()
        res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' })
        res.end(data)
      } catch {
        res.destroy()
      }
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const address = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
    const command = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [it, ...args], {
          cwd: folder,
          env: { ...env(), IT_URL: address, IT_SITE_URL: backendAt(Number(new URL(origin).port)).site },
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        let out = ''
        child.stdout!.on('data', (piece: Buffer) => (out += piece))
        child.once('exit', (code) => resolve({ code, out }))
      })
    try {
      const args = ['create', 'Lost completion', '--id', 'lost-completion', '--html', '<p>Original</p>']
      expect((await command(args)).code).toBe(1)
      expect([calls.filter((p) => p === 'publish:begin').length, calls.filter((p) => p === 'publish:finish').length, uploads]).toEqual([1, 3, 1])
      expect(JSON.parse(await ran(['update', 'lost-completion', '--html', '<p>Newer</p>'])).version).toBe(2)
      const recovered = await command(args)
      expect(recovered.code).toBe(0)
      expect(JSON.parse(recovered.out).version).toBe(1)
      expect([calls.filter((p) => p === 'publish:begin').length, calls.filter((p) => p === 'publish:resume').length, uploads]).toEqual([1, 1, 1])
      expect(JSON.parse(await ran(['read', 'lost-completion'])).version).toBe(2)
    } finally {
      proxy.closeAllConnections()
      await new Promise<void>((resolve, reject) => proxy.close((err) => (err ? reject(err) : resolve())))
    }
  }, 120_000)

  /** A token for the session a cookie is. */
  const token = async (cookie: string) =>
    ((await (await fetch(`${origin}/session/token`, { method: 'POST', headers: { ...site(), cookie } })).json()) as { token: string }).token

  /**
   * The backend program's own ordering of a field a record does not have, which the order of
   * clicks and stops leans on: a click or a setting aside from before these had a number has
   * none, and a range up to a number is to take it in, as Convex says it orders a missing field
   * below every number. The stand-in backend the other tests run on orders it so too; this asks
   * the program itself. Such records are written as a backup would bring them back, by the
   * backend program's own way of adding records, since no function of It's writes one any more.
   */
  test('a numbered stop drops the clicks that have no number, and a numbered return gives back what was set aside with none', async () => {
    const { adminKey } = JSON.parse(readFileSync(path.join(folder, 'it/service.json'), 'utf8')) as { adminKey: string }
    const { api } = backendAt(Number(new URL(origin).port))
    const asAdmin = async (kind: 'query' | 'mutation', name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${api}/api/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Convex ${adminKey}` },
        body: JSON.stringify({ path: name, args, format: 'json' }),
        signal: AbortSignal.timeout(10_000),
      })
      const result = (await response.json()) as { status: string; value?: unknown; errorMessage?: string }
      if (result.status !== 'success') throw new Error(`${name} was refused: ${result.errorMessage}`)
      return result.value
    }
    const rows = async (table: string) =>
      ((await asAdmin('query', '_system/cli/tableData', { table, order: 'asc', paginationOpts: { numItems: 100, cursor: null } })) as { page: any[] }).page
    const add = async (table: string, documents: Record<string, unknown>[]) => {
      const said = (await asAdmin('mutation', '_system/frontend/addDocument', { table, documents })) as { success?: boolean } | null
      expect(said?.success ?? true).toBe(true)
    }
    const [user] = await rows('users')
    const [machine] = await rows('machines')
    const now = Date.now()
    const stopped = { harness: 'codex', id: 'thread-stopped' }
    const aside = { harness: 'codex', id: 'thread-aside' }
    await add('artifacts', [{ userId: user._id, slug: 'ordering', title: 'Ordering', lastVersion: 1, bytes: 0, createdAt: now, updatedAt: now, waiting: 6 }])
    const page = (await rows('artifacts')).find((a) => a.slug === 'ordering')
    const click = (clientActionId: string, more: Record<string, unknown>) => ({
      userId: user._id,
      artifactId: page._id,
      clientActionId,
      name: 'press',
      payload: '{}',
      contentVersion: 1,
      title: 'Ordering',
      createdAt: now,
      delivery: 'pending',
      harness: 'codex',
      ...more,
    })
    await add('actions', [
      click('ordering-unnumbered', { machineId: machine._id, sessionId: stopped.id }),
      click('ordering-before', { machineId: machine._id, sessionId: stopped.id, sequence: 5 }),
      click('ordering-after', { machineId: machine._id, sessionId: stopped.id, sequence: 50 }),
      click('ordering-aside-unnumbered', { parkedBy: machine._id, sessionId: aside.id }),
      click('ordering-aside-before', { parkedBy: machine._id, sessionId: aside.id, parkedGeneration: 0 }),
      click('ordering-aside-after', { parkedBy: machine._id, sessionId: aside.id, parkedGeneration: 60 }),
    ])
    await add('deliveryReturns', [{ userId: user._id, machineId: machine._id, harness: aside.harness, sessionId: aside.id, generation: 55, at: now }])
    // A step of a stop that has its place, 10, in the order: what has no place came before it
    await asAdmin('mutation', 'artifacts:dropRest', { userId: user._id, machineId: machine._id, session: stopped, at: 0, sequence: 10 })
    // A step of giving back what was set aside before the conversation was heard from again at 55
    await asAdmin('mutation', 'delivery:unparkRest', { userId: user._id, machineId: machine._id, for: aside, generation: 55 })
    const after = new Map((await rows('actions')).filter((x) => x.clientActionId.startsWith('ordering-')).map((x) => [x.clientActionId, x]))
    expect([...after.keys()].sort()).toHaveLength(6)
    expect(after.get('ordering-unnumbered')).toMatchObject({ delivery: 'handed_off', route: 'stopped', stoppedSequence: 10 })
    expect(after.get('ordering-before')).toMatchObject({ delivery: 'handed_off', route: 'stopped', stoppedSequence: 10 })
    expect(after.get('ordering-after')).toMatchObject({ delivery: 'pending' })
    for (const given of ['ordering-aside-unnumbered', 'ordering-aside-before']) {
      expect(after.get(given)).toMatchObject({ delivery: 'pending', machineId: machine._id })
      expect(after.get(given)).not.toHaveProperty('parkedBy')
    }
    expect(after.get('ordering-aside-after')).toMatchObject({ parkedBy: machine._id, parkedGeneration: 60 })
    expect(after.get('ordering-aside-after')).not.toHaveProperty('machineId')
  })
})
