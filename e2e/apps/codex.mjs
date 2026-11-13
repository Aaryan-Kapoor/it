// It's Codex add-on, against the real Codex program, with no account and no real model.
//
//   node e2e/apps/codex.mjs <the codex program> [--version <x.y.z>]
//
// Everything runs in a folder of its own: a home, a CODEX_HOME and an It folder that nothing
// else uses, so that the Codex and the It of whoever runs it are never read or written. It is
// started on IT_PORT, or 5700, and the stand-in model listens on the port 90 above it.
//
// What it proves, in this order:
//
// 1. With no model. The real `it setup --only codex` installs the add-on with Codex's own
//    commands, and Codex itself then says that the plugin is installed and on, and that its four
//    hooks are there and not yet approved: `codex plugin list`, and `hooks/list` asked of Codex's
//    own app server. `it status` says the same. Turned off in Codex's own settings, both say it is
//    off, and turned on again, both say it is on. Then the person's own step is taken in Codex's
//    own terminal interface, run in a terminal of its own: it says the hooks need review, and
//    "Trust all and continue" is chosen. Codex then says the hooks are trusted, and `it status`
//    says the add-on is connected.
// 2. With a stand-in for the model. Codex is pointed at a stand-in on this machine through its
//    own settings (`model_providers.<id>.base_url`, with a made-up key), and a prompt is typed into
//    that same terminal. The stand-in answers with a command that runs `it create --open`, and the
//    page comes up on a browser paired as the owner's. The page is clicked as a person clicks it.
//    The check passes only when the stand-in is then asked again, in the same conversation, in a
//    new turn whose newest message from the person is It's mark, `[It]`, followed by what It's
//    own `UserPromptSubmit` hook adds to the turn: the click's line, which begins `[It]` and ends
//    with `[action <id>]` for that click. (That is how It hands a click to a Codex conversation
//    in which a hook of its own has run: the mark goes through Codex's queue, and the hook gives
//    the agent the rest.) It answers with `it patch`, and the page's state shows it.
// 3. A click on a page whose conversation is closed: Codex's terminal is left and its background
//    server stopped, the page is clicked again, and It reopens the conversation through the real
//    Codex (`codex exec resume`, which is Auto-wake), which asks the stand-in in the same
//    conversation with a newest message from the person that begins `[It]` and holds the
//    click's line, ending with its `[action <id>]`.
//
// It runs on Linux, and on macOS too (where, with Codex 0.160.0 and 0.169.0, the click in step 2
// was not handed over while Codex's terminal had the conversation open). Windows has no
// pseudo-terminal for Codex's terminal interface. What it does not prove: anything a real model
// does, Codex's desktop app, or Codex inside T3 Code. The approval is chosen in Codex's own
// terminal interface, which is the step a person takes there; where Codex shows no such question
// (its desktop app, T3 Code) nothing here stands for what a person does.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { standInModel, textOf } from './codex/model.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const args = process.argv.slice(2)
const program = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null
const option = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
if (!program || !existsSync(program)) {
  console.error('Give the path of the codex program to test: node e2e/apps/codex.mjs <codex> [--version <x.y.z>]')
  process.exit(2)
}
const wanted = option('--version')
const base = Number(process.env.IT_PORT || 5700)
const modelPort = base + 90
const CLI = process.env.IT_CLI ? path.resolve(process.env.IT_CLI) : path.join(root, 'packages', 'cli', 'dist', 'it.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  const said = ok ? '' : `\n      ${String(detail).replace(/\s+/g, ' ').slice(0, 900)}`
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${said}`)
  return Boolean(ok)
}

// The run's own folder. Codex refuses to put its helper programs under a temporary folder and
// says so, which changes nothing here.
const top = mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'it-codex-'))
const home = path.join(top, 'home')
const codexHome = path.join(home, '.codex')
const itHome = path.join(home, '.it')
const work = path.join(home, 'work')
for (const folder of [codexHome, work, path.join(top, 'no-t3-code')]) mkdirSync(folder, { recursive: true })
const logs = path.join(top, 'logs')
mkdirSync(logs)

// What every program the run starts is given, and nothing else of this process's surroundings:
// the agent apps of whoever runs it, and their It, are not to be found from here.
const env = {
  PATH: [path.join(itHome, 'bin'), path.dirname(program), path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(
    path.delimiter,
  ),
  HOME: home,
  CODEX_HOME: codexHome,
  IT_HOME: itHome,
  IT_PORT: String(base),
  T3CODE_HOME: path.join(top, 'no-t3-code'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  XDG_STATE_HOME: path.join(home, '.local', 'state'),
  IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
  LANG: 'C.UTF-8',
  // The made-up key that Codex sends the stand-in model, as its settings below tell it to
  IT_E2E_MODEL_KEY: 'made-up-key-for-a-stand-in',
  ...(process.env.IT_BACKEND_BIN ? { IT_BACKEND_BIN: process.env.IT_BACKEND_BIN } : {}),
}

/** Runs a program to its end, within `ms`, and resolves with its exit code and what it printed. */
function run(command, argv, { input, ms = 120_000, cwd = home } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { env, cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    if (input !== undefined) child.stdin.end(input)
    const late = setTimeout(() => child.kill('SIGKILL'), ms)
    child.on('error', (e) => {
      clearTimeout(late)
      resolve({ code: null, out, err: `${err}${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(late)
      resolve({ code, out, err })
    })
  })
}
const codex = (argv, opts) => run(program, argv, opts)
/** Runs `it` as the machine of this run, and resolves with what it answered, read as JSON where it is. */
async function it(argv, opts) {
  const r = await run(process.execPath, [CLI, ...argv], opts)
  let json
  try {
    json = JSON.parse(r.out)
  } catch {}
  return { ...r, json }
}
const codexState = async () => (await it(['status'])).json?.harnesses?.find((h) => h.id === 'codex')

