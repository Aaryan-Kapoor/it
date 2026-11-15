// A session as the clean account `itrehearsal`: the account's own terminal (a shell in a pseudo
// console held as that account, drawn in a window on the left), the person's browser on the
// right, and, in a run, the screen recorded from before the person's first word to the end.
//
//   node e2e/rehearsal/session.mjs --mode preflight|run --app codex|claude --version <v>
//        [--browser msedge|chrome] [--id <run id>] [--scenario 1] [--control 5697]
//
// preflight: no recording and no person. The agent app's own first run (what a participant did
//   when they installed it before the event) is gone through by the tester over the control port,
//   in the account's home folder, and the choice of model is checked in the app.
// run: the screen is recorded, the terminal is open in an empty folder with nothing in it, the
//   browser is open on an empty page, and the person (a model with eyes and hands, or a script)
//   does the rest. The tester only watches over the control port, and stops the run.
//
// Control port (127.0.0.1): POST JSON {cmd: "screen" | "type" | "key" | "stop" | "status", ...}.
// In a run, "type" and "key" are refused: the tester does not help the person.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { hostTerminal, psAs, startAs, userEnv } from './asuser.mjs'
import { claudeAccess, codexAuthContent, forget, scrub, shredLedger, shredOnExit } from './credentials.mjs'
import { leftIn, ownerFingerprint, recorder, RESULTS, sleep, stamp, WORK } from './lib.mjs'
import { personBrowser, SCREEN, terminalView, terminalWindow } from './stage.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const mode = arg('mode', 'preflight')
const app = arg('app', 'codex')
const version = arg('version', app === 'codex' ? '0.169.0' : '2.1.325')
const channel = arg('browser', 'msedge')
const scenario = arg('scenario', '1')
const controlPort = Number(arg('control', 5697))
const person = arg('person', 'model')
const USER = 'itrehearsal'
const UHOME = `C:\\Users\\${USER}`
const id = arg('id', `${stamp().slice(0, 16).replace(/[:T]/g, '')}-s${scenario}-${app}-${channel}`)
const MODEL = app === 'codex' ? { model: 'gpt-6.1-sol', effort: 'high' } : { model: 'claude-sonnet-5-5', effort: 'high' }
const appBin = path.join(WORK, 'apps', `${app === 'codex' ? 'codex' : 'claude'}-${version}`, 'node_modules', '.bin')
const run = mode === 'run'
const top = path.join(WORK, 'sessions', id)
const results = run ? path.join(RESULTS, id) : path.join(top, 'preflight')
for (const d of [top, results]) mkdirSync(d, { recursive: true })
const fromUser = path.join(WORK, 'from-user', id)
mkdirSync(fromUser, { recursive: true })
const stepsFile = path.join(results, 'steps.log')
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

shredOnExit()
const leftover = shredLedger()
if (leftover) log('token files from an earlier run could not all be shredded', `${leftover} left`, false)
const startedAt = stamp()
const fingerprint0 = ownerFingerprint()

// The account's environment, as a participant's laptop has it, with the agent app on the PATH
// and the one thing that differs from a participant: the install script and It fetch the build
// under test from the stand-in for It's releases on this machine.
const shellEnv = userEnv(USER, { path: [appBin], extra: { IT_INSTALL_BASE: 'http://127.0.0.1:5690' } })

