// A person typing the guide's install line into a window they opened themselves: a Windows
// PowerShell console, Windows Terminal, and PowerShell started from cmd, each in a throwaway
// profile, recorded, with Windows Defender's event log read after each line (read only).
//
//   node e2e/rehearsal/typed-install.mjs [--only ps,wt,cmd] [--line real|127|both]
//
// The windows are found by their own titles, never by process (Windows Terminal keeps all its
// windows, the owner's too, in one process), kept on top, typed into only while they have the
// keyboard, and pictured only within their own rectangle and only while nothing else is over them. Each window's PowerShell has IT_HOME, USERPROFILE and TEMP in the throwaway profile,
// IT_INSTALL_BASE naming the stand-in, IT_INSTALL_PLAIN so that the script stops when the program
// is in place (no `it setup`, nothing registered), and IT_INSTALL_NO_PATH; before the line is
// typed the harness checks, from a file the window itself wrote, that it has them.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { homeOnWindows, systemPath } from '../apps/windows.mjs'
import { recorder, sleep, WORK } from './lib.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const OUT = arg('out', 'D:\\it-rehearsal\\2026-11-15\\defender\\typed')
const ROOT = 'D:\\r\\typed'
const only = arg('only', 'ps,wt,cmd').split(',')
const lineKind = arg('line', 'both')
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const WIN = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'win.ps1')
const HANDS = path.join(WORK, 'hands', 'hands.exe')
const LINES = { real: 'irm https://itcan.do/install.ps1 | iex', 127: 'irm http://127.0.0.1:5690/latest/download/install.ps1 | iex' }
mkdirSync(OUT, { recursive: true })
const log = (s) => {
  const line = `${new Date().toISOString()} ${s}`
  console.log(line)
  writeFileSync(path.join(OUT, 'typed.log'), `${line}\n`, { flag: 'a' })
}
const win = (...a) => {
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN, ...a], { encoding: 'utf8', windowsHide: true })
  return `${r.stdout}${r.stderr}`.trim()
}
let shot = 0
// Pictures of the rehearsal's own window only (win.ps1 shot refuses where anything else is over it)
let current = null
const look = (what, title = current) => {
  const file = path.join(OUT, `shot-${String(++shot).padStart(3, '0')}-${what}.png`)
  const said = win('shot', title, file)
  return /^saved/.test(said) ? file : `(no picture: ${said.split(String.fromCharCode(10))[0].trim()})`
}
// A frame of the window every two seconds, made into the run's video at the end
const FRAMES = path.join(OUT, 'frames')
mkdirSync(FRAMES, { recursive: true })
let frame = 0
let framing = false
const frames = setInterval(() => {
  if (!current || framing) return
  framing = true
  const file = path.join(FRAMES, `f-${String(++frame).padStart(5, '0')}.png`)
  const c = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN, 'shot', current, file], { windowsHide: true, stdio: 'ignore' })
  c.on('close', () => (framing = false))
}, 2000)
function events(since) {
  const r = spawnSync(
    PS,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1116,1117,1118,1119,1121,1122; StartTime=[datetime]::Parse('${since}').ToLocalTime()} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ t=$_.TimeCreated.ToUniversalTime().ToString('o'); id=$_.Id; name=([regex]::Match($_.Message,'Name: (\\S+)').Groups[1].Value); path=([regex]::Match($_.Message,'Path: (.*?)\\r?\\n\\s*Detection Origin').Groups[1].Value) } } | ConvertTo-Json -Compress`,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  try {
    return [JSON.parse(r.stdout)].flat().filter(Boolean)
  } catch {
    return []
  }
}

function profile(name) {
  const home = path.join(ROOT, name, 'home')
  rmSync(path.join(ROOT, name), { recursive: true, force: true })
  mkdirSync(path.join(home, 'project'), { recursive: true })
  const env = {
    PATH: systemPath().join(';'),
    HOME: home,
    ...homeOnWindows(home),
    IT_HOME: path.join(home, '.it'),
    IT_INSTALL_BASE: 'http://127.0.0.1:5690',
    IT_INSTALL_PLAIN: '1',
    IT_INSTALL_NO_PATH: '1',
    IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage', DO_NOT_TRACK: '1',
    USERNAME: process.env.USERNAME,
    COMPUTERNAME: process.env.COMPUTERNAME,
    USERDOMAIN: process.env.USERDOMAIN,
  }
  // For a window whose surroundings cannot be handed over (Windows Terminal builds its own), the
  // same set by the window's first script; and in every window, the file that shows the harness
  // what the window has
  const marker = path.join(ROOT, name, 'window-has.txt')
  const sets = Object.entries(env)
    .filter(([k]) => k !== 'PATH')
    .map(([k, v]) => `\${env:${k}} = '${String(v).replace(/'/g, "''")}'`)
    .join('\n')
  const prep = path.join(ROOT, name, 'prep.ps1')
  writeFileSync(prep, `${sets}\nSet-Location '${path.join(home, 'project')}'\n$Host.UI.RawUI.WindowTitle = 'it-typed-${name}'\n"$env:IT_HOME|$env:USERPROFILE|$env:IT_INSTALL_PLAIN|$env:IT_INSTALL_BASE" | Out-File -Encoding ascii '${marker}'\nClear-Host\n`)
  const check = path.join(ROOT, name, 'check.ps1')
  writeFileSync(check, `"$env:IT_HOME|$env:USERPROFILE|$env:IT_INSTALL_PLAIN|$env:IT_INSTALL_BASE" | Out-File -Encoding ascii '${marker}'\n`)
  return { home, env, marker, prep, check }
}
function windowHas(p) {
  if (!existsSync(p.marker)) return false
  const [itHome, profileDir, plain, base] = readFileSync(p.marker, 'utf8').trim().split('|')
  return itHome === p.env.IT_HOME && profileDir === p.home && plain === '1' && base === 'http://127.0.0.1:5690'
}

