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
// with T3 Code's own command, for Claude Code. The run reads the conversation's id from T3 Code's
// own account of the thread, and not through It's code. Outside Windows T3 Code is also given, as
// the `claude` it runs, a script that writes down how T3 Code started it and then becomes the real
// Claude Code, which has no account here, so the run sees T3 Code hand that very id to Claude Code
// (`--session-id`). On Windows that script would have to be one that cmd.exe reads, and T3 Code
// runs the real Claude Code's own program instead. It's code must find the thread by that id,
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
// T3 Code begins a run of the thread for that message on that same conversation, and It records
// the click as handed over by a queue, which is how the backend records T3 Code's way. With It's
// add-on then turned off by Claude Code's own command, a second click must still reach the thread,
// which is what It's documentation promises. What `arrives` says in that case is reported and not
// held to, since it says otherwise today. At the end each click must be in that thread once, the
// thread beside it must have none, and nothing the run started may be left running.
//
// The turn T3 Code starts for each message fails, since Claude Code has no account here; that is
// expected, and what is checked is that T3 Code took the message for the right thread. On Windows
// It finds T3 Code's command by the version T3 Code noted, where T3 Code's launcher keeps it, as
// it does on a machine where T3 Code was installed from npm; the command T3 Code's desktop app
// keeps in T3 Code's folder is not covered. A whole loop with the real Claude Code inside T3 Code
// and a stand-in model is not attempted here.
//
//   node e2e/apps/t3-code.mjs --version <version | latest | nightly>   installs that T3 Code from npm
//
// IT_PORT is the port the run's It counts from (6300 where it is not set); T3 Code's server
// listens 50 above it and the stand-in for another protocol 51 above. IT_T3_ROOT is the folder
// the run's folders are made in; It's connector listens at a socket in It's folder, whose path a
// system holds to about a hundred characters. IT_BIN and IT_CLI name the It to run, as for the
// other end-to-end scripts. IT_T3_KEEP keeps the run's folders.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const windows = process.platform === 'win32'

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
const t3Bin = at('t3-bin')
const work = at('work')
const logs = at('logs')
for (const f of [home, t3Home, t3Bin, work, logs, at('build')]) mkdirSync(f, { recursive: true })
// On Windows the connector listens on a port, and elsewhere at a socket in It's folder
if (!windows && path.join(itHome, 'connector.sock').length > 100) {
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
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const systemPath = windows
  ? [path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32', 'Wbem'), path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')]
  : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const temporary = process.env.RUNNER_TEMP ?? os.tmpdir()