// The sign-in lent to the run, and the agent app's settings, as a person who chose that model has them
const files = []
const appEnv = {}
let tokenExpiry = null
if (app === 'codex') {
  const auth = codexAuthContent()
  tokenExpiry = new Date(auth.expiresAt).toISOString()
  files.push({ path: `${UHOME}\\.codex\\auth.json`, content: auth.content, secret: true })
  files.push({
    path: `${UHOME}\\.codex\\config.toml`,
    content: `${existsSync(path.join(top, 'kept-config.toml')) ? readFileSync(path.join(top, 'kept-config.toml'), 'utf8') : ''}`,
    secret: false,
  })
} else {
  const access = claudeAccess()
  tokenExpiry = new Date(access.expiresAt).toISOString()
  Object.assign(appEnv, access.env)
}
// The settings files are written only where the preflight has not made them already: see below
const settingsFor = async () => {
  if (app === 'codex') {
    const r = await psAs(USER, `'<<<'; if (Test-Path '${UHOME}\\.codex\\config.toml') { Get-Content -Raw '${UHOME}\\.codex\\config.toml' }; '>>>'`, shellEnv)
    const m = /<<<\r?\n([\s\S]*?)>>>/.exec(r.output)
    if (!m) throw new Error(`the settings of Codex in the account could not be read: ${r.output.slice(0, 200)}`)
    let toml = `${m[1].replace(/^\uFEFF/, '').trimEnd()}\n`
    const set = (k, v) => {
      const re = new RegExp(`^${k}\\s*=.*$`, 'm')
      toml = re.test(toml) ? toml.replace(re, `${k} = ${v}`) : `${k} = ${v}\n${toml}`
    }
    set('model', `"${MODEL.model}"`)
    set('model_reasoning_effort', `"${MODEL.effort}"`)
    set('cli_auth_credentials_store', '"file"')
    return [{ path: `${UHOME}\\.codex\\config.toml`, content: toml, secret: false }]
  }
  const r = await psAs(USER, `'<<<'; if (Test-Path '${UHOME}\\.claude\\settings.json') { Get-Content -Raw '${UHOME}\\.claude\\settings.json' }; '>>>'`, shellEnv)
  const m = /<<<\r?\n([\s\S]*?)>>>/.exec(r.output)
  if (!m) throw new Error(`the settings of Claude Code in the account could not be read: ${r.output.slice(0, 200)}`)
  let s = {}
  try {
    s = JSON.parse(m[1].replace(/^\uFEFF/, '').trim() || '{}')
  } catch {}
  s.model = MODEL.model
  s.effortLevel = MODEL.effort
  return [{ path: `${UHOME}\\.claude\\settings.json`, content: `${JSON.stringify(s, null, 2)}\n`, secret: false }]
}
const settings = await settingsFor()
const allFiles = [...files.filter((f) => f.secret), ...settings]

// Before a run, the account holds nothing of It and no work folder: a participant's laptop
const workDir = `${UHOME}\\hackathon`
if (run) {
  const r = await psAs(
    USER,
    [
      "$ErrorActionPreference = 'Continue'",
      `if (Test-Path '${UHOME}\\.it\\bin\\it.exe') { & '${UHOME}\\.it\\bin\\it.exe' uninstall --yes 2>&1 | Out-String | Select-Object -First 1 }`,
      `foreach ($d in @('${UHOME}\\.it', '${workDir}')) { if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } }`,
      `New-Item -ItemType Directory -Force '${workDir}' | Out-Null`,
      `"tasks: " + ((Get-ScheduledTask -TaskPath '\\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'it*' } | ForEach-Object { $_.TaskName }) -join ',')`,
      `"it folder: " + (Test-Path '${UHOME}\\.it')`,
      `"work folder empty: " + (@(Get-ChildItem -Force '${workDir}').Count -eq 0)`,
    ].join('\n'),
    shellEnv,
  )
  log('the account holds nothing of It before the run', r.output.trim().replace(/\s+/g, ' '))
}

// The windows: the terminal on the left, the browser on the right
const term = await terminalView({ port: controlPort + 1, title: `${USER}@laptop — Windows PowerShell`, cols: 104, rows: 50, fontSize: 20 })
const tw = await terminalWindow({ term, profile: path.join(top, 'terminal-view') })
const browser = await personBrowser({ channel, profile: path.join(top, 'browser'), fakeMedia: false })
await browser.page.goto('about:blank')
term.onOpen = async (url) => {
  log('a link in the terminal was clicked, and opened in the browser', url)
  try {
    const blank = browser.page.url() === 'about:blank'
    const p = blank ? browser.page : await browser.context.newPage()
    await p.goto(url)
    await p.bringToFront()
  } catch (e) {
    log('the link could not be opened', e.message, false)
  }
}

