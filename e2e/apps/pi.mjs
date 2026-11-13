// The real Pi, with no account and no model of anyone's: does It's add-on load in it, and does a
// click on a page come back into the conversation as a new turn?
//
// Pi is installed from its official package into a folder of this run's own, and runs with a
// throwaway home and a throwaway settings folder, so that nobody's own Pi is read or written.
// It is the job's own: a folder and a port of its own, set up with the real `it setup` for Pi
// alone, and run with `it serve`.
//
// First, with no model: Pi itself says, with `pi list`, that It's package is installed, and once
// started it loads the add-on, which reports to It's connector, so that `it status` calls it
// active. Turned off as `pi config` turns it off, Pi lists it as filtered and It says it is
// turned off; taken away by `it setup --none`, Pi no longer lists it; and taken away with Pi's
// own `pi remove`, It says it is no longer connected.
//
// Then, with a stand-in for the model's API that Pi is pointed at through its own `models.json`
// and given a made-up key: the stand-in's first answer runs `it create --open` for a page with
// one button, and the turn ends. A browser paired as the owner's clicks the button, and the run
// passes only where Pi then sends the stand-in a new request in the same conversation whose
// newest message from the user is the click, beginning `[It]` and ending `[action <id>]`. The
// stand-in answers that with `it patch`, and the page shows the change.
//
//   node e2e/apps/pi.mjs --version <version | oldest | newest>   installs that Pi from npm first
//   node e2e/apps/pi.mjs --pi <path to a pi program>              runs the Pi that is there
//
// IT_PORT is the port the run's It counts from (5800 where it is not set), and the stand-in model
// listens 50 above it. IT_PI_ROOT is the folder the run's folders are made in; It's connector
// listens at a socket in It's folder, whose path a system holds to about a hundred characters.
// IT_BIN and IT_CLI name the It to run, as for the other end-to-end scripts.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COMMAND, root, sleep } from '../lib.mjs'
import { printCleanly, verdict } from '../logs.mjs'
import { launch, pairAsOwner } from '../site.mjs'
import { newestFromUser, shellTool, standInModel, textOf } from './pi/model.mjs'
import { startPi } from './pi/rpc.mjs'

printCleanly()
const PACKAGE = '@earendil-works/pi-coding-agent'
const argv = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const asked = option('--version')
const given = option('--pi')
if (!asked === !given) {
  console.error('usage: node e2e/apps/pi.mjs (--version <version | oldest | newest> | --pi <path to a pi program>)')
  process.exit(2)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  console.log(verdict(name, ok, typeof detail === 'string' ? detail : JSON.stringify(detail), 1200))
  return Boolean(ok)
}
const began = Date.now()

const base = Number(process.env.IT_PORT ?? 5800)
const top = mkdtempSync(path.join(process.env.IT_PI_ROOT ?? os.tmpdir(), 'itpi-'))
const at = (...p) => path.join(top, ...p)
const home = at('home')
const agent = at('pi-agent')
const itHome = at('it')
const bin = at('bin')
const work = at('work')
const logs = at('logs')
for (const f of [home, agent, bin, work, logs, at('t3')]) mkdirSync(f, { recursive: true })
if (path.join(itHome, 'connector.sock').length > 100) {
  console.error(`It's folder would be ${itHome}, and the socket in it too long a path for the system. Name a shorter folder in IT_PI_ROOT.`)
  rmSync(top, { recursive: true, force: true })
  process.exit(2)
}

