// Windows Defender and the install lines of the live guide (https://itcan.do/install.md, 0.1.42)
// and the variants agents wrote of them in the rehearsal's runs, each started as an agent's tool
// starts it (powershell.exe with the line after -Command, or the line as given), with Defender's
// own log read after each (event ids, names and counts; no path is kept).
//
// Defender judges a command line when the program starts, so whether the script then installs
// does not change the verdict: each try's IT_HOME is a folder that already holds a file, which
// the install script refuses before it downloads anything, so that no try installs or downloads.
//   node e2e/rehearsal/defender-live.mjs [--out <folder>]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { homeOnWindows, systemPath } from '../apps/windows.mjs'

const i = process.argv.indexOf('--out')
const OUT = i === -1 ? 'D:\\it-rehearsal\\2026-11-15\\defender\\live' : process.argv[i + 1]
const ROOT = 'D:\\r\\deflive'
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'
const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const U = 'https://itcan.do/install.ps1'
mkdirSync(OUT, { recursive: true })
const ps = (line, flags = ['-NoProfile']) => [PS, ...flags, '-Command', line]

const tries = [
  // The live guide's lines for an agent, as a tool runs them
  { name: 'guide-1-download', how: 'guide line 1 (download to a file), in powershell -NoProfile -Command', argv: ps(`irm ${U} -OutFile "$env:TEMP\\it-install.ps1"`) },
  { name: 'guide-2-run-file', how: 'guide line 2 (run the file), as given', argv: [PS, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '%TEMP%\\it-install.ps1'], needsFile: true },
  { name: 'guide-2-in-command', how: 'guide line 2, wrapped in powershell -Command as an agent tool does', argv: ps(`powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\it-install.ps1"`), needsFile: true },
  { name: 'guide-fallback', how: 'the guide\'s fallback: Get-Content -Raw file | powershell -NoProfile -Command -', argv: ps(`Get-Content -Raw "$env:TEMP\\it-install.ps1" | powershell -NoProfile -Command -`), needsFile: true },
  // What the agents ran tonight
  { name: 'claude-site-run', how: 'as Claude Code ran it from the live guide: $env:IT_INSTALL_PLAIN then powershell -File', argv: ps(`$env:IT_INSTALL_PLAIN='1'; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\it-install.ps1"`), needsFile: true },
  { name: 'claude-iwr-file', how: 'as Claude Code ran it on bba16ffc: Invoke-WebRequest to a file, then & the file', argv: ps(`Invoke-WebRequest ${U} -OutFile "$env:TEMP\\it-install.ps1"; $env:IT_INSTALL_PLAIN='1'; & "$env:TEMP\\it-install.ps1"`) },
  { name: 'codex-irm-iex', how: 'as Codex ran it (68e03a6d and earlier): Invoke-RestMethod | Invoke-Expression', argv: ps(`$env:IT_INSTALL_PLAIN = '1'; Invoke-RestMethod -Uri '${U}' | Invoke-Expression`) },
  { name: 'codex-iwr-content', how: 'as Codex read it first: (Invoke-WebRequest … -UseBasicParsing).Content', argv: ps(`(Invoke-WebRequest -Uri '${U}' -UseBasicParsing).Content | Out-Null`) },
  { name: 'codex-ascii-bypass', how: 'Codex-style, no profile flag', argv: ps(`$env:IT_INSTALL_PLAIN = '1'; Invoke-RestMethod -Uri '${U}' | Invoke-Expression`, []) },
  // The lines Defender blocked this afternoon, again
  { name: 'old-guide-line', how: 'the old guide line', argv: ps(`irm ${U} | iex`) },
  { name: 'old-no-noprofile', how: 'the old guide line without -NoProfile (blocked at 14:11)', argv: ps(`irm ${U} | iex`, []) },
  { name: 'old-bypass', how: 'the old guide line with -ExecutionPolicy Bypass (blocked at 14:12)', argv: ps(`irm ${U} | iex`, ['-NoProfile', '-ExecutionPolicy', 'Bypass']) },
  { name: 'old-127', how: 'last night\'s first blocked line, replayed (stand-in address; nothing listens there now)', argv: [PS, '-NoProfile -Command irm http://127.0.0.1:5690/latest/download/latest.json | iex'], verbatim: true },
  // Other shells an agent may use
  { name: 'bash-guide-1', how: 'guide line 1 from Git Bash (as Claude Code\'s Bash tool)', argv: [BASH, '-c', `powershell -NoProfile -Command 'irm ${U} -OutFile "$env:TEMP\\it-install.ps1"'`] },
  { name: 'cmd-guide-2', how: 'guide line 2 from cmd /c', argv: [CMD, '/d', '/c', 'powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\\it-install.ps1"'], verbatim: true, needsFile: true },
]

