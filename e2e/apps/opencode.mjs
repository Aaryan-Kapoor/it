// It's OpenCode add-on, run by the real OpenCode, with no account and no real model.
//
//   node e2e/apps/opencode.mjs --package oldest            the oldest OpenCode `it setup` accepts
//   node e2e/apps/opencode.mjs --package opencode-ai@1     the newest OpenCode 1
//   node e2e/apps/opencode.mjs --package @opencode/cli@latest
//   OPENCODE_BIN=/path/to/opencode node e2e/apps/opencode.mjs
//
// Everything happens in one folder of the run's own, which is removed at the end: the home
// folder and the XDG folders that OpenCode and It are given, the folder OpenCode works in, and
// an It of the run's own (IT_HOME, with IT_PORT as its base port, 5900 unless it says otherwise).
// Nothing is read from or written to the home folder of whoever runs it, and no agent app but
// OpenCode is looked for. With --package the named OpenCode is installed from npm into that
// folder; OPENCODE_BIN names one that is already installed. It runs the `it` that IT_BIN (a
// standalone program) or IT_CLI (a Node bundle) names, and otherwise the bundle that
// `npm run generate` builds.
//
// What it checks, in order:
//
//   1. With no model. The real `it setup --only opencode --no-service` puts the add-on into
//      OpenCode. OpenCode is started as `opencode serve`, and is seen to load the add-on:
//      OpenCode 2 lists it among its plugins as active, OpenCode 1's settings name it, its log
//      holds no refusal of it, and the add-on, running inside OpenCode, reports to It's
//      connector as the build that setup put there, which `it status` then calls connected and
//      active. Then It's file is replaced with a plugin of the form this OpenCode refuses.
//      OpenCode is seen to refuse it, and `it status` must say so and must not call it
//      connected. It's own file is put back, as an upgrade puts a newer one, OpenCode loads it,
//      and `it status` calls it connected again.
//   2. With a stand-in for the model. A small server on this machine answers OpenCode by
//      script, as its own settings point it there with a made-up key (model.mjs). The first
//      turn calls the shell tool with `it create … --open` for a page with one button, and ends.
//      A browser paired with It as a person pairs one shows the page and clicks the button.
//      The check passes only once the stand-in is asked again by OpenCode, in the same
//      conversation, with a newest message on the person's side that begins `[It]` and ends
//      `[action <id>]`, and It says the add-on handed the click over. The stand-in answers with
//      `it patch`, and the page's state shows the change.
//   3. Where every check so far passed: OpenCode is stopped, so that the conversation is
//      closed, and the button is pressed again. It's Auto-wake has to reopen the conversation
//      with the real `opencode run --session`, which asks the stand-in with the click, and the
//      stand-in's `it patch` shows on the page. OpenCode 2's run starts OpenCode's background
//      service, which the run stops at the end with `opencode service stop`.
//
// It ends with 0 only when every check passed. Whatever happens, every program it started is
// stopped by its own process id, and the folder is removed (IT_OC_KEEP=1 keeps it).
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterTool, newestUser, standInModel, textOf } from './opencode/model.mjs'
import { homeOnWindows, nodeAlone, processesIn, systemPath, windows } from './windows.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
/**
 * The oldest OpenCode that `it setup` installs the add-on into, as setup itself says it: OpenCode
 * 1 is published as `opencode-ai`.
 */
function oldest() {
  const source = readFileSync(path.join(root, 'packages', 'cli', 'src', 'setup.ts'), 'utf8')
  const min = /\bopencode: \{[^}]*\bmin: '([0-9.]+)'/.exec(source)?.[1]
  if (!min) throw new Error('packages/cli/src/setup.ts names no oldest OpenCode')
  return `opencode-ai@${min}`
}
const PACKAGE = option('--package') === 'oldest' ? oldest() : option('--package')
const PORT = Number(process.env.IT_PORT ?? 5900)
const KEEP = process.env.IT_OC_KEEP === '1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const started = Date.now()
const results = []
/** An address that pairs a browser carries its code after `/pair#`: a credential, which is taken out of all that is printed. */
const unpaired = (text) => String(text).replace(/\/pair#[A-Za-z0-9_-]+/g, '/pair#[a code that pairs a browser]')
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n       ${unpaired(detail).replace(/\n/g, '\n       ')}` : ''}`)
  return Boolean(ok)
}
const section = (title) => console.log(`\n${title} (${Math.round((Date.now() - started) / 1000)} s)`)
async function until(fn, ms = 20_000, every = 250) {
  const end = Date.now() + ms
  for (;;) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => undefined)
    if (v) return v
    if (Date.now() > end) return undefined
    await sleep(every)
  }
}

// ---------- the run's own folder, and what every program it starts is given ----------