/** The oldest Pi that `it setup` installs into, as the source says. */
function oldest() {
  const source = readFileSync(path.join(root, 'packages/cli/src/setup.ts'), 'utf8')
  const found = /\bpi: \{ label: 'Pi', bin: 'pi', min: '([^']+)' \}/.exec(source)
  if (!found) throw new Error('the oldest Pi that `it setup` installs into was not found in packages/cli/src/setup.ts')
  return found[1]
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
/** Installs Pi from its package into this run's folder, and gives the path of its program. */
function install(version) {
  const want =
    version === 'oldest'
      ? oldest()
      : version === 'newest'
        ? execFileSync(npm, ['view', PACKAGE, 'version'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim()
        : version
  const into = at('pi-install')
  mkdirSync(into, { recursive: true })
  writeFileSync(path.join(into, 'package.json'), '{"private":true}\n')
  execFileSync(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', `${PACKAGE}@${want}`], {
    cwd: into,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  })
  return { program: path.join(into, 'node_modules', '.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi'), want }
}

// The Pi the run is about, put on the PATH of everything the run starts under the name `pi`, so
// that `it setup`, the connector and the run itself all find this one and no other
const pi = given ? { program: path.resolve(given), want: null } : install(asked)
symlinkSync(pi.program, path.join(bin, 'pi'))

// What every program the run starts is given: nothing of whoever runs it but the PATH and the
// language, so that no key for a model, no setting of theirs and no folder of theirs is seen.
const env = {
  PATH: [bin, path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter),
  LANG: 'C.UTF-8',
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  XDG_STATE_HOME: path.join(home, '.local', 'state'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
  PI_CODING_AGENT_DIR: agent,
  // Pi asks the internet for nothing as it starts: no newer catalog of models, no newer Pi
  PI_OFFLINE: '1',
  IT_HOME: itHome,
  IT_PORT: String(base),
  IT_HARNESSES: 'pi',
  IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
  // An empty folder, so that the connector never finds a T3 Code of whoever runs this
  T3CODE_HOME: at('t3'),
  ...Object.fromEntries(
    ['IT_BACKEND_BIN', 'IT_BACKEND_RELEASES', 'CI', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
  ),
}

/** Runs a program to its end in the run's surroundings; resolves with its exit code and what it printed. */
function ran(program, args, { cwd = work, ms = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && /\.cmd$/i.test(program) })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), ms)
    child.on('error', (e) => (err += e.message))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}
/** The run's It: what a command printed, as JSON where it is JSON. Throws where it failed. */
async function it(args, options) {
  const r = await ran(COMMAND[0], [...COMMAND.slice(1), ...args], options)
  let parsed = r.out
  try {
    parsed = JSON.parse(r.out)
  } catch {}
  if (r.code !== 0) {
    let said
    try {
      said = JSON.parse(r.err.trim().split('\n').pop())
    } catch {}
    throw Object.assign(new Error(said?.error?.message ?? `it ${args[0]} exited ${r.code}: ${r.err.slice(-400)}`), { code: said?.error?.code })
  }
  return parsed
}
const piList = () => ran('pi', ['list'], { ms: 60_000 })
const listed = (out) => out.split('\n').some((line) => path.resolve(work, line.trim().replace(/ \(filtered\)$/, '')) === path.join(itHome, 'addons', 'pi'))
const filtered = (out) => out.split('\n').some((line) => line.trim().endsWith(' (filtered)'))
const piStatus = async () => (await it(['status'])).harnesses?.find((h) => h.id === 'pi')
const loaded = async () => (await it(['status'])).connector?.addons?.pi
async function untilTrue(test, ms, every = 500) {
  const end = Date.now() + ms
  for (;;) {
    const got = await test().catch(() => null)
    if (got || Date.now() > end) return got
    await sleep(every)
  }
}

let serve = null
let model = null
let browser = null
const pis = []
const slug = `pi-check-${Date.now().toString(36)}`