function envFor(home) {
  const itHome = path.join(home, '.it')
  // A folder that already holds a file that is not It's: the script refuses it before downloading
  mkdirSync(itHome, { recursive: true })
  writeFileSync(path.join(itHome, 'not-its.txt'), 'keeps the install script from downloading\n')
  return { PATH: systemPath().join(';'), HOME: home, ...homeOnWindows(home), IT_HOME: itHome, IT_INSTALL_PLAIN: '1', IT_INSTALL_NO_PATH: '1', IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage', USERNAME: process.env.USERNAME, COMPUTERNAME: process.env.COMPUTERNAME, USERDOMAIN: process.env.USERDOMAIN }
}
function events(since) {
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', `Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1116,1117; StartTime=[datetime]::Parse('${since}').ToLocalTime()} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ t=$_.TimeCreated.ToUniversalTime().ToString('o'); id=$_.Id; name=([regex]::Match($_.Message,'Name: (\\S+)').Groups[1].Value); line=([regex]::Match($_.Message,'CmdLine:_\\S+\\\\(\\S+\\.exe .{0,160})').Groups[1].Value) } } | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true })
  try {
    return [JSON.parse(r.stdout)].flat().filter(Boolean)
  } catch {
    return []
  }
}
function runTry(t, env, cwd) {
  return new Promise((resolve) => {
    const [cmd, ...args] = t.argv.map((a) => a.replace(/%TEMP%/g, env.TEMP))
    let out = ''
    let child
    try {
      child = spawn(cmd, args, { env, cwd, windowsHide: true, windowsVerbatimArguments: Boolean(t.verbatim), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ code: null, spawnError: String(e.code ?? e.message), out })
    }
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const late = setTimeout(() => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }), 60_000)
    child.on('error', (e) => {
      clearTimeout(late)
      resolve({ code: null, spawnError: String(e.code ?? e.message), out })
    })
    child.on('close', (code) => {
      clearTimeout(late)
      resolve({ code, out })
    })
  })
}

const results = []
for (const t of tries) {
  const home = path.join(ROOT, t.name)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const env = envFor(home)
  // The saved script, for a line that runs the file: fetched here (by this program, not by the try)
  if (t.needsFile) writeFileSync(path.join(env.TEMP, 'it-install.ps1'), Buffer.from(await (await fetch(U)).arrayBuffer()))
  const since = new Date(Date.now() - 1000).toISOString()
  const r = await runTry(t, env, home)
  await new Promise((s) => setTimeout(s, 10_000))
  // Only events whose command line is this try's own (a late event of an earlier try is told apart)
  const evs = events(since)
  const ran = !r.spawnError
  const refusedFolder = /already holds files/.test(r.out)
  const res = { name: t.name, how: t.how, at: since, started: ran, spawnError: r.spawnError ?? null, exit: r.code, scriptRan: refusedFolder, events: evs.map((e) => ({ t: e.t, id: e.id, name: e.name, line: e.line })) }
  results.push(res)
  console.log(`${t.name}: ${ran ? 'started' : `NOT STARTED (${r.spawnError})`}, script reached its folder check: ${refusedFolder}, Defender: ${evs.length ? evs.map((e) => `${e.id} ${e.name}`).join('; ') : 'nothing'}`)
  writeFileSync(path.join(OUT, 'tries.json'), `${JSON.stringify(results, null, 2)}\n`)
}
for (const t of tries) rmSync(path.join(ROOT, t.name), { recursive: true, force: true })