const common = {
  LANG: 'C.UTF-8',
  HOME: home,
  // What Windows' own programs need, and a person's folders there that are the run's own
  ...(windows
    ? {
        SystemRoot: systemRoot,
        windir: systemRoot,
        ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
        PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
        USERPROFILE: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        TEMP: temporary,
        TMP: temporary,
      }
    : {}),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  XDG_STATE_HOME: path.join(home, '.local', 'state'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  TMPDIR: temporary,
  // An empty folder for T3 Code, the run's own
  T3CODE_HOME: t3Home,
  // Claude Code fetches no newer Claude Code, and asks the internet for nothing it can do without
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ...Object.fromEntries(['CI'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
}
// The real Claude Code, as npm installs it into the run's folder: the folder of the commands npm
// makes for it, and its own program
const claudeCommands = at('claude-install', 'node_modules', '.bin')
const claudeProgram = at('claude-install', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
/**
 * T3 Code: its launcher is run by the Node that runs this, and the `claude` it runs is the script
 * that writes down how T3 Code started it before it becomes the real Claude Code. On Windows,
 * where that script would have to be one that cmd.exe reads, it is the real Claude Code's own
 * program, and the run learns the conversation from T3 Code's own account of the thread alone.
 */
const t3Env = {
  ...common,
  PATH: [...(windows ? [path.dirname(claudeProgram)] : [t3Bin]), path.dirname(process.execPath), ...systemPath].join(path.delimiter),
  // On this machine alone
  T3CODE_LAN: 'false',
}
/** It, and the real Claude Code that `it setup` connects. */
const itEnv = {
  ...common,
  PATH: [claudeCommands, path.dirname(process.execPath), ...systemPath].join(path.delimiter),
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

/**
 * Ends a program the run started and everything it started in turn: outside Windows each is
 * started in a process group of its own, which is ended whole, and on Windows the system's own
 * `taskkill` ends the program's tree. Only programs the run itself started are given to this.
 */
function endTree(pid, signal = 'SIGKILL') {
  if (typeof pid !== 'number') return
  try {
    if (windows) execFileSync(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {}
  }
}
/**
 * Runs a program to its end; resolves with its exit code and what it printed. One that takes too
 * long is ended with all it started, and one that has ended is not waited for longer because
 * something it started still holds what it prints.
 */
function ran(program, args, { env = itEnv, cwd = work, ms = 120_000, input } = {}) {
  if (env === t3Env) ownT3(env)
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, env, detached: !windows, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out, err })
    }
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    if (input !== undefined) child.stdin.end(input)
    const timer = setTimeout(() => endTree(child.pid), ms)
    child.on('error', (e) => {
      err += e.message
      finish(null)
    })
    child.on('exit', (code) => setTimeout(() => finish(code), 2000))
    child.on('close', (code) => finish(code))
  })
}
/** T3 Code's launcher from its package, run by this Node: on Windows npm's command for it is one that cmd.exe reads. */
const launcher = at('t3-install', 'node_modules', 't3', 'bin', 't3.mjs')
const t3 = (args, options) => ran(process.execPath, [launcher, ...args, '--base-dir', t3Home], { env: t3Env, ...options })
const t3Json = async (args, options) => {
  const r = await t3([...args, '--json'], options)
  let said
  try {
    said = JSON.parse(r.out)
  } catch {}
  if (r.code !== 0 || said === undefined)
    throw new Error(`t3 ${args.slice(0, 2).join(' ')} ended with ${r.code}${said === undefined ? ' and printed no JSON' : ''}: ${(r.err || r.out).slice(-600)}`)
  return said
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
// On Windows npm is a command that cmd.exe reads; nothing it is given here has a space in it
const npm = (args, cwd) =>
  execFileSync(windows ? 'npm.cmd' : 'npm', args, { cwd, env: npmEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: windows })
/** Installs a package from npm into a folder of the run's own. */
function install(spec, folder) {
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'package.json'), '{"private":true}\n')
  npm(['install', '--no-audit', '--no-fund', spec], folder)
}

let server = null
let serve = null
let browser = null
let other = null

/**
 * Stops one program the run started, and waits for it: asked first, and ended where it does not
 * stop. On Windows, where there is no signal to ask with, It's service is asked by a file in It's
 * folder (`service.stop`), as It itself asks it there.
 */
async function stopProgram(child, ms = 60_000, { it: isIt = false } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true
  if (windows && isIt) writeFileSync(path.join(itHome, 'service.stop'), '')
  // It is asked alone, and stops its backend program itself; T3 Code's launcher, its program and
  // what that started are asked together, as a terminal would ask them
  else if (isIt || windows) child.kill('SIGTERM')
  else endTree(child.pid, 'SIGTERM')
  const end = Date.now() + ms
  while (child.exitCode === null && child.signalCode === null && Date.now() < end) await sleep(250)
  const asked = child.exitCode !== null || child.signalCode !== null
  if (!asked) endTree(child.pid)
  return asked
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/**
 * The processes running a program that lives in a folder, each with that program: only programs
 * this run installed live in its folders (T3 Code's own program, the real Claude Code, It's backend
 * program), so a process is known to be the run's own by its program and nothing else. On Linux
 * the system names each process's program; on Windows PowerShell is asked, with the folder handed
 * to it in its surroundings and not written into what it runs. Null where that could not be asked,
 * and an empty list on a system where neither is so.
 */
function runningFrom(folder) {
  // Windows takes a folder's name in either case
  const plain = (name) => (windows ? `${name}${path.sep}`.toLowerCase() : `${name}${path.sep}`)
  const within = (file) => plain(file).startsWith(plain(folder))
  if (windows) {
    try {
      // Written out as UTF-8, which is how it is read, whatever the console's code page
      const script =
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.ExecutablePath }"
      return execFileSync(
        path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          env: { SystemRoot: systemRoot, PATH: path.join(systemRoot, 'System32') },
        },
      )
        .split(/\r?\n/)
        .map((line) => /^(\d+)\|(.+)$/.exec(line.trim()))
        .filter((m) => m && Number(m[1]) !== process.pid && within(m[2]))
        .map((m) => Number(m[1]))
    } catch {
      return null
    }
  }
  if (process.platform !== 'linux') return []
  const found = []
  for (const name of readdirSync('/proc')) {
    const pid = Number(name)
    if (!Number.isInteger(pid) || pid === process.pid) continue
    try {
      if (within(realpathSync(`/proc/${pid}/exe`))) found.push(pid)
    } catch {}
  }
  return found
}
/** Whether a process is the run's own T3 Code's program, by the program it runs, and may be ended. */
const t3Program = (pid) => (runningFrom(realpathSync(t3Home)) ?? []).includes(pid)
/**
 * The processes of the run's that are still running, or null where that could not be asked: those
 * of the programs installed in its folders. The Node processes the run starts itself (T3 Code's
 * launcher, It's service) are not among them, and are stopped and waited for by their own handles.
 */