try {
  // ---------- The program, and It set up for it ----------
  const version = (await ran('pi', ['--version'])).out.trim()
  console.log(
    `\nPi ${version}${pi.want ? ` (asked for ${asked}, which is ${pi.want})` : ''}, It ${(await it(['--version']).catch(() => ({}))).version ?? '?'}\n`,
  )
  if (pi.want) check('the Pi installed from its package is the version asked for', version === pi.want, `pi --version said ${version}`)

  const setup = await it(['setup', '--only', 'pi', '--no-service'], { ms: 300_000 })
  const said = setup.harnesses?.find((h) => h.id === 'pi')
  check('`it setup --only pi` finds this Pi and connects it', said?.addon === 'connected' && said?.version === version, setup)
  check(
    'and says it installed the add-on',
    setup.addons?.some((a) => a.id === 'pi' && a.did === 'installed'),
    setup.addons,
  )
  let list = await piList()
  check('Pi itself lists It’s package, from It’s folder, with nothing of it filtered out', list.code === 0 && listed(list.out) && !filtered(list.out), list)
  check('`it status` agrees that Pi is connected', (await piStatus())?.addon === 'connected', await piStatus())

  // ---------- It running, and the add-on loaded by Pi ----------
  serve = spawn(COMMAND[0], [...COMMAND.slice(1), 'serve'], {
    cwd: work,
    env,
    stdio: ['ignore', openSync(path.join(logs, 'serve.out.log'), 'w'), openSync(path.join(logs, 'serve.log'), 'w')],
  })
  const up = await untilTrue(async () => {
    const s = await it(['status'])
    return s.running && s.connector?.ok ? s : null
  }, 90_000)
  if (!check('It runs, with its connector', up, readFileSync(path.join(logs, 'serve.log'), 'utf8').slice(-1500))) throw new Error('It did not start')
  check('and has heard from no add-on of Pi’s yet', (await loaded())?.state !== 'active', await loaded())

  // With no model at all, as Pi first starts for someone who has not chosen one
  const bare = startPi('pi', ['--no-session'], { cwd: work, env })
  pis.push(bare)
  const active = await untilTrue(async () => ((await loaded())?.state === 'active' ? await loaded() : null), 30_000)
  check('Pi started with no model loads the add-on, which reports to It’s connector, and `it status` calls it active', active, {
    status: await loaded(),
    pi: bare.stderr().slice(-800),
    ended: bare.ended(),
  })
  check('and the add-on Pi loaded is the build this It carries', active && !active.outdated, active)
  const commands = await bare.command('get_commands')
  check(
    'Pi’s own list of commands has the skill from It’s package',
    commands?.data?.commands?.some(
      (c) => c.name === 'skill:it' && c.source === 'skill' && path.resolve(c.sourceInfo?.baseDir ?? '') === path.join(itHome, 'addons', 'pi'),
    ),
    commands,
  )
  // A command Pi runs is given the conversation's id by the add-on, which is how a page knows its conversation
  const state = await bare.command('get_state')
  const shell = await bare.command('bash', { command: 'printf "%s" "$IT_PI_SESSION"' })
  check('a command Pi runs is told the conversation’s id by the add-on', state?.data?.sessionId && shell?.data?.output?.trim() === state.data.sessionId, {
    state: state?.data?.sessionId,
    shell: shell?.data ?? shell,
  })
  await bare.close()

  // ---------- The loop, with a stand-in for the model ----------
  const typed = 'Make me a page with one button, and show it.'
  const pageHtml =
    '<h1>Pi check</h1><button id=go onclick="It.action(&quot;approve&quot;,{n:1})">Approve</button><p id=said></p>' +
    '<script>It.onState(function(s){document.getElementById("said").textContent=s.answer||""})</script>'
  const answer = 'approved through Pi'
  let actionId = null
  model = await standInModel({
    port: base + 50,
    script(request, n) {
      const tool = shellTool(request)
      if (!tool) throw new Error('Pi offered no tool that runs a command')
      // The person's first message: publish the page and show it
      if (n === 0) return { call: { name: tool.name, arguments: { [tool.param]: `it create "Pi check" --id ${slug} --open --html '${pageHtml}'` } } }
      // The command's result: the turn ends
      if (n === 1) return { text: 'The page is up.' }
      // The click: answer it on the page
      if (n === 2) return { call: { name: tool.name, arguments: { [tool.param]: `it patch ${slug} '${JSON.stringify({ answer })}'` } } }
      if (n === 3) return { text: 'Done.' }
      throw new Error(`no answer is scripted for a request after the fourth, and Pi sent one: ${newestFromUser(request)?.slice(0, 200)}`)
    },
  })
  writeFileSync(
    path.join(agent, 'models.json'),
    `${JSON.stringify({ providers: { standin: { baseUrl: model.url, api: 'openai-completions', apiKey: 'made-up', models: [{ id: 'script', name: 'Scripted stand-in' }] } } }, null, 2)}\n`,
  )

  // A browser paired as the owner's, on the site, where `--open` brings the page up
  const opened = await launch()
  browser = opened.browser
  const run = (_home, args) => it(args)
  await pairAsOwner(opened.page, { home: itHome, run })
  check('a browser is paired as the owner’s', true)

  const host = startPi('pi', ['--provider', 'standin', '--model', 'script'], { cwd: work, env })
  pis.push(host)
  const hostState = await host.command('get_state')
  const session = hostState?.data?.sessionId
  check(
    'Pi runs with the stand-in model chosen through its own models.json',
    hostState?.data?.model?.provider === 'standin' && session,
    hostState?.data ?? { stderr: host.stderr().slice(-800) },
  )
  await untilTrue(async () => ((await loaded())?.state === 'active' ? true : null), 30_000)

  const prompted = await host.command('prompt', { message: typed })
  check('Pi takes the person’s message', prompted?.success === true, prompted)
  await model.until(2, 60_000)
  const first = model.requests[0]?.body
  check(
    'Pi sends it to the stand-in, with a made-up key, in a request that offers its shell tool',
    first && newestFromUser(first) === typed && shellTool(first) && model.requests[0].headers.authorization === 'present',
    first ? { tools: first.tools?.map((t) => t.function?.name) } : 'no request',
  )
  const second = model.requests[1]?.body
  const result =
    second?.messages
      ?.filter((m) => m.role === 'tool')
      .map(textOf)
      .join('\n') ?? ''
  let created = null
  try {
    created = JSON.parse(result.slice(result.indexOf('{'), result.lastIndexOf('}') + 1))
  } catch {}
  check(
    'Pi ran `it create --open` and gave the stand-in what it printed: the page, shown on the display in use',
    created?.id === slug && Array.isArray(created?.shownOn) && created.shownOn.length > 0,
    result.slice(0, 800),
  )
  const settled = await host.until((r) => r.type === 'agent_end', 60_000)
  check('and the turn ends', settled, host.records.slice(-5))

  const made = await it(['read', slug]).catch((e) => ({ error: e.message }))
  check('the page knows the Pi conversation that made it', made.session?.harness === 'pi' && made.session?.id === session, {
    made: made.session ?? made.error,
    session,
  })

  // The page as the owner's browser shows it, brought up there by `--open`
  const frame = opened.page.frameLocator('.mount iframe')
  const shown = await frame
    .locator('#go')
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  if (!check('the owner’s browser brings the page up by itself', shown, opened.page.url())) {
    await opened.page.goto(`http://localhost:${base}/p/${slug}`)
    await frame.locator('#go').waitFor({ timeout: 30_000 })
  }
  const before = model.requests.length
  await frame.locator('#go').click()
  const asked3 = await model.until(before + 1, 60_000)
  const third = model.requests[before]?.body
  const click = newestFromUser(third)
  const ended = /\[action ([^\]\s]+)\]\s*$/.exec(click ?? '')
  actionId = ended?.[1] ?? null
  check(
    'the click comes back into Pi as a new turn: Pi sends the stand-in a request whose newest message from the user begins [It] and ends [action <id>]',
    asked3 && click?.startsWith('[It]') && actionId,
    click ?? `no request from Pi within a minute of the click; Pi said: ${host.stderr().slice(-600)}`,
  )
  const all = third?.messages ?? []
  check(
    'in the same conversation: the request carries the person’s first message and the call that made the page',
    all.some((m) => m.role === 'user' && textOf(m) === typed) &&
      all.some((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.function?.arguments?.includes(`--id ${slug}`))),
    all.map((m) => m.role),
  )
  check('and Pi still holds that conversation under the same id', (await host.command('get_state'))?.data?.sessionId === session)
  const recent = (await it(['read', slug])).recentActions?.find((a) => a.id === actionId)
  check(
    'It records that the add-on handed that click over',
    recent?.delivery === 'handed_off' && recent?.route === 'addon',
    recent ?? (await it(['read', slug])).recentActions,
  )

  await model.until(before + 2, 60_000)
  const patched = await untilTrue(async () => ((await it(['read', slug])).state?.answer === answer ? true : null), 30_000)
  check('Pi runs the stand-in’s `it patch`, and the page’s state has the change', patched, (await it(['read', slug])).state)
  const onPage = await frame
    .locator('#said', { hasText: answer })
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check('and the page in the browser shows it', onPage)
  await host.until((r) => r.type === 'agent_end', 30_000, host.records.indexOf(settled) + 1)
  check('the stand-in had an answer for every request Pi sent', model.faults.length === 0, model.faults)
  await host.close()
  await browser.close().catch(() => {})
  browser = null

  // ---------- Turned off, and taken away, by Pi's own means ----------
  // As `pi config` turns the extension off: the package's entry in Pi's settings becomes an
  // object whose filter of extensions leaves `extensions/it.js` out
  const settingsFile = path.join(agent, 'settings.json')
  const settings = readFileSync(settingsFile, 'utf8')
  const parsed = JSON.parse(settings)
  parsed.packages = parsed.packages.map((p) =>
    typeof p === 'string' && path.resolve(agent, p) === path.join(itHome, 'addons', 'pi') ? { source: p, extensions: ['-extensions/it.js'] } : p,
  )
  writeFileSync(settingsFile, `${JSON.stringify(parsed, null, 2)}\n`)
  list = await piList()
  check('turned off as `pi config` turns it off, Pi lists It’s package as filtered', listed(list.out) && filtered(list.out), list.out)
  check('and `it status` says the add-on is turned off in Pi', (await piStatus())?.addon === 'disabled', await piStatus())
  const off = startPi('pi', ['--no-session'], { cwd: work, env })
  pis.push(off)
  const offShell = await off.command('bash', { command: 'printf "%s" "$IT_PI_SESSION"' })
  check(
    'and Pi does not load it: a command Pi runs is told no conversation by the add-on',
    offShell?.success === true && offShell.data?.output?.trim() === '',
    offShell,
  )
  await off.close()
  writeFileSync(settingsFile, settings)
  check('turned on again, `it status` says Pi is connected', (await piStatus())?.addon === 'connected', await piStatus())

  const none = await it(['setup', '--none', '--no-service'], { ms: 300_000 })
  list = await piList()
  check('`it setup --none` takes the add-on out, and Pi itself no longer lists it', !listed(list.out), { list: list.out, setup: none.addons })
  await it(['setup', '--only', 'pi', '--no-service'], { ms: 300_000 })
  check('`it setup --only pi` puts it back', listed((await piList()).out) && (await piStatus())?.addon === 'connected', await piStatus())
  const removed = await ran('pi', ['remove', path.join(itHome, 'addons', 'pi')])
  list = await piList()
  check('taken away with Pi’s own `pi remove`, Pi no longer lists it', removed.code === 0 && !listed(list.out), { removed, list: list.out })
  check('and `it status` says Pi is no longer connected', (await piStatus())?.addon === 'not_connected', await piStatus())
} catch (err) {
  check(`the run finished (${err.message})`, false, err.stack)
} finally {
  for (const p of pis) await p.close().catch(() => {})
  await browser?.close().catch(() => {})
  await model?.close().catch(() => {})
  if (serve && serve.exitCode === null && serve.signalCode === null) {
    // The service is asked to stop, and waited for: it stops its backend program in its turn
    serve.kill('SIGTERM')
    const end = Date.now() + 90_000
    while (serve.exitCode === null && serve.signalCode === null && Date.now() < end) await sleep(250)
    check('It stops when it is asked to', serve.exitCode !== null || serve.signalCode !== null)
  }
  if (results.some((r) => !r.ok)) {
    for (const [name, file] of [
      ['It', path.join(logs, 'serve.log')],
      ['the connector', path.join(itHome, 'logs', 'connector.log')],
    ])
      if (existsSync(file)) console.log(`\nThe end of what ${name} wrote:\n${readFileSync(file, 'utf8').slice(-3000)}`)
    for (const [i, p] of pis.entries()) if (p.stderr()) console.log(`\nWhat Pi ${i + 1} wrote to its standard error:\n${p.stderr().slice(-2000)}`)
  }
  if (!process.env.IT_PI_KEEP) rmSync(top, { recursive: true, force: true })
  else console.log(`\nThe run's folders are kept in ${top}`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} passed in ${Math.round((Date.now() - began) / 1000)} seconds`)
process.exit(failed.length ? 1 : 0)
