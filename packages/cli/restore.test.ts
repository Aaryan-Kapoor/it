// Going back to an older It once a newer one has changed the data, by putting back the copy the
// newer one kept before it changed anything, as "Going back to an older It" in docs/data.md
// says. The commands that put the copy back are read from that page and run as they are written
// there, so the page cannot come to say something that does not work.
//
// The older It is this source. The newer one is this source too, under the next version number,
// with functions whose schema gives every display two optional fields the older schema does not
// have, `usedAt` and `reports`, and a module that writes them. In one case it also says that it
// runs a newer release of the backend program, as a release may. Both run the real backend
// program, on ports of this file's own, in a folder of each test's own.
//
// What this does not cover: two real releases from GitHub, a backend program that is in truth
// another build and has changed the database's own format, the older backend program being
// fetched again, the install script putting the older program in place, and the steps on macOS
// and on Windows, whose PowerShell commands are not run.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { build, type Plugin } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { FUNCTIONS_HASH, functions as functionsText } from './src/functions.generated'
import { backendAt, VERSION } from './src/lib'
import { asAdmin } from './src/serve/backend'
import { RELEASE } from './src/serve/config'
import { bases } from './test-ports'

delete process.env.XDG_CONFIG_HOME

const windows = process.platform === 'win32'
/** The backend program on this machine: the one IT_BACKEND_BIN names, or the one the `convex` package keeps. */
const program = [process.env.IT_BACKEND_BIN, path.join(os.homedir(), '.cache/convex/binaries', RELEASE, 'convex-local-backend')].find(
  (file): file is string => Boolean(file) && existsSync(file!),
)

const ports = bases(33_000, 8)
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Waits for something for a generous while, and where it has not come by then, says what was there in its place. */
const comes = async (what: () => boolean | Promise<boolean>, seen: () => unknown, ms = 120_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await pause(50)) if (await what()) return
  throw new Error(`What was waited for had not come after ${ms / 1000} seconds. What was there: ${JSON.stringify(seen())}`)
}

/** The next version of It, and a release of the backend program newer than any It has run. */
const NEWER = VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1))
const NEWER_RELEASE = 'precompiled-2099-01-01-abcdef0'

let folder: string
let scratch: string
/** This source as the program, and the newer It as one with newer functions only and as one that runs a newer backend program too. */
let older: string
let newerFunctions: string
let newerBoth: string
let NEWER_HASH: string

/** The source of `restoring.js`, a module of the newer functions that writes and reads the two fields only they know. */
const RESTORING = `
  import { internalMutationGeneric, internalQueryGeneric } from 'convex/server'
  export const mark = internalMutationGeneric({
    args: {},
    handler: async (ctx) => {
      const all = await ctx.db.query('displays').collect()
      for (const d of all) await ctx.db.patch(d._id, { usedAt: Date.now(), reports: [{ at: Date.now(), visible: true }] })
      return all.length
    },
  })
  export const seen = internalQueryGeneric({
    args: {},
    handler: async (ctx) => (await ctx.db.query('displays').collect()).map((d) => ({ key: d.key, usedAt: d.usedAt, reports: d.reports })),
  })
`