// The windows the person's hands may act on: the processes of these two browsers alone
function allowWindows() {
  const marks = [path.join(top, 'terminal-view'), path.join(top, 'browser')].map((d) => d.toLowerCase())
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
log('the hands may act on the terminal and the browser', `${allowWindows()} processes`)
// The two windows are kept on top of everything else for the whole session, so that nothing of
// the owner's own desktop is ever on the screen that is recorded or shown to the person
const HANDS = path.join(WORK, 'hands', 'hands.exe')
const raise = () => {
  try {
    execFileSync(HANDS, ['raise'], { stdio: 'ignore', windowsHide: true })
  } catch {}
}
raise()
const raising = setInterval(() => {
  allowWindows()
  raise()
}, 5000)

// The recording starts before the person's first word
if (run) {
  rec = recorder(path.join(results, 'video.mp4'), { width: SCREEN.width, height: SCREEN.height })
  await sleep(1500)
  log('recording started')
}

// The account's own terminal: Windows PowerShell, in the empty work folder (or the home, in a preflight)
const host = await hostTerminal({
  user: USER,
  port: controlPort + 2,
  argv: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoLogo'],
  cwd: run ? workDir : UHOME,
  cols: term.cols,
  rows: term.rows,
  env: shellEnv,
  appEnv,
  files: allFiles,
  logFile: path.join(WORK, 'from-user', `${id}-host.log`),
})
term.useSocket(host.socket)
log('the terminal is open, as the account', `${USER}, in ${run ? workDir : UHOME}`)
await tw.page.bringToFront()
// Focus starts in the terminal, as a terminal window just opened has it
await tw.page.click('#t').catch(() => {})
forget()

let stopping = null
const meta = { id, mode, scenario, app, appVersion: version, model: MODEL, browser: channel, person, user: USER, build: process.env.IT_REHEARSAL_BUILD || 'db320c788d78', tokenExpiry }
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
    if (q.cmd === 'status') return reply({ id, video: rec?.at() ?? null, url: browser.page.url(), pages: browser.context.pages().map((p) => p.url()) })
    if (q.cmd === 'note') {
      log(q.name || 'note', q.seen || '', q.ok !== false)
      return reply('noted')
    }
    if (q.cmd === 'allow') return reply({ allowed: allowWindows() })
    if (q.cmd === 'type' || q.cmd === 'key') {
      if (run) return reply('refused: the tester does not help the person in a run')
      if (q.cmd === 'type') await term.type(q.text)
      else term.key(q.name)
      return reply('done')
    }
    if (q.cmd === 'stop') {
      reply('stopping')
      stopping = q
    }
  })
  .listen(controlPort, '127.0.0.1', () => log('control port open', String(controlPort)))

while (!stopping) await sleep(1000)

// The end: the recording stops after what the person last did
clearInterval(raising)
const endedAt = stamp()
if (rec) {
  await sleep(2000)
  await rec.stop()
  log('recording stopped')
}
const transcript = scrub(term.raw().toString('utf8'))
writeFileSync(path.join(results, 'terminal.txt'), transcript.text)
const plainText = transcript.text.replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>()78][A-Za-z0-9]?/g, '')
writeFileSync(path.join(results, 'terminal-plain.txt'), plainText)
if (transcript.found) log('token-shaped text was taken out of the terminal transcript', String(transcript.found))
host.socket.end()
await sleep(2500)
await browser.context.close().catch(() => {})
await tw.context.close().catch(() => {})
await term.close()

