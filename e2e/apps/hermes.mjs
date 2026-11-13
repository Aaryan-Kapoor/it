// The real Hermes Agent, with It, from a fresh machine to a click that comes back as a turn. It
// needs no account: Hermes's model is a stand-in on this machine that answers by a script
// (hermes/model.mjs), set as Hermes's custom provider with no key.
//
//   node e2e/apps/hermes.mjs <the home Hermes was installed into>
//
// The home is one that Hermes's own installer installed into, with HOME pointed at it, so that
// it holds `.local/bin/hermes` and Hermes's folder `.hermes`. It is throwaway, and the run uses
// it as the home of everything it starts. An It of the run's own is made in a folder of its own
// (IT_HOME), at IT_PORT (4700 where nothing says another). No program is given anything of the
// environment this script runs in but what it needs, so nothing of the person's own Hermes, It
// or T3 Code is read or written. The It is the Node bundle that `npm run generate` built, or
// IT_CLI.
//
// First, as a person sets It up: `it setup` connects Hermes and nothing else, Hermes itself lists
// It's add-on as enabled, and the plain `hermes` terminal is started, in a pseudo-terminal
// (hermes/terminal.py), from a shell that has It on its PATH, as a new terminal has after It's
// install script. Once Hermes has loaded the add-on and It hears it, `it status` says either that
// the add-on is at work or that Hermes refuses what it hands over, and what setup told the person
// must agree with that.
//
// Then the loop, with the stand-in for the model. The person's first message is typed into the
// terminal, and the first turn runs `it create --open` for a page with one button and ends. A
// browser paired as the owner's presses the button. Where It said that Hermes refuses the
// add-on, the click must wait and the model must be asked nothing; then the command that setup
// and `it status` give is run, `it status` must say that the add-on is at work, and the click
// that waited must arrive. Where It said the add-on is at work, the click must arrive at once.
// Arriving means that Hermes asks the stand-in for a new turn of the same conversation whose
// newest user message begins `[It]` and ends `[action <id>]` for that click. The stand-in answers
// by running `it patch`, and the page's state and the page in the browser show the change. A
// second click must then arrive the same way.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { root, sleep, stopped } from '../lib.mjs'
import { printCleanly, verdict } from '../logs.mjs'
import { newestFromUser, standInModel, textOf } from './hermes/model.mjs'

printCleanly()
const given = process.argv[2]
if (!given || !existsSync(path.join(given, '.local', 'bin', 'hermes'))) {
  console.error('Give the home that Hermes’s installer installed into, whose .local/bin holds `hermes`.')
  process.exit(2)
}
const HOME = path.resolve(given)
const HERMES = path.join(HOME, '.local', 'bin', 'hermes')
const HERMES_HOME = path.join(HOME, '.hermes')
const CLI = path.resolve(process.env.IT_CLI ?? path.join(root, 'packages/cli/dist/it.mjs'))
const PORT = Number(process.env.IT_PORT ?? 4700)
const MODEL_PORT = PORT + 50
const PAGE = 'one-button'
const ALLOW = 'hermes config set plugins.entries.it-bridge.allow_gateway_injection true'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  console.log(verdict(name, ok, detail, 1500))
  return Boolean(ok)
}
/** Stops the run where nothing after a check can mean anything once it has failed. */
class Stop extends Error {}
const must = (name, ok, detail) => {
  if (!check(name, ok, detail)) throw new Stop(name)
}
const note = (words) => console.log(`  note ${words}`)

// It's folder is short, since its connector listens on a socket file inside it
const scratch = mkdtempSync(path.join(os.tmpdir(), 'it-hermes-'))
const folders = Object.fromEntries(Object.entries({ it: 'it', work: 'work', none: 'no-t3-code' }).map(([k, v]) => [k, path.join(scratch, v)]))
for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true })

