// The real Claude Code, with It, from a fresh machine to a click that comes back as a turn. It
// needs no account: Claude Code's model is a stand-in on this machine that answers by a script
// (claude-code/model.mjs), reached with ANTHROPIC_BASE_URL and a made-up key.
//
//   node e2e/apps/claude-code.mjs <folder Claude Code was installed into> [--setup-only]
//
// The folder is one that `npm install --prefix` installed the official package into, so that
// its `bin` holds `claude`. Everything else is made here, in throwaway folders: a home, Claude
// Code's settings folder (CLAUDE_CONFIG_DIR) and an It of the run's own, at IT_PORT (4700 where
// nothing says another). Neither program is given anything of the environment this script is
// run in but what it needs, so nothing of the person's own Claude Code, It or T3 Code is read or
// written. The It is the Node bundle that `npm run generate` built, or IT_CLI.
//
// First, with no model at all: `it setup` connects Claude Code and nothing else, Claude Code
// itself says that It's add-on is installed and on, and `it status` agrees; the add-on is turned
// off with Claude Code's own command, It says that it is off, and it is turned back on.
//
// Then the loop, with the stand-in for the model: the first turn runs `it create --open` for a
// page with one button, a browser paired as the owner's presses the button, and the stand-in must
// then be asked for a new turn of the same conversation whose newest user message begins `[It]`
// and ends `[action <id>]` for that click. It answers by running `it patch`, and the page's state
// shows the change. Then Claude Code is closed and the button pressed again: It's service
// reopens the conversation with Claude Code's own command (Auto-wake), and the reopened turn,
// asked of the same stand-in, changes the page again. `--setup-only` stops before the loop.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { root, sleep, stopped } from '../lib.mjs'
import { printCleanly, verdict } from '../logs.mjs'
import { runs, standInModel, words } from './claude-code/model.mjs'
import { commandNames, homeOnWindows, systemPath, windows } from './windows.mjs'

printCleanly()
const args = process.argv.slice(2)
const prefix = args.find((a) => !a.startsWith('--'))
const setupOnly = args.includes('--setup-only')
// On Windows, `npm install --global --prefix` puts the command, `claude.cmd`, in the folder itself
// and not in its bin, and the program it runs is the package's own `claude.exe`, which is what
// this script starts itself: a .cmd file is started only through a shell
const CLAUDE =
  prefix &&
  (windows
    ? path.join(path.resolve(prefix), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    : path.join(path.resolve(prefix), 'bin', 'claude'))
if (!prefix || !existsSync(CLAUDE) || (windows && !existsSync(path.join(prefix, 'claude.cmd')))) {
  console.error(
    `Give the folder Claude Code was installed into with \`npm install --global --prefix\`, which holds ${windows ? '`claude.cmd`' : '`bin/claude`'}.`,
  )
  process.exit(2)
}
/** The folder whose `claude` a person's shell, and It, would find: the one npm put the command in. */
const CLAUDE_FOLDER = windows ? path.resolve(prefix) : path.dirname(CLAUDE)
const CLI = path.resolve(process.env.IT_CLI ?? path.join(root, 'packages/cli/dist/it.mjs'))
// The standalone program, where IT_BIN names one, in place of the Node bundle. It is put where
// It's installers put it, in It's folder's bin, and run from there.
const STANDALONE = process.env.IT_BIN ? path.resolve(process.env.IT_BIN) : null
const PORT = Number(process.env.IT_PORT ?? 4700)
const PLUGIN = 'it-bridge@it'
const PAGE = 'one-button'
// Nothing that looks like a key of Anthropic's, so that no check for credentials takes it for one
const MADE_UP_KEY = 'a-made-up-key-for-a-stand-in-model'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  console.log(verdict(name, ok, detail, 1200))
  return Boolean(ok)
}
/** Stops the run where nothing after a check can mean anything once it has failed. */
class Stop extends Error {}
const must = (name, ok, detail) => {
  if (!check(name, ok, detail)) throw new Stop(name)
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'it-cc-'))
const folders = Object.fromEntries(
  Object.entries({ home: 'home', claude: 'claude', it: 'it', work: 'work', none: 'no-t3-code', browser: 'browser' }).map(([k, v]) => [
    k,
    path.join(scratch, v),
  ]),
)
for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true })
const IT = STANDALONE ? [path.join(folders.it, 'bin', windows ? 'it.exe' : 'it')] : [process.execPath, CLI]
if (STANDALONE) {
  mkdirSync(path.dirname(IT[0]), { recursive: true })
  copyFileSync(STANDALONE, IT[0])
  // With the record the installers write beside it (INSTALLATION in packages/cli/src/installation.ts)
  writeFileSync(path.join(folders.it, 'installation.json'), '{"product":"It","format":1,"about":"This folder holds an installation of It."}\n')
}
let cleaning = null
/** Once the run has begun to clean up, it starts nothing more: whatever it would start, it stops here. */
const notStopping = () => {
  if (cleaning) throw new Stop('the run is stopping')
}
// Asked to stop, the run stops what it started before it ends
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    check(`the run finished (it was stopped by ${signal})`, false)
    cleanUp().finally(() => process.exit(1))
  })

