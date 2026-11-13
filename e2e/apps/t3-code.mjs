// The real T3 Code, with no account and no model of anyone's: does It still find T3 Code's
// server, get a session from T3 Code's own command, read its threads in the protocol it speaks,
// and put a click to the thread that holds the conversation it is for?
//
// T3 Code is installed from its official package (`t3` on npm, whose launcher fetches T3 Code's
// own program into T3 Code's folder) into folders of this run's own, and its server is started
// with `t3 serve` in a throwaway T3 Code folder, a throwaway home and a port of the run's own.
// Nothing of whoever runs this is read or written: before every command of T3 Code's the run
// checks that the folder T3 Code is pointed at is one of its own.
//
// First It's own code for T3 Code (packages/cli/src/t3.ts), built from the source and loaded here,
// is asked against the real server: that it finds the server from the note T3 Code keeps, finds
// T3 Code's own program as T3 Code's launcher keeps it, is issued a session by T3 Code's own
// command, and lists and reads threads in version 2 of T3 Code's protocol, which the real server
// is asked whether it still speaks. A thread is made with T3 Code's own command, in a project made
// with T3 Code's own command, for Claude Code. T3 Code is given, as the `claude` it runs, a
// stand-in that writes down how it was started and ends at once, as Claude Code does here with no
// account: T3 Code names the conversation's id on that command line (`--session-id`), so the run
// learns the id from T3 Code itself and not from It. It's code must find the thread by that id,
// say that it runs that conversation now, and say that no thread holds another. Asked through a
// stand-in that passes everything on to the real server but asks it in the next version of the
// protocol, It must take the real server's refusal for not knowing, never for no thread, and
// must not put a message to a thread.
//
// Then a whole It of the run's own, with the real Claude Code installed from its package for It's
// side alone, so that `it setup --only claude-code` connects it as it would for a person. A page
// is made in the conversation the thread holds, as Claude Code's add-on would name it. `it create`
// and `it status` must say that what the person does arrives by itself, through the thread. A
// paired browser clicks the page's button, and the run passes only where T3 Code's own command
// then shows the click in that thread as a message from the person, in It's wording for a click,
// and in no other thread, T3 Code starts its `claude` again for that same conversation to take it
// up, and It records the click as handed over by way of T3 Code. With It's add-on then turned
// off by Claude Code's own command, a second click must still reach the thread, which is what
// It's documentation promises. What `arrives` says in that case is reported and not held to,
// since it says otherwise today (see the run's report).
//
// The turn T3 Code starts for the click fails, since the `claude` it runs is a stand-in that ends
// at once; that is expected, and what is checked is that T3 Code took the message for the right
// thread. A whole loop with the real Claude Code inside T3 Code and a stand-in model is not
// attempted here.
//
//   node e2e/apps/t3-code.mjs --version <version | latest | nightly>   installs that T3 Code from npm
//
// IT_PORT is the port the run's It counts from (6300 where it is not set); T3 Code's server
// listens 50 above it and the stand-in for another protocol 51 above. IT_T3_ROOT is the folder
// the run's folders are made in; It's connector listens at a socket in It's folder, whose path a
// system holds to about a hundred characters. IT_BIN and IT_CLI name the It to run, as for the
// other end-to-end scripts. IT_T3_KEEP keeps the run's folders.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COMMAND, sleep } from '../lib.mjs'
import { printCleanly, verdict } from '../logs.mjs'
import { launch, pairAsOwner } from '../site.mjs'
import { itsOwnT3 } from './t3-code/its-own.mjs'
import { otherProtocol } from './t3-code/other-protocol.mjs'

printCleanly()
const argv = process.argv.slice(2)
const asked = argv[argv.indexOf('--version') + 1]
if (!argv.includes('--version') || !asked) {
  console.error('usage: node e2e/apps/t3-code.mjs --version <version | latest | nightly>')
  process.exit(2)
}
if (process.platform === 'win32') {
  console.error('This run is written for Linux and macOS: on Windows It finds T3 Code’s command another way, which it does not cover yet.')
  process.exit(2)
}