/** Bundles the program as `build.mjs` does, with whatever the plugins change of its source. */
const bundled = (name: string, plugins: Plugin[] = []) =>
  build({
    entryPoints: [path.join(__dirname, 'src/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: path.join(scratch, name),
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    loader: { '.md': 'text', '.txt': 'text' },
    logLevel: 'silent',
    plugins,
  }).then(() => path.join(scratch, name))

beforeAll(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'it-restore-scratch-'))
  older = await bundled('older.mjs')
  // The newer functions: the displays of their schema have two more fields, which may be left out
  const request = JSON.parse(functionsText()) as {
    appDefinition: { schema: { source: string }; changedModules: { path: string; source: string; environment: string }[] }
  }
  const schema = request.appDefinition.schema.source
  request.appDefinition.schema.source = schema.replace(
    /generatedName:\s*(\w+)\.string\(\),/,
    (whole, v: string) => `${whole} usedAt: ${v}.optional(${v}.number()), reports: ${v}.optional(${v}.array(${v}.object({ at: ${v}.number(), visible: ${v}.boolean() }))),`,
  )
  expect(request.appDefinition.schema.source).not.toBe(schema)
  // And a module of their own that uses them, bundled whole as the backend takes a module
  const restoring = await build({
    stdin: { contents: RESTORING, resolveDir: __dirname, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    write: false,
    logLevel: 'silent',
  })
  request.appDefinition.changedModules.push({ path: 'restoring.js', source: restoring.outputFiles[0]!.text, environment: 'isolate' })
  const text = JSON.stringify(request)
  NEWER_HASH = createHash('sha256').update(text).digest('hex')
  const newer = (release: string): Plugin => ({
    name: 'a newer It',
    setup(b) {
      b.onLoad({ filter: /functions\.generated\.ts$/ }, () => ({
        loader: 'ts',
        contents: `export const FUNCTIONS_HASH = '${NEWER_HASH}'\nexport const FUNCTIONS_GZIP = ''\nexport const functions = () => ${JSON.stringify(text)}`,
      }))
      b.onLoad({ filter: /[\\/]src[\\/]lib\.ts$/ }, (asked) => ({
        loader: 'ts',
        contents: readFileSync(asked.path, 'utf8').replace(`export const VERSION = '${VERSION}'`, `export const VERSION = '${NEWER}'`),
      }))
      b.onLoad({ filter: /[\\/]src[\\/]serve[\\/]config\.ts$/ }, (asked) => ({
        loader: 'ts',
        contents: readFileSync(asked.path, 'utf8').replace(`export const RELEASE = '${RELEASE}'`, `export const RELEASE = '${release}'`),
      }))
    },
  })
  newerFunctions = await bundled('newer-functions.mjs', [newer(RELEASE)])
  newerBoth = await bundled('newer-both.mjs', [newer(NEWER_RELEASE)])
}, 120_000)
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

beforeEach(async () => {
  folder = mkdtempSync(path.join(os.tmpdir(), 'it-restore-'))
  process.env.IT_PORT = String(await ports.next())
}, 120_000)

const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
  rmSync(folder, { recursive: true, force: true })
  await ports.release()
}, 120_000)

/**
 * Runs one of the programs in a folder of It's own, with only what is given here in its
 * environment: `node` on its PATH and nothing else, and the backend program this machine has.
 */