// The only PATH either program is given: Claude Code's own folder, the Node that runs It (none
// for the standalone program, which needs none), and the system's. No `it` is put on it: It's
// add-on puts It's own folder there for the commands a conversation runs, and that is part of
// what is tested.
const PATH = [CLAUDE_FOLDER, ...(STANDALONE ? [] : [path.dirname(process.execPath)]), ...systemPath()].join(path.delimiter)
/** What every program the run starts is given, and nothing more. */
const base = {
  PATH,
  HOME: folders.home,
  // On Windows, where a home of the run's own is given by more than HOME
  ...homeOnWindows(folders.home),
  LANG: 'C.UTF-8',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  CLAUDE_CONFIG_DIR: folders.claude,
  DISABLE_AUTOUPDATER: '1',
  // Claude Code sends no telemetry and no error reports. CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  // would stop more, and is not set: with it, Claude Code 2.1.287 loads It's add-on and never runs
  // the add-on's clock, so that it never asks for clicks, and a run with it would test a Claude
  // Code that few people have
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  IT_HOME: folders.it,
  IT_PORT: String(PORT),
  // It looks for Claude Code alone, and never for the T3 Code of whoever runs this
  IT_HARNESSES: 'claude-code',
  T3CODE_HOME: folders.none,
  // Usage counts go to a port where nothing listens, and never to the real address
  IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
  ...(process.env.IT_BACKEND_BIN ? { IT_BACKEND_BIN: process.env.IT_BACKEND_BIN } : {}),
}

/** The environment the browser is started with: nothing of this script's own, and a home of its own. */
const browserEnv = {
  PATH,
  HOME: folders.browser,
  ...homeOnWindows(folders.browser),
  XDG_CONFIG_HOME: path.join(folders.browser, 'config'),
  XDG_CACHE_HOME: path.join(folders.browser, 'cache'),
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
}