const results = []
const notes = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  console.log(verdict(name, ok, typeof detail === 'string' ? detail : JSON.stringify(detail), 1500))
  return Boolean(ok)
}
/** Something the run found and says, without holding It to it. */
const note = (line) => {
  notes.push(line)
  console.log(`  note ${line}`)
}
const began = Date.now()

const base = Number(process.env.IT_PORT ?? 6300)
const keep = Boolean(process.env.IT_T3_KEEP)
const t3Port = base + 50
const top = mkdtempSync(path.join(process.env.IT_T3_ROOT ?? os.tmpdir(), 'itt3-'))
const at = (...p) => path.join(top, ...p)
const home = at('home')
const t3Home = at('t3')
const itHome = at('it')
const itBin = at('it-bin')
const t3Bin = at('t3-bin')
const work = at('work')
const logs = at('logs')
for (const f of [home, t3Home, itBin, t3Bin, work, logs, at('build')]) mkdirSync(f, { recursive: true })
if (path.join(itHome, 'connector.sock').length > 100) {
  console.error(`It's folder would be ${itHome}, and the socket in it too long a path for the system. Name a shorter folder in IT_T3_ROOT.`)
  rmSync(top, { recursive: true, force: true })
  process.exit(2)
}

/** The folder of T3 Code that nobody but this run has: every command of T3 Code's is checked to be pointed at it before it runs. */
const ownT3 = (env) => {
  const named = env.T3CODE_HOME
  const theirs = path.join(os.homedir(), '.t3')
  if (named !== t3Home || path.resolve(named) === path.resolve(theirs) || !path.resolve(named).startsWith(`${path.resolve(top)}${path.sep}`))
    throw new Error(`refusing to run a command of T3 Code's pointed at a folder that is not the run's own (${named})`)
}