/** Asks a program to stop and waits for it, ending it outright after `ms`. */
function stopped(child, ms = 10_000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve()
    const hard = setTimeout(() => child.kill('SIGKILL'), ms)
    const never = setTimeout(resolve, ms + 4000)
    child.once('close', () => {
      clearTimeout(hard)
      clearTimeout(never)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

/**
 * Codex's own app server, spoken to over its standard input and output as its clients speak to
 * it, for what Codex itself says about its hooks and to change its settings as its clients do.
 */
async function appServer() {
  const child = spawn(program, ['app-server', '--listen', 'stdio://'], { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  let next = 1
  const waiting = new Map()
  child.stderr.on('data', () => {})
  child.stdout.on('data', (d) => {
    buf += d
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let m
      try {
        m = JSON.parse(line)
      } catch {
        continue
      }
      if (m.id !== undefined && waiting.has(m.id)) {
        const { resolve, reject } = waiting.get(m.id)
        waiting.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      }
    }
  })
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++
      const late = setTimeout(() => waiting.delete(id) && reject(new Error(`Codex's app server did not answer ${method} within a minute`)), 60_000)
      waiting.set(id, {
        resolve: (v) => {
          clearTimeout(late)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(late)
          reject(e)
        },
      })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  child.on('close', () => {
    for (const [id, { reject }] of waiting) {
      waiting.delete(id)
      reject(new Error('Codex’s app server ended'))
    }
  })
  try {
    await request('initialize', { clientInfo: { name: 'it-ci', title: 'It CI', version: '0' }, capabilities: { experimentalApi: true } })
  } catch (err) {
    // An app server that will not begin is stopped here, since nobody is given a way to close it
    await stopped(child, 5000)
    throw err
  }
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
  return {
    request,
    close: async () => {
      child.stdin.end()
      await stopped(child, 5000)
    },
  }
}
/** It's hooks, as Codex's own app server lists them for the work folder. */
async function itsHooks() {
  const server = await appServer()
  try {
    const listed = await server.request('hooks/list', { cwds: [work] })
    return (listed?.data ?? []).flatMap((entry) => entry.hooks ?? []).filter((h) => h.pluginId === 'it-bridge@it')
  } finally {
    await server.close()
  }
}
const pluginLine = async () => {
  const r = await codex(['plugin', 'list', '--marketplace', 'it'])
  return r.out.split('\n').find((line) => line.startsWith('it-bridge@it')) ?? `(no line for it-bridge@it) ${r.out} ${r.err}`
}

/**
 * Codex's own terminal interface, in a terminal of its own, as a person runs `codex` in a
 * window. What it shows is kept, and read with its terminal's codes taken out.
 */
function terminal() {
  const child = spawn('python3', [path.join(here, 'codex', 'terminal.py'), '120', '40', program], { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'] })
  let shown = ''
  child.stdout.on('data', (d) => (shown += d))
  child.stderr.on('data', (d) => (shown += d))
  const plain = (from = 0) =>
    shown
      .slice(from)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's codes begin with ESC
      .replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>()78][A-Za-z0-9]?/g, '')
  return {
    child,
    mark: () => shown.length,
    plain,
    type: (keys) => child.stdin.write(keys),
    until: async (pattern, ms, from = 0) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (pattern.test(plain(from).replace(/\s+/g, ''))) return true
        if (child.exitCode !== null) return false
        await sleep(200)
      }
      return false
    },
  }
}

/**
 * The processes this run started, found by what they were given: every program the run starts
 * is given its CODEX_HOME and IT_HOME, which are folders made for this run alone, and Codex and
 * It hand them on to what they start in turn. `which` picks one of the two. Only processes of
 * the same user can be read, which is all this run starts.
 */
function ours(which = 'IT_HOME') {
  const folder = which === 'IT_HOME' ? itHome : codexHome
  const found = []
  // A Mac has no /proc. Its `ps` shows each process's environment after its command, for the
  // processes of the same user, and a folder of this run's names nothing else
  if (process.platform === 'darwin') {
    const listed = spawnSync('ps', ['-E', '-ww', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout ?? ''
    for (const line of listed.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (!m || Number(m[1]) === process.pid) continue
      if (!` ${m[2]} `.includes(` ${which}=${folder} `)) continue
      found.push({ pid: Number(m[1]), command: m[2].split(' ') })
    }
    return found
  }
  const mark = `${which}=${folder}\0`
  let pids = []
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  } catch {
    return found
  }
  for (const pid of pids.map(Number)) {
    if (pid === process.pid) continue
    try {
      if (!`${readFileSync(`/proc/${pid}/environ`, 'latin1')}\0`.includes(mark)) continue
      found.push({ pid, command: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) })
    } catch {}
  }
  return found
}
/** Asks each process to stop, waits up to `ms` for all of them, ends those left outright, and says which were. */
async function ended(list, ms = 10_000) {
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (const { pid } of list) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  for (const end = Date.now() + ms; Date.now() < end && list.some(({ pid }) => alive(pid)); ) await sleep(200)
  const left = list.filter(({ pid }) => alive(pid))
  for (const { pid } of left) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  return left
}
/** Codex's own servers of this run: its shared background server and the updater beside it. */
const codexServers = () => ours('CODEX_HOME').filter(({ command }) => command.includes('app-server'))
/**
 * Stops Codex's shared background server, and its updater, by Codex's own command first and
 * then each by its process id, waited for. Resolves with what was still running after Codex's
 * command, and what had to be ended outright.
 */
async function stopCodexServer() {
  await codex(['app-server', 'daemon', 'stop'], { ms: 30_000 })
  const after = codexServers()
  return { after, forced: await ended(after) }
}

// The run's slug and the prompt the person types. The stand-in model goes by them.
const slug = `codex-ci-${Date.now().toString(36)}`
const PROMPT = `Put up a page that asks me to approve the deploy (${slug}).`
const page = `<h1>Deploy</h1><button id="go" onclick="It.action(\`approve\`)">Approve</button>`
const created = `it create "Approve the deploy" --id ${slug} --html '${page}' --open`
/**
 * The click a turn was started for, by its id: the line It wrote for it, which begins `[It]` and
 * ends with `[action <id>]`. It is in the person's newest message where It put the whole line
 * there, as it does when it reopens a conversation, or where no hook of It's has run in the
 * conversation. Where one has, It puts only the mark `[It]` into Codex's queue, and its
 * `UserPromptSubmit` hook adds the line to the turn as context for the agent, after the mark.
 */
const clickOf = (asked) => {
  const lines = [asked.newest, ...asked.since.filter((item) => item?.type === 'message').map(textOf)].flatMap((text) => text.split('\n'))
  return lines.map((line) => /^\[It\] .*\[action ([^\]\s]+)\]$/.exec(line.trim())?.[1]).find(Boolean)
}
const model = await standInModel({
  port: modelPort,
  script: (asked) => {
    if (asked.newest.startsWith('[It]')) {
      const action = clickOf(asked)
      // A click: the page is answered once, by a patch that names the click it answers
      if (action && asked.outputs === 0) return { run: `it patch ${slug} '${JSON.stringify({ answered: action })}'` }
      return { say: 'Answered on the page.' }
    }
    if (asked.newest.trim() === PROMPT) return asked.outputs === 0 ? { run: created } : { say: 'The page is up, and I will wait for you to use it.' }
    return { say: 'OK' }
  },
})
/** The newest of the page's actions, once It has a delivery for it, or what it last had of it. */
async function handed(id, ms) {
  let action
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    action = (await it(['read', slug])).json?.recentActions?.find((a) => a.id === id)
    if (action?.delivery === 'handed_off') break
  }
  return action
}

