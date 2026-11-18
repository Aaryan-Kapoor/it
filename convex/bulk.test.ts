// @vitest-environment node
// The largest changes to a page's state, against the real backend program. The backend program
// holds one function to limits that the stand-in backend of the other tests does not have: it
// may read the database in 4,096 places, and looking a record up by its name, changing it and
// removing it are each one of them; it may write 16,000 records and 16 MiB; and it may run for
// a second of its own time. A page keeps up to 5,000 values in a state of up to 512 KB, and a
// change that It accepts must then be made, whole, in one function. So these start the program
// itself, in a folder and on ports of their own, and change everything a page may keep at
// once, by every way there is to change it: `it patch`, `it set`, `it patch --replace`, and the
// page's own writes.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIMITS, STORE_KEY } from '@it/protocol'
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

/** The base port everything is counted from: one of this file's own blocks, held for as long as the service runs on it. */
const ports = bases(22_000, 10)
const until = async (what: () => boolean | Promise<boolean>, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) if (await what()) return true
  return false
}

/** As many values as a page may keep, under names of their own, each made by `value`. */
const values = (value: (i: number) => unknown, prefix = 'k', count: number = LIMITS.storeKeys) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, value(i)]))
/**
 * A value of such a size that as many of them as a page may keep come to nearly the most a
 * state may be: each one's share of the limit, less its name of up to five characters and the
 * quotes, the colon and the comma it is written with.
 */
const filling = (i: number, mark: string) => `${i}`.padEnd(Math.floor(LIMITS.stateBytes / LIMITS.storeKeys) - 11, mark)
const bytes = (state: unknown) => new TextEncoder().encode(JSON.stringify(state)).length

// Left out where the backend program is not on this machine, and on Windows, where the service is not run as a program by these tests
if (!program) console.log('  skip  the tests of the largest changes to a state: the backend program is not on this machine, and IT_BACKEND_BIN names none')
else if (process.platform === 'win32')
  console.log('  skip  the tests of the largest changes to a state: they run the service as a program, which these tests do not do on Windows')
