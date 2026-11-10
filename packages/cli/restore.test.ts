// Going back to an older It once a newer one has changed the data, by putting back the copy the
// newer one kept before it changed anything, as "Going back to an older It" in docs/data.md
// says, and putting the folder kept aside back again. The lines that do both are read from that
// page and run exactly as they are written there, with `sh` and nothing added or changed, but
// the copy's name where they ask for it. They are told It's folder by IT_HOME, as a person whose
// folder is not `~/.it` is told to do, so the page cannot come to say something that does not
// work. Where they stop the background service, `it service uninstall` is a stand-in that says
// what it was asked and ends as it is told to: no service of this machine's is touched.
//
// The older It is this source. A newer one is this source too, under a later version number,
// with functions whose schema gives every display two optional fields the older schema does not
// have, `usedAt` and `reports`, and a module that writes them. Some of them also say that they
// run a newer release of the backend program, as a release may, and one has functions that the
// data refuses. All run the real backend program, on ports of this file's own, in a folder of
// each test's own.
//
// What this does not cover: two real releases from GitHub, a backend program that is in truth
// another build and has changed the database's own format, the older backend program being
// fetched again, the install script putting the older program in place, `it service uninstall`
// itself, and the steps on macOS and on Windows, whose PowerShell commands are not run.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
import { zsh } from './test-zsh'

delete process.env.XDG_CONFIG_HOME

const windows = process.platform === 'win32'
/** The backend program on this machine: the one IT_BACKEND_BIN names, or the one the `convex` package keeps. */
const program = [process.env.IT_BACKEND_BIN, path.join(os.homedir(), '.cache/convex/binaries', RELEASE, 'convex-local-backend')].find(
  (file): file is string => Boolean(file) && existsSync(file!),
)

// Below the ports the system hands to outgoing connections, which begin at 32768 on Linux, and
// apart from every other file's
const ports = bases(29_500, 8)
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Waits for something for a generous while, and where it has not come by then, says what was there in its place. */
const comes = async (what: () => boolean | Promise<boolean>, seen: () => unknown, ms = 120_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await pause(50)) if (await what()) return
  throw new Error(`What was waited for had not come after ${ms / 1000} seconds. What was there: ${JSON.stringify(seen())}`)
}

/** Later versions of It, and a release of the backend program newer than any It has run. */
const NEWER = VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1))
const NEWEST = VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 2))
const NEWER_RELEASE = 'precompiled-2099-01-01-abcdef0'

let folder: string
/** The folder the lines keep things beside: the test's own folder, as the system names it with every link in it followed. */
let real: string
let scratch: string
/** A folder with `it` in it that stands in for the command the documented lines run. */
let stub: string
/** A newer It: the program, and the hash of its functions. */
interface Later {
  program: string
  hash: string
}
/** This source as the program, and later Its. */
let older: string
let newerFunctions: Later
let newerBoth: Later
let refusing: Later
let newest: Later

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

/**
 * A later It under `version`, running the backend program `release`. Its functions either give
 * displays the two optional fields and carry the module that writes them, which the data takes,
 * or ask every person's record for a field it does not have, which the data refuses.
 */