const started0 = Date.now()
const rec = { at: () => (Date.now() - started0) / 1000 }
const results = []
const started = []

async function tryLine(name, title, p, kind) {
  const line = LINES[kind]
  // The window's own word for what it has, written just now
  rmSync(p.marker, { force: true })
  log(`${name}: check ${win('type', title, `. '${p.check}'\\n`)}`)
  await sleep(2500)
  if (!windowHas(p)) {
    log(`${name}: the window does not have the throwaway profile; the line is NOT typed`)
    results.push({ window: name, line, typed: false })
    return
  }
  win('type', title, 'cls\\n')
  await sleep(1000)
  const since = new Date(Date.now() - 1000).toISOString()
  const at = rec.at()
  log(`${name}: typing "${line}" at ${at.toFixed(1)} s in the video: ${win('type', title, `${line}\\n`)}`)
  // Until the program is in place, or 150 s
  const program = path.join(p.env.IT_HOME, 'bin', 'it.exe')
  let s = 0
  for (; s < 150 && !existsSync(program); s += 3) await sleep(3000)
  await sleep(8000)
  const file = look(`${name}-${kind}`)
  const evs = events(since)
  const r = { window: name, line, typed: true, videoAt: Math.round(at), installed: existsSync(program), seconds: s, blocked: evs.length > 0, events: evs, shot: file }
  results.push(r)
  log(`${name}: installed ${r.installed}, Defender ${evs.length ? evs.map((e) => `${e.id} ${e.name} ${e.path}`).join('; ') : 'nothing'}`)
  writeFileSync(path.join(OUT, 'typed.json'), `${JSON.stringify(results, null, 2)}\n`)
  // A fresh It folder for the next line in the same window
  rmSync(p.env.IT_HOME, { recursive: true, force: true })
}
const kinds = lineKind === 'both' ? ['real', '127'] : [lineKind]