/** Runs a program to its end, with `base` and anything more given. */
function run(program, argv, more = {}, ms = 180_000) {
  return new Promise((resolve) => {
    const child = spawn(program, argv, { env: { ...base, ...more }, cwd: folders.work, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const late = setTimeout(() => child.kill('SIGKILL'), ms)
    child.on('error', (e) => resolve({ code: -1, out, err: `${err}${e.message}` }))
    child.on('close', (code) => {
      clearTimeout(late)
      resolve({ code, out, err })
    })
  })
}
/** The `it` command, which answers in JSON to a program. A last argument `{ env, ms }` adds to its environment and limits how long it may take. */
async function it(...argv) {
  const { env = {}, ms = 60_000 } = typeof argv.at(-1) === 'object' ? argv.pop() : {}
  const r = await run(IT[0], [...IT.slice(1), ...argv], env, ms)
  let json = null
  try {
    json = JSON.parse(r.out)
  } catch {}
  return { ...r, json }
}
const claude = (...argv) => run(CLAUDE, argv, {}, 120_000)
/** What Claude Code itself lists of It's plugin: null where it could not be asked. */
async function listed() {
  const r = await claude('plugin', 'list', '--json')
  try {
    return { found: JSON.parse(r.out).find((p) => p.id === PLUGIN), said: r.out + r.err }
  } catch {
    return { found: null, said: r.out + r.err }
  }
}
const statusOf = async (ms) => {
  const r = await it('status', { ms })
  return { claudeCode: r.json?.harnesses?.find((h) => h.id === 'claude-code'), said: r.out + r.err }
}
/**
 * Asks again until `ok` holds of what `ask` gives, or the time is up; gives the last answer. Each
 * asking is given what is left of the time, at least two seconds, as the most it may take.
 */
async function until(ask, ok, ms) {
  const end = Date.now() + ms
  const left = () => Math.max(2000, end - Date.now())
  let last = await ask(left())
  while (!ok(last) && Date.now() < end) {
    await sleep(500)
    last = await ask(left())
  }
  return last
}
/** Whether a process is still there. */
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}
/** Whether something on this machine answers 200 at a port and path. */
const answers = (port, p, host) =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: host ? { host } : {}, timeout: 3000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })

let service
let serviceFault = null
let conversation
let conversationFault = null
let browser
/** The browser while it starts, so that cleaning up can wait for it and close it. */
let launching = null
let model
const serviceLog = path.join(scratch, 'service.log')
const debugFile = path.join(scratch, 'claude-debug.txt')
const events = []
let claudeSaid = ''

let sessionAtFirst = null
const clickTurns = []