async function later(name: string, version: string, release: string, functions: 'taken' | 'refused'): Promise<Later> {
  const request = JSON.parse(functionsText()) as {
    appDefinition: { schema: { source: string }; changedModules: { path: string; source: string; environment: string }[] }
  }
  const schema = request.appDefinition.schema.source
  if (functions === 'taken') {
    request.appDefinition.schema.source = schema.replace(
      /generatedName:\s*(\w+)\.string\(\),/,
      (whole, v: string) =>
        `${whole} usedAt: ${v}.optional(${v}.number()), reports: ${v}.optional(${v}.array(${v}.object({ at: ${v}.number(), visible: ${v}.boolean() }))),`,
    )
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
  } else {
    request.appDefinition.schema.source = schema.replace(/subject:\s*(\w+)\.string\(\),/, (whole, v: string) => `${whole} somethingNew: ${v}.string(),`)
  }
  expect(request.appDefinition.schema.source).not.toBe(schema)
  const text = JSON.stringify(request)
  const hash = createHash('sha256').update(text).digest('hex')
  const plugin: Plugin = {
    name: 'a later It',
    setup(b) {
      b.onLoad({ filter: /functions\.generated\.ts$/ }, () => ({
        loader: 'ts',
        contents: `export const FUNCTIONS_HASH = '${hash}'\nexport const FUNCTIONS_GZIP = ''\nexport const functions = () => ${JSON.stringify(text)}`,
      }))
      b.onLoad({ filter: /[\\/]src[\\/]lib\.ts$/ }, (asked) => ({
        loader: 'ts',
        contents: readFileSync(asked.path, 'utf8').replace(`export const VERSION = '${VERSION}'`, `export const VERSION = '${version}'`),
      }))
      b.onLoad({ filter: /[\\/]src[\\/]serve[\\/]config\.ts$/ }, (asked) => ({
        loader: 'ts',
        contents: readFileSync(asked.path, 'utf8').replace(`export const RELEASE = '${RELEASE}'`, `export const RELEASE = '${release}'`),
      }))
    },
  }
  return { program: await bundled(name, [plugin]), hash }
}