// What It left in the account: its scheduled task, its logs, and then It's own uninstall
const after = await psAs(
  USER,
  [
    "$ErrorActionPreference = 'Continue'",
    `$t = Get-ScheduledTask -TaskPath '\\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'it*' }`,
    `foreach ($x in $t) { "task: " + $x.TaskName + " | state " + $x.State + " | principal " + $x.Principal.UserId + " | logon " + $x.Principal.LogonType + " | runs " + $x.Actions[0].Execute + " " + $x.Actions[0].Arguments + " in " + $x.Actions[0].WorkingDirectory }`,
    `if (-not $t) { "task: none" }`,
    `"sid: " + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value`,
    `if (Test-Path '${UHOME}\\.it\\logs') { Copy-Item -Recurse -Force '${UHOME}\\.it\\logs' '${fromUser}\\it-logs' -ErrorAction SilentlyContinue }`,
    `if (Test-Path '${UHOME}\\.it\\bin\\it.exe') { "status: " + ((& '${UHOME}\\.it\\bin\\it.exe' status --json 2>&1) | Out-String) }`,
  ].join('\n'),
  shellEnv,
)
writeFileSync(path.join(results, 'after.txt'), scrub(after.output).text)
log('what It registered for the account', scrub(after.output).text.split(/\r?\n/).filter((l) => /^task:|^sid:/.test(l)).join(' / '))
const logsDir = path.join(results, 'logs')
mkdirSync(logsDir, { recursive: true })
let scrubbed = 0
const copyLogs = (from, to) => {
  if (!existsSync(from)) return
  for (const f of readdirSync(from, { withFileTypes: true })) {
    if (f.isDirectory()) copyLogs(path.join(from, f.name), path.join(to, f.name))
    else {
      mkdirSync(to, { recursive: true })
      const s = scrub(readFileSync(path.join(from, f.name), 'utf8'))
      scrubbed += s.found
      writeFileSync(path.join(to, f.name), s.text)
    }
  }
}
copyLogs(path.join(fromUser, 'it-logs'), logsDir)
rmSync(fromUser, { recursive: true, force: true })
if (scrubbed) log("token-shaped text was taken out of It's logs", String(scrubbed))

if (run) {
  const un = await psAs(
    USER,
    [
      "$ErrorActionPreference = 'Continue'",
      `if (Test-Path '${UHOME}\\.it\\bin\\it.exe') { (& '${UHOME}\\.it\\bin\\it.exe' uninstall --yes 2>&1) | Out-String }`,
      `Start-Sleep 3`,
      `"task after uninstall: " + ((Get-ScheduledTask -TaskPath '\\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'it*' } | ForEach-Object { $_.TaskName }) -join ',')`,
      `"it folder after uninstall: " + (Test-Path '${UHOME}\\.it') + " " + ((Get-ChildItem -Force '${UHOME}\\.it' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ',')`,
      `"token file: " + (Test-Path '${UHOME}\\.codex\\auth.json')`,
      `if (Test-Path '${UHOME}\\.codex\\auth.json') { Remove-Item -Force '${UHOME}\\.codex\\auth.json' }`,
    ].join('\n'),
    shellEnv,
  )
  writeFileSync(path.join(results, 'uninstall.txt'), scrub(un.output).text)
  log("It's own uninstall in the account", scrub(un.output).text.split(/\r?\n/).filter((l) => /after uninstall|token file/.test(l)).join(' / '))
}
// What the account still has running of the agent app (Codex keeps a background server after its
// window is left): each is ended by its own process id, as that account
const ended = await psAs(
  USER,
  [
    '$me = $PID',
    "$mine = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me -and $_.Name -match '^(codex|codex-.*|claude|node|it|rg)\\.exe$' } | Where-Object { try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $env:USERNAME } catch { $false } }",
    'foreach ($p in $mine) { "ending " + $p.Name + " " + $p.ProcessId; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
    'Start-Sleep 2',
    '"still running: " + ((Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me -and $_.Name -match \'^(codex|codex-.*|claude|node|it|rg)\\.exe$\' } | Where-Object { try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $env:USERNAME } catch { $false } } | ForEach-Object { $_.Name }) -join ",")',
  ].join('\n'),
  shellEnv,
)
log("the account's own agent processes left running were ended by their ids", ended.output.trim().replace(/\s+/g, ' ').slice(0, 600))
const fingerprint1 = ownerFingerprint()
const ownerSame = fingerprint0.tasks === fingerprint1.tasks && !fingerprint1.ownerStopAsked
log("the owner's own It task is as it was, and was not asked to stop", JSON.stringify({ before: fingerprint0, after: fingerprint1 }), ownerSame)
const left = leftIn(top)
log('nothing of the session is left running', JSON.stringify(left), Array.isArray(left) && left.length === 0)
const meta2 = { ...meta, start: startedAt, end: endedAt, stoppedBecause: stopping.reason ?? '', steps }
writeFileSync(path.join(results, 'session.json'), `${JSON.stringify(meta2, null, 2)}\n`)
console.log(`session ended: ${results}`)
process.exit(0)