const leftOver = () => runningFrom(realpathSync(top))
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
      stillUp = !(await stopProgram(serve, 90_000, { it: true }))
      check('It stops when it is asked to', !stillUp, stillUp ? `It (process ${serve.pid}) is still running on ${itHome}` : '')
    }
    // T3 Code's launcher passes the signal on to T3 Code's own program, which is waited for too
    const program = noted()?.pid
    if (server) await stopProgram(server, 30_000)
    if (typeof program === 'number') {
      const end = Date.now() + 30_000
      while (alive(program) && Date.now() < end) await sleep(250)
      // Only the very program T3 Code noted, and only where it is the run's own T3 Code's
      if (alive(program) && t3Program(program)) endTree(program)
      await sleep(1000)
    }
    // Whatever of the run's is still running now, a program that T3 Code or It started among it,
    // is ended, and said; and the run fails where something cannot be ended
    const left = leftOver() ?? []
    if (left.length) {
      note(`${left.length} process${left.length === 1 ? '' : 'es'} of the run’s were still running once it had stopped what it started, and were ended`)
      for (const pid of left) endTree(pid)
      await sleep(2000)
    }
    const still = leftOver()
    stillUp = still === null || still.length > 0 || (typeof program === 'number' && alive(program) && t3Program(program))
    check(
      'no program the run installed or started is left running',
      !stillUp,
      still === null ? 'the system could not be asked which processes run the run’s programs' : still.length ? `still running: ${still.join(', ')}` : '',
    )
    if (results.some((r) => !r.ok)) {
      for (const [name, file] of [
        ['It, with its connector', path.join(logs, 'serve.log')],
        ['T3 Code', path.join(logs, 't3.log')],
      ])
        if (existsSync(file)) console.log(`\nThe end of what ${name} wrote:\n${readFileSync(file, 'utf8').slice(-3000)}`)
    }
    if (stillUp) console.log(`\nSomething the run started is still running, so its folders are kept in ${top}. Stop it, then remove them.`)
    else if (!keep) {
      try {
        rmSync(top, { recursive: true, force: true, maxRetries: 5 })
      } catch (err) {
        check('the run’s folders are removed', false, `${top}: ${err.message}`)
      }
    } else console.log(`\nThe run's folders are kept in ${top}`)
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
  install(`t3@${want}`, at('t3-install'))
  // The real Claude Code, from its package: It's side connects it with `it setup`, and T3 Code runs
  // it for its threads, each with a folder of its own for Claude Code's settings and no account
  const claudeVersion = npm(['view', '@anthropic-ai/claude-code', 'version'], top).trim()
  install(`@anthropic-ai/claude-code@${claudeVersion}`, at('claude-install'))
  // What T3 Code runs as `claude` outside Windows: a script that writes down how T3 Code started
  // it, each word ended by a NUL and each start by a word of its own, and then becomes the real
  // Claude Code
  if (!windows)
    writeFileSync(
      path.join(t3Bin, 'claude'),
      [
        '#!/bin/sh',
        `{ for word in "$@"; do printf '%s\\0' "$word"; done; printf '\\036\\0'; } >> '${at('claude-calls')}'`,
        `exec '${claudeProgram}' "$@"`,
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
  const program = path.join(t3Home, 'runtime', 'versions', want, windows ? 't3.exe' : 't3')
  check(
    'and its launcher keeps T3 Code’s own program where It looks for it, by version and marked as installed whole',
    existsSync(program) && existsSync(path.join(t3Home, 'runtime', 'versions', want, '.install-complete')),
  )

  // ---------- T3 Code's server, in the run's own folder ----------
  ownT3(t3Env)
  server = spawn(process.execPath, [launcher, 'serve', '--base-dir', t3Home, '--port', String(t3Port), '--host', '127.0.0.1', '--no-browser', work], {
    cwd: work,
    env: t3Env,
    detached: !windows,
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
    process.platform === 'linux'
      ? 'and T3 Code’s own command: the program T3 Code runs as its server, as the system names it, which is the one its launcher keeps'
      : 'and T3 Code’s own command: the program its launcher keeps, by the version T3 Code noted',
    found?.command?.length === 1 && realpathSync(found.command[0]) === realpathSync(program),
    found?.command,
  )
  const kept = own.t3Command(t3Home, up.serverVersion)
  check('which It also finds by the version T3 Code noted, where the system does not say', kept?.command?.length === 1 && kept.command[0] === program, kept)

  // Which versions of T3 Code's protocol the real server speaks, as it answers for its threads
  const token = (await t3Json(['auth', 'session', 'issue', '--scope', 'orchestration:read', '--ttl', '1h', '--label', 'It run'])).token
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

  /**
   * The Claude Code conversation that T3 Code's own account of a thread says it holds, read here
   * and not by It's code: the id T3 Code gave the program, as the thread's snapshot names it.
   */
  const projectionOf = async (id) => {
    const answer = await fetch(`${up.origin}/api/orchestration/threads/${encodeURIComponent(id)}/bounded`, {
      headers: { authorization: `Bearer ${token}`, 'x-t3-orchestration-protocol': '2' },
      signal: AbortSignal.timeout(10_000),
    })
    return answer.ok ? ((await answer.json())?.projection ?? null) : null
  }
  /** The provider thread of a thread that holds its Claude Code conversation, as T3 Code's snapshot says. */
  const claudeOf = (projection, id) =>
    (projection?.providerThreads ?? []).find((p) => p?.appThreadId === id && p.driver === 'claudeAgent' && p.nativeThreadRef?.strength === 'strong')
  const conversationOf = async (id) => {
    const own = claudeOf(await projectionOf(id), id)
    return typeof own?.nativeThreadRef?.nativeId === 'string' ? own.nativeThreadRef.nativeId : null
  }

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
  // T3 Code names the conversation in its account of the thread, and outside Windows the run also
  // sees it hand that very id to the `claude` it starts for the thread
  const conversation = await untilTrue(() => conversationOf(thread), 60_000)
  if (windows) check('T3 Code’s own account of the thread names the Claude Code conversation it holds', conversation, conversation)
  else {
    const first = await untilTrue(async () => claudeCalls().map(conversationIn).find(Boolean), 60_000)
    check(
      'T3 Code starts Claude Code for the thread, and names the conversation it is to be, which is the one its own account of the thread names',
      conversation && first?.how === 'session-id' && first.id === conversation,
      { first, conversation, calls: claudeCalls() },
    )
  }
  if (!conversation) throw new Error('T3 Code named no conversation for Claude Code')
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
  const besideConversation = await untilTrue(() => conversationOf(beside), 60_000)
  check('and another thread beside it, for another conversation', beside && beside !== thread && besideConversation && besideConversation !== conversation, {
    beside,
    besideConversation,
  })
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
  // Made from the real server by asking it in the version above It's, which the server was seen
  // above to refuse; one that speaks that version as well cannot stand for one that does not
  if (speaks.includes(3)) note(`T3 Code ${want} speaks version 3 of its protocol as well, so a T3 Code that speaks only another version is not tried`)
  else {
    other = await otherProtocol(up.origin, base + 51)
    const elsewhere = { ...found, origin: other.origin }
    search = own.t3Search()
    const unread = await own.t3ThreadOf(elsewhere, of, search, AbortSignal.timeout(30_000))
    const unknown = await own.t3RunsNow(elsewhere, nobody, AbortSignal.timeout(30_000))
    const before = (await t3Json(['thread', 'show', thread, '--messages', '50'])).messages
    const refused = await own.t3Send(elsewhere, thread, 'a message T3 Code should refuse')
    const after = (await t3Json(['thread', 'show', thread, '--messages', '50'])).messages
    // Every read of threads was asked in the other version and refused by the real server itself,
    // not by the stand-in for a server it could not reach. T3 Code still issues the ticket for its
    // socket in that version, and refuses the socket that would carry the message
    const answers = other.asked
    const refusedNow = (a) => a.passed === '3' && typeof a.status === 'number' && a.status >= 400 && a.status < 500
    const reads = answers.filter((a) => a.path.startsWith('/api/orchestration/'))
    const refusedByT3 = reads.length > 0 && reads.every(refusedNow)
    const sockets = answers.filter((a) => a.method === 'socket')
    check(
      'asked in a version T3 Code does not speak, It is refused by the real server and takes that for not knowing: never for no thread',
      refusedByT3 && unread.status === 'incomplete' && !unread.progressed && unknown.status === 'unknown',
      { unread, unknown, reads: reads.slice(0, 6) },
    )
    check(
      'and puts no message to the thread, and says why in words of its own',
      typeof refused === 'string' &&
        refused.length > 0 &&
        sockets.length > 0 &&
        sockets.every(refusedNow) &&
        Array.isArray(before) &&
        before.length > 0 &&
        Array.isArray(after) &&
        after.length === before.length,
      { refused, before: before?.length, after: after?.length, answers: answers.slice(-3) },
    )
    await other.close()
    other = null
  }

  // ---------- A whole It, and the real Claude Code for It's side ----------
  const setup = await it(['setup', '--only', 'claude-code', '--no-service'], { ms: 300_000 })
  const claude = setup.harnesses?.find((h) => h.id === 'claude-code')
  check(`\`it setup --only claude-code\` connects the real Claude Code ${claudeVersion}`, claude?.addon === 'connected', setup.harnesses ?? setup)
  /** Starts It's service, and waits for it and its connector. */
  const startIt = async () => {
    serve = spawn(COMMAND[0], [...COMMAND.slice(1), 'serve'], {
      cwd: work,
      env: itEnv,
      detached: !windows,
      stdio: ['ignore', openSync(path.join(logs, 'serve.out.log'), 'a'), openSync(path.join(logs, 'serve.log'), 'a')],
    })
    return untilTrue(async () => {
      const s = await it(['status'])
      return s.running && s.connector?.ok ? s : null
      // A Windows runner was seen to take more than two minutes the first time
    }, 300_000)
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
  // T3 Code starts a turn of the thread for a message a person puts to it, which is what makes it a
  // turn and not only a line kept in the thread: a run of its own, made for that message, on the
  // provider thread of that same conversation, and begun
  const firstRun = settled.messages.find((m) => m.text === 'Make me a page with one button.')?.runId
  const run = await untilTrue(async () => {
    const projection = await projectionOf(thread)
    const message = projection?.messages?.find((m) => m.role === 'user' && m.text === clicked?.text)
    const r = projection?.runs?.find((x) => x.id === clicked?.runId)
    const provider = claudeOf(projection, thread)
    return r?.startedAt && message ? { run: r, message: message.id, provider } : null
  }, 30_000)
  check(
    'T3 Code takes it up as a turn of its own in the thread: a run for that message, on the same conversation, which T3 Code began',
    typeof firstRun === 'string' &&
      typeof clicked?.runId === 'string' &&
      clicked.runId !== firstRun &&
      run?.run.userMessageId === run?.message &&
      run?.provider?.nativeThreadRef?.nativeId === conversation &&
      run?.run.providerThreadId === run?.provider?.id,
    { firstRun, clicked: clicked?.runId, run },
  )
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
  const disabled = await ran(claudeProgram, ['plugin', 'disable', 'it-bridge@it'], { env: itEnv, ms: 60_000 })
  const off = await untilTrue(async () => {
    const s = await it(['status'])
    const h = s.harnesses?.find((x) => x.id === 'claude-code')
    return h && h.addon !== 'connected' ? h : null
  }, 30_000)
  check('Claude Code’s own command turns It’s add-on off, and `it status` says so', disabled.code === 0 && off, { disabled, off })
  // The connector looks again at what is installed when it starts, when the apps chosen change, and
  // every half hour: It is started again, so that its connector has seen the add-on turned off
  const stopped = await stopProgram(serve, 90_000, { it: true })
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
  // What reached the thread, a while after the last click was handed over: each click once, there,
  // and nothing in the thread beside it
  await sleep(5000)
  const finalShown = await t3Json(['thread', 'show', thread, '--messages', '50'])
  const besideShown = await t3Json(['thread', 'show', beside, '--messages', '50'])
  const delivered = (finalShown.messages ?? []).filter((m) => m.text.startsWith('[It]'))
  check(
    'each click reached that thread once, and the thread beside it got none',
    Array.isArray(besideShown.messages) &&
      besideShown.messages.some((m) => m.text === 'Something else.') &&
      !besideShown.messages.some((m) => m.text.startsWith('[It]')) &&
      delivered.length === 2 &&
      new Set(delivered.map((m) => m.text)).size === 2,
    { delivered: delivered.map((m) => m.text.slice(-60)), beside: besideShown.messages?.map((m) => m.text.slice(0, 60)) },
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