beforeAll(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'it-restore-scratch-'))
  stub = path.join(scratch, 'stub')
  mkdirSync(stub)
  writeFileSync(path.join(stub, 'it'), '#!/bin/sh\necho "$*" >> "$STUB_ASKED"\nexit "$STUB_ENDS"\n', { mode: 0o755 })
  ;[older, newerFunctions, newerBoth, refusing, newest] = await Promise.all([
    bundled('older.mjs'),
    later('newer-functions.mjs', NEWER, RELEASE, 'taken'),
    later('newer-both.mjs', NEWER, NEWER_RELEASE, 'taken'),
    later('refusing.mjs', NEWER, NEWER_RELEASE, 'refused'),
    later('newest.mjs', NEWEST, NEWER_RELEASE, 'taken'),
  ])
}, 180_000)
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Folders a test made beside its own, as the documented lines make them, and that go with it. */
let beside: string[]
beforeEach(async () => {
  folder = mkdtempSync(path.join(os.tmpdir(), 'it-restore-'))
  real = realpathSync(folder)
  beside = [folder, `${real}-after-upgrade`, `${real}-replaced`]
  pasteIn = 'sh'
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
  for (const made of beside) {
    for (const part of staged(made)) rmSync(part, { recursive: true, force: true })
    rmSync(made, { recursive: true, force: true })
  }
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
const said = async (it: string, args: string[], home = folder) => {
  const ran = run(it, args, home)
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
/** The folders the lines began copying It's folder `home` into, and that are there still. */
const staged = (home: string) => {
  const dir = path.dirname(home)
  const named = `${path.basename(home)}-after-upgrade.part.`
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((entry) => entry.startsWith(named))
        .map((entry) => path.join(dir, entry))
    : []
}
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
/** Every folder, file and link under a folder, by its path from there, each file with a hash of what it holds and each link with where it leads. */
const tree = (dir: string, under = ''): string[] =>
  readdirSync(path.join(dir, under), { withFileTypes: true })
    .flatMap((entry) => {
      const name = path.join(under, entry.name)
      const full = path.join(dir, name)
      if (entry.isSymbolicLink()) return [`${name} -> ${readlinkSync(full)}`]
      if (entry.isDirectory()) return [`${name}/`, ...tree(dir, name)]
      return [`${name} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`]
    })
    .sort()

/** The section of docs/data.md these steps are in. */
const section = () => {
  const page = readFileSync(path.join(__dirname, '../../docs/data.md'), 'utf8')
  const from = page.indexOf('## Going back to an older It')
  return page.slice(from, page.indexOf('\n## ', from + 1))
}
/** The block of shell lines in that section that has `marker` in it, as it is written there. */
function documented(marker: string): string {
  const blocks = [...section().matchAll(/^( *)```sh\n([\s\S]*?)^\1```/gm)].map(([, indent, block]) =>
    block!
      .split('\n')
      .map((line) => line.slice(indent!.length))
      .join('\n'),
  )
  const found = blocks.filter((block) => block.includes(marker))
  expect(found, `one block of shell lines in the section has ${marker} in it`).toHaveLength(1)
  return found[0]!
}
/**
 * Runs documented lines with `sh`, as a person pastes them, in a terminal where IT_HOME names
 * It's folder `home`. The copy's name is put where they say `copy=before-...`, and nothing else
 * of them is changed. `it` is the stand-in, which ends as `ends` says.
 */
/**
 * The shells the lines are pasted into: sh, which is dash on Debian and Ubuntu, bash, and zsh,
 * which is macOS's own, where this machine has it or IT_TEST_ZSH names one. The shell a test
 * pastes into unless it says otherwise is `pasteIn`.
 */
const SHELLS = ['sh', 'bash', ...(zsh ? [zsh] : [])]
let pasteIn = 'sh'
function pasted(lines: string, home: string, copy?: string, ends = 0, cwd = scratch, shell = pasteIn, first = stub) {
  let script = lines
  if (copy !== undefined) {
    expect(script).toMatch(/^ *copy=before-\.\.\.$/m)
    script = script.replace(/^( *)copy=before-\.\.\.$/m, `$1copy=${copy}`)
  }
  const asked = path.join(scratch, `asked-${Math.random().toString(36).slice(2)}`)
  const ran = spawnSync(shell, ['-c', script], {
    env: { PATH: `${first}:${stub}:${process.env.PATH}`, HOME: scratch, IT_HOME: home, STUB_ASKED: asked, STUB_ENDS: String(ends) },
    cwd,
    encoding: 'utf8',
  })
  return { code: ran.status, out: ran.stdout, err: ran.stderr, asked: existsSync(asked) ? readFileSync(asked, 'utf8') : '' }
}

describe.skipIf(!program || windows)('going back to an older It by putting back the copy from before the upgrade', () => {
  test.each([
    ['newer functions, with a display signed out since, its lines pasted into sh', false, true],
    [
      `newer functions and a newer backend program, where It’s folder is reached through a link in a folder with a space in its name, its lines pasted into ${zsh ? 'zsh' : 'bash, for want of zsh'}`,
      true,
      false,
    ],
  ])(
    'after an It with %s has changed the data, the documented lines put the copy back, the older It starts on it with its page and state as they were, and the documented lines put the kept folder back again',
    async (_, programToo, signedOut) => {
      const newer = programToo ? newerBoth : newerFunctions
      if (programToo) pasteIn = zsh ?? 'bash'
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
      expect(await said(older, ['create', 'Plan', '--id', 'plan', '--dir', path.join(folder, 'page'), '--state', '{"step":1}'])).toMatchObject({
        id: 'plan',
        version: 1,
      })
      expect(await said(older, ['set', 'plan', 'step', '2'])).toMatchObject({ revision: 2 })
      const asSite = { origin: door, 'x-it-site': '1', 'content-type': 'application/json' }
      /** Pairs a browser as the owner's through the door, as the site does, and gives its cookie. */
      const paired = async (it: string) => {
        const code = new URL((await said(it, ['site', '--no-open'])).url).hash.slice(1)
        const redeemed = await fetch(`${door}/session/redeem`, { method: 'POST', headers: asSite, body: JSON.stringify({ code }) })
        expect(redeemed.status).toBe(200)
        return redeemed.headers.getSetCookie()[0]!.split(';')[0]!
      }
      const first = { cookie: await paired(older), key: 'a-display-key-000001' }
      /** A paired browser, with a token its pairing earns it now. */
      const browser = async (cookie: string) => {
        const earned = await fetch(`${door}/session/token`, { method: 'POST', headers: { ...asSite, cookie } })
        expect(earned.status).toBe(200)
        const client = new ConvexHttpClient(door, { logger: false })
        client.setAuth(((await earned.json()) as { token: string }).token)
        return client
      }
      const register = async (as: { cookie: string; key: string }) =>
        (await browser(as.cookie)).mutation(ref<'mutation'>('displays:register'), { key: as.key, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/144.0' })
      await register(first)
      /**
       * Opens a page on a display as the site does: a showing, its one ticket, and the page's
       * first file under the address the ticket is traded for. Where the ticket is refused,
       * what is given is how.
       */
      const opened = async (slug: string, as: { cookie: string; key: string }) => {
        const client = await browser(as.cookie)
        const page = (await client.query(ref<'query'>('artifacts:get'), { slug })) as { id: string }
        const { mountId } = (await client.mutation(ref<'mutation'>('mounts:create'), { artifactId: page.id, displayKey: as.key })) as { mountId: string }
        const { ticket } = (await client.action(ref<'action'>('mounts:ticket'), { mountId })) as { ticket: string }
        const traded = await fetch(`${pages}/open/${ticket}`, { redirect: 'manual' })
        if (traded.status !== 303) return { status: traded.status, body: '' }
        const shown = await fetch(new URL(traded.headers.get('location')!, pages))
        return { status: shown.status, body: await shown.text() }
      }
      expect(await opened('plan', first)).toEqual({ status: 200, body: index })
      await stopped(service)
      const before = json(path.join(folder, 'backend', 'data.json'))
      expect(before).toMatchObject({ release: RELEASE, it: VERSION, functions: FUNCTIONS_HASH, functionsOf: VERSION })

      // The newer It keeps a copy and loads its functions, which the data takes
      service = serve(newer.program, 'newer.log')
      await started(service)
      expect(service.lines()).toContain('backend: a copy of the database was kept before it is changed (database_copied)')
      expect(service.lines()).toContain(`backend: functions loaded (${newer.hash.slice(0, 12)})`)
      const copies = readdirSync(path.join(folder, 'backend')).filter((name) => name.startsWith('before-'))
      expect(copies).toEqual([programToo ? `before-${NEWER_RELEASE}-functions-${newer.hash.slice(0, 12)}` : `before-functions-${newer.hash.slice(0, 12)}`])
      const copy = copies[0]!
      const inCopy = path.join(folder, 'backend', copy)
      expect(readdirSync(inCopy)).toEqual(expect.arrayContaining(['copy.json', 'data.json', 'db.sqlite3', 'storage']))
      expect(json(path.join(inCopy, 'data.json'))).toEqual(before)
      // It writes what only it knows of, and more is done after the upgrade: the state changed
      // again, another page, a second version of the first, and maybe a display signed out
      const backend = { api: backendAt(port).api, adminKey: json(path.join(folder, 'service.json')).adminKey as string }
      expect(await asAdmin(backend, 'restoring:mark', {})).toBe(1)
      expect(await asAdmin(backend, 'restoring:seen', {})).toEqual([
        { key: first.key, usedAt: expect.any(Number), reports: [{ at: expect.any(Number), visible: true }] },
      ])
      expect(await said(newer.program, ['set', 'plan', 'step', '3'])).toMatchObject({ revision: 3 })
      expect(await said(newer.program, ['create', 'Later', '--id', 'later', '--html', '<p>later</p>'])).toMatchObject({ id: 'later' })
      expect(await said(newer.program, ['update', 'plan', '--html', '<p>newer-v2</p>'])).toMatchObject({ version: 2 })
      if (signedOut) {
        const client = await browser(first.cookie)
        const { job } = (await client.mutation(ref<'mutation'>('displays:signOut'), { key: first.key })) as { job: string }
        // The part of It that serves pages has been told, and remembers it
        await comes(
          async () => (await client.query(ref<'query'>('displays:signOutConfirmed'), { job })) === true,
          () => 'the sign-out unconfirmed',
        )
      }
      await stopped(service)
      expect(json(path.join(folder, 'backend', 'data.json'))).toMatchObject({
        release: programToo ? NEWER_RELEASE : RELEASE,
        it: NEWER,
        functionsOf: NEWER,
        functions: newer.hash,
      })

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

      // The lines are told It's folder as the person's terminal would name it: in one case
      // through a link, in a folder with a space in its name, that leads to it
      let home = folder
      if (programToo) {
        const spaced = path.join(mkdtempSync(path.join(os.tmpdir(), 'it-restore-link-')), 'a home with spaces')
        mkdirSync(spaced)
        home = path.join(spaced, '.it')
        symlinkSync(folder, home)
        beside.push(path.dirname(spaced), `${home}-after-upgrade`, `${home}-replaced`)
      }
      const saved = `${real}-after-upgrade`
      // The documented lines, where the service cannot be stopped, change nothing
      const back = documented('copy=')
      const asItWas = tree(folder)
      const unstopped = pasted(back, home, copy, 1)
      expect([unstopped.code, unstopped.out, unstopped.asked]).toEqual([1, '', 'service uninstall\n'])
      expect(tree(folder)).toEqual(asItWas)
      expect(existsSync(saved)).toBe(false)
      // Where It's folder cannot be copied whole, they stop before anything of it is changed,
      // and leave what they began in a folder of their own, which the next run refuses to go
      // past and never removes: that is the person's to look at
      if (process.getuid?.() !== 0) {
        const unreadable = path.join(folder, 'unreadable')
        writeFileSync(unreadable, 'kept from whoever copies')
        chmodSync(unreadable, 0)
        const cut = pasted(back, home, copy)
        rmSync(unreadable, { force: true })
        expect(cut.err).toMatch(/run it setup to start it again\.\n$/)
        const [left, ...more] = staged(real)
        expect([cut.code === 0, more, cut.out]).toEqual([false, [], `Copying It's folder to ${left}.\n`])
        expect(left).toMatch(/-after-upgrade\.part\.\w{6}$/)
        expect([tree(folder), existsSync(saved)]).toEqual([asItWas, false])
        const leftAsItWas = tree(left!)
        const halted = pasted(back, home, copy)
        expect([halted.code, halted.out]).toEqual([1, ''])
        expect(halted.err).toBe(
          `${left} is there already, so nothing was changed. Look at what is in it, remove it yourself if you do not need it, and run these lines again.\n`,
        )
        expect([tree(folder), tree(left!), existsSync(saved)]).toEqual([asItWas, leftAsItWas, false])
        // As the person does, having looked
        rmSync(left!, { recursive: true, force: true })
      }
      // Run as they are written, they stop the service, keep the whole folder as it was, and put the copy back
      const put = pasted(back, home, copy)
      expect([put.code, put.err, put.asked]).toEqual([0, '', 'service uninstall\n'])
      const [copying, kept, aside, done] = put.out.split('\n')
      expect(copying).toMatch(new RegExp(`^Copying It's folder to ${saved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.part\\.\\w{6}\\.$`))
      expect([kept, done]).toEqual([`It's folder as it was is kept in ${saved}.`, 'The copy is in place.'])
      // What the copy replaced is not deleted: it is moved into a folder of the lines' own, beside it
      const replaced = /^What the copy replaced is in (.*)\.$/.exec(aside!)?.[1]
      expect(path.dirname(replaced!)).toBe(path.join(real, 'backend'))
      expect(path.basename(replaced!)).toMatch(/^replaced\.\w{6}$/)
      expect(readdirSync(replaced!)).toEqual(expect.arrayContaining(['data.json', 'db.sqlite3', 'storage']))
      expect(json(path.join(replaced!, 'data.json'))).toMatchObject({ it: NEWER, functionsOf: NEWER })
      expect(lstatSync(saved).isDirectory()).toBe(true)
      expect(tree(saved)).toEqual(asItWas)
      expect(staged(real)).toEqual([])
      expect(json(path.join(folder, 'backend', 'data.json'))).toEqual(before)
      expect(existsSync(path.join(folder, 'backend', 'copy.json'))).toBe(false)
      if (home !== folder) expect([readlinkSync(home), existsSync(`${home}-after-upgrade`)]).toEqual([folder, false])
      // A second run refuses, and changes nothing anywhere
      const restored = tree(folder)
      const again = pasted(back, home, copy)
      expect([again.code, again.out, again.asked]).toEqual([1, '', ''])
      expect(again.err).toBe(
        `${saved} is there already, so nothing was changed. Look at what is in it, remove it yourself if you do not need it, and run these lines again.\n`,
      )
      expect([tree(folder), tree(saved)]).toEqual([restored, asItWas])

      // The older It starts on it, with its own functions in it and none refused
      service = serve(older, 'restored.log')
      await started(service)
      expect(service.lines()).not.toMatch(/backend_older|functions_kept|copy_failed|database_copied/)
      expect((await said(older, ['status', '--json'])).database).toEqual({ release: RELEASE, it: VERSION, functions: FUNCTIONS_HASH, functionsOf: VERSION })
      // The functions it has are the older ones: the newer module is not among them
      expect(
        await asAdmin(backend, 'restoring:seen', {}).then(
          () => 'answered',
          () => 'not there',
        ),
      ).toBe('not there')
      // The page and its state are as they were before the upgrade, and what was done since is gone
      expect(await said(older, ['state', 'plan'])).toEqual({ state: { step: 2 }, revision: 2 })
      expect(await said(older, ['read', 'plan'])).toMatchObject({ version: 1 })
      expect((await said(older, ['list'])).map((page: { id: string }) => page.id)).toEqual(['plan'])
      const displays = (await (await browser(first.cookie)).query(ref<'query'>('displays:list'), {})) as { id: string }[]
      expect(displays).toHaveLength(1)
      let display = first
      if (!signedOut) expect(await opened('plan', display)).toEqual({ status: 200, body: index })
      else {
        // The display signed out since the upgrade opens nothing, as the page says, until it is forgotten and paired again
        expect(await opened('plan', display)).toEqual({ status: 401, body: '' })
        await (await browser(first.cookie)).mutation(ref<'mutation'>('displays:forget'), { displayId: displays[0]!.id })
        display = { cookie: await paired(older), key: 'a-display-key-000002' }
        await register(display)
        expect(await opened('plan', display)).toEqual({ status: 200, body: index })
      }
      // And it goes on from there, publishing a second version of its own over the files the newer one had
      expect(await said(older, ['set', 'plan', 'step', '4'])).toMatchObject({ revision: 3 })
      expect(await said(older, ['update', 'plan', '--html', '<p>older-v2</p>'])).toMatchObject({ version: 2 })
      expect(await opened('plan', display)).toEqual({ status: 200, body: '<p>older-v2</p>' })
      await stopped(service)

      // Going forward again with the documented lines puts the whole folder back as it was kept
      const forward = pasted(documented('-replaced'), home)
      expect([forward.code, forward.err, forward.asked]).toEqual([0, '', 'service uninstall\n'])
      expect(forward.out).toBe(`It's folder is the one that was kept, and the one it replaced is in ${real}-replaced.\n`)
      expect(tree(folder)).toEqual(asItWas)
      expect(existsSync(saved)).toBe(false)
      expect(json(path.join(`${real}-replaced`, 'backend', 'data.json'))).toMatchObject({ it: VERSION, functionsOf: VERSION })
      if (home !== folder) expect(readlinkSync(home)).toBe(folder)
      // And the newer It starts on it, with its own second version, its own bytes and its own state
      service = serve(newer.program, 'forward.log')
      await started(service)
      expect(service.lines()).not.toMatch(/database_copied|functions_kept/)
      expect(await said(newer.program, ['state', 'plan'])).toEqual({ state: { step: 3 }, revision: 3 })
      expect((await said(newer.program, ['list'])).map((page: { id: string }) => page.id).sort()).toEqual(['later', 'plan'])
      expect(await opened('plan', first)).toEqual({ status: 200, body: '<p>newer-v2</p>' })
      await stopped(service)
    },
    600_000,
  )

  test('of two copies, the one to put back is the one the older It last ran on, though a later one says its functions are the older It’s', async () => {
    const setup = run(older, ['setup', '--none', '--no-service'])
    expect(await setup.ended, setup.err()).toBe(0)
    let service = serve(older, 'older.log')
    await started(service)
    await stopped(service)
    // A newer It with a newer backend program, whose functions the data refuses: it serves with the older functions, on its own program
    service = serve(refusing.program, 'refusing.log')
    await started(service)
    expect(service.lines()).toContain('backend: the functions of this version were refused, and the ones already loaded go on serving (functions_kept)')
    await stopped(service)
    // And the newest, on that same program, whose functions the data takes
    service = serve(newest.program, 'newest.log')
    await started(service)
    expect(service.lines()).toContain(`backend: functions loaded (${newest.hash.slice(0, 12)})`)
    await stopped(service)
    const kept = readdirSync(path.join(folder, 'backend'))
      .filter((name) => name.startsWith('before-'))
      .sort()
    expect(kept).toEqual([`before-${NEWER_RELEASE}-functions-${refusing.hash.slice(0, 12)}`, `before-functions-${newest.hash.slice(0, 12)}`].sort())
    const noted = Object.fromEntries(kept.map((copy) => [copy, json(path.join(folder, 'backend', copy, 'data.json'))]))
    // Both say that their functions are the older It's. Only one was last run by it
    for (const copy of kept) expect(noted[copy]).toMatchObject({ functionsOf: VERSION })
    expect(section()).toContain('The copy to put back is the one whose `it` is the version you want to go back to')
    const chosen = kept.filter((copy) => noted[copy]!.it === VERSION)
    expect(chosen).toEqual([`before-${NEWER_RELEASE}-functions-${refusing.hash.slice(0, 12)}`])
    expect(noted[`before-functions-${newest.hash.slice(0, 12)}`]).toMatchObject({ it: NEWER, release: NEWER_RELEASE })
    // Each is put back in a copy of the folder, as the page says, and the older It is started on it: it runs on the one chosen, and refuses the other
    // The chosen one is put back in every shell the lines may be pasted into, the other in sh
    const tries = [
      ...SHELLS.map((shell) => [chosen[0]!, shell] as const),
      ...kept.filter((copy) => !chosen.includes(copy)).map((copy) => [copy, 'sh'] as const),
    ]
    for (const [copy, shell] of tries) {
      const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-restore-choice-')))
      beside.push(home, `${home}-after-upgrade`)
      cpSync(folder, home, { recursive: true })
      // Told It's folder by a relative IT_HOME, which is taken from where the lines are pasted
      const put = pasted(documented('copy='), path.basename(home), copy, 0, path.dirname(home), shell)
      expect([shell, put.code, put.err, put.out.split('\n').at(-2)]).toEqual([shell, 0, '', 'The copy is in place.'])
      expect(existsSync(`${home}-after-upgrade`)).toBe(true)
      const tried = serve(older, 'tried.log', home)
      if (chosen.includes(copy)) {
        await started(tried)
        await stopped(tried)
      } else {
        expect(await tried.ended).toBe(1)
        expect(tried.lines()).toMatch(/could not start: backend_older\n$/)
      }
    }
    // A folder whose backend keeps its stored files through a link, or whose database's journal
    // is a link, even one that leads nowhere, is refused before anything is copied or changed
    const links: [string, (linked: string) => void][] = [
      [
        'storage',
        (linked) => {
          renameSync(path.join(linked, 'backend', 'storage'), `${linked}-elsewhere`)
          symlinkSync(`${linked}-elsewhere`, path.join(linked, 'backend', 'storage'))
        },
      ],
      [
        'db.sqlite3-wal',
        (linked) => {
          rmSync(path.join(linked, 'backend', 'db.sqlite3-wal'), { force: true })
          symlinkSync(`${linked}-elsewhere`, path.join(linked, 'backend', 'db.sqlite3-wal'))
        },
      ],
    ]
    for (const [[name, link], shell] of links.flatMap((one) => SHELLS.map((shell) => [one, shell] as const))) {
      const linked = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-restore-linked-')))
      beside.push(linked, `${linked}-after-upgrade`, `${linked}-elsewhere`)
      cpSync(folder, linked, { recursive: true })
      link(linked)
      const unlinked = tree(linked)
      const refused = pasted(documented('copy='), linked, kept[0], 0, scratch, shell)
      expect([name, shell, refused.code, refused.out, refused.asked]).toEqual([name, shell, 1, '', ''])
      expect(refused.err).toBe(`${path.join(linked, 'backend', name)} is a link, so a copy would not hold what it leads to, and nothing was changed.\n`)
      expect([tree(linked), existsSync(`${linked}-after-upgrade`), staged(linked)]).toEqual([unlinked, false, []])
    }
    /** A copy of the folder as it is now, under a name of its own, with whatever `also` adds. */
    const cloned = (also: (home: string) => void = () => {}) => {
      const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-restore-clone-')))
      beside.push(home, `${home}-after-upgrade`, `${home}-replaced`)
      cpSync(folder, home, { recursive: true })
      also(home)
      return home
    }
    const SETUP = 'The background service is stopped and not registered. Once the folder is as you want it, run it setup to start it again.\n'
    for (const shell of SHELLS) {
      // A copy that is not there is refused before the background service is touched
      let home = cloned()
      let asItIs = tree(home)
      const none = pasted(documented('copy='), home, 'before-nothing', 0, scratch, shell)
      expect([shell, none.code, none.out, none.asked]).toEqual([shell, 1, '', ''])
      expect(none.err).toBe(`There is no copy named before-nothing in ${home}/backend, so nothing was changed.\n`)
      expect(tree(home)).toEqual(asItIs)
      // It still running is found only once the service is stopped, and then the person is told how to start it again
      home = cloned((home) => writeFileSync(path.join(home, 'backend', 'lock'), '{}'))
      asItIs = tree(home)
      const running = pasted(documented('copy='), home, kept[0], 0, scratch, shell)
      expect([shell, running.code, running.out, running.asked]).toEqual([shell, 1, '', 'service uninstall\n'])
      expect(running.err).toBe(`It is still running, so nothing in its folder was changed. Stop it, and run these lines again.\n${SETUP}`)
      expect([tree(home), existsSync(`${home}-after-upgrade`), staged(home)]).toEqual([asItIs, false, []])
      // Putting back a kept folder that is not there is refused before the service is touched
      const nothingKept = pasted(documented('-replaced'), home, undefined, 0, scratch, shell)
      expect([shell, nothingKept.code, nothingKept.asked]).toEqual([shell, 1, ''])
      expect(nothingKept.err).toBe(`There is no folder ${home}-after-upgrade to put back, so nothing was changed.\n`)
    }
    // Where the kept folder cannot be moved into place, It's folder is moved back; where that
    // fails too, the person is told where each folder is. `mv` is a stand-in that refuses to move
    // the folders it is told to, and is the real one otherwise
    const real_mv = spawnSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).stdout.trim()
    const refusingMv = (name: string, refused: string) => {
      const dir = path.join(scratch, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'mv'), `#!/bin/sh\ncase "$1" in ${refused}) echo "mv: cannot move $1" >&2; exit 1 ;; esac\nexec '${real_mv}' "$@"\n`, {
        mode: 0o755,
      })
      return dir
    }
    const keptStays = refusingMv('mv-kept', '*-after-upgrade')
    const bothStay = refusingMv('mv-both', '*-after-upgrade | *-replaced')
    for (const shell of SHELLS) {
      const home = cloned((home) => cpSync(folder, `${home}-after-upgrade`, { recursive: true }))
      const asItIs = tree(home)
      const back = pasted(documented('-replaced'), home, undefined, 0, scratch, shell, keptStays)
      expect([shell, back.code, back.out, back.asked]).toEqual([shell, 1, '', 'service uninstall\n'])
      expect(back.err).toBe(
        `mv: cannot move ${home}-after-upgrade\nThe kept folder could not be moved into place, so It's folder was moved back and nothing in it was changed. Close whatever has a file open in ${home}-after-upgrade, and run these lines again.\n${SETUP}`,
      )
      expect([tree(home), existsSync(`${home}-replaced`), existsSync(`${home}-after-upgrade`)]).toEqual([asItIs, false, true])
      const stuck = pasted(documented('-replaced'), home, undefined, 0, scratch, shell, bothStay)
      expect([shell, stuck.code, stuck.out]).toEqual([shell, 1, ''])
      expect(stuck.err).toBe(
        `mv: cannot move ${home}-after-upgrade\nmv: cannot move ${home}-replaced\nThe kept folder could not be moved into place, and It's folder could not be moved back either. It's folder is now ${home}-replaced, and the kept folder is still ${home}-after-upgrade. Move ${home}-replaced back to ${home} yourself before anything else.\n${SETUP}`,
      )
      expect([existsSync(home), tree(`${home}-replaced`), existsSync(`${home}-after-upgrade`)]).toEqual([false, asItIs, true])
    }
  }, 600_000)

  // Where this machine has no zsh, the lines are not pasted into it, and that is said here as a test left out
  if (!zsh) test.skip('the documented lines pasted into zsh (not run: no zsh on this machine, and IT_TEST_ZSH names none)', () => {})
})
