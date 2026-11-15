// A run under the owner's own Windows account, in a throwaway profile: It installed by the real
// install script through the stand-in and set up by the harness with `--no-service`, served by an
// `it serve` the harness starts, and then the agent app in its own terminal (left) and the
// person's browser (right), with the screen recorded from before the person's first word.
//
//   node e2e/rehearsal/arun.mjs --app codex|claude --version <v> [--browser msedge|chrome]
//        [--scenario 1] [--profile-name rehearsal] [--port 5600] [--control 5697] [--id <run id>]
//
// Phases, over the control port (127.0.0.1, POST JSON {cmd}):
//   (start)  It is installed and set up, `it serve` started, the browser paired, the terminal
//            open in the empty project folder; the tester may type (the agent app's own first run).
//   record   the screen recording starts and the tester can no longer type: the person plays.
//   stop     the end: recording stopped, everything the run started stopped by its own id.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { claudeAccess, codexAuth, forget, scrub, shredAll, shredLedger, shredOnExit } from './credentials.mjs'
import { killTree, leftIn, ownerFingerprint, ownerSkillsOff, profileEnv, recorder, runFolders, sleep, stamp, WORK } from './lib.mjs'
import { install, it, personBrowser, SCREEN, setup, terminalView, terminalWindow } from './stage.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const app = arg('app', 'codex')
const version = arg('version', app === 'codex' ? '0.169.0' : '2.1.325')
const channel = arg('browser', 'msedge')
const scenario = arg('scenario', '1')
const port = Number(arg('port', 5600))
const controlPort = Number(arg('control', 5697))
const profileName = arg('profile-name', 'rehearsal')
const person = arg('person', 'model')
const agentInstalls = process.argv.includes('--agent-installs')
const build = process.env.IT_REHEARSAL_BUILD || '68e03a6dc1b2'
const id = arg('id', `${stamp().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-')}-s${scenario}-${app}-${channel}-aarya`)
const MODEL = app === 'codex' ? { model: 'gpt-6.1-sol', effort: 'high' } : { model: 'claude-sonnet-5-5', effort: 'high' }
const appDir = path.join(WORK, 'apps', `${app === 'codex' ? 'codex' : 'claude'}-${version}`)
const appBin = path.join(appDir, 'node_modules', '.bin')