// ---------- What every program the run starts is given ----------
// Nothing of whoever runs this but the language and the folder for temporary files, so that no key
// for a model, no setting of theirs and no folder of theirs is seen: a home of the run's own, and a
// PATH of the run's own folders, the Node that runs this, and the system's own programs. Not the
// PATH this was started with, which may hold a person's own `t3` or `claude`.
const systemPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const common = {
  LANG: 'C.UTF-8',
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  XDG_STATE_HOME: path.join(home, '.local', 'state'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  TMPDIR: process.env.RUNNER_TEMP ?? os.tmpdir(),
  // An empty folder for T3 Code, the run's own
  T3CODE_HOME: t3Home,
  // Claude Code fetches no newer Claude Code, and asks the internet for nothing it can do without
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ...Object.fromEntries(['CI'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
}
/** T3 Code: its own program and launcher, and the stand-in it runs as `claude`. */
const t3Env = {
  ...common,
  PATH: [t3Bin, path.dirname(process.execPath), ...systemPath].join(path.delimiter),
  // On this machine alone
  T3CODE_LAN: 'false',
}
/** It, and the real Claude Code that `it setup` connects. */
const itEnv = {
  ...common,
  PATH: [itBin, path.dirname(process.execPath), ...systemPath].join(path.delimiter),
  CLAUDE_CONFIG_DIR: at('claude-config'),
  IT_HOME: itHome,
  IT_PORT: String(base),
  IT_HARNESSES: 'claude-code',
  IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
  ...Object.fromEntries(['IT_BACKEND_BIN', 'IT_BACKEND_RELEASES'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
}
// The run itself asks T3 Code's command for a session through It's own code, which runs it with
// this process's surroundings: they are made T3 Code's as the run gives them, and nothing else
const playwrightBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), '.cache', 'ms-playwright')
for (const k of Object.keys(process.env)) delete process.env[k]
Object.assign(process.env, t3Env, { PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsers })

/** Runs a program to its end; resolves with its exit code and what it printed. */
function ran(program, args, { env = itEnv, cwd = work, ms = 120_000, input } = {}) {
  if (env === t3Env) ownT3(env)
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    if (input !== undefined) child.stdin.end(input)
    const timer = setTimeout(() => child.kill('SIGKILL'), ms)
    child.on('error', (e) => (err += e.message))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}
const t3 = (args, options) => ran('t3', [...args, '--base-dir', t3Home], { env: t3Env, ...options })
const t3Json = async (args, options) => {
  const r = await t3([...args, '--json'], options)
  try {
    return JSON.parse(r.out)
  } catch {
    throw new Error(`t3 ${args.slice(0, 2).join(' ')} ended with ${r.code} and printed no JSON: ${(r.err || r.out).slice(-600)}`)
  }
}
/** The run's It: what a command printed, as JSON where it is JSON. Throws where it failed. */
async function it(args, { extra = {}, ...options } = {}) {
  const r = await ran(COMMAND[0], [...COMMAND.slice(1), ...args], { env: { ...itEnv, ...extra }, ...options })
  let parsed = r.out
  try {
    parsed = JSON.parse(r.out)
  } catch {}
  if (r.code !== 0) throw new Error(`it ${args[0]} exited ${r.code}: ${r.err.slice(-600)}`)
  return parsed
}
async function untilTrue(test, ms, every = 500) {
  const end = Date.now() + ms
  for (;;) {
    const got = await test().catch(() => null)
    if (got || Date.now() > end) return got
    await sleep(every)
  }
}

/** What npm is run with: nothing of whoever runs this that says how npm is set up, and npm's own registry. */
function npmEnv() {
  writeFileSync(at('npmrc'), '')
  writeFileSync(at('npmrc-global'), '')
  return {
    ...common,
    PATH: [path.dirname(process.execPath), ...systemPath].join(path.delimiter),
    npm_config_userconfig: at('npmrc'),
    npm_config_globalconfig: at('npmrc-global'),
    npm_config_cache: at('npm-cache'),
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_update_notifier: 'false',
  }
}
const npm = (args, cwd) => execFileSync('npm', args, { cwd, env: npmEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
/** Installs a package from npm into a folder of the run's own, and links its programs into `bin`. */
function install(spec, folder, programs, bin) {
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'package.json'), '{"private":true}\n')
  npm(['install', '--no-audit', '--no-fund', spec], folder)
  for (const p of programs) execFileSync('ln', ['-sf', path.join(folder, 'node_modules', '.bin', p), path.join(bin, p)])
}

let server = null
let serve = null
let browser = null
let other = null

/** Stops one program the run started, and waits for it: asked first, and ended where it does not stop. */
async function stopProgram(child, ms = 60_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true
  child.kill('SIGTERM')
  const end = Date.now() + ms
  while (child.exitCode === null && child.signalCode === null && Date.now() < end) await sleep(250)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  return child.exitCode !== null || child.signalCode !== null
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** The note T3 Code keeps of its running server, in the run's folder. */
const noted = () => {
  try {
    return JSON.parse(readFileSync(path.join(t3Home, 'userdata', 'server-runtime.json'), 'utf8'))
  } catch {
    return null
  }
}

let cleaning = null
function cleanUp() {
  cleaning ??= (async () => {
    await browser?.close().catch(() => {})
    await other?.close().catch(() => {})
    let stillUp = false
    if (serve && serve.exitCode === null && serve.signalCode === null) {
      stillUp = !(await stopProgram(serve, 90_000))
      check('It stops when it is asked to', !stillUp, stillUp ? `It (process ${serve.pid}) is still running on ${itHome}` : '')
    }
    // T3 Code's launcher passes the signal on to T3 Code's own program, which is waited for too
    const program = noted()?.pid
    if (server) await stopProgram(server, 30_000)
    if (typeof program === 'number') {
      const end = Date.now() + 30_000
      while (alive(program) && Date.now() < end) await sleep(250)
      if (alive(program)) {
        // Only the very program T3 Code noted, and only where it is the run's own T3 Code's
        let ours = false
        try {
          ours = realpathSync(`/proc/${program}/exe`).startsWith(realpathSync(t3Home))
        } catch {}
        if (ours) process.kill(program, 'SIGKILL')
      }
      stillUp ||= alive(program)
    }
    if (results.some((r) => !r.ok)) {
      for (const [name, file] of [
        ['It, with its connector', path.join(logs, 'serve.log')],
        ['T3 Code', path.join(logs, 't3.log')],
      ])
        if (existsSync(file)) console.log(`\nThe end of what ${name} wrote:\n${readFileSync(file, 'utf8').slice(-3000)}`)
    }
    if (stillUp) console.log(`\nSomething the run started is still running, so its folders are kept in ${top}. Stop it, then remove them.`)
    else if (!keep) rmSync(top, { recursive: true, force: true })
    else console.log(`\nThe run's folders are kept in ${top}`)
  })()
  return cleaning
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    check(`the run finished, and was not stopped part way by ${signal}`, false)
    void cleanUp().finally(() => process.exit(1))
  })

/** How T3 Code started its `claude`, each time, as the stand-in wrote it down. */
const claudeCalls = () => {
  try {
    const calls = [[]]
    for (const word of readFileSync(at('claude-calls'), 'utf8').split('\0').slice(0, -1)) {
      if (word === '\x1e') calls.push([])
      else calls.at(-1).push(word)
    }
    return calls.slice(0, -1)
  } catch {
    return []
  }
}
/** The conversation id a command line of T3 Code's names, as it starts a new one or takes one up. */
const conversationIn = (args) => {
  for (const [i, a] of args.entries()) {
    const m = /^--(session-id|resume)=(.+)$/.exec(a)
    if (m) return { how: m[1], id: m[2] }
    if ((a === '--session-id' || a === '--resume') && args[i + 1]) return { how: a.slice(2), id: args[i + 1] }
  }
  return null
}

try {
  // ---------- T3 Code, from its package ----------
  const want = asked === 'latest' || asked === 'nightly' ? npm(['view', `t3@${asked}`, 'version'], top).trim() : asked
  install(`t3@${want}`, at('t3-install'), ['t3'], t3Bin)
  // The real Claude Code, from its package: It's side connects it with `it setup`, and T3 Code runs
  // it for its threads, each with a folder of its own for Claude Code's settings and no account
  const claudeVersion = npm(['view', '@anthropic-ai/claude-code', 'version'], top).trim()
  install(`@anthropic-ai/claude-code@${claudeVersion}`, at('claude-install'), ['claude'], itBin)
  // What T3 Code runs as `claude`: a script that writes down how T3 Code started it, each word
  // ended by a NUL and each start by a word of its own, and then becomes the real Claude Code
  writeFileSync(
    path.join(t3Bin, 'claude'),
    [
      '#!/bin/sh',
      `{ for word in "$@"; do printf '%s\\0' "$word"; done; printf '\\036\\0'; } >> '${at('claude-calls')}'`,
      `exec '${path.join(at('claude-install'), 'node_modules', '.bin', 'claude')}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  // The launcher fetches T3 Code's own program, by version, into T3 Code's folder, the first time it runs
  const version = await t3(['--version'], { ms: 300_000 })
  const said = /\bv?(\d+\.\d+\.\d+\S*)/.exec(version.out)?.[1]
  console.log(`\nT3 Code ${said ?? '?'} (asked for ${asked}, which is ${want}), It ${(await it(['--version']).catch(() => ({}))).version ?? '?'}\n`)
  if (!check('T3 Code installed from its package runs, and is the version asked for', version.code === 0 && said === want, version))
    throw new Error('T3 Code did not install')
  const program = path.join(t3Home, 'runtime', 'versions', want, 't3')
  check(
    'and its launcher keeps T3 Code’s own program where It looks for it, by version and marked as installed whole',
    existsSync(program) && existsSync(path.join(t3Home, 'runtime', 'versions', want, '.install-complete')),
  )

  // ---------- T3 Code's server, in the run's own folder ----------
  ownT3(t3Env)
  server = spawn('t3', ['serve', '--base-dir', t3Home, '--port', String(t3Port), '--host', '127.0.0.1', '--no-browser', work], {
    cwd: work,
    env: t3Env,
    stdio: ['ignore', openSync(path.join(logs, 't3.log'), 'w'), openSync(path.join(logs, 't3.log'), 'a')],
  })
  const up = await untilTrue(async () => {
    const n = noted()
    if (!n || !alive(n.pid)) return null
    const answer = await fetch(`${n.origin}/api/orchestration/shell`, { signal: AbortSignal.timeout(2000) })
    return answer.status === 401 || answer.status === 403 ? n : null
  }, 120_000)
  if (
    !check('T3 Code’s server starts, notes where it is in its own folder, and answers there', up, readFileSync(path.join(logs, 't3.log'), 'utf8').slice(-1500))
  )
    throw new Error('T3 Code did not start')
  check(
    'and its note says what It reads: the process, an address on this machine, and the version',
    typeof up.pid === 'number' && up.origin === `http://127.0.0.1:${t3Port}` && up.serverVersion === want,
    up,
  )

  // ---------- It's own code for T3 Code, against the real server ----------
  const own = await itsOwnT3(at('build'))
  const found = own.t3Server(t3Home)
  check('It finds the server from the note T3 Code keeps', found?.origin === up.origin && found?.home === t3Home, found)
  check(
    'and T3 Code’s own command: the program T3 Code runs as its server, as the system names it, which is the one its launcher keeps',
    found?.command?.length === 1 && realpathSync(found.command[0]) === realpathSync(program),
    found?.command,
  )
  const kept = own.t3Command(t3Home, up.serverVersion)
  check('which It also finds by the version T3 Code noted, where the system does not say', kept?.command?.length === 1 && kept.command[0] === program, kept)

  // Which versions of T3 Code's protocol the real server speaks, as it answers for its threads
  const token = (await t3Json(['auth', 'session', 'issue', '--scope', 'orchestration:read', '--ttl', '5m', '--label', 'It run'])).token
  const speaks = []
  for (let v = 1; v <= 6; v++) {
    const answer = await fetch(`${up.origin}/api/orchestration/shell`, {
      headers: { authorization: `Bearer ${token}`, 'x-t3-orchestration-protocol': String(v) },
      signal: AbortSignal.timeout(10_000),
    })
    if (answer.ok) speaks.push(v)
  }
  console.log(`  T3 Code ${want} answers for its threads in version ${speaks.join(', ') || 'none'} of its protocol, of 1 to 6`)
  if (
    !check(
      'T3 Code still speaks version 2 of its protocol, the one It speaks',
      speaks.includes(2),
      `T3 Code ${want} speaks ${speaks.join(', ') || 'none of 1 to 6'}, and It speaks only 2: every click for a thread waits`,
    )
  )
    throw new Error('T3 Code does not speak the protocol It speaks')

  const nobody = { harness: 'claude-code', ids: ['00000000-0000-4000-8000-000000000000'], cwd: work }
  const none = await own.t3RunsNow(found, nobody, AbortSignal.timeout(30_000))
  check(
    'T3 Code’s own command issues It a session, and It lists the threads under it: none runs a conversation while there are none',
    none.status === 'none' && own.t3Refusal() === undefined,
    { none, refusal: own.t3Refusal() },
  )

  // ---------- A thread for Claude Code, made with T3 Code's own command ----------
  const project = await t3(['project', 'add', work, '--title', 'It run'])
  check('T3 Code’s own command makes a project of the run’s folder', project.code === 0, project)
  // A name for a model that T3 Code itself resolves, which every T3 Code here takes
  const model = 'sonnet'
  const started = await t3Json(['thread', 'start', '--provider', 'claudeAgent', '--model', model, '--title', 'It run', work, 'Make me a page with one button.'])
  const thread = started.threadId
  check('and a thread in it for Claude Code, with a message', typeof thread === 'string' && thread.length > 0, started)
  // T3 Code starts its `claude` for the thread, naming the conversation
  const first = await untilTrue(async () => claudeCalls().map(conversationIn).find(Boolean), 60_000)
  if (!check('T3 Code starts Claude Code for the thread, and names the conversation it is to be', first?.how === 'session-id' && first.id, claudeCalls()))
    throw new Error('T3 Code named no conversation for Claude Code')
  const conversation = first.id
  const settled = await untilTrue(async () => {
    const shown = await t3Json(['thread', 'show', thread, '--messages', '5'])
    return shown.thread?.activeRunId === null && shown.thread.status !== 'running' ? shown : null
  }, 60_000)
  check(
    'with no Claude Code that can answer, the thread’s turn ends, as it does for a person with no account, and the message stays in the thread',
    settled?.messages?.some((m) => m.role === 'user' && m.text === 'Make me a page with one button.'),
    settled,
  )
  // A second thread in the same project, for Claude Code too, made after the first, so that It
  // meets it first: the click must not go there
  const other2 = await t3Json(['thread', 'start', '--provider', 'claudeAgent', '--model', model, '--title', 'It run, beside', work, 'Something else.'])
  const beside = other2.threadId
  const besideConversation = (
    await untilTrue(async () => {
      const ids = claudeCalls().map(conversationIn).filter(Boolean)
      return ids.find((c) => c.id !== conversation)
    }, 60_000)
  )?.id
  check('and another thread beside it, for another conversation', beside && beside !== thread && besideConversation, { beside, besideConversation })
  await untilTrue(async () => (await t3Json(['thread', 'show', beside])).thread?.activeRunId === null, 60_000)

  const of = { harness: 'claude-code', ids: [conversation], cwd: work }
  let search = own.t3Search()
  let result
  for (let i = 0; i < 6; i++) {
    result = await own.t3ThreadOf(found, of, search, AbortSignal.timeout(30_000))
    if (result.status !== 'incomplete') break
  }
  check('It finds the thread that holds the conversation by the id T3 Code gave Claude Code', result?.status === 'found' && result.thread === thread, result)
  const running = await own.t3Running(found, of, undefined, AbortSignal.timeout(30_000))
  check('and says that thread runs that conversation now, with nothing it ran before', running?.thread === thread && running.before.length === 0, running)
  const now = await own.t3RunsNow(found, of, AbortSignal.timeout(30_000))
  check('as a command the conversation runs is told', now.status === 'found' && now.thread === thread, now)
  search = own.t3Search()
  for (let i = 0; i < 6; i++) {
    result = await own.t3ThreadOf(found, nobody, search, AbortSignal.timeout(30_000))
    if (result.status !== 'incomplete') break
  }
  check('and that no thread holds a conversation none of them has', result?.status === 'absent', result)

  // ---------- A T3 Code that speaks another version ----------
  other = await otherProtocol(up.origin, base + 51)
  const elsewhere = { ...found, origin: other.origin }
  search = own.t3Search()
  const unread = await own.t3ThreadOf(elsewhere, of, search, AbortSignal.timeout(30_000))
  const unknown = await own.t3RunsNow(elsewhere, nobody, AbortSignal.timeout(30_000))
  const before = (await t3Json(['thread', 'show', thread, '--messages', '20'])).messages?.length
  const refused = await own.t3Send(elsewhere, thread, 'a message T3 Code should refuse')
  const after = (await t3Json(['thread', 'show', thread, '--messages', '20'])).messages?.length
  check(
    'asked in a version T3 Code does not speak, It is refused by the real server and takes that for not knowing: never for no thread',
    unread.status === 'incomplete' && !unread.progressed && unknown.status === 'unknown' && other.asked.some((a) => a.passed === '3'),
    { unread, unknown, asked: other.asked.slice(0, 4) },
  )
  check('and puts no message to the thread, and says why in words of its own', typeof refused === 'string' && refused.length > 0 && after === before, {
    refused,
    before,
    after,
  })
  await other.close()
  other = null

  // ---------- A whole It, and the real Claude Code for It's side ----------
  const setup = await it(['setup', '--only', 'claude-code', '--no-service'], { ms: 300_000 })
  const claude = setup.harnesses?.find((h) => h.id === 'claude-code')
  check(`\`it setup --only claude-code\` connects the real Claude Code ${claudeVersion}`, claude?.addon === 'connected', setup.harnesses ?? setup)
  /** Starts It's service, and waits for it and its connector. */
  const startIt = async () => {
    serve = spawn(COMMAND[0], [...COMMAND.slice(1), 'serve'], {
      cwd: work,
      env: itEnv,
      stdio: ['ignore', openSync(path.join(logs, 'serve.out.log'), 'a'), openSync(path.join(logs, 'serve.log'), 'a')],
    })
    return untilTrue(async () => {
      const s = await it(['status'])
      return s.running && s.connector?.ok ? s : null
    }, 120_000)
  }
  if (!check('It runs, with its connector', await startIt(), readFileSync(path.join(logs, 'serve.log'), 'utf8').slice(-1500)))
    throw new Error('It did not start')

  // A page made in the conversation the thread holds, named as Claude Code's add-on names it
  const inThread = { IT_HARNESS: 'claude-code', IT_SESSION: conversation }
  const slug = `t3-check-${Date.now().toString(36)}`
  const html = '<h1>T3 Code check</h1><button id=go onclick="It.action(&quot;approve&quot;,{n:1})">Approve</button>'
  const made = await it(['create', 'T3 Code check', '--id', slug, '--html', html], { extra: inThread })
  check(
    '`it create` in that conversation says that what the person does arrives by itself, through its thread of T3 Code',
    made.arrives?.byItself === true && made.arrives?.via === 't3',
    made.arrives ?? made,
  )
  const asStatus = await it(['status'], { extra: inThread })
  check('and so does `it status`', asStatus.arrives?.byItself === true && asStatus.arrives?.via === 't3', asStatus.arrives ?? asStatus)
  // The connector is part of the service, and writes where the service does
  const connectorLog = () => readFileSync(path.join(logs, 'serve.log'), 'utf8')
  check(
    'and the connector says the conversation is held in a thread of T3 Code',
    /claude-code conversation \([0-9a-f]{8}\) is held in a thread of T3 Code/i.test(connectorLog()),
  )
  const outside = await it(['status'], { extra: { IT_HARNESS: 'claude-code', IT_SESSION: nobody.ids[0] } })
  check(
    'while for a conversation no thread holds, it does not say that anything arrives through T3 Code',
    outside.arrives && outside.arrives.byItself !== true && outside.arrives.via === undefined,
    outside.arrives ?? outside,
  )

  // ---------- The click ----------
  const opened = await launch()
  browser = opened.browser
  await pairAsOwner(opened.page, { home: itHome, run: (_home, args) => it(args) })
  const site = new URL(opened.page.url()).origin
  await opened.page.goto(`${site}/p/${slug}`)
  const frame = opened.page.frameLocator('.mount iframe')
  await frame.locator('#go').waitFor({ timeout: 30_000 })
  await frame.locator('#go').click()
  const clicked = await untilTrue(async () => {
    const shown = await t3Json(['thread', 'show', thread, '--messages', '20'])
    return shown.messages?.find((m) => m.role === 'user' && m.text.startsWith('[It]')) ?? null
  }, 60_000)
  const actionId = /\[action ([^\]\s]+)\]\s*$/.exec(clicked?.text ?? '')?.[1]
  check(
    'the click reaches the thread: T3 Code’s own command shows it there as a message from the person, in It’s wording, which begins [It] and ends [action <id>]',
    clicked && actionId && clicked.text.includes('approve'),
    clicked ?? `nothing in the thread a minute after the click; the connector said: ${connectorLog().slice(-800)}`,
  )
  const besideShown = await t3Json(['thread', 'show', beside, '--messages', '20'])
  check('and in no other thread', !besideShown.messages?.some((m) => m.text.startsWith('[It]')), besideShown.messages)
  // T3 Code starts a turn of the thread for a message a person puts to it, which is what makes it
  // a turn and not only a line kept in the thread
  const firstRun = settled.messages.find((m) => m.text === 'Make me a page with one button.')?.runId
  check('T3 Code takes it up as a turn of its own in the thread', clicked?.runId && clicked.runId !== firstRun, { firstRun, clicked })
  const recorded = await untilTrue(async () => {
    const r = (await it(['read', slug])).recentActions?.find((a) => a.id === actionId)
    return r?.delivery === 'handed_off' ? r : null
  }, 30_000)
  // The backend has no route of its own for T3 Code: a message put to a thread is recorded as a
  // queue's, as one put in Codex's own queue is, and not as the add-on's or a waiting agent's
  check(
    'and It records the click as handed over, by a queue and not by the add-on',
    recorded?.route === 'queue',
    recorded ?? (await it(['read', slug])).recentActions,
  )

  // ---------- With It's add-on turned off in Claude Code ----------
  // It's documentation says a conversation a thread holds still gets its clicks there, since the
  // way to the thread asks nothing of the add-on
  const disabled = await ran('claude', ['plugin', 'disable', 'it-bridge@it'], { env: itEnv, ms: 60_000 })
  const off = await untilTrue(async () => {
    const s = await it(['status'])
    const h = s.harnesses?.find((x) => x.id === 'claude-code')
    return h && h.addon !== 'connected' ? h : null
  }, 30_000)
  check('Claude Code’s own command turns It’s add-on off, and `it status` says so', disabled.code === 0 && off, { disabled, off })
  // The connector looks again at what is installed when it starts, when the apps chosen change, and
  // every half hour: It is started again, so that its connector has seen the add-on turned off
  const stopped = await stopProgram(serve, 90_000)
  if (!check('It stops when it is asked to, and starts again', stopped && (await startIt()), readFileSync(path.join(logs, 'serve.log'), 'utf8').slice(-1500)))
    throw new Error('It did not start again')
  const offArrives = (await it(['status'], { extra: inThread })).arrives
  note(`with It’s add-on turned off, \`arrives\` for the conversation the thread holds says ${JSON.stringify(offArrives)}`)
  const before2 = (await t3Json(['thread', 'show', thread, '--messages', '50'])).messages?.filter((m) => m.text.startsWith('[It]')).length ?? 0
  await frame.locator('#go').click()
  const second = await untilTrue(async () => {
    const shown = await t3Json(['thread', 'show', thread, '--messages', '50'])
    const its = shown.messages?.filter((m) => m.role === 'user' && m.text.startsWith('[It]')) ?? []
    return its.length > before2 ? its.at(-1) : null
  }, 60_000)
  check(
    'with It’s add-on turned off, a click still reaches the thread, as It’s documentation says',
    second && !second.text.endsWith(`[action ${actionId}]`),
    second ?? `nothing more in the thread a minute after the click; the connector said: ${connectorLog().slice(-800)}`,
  )
  if (second && offArrives?.byItself !== true)
    note(
      '`arrives` says the click does not arrive by itself while it does: it asks for the add-on (`route.connected`) where the connector asks only that the app is chosen (`throughT3`)',
    )
} catch (err) {
  check(`the run went to its end (${err.message})`, false)
} finally {
  await cleanUp()
}

const failed = results.filter((r) => !r.ok)
console.log(
  `\n${results.length - failed.length} of ${results.length} checks passed in ${Math.round((Date.now() - began) / 1000)} seconds${notes.length ? `, with ${notes.length} note${notes.length === 1 ? '' : 's'}` : ''}`,
)
process.exit(failed.length ? 1 : 0)