// Short, since It's connector listens at a socket inside IT_HOME and a socket's path is limited
const base = mkdtempSync(path.join(process.env.IT_OC_ROOT ?? os.tmpdir(), 'it-oc-'))
const HOME = path.join(base, 'h')
const WORK = path.join(base, 'work')
const IT_HOME = path.join(base, 'it')
for (const d of [HOME, WORK]) mkdirSync(d, { recursive: true })
const XDG = {
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  XDG_DATA_HOME: path.join(HOME, '.local', 'share'),
  XDG_STATE_HOME: path.join(HOME, '.local', 'state'),
  XDG_CACHE_HOME: path.join(HOME, '.cache'),
}
const OC_CONFIG = path.join(XDG.XDG_CONFIG_HOME, 'opencode')
const OC_LOG = path.join(XDG.XDG_DATA_HOME, 'opencode', 'log', 'opencode.log')
const PLUGIN = path.join(OC_CONFIG, 'plugins', 'it-bridge.js')
// Made up for each run, as the model's key is made up: OpenCode's server asks for it, and only
// the programs this run starts are given it
const SERVER_PASSWORD = randomBytes(18).toString('hex')

/** The command that runs It: the standalone program, a bundle named, or the bundle in this checkout. */
const IT_COMMAND = process.env.IT_BIN ? [process.env.IT_BIN] : [process.execPath, process.env.IT_CLI ?? path.join(root, 'packages', 'cli', 'dist', 'it.mjs')]
// On Windows the standalone program is put where It's installer puts it, in It's folder's bin, with
// the record it writes beside it, and run from there: a command OpenCode runs finds it there as `it.exe`
if (windows && process.env.IT_BIN) {
  IT_COMMAND[0] = path.join(IT_HOME, 'bin', 'it.exe')
  mkdirSync(path.dirname(IT_COMMAND[0]), { recursive: true })
  copyFileSync(process.env.IT_BIN, IT_COMMAND[0])
  // INSTALLATION in packages/cli/src/installation.ts
  writeFileSync(path.join(IT_HOME, 'installation.json'), '{"product":"It","format":1,"about":"This folder holds an installation of It."}\n')
}

let opencodeBin = process.env.OPENCODE_BIN
/** The folder whose `opencode` It finds: on Windows that of npm's opencode.cmd, as npm puts it on a person's PATH. */
let opencodeFolder = opencodeBin && path.dirname(opencodeBin)
/** What every program the run starts is given, and nothing else from the environment of whoever runs it. */
function env(extra = {}) {
  const dirs = [opencodeFolder, nodeAlone(path.join(base, 'node')), ...systemPath()].filter(Boolean)
  return {
    PATH: [...new Set(dirs)].join(path.delimiter),
    HOME,
    // On Windows, where a home of the run's own is given by more than HOME
    ...homeOnWindows(HOME),
    ...XDG,
    USER: os.userInfo().username,
    // On Windows no shell is named, as none is in a person's own surroundings there
    ...(windows ? {} : { SHELL: '/bin/bash' }),
    LANG: 'C.UTF-8',
    TMPDIR: path.join(base, 'tmp'),
    IT_HOME,
    IT_PORT: String(PORT),
    // OpenCode is the one agent app It looks for, and T3 Code is nowhere
    IT_HARNESSES: 'opencode',
    T3CODE_HOME: path.join(base, 'no-t3-code'),
    IT_TELEMETRY_ENABLED: '0',
    IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
    ...(process.env.IT_BACKEND_BIN ? { IT_BACKEND_BIN: process.env.IT_BACKEND_BIN } : {}),
    ...(process.env.IT_BACKEND_RELEASES ? { IT_BACKEND_RELEASES: process.env.IT_BACKEND_RELEASES } : {}),
    OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    ...extra,
  }
}
mkdirSync(path.join(base, 'tmp'), { recursive: true })
// What this program itself puts in a temporary folder, the browser's profile among it, goes in the run's own
process.env.TMPDIR = path.join(base, 'tmp')