try {
  // 1. A Windows PowerShell console window, opened as from the Start menu
  if (only.includes('ps')) {
    const p = profile('ps')
    // cmd's start gives the window a console of its own; its first, quoted, argument is only a title
    const c = spawn('C:\\Windows\\System32\\cmd.exe', [`/d /c start "it-window" "${PS}" -NoLogo -NoExit -ExecutionPolicy Bypass -File "${p.prep}"`], { env: p.env, cwd: path.join(p.home, 'project'), stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
    started.push(c.pid)
    await sleep(4000)
    log(`ps: ${win('place', 'it-typed-ps', '200', '80', '2160', '1200')}`)
    current = 'it-typed-ps'
    for (const k of kinds) await tryLine('ps', 'it-typed-ps', p, k)
  }
  // 1b. The classic console window (conhost), as on a laptop where Windows Terminal is not the default
  if (only.includes('conhost')) {
    const p = profile('conhost')
    const c = spawn('C:\\Windows\\System32\\cmd.exe', [`/d /c start "it-window" C:\\Windows\\System32\\conhost.exe "${PS}" -NoLogo -NoExit -ExecutionPolicy Bypass -File "${p.prep}"`], { env: p.env, cwd: path.join(p.home, 'project'), stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
    started.push(c.pid)
    await sleep(4000)
    log(`conhost: ${win('place', 'it-typed-conhost', '200', '80', '2160', '1200')}`)
    current = 'it-typed-conhost'
    for (const k of kinds) await tryLine('conhost', 'it-typed-conhost', p, k)
  }
  // 2. Windows Terminal, a new window of its own
  if (only.includes('wt')) {
    const p = profile('wt')
    const c = spawn(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe'), ['-w', 'new', '--title', 'it-typed-wt', '--suppressApplicationTitle', PS, '-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', p.prep], { env: p.env, detached: true, stdio: 'ignore' })
    started.push(c.pid)
    await sleep(6000)
    log(`wt: ${win('place', 'it-typed-wt', '200', '80', '2160', '1200')}`)
    current = 'it-typed-wt'
    for (const k of kinds) await tryLine('wt', 'it-typed-wt', p, k)
  }
  // 3. cmd, and PowerShell started from it by typing `powershell`
  if (only.includes('cmd')) {
    const p = profile('cmd')
    const c = spawn('C:\\Windows\\System32\\cmd.exe', ['/d /c start "it-window" C:\\Windows\\System32\\cmd.exe /k title it-typed-cmd'], { env: p.env, cwd: path.join(p.home, 'project'), stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
    started.push(c.pid)
    await sleep(3000)
    log(`cmd: ${win('place', 'it-typed-cmd', '200', '80', '2160', '1200')}`)
    current = 'it-typed-cmd'
    log(`cmd: ${win('type', 'it-typed-cmd', 'powershell\\n')}`)
    await sleep(4000)
    look('cmd-powershell')
    for (const k of kinds) await tryLine('cmd', 'it-typed-cmd', p, k)
  }
} catch (e) {
  log(`stopped: ${e.message}`)
}
await sleep(1500)
clearInterval(frames)
current = null
await sleep(2500)
for (const pid of started) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
log('the windows close')
// Each window is closed by its own title (Windows Terminal's process is shared with the owner's
// windows), and then whatever of the run is left, by its own process id
for (const t of ['it-typed-ps', 'it-typed-conhost', 'it-typed-wt', 'it-typed-cmd', 'it-typed-cmd']) {
  win('type', t, 'exit\\n')
  await sleep(1200)
}
await sleep(1500)
const left = spawnSync(PS, ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'D:\\\\r\\\\typed' -and $_.CommandLine -notmatch 'Get-CimInstance' } | ForEach-Object { $_.ProcessId }"], { encoding: 'utf8', windowsHide: true })
  .stdout.split(/\s+/)
  .filter(Boolean)
for (const pid of left) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true })
log(`left running and ended by id: ${left.join(' ') || 'none'}`)
writeFileSync(path.join(OUT, 'typed.json'), `${JSON.stringify(results, null, 2)}\n`)
spawnSync('ffmpeg', ['-v', 'error', '-framerate', '1', '-i', path.join(FRAMES, 'f-%05d.png'), '-vf', 'scale=trunc(iw/4)*2:trunc(ih/4)*2,fps=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path.join(OUT, 'video.mp4')], { windowsHide: true })
log('done (video: one frame for every two seconds, played at twice the speed)')
process.exit(0)