// What every program the run starts is given, and nothing more. The PATH has Hermes's own folder,
// the Node that runs It and the system's. It's own folder is put on it only for the terminal, as a
// person's new terminal has it after It's install script.
const PATH = [path.dirname(HERMES), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter)
const base = {
  PATH,
  HOME,
  HERMES_HOME,
  LANG: 'C.UTF-8',
  SHELL: '/bin/bash',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  IT_HOME: folders.it,
  IT_PORT: String(PORT),
  // It looks for Hermes alone, and never for the T3 Code of whoever runs this
  IT_HARNESSES: 'hermes',
  T3CODE_HOME: folders.none,
  // Usage counts go to a port where nothing listens, and never to the real address
  IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
  ...(process.env.IT_BACKEND_BIN ? { IT_BACKEND_BIN: process.env.IT_BACKEND_BIN } : {}),
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
/** The `it` command, which answers in JSON to a program. */
async function it(...argv) {
  const r = await run(process.execPath, [CLI, ...argv])
  let json = null
  try {
    json = JSON.parse(r.out)
  } catch {}
  return { ...r, json }
}
const hermes = (...argv) => run(HERMES, argv, {}, 120_000)
/** Hermes's own list of the plugins a person added, and what it says of It's. */
async function listed() {
  const r = await hermes('plugins', 'list', '--json', '--no-bundled')
  try {
    return { found: JSON.parse(r.out).find((p) => p.name === 'it-bridge'), said: r.out + r.err }
  } catch {
    return { found: null, said: r.out + r.err }
  }
}
const statusOf = async () => {
  const r = await it('status')
  return { hermes: r.json?.harnesses?.find((h) => h.id === 'hermes'), said: (r.out + r.err).slice(-1500) }
}
/** Asks again until `ok` holds of what `ask` gives, or the time is up; gives the last answer. */
async function until(ask, ok, ms, every = 500) {
  const end = Date.now() + ms
  let last = await ask()
  while (!ok(last) && Date.now() < end) {
    await sleep(every)
    last = await ask()
  }
  return last
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
/** Whether a semver-like version is later than another. */
const later = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** What the terminal shows, as text: its escapes taken out, its lines as they were drawn. */
const screenFile = path.join(scratch, 'screen.txt')
const screen = () =>
  existsSync(screenFile)
    ? readFileSync(screenFile, 'utf8')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's escapes are what is taken out
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g, '')
        .replace(/\r/g, '\n')
    : ''

let service
let terminal
let browser
let model
const serviceLog = path.join(scratch, 'service.log')

// The script the stand-in answers by. The person's message makes the page; the command's result
// ends that turn; a click, as a turn of its own, is answered by changing the page's state; and
// that result ends the turn.
const clickTurns = []
const script = (request) => {
  const last = request.messages.at(-1)
  if (last?.role === 'tool') return { text: 'Done.' }
  const said = newestFromUser(request) ?? ''
  if (said.startsWith('[It]')) {
    clickTurns.push(request)
    return { run: `it patch ${PAGE} '{"pressed":"${clickTurns.length === 1 ? 'yes' : 'again'}"}'` }
  }
  if (said.startsWith('Make a page with one button')) {
    return {
      run: `it create "One button" --id ${PAGE} --state '{"pressed":"no"}' --open --html '<p>Pressed: <b id="seen" data-it-bind="pressed">no</b></p><button id="go">Press</button><script>document.getElementById("go").onclick = () => It.action("press")</script>'`,
    }
  }
  return { text: 'Nothing to do.' }
}
/** What a command the stand-in had Hermes run gave back, as Hermes handed it to the model. */
const resultOf = (command) => {
  for (const turn of model.turns) {
    const messages = turn.body.messages
    const call = messages.findIndex((m) => m.role === 'assistant' && JSON.stringify(m.tool_calls ?? []).includes(command))
    const result = call >= 0 ? messages.slice(call + 1).find((m) => m.role === 'tool') : null
    if (result) return textOf(result)
  }
  return null
}

try {
  model = await standInModel({ port: MODEL_PORT, script })

  const versionSaid = (await hermes('--version')).out
  const version = /\bv?(\d+\.\d+\.\d+)/.exec(versionSaid)?.[1]
  must('Hermes Agent runs and says its version', version, versionSaid)
  console.log(`Hermes Agent ${version}, installed by its own installer into ${HOME}\n`)
  // Hermes before 0.21.6 takes a plugin's message in the plain terminal, where the plugin runs.
  // A later one has a setting by which the person allows it, and 0.23.1 runs the terminal's agent
  // in a gateway where a plugin's message is refused until it is allowed.
  const needsAllowing = later(version, '0.21.5')

  // ---------- as a person sets It up ----------
  // Hermes's model is the stand-in, set as a person sets a custom provider
  for (const [key, value] of [
    ['model.provider', 'custom'],
    ['model.base_url', model.url],
    ['model.default', 'script'],
  ]) {
    const set = await hermes('config', 'set', key, value)
    must(`Hermes takes \`${key}\` for its model`, set.code === 0, set.out + set.err)
  }

  const setupAt = Date.now()
  const setup = await it('setup', '--only', 'hermes', '--no-service')
  const connected = setup.json?.harnesses?.find((h) => h.id === 'hermes')
  must('`it setup --only hermes` connects Hermes', setup.code === 0 && connected?.addon === 'connected', setup.out + setup.err)
  note(`setup took ${Math.round((Date.now() - setupAt) / 1000)} s`)
  // Hermes 0.20.1 asks a question as it enables a plugin; setup must not wait on it and call the install failed
  check(
    'setup installs the add-on, and Hermes’s own command that enables it finishes',
    setup.json?.addons?.find((a) => a.id === 'hermes')?.did === 'installed',
    JSON.stringify(setup.json?.addons),
  )
  const told = setup.json?.tell ?? ''
  check(
    needsAllowing
      ? 'setup tells the person to allow It’s add-on with Hermes’s own command'
      : 'setup tells the person that a click arrives in the plain terminal, with nothing to allow',
    needsAllowing ? told.includes(ALLOW) : /arrives by itself in the plain `hermes` terminal/.test(told) && !told.includes(ALLOW),
    told,
  )
  const { found, said } = await listed()
  must('Hermes itself lists It’s plugin as enabled', found?.status === 'enabled', said)

  service = spawn(process.execPath, [CLI, 'serve'], {
    env: base,
    cwd: folders.work,
    stdio: ['ignore', openSync(serviceLog, 'w'), openSync(serviceLog, 'a')],
  })
  const upBy = Date.now() + 240_000
  let up = false
  while (!up && Date.now() < upBy && service.exitCode === null) {
    up = (await answers(PORT + 41, '/health')) && (await answers(PORT, '/', `localhost:${PORT}`))
    if (!up) await sleep(1000)
  }
  must('It’s service starts, with its backend and its site', up, existsSync(serviceLog) ? readFileSync(serviceLog, 'utf8').slice(-2000) : '')

  // A browser paired as the owner's, with the site open, for the page to be brought up on
  const site = await it('site', '--no-open')
  const pairing = site.json?.url
  must('`it site` gives an address that pairs a browser', typeof pairing === 'string', site.err)
  browser = await chromium.launch()
  const tab = await (await browser.newContext()).newPage()
  await tab.goto(pairing)
  await tab.locator('header.bar').waitFor({ timeout: 30_000 })

  // The plain `hermes` terminal, as a person starts it in a new terminal
  terminal = spawn('python3', ['-I', path.join(root, 'e2e/apps/hermes/terminal.py'), screenFile, HERMES], {
    env: { ...base, PATH: `${path.join(folders.it, 'bin')}${path.delimiter}${PATH}`, TERM: 'xterm-256color' },
    cwd: folders.work,
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  const type = (line) => terminal.stdin.write(`${line}\n`)
  // A Hermes asks once whether to share what it measures; the answer is its own default, No thanks
  // It's status is read once it has settled: as it starts, a Hermes can report from before it
  // knows that it is a terminal (0.21.5 says for a second that it refuses the add-on)
  let asked = false
  const readings = []
  const heard = await until(
    async () => {
      // Drawn as a numbered choice or as a menu, its default is No thanks, which Enter takes
      if (!asked && /Help improve Hermes\?[\s\S]*No thanks/.test(screen())) {
        asked = true
        await sleep(1000)
        type('')
      }
      const now = await statusOf()
      readings.push(now.hermes?.runtime?.state ?? 'none')
      return now
    },
    (s) =>
      s.hermes?.runtime?.state &&
      s.hermes.runtime.state !== 'inactive' &&
      readings.slice(-5).every((r) => r === s.hermes.runtime.state) &&
      readings.length >= 5,
    120_000,
    1000,
  )
  if (new Set(readings.filter((r) => r !== 'inactive' && r !== 'none')).size > 1)
    note(`It’s status went ${[...new Set(readings)].join(', then ')} as Hermes started`)
  must(
    'Hermes loads It’s add-on, and It hears it',
    heard.hermes?.runtime?.version,
    `${JSON.stringify(heard.hermes ?? heard.said)}\nthe terminal: ${screen().slice(-1500)}`,
  )
  const refused = heard.hermes.runtime.state === 'incompatible' && (heard.hermes.runtime.detail ?? '').includes(ALLOW)
  const atWork = heard.hermes.runtime.state === 'active'
  check('It’s status says that the add-on is at work, or that Hermes refuses it and how to allow it', refused || atWork, JSON.stringify(heard.hermes.runtime))
  console.log(`  It says that ${refused ? 'Hermes refuses what the add-on hands over' : 'the add-on is at work'}\n`)
  if (refused) check('and setup told the person how to allow it', told.includes(ALLOW), told)
  if (!needsAllowing) check('a Hermes before 0.21.6 needs nothing allowed, as setup said', atWork, JSON.stringify(heard.hermes.runtime))
  // Ready for a message once the terminal has stopped drawing for a moment
  let before = ''
  await until(
    async () => {
      const now = screen()
      const still = now === before
      before = now
      return still
    },
    (still) => still,
    15_000,
    1500,
  )

  // ---------- the loop, with the stand-in for the model ----------
  type('Make a page with one button on It.')
  const madeBy = Date.now() + 120_000
  let created = null
  while (!created && Date.now() < madeBy && terminal.exitCode === null) {
    await sleep(300)
    created = resultOf('it create')
  }
  // Hermes hands a command's result to the model as JSON with its output in it
  let createdJson = null
  try {
    const output = String(JSON.parse(created)?.output ?? created)
    createdJson = JSON.parse(output.slice(output.indexOf('{')))
  } catch {}
  must(
    'the first turn runs `it create --open` through Hermes’s own terminal tool',
    createdJson?.id === PAGE,
    `${created}\nthe terminal: ${screen().slice(-1500)}\nasked: ${model.turns.length}, asides: ${model.asides.join('; ')}`,
  )
  const made = await it('read', PAGE)
  const session = made.json?.session?.id
  must('the page belongs to a Hermes conversation', made.json?.session?.harness === 'hermes' && session, JSON.stringify(made.json?.session ?? made.err))
  // It cannot always tell whether Hermes lets the add-on speak, and then says so; it never says
  // that a click arrives by itself where its status says that Hermes refuses it
  check(
    refused
      ? 'and `it create` told the agent that a click does not arrive by itself'
      : 'and `it create` did not tell the agent that a click does not arrive by itself',
    refused ? createdJson?.arrives?.byItself === false : createdJson?.arrives && createdJson.arrives.byItself !== false,
    JSON.stringify(createdJson?.arrives),
  )
  const frame = tab.frameLocator('.mount iframe')
  const shown = await frame
    .locator('#go')
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('`--open` brought the page up in the paired browser', shown, tab.url())
  if (!shown) await tab.goto(new URL(`/p/${PAGE}`, pairing).href)
  await frame.locator('#go').waitFor({ timeout: 30_000 })
  // The first turn has ended once the stand-in has answered the command's result
  await until(
    async () => model.turns.length,
    (n) => n >= 2,
    30_000,
  )
  await sleep(2000)

  // A click, as a person makes it, while the conversation is idle
  const askedBefore = model.turns.length
  await frame.locator('#go').click()
  const action = (
    await until(
      () => it('read', PAGE),
      (r) => r.json?.recentActions?.length > 0,
      15_000,
    )
  ).json?.recentActions?.[0]
  must('It stores the click', action?.id, JSON.stringify(action))

  if (refused) {
    await sleep(15_000)
    const waiting = (await it('read', PAGE)).json?.recentActions?.find((a) => a.id === action.id)
    check(
      'while Hermes refuses the add-on, the click waits where `it wait` and the site take it, and Hermes is asked nothing',
      waiting?.delivery === 'pending' && waiting.route === null && model.turns.length === askedBefore && clickTurns.length === 0,
      JSON.stringify({ waiting, asked: model.turns.length - askedBefore }),
    )
    const allowed = await hermes(...ALLOW.split(' ').slice(1))
    must('Hermes takes the command that allows It’s add-on', allowed.code === 0, allowed.out + allowed.err)
    const now = await until(statusOf, (s) => s.hermes?.runtime?.state === 'active', 30_000)
    check('and `it status` then says that the add-on is at work, with no restart', now.hermes?.runtime?.state === 'active', now.said)
  }

  const clickBy = Date.now() + 90_000
  while (!clickTurns.length && Date.now() < clickBy && terminal.exitCode === null) await sleep(250)
  const turn = clickTurns[0]
  must(
    refused
      ? 'the click that waited comes back into Hermes as a new turn, asked of the model'
      : 'the click comes back into Hermes as a new turn, asked of the model',
    turn !== undefined,
    JSON.stringify({
      action: (await it('read', PAGE)).json?.recentActions?.[0],
      status: (await statusOf()).hermes,
      asked: model.turns.map((t) => (newestFromUser(t.body) ?? '').slice(0, 120)),
    }),
  )
  const text = newestFromUser(turn)
  check(
    'its newest user message begins `[It]` and ends `[action <id>]` for that click',
    text.startsWith('[It]') && text.endsWith(`[action ${action.id}]`),
    JSON.stringify({ text, action: action.id }),
  )
  check(
    'in the same conversation: the turn that made the page comes before it',
    turn.messages.some((m) => m.role === 'user' && textOf(m).startsWith('Make a page with one button')) &&
      JSON.stringify(turn.messages).includes(`--id ${PAGE}`),
    JSON.stringify(turn.messages.map((m) => `${m.role}: ${textOf(m).slice(0, 60)}`)),
  )
  const handed = await until(
    () => it('read', PAGE),
    (r) => r.json?.recentActions?.find((a) => a.id === action.id)?.delivery === 'handed_off',
    15_000,
  )
  const recorded = handed.json?.recentActions?.find((a) => a.id === action.id)
  check(
    'It records that the add-on handed the click over',
    recorded?.delivery === 'handed_off' && recorded?.route === 'addon',
    JSON.stringify(recorded ?? handed.err),
  )
  const state = await until(
    () => it('state', PAGE),
    (s) => s.json?.state?.pressed === 'yes',
    30_000,
  )
  check('the agent’s `it patch` changed the page’s state', state.json?.state?.pressed === 'yes', `${state.out}${state.err}\n${resultOf('it patch')}`)
  check(
    'and the page in the browser shows it',
    await frame
      .locator('#seen', { hasText: 'yes' })
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false),
  )
  // Whether the terminal showed the click's turn. The documents say that from 0.23.1 it does not.
  note(
    /it patch one-button/.test(screen())
      ? 'the plain terminal showed the turn the click started'
      : 'the plain terminal did not show the turn the click started; the agent had it and answered on the page',
  )

  // A second click, on an idle conversation, with nothing else done
  await until(
    async () => model.turns.length,
    (n) => n >= model.turns.findIndex((t) => t.body === turn) + 2,
    30_000,
  )
  await sleep(2000)
  await frame.locator('#go').click()
  const secondBy = Date.now() + 60_000
  while (clickTurns.length < 2 && Date.now() < secondBy && terminal.exitCode === null) await sleep(250)
  const second = (await it('read', PAGE)).json?.recentActions?.[0]
  const again = clickTurns[1]
  check(
    'a second click comes back as a new turn in the same conversation, in It’s wording',
    again &&
      second?.id !== action.id &&
      newestFromUser(again).endsWith(`[action ${second?.id}]`) &&
      JSON.stringify(again.messages).includes(`[action ${action.id}]`),
    JSON.stringify({ second, asked: model.turns.map((t) => (newestFromUser(t.body) ?? '').slice(0, 120)) }),
  )
  const pressedAgain = await until(
    () => it('state', PAGE),
    (s) => s.json?.state?.pressed === 'again',
    30_000,
  )
  check('and its `it patch` changed the page again', pressedAgain.json?.state?.pressed === 'again', pressedAgain.out + pressedAgain.err)
  if (model.faults.length) check('the stand-in for the model answered every request', false, model.faults.join('; '))
} catch (err) {
  if (!(err instanceof Stop)) check(`the run finished (${err.message})`, false, err.stack)
} finally {
  // The terminal is closed as a person closes it. Hermes's background gateway outlives it, so it
  // is stopped by the process id Hermes notes for it, and only where Hermes says it is its gateway.
  if (terminal && terminal.exitCode === null) terminal.stdin.end()
  await stopped(terminal, 20_000)
  try {
    const noted = JSON.parse(readFileSync(path.join(HERMES_HOME, 'gateway.pid'), 'utf8'))
    if (noted?.kind === 'hermes-gateway' && Number.isInteger(noted.pid) && noted.pid > 1) {
      process.kill(noted.pid, 'SIGTERM')
      const end = Date.now() + 20_000
      while (Date.now() < end) {
        try {
          process.kill(noted.pid, 0)
        } catch {
          break
        }
        await sleep(250)
      }
      try {
        process.kill(noted.pid, 'SIGKILL')
      } catch {}
    }
  } catch {}
  await stopped(service, 60_000)
  await browser?.close().catch(() => {})
  await model?.close()
  if (results.some((r) => !r.ok)) {
    // What each part said, for whoever reads a failed run. Nothing here holds a credential: It
    // writes none to its log, the address that pairs the browser is not printed, and the model needs no key.
    const tail = (file, n) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(-n).join('\n') : '(nothing)')
    console.log(`\n--- the service’s log, its end\n${tail(serviceLog, 60)}`)
    for (const log of ['gateway.log', 'agent.log', 'errors.log'])
      console.log(
        `\n--- Hermes’s ${log}, its lines about plugins\n${tail(path.join(HERMES_HOME, 'logs', log), 400)
          .split('\n')
          .filter((l) => /plugin|it-bridge|inject/i.test(l))
          .slice(-30)
          .join('\n')}`,
      )
    console.log(
      `\n--- the terminal, its end\n${screen()
        .split('\n')
        .filter((l) => l.trim())
        .slice(-40)
        .join('\n')}`,
    )
    if (model)
      console.log(
        `\n--- what the stand-in for the model was asked\n${model.turns.map((t) => JSON.stringify({ said: (newestFromUser(t.body) ?? '').slice(0, 200), last: t.body.messages.at(-1)?.role })).join('\n')}\nasides: ${model.asides.join(', ')}`,
      )
  }
  rmSync(scratch, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