/** Runs a program to its end. Resolves with its exit code and what it printed. */
/** Ends a program `run` started, with everything in its process group. */
function end(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // The group has gone; the program itself is told, which does nothing where it has gone too
    try {
      child.kill(signal)
    } catch {}
  }
}
/** Set once the run has been told to stop: from then on nothing of the run's own starts but its cleanup. */
let stoppedBy = null
/** The programs `run` is waiting on, which the cleanup ends where it comes first. */
const inFlight = new Set()
function run(cmd, args, { cwd = WORK, ms = 120_000, input, cleanup = false } = {}) {
  if (stoppedBy && !cleanup) return Promise.resolve({ code: -1, out: '', err: `not started: the run was stopped by ${stoppedBy}` })
  return new Promise((resolve) => {
    // In a process group of its own where the system has them, so that ending it ends what it
    // started as well, such as a script npm runs as it installs
    const child = spawn(cmd, args, {
      cwd,
      env: env(),
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    inFlight.add(child)
    child.on('exit', () => inFlight.delete(child))
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    if (input !== undefined) child.stdin.end(input)
    const timer = setTimeout(() => end(child, 'SIGKILL'), ms)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: `${err}${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}
const json = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
const it = (args, opts) => run(IT_COMMAND[0], [...IT_COMMAND.slice(1), ...args], opts)

/** The programs that go on running behind the run, each stopped by its own process id at the end. */
const running = new Map()
function start(name, cmd, args, { cwd = WORK, log } = {}) {
  if (stoppedBy) throw new Error(`${name} was not started: the run was stopped by ${stoppedBy}`)
  const child = spawn(cmd, args, { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
  let said = ''
  const keep = (d) => {
    said += d
    if (said.length > 200_000) said = said.slice(-100_000)
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  if (log) {
    child.stdout.on('data', (d) => log(String(d)))
    child.stderr.on('data', (d) => log(String(d)))
  }
  const one = { child, said: () => said, exited: null }
  child.on('exit', (code, signal) => (one.exited = { code, signal }))
  child.on('error', () => (one.exited = { code: -1 }))
  running.set(name, one)
  return one
}
/** Asks a program to stop, waits for it, and ends it where it has not stopped in time. */
async function stop(name, ms = 30_000) {
  const one = running.get(name)
  if (!one) return true
  running.delete(name)
  if (one.exited) return true
  // It's service, on Windows, which has no signal to ask with, by the file it looks for in its folder
  if (name === 'it' && windows) writeFileSync(path.join(IT_HOME, 'service.stop'), '')
  else one.child.kill('SIGTERM')
  if (await until(() => one.exited, ms, 100)) return true
  one.child.kill('SIGKILL')
  await until(() => one.exited, 5000, 100)
  return false
}

// ---------- OpenCode ----------

async function install() {
  if (!PACKAGE) return
  const into = path.join(base, 'opencode')
  mkdirSync(into, { recursive: true })
  writeFileSync(path.join(into, 'package.json'), '{"private":true}\n')
  // On Windows npm's own script, under the Node that runs this, since npm.cmd is started only through a shell
  const npm = windows ? [process.execPath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')] : ['npm']
  const got = await run(npm[0], [...npm.slice(1), 'install', '--no-audit', '--no-fund', '--loglevel=error', PACKAGE], { cwd: into, ms: 300_000 })
  if (got.code !== 0) throw new Error(`npm could not install ${PACKAGE}: ${got.err.slice(-800)}`)
  opencodeBin = path.join(into, 'node_modules', '.bin', 'opencode')
  opencodeFolder = path.dirname(opencodeBin)
  // On Windows `opencode` there is npm's opencode.cmd, and the program it runs is the package's own opencode.exe
  if (windows)
    opencodeBin = [path.join(into, 'node_modules', 'opencode-ai'), path.join(into, 'node_modules', '@opencode', 'cli')]
      .map((pkg) => path.join(pkg, 'bin', 'opencode.exe'))
      .find((program) => existsSync(program))
}

let version = ''
let major = 0
const ocPort = PORT + 10
const ocUrl = `http://127.0.0.1:${ocPort}`

/** Starts `opencode serve` in the working folder, and waits until it listens. */
async function startOpenCode() {
  const one = start('opencode', opencodeBin, ['serve', '--hostname', '127.0.0.1', '--port', String(ocPort)])
  const listening = await until(() => /listening on http/.test(one.said()) || one.exited, 60_000, 100)
  if (!listening || one.exited) throw new Error(`opencode serve did not start: ${one.said().slice(-800)}`)
  // OpenCode sets a folder up, and loads its plugins, when something first asks about it
  await ocPlugins()
}
/**
 * The plugins OpenCode has for the working folder, as it says itself. OpenCode 2 lists each
 * one with whether it is active or failed, and why; OpenCode 1 lists the files its settings
 * name, and says nothing of how loading them went.
 */
async function ocPlugins() {
  if (major >= 2) {
    const got = await ocApi(`/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(WORK)}`)
    return (got.body?.data ?? []).map((p) => ({ id: p.id, path: p.source?.path, state: p.state?.status, error: p.state?.error }))
  }
  const got = await ocApi(`/config?directory=${encodeURIComponent(WORK)}`)
  return (got.body?.plugin ?? []).map((p) => ({ path: String(p).replace(/^file:\/\//, '') }))
}
/** Whether OpenCode holds a piece of text among the messages of the conversation with this id. */
/**
 * Whether OpenCode holds a click, as a message on the person's side, in the conversation with
 * this id: one that begins `[It]` and names the action, and, where `ends`, ends with its name as
 * a live click does. OpenCode 2 lists a conversation's messages each with its `type` and `text`;
 * OpenCode 1 lists each with its `info.role` and its parts.
 */
async function storedIn(id, action, { ends = false } = {}) {
  if (!id || !action) return false
  const route = major >= 2 ? `/api/session/${id}/message?limit=200` : `/session/${id}/message?directory=${encodeURIComponent(WORK)}`
  const got = await ocApi(route)
  if (got.status !== 200) return false
  const users =
    major >= 2
      ? (got.body?.data ?? []).filter((m) => m?.type === 'user').map((m) => (typeof m.text === 'string' ? m.text : ''))
      : (Array.isArray(got.body) ? got.body : [])
          .filter((m) => m?.info?.role === 'user')
          .map((m) =>
            (m.parts ?? [])
              .filter((part) => part?.type === 'text')
              .map((part) => part.text ?? '')
              .join(''),
          )
  const name = `[action ${action}]`
  return users.some((t) => t.trim().startsWith('[It]') && (ends ? t.trim().endsWith(name) : t.includes(name)))
}
// On Windows OpenCode 1 names a plugin by its file URL's path, as /C:/…, in forward slashes
const samePath = (a) => (windows ? Boolean(a) && path.resolve(String(a).replace(/^\/(?=[A-Za-z]:)/, '')).toLowerCase() === PLUGIN.toLowerCase() : a === PLUGIN)
const itsPlugin = (plugins) => plugins.find((p) => samePath(p.path))
const ocApi = async (route, init = {}) => {
  const res = await fetch(`${ocUrl}${route}`, {
    ...init,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${SERVER_PASSWORD}`).toString('base64')}`, ...(init.headers ?? {}) },
  })
  return { status: res.status, body: json(await res.text()) }
}
/** What OpenCode's log holds, from a given length on. */
const ocLog = (from = 0) => {
  try {
    return readFileSync(OC_LOG, 'utf8').slice(from)
  } catch {
    return ''
  }
}
const ocLogLength = () => {
  try {
    return statSync(OC_LOG).size
  } catch {
    return 0
  }
}
/** OpenCode's own lines that say it refused It's file. */
function ocSaysOfPlugin(text) {
  const lines = text.split('\n').filter((l) => l.includes('it-bridge.js'))
  return { refused: lines.filter((l) => /(msg|message)="failed to load plugin"/.test(l)) }
}

// ---------- It ----------

/** OpenCode as `it status` has it: the harness entry, and the connector's view of the add-on. */
async function statusOfOpenCode() {
  const got = await it(['status'])
  const s = json(got.out)
  return { status: s, oc: s?.harnesses?.find((h) => h.id === 'opencode') }
}
/** The build of the add-on that setup put in OpenCode's plugins folder. */
const buildIn = (file) => /const ADDON_VERSION = '([^']+)'/.exec(readFileSync(file, 'utf8'))?.[1]

// ---------- what part 2 says and looks for ----------

const PAGE = 'opencode-check'
const ASK = 'Make me a page with one button that I can press. (stand-in turn: page)'
/** The newest click's id, once the stand-in has seen it, and every click it has seen, in order. */
let clicked
/** What `it action` last said of the click Auto-wake took, for a failed check to show. */
let lastAction = ''
const heard = []
/** What the stand-in was asked that its script has no answer for, for a failed check to show. */
const others = []
/** The tab that shows the page, and the first turn's message, which part 3 goes on from. */
let shownIn
let conversation
/** The id OpenCode gave the conversation the first turn made. */
let sessionId
/** Which of the stand-in's answers it gave, in order, for the checks to read. */
const answered = []

/** The name of the shell tool in a request: `bash` in OpenCode 1, `shell` in OpenCode 2. */
const shellTool = (request) => {
  const names = (request.tools ?? []).map((t) => t?.function?.name)
  return names.includes('bash') ? 'bash' : names.includes('shell') ? 'shell' : undefined
}
const shellCall = (request, command, description) => {
  const name = shellTool(request)
  return name ? { tool: { name, args: name === 'bash' ? { command, description } : { command } } } : { text: 'No shell tool was offered.' }
}

// ---------- the run ----------

let model
let browser
/** The browser's launch while it is under way. */
let launching
let failed = false
let cleaning = null
/** Stops everything the run started, removes its folder, says how the run went, and ends it. Run once, however the run ends. */
function cleanUp(signal) {
  // A signal that comes while the cleanup is under way is still a run that did not pass
  if (signal) stoppedBy ??= signal
  cleaning ??= (async () => {
    // What the run was waiting on when it was told to stop is ended first, before its folder goes
    // Each one's whole process group is asked, and then ended, also where the program itself has
    // gone by then and something it started is still there: a group outlives its first program
    const groups = [...inFlight]
    for (const child of groups) end(child, 'SIGTERM')
    await until(() => inFlight.size === 0, 5000, 100)
    for (const child of groups) end(child, 'SIGKILL')
    // A browser still being launched is waited for, so that it is closed too
    const launched = await launching?.catch(() => undefined)
    await (browser ?? launched)?.close().catch(() => {})
    const ocStopped = await stop('opencode')
    // Auto-wake's `opencode run` of OpenCode 2 starts OpenCode's background service, which goes
    // on running by design; it is asked to stop with OpenCode's own command
    if (major >= 2 && opencodeBin) await run(opencodeBin, ['service', 'stop'], { ms: 30_000, cleanup: true })
    const itStopped = await stop('it', 90_000)
    for (const name of [...running.keys()]) await stop(name)
    await model?.close().catch(() => {})
    if (!ocStopped) check('OpenCode stopped when it was asked to', false)
    if (!itStopped) check('It stopped when it was asked to', false)
    const left = leftRunning()
    check('nothing the run started is left running', left.length === 0, left.join('\n'))
    if (results.some((r) => !r.ok)) {
      console.log('\nThe end of OpenCode’s log:')
      console.log(
        ocLog()
          .split('\n')
          .filter((l) => /level=(WARN|ERROR)|plugin|it-bridge/i.test(l))
          .slice(-40)
          .join('\n'),
      )
    }
    if (KEEP) console.log(`\nKept: ${base}`)
    else rmSync(base, { recursive: true, force: true, maxRetries: 5 })
    if (stoppedBy) check(`the run went to its end, and was not stopped by ${stoppedBy}`, false)
    const bad = results.filter((r) => !r.ok)
    console.log(
      `\n${results.length - bad.length} of ${results.length} checks passed with OpenCode ${version || '(unknown)'}, in ${Math.round((Date.now() - started) / 1000)} s`,
    )
    process.exit(bad.length || failed ? 1 : 0)
  })()
  return cleaning
}
// A run that is cancelled, or that runs out of time, still stops what it started and removes its folder
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void cleanUp(signal))
try {
  section('Installing OpenCode')
  await install()
  if (!opencodeBin || !existsSync(opencodeBin)) throw new Error('No OpenCode: give --package <npm spec> or OPENCODE_BIN')
  const v = await run(opencodeBin, ['--version'])
  version = /(\d+\.\d+\.\d+)/.exec(`${v.out}${v.err}`)?.[1] ?? ''
  major = Number(version.split('.')[0])
  check(`OpenCode says its version (${version || 'none'})`, Boolean(version), `${v.out}${v.err}`)
  console.log(`OpenCode ${version}${PACKAGE ? `, from ${PACKAGE}` : ''}`)

  // The stand-in for the model, and OpenCode's settings that point it there, are in place
  // before OpenCode first starts, so that it is started once for the whole run
  model = await standInModel(script, { port: PORT + 20 })
  mkdirSync(OC_CONFIG, { recursive: true })
  writeFileSync(
    path.join(OC_CONFIG, 'opencode.json'),
    `${JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        autoupdate: false,
        share: 'disabled',
        provider: {
          standin: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Stand-in',
            options: { baseURL: model.url, apiKey: 'made-up-key' },
            models: { model: { name: 'Stand-in model', tool_call: true } },
          },
        },
        model: 'standin/model',
        small_model: 'standin/model',
      },
      null,
      2,
    )}\n`,
  )
  execFileSync('git', ['init', '-q'], { cwd: WORK, env: env() })

  // ---------- part 1 ----------
  section('Part 1: OpenCode loads It’s add-on, with no model')
  const setup = await it(['setup', '--only', 'opencode', '--no-service'], { ms: 300_000 })
  const set = json(setup.out)
  check('`it setup --only opencode --no-service` succeeds', setup.code === 0 && set, `exit ${setup.code}\n${setup.err.slice(-1500)}`)
  const found = set?.harnesses?.find((h) => h.id === 'opencode')
  check(`setup finds OpenCode at the version it runs (${found?.version})`, found?.version === version, JSON.stringify(found))
  check(
    'setup says it installed the add-on into OpenCode',
    set?.addons?.some((a) => a.id === 'opencode' && a.did === 'installed'),
    JSON.stringify(set?.addons),
  )
  check('the add-on is in OpenCode’s plugins folder', existsSync(PLUGIN), PLUGIN)
  const build = existsSync(PLUGIN) ? buildIn(PLUGIN) : undefined
  check(`the add-on in place names its build (${build})`, build && build !== 'IT_ADDON_BUILD')

  start('it', IT_COMMAND[0], [...IT_COMMAND.slice(1), 'serve'])
  const up = await until(
    async () => {
      const { status } = await statusOfOpenCode()
      return status?.running && status?.connector?.ok && status
    },
    180_000,
    1000,
  )
  check('It is running with its connector', up, running.get('it')?.said().slice(-1500))
  if (!up) throw new Error('It did not start')

  const logFrom = ocLogLength()
  await startOpenCode()
  const active = await until(
    async () => {
      const { oc } = await statusOfOpenCode()
      return oc?.runtime?.state === 'active' && oc
    },
    60_000,
    500,
  )
  const said = ocSaysOfPlugin(ocLog(logFrom))
  check('OpenCode does not refuse It’s add-on', said.refused.length === 0, said.refused.join('\n'))
  const listed = itsPlugin(await ocPlugins())
  if (major >= 2)
    check(
      'OpenCode lists It’s add-on among its plugins, by its id, as active',
      listed?.id === 'it-bridge' && listed?.state === 'active',
      JSON.stringify(listed ?? (await ocPlugins()).filter((p) => p.path)),
    )
  else check('OpenCode’s own settings list It’s add-on among its plugins', listed, JSON.stringify(await ocPlugins()))
  check(
    'the add-on, running inside OpenCode, reports to It’s connector as the build setup put there',
    Boolean(build) && active?.runtime?.version === build,
    JSON.stringify(active ?? (await statusOfOpenCode()).oc),
  )
  check('`it status` calls OpenCode connected and its add-on active', active?.addon === 'connected', JSON.stringify(active))

  // A plugin in the form this OpenCode refuses, at It's path: OpenCode 2 refuses one that only
  // names its export, which is how It's add-on was written before #424, and OpenCode 1 refuses
  // a default export that has an id and no `server` function
  section('Part 1: an add-on OpenCode refuses is said, and not called connected')
  await stop('opencode')
  const original = readFileSync(PLUGIN)
  const refusedFrom = ocLogLength()
  writeFileSync(
    PLUGIN,
    major >= 2
      ? "// A plugin in OpenCode 1's form alone, which OpenCode 2 refuses\nexport const ItBridge = async () => ({})\n"
      : "// A plugin in OpenCode 2's form alone, which OpenCode 1 refuses\nexport default { id: 'it-bridge', setup: async () => {} }\n",
  )
  await startOpenCode()
  const refusal = await until(
    () => {
      const r = ocSaysOfPlugin(ocLog(refusedFrom)).refused
      return r.length > 0 && r
    },
    30_000,
    250,
  )
  check(`OpenCode ${version} refuses that file, and says so in its log`, refusal, ocLog(refusedFrom).slice(-1500))
  if (major >= 2) {
    // OpenCode writes the refusal to its log before its list of plugins has the file, so the list is asked until it does
    const failedOne = await until(
      async () => {
        const one = itsPlugin(await ocPlugins())
        return one?.state === 'failed' && one
      },
      15_000,
      250,
    )
    check(
      'OpenCode lists that file among its plugins as failed',
      failedOne?.state === 'failed',
      JSON.stringify(failedOne || itsPlugin(await ocPlugins()) || (await ocPlugins()).filter((p) => p.path)),
    )
  }
  const saidRefused = await until(
    async () => {
      const { oc } = await statusOfOpenCode()
      return oc?.runtime?.state === 'incompatible' && oc
    },
    30_000,
    500,
  )
  const nowOc = saidRefused ?? (await statusOfOpenCode()).oc
  check('`it status` says OpenCode refused the add-on', saidRefused, JSON.stringify(nowOc))
  check('`it status` does not call OpenCode connected', nowOc && nowOc.addon !== 'connected', JSON.stringify(nowOc))

  // It's own file is put back as an upgrade puts a newer one, and the refusal is over once
  // the add-on that OpenCode then loads reports
  section('Part 1: It’s add-on put back, OpenCode loads it, and the refusal is over')
  await stop('opencode')
  writeFileSync(PLUGIN, original)
  const backFrom = ocLogLength()
  await startOpenCode()
  const back = await until(
    async () => {
      const { oc } = await statusOfOpenCode()
      return oc?.runtime?.state === 'active' && oc?.addon === 'connected' && oc
    },
    60_000,
    500,
  )
  check('OpenCode loads it, and `it status` calls it connected and active again', back, JSON.stringify((await statusOfOpenCode()).oc))
  check('OpenCode does not refuse it', ocSaysOfPlugin(ocLog(backFrom)).refused.length === 0, ocLog(backFrom).slice(-1500))

  // ---------- part 2 ----------
  section('Part 2: a click on a page comes back into the conversation as a turn')
  await part2()

  // ---------- part 3 ----------
  if (results.every((r) => r.ok)) {
    section('Part 3: a click on a page whose conversation is closed reopens it')
    await part3()
  }
} catch (err) {
  failed = true
  check('the run went to its end', false, unpaired(err?.stack ?? err))
} finally {
  await cleanUp()
}

/**
 * Programs still running whose environment names the run's home folder: started by OpenCode or
 * by It on the run's behalf, such as a background service of OpenCode's. Each is ended, by its
 * own process id, and named. Linux alone can be asked this way.
 */
function leftRunning() {
  // On Windows, by the run's folder: in the program's path or its command line
  if (windows)
    return (processesIn(base) ?? [{ pid: null, command: '(the processes on this machine could not be listed)' }]).map(({ pid, command }) => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
      return `${pid} ${command}`
    })
  if (process.platform !== 'linux') return []
  const left = []
  let pids = []
  try {
    pids = execFileSync('ps', ['-e', '-o', 'pid='], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean)
  } catch {
    return []
  }
  for (const pid of pids) {
    if (pid === process.pid) continue
    let environ
    try {
      environ = readFileSync(`/proc/${pid}/environ`, 'utf8')
    } catch {
      continue
    }
    if (!environ.split('\0').includes(`HOME=${HOME}`)) continue
    let cmd = ''
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
    } catch {}
    left.push(`${pid} ${cmd}`)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  return left
}

// ---------- part 2: the stand-in for the model, and the click ----------

// On Windows OpenCode runs a command in Windows PowerShell 5.1, and the agent does as It's skill
// says there (addons/skill/more/page.md, "On Windows"): it runs It as `it.exe`, since a bare `it`
// there may be Pester's own command, and gives JSON in a file, since that PowerShell takes the
// double quotes out of an argument. The file is written here, as the agent writes it with its own
// file tool, in the temporary folder. The Node bundle has no it.exe, only It's it.cmd, which is `it`.
function itName() {
  return windows && process.env.IT_BIN ? 'it.exe' : 'it'
}
function json_(value, as) {
  if (!windows) return as === 'state' ? `--state '${JSON.stringify(value)}'` : `'${JSON.stringify(value)}'`
  const file = path.join(HOME, 'AppData', 'Local', 'Temp', `${as}-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify(value))
  return `${as === 'state' ? '--state-file' : '--file'} "${file.replaceAll('\\', '/')}"`
}

/** What the stand-in answers each request with: the whole script of the conversation. */
function script(request) {
  // OpenCode asks for a conversation's title with no tools, and is given one
  if (!request.tools?.length) return answered.push('title') && { text: 'A page with a button' }
  const said = textOf(newestUser(request))
  if (afterTool(request)) return answered.push('done') && { text: 'Done.' }
  // A click handed to an open conversation ends with its action's id; one that Auto-wake reopens
  // a conversation for has It's word about the reopening after it
  const action = /^\[It\][\s\S]*?\[action ([^\]\s]+)\]/.exec(said.trim())
  if (action) {
    clicked = action[1]
    if (!heard.includes(clicked)) heard.push(clicked)
    answered.push('patch')
    const pings = heard.indexOf(clicked) + 1
    return shellCall(request, `${itName()} patch ${PAGE} ${json_({ pings, heard: clicked }, 'patch')}`, 'Shows on the page that the click was heard')
  }
  if (said.includes('(stand-in turn: page)')) {
    answered.push('create')
    const html = '<p>Pressed: <b id="n" data-it-bind="pings">0</b></p><button id="ping" onclick="It.action(`ping`)">Press</button>'
    return shellCall(
      request,
      `${itName()} create 'A page with a button' --id ${PAGE} --html '${html}' ${json_({ pings: 0 }, 'state')} --open`,
      'Makes the page',
    )
  }
  answered.push('other')
  others.push(said.slice(0, 600))
  return { text: 'I have nothing to do for that.' }
}

async function part2() {
  const { chromium } = await import('playwright')
  // Given what every other program of the run is given, so that it is found by the sweep at the
  // end. Playwright would end the whole run on a signal, before it has stopped anything else, so
  // the run's own handling of a signal closes the browser with the rest.
  if (stoppedBy) throw new Error(`the browser was not started: the run was stopped by ${stoppedBy}`)
  launching = chromium.launch({ env: env(), handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false })
  browser = await launching
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const tab = await context.newPage()
  // The address `it site` prints pairs one browser as the owner's. It is a credential, and is
  // never printed.
  const site = json((await it(['site', '--no-open'])).out)
  if (!site?.url) throw new Error('`it site --no-open` gave no address')
  await tab.goto(site.url)
  const paired = await until(() => tab.locator('header.bar').isVisible(), 20_000)
  check('a browser is paired with It as a person pairs one', paired)
  if (!paired) throw new Error('the browser was not paired')

  // The first turn, sent as a person sends one: `opencode run`, against the OpenCode that is
  // running, which holds the conversation after the run has ended
  model.skip()
  const turn = start('turn', opencodeBin, ['run', major >= 2 ? '--server' : '--attach', ocUrl, '--format', 'json', ASK])
  const created = await until(() => answered.includes('create'), 60_000)
  check('OpenCode asks the stand-in for the first turn, and is told to make the page', created, `${turn.said().slice(-1500)}\nanswered: ${answered}`)
  const first = model.requests.find((r) => textOf(newestUser(r)).includes('(stand-in turn: page)') && r.tools?.length)
  const system = (first?.messages ?? [])
    .filter((m) => m.role === 'system')
    .map(textOf)
    .join('\n')
  check('the add-on told the agent of It among its instructions', system.includes('It is set up on this machine'))
  const done = await until(() => answered.includes('done'), 60_000)
  const result = model.requests.find((r) => afterTool(r) && textOf(newestUser(r)).includes('(stand-in turn: page)'))
  const output = textOf(result?.messages?.at(-1))
  check(
    'OpenCode ran `it create --open`, and the turn ended',
    done && /"id":\s*"opencode-check"/.test(output),
    `${output.slice(0, 1500)}\nanswered: ${answered}\nthe stand-in was last sent: ${JSON.stringify(model.requests.at(-1)?.messages?.slice(-2) ?? null).slice(0, 1500)}\n${turn.said().slice(-800)}`,
  )
  // `opencode run` of OpenCode 1 stays attached once the turn is over; the conversation is held
  // by the OpenCode it was attached to, so ending it ends nothing of the conversation
  await until(() => running.get('turn')?.exited, 5000)
  sessionId = /"sessionID":"(ses_[A-Za-z0-9]+)"/.exec(turn.said())?.[1]
  check('`opencode run` names the conversation it made', sessionId, turn.said().slice(-800))
  await stop('turn', 5000)

  conversation = first?.messages?.find((m) => m.role === 'user' && textOf(m).includes('(stand-in turn: page)'))
  const shown = await until(async () => (await tab.frameLocator('.mount iframe').locator('#ping').isVisible()) && true, 30_000)
  check('`--open` shows the page in the paired browser', shown, `the tab is at ${tab.url()}`)
  if (!shown) throw new Error('the page was not shown')

  // The page's id is no secret; the action's id comes back to the stand-in in OpenCode's message
  model.skip()
  await tab.frameLocator('.mount iframe').locator('#ping').click()
  const asked = await until(() => clicked, 60_000)
  const turn2 = model.requests.find((r) => /^\[It\]/.test(textOf(newestUser(r)).trim()) && r.tools?.length)
  const said = textOf(newestUser(turn2)).trim()
  check(
    'OpenCode asks the stand-in anew, with a newest message that begins `[It]` and ends `[action <id>]`',
    asked && /^\[It\][\s\S]*\[action [^\]\s]+\]$/.test(said),
    `requests since the click: ${model.requests.length}; answered: ${answered}`,
  )
  check(
    'in the same conversation: the request carries the first turn',
    turn2?.messages?.some((m) => m.role === 'user' && conversation && textOf(m) === textOf(conversation)),
    said.slice(0, 500),
  )
  check(`the message names the page (${PAGE})`, said.includes(PAGE), said.slice(0, 500))
  check(
    'OpenCode keeps the click in the conversation the first turn made, by its id',
    await until(() => storedIn(sessionId, clicked, { ends: true }), 20_000, 500),
    `conversation ${sessionId}, action ${clicked}`,
  )
  // Auto-wake could have answered the click by reopening the conversation in another OpenCode
  // of its own, which would have asked the stand-in in the same way. It says which way went.
  const handed = await until(
    async () => {
      const a = json((await it(['action', clicked ?? 'none'])).out)
      return a?.route && a
    },
    20_000,
    500,
  )
  const way = { delivery: handed?.delivery, route: handed?.route, outcome: handed?.outcome }
  check(
    'It says the add-on in the running OpenCode handed the click over, and not Auto-wake',
    way.route === 'addon' && way.delivery === 'handed_off',
    JSON.stringify(way),
  )

  const patched = await until(
    async () => {
      const state = json((await it(['state', PAGE])).out)
      return state?.state?.pings === 1 && state
    },
    60_000,
    500,
  )
  check('the stand-in’s `it patch` ran, and the page’s state shows the change', patched && clicked && patched.state.heard === clicked, JSON.stringify(patched))
  const onPage = await until(async () => (await tab.frameLocator('.mount iframe').locator('#n').innerText()) === '1', 20_000)
  check('the page in the browser shows it', onPage)
  shownIn = tab
}

/**
 * A click on a page whose conversation is closed: OpenCode is stopped, and It's Auto-wake has to
 * reopen the conversation with the real `opencode run --session`, which asks the stand-in with
 * the click as the newest message, and the stand-in's `it patch` shows on the page.
 */
async function part3() {
  await stop('opencode')
  const before = heard.length
  const at = model.requests.length
  await shownIn.frameLocator('.mount iframe').locator('#ping').click()
  // Auto-wake waits a while before it reopens a conversation, so that an add-on can take the click first
  const asked = await until(() => heard.length > before, 180_000, 500)
  const woken = model.requests.slice(at).find((r) => /^\[It\]/.test(textOf(newestUser(r)).trim()) && r.tools?.length)
  check('Auto-wake reopens the closed conversation, and OpenCode asks the stand-in with the click', asked, `answered: ${answered}\n${others.join('\n---\n')}`)
  check(
    'in the same conversation: the request carries the first turn',
    woken?.messages?.some((m) => m.role === 'user' && conversation && textOf(m) === textOf(conversation)),
  )
  const second = heard[before]
  // OpenCode is started again to be asked which conversation holds the click
  await startOpenCode()
  check(
    'OpenCode keeps that click in the same conversation, by its id',
    await until(() => storedIn(sessionId, second), 20_000, 500),
    `conversation ${sessionId}, action ${second}`,
  )
  // A conversation It reopens is written down as handed over by way of the queue, which for an
  // app with no queue of its own, as OpenCode has none, is the reopening alone
  const handed = await until(
    async () => {
      const got = await it(['action', second ?? 'none'])
      const a = json(got.out)
      lastAction = a ? `${a.delivery} ${a.route}` : `${got.code} ${got.err.slice(-300)}`
      return a?.route && a
    },
    20_000,
    500,
  )
  check(
    'It says the click was handed over by reopening the conversation, and not by an add-on',
    handed?.delivery === 'handed_off' && handed?.route === 'queue',
    lastAction,
  )
  const patched = await until(
    async () => {
      const state = json((await it(['state', PAGE])).out)
      return state?.state?.pings === 2 && state
    },
    60_000,
    500,
  )
  check(
    'the stand-in’s `it patch` ran, and the page’s state shows the second click',
    patched && second && patched.state.heard === second,
    JSON.stringify(patched),
  )
}