shredOnExit()
shredLedger()
const f = runFolders(id, profileName)
const stepsFile = path.join(f.results, 'steps.log')
let rec = null
const steps = []
const log = (name, seen = '', ok = true) => {
  const t = rec ? Math.round(rec.at() * 10) / 10 : null
  const s = { at: stamp(), video: t, name, ok, seen: scrub(String(seen)).text.slice(0, 3000) }
  steps.push(s)
  const mmss = t === null ? '--:--' : `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  const line = `${mmss} ${ok ? 'ok  ' : 'FAIL'} ${name}${seen ? ` — ${s.seen.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`
  console.log(line)
  writeFileSync(stepsFile, `${line}\n`, { flag: 'a' })
}
const startedAt = stamp()
const fingerprint0 = ownerFingerprint()
const icacls = () => {
  try {
    return execFileSync('icacls', [process.env.USERPROFILE], { encoding: 'utf8', windowsHide: true })
  } catch {
    return ''
  }
}
const icacls0 = icacls()

// What every program of the run is given: the throwaway home, It's folder and ports, the agent
// app on the PATH behind the guard, and the stand-in for the releases
const env = profileEnv(f, { port, appBin, guard: true, extra: { IT_INSTALL_BASE: 'http://127.0.0.1:5690', IT_INSTALL_NO_PATH: '1' } })
// A run that tests an update: the guard passes `it upgrade`, once It says no service is
// registered for this folder (guard.ts)
if (process.argv.includes('--allow-upgrade')) env.IT_REHEARSAL_ALLOW_UPGRADE = '1'
// From the real site, as a participant: no stand-in, the published program from It's releases.
// IT_INSTALL_NO_PATH stays, since the owner's own PATH may not be changed.
const realSite = process.argv.includes('--real-site')
if (realSite) delete env.IT_INSTALL_BASE
if (agentInstalls)
  Object.assign(env, {
    IT_REHEARSAL_GUARD: 'convert',
    IT_REHEARSAL_REAL_IT: path.join(f.itHome, 'bin', 'it-real.exe'),
    IT_REHEARSAL_SERVE_LOG: path.join(f.logs, 'serve.log'),
    IT_REHEARSAL_SERVE_PIDS: path.join(f.top, 'serve-pids.txt'),
  })
// The agent app's settings, as a person who chose that model has them, in the throwaway profile
let tokenExpiry = null
const appEnv = {}
if (app === 'codex') {
  mkdirSync(f.codexHome, { recursive: true })
  // Under the owner's account Codex's own Windows sandbox stays off (it changes folder permissions)
  writeFileSync(
    path.join(f.codexHome, 'config.toml'),
    `model = "${MODEL.model}"\nmodel_reasoning_effort = "${MODEL.effort}"\nsandbox_mode = "danger-full-access"\ncli_auth_credentials_store = "file"\n${ownerSkillsOff()}`,
  )
  const auth = codexAuth(f.codexHome)
  tokenExpiry = new Date(auth.expiresAt).toISOString()
} else {
  mkdirSync(path.join(f.home, '.claude'), { recursive: true })
  writeFileSync(path.join(f.home, '.claude', 'settings.json'), `${JSON.stringify({ model: MODEL.model, effortLevel: MODEL.effort }, null, 2)}\n`)
  const access = claudeAccess()
  tokenExpiry = new Date(access.expiresAt).toISOString()
  Object.assign(appEnv, access.env)
}
// A picture the person has on their laptop, for a page that asks for a photo or a file
if (process.argv.includes('--picture')) {
  const pictures = path.join(f.home, 'Pictures')
  mkdirSync(pictures, { recursive: true })
  execFileSync(
    'ffmpeg',
    [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xf3efe6:s=900x600', '-frames:v', '1', '-vf',
      "drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':fontsize=44:fontcolor=0x1c1a16:x=60:y=60:text='Luigi''s Pizza — tonight',drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':fontsize=36:fontcolor=0x333333:x=60:y=180:text='Margherita   9',drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':fontsize=36:fontcolor=0x333333:x=60:y=250:text='Funghi   11',drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':fontsize=36:fontcolor=0x333333:x=60:y=320:text='Diavola   12',drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':fontsize=36:fontcolor=0x333333:x=60:y=390:text='Tiramisu   6'",
      '-y', path.join(pictures, 'menu.png'),
    ],
    { stdio: 'ignore', windowsHide: true },
  )
}
log('the agent app is set up in the throwaway profile', `${app} ${version}, ${MODEL.model} at ${MODEL.effort}; token valid until ${tokenExpiry}`)

// The windows, kept on top of everything else
const term = await terminalView({ port: controlPort + 1, title: `${profileName}@laptop — Windows PowerShell`, cols: 104, rows: 50, fontSize: 20 })
const tw = await terminalWindow({ term, profile: f.viewProfile })
const browser = await personBrowser({ channel, profile: f.browserProfile, app: `${term.url}blank`, fakeMedia: process.argv.includes('--fake-media') })
// A page that asks for a file never opens Windows's own file dialog here: the browser runs as the
// owner, and that dialog would show the owner's own folders. The file chooser is answered with
// the throwaway profile's picture where there is one, and with nothing where there is none.
browser.context.on('page', (p) => p.on('filechooser', (fc) => answerChooser(fc)))
browser.page.on('filechooser', (fc) => answerChooser(fc))
function answerChooser(fc) {
  const picture = path.join(f.home, 'Pictures', 'menu.png')
  log('a page asked for a file; the harness gave it the profile\'s picture instead of opening the owner\'s file dialog', existsSync(picture) ? picture : '(none)')
  fc.setFiles(existsSync(picture) ? [picture] : []).catch(() => {})
}
term.onOpen = async (url) => {
  log('a link in the terminal was clicked, and opened in the browser', url)
  browser.page.goto(url).catch((e) => log('the link could not be opened', e.message, false))
}
function allowWindows() {
  const marks = [f.viewProfile, f.browserProfile].map((d) => d.toLowerCase())
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  )
  let all = []
  try {
    all = [JSON.parse(out)].flat()
  } catch {}
  const pids = all.filter((p) => marks.some((m) => String(p.CommandLine ?? '').toLowerCase().includes(m))).map((p) => p.ProcessId)
  mkdirSync(path.join(WORK, 'hands'), { recursive: true })
  writeFileSync(path.join(WORK, 'hands', 'allowed.txt'), `${pids.join('\n')}\n`)
  return pids.length
}
const HANDS = path.join(WORK, 'hands', 'hands.exe')
const raise = () => {
  try {
    execFileSync(HANDS, ['raise'], { stdio: 'ignore', windowsHide: true })
  } catch {}
}
allowWindows()
raise()
const raising = setInterval(() => {
  allowWindows()
  raise()
}, 5000)
const browseFile = path.join(WORK, 'hands', 'browse.txt')
rmSync(browseFile, { force: true })
const browsing = setInterval(() => {
  if (!existsSync(browseFile)) return
  let url = ''
  try {
    url = readFileSync(browseFile, 'utf8').trim()
  } catch {}
  rmSync(browseFile, { force: true })
  if (!/^https?:\/\//.test(url)) return
  log('the person typed an address into the browser', url)
  browser.page.goto(url).catch((e) => log('the address could not be opened', e.message, false))
}, 300)

const appId = app === 'codex' ? 'codex' : 'claude-code'
let sentence = 'Give me the It tour.'
let serveChild = null
let swapping = null
// The setup step, by the harness: the real install script, `it setup --only <app> --no-service`, `it serve`.
// Before the terminal opens, or, with --late-setup, while the agent app is already open (the
// `setup` event), so that the add-on arrives in a conversation that has begun without it
let program = path.join(f.itHome, 'bin', 'it.exe')
const serveLog = createWriteStream(path.join(f.logs, 'serve.log'), { flags: 'a' })
function startServe() {
  serveChild = spawn(program, ['serve'], { env: { ...env, ...appEnv }, cwd: f.work, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  serveChild.stdout.pipe(serveLog, { end: false })
  serveChild.stderr.pipe(serveLog, { end: false })
}
async function harnessSetup(during = false) {
  if (!during) term.note('The organisers set It up on this laptop before the event (done by the rehearsal harness):')
  const ins = await install({ env, cwd: f.home, base: 'http://127.0.0.1:5690', term: during ? null : term, log })
  program = ins.program
  const set = await setup({ program: ins.program, env, cwd: f.work, app: appId, term: during ? null : term, log })
  writeFileSync(path.join(f.logs, 'setup.txt'), scrub(`${set.out}\n${set.err}`).text)
  const say = /“([^”]*It tour[^”]*)”|"(Give me the It tour\.?)"/.exec(`${set.out}\n${set.err}`)
  sentence = say ? (say[1] ?? say[2]) : 'Give me the It tour.'
  log('what setup told the person to say', sentence)
  startServe()
  let status = null
  for (let i = 0; i < 60 && !status?.running; i++) {
    await sleep(2500)
    status = (await it(ins.program, ['status', '--json'], { env, cwd: f.work, ms: 90_000 })).json
  }
  log('it serve is running, started by the harness', `running ${status?.running}, site ${status?.site}`, Boolean(status?.running))
  const site = await it(ins.program, ['site', '--no-open'], { env, cwd: f.work })
  const pairUrl = site.json?.url
  log('the pairing link (it site --no-open)', pairUrl ?? site.out, Boolean(pairUrl))
  if (pairUrl) await browser.page.goto(pairUrl).catch(() => {})
  await sleep(3000)
}
const lateSetup = process.argv.includes('--late-setup')
if (!agentInstalls && !lateSetup) await harnessSetup()
else if (lateSetup) log('It will be set up by the harness while the agent app is open (the setup event)')
else {
  // The agent installs It itself. The moment the installer has put It's program in place, the
  // guard takes its place and the program is kept beside it, so that `it setup`, however the agent
  // runs it, registers no task for the owner's account: the guard adds `--no-service` and starts
  // `it serve`, the one thing the task would have done for a person on their own account.
  const bin = path.join(f.itHome, 'bin')
  const target = path.join(bin, 'it.exe')
  const realIt = path.join(bin, 'it-real.exe')
  const guardExe = path.join(WORK, 'guard', 'it.exe')
  const guardSize = statSync(guardExe).size
  let lastSize = -1
  let stableSince = 0
  swapping = setInterval(() => {
    try {
      if (!existsSync(target)) return
      const size = statSync(target).size
      if (size === guardSize) return
      if (size !== lastSize) {
        lastSize = size
        stableSince = Date.now()
        return
      }
      if (Date.now() - stableSince < 1200) return
      rmSync(realIt, { force: true })
      renameSync(target, realIt)
      copyFileSync(guardExe, target)
      lastSize = -1
      log("the installed program was kept as it-real.exe and the guard put in its place (so that setup registers no task for the owner's account)", `${size} bytes`)
    } catch (e) {
      log('the guard could not be put in place', e.message, false)
    }
  }, 150)
  log('the agent will install It itself; the guard watches for the program', bin)
}

// The terminal: Windows PowerShell in the empty project folder, as the person's own
const pty = term.open(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoLogo'], { env: { ...env, ...appEnv }, cwd: f.work, python: path.join(WORK, 'pyembed', 'python.exe') })
forget()
await sleep(2500)
await tw.page.click('#t').catch(() => {})
log('the terminal is open', `in ${f.work}`)

let recording = false
let stopping = null
// The bar above the page (#491): whether it says that the agent is working, against whether the
// agent's terminal shows a turn running ("esc to interrupt"), each change written down with its
// time in the video, in working.log beside the steps
const workingLog = path.join(f.results, 'working.log')
let barWas = null
let termWas = null
const watchingWork = setInterval(async () => {
  if (!recording) return
  let bar = ''
  try {
    bar = await browser.page.evaluate(() => {
      const m = /(Codex|Claude Code|Your agent) is working/.exec(document.body?.innerText ?? '')
      return m ? m[0] : ''
    })
  } catch {}
  const screen = await term.screen().catch(() => '')
  const busy = /esc to interrupt/i.test(screen) ? 'turn running' : ''
  const t = rec ? rec.at().toFixed(1) : '?'
  if (bar !== barWas) {
    writeFileSync(workingLog, `${t}s bar: ${bar || '(no working)'}\n`, { flag: 'a' })
    barWas = bar
  }
  if (busy !== termWas) {
    writeFileSync(workingLog, `${t}s terminal: ${busy || '(idle)'}\n`, { flag: 'a' })
    termWas = busy
  }
}, 500)
// What goes wrong, done by the harness at a time it was given: It set up late, It stopped (every
// process of It in the throwaway profile, by its own id), and It started again
async function faultEvent(what) {
  if (what === 'setup') {
    await harnessSetup(true)
    return `It was set up while the agent app was open; the person says: ${sentence}`
  }
  if (what === 'it-stop') {
    const mine = leftIn(f.itHome) ?? []
    for (const p of mine) killTree(p.pid)
    if (serveChild) killTree(serveChild.pid)
    await sleep(2000)
    return `It stopped: ended ${mine.map((p) => `${p.name} ${p.pid}`).join(', ') || 'nothing'}; left: ${JSON.stringify(leftIn(f.itHome))}`
  }
  if (what === 'it-start') {
    const st = (await it(program, ['status', '--json'], { env, cwd: f.work, ms: 60_000 })).json
    if (st?.running) return 'It was already running again (started by the person or the agent); nothing done'
    // Nor while a start of the person's or the agent's is still under way
    const already = leftIn(f.itHome) ?? []
    if (already.length) return `It is being started already (${already.map((p) => p.name).join(', ')}); nothing done`
    startServe()
    let status = null
    for (let i = 0; i < 40 && !status?.running; i++) {
      await sleep(2500)
      status = (await it(program, ['status', '--json'], { env, cwd: f.work, ms: 60_000 })).json
    }
    return `It started again by the harness (it serve): running ${status?.running}`
  }
  return `unknown event ${what}`
}
const meta = {
  id,
  scenario,
  flow: `scenario ${scenario}`,
  app: app === 'codex' ? 'Codex' : 'Claude Code',
  appVersion: version,
  model: MODEL,
  browser: channel,
  person,
  account: 'aarya (throwaway profile)',
  setUpBy: agentInstalls
    ? 'the agent (install and setup), except that the harness turned its `it setup` into `it setup --no-service` plus `it serve`, which is what the background task would do'
    : 'the harness (install script, it setup --only ' + appId + ' --no-service, it serve), not the agent',
  build,
  sentence,
  tokenExpiry,
}
http
  .createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    let q = {}
    try {
      q = JSON.parse(body || '{}')
    } catch {}
    const reply = (o) => res.end(typeof o === 'string' ? o : JSON.stringify(o))
    if (q.cmd === 'screen') return reply(await term.screen())
    if (q.cmd === 'status') return reply({ id, recording, video: rec?.at() ?? null, url: browser.page.url(), sentence })
    if (q.cmd === 'note') {
      log(q.name || 'note', q.seen || '', q.ok !== false)
      return reply('noted')
    }
    if (q.cmd === 'type' || q.cmd === 'key') {
      if (recording) return reply('refused: the tester does not help the person in a run')
      if (q.cmd === 'type') await term.type(q.text)
      else term.key(q.name)
      return reply('done')
    }
    if (q.cmd === 'setup' || q.cmd === 'it-stop' || q.cmd === 'it-start') {
      reply(await faultEvent(q.cmd))
      return
    }
    if (q.cmd === 'record') {
      if (!recording) {
        recording = true
        rec = recorder(path.join(f.results, 'video.mp4'), { width: SCREEN.width, height: SCREEN.height })
        await sleep(1500)
        log('recording started')
        // --events setup@120,it-stop@600,it-start@900: what goes wrong, and when, in seconds of the video
        for (const ev of String(arg('events', '')).split(',').filter(Boolean)) {
          const [what, at] = ev.split('@')
          setTimeout(() => faultEvent(what).then((r) => log(`event ${what}`, r)), Number(at) * 1000)
        }
      }
      return reply('recording')
    }
    if (q.cmd === 'stop') {
      reply('stopping')
      stopping = q
    }
  })
  .listen(controlPort, '127.0.0.1', () => log('control port open', String(controlPort)))

while (!stopping) await sleep(1000)

clearInterval(raising)
clearInterval(watchingWork)
clearInterval(browsing)
const endedAt = stamp()
if (rec) {
  await sleep(2000)
  await rec.stop()
  log('recording stopped')
}
const transcript = scrub(term.raw().toString('utf8'))
writeFileSync(path.join(f.results, 'terminal.txt'), transcript.text)
// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's codes begin with ESC
writeFileSync(path.join(f.results, 'terminal-plain.txt'), transcript.text.replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>()78][A-Za-z0-9]?/g, ''))
// Everything the run started, by its own id
killTree(pty.pid)
await sleep(1000)
if (swapping) clearInterval(swapping)
const serves = [serveChild?.pid, ...(existsSync(path.join(f.top, 'serve-pids.txt')) ? readFileSync(path.join(f.top, 'serve-pids.txt'), 'utf8').split(/\s+/).map(Number) : [])].filter(Boolean)
for (const served of serves) spawnSyncSafe('taskkill', ['/PID', String(served), '/T'])
await sleep(8000)
for (const served of serves) killTree(served)
await browser.context.close().catch(() => {})
await tw.context.close().catch(() => {})
await term.close()
// What is left in the run's folder that runs, ended by its id
await sleep(3000)
let left = leftIn(f.top)
for (const p of left ?? []) killTree(p.pid)
await sleep(2000)
left = leftIn(f.top)
log('nothing of the run is left running', JSON.stringify(left), Array.isArray(left) && left.length === 0)
// It's logs, scrubbed
for (const name of ['it.log']) {
  const from = path.join(f.itHome, 'logs', name)
  if (existsSync(from)) writeFileSync(path.join(f.logs, name), scrub(readFileSync(from, 'utf8')).text)
}
const shredded = shredAll()
log('the lent sign-in was overwritten and deleted', shredded ? 'yes' : 'NOT ALL', shredded)
const fingerprint1 = ownerFingerprint()
log("the owner's own It task is as it was, and was not asked to stop", JSON.stringify({ before: fingerprint0, after: fingerprint1 }), fingerprint0.tasks === fingerprint1.tasks && !fingerprint1.ownerStopAsked)
const same = icacls() === icacls0
log("the permissions of the owner's profile folder are as they were", same ? 'icacls unchanged' : 'icacls CHANGED', same)
const guard = existsSync(path.join(f.logs, 'guard.log')) ? readFileSync(path.join(f.logs, 'guard.log'), 'utf8') : ''
if (guard) log('the guard refused a command under the owner account', guard.trim(), true)
writeFileSync(path.join(f.results, 'session.json'), `${JSON.stringify({ ...meta, start: startedAt, end: endedAt, stoppedBecause: stopping.reason ?? '', steps }, null, 2)}\n`)
// The agent app's own record of the conversation (every command it ran, in full), scrubbed of
// anything shaped like a token, kept before the profile goes
const transcripts = path.join(f.results, 'agent-transcript')
const keepFrom = (dir) => {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, String(entry))
    if (!/\.jsonl$/.test(file) || !statSync(file).isFile()) continue
    mkdirSync(transcripts, { recursive: true })
    // A line naming the owner's profile, or holding a skill file, is left out: Codex reads skills
    // from the owner's own home folder whatever the throwaway profile says
    const owner = os.userInfo().homedir.toLowerCase()
    const owners = [owner, owner.replaceAll('\\', '/'), owner.replaceAll('\\', '\\\\')]
    const kept1 = scrub(readFileSync(file, 'utf8'))
      .text.split('\n')
      .map((l) => {
        const low = l.toLowerCase()
        const drop = owners.some((o) => low.includes(o)) || (l.includes('name: ') && l.includes('description: ') && l.includes('---'))
        return drop ? JSON.stringify({ redacted: "a line naming the owner's profile, or holding a skill file, was left out by the harness" }) : l
      })
    writeFileSync(path.join(transcripts, path.basename(file)), kept1.join('\n'))
    n++
  }
  return n
}
const kept = app === 'codex' ? keepFrom(path.join(f.codexHome, 'sessions')) : keepFrom(path.join(f.home, '.claude', 'projects'))
log("the agent app's own transcript was kept, scrubbed", `${kept} file(s) in agent-transcript`)
// The throwaway profile goes; its results stay
try {
  rmSync(f.top, { recursive: true, force: true })
} catch {}
console.log(`run ended: ${f.results}`)
process.exit(0)

function spawnSyncSafe(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', windowsHide: true })
  } catch {}
}
