// @vitest-environment node
// Many callers at once, against the real backend program. What is counted against a person is
// kept in one record for all of their tabs, browsers and machines, and a display, a session and
// a showing are each one record too. Of the callers that would write the same record at the
// same moment the backend program lets one through and gives up on the others, and a function
// that an action or a route runs is then for the action or the route to ask again
// (lib/clash.ts). So every caller is to be answered: with what it asked for, or with a refusal
// that says why. The stand-in backend the other tests here run on never gives up on a write,
// which is why these start the program itself, in a folder and on ports of their own.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
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
  afterAll(async () => {
    if (service && service.exitCode === null && service.signalCode === null) {
      const gone = new Promise((resolve) => service!.once('exit', resolve))
      service.kill('SIGTERM')
      await gone
    }
    await ports.release()
    rmSync(folder, { recursive: true, force: true })
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

  test('every tab that fetches the token its display signs out with is given one, or told it has asked too often', async () => {
    const browser = await paired()
    const answers = await Promise.all(Array.from({ length: 120 }, () => browser.asks('action', 'displays:signOutToken', { key: browser.key }).then(outcome)))
    const { answered, rate_limited, ...other } = tally(answers)
    expect(other).toEqual({})
    // As many as the limit lets through at once, and no fewer for having asked together
    expect([answered! >= 30, answered! + rate_limited!]).toEqual([true, 120])
  }, 120_000)

  test('every tab that asks for the key notifications are subscribed with is given it, or told it has asked too often', async () => {
    const browser = await paired()
    const answers = await Promise.all(Array.from({ length: 120 }, () => browser.asks('action', 'push:publicKey', {}).then(outcome)))
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
        }).then((r) => r.status),
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
        }).then((r) => r.status),
      ),
    )
    expect(tally(answers)).toEqual({ 200: 1, 401: 59 })
  }, 120_000)

  /** A token for the session a cookie is. */
  const token = async (cookie: string) =>
    ((await (await fetch(`${origin}/session/token`, { method: 'POST', headers: { ...site(), cookie } })).json()) as { token: string }).token
})