let serve
let tui
let browser
try {
  // ---------------------------------------------------------------------------------------
  // 1. The add-on, installed and approved, as Codex itself says
  const version = /(\d+\.\d+\.\d+)/.exec((await codex(['--version'])).out)?.[1]
  check(`the Codex under test is ${wanted ?? 'the one given'}`, version && (!wanted || version === wanted), version)

  // The person's own settings, as one who uses another model provider has them: the stand-in,
  // with a made-up key. Codex's analytics and its look for a newer version are turned off, so
  // that nothing of the run goes anywhere but this machine. The work folder is one the person
  // has already said they trust, so that Codex does not ask that first.
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    `model = "stand-in"
model_provider = "standin"
check_for_update_on_startup = false

[analytics]
enabled = false

[model_providers.standin]
name = "A stand-in model on this machine"
base_url = "${model.url}"
env_key = "IT_E2E_MODEL_KEY"
wire_api = "responses"

[projects.${JSON.stringify(work)}]
trust_level = "trusted"
`,
  )

  const setup = await it(['setup', '--only', 'codex', '--no-service'], { ms: 300_000 })
  writeFileSync(path.join(logs, 'setup.txt'), `${setup.out}\n${setup.err}`)
  const set = setup.json?.harnesses?.find((h) => h.id === 'codex')
  check(
    'it setup installs the add-on into this Codex',
    setup.code === 0 && set?.version === version && setup.json?.addons?.some((a) => a.id === 'codex' && a.did === 'installed'),
    setup.out || setup.err,
  )
  check(
    'and says the hooks still need the person’s approval in Codex',
    set?.addon === 'needs_approval' && /Trust all and continue/.test(set?.detail ?? ''),
    JSON.stringify(set),
  )

  const listed = await pluginLine()
  check('Codex itself lists It’s plugin as installed and on', /^it-bridge@it\s+installed, enabled\b/.test(listed), listed)
  let hooks = await itsHooks().catch((e) => e)
  const events = Array.isArray(hooks)
    ? hooks
        .map((h) => h.eventName)
        .sort()
        .join()
    : ''
  check(
    'Codex itself lists It’s four hooks, each running `it hook codex`',
    events === 'postToolUse,sessionStart,stop,userPromptSubmit' && hooks.every((h) => h.enabled && /(^|\/)it hook codex$/.test(h.command)),
    Array.isArray(hooks) ? JSON.stringify(hooks) : hooks.message,
  )
  check(
    'and says none of them is trusted yet',
    Array.isArray(hooks) && hooks.length === 4 && hooks.every((h) => h.trustStatus === 'untrusted'),
    Array.isArray(hooks) ? hooks.map((h) => h.trustStatus).join() : '',
  )
  check('it status says the same: the hooks need approval', (await codexState())?.addon === 'needs_approval', JSON.stringify(await codexState()))

  // Turned off in Codex's own settings, written as Codex's clients write them
  const settings = await appServer()
  const enabled = (value) => settings.request('config/value/write', { keyPath: 'plugins.it-bridge@it.enabled', value, mergeStrategy: 'replace' })
  const off = await enabled(false).then(
    () => null,
    (e) => e.message,
  )
  const offLine = await pluginLine()
  check('turned off in Codex’s settings, Codex lists It’s plugin as off', !off && /^it-bridge@it\s+installed, disabled\b/.test(offLine), off ?? offLine)
  check('and it status says it is turned off', (await codexState())?.addon === 'disabled', JSON.stringify(await codexState()))
  await enabled(true).catch(() => {})
  await settings.close()
  check(
    'turned on again, both say it is on and its hooks still need approval',
    /^it-bridge@it\s+installed, enabled\b/.test(await pluginLine()) && (await codexState())?.addon === 'needs_approval',
    JSON.stringify(await codexState()),
  )

  // It's own It, and a browser paired as the owner's, for the page to come up on. Started before
  // Codex's terminal is, so that the conversation's first turn finds them there.
  serve = spawn(process.execPath, [CLI, 'serve'], { env, cwd: home, stdio: ['ignore', 'ignore', 'pipe'] })
  let served = ''
  serve.stderr.on('data', (d) => (served += d))
  let site
  for (const end = Date.now() + 90_000; Date.now() < end && !site; await sleep(1000)) {
    const r = await it(['site', '--no-open'], { ms: 20_000 })
    if (r.code === 0 && r.json?.url) site = r.json.url
  }
  check('It starts, and gives the address that pairs a browser', site, served.slice(-600))
  browser = await chromium.launch()
  const tab = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await tab.goto(site)
  const paired = await tab
    .locator('header.bar')
    .waitFor({ timeout: 30_000 })
    .then(
      () => true,
      () => false,
    )
  check('a browser is paired as the owner’s, and is a display the page can come up on', paired)
  const siteAt = new URL(site).origin

  // The person's own step: Codex's terminal interface says the hooks need review as it starts,
  // and "Trust all and continue" is chosen
  tui = terminal()
  const asked = await tui.until(/Hooksneedreview.*Trustallandcontinue/, 60_000)
  check('Codex’s terminal says It’s hooks need review as it starts', asked, tui.plain().slice(-1500))
  // The second choice. The terminal is asked to move down one and choose, as a person does
  tui.type('\x1b[B')
  await sleep(500)
  tui.type('\r')
  const ready = await tui.until(/AskCodextodoanything|Implement\{feature\}|Explainthiscodebase/, 30_000, tui.mark())
  hooks = await itsHooks().catch((e) => e)
  check(
    'chosen “Trust all and continue”, Codex says It’s four hooks are trusted',
    Array.isArray(hooks) && hooks.length === 4 && hooks.every((h) => h.trustStatus === 'trusted'),
    Array.isArray(hooks) ? hooks.map((h) => h.trustStatus).join() : hooks.message,
  )
  check('and it status says the add-on is connected', (await codexState())?.addon === 'connected', JSON.stringify(await codexState()))

  // ---------------------------------------------------------------------------------------
  // 2. A click comes back into the conversation as a new turn
  check('Codex’s terminal is ready for a prompt', ready, tui.plain().slice(-1500))
  tui.type(PROMPT)
  await sleep(700)
  tui.type('\r')
  const first = await model.until((r) => r.newest.trim() === PROMPT, 60_000)
  const thread = first?.thread
  check('the prompt reaches the stand-in model, in a conversation Codex names', first && thread, JSON.stringify(model.seen.slice(-3)))
  const made = await model.until((r) => r.newest.trim() === PROMPT && r.outputs > 0, 60_000)
  const printed = made?.since.find((item) => item?.type === 'function_call_output')?.output ?? ''
  check(
    'Codex runs the `it create --open` the stand-in asked for, and gives back what it printed',
    /"version":\s*1\b/.test(String(printed)),
    String(printed).slice(0, 600),
  )
  const read = (await it(['read', slug])).json
  check(
    'the page is published, and remembers the Codex conversation that made it',
    read?.session?.harness === 'codex' && read?.session?.id === thread,
    JSON.stringify(read?.session ?? read),
  )
  const shown = await tab.waitForURL(`${siteAt}/p/${slug}`, { timeout: 30_000 }).then(
    () => true,
    () => false,
  )
  check('and comes up on the paired browser by itself', shown, tab.url())
  const frame = tab.frameLocator('.mount iframe')
  await frame.locator('#go').waitFor({ timeout: 30_000 })
  // Codex is idle again once its terminal shows the words the stand-in ended the turn with
  check('Codex’s terminal shows the stand-in’s answer, and the turn is over', await tui.until(/Thepageisup,andIwillwait/, 60_000), tui.plain().slice(-1500))
  await sleep(2000)
  const before = model.seen.length
  await frame.locator('#go').click()
  const clicked = await model.until((r) => r.n > before && r.newest.startsWith('[It]'), 90_000)
  const newestAction = (await it(['read', slug])).json?.recentActions?.[0]
  const action = newestAction ? await handed(newestAction.id, 30_000) : undefined
  check(
    'the click comes back to the stand-in as a new turn, whose newest message from the person is It’s mark, [It]',
    clicked?.newest === '[It]' && clicked.outputs === 0,
    JSON.stringify({ newest: clicked?.newest, since: clicked?.since }),
  )
  check(
    'and It’s own hook adds to that turn the click’s line, which begins [It] and ends with that click’s [action id]',
    clicked && action?.id && clickOf(clicked) === action.id,
    JSON.stringify({ since: clicked?.since, action }),
  )
  check('in the same conversation that made the page', clicked?.thread === thread, JSON.stringify({ clicked: clicked?.thread, thread }))
  // Codex says what started each turn, in the metadata it sends the model with it
  check(
    'handed to that conversation through Codex’s own queue, as It records and as Codex says it started the turn',
    action?.delivery === 'handed_off' && action?.route === 'queue' && clicked?.trigger === 'queue',
    JSON.stringify({ action, trigger: clicked?.trigger }),
  )
  const patched = await model.until((r) => r.n > before && r.newest === clicked?.newest && r.outputs > 0, 60_000)
  const state = (await it(['state', slug])).json
  check(
    'Codex runs the `it patch` the stand-in answered with, and the page’s state shows it',
    patched && state?.state?.answered === action?.id,
    JSON.stringify(state),
  )

  // ---------------------------------------------------------------------------------------
  // 3. A click on a page whose conversation is closed. Codex's terminal is left as a person
  // leaves it, and its background server, which keeps a conversation open after the terminal
  // is gone, is stopped: then no Codex has the conversation open
  check('and Codex’s terminal shows the turn the click started, to its end', await tui.until(/Answeredonthepage/, 60_000), tui.plain().slice(-1500))
  await sleep(2000)
  tui.type('\x03')
  await sleep(500)
  tui.type('\x03')
  await stopped(tui.child, 15_000)
  const stopping = await stopCodexServer()
  const anyCodex = ours('CODEX_HOME').filter(({ command }) => /(^|\/)codex$/.test(command[0] ?? ''))
  check(
    // Codex's own `app-server daemon stop` is what stops the server, the process that listens.
    // It leaves the updater beside it running, which the run then ends itself
    'Codex’s terminal is left and Codex’s own command stops its background server, so that no Codex has the conversation open',
    tui.child.exitCode !== null && !stopping.after.some(({ command }) => command.includes('--listen')) && stopping.forced.length === 0 && anyCodex.length === 0,
    JSON.stringify({ terminal: tui.child.exitCode, afterStop: stopping.after, forced: stopping.forced, anyCodex }),
  )
  await sleep(2000)
  const beforeWake = model.seen.length
  await frame.locator('#go').click()
  const woken = await model.until((r) => r.n > beforeWake && r.newest.startsWith('[It]'), 120_000)
  const latest = (await it(['read', slug])).json?.recentActions?.[0]
  const second = latest && latest.id !== action?.id ? await handed(latest.id, 60_000) : latest
  check(
    'with Codex closed, a click reopens the conversation through the real Codex, which asks the stand-in with the click’s line in the person’s message',
    woken?.newest.startsWith('[It]') && second?.id && second.id !== action?.id && clickOf({ newest: woken.newest, since: [] }) === second.id,
    JSON.stringify({ woken: woken?.newest, second }),
  )
  check('in the same conversation', woken?.thread === thread, JSON.stringify({ woken: woken?.thread, thread }))
  // The click's turn in the open conversation came from Codex's queue, and this one from a
  // `codex exec` run, which nothing but It's reopening started
  check(
    'and Codex says a `codex exec` run started that turn',
    woken?.trigger === 'exec' && clicked?.trigger === 'queue',
    JSON.stringify({ woken: woken?.trigger, clicked: clicked?.trigger, first: first?.trigger }),
  )
  check('It records the click as handed to that conversation', second?.delivery === 'handed_off', JSON.stringify(second))
  const wokePatched = await model.until((r) => r.n > beforeWake && r.newest === woken?.newest && r.outputs > 0, 90_000)
  const after = (await it(['state', slug])).json
  check('and Codex, reopened, runs the `it patch` the stand-in answered with', wokePatched && after?.state?.answered === second?.id, JSON.stringify(after))
  writeFileSync(path.join(logs, 'runs.txt'), (await it(['runs'])).out)
} catch (err) {
  check(`the run finished (${err.message})`, false, err.stack)
} finally {
  if (tui) await stopped(tui.child, 5000)
  await stopCodexServer().catch(() => {})
  await browser?.close().catch(() => {})
  await stopped(serve, 60_000)
  await model.close()
  // Everything the run started has been asked to stop and waited for. Anything still running
  // that was given this run's It folder is a fault: it is said, and ended
  const left = ours()
  check('nothing the run started is left running', left.length === 0, JSON.stringify(left))
  await ended(left)
  writeFileSync(path.join(logs, 'model.json'), JSON.stringify({ seen: model.seen, others: model.others }, null, 1))
  if (tui) writeFileSync(path.join(logs, 'terminal.txt'), tui.plain())
  // What the run wrote down is copied where IT_E2E_CODEX_LOGS says, for CI to keep: what setup
  // printed, every request the stand-in model was sent and what it answered, and what Codex's
  // terminal showed. None of it holds a credential: the model's key is a made-up one, and the
  // address that pairs a browser is never written down.
  if (process.env.IT_E2E_CODEX_LOGS) cpSync(logs, process.env.IT_E2E_CODEX_LOGS, { recursive: true })
  if (process.env.IT_E2E_KEEP) console.log(`\nKept: ${top}`)
  else rmSync(top, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