const run = (it: string, args: string[], home = folder) => {
  const commands = path.join(scratch, 'commands')
  if (!existsSync(commands)) {
    mkdirSync(commands)
    symlinkSync(process.execPath, path.join(commands, 'node'))
  }
  const child = spawn(process.execPath, [it, ...args], {
    cwd: home,
    env: {
      PATH: commands,
      HOME: home,
      IT_HOME: home,
      IT_PORT: process.env.IT_PORT!,
      IT_BACKEND_BIN: program!,
      IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
      IT_HARNESSES: 'none',
      IT_SHELL_ENV: 'off',
      IT_UPDATE_CHECK: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let out = ''
  let err = ''
  child.stdout!.on('data', (c: Buffer) => (out += c))
  child.stderr!.on('data', (c: Buffer) => (err += c))
  const ended = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  return { child, ended, out: () => out, err: () => err }
}
/** What a command printed as JSON, once it has ended well. */
const said = async (it: string, args: string[]) => {
  const ran = run(it, args)
  const code = await ran.ended
  expect([args, code === 0 ? 0 : { code, said: ran.err() }]).toEqual([args, 0])
  return JSON.parse(ran.out())
}
/** The service, run in the foreground as `it serve` runs it, writing down what it does in a log of its own. */
const serve = (it: string, log: string, home = folder) => {
  const file = path.join(home, log)
  const ran = run(it, ['serve', '--log', file], home)
  const lines = () => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  return { ...ran, lines }
}
type Served = ReturnType<typeof serve>
/** Waits for the service to have started, and fails at once where it ended instead. */
const started = (service: Served) =>
  comes(
    () => {
      if (service.lines().includes('service started')) return true
      if (service.child.exitCode !== null) throw new Error(`The service ended without starting: ${JSON.stringify([service.lines(), service.err()])}`)
      return false
    },
    () => [service.lines(), service.err()],
  )
const stopped = async (service: Served) => {
  service.child.kill('SIGTERM')
  expect(await service.ended).toBe(0)
}
const inBackend = (...parts: string[]) => path.join(folder, 'backend', ...parts)
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

/** The commands docs/data.md gives for Linux and macOS, as they are written there. */
function documentedSteps(): string {
  const page = readFileSync(path.join(__dirname, '../../docs/data.md'), 'utf8')
  const section = page.slice(page.indexOf('## Going back to an older It'))
  const [, indent, block] = /^( *)```sh\n([\s\S]*?)^\1```/m.exec(section) ?? []
  expect(block, 'the section has a block of shell commands').toBeDefined()
  return block!
    .split('\n')
    .map((line) => line.slice(indent!.length))
    .join('\n')
}

describe.skipIf(!program || windows)('going back to an older It by putting back the copy from before the upgrade', () => {
  test.each([
    ['newer functions', false],
    ['newer functions and a newer backend program', true],
  ])(
    'after an It with %s has changed the data, the documented steps put the copy back, and the older It starts on it with its page, state and display as they were',
    async (_, programToo) => {
      const newer = programToo ? newerBoth : newerFunctions
      const port = Number(process.env.IT_PORT)
      const door = `http://127.0.0.1:${port}`
      const pages = `http://127.0.0.1:${port + 1}`
      const ref = makeFunctionReference

      // The older It, set up, with a page of two files, its state, and a browser paired as the owner's that is a display
      const setup = run(older, ['setup', '--none', '--no-service'])
      expect(await setup.ended, setup.err()).toBe(0)
      let service = serve(older, 'older.log')
      await started(service)
      const index = '<!doctype html><h1>Plan</h1><script src="app.js"></script>'
      mkdirSync(path.join(folder, 'page'))
      writeFileSync(path.join(folder, 'page', 'index.html'), index)
      writeFileSync(path.join(folder, 'page', 'app.js'), 'console.log("plan")')
      expect(await said(older, ['create', 'Plan', '--id', 'plan', '--dir', path.join(folder, 'page'), '--state', '{"step":1}'])).toMatchObject({ id: 'plan', version: 1 })
      expect(await said(older, ['set', 'plan', 'step', '2'])).toMatchObject({ revision: 2 })
      const asSite = { origin: door, 'x-it-site': '1', 'content-type': 'application/json' }
      const code = new URL((await said(older, ['site', '--no-open'])).url).hash.slice(1)
      const redeemed = await fetch(`${door}/session/redeem`, { method: 'POST', headers: asSite, body: JSON.stringify({ code }) })
      expect(redeemed.status).toBe(200)
      const cookie = redeemed.headers.getSetCookie()[0]!.split(';')[0]!
      /** The paired browser, with a token its pairing earns it now. */
      const browser = async () => {
        const earned = await fetch(`${door}/session/token`, { method: 'POST', headers: { ...asSite, cookie } })
        expect(earned.status).toBe(200)
        const client = new ConvexHttpClient(door, { logger: false })
        client.setAuth(((await earned.json()) as { token: string }).token)
        return client
      }
      const displayKey = 'a-display-key-000001'
      await (await browser()).mutation(ref<'mutation'>('displays:register'), { key: displayKey, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/144.0' })
      /** Opens a page on the display as the site does: a showing, its one ticket, and the page's first file under the address the ticket is traded for. */
      const opened = async (slug: string) => {
        const client = await browser()
        const page = (await client.query(ref<'query'>('artifacts:get'), { slug })) as { id: string }
        const { mountId } = (await client.mutation(ref<'mutation'>('mounts:create'), { artifactId: page.id, displayKey })) as { mountId: string }
        const { ticket } = (await client.action(ref<'action'>('mounts:ticket'), { mountId })) as { ticket: string }
        const traded = await fetch(`${pages}/open/${ticket}`, { redirect: 'manual' })
        expect(traded.status).toBe(303)
        const shown = await fetch(new URL(traded.headers.get('location')!, pages))
        return { status: shown.status, body: await shown.text() }
      }
      expect(await opened('plan')).toEqual({ status: 200, body: index })
      await stopped(service)
      const before = json(inBackend('data.json'))
      expect(before).toMatchObject({ release: RELEASE, it: VERSION, functions: FUNCTIONS_HASH, functionsOf: VERSION })

      // The newer It keeps a copy and loads its functions, which the data takes
      service = serve(newer, 'newer.log')
      await started(service)
      expect(service.lines()).toContain('backend: a copy of the database was kept before it is changed (database_copied)')
      expect(service.lines()).toContain(`backend: functions loaded (${NEWER_HASH.slice(0, 12)})`)
      const copies = readdirSync(inBackend()).filter((name) => name.startsWith('before-'))
      expect(copies).toEqual([programToo ? `before-${NEWER_RELEASE}-functions-${NEWER_HASH.slice(0, 12)}` : `before-functions-${NEWER_HASH.slice(0, 12)}`])
      const copy = copies[0]!
      const kept = readdirSync(inBackend(copy)).sort()
      expect(kept).toEqual(expect.arrayContaining(['copy.json', 'data.json', 'db.sqlite3', 'storage']))
      expect(json(inBackend(copy, 'data.json'))).toEqual(before)
      // It writes what only it knows of, and more is done after the upgrade: the state changed again, and another page
      const backend = { api: backendAt(port).api, adminKey: json(path.join(folder, 'service.json')).adminKey as string }
      expect(await asAdmin(backend, 'restoring:mark', {})).toBe(1)
      expect(await asAdmin(backend, 'restoring:seen', {})).toEqual([
        { key: displayKey, usedAt: expect.any(Number), reports: [{ at: expect.any(Number), visible: true }] },
      ])
      expect(await said(newer, ['set', 'plan', 'step', '3'])).toMatchObject({ revision: 3 })
      expect(await said(newer, ['create', 'Later', '--id', 'later', '--html', '<p>later</p>'])).toMatchObject({ id: 'later' })
      await stopped(service)
      expect(json(inBackend('data.json'))).toMatchObject({ release: programToo ? NEWER_RELEASE : RELEASE, it: NEWER, functionsOf: NEWER, functions: NEWER_HASH })

      // The older It is not started on the newer data
      const refused = serve(older, 'refused.log')
      expect(await refused.ended).toBe(1)
      expect(refused.lines()).toMatch(/could not start: backend_older\n$/)

      // Nor would its functions fit that data, where it went past what is noted: in a copy of the
      // whole folder, the note is made to say the data is the older It's, and the backend refuses
      // the older functions for the fields only the newer ones know
      const control = mkdtempSync(path.join(os.tmpdir(), 'it-restore-control-'))
      try {
        cpSync(folder, control, { recursive: true })
        const note = path.join(control, 'backend', 'data.json')
        writeFileSync(note, JSON.stringify({ ...json(note), release: RELEASE, it: VERSION, functionsOf: VERSION }))
        const forced = serve(older, 'forced.log', control)
        await started(forced)
        expect(forced.lines()).toContain('backend: functions not loaded (schema failed)')
        expect(forced.lines()).toContain('backend: the functions of this version were refused, and the ones already loaded go on serving (functions_kept)')
        await stopped(forced)
      } finally {
        rmSync(control, { recursive: true, force: true })
      }

      // The copy is put back with the commands the documentation gives, as they are written there
      const steps = documentedSteps()
      expect(steps).toMatch(/^copy=before-\.\.\.$/m)
      expect(steps).toContain('~/.it')
      execFileSync('sh', ['-e', '-c', steps.replace(/^copy=.*$/m, `copy=${copy}`).replaceAll('~/.it', `'${folder}'`)], {
        env: { PATH: process.env.PATH, HOME: folder },
        stdio: 'pipe',
      })
      // The newer data is aside, whole, and the copy is as it was
      expect(json(inBackend('after-upgrade', 'data.json'))).toMatchObject({ it: NEWER, functionsOf: NEWER })
      expect(readdirSync(inBackend('after-upgrade'))).toEqual(expect.arrayContaining(['data.json', 'db.sqlite3', 'storage']))
      expect(readdirSync(inBackend(copy)).sort()).toEqual(kept)
      expect(existsSync(inBackend('copy.json'))).toBe(false)

      // The older It starts on it, with its own functions in it and none refused
      service = serve(older, 'restored.log')
      await started(service)
      expect(service.lines()).not.toMatch(/backend_older|functions_kept|copy_failed|database_copied/)
      const status = await said(older, ['status', '--json'])
      expect(status.database).toEqual({ release: RELEASE, it: VERSION, functions: FUNCTIONS_HASH, functionsOf: VERSION })
      // The functions it has are the older ones: the newer module is not among them
      expect(await asAdmin(backend, 'restoring:seen', {}).then(
        () => 'answered',
        () => 'not there',
      )).toBe('not there')
      // The page opens on the display, with its state as it was before the upgrade, and what was done since is gone
      expect(await said(older, ['state', 'plan'])).toEqual({ state: { step: 2 }, revision: 2 })
      expect((await said(older, ['list'])).map((page: { id: string }) => page.id)).toEqual(['plan'])
      expect(((await (await browser()).query(ref<'query'>('displays:list'), {})) as { key?: string }[]).length).toBe(1)
      expect(await opened('plan')).toEqual({ status: 200, body: index })
      // And it goes on from there
      expect(await said(older, ['set', 'plan', 'step', '4'])).toMatchObject({ revision: 3 })
      await stopped(service)
    },
    400_000,
  )
})