try {
  // The script the stand-in answers by. The person's message makes a page; the page's result
  // ends that turn; a click on it, as a turn of its own, is answered by changing the page's
  // state; and that result ends the turn. It is started first, so that It's service is given its
  // address too, for the conversation it reopens.
  model = await standInModel((turn) => {
    const result = turn.results[0]
    const resultText = result ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content)) : ''
    if (!result && /^Make a page with one button/.test(turn.text)) {
      sessionAtFirst = turn.session
      return runs(
        `it create "One button" --id ${PAGE} --state '{"pressed":"no"}' --open --html '<p>Pressed: <b id="seen" data-it-bind="pressed">no</b></p><button id="go">Press</button><script>document.getElementById("go").onclick = () => It.action("press")</script>'`,
        'Making the page.',
      )
    }
    if (!result && turn.text.startsWith('[It]')) {
      clickTurns.push(turn)
      return runs(`it patch ${PAGE} '{"pressed":"${clickTurns.length === 1 ? 'yes' : 'again'}"}'`, 'Marking the page as pressed.')
    }
    if (result) return words(result.is_error ? `The command failed: ${resultText.slice(0, 300)}` : 'Done.')
    return words('Nothing to do.')
  })
  Object.assign(base, { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: MADE_UP_KEY })

  const version = (await claude('--version')).out.trim()
  console.log(`Claude Code ${version}, installed from its package into ${prefix}\n`)

  // ---------- with no model ----------
  // No `it` is to be found on the PATH the programs are given, or the commands a conversation
  // runs could reach it without the add-on having put It's own there
  const already = PATH.split(path.delimiter).filter((folder) =>
    commandNames('it').some((name) => {
      try {
        return statSync(path.join(folder, name)).isFile()
      } catch {
        return false
      }
    }),
  )
  must('no `it` is on the PATH the run gives its programs', already.length === 0, already.join(', '))
  // The first run on a fresh machine, connecting Claude Code and no other app
  const setup = await it('setup', '--only', 'claude-code', '--no-service', { ms: 300_000 })
  const connected = setup.json?.harnesses?.find((h) => h.id === 'claude-code')
  must('`it setup --only claude-code` connects Claude Code', setup.code === 0 && connected?.addon === 'connected', setup.out + setup.err)

  // The service has It's own folder on its PATH, as a service started from a shell that the install
  // script has put it on has, and as Auto-wake's note to a reopened conversation says it is. The
  // conversation this run starts itself is not given it: the add-on puts it there.
  notStopping()
  service = spawn(IT[0], [...IT.slice(1), 'serve'], {
    env: { ...base, PATH: `${PATH}${path.delimiter}${path.join(folders.it, 'bin')}` },
    cwd: folders.work,
    stdio: ['ignore', openSync(serviceLog, 'w'), openSync(serviceLog, 'a')],
  })
  service.on('error', (err) => (serviceFault = err))
  const upBy = Date.now() + 240_000
  let up = false
  while (!up && Date.now() < upBy && service.exitCode === null && !serviceFault) {
    up = (await answers(PORT + 41, '/health')) && (await answers(PORT, '/', `localhost:${PORT}`))
    if (!up) await sleep(1000)
  }
  must(
    'It’s service starts, with its backend and its site',
    up,
    serviceFault?.message ?? (existsSync(serviceLog) ? readFileSync(serviceLog, 'utf8').slice(-2000) : ''),
  )

  let { found, said } = await listed()
  check('Claude Code itself lists It’s plugin, installed and turned on', found?.enabled === true, said)
  let now = await statusOf()
  check('and `it status` agrees that Claude Code is connected', now.claudeCode?.addon === 'connected', now.said)

  const off = await claude('plugin', 'disable', PLUGIN, '--scope', 'user')
  ;({ found, said } = await listed())
  check('Claude Code turns It’s plugin off with its own command', off.code === 0 && found?.enabled === false, off.out + off.err + said)
  now = await until(statusOf, (s) => s.claudeCode?.addon === 'disabled', 20_000)
  check(
    'and `it status` says that the add-on is turned off in Claude Code',
    now.claudeCode?.addon === 'disabled' && /turned off/.test(now.claudeCode?.detail ?? ''),
    now.said,
  )

  const on = await claude('plugin', 'enable', PLUGIN, '--scope', 'user')
  ;({ found, said } = await listed())
  check('Claude Code turns it back on with its own command', on.code === 0 && found?.enabled === true, on.out + on.err + said)
  now = await until(statusOf, (s) => s.claudeCode?.addon === 'connected', 20_000)
  must('and `it status` says that Claude Code is connected again', now.claudeCode?.addon === 'connected', now.said)

  if (!setupOnly) {
    // ---------- the loop, with a stand-in for the model ----------
    // A browser paired as the owner's, with the site open, for the page to be brought up on
    const site = await it('site', '--no-open')
    const pairing = site.json?.url
    must('`it site` gives an address that pairs a browser', typeof pairing === 'string', site.err)
    notStopping()
    launching = chromium.launch({ env: browserEnv })
    browser = await launching
    notStopping()
    const tab = await (await browser.newContext()).newPage()
    await tab.goto(pairing)
    await tab.locator('header.bar').waitFor({ timeout: 30_000 })

    // Claude Code as a host such as T3 Code runs it: one process, messages in and events out as
    // lines of JSON. It may run `it` and nothing else without asking, as It's own reopening of
    // a conversation allows.
    // The conversation's id is chosen here, so that It can be asked about it before anything is said in it
    const session = randomUUID()
    notStopping()
    conversation = spawn(
      CLAUDE,
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--session-id',
        session,
        '--allowedTools',
        'Bash(it:*)',
        '--debug-file',
        debugFile,
      ],
      {
        cwd: folders.work,
        env: base,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let buf = ''
    conversation.stdout.on('data', (d) => {
      buf += d
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        try {
          events.push(JSON.parse(line))
        } catch {}
      }
    })
    conversation.stderr.on('data', (d) => (claudeSaid += d))
    conversation.on('error', (err) => (conversationFault = err))
    const ended = () => conversation.exitCode !== null || conversationFault !== null
    const finished = () => events.filter((e) => e.type === 'result')
    const untilFinished = async (n, ms) => {
      const end = Date.now() + ms
      while (finished().length < n && Date.now() < end && !ended()) await sleep(200)
      return finished().length >= n
    }

    // The add-on, once Claude Code has loaded it, asks the connector for the conversation's clicks
    // and puts It's folder on the PATH of the commands the conversation runs. Until then a command
    // that names no conversation and an `it` that is not found would say nothing of the add-on:
    // the person's first message is typed once It says that a click would arrive by itself, as
    // a person typing takes longer than that.
    const asWhat = { IT_HARNESS: 'claude-code', IT_SESSION: session }
    const heard = await until(
      (ms) => it('status', { env: asWhat, ms }),
      (s) => s.json?.arrives?.byItself === true,
      60_000,
    )
    const loaded = () => (existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : '')
    must(
      'Claude Code loads It’s add-on, and It says that a click on that conversation’s page arrives by itself through it',
      heard.json?.arrives?.byItself === true && heard.json.arrives.via === 'addon' && /hooks module it-bridge@it loaded/.test(loaded()),
      `${conversationFault?.message ?? ''}${JSON.stringify(heard.json?.arrives ?? heard.err)}\n${loaded()
        .split('\n')
        .filter((l) => l.includes('it-bridge'))
        .join('\n')}`,
    )

    conversation.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Make a page with one button on It.' } })}\n`)
    const firstDone = await untilFinished(1, 120_000)
    const created = model.turns.flatMap((t) => t.results).find(Boolean)
    must(
      'the first turn runs `it create --open` through Claude Code’s own Bash tool, and ends',
      firstDone && finished()[0]?.subtype === 'success' && created && !created.is_error,
      JSON.stringify({ created, result: finished()[0]?.subtype }),
    )
    const made = await it('read', PAGE)
    must(
      'the page belongs to that Claude Code conversation',
      made.json?.session?.harness === 'claude-code' && made.json?.session?.id === session && sessionAtFirst === session,
      JSON.stringify({ made: made.json?.session ?? made.err, session, sessionAtFirst }),
    )
    // What `it create` told the agent, as Claude Code handed it back to the model
    let told = null
    try {
      const output = typeof created.content === 'string' ? created.content : created.content.map((b) => b.text ?? '').join('')
      // Claude Code may add a line of its own after the command's output, as it does on Windows
      // ("Shell cwd was reset to …"): what It printed is the JSON object before it
      told = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1))
    } catch {}
    check(
      'and `it create` told the agent that a click arrives by itself, through the add-on',
      told?.arrives?.byItself === true && told.arrives.via === 'addon',
      JSON.stringify(told?.arrives ?? created.content),
    )
    // The page, as `--open` brought it up in the browser, or as the browser opens it
    const frame = tab.frameLocator('.mount iframe')
    const shown = await frame
      .locator('#go')
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    check('`--open` brought the page up in the paired browser', shown, tab.url())
    if (!shown) await tab.goto(new URL(`/p/${PAGE}`, pairing).href)
    await frame.locator('#go').waitFor({ timeout: 30_000 })

    // A click, as a person makes it, while the conversation is idle
    await frame.locator('#go').click()
    const clickBy = Date.now() + 90_000
    while (!clickTurns.length && Date.now() < clickBy && !ended()) await sleep(200)
    const action = (await it('read', PAGE)).json?.recentActions?.[0]
    const turn = clickTurns[0]
    must(
      'the click comes back into Claude Code as a new turn, asked of the model',
      turn !== undefined,
      JSON.stringify({ action, turns: model.turns.map((t) => t.text.slice(0, 120) || `(${t.results.length} results)`), asides: model.asides }),
    )
    check(
      'its newest user message begins `[It]` and ends `[action <id>]` for that click',
      action?.id && turn.text.startsWith('[It]') && turn.text.endsWith(`[action ${action.id}]`),
      JSON.stringify({ text: turn.text, action: action?.id }),
    )
    check(
      'in the same conversation: Claude Code’s own id for it, and the turns before it',
      turn.session === session && JSON.stringify(turn.messages).includes(`--id ${PAGE}`),
      JSON.stringify({ session, asked: turn.session }),
    )
    // The add-on tells the connector once Claude Code has taken the prompt, which may be just after the model is asked
    const handed = await until(
      (ms) => it('read', PAGE, { ms }),
      (r) => r.json?.recentActions?.find((a) => a.id === action?.id)?.delivery === 'handed_off',
      15_000,
    )
    const recorded = handed.json?.recentActions?.find((a) => a.id === action?.id)
    check(
      'It records that the add-on handed the click over',
      recorded?.delivery === 'handed_off' && recorded?.route === 'addon',
      JSON.stringify(recorded ?? handed.err),
    )
    check('and the turn ends', await untilFinished(2, 60_000), JSON.stringify(finished()))
    const state = await until(
      (ms) => it('state', PAGE, { ms }),
      (s) => s.json?.state?.pressed === 'yes',
      15_000,
    )
    check('the agent’s `it patch` changed the page’s state', state.json?.state?.pressed === 'yes', state.out + state.err)
    const seen = await frame
      .locator('#seen', { hasText: 'yes' })
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    check('and the page in the browser shows it', seen)

    // ---------- a closed conversation, reopened ----------
    // Claude Code is closed, and the page is pressed again. It's service, which was given the
    // same stand-in for the model, reopens the conversation with Claude Code's own command: that
    // is Auto-wake, which is on from when the app was connected.
    await stopped(conversation)
    const closed = await until(
      (ms) => it('status', { env: asWhat, ms }),
      (s) => s.json?.arrives && s.json.arrives.via !== 'addon',
      30_000,
    )
    check(
      'once Claude Code is closed, It no longer hears its add-on in that conversation',
      closed.json?.arrives && closed.json.arrives.via !== 'addon',
      JSON.stringify(closed.json?.arrives ?? closed.err),
    )
    await frame.locator('#go').click()
    const wokenBy = Date.now() + 120_000
    while (clickTurns.length < 2 && Date.now() < wokenBy) await sleep(250)
    const second = (await it('read', PAGE)).json?.recentActions?.[0]
    const woken = clickTurns[1]
    must(
      'a click on the page of the closed conversation reopens it through Claude Code’s own command, as a new turn asked of the model',
      woken !== undefined,
      JSON.stringify({ action: second, turns: model.turns.map((t) => t.text.slice(0, 120) || `(${t.results.length} results)`) }),
    )
    check(
      'its newest user message is that click in It’s wording, `[It] … [action <id>]`, with It’s note on reopening after it',
      second?.id &&
        second.id !== action?.id &&
        /^\[It\] [^\n]*\[action ([^\]]+)\]$/m.exec(woken.text)?.[1] === second.id &&
        woken.text.startsWith('[It]') &&
        /\n\n\[It\] It reopened this conversation/.test(woken.text),
      JSON.stringify({ text: woken.text, action: second?.id }),
    )
    check(
      'and it is the same conversation, by Claude Code’s own id for it, carried on with the turns before it',
      woken.session === session && JSON.stringify(woken.messages).includes(`--id ${PAGE}`) && JSON.stringify(woken.messages).includes(`[action ${action?.id}]`),
      JSON.stringify({ session, asked: woken.session }),
    )
    const again = await until(
      (ms) => it('state', PAGE, { ms }),
      (s) => s.json?.state?.pressed === 'again',
      30_000,
    )
    check(
      'the reopened conversation’s `it patch` changed the page’s state',
      again.json?.state?.pressed === 'again',
      `${again.out}${again.err}\nwhat the command gave the model: ${JSON.stringify(model.turns.slice(model.turns.indexOf(woken) + 1).flatMap((t) => t.results))}`,
    )
    check(
      'and the page in the browser shows it',
      await frame
        .locator('#seen', { hasText: 'again' })
        .waitFor({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false),
    )
    if (model.faults.length) check('the stand-in for the model answered every request', false, model.faults.join('; '))
  }
} catch (err) {
  if (!(err instanceof Stop)) check(`the run finished (${err.message})`, false, err.stack)
} finally {
  await cleanUp()
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} passed`)
process.exit(failed.length ? 1 : 0)

/**
 * Stops everything the run started, waits for it, says what each part said where a check failed,
 * and removes the run's folders: only once every program that used them has gone. Run once, from
 * the end of the run or when the run is asked to stop.
 */
function cleanUp() {
  cleaning ??= (async () => {
    await stopped(conversation)
    // A browser that was still starting when the run was asked to stop is waited for, and closed
    await (browser ?? (await launching?.catch(() => null)))?.close().catch(() => {})
    // The service is asked to stop, and stops its connector, the conversations it reopened and
    // its backend, and is waited for. A service that stopped cleanly when asked has stopped what
    // it started. One that did not, or that ended by itself before, may have left its backend or
    // a reopened conversation running, each in a process group of its own: the run's folder is
    // then kept, since they may still be using it.
    let clean = !service || serviceFault !== null
    if (service && service.exitCode === null && service.signalCode === null && !serviceFault) {
      const exited = new Promise((r) => service.once('exit', (code, signal) => r({ code, signal })))
      // On Windows, which has no signal to ask with, by the file It's service looks for in its folder
      if (windows) writeFileSync(path.join(folders.it, 'service.stop'), '')
      else service.kill('SIGTERM')
      const how = await Promise.race([exited, sleep(90_000).then(() => null)])
      clean = check('It’s service stops when it is asked to', how?.code === 0, JSON.stringify(how ?? 'still running after ninety seconds'))
      if (!how) {
        service.kill('SIGKILL')
        await Promise.race([exited, sleep(10_000)])
      }
    }
    // The backend is followed by the process ids the service wrote down for it, and a process is
    // taken for it only while its command line names this run's It folder, so that an id the
    // system has given to another program since is left alone
    const backends = existsSync(serviceLog) ? [...readFileSync(serviceLog, 'utf8').matchAll(/backend: started \(pid (\d+)\)/g)].map((m) => Number(m[1])) : []
    const commandLine = (pid) =>
      (windows
        ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], {
            encoding: 'utf8',
            windowsHide: true,
          })
        : spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
      ).stdout ?? ''
    const ours = (pid) => alive(pid) && commandLine(pid).includes(folders.it)
    const stillOurs = async (ms) => {
      const end = Date.now() + ms
      while (backends.some(ours) && Date.now() < end) await sleep(250)
      return backends.filter(ours)
    }
    let left = await stillOurs(30_000)
    if (left.length) {
      check('It’s backend program stopped with the service', false, `still running: ${left.join(', ')}`)
      for (const pid of left) process.kill(pid, 'SIGKILL')
      left = await stillOurs(10_000)
    }
    await model?.close()
    report()
    // Kept where something that used it may still be running, and said so
    if (left.length || !clean || (service && service.exitCode === null && service.signalCode === null))
      console.log(`\nSomething the run started may still be running, so its folder is kept: ${scratch}`)
    else
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch (err) {
        console.log(`\nThe run’s folder could not be removed (${err.code}): ${scratch}`)
      }
  })()
  return cleaning
}

/** What each part said, for whoever reads a failed run. */
function report() {
  if (results.some((r) => !r.ok)) {
    // What each part said, for whoever reads a failed run. Nothing here holds a credential: It
    // writes none to its log, the address that pairs the browser is not printed, and the key is
    // made up.
    const tail = (file, n) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(-n).join('\n') : '(nothing)')
    console.log(`\n--- the service’s log, its end\n${tail(serviceLog, 60)}`)
    console.log(
      `\n--- what Claude Code wrote of It’s add-on\n${
        existsSync(debugFile)
          ? readFileSync(debugFile, 'utf8')
              .split('\n')
              .filter((l) => /it-bridge|plugin|hook/i.test(l))
              .slice(-40)
              .join('\n')
          : '(nothing)'
      }`,
    )
    console.log(`\n--- Claude Code’s events\n${events.map((e) => `${e.type} ${e.subtype ?? ''}`).join('\n')}\n${claudeSaid.slice(-2000)}`)
    if (model)
      console.log(
        `\n--- what the stand-in for the model was asked\n${model.turns.map((t) => JSON.stringify({ text: t.text.slice(0, 200), results: t.results.length, session: t.session })).join('\n')}\nasides: ${model.asides.join(', ')}`,
      )
  }
}