describe.skipIf(!program || process.platform === 'win32')('the largest changes to a page’s state, against the real backend program', () => {
  let folder: string
  let origin: string
  let service: ChildProcess | undefined
  let files = 0
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
  /** Runs the program to its end: how it ended, and what it printed, read as JSON where it is JSON. */
  const ran = (args: string[]) =>
    new Promise<{ code: number | null; said: any }>((resolve) => {
      const child = spawn(process.execPath, [it, ...args], { cwd: folder, env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout!.on('data', (piece: Buffer) => (out += piece))
      child.stderr!.on('data', (piece: Buffer) => (err += piece))
      child.once('exit', (code) => {
        let said: unknown = (out || err).trim()
        try {
          said = JSON.parse(String(said))
        } catch {}
        resolve({ code, said })
      })
    })
  /** A change as large as these are is given in a file, as an agent gives it. */
  const inFile = (body: unknown) => {
    const file = path.join(folder, `change-${files++}.json`)
    writeFileSync(file, JSON.stringify(body))
    return file
  }
  const patch = (slug: string, body: unknown, ...more: string[]) => ran(['patch', slug, '--file', inFile(body), ...more])
  const stateOf = async (slug: string) => (await ran(['state', slug])).said as { state: Record<string, any>; revision: number }
  const made = async (slug: string) => expect((await ran(['create', slug, '--id', slug, '--html', '<p>A page.</p>'])).code).toBe(0)
  /** What the backend program answers its own key: how many records of what pages keep there are in all. */
  const records = async () => {
    const { adminKey } = JSON.parse(readFileSync(path.join(folder, 'it/service.json'), 'utf8')) as { adminKey: string }
    const answered = await fetch(`${backendAt(Number(new URL(origin).port)).api}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Convex ${adminKey}` },
      body: JSON.stringify({ path: '_system/frontend/tableSize:default', args: { tableName: 'stored', componentId: null }, format: 'json' }),
      signal: AbortSignal.timeout(10_000),
    })
    const said = (await answered.json()) as { status: string; value?: number }
    if (said.status !== 'success' || typeof said.value !== 'number') throw new Error('the records could not be counted')
    return said.value
  }

  beforeAll(async () => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-bulk-'))
    mkdirSync(path.join(folder, 'commands'))
    symlinkSync(process.execPath, path.join(folder, 'commands', 'node'))
    origin = `http://127.0.0.1:${await ports.next()}`
    expect((await ran(['setup', '--none', '--no-service'])).code).toBe(0)
    service = spawn(process.execPath, [it, 'serve', '--log', path.join(folder, 'service.log')], { cwd: folder, env: env(), stdio: 'ignore' })
    const log = () => (existsSync(path.join(folder, 'service.log')) ? readFileSync(path.join(folder, 'service.log'), 'utf8') : '')
    // Where it does not start, what it wrote down says why
    expect([await until(() => /^\S+ connector \S+ started/m.test(log()), 90_000), log()]).toEqual([true, expect.any(String)])
  }, 120_000)
  afterAll(async () => {
    let left: number | undefined
    let stuck: string | undefined
    try {
      if (service && service.exitCode === null && service.signalCode === null) {
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
    expect(stuck, 'the service had not stopped 45 seconds after it was asked to').toBeUndefined()
  }, 60_000)

  test('an agent merges in the most a page may keep, changes all of it, puts as much in its place, and takes it all away, each in one change', async () => {
    await made('most')
    const before = await records()
    // As many values as a page may keep, in a state that is nearly as large as one may be
    const first = { [STORE_KEY]: values((i) => filling(i, 'a')) }
    expect([Object.keys(first[STORE_KEY]).length, bytes(first) > LIMITS.stateBytes - 16 * 1024, bytes(first) <= LIMITS.stateBytes]).toEqual([
      LIMITS.storeKeys,
      true,
      true,
    ])
    // Merged into a page that keeps nothing, with `it patch`
    expect(await patch('most', first)).toEqual({ code: 0, said: { revision: 1 } })
    expect(await stateOf('most')).toEqual({ state: first, revision: 1 })
    // Every one of them changed, with `it set`: each is merged into the value that is there
    const second = values((i) => filling(i, 'b'))
    expect(await ran(['set', 'most', STORE_KEY, '--file', inFile(second)])).toEqual({ code: 0, said: { revision: 2 } })
    expect(await stateOf('most')).toEqual({ state: { [STORE_KEY]: second }, revision: 2 })
    // And again with `it patch`, which merges as `it set` does
    const third = { [STORE_KEY]: values((i) => filling(i, 'c')) }
    expect(await patch('most', third)).toEqual({ code: 0, said: { revision: 3 } })
    expect(await stateOf('most')).toEqual({ state: third, revision: 3 })
    // As many others put in place of them, with `it patch --replace`
    const others = { title: 'others', [STORE_KEY]: values((i) => filling(i, 'd'), 'o') }
    expect(bytes(others) <= LIMITS.stateBytes).toBe(true)
    expect(await patch('most', others, '--replace')).toEqual({ code: 0, said: { revision: 4 } })
    expect(await stateOf('most')).toEqual({ state: others, revision: 4 })
    // One more than a page may keep is refused with the reason, and nothing of it is written
    expect(await patch('most', { [STORE_KEY]: { 'one-more': 1 } })).toEqual({
      code: 1,
      said: { error: { code: 'limit', message: `A page keeps at most ${LIMITS.storeKeys} values with It.store.` } },
    })
    // So is a change to every value that would make the state larger than one may be
    expect(await patch('most', { [STORE_KEY]: values((i) => filling(i, 'e').padEnd(150, 'e'), 'o') })).toEqual({
      code: 1,
      said: { error: { code: 'limit', message: `A page's state is at most ${LIMITS.stateBytes / 1024} KB.` } },
    })
    // And one that names ten times as many values as a page may keep
    expect((await patch('most', { [STORE_KEY]: values(() => 1, 'z', 10 * LIMITS.storeKeys) })).said).toEqual({
      error: { code: 'limit', message: `A page keeps at most ${LIMITS.storeKeys} values with It.store.` },
    })
    expect(await stateOf('most')).toEqual({ state: others, revision: 4 })
    // All of it taken away at once
    expect(await patch('most', { [STORE_KEY]: null })).toEqual({ code: 0, said: { revision: 5 } })
    expect(await stateOf('most')).toEqual({ state: { title: 'others' }, revision: 5 })
    // The records each of those changes left behind are removed afterwards, until none of what the page kept is there
    expect([await until(async () => (await records()) === before, 120_000), (await records()) - before]).toEqual([true, 0])
  }, 420_000)

  test('a page fills what it may keep itself, its agent changes all of that at once, and the page goes on changing it', async () => {
    await made('own')
    const before = await records()
    // A browser paired as the owner's, which is what a page's own writes are made as
    const code = new URL(((await ran(['site', '--no-open', '--json'])).said as { url: string }).url).hash.slice(1)
    const site = { origin, 'x-it-site': '1', 'content-type': 'application/json' }
    const redeemed = await fetch(`${origin}/session/redeem`, { method: 'POST', headers: site, body: JSON.stringify({ code }) })
    expect(redeemed.status).toBe(200)
    const cookie = redeemed.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
    const { token } = (await (await fetch(`${origin}/session/token`, { method: 'POST', headers: { ...site, cookie } })).json()) as { token: string }
    /** One function of the backend's, called as the browser: what it gave, or the code of its refusal, or `no code` where it failed and said nothing. */
    const asks = async (kind: 'query' | 'mutation', fn: string, args: Record<string, unknown>) => {
      const r = await fetch(`${origin}/api/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: fn, args, format: 'json' }),
      })
      const said = (await r.json()) as { status: string; value?: any; errorData?: { code?: string } }
      return said.status === 'success' ? { value: said.value } : { refused: said.errorData?.code ?? 'no code' }
    }
    expect(await asks('mutation', 'displays:register', { key: crypto.randomUUID(), userAgent: 'a test' })).toHaveProperty('value')
    const pages = (await asks('query', 'artifacts:list', {})).value as { id: string; slug: string }[]
    const artifactId = pages.find((p) => p.slug === 'own')!.id
    /** The page keeps values, as many at once as one write of It.store may. */
    const keeps = async (kept: Record<string, unknown>) => {
      const changes = Object.entries(kept).map(([key, value]) => ({ key, value: JSON.stringify(value) }))
      const answers = []
      for (let from = 0; from < changes.length; from += LIMITS.storeKeysAtOnce)
        answers.push(await asks('mutation', 'state:store', { artifactId, changes: changes.slice(from, from + LIMITS.storeKeysAtOnce) }))
      return answers
    }
    const writes = LIMITS.storeKeys / LIMITS.storeKeysAtOnce
    const first = values((i) => filling(i, 'p'))
    expect((await keeps(first)).map((answer) => answer.value?.revision)).toEqual(Array.from({ length: writes }, (_, n) => n + 1))
    expect(await stateOf('own')).toEqual({ state: { [STORE_KEY]: first }, revision: writes })
    // One more is refused, as the page's writes always were
    expect(await asks('mutation', 'state:store', { artifactId, changes: [{ key: 'one-more', value: '1' }] })).toEqual({ refused: 'limit' })
    // The agent changes every one of them in one change
    const second = values((i) => filling(i, 'q'))
    expect(await patch('own', { [STORE_KEY]: second })).toEqual({ code: 0, said: { revision: writes + 1 } })
    // A display that had the state from before is sent the whole of it, and one that has it is sent nothing more
    const sent = (await asks('query', 'state:live', { artifactId, since: writes })).value as { whole?: boolean; revision: number; kept: [string, string][] }
    expect([sent.whole, sent.revision, sent.kept.length]).toEqual([true, writes + 1, LIMITS.storeKeys])
    expect((await asks('query', 'state:live', { artifactId, since: writes + 1 })).value).toEqual({ revision: writes + 1 })
    // The page changes them all again, a write at a time, while what the agent's change left behind may still be there
    const third = values((i) => filling(i, 'r'))
    expect((await keeps(third)).map((answer) => answer.value?.revision)).toEqual(Array.from({ length: writes }, (_, n) => writes + 2 + n))
    expect(await stateOf('own')).toEqual({ state: { [STORE_KEY]: third }, revision: 2 * writes + 1 })
    // And takes them away. Past a thousand names taken away the records of all that went are
    // removed, so of the ten writes the names of the last one's values are still kept, with no value
    expect((await keeps(values(() => null))).every((answer) => 'value' in answer)).toBe(true)
    expect(await stateOf('own')).toEqual({ state: {}, revision: 3 * writes + 1 })
    const named = before + LIMITS.storeKeysAtOnce
    expect([await until(async () => (await records()) === named, 120_000), (await records()) - before]).toEqual([true, LIMITS.storeKeysAtOnce])
  }, 420_000)
})
