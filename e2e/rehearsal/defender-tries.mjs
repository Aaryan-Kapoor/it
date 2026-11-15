// Which ways of running It's Windows install script Windows Defender lets through, on this real
// machine, each started as a program (an agent's tool, Node, cmd, a background process) starts it:
//
//   node e2e/rehearsal/defender-tries.mjs [--only <name,name>] [--out <folder>]
//
// Each try runs in a throwaway profile (its own USERPROFILE, IT_HOME, TEMP), with IT_INSTALL_BASE
// naming the stand-in (which also serves the real public script's downloads, being on 127.0.0.1),
// IT_INSTALL_PLAIN so that the script stops once the program is in place and sets nothing up, and
// IT_INSTALL_NO_PATH so that the owner's PATH is left alone. Defender's own event log is read
// (read only) for 1116/1117 after each try; nothing in Defender is changed.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { homeOnWindows, systemPath } from '../apps/windows.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const OUT = arg('out', 'D:\\it-rehearsal\\2026-11-15\\defender')
const ROOT = 'D:\\r\\def'
const only = arg('only', '')
  .split(',')
  .filter(Boolean)
mkdirSync(OUT, { recursive: true })
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'
const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const REAL = 'https://itcan.do/install.ps1'
const GH = 'https://github.com/Aaryan-Kapoor/it/releases/latest/download/install.ps1'
const LOCAL = 'http://127.0.0.1:5690/latest/download/install.ps1'
const LOCALHOST = 'http://localhost:5690/latest/download/install.ps1'
const b64 = (s) => Buffer.from(s, 'utf16le').toString('base64')

// Each try: how a program starts it. `file` is where a two-step form saves the script.
const tries = [
  // c. The guide's line, started by a program
  { name: 'node-guide-real', how: 'Node spawns the guide\'s line', argv: [PS, '-NoProfile', '-Command', `irm ${REAL} | iex`] },
  { name: 'node-guide-github', how: 'Node spawns the line with the GitHub release address', argv: [PS, '-NoProfile', '-Command', `irm ${GH} | iex`] },
  { name: 'node-guide-127', how: 'Node spawns the line with the stand-in\'s IP address', argv: [PS, '-NoProfile', '-Command', `irm ${LOCAL} | iex`] },
  { name: 'node-guide-localhost', how: 'Node spawns the line with localhost', argv: [PS, '-NoProfile', '-Command', `irm ${LOCALHOST} | iex`] },
  { name: 'cmd-guide-real', how: 'cmd /c starts the guide\'s line', argv: [CMD, '/d', '/c', `powershell -NoProfile -Command "irm ${REAL} | iex"`], verbatim: true },
  { name: 'bash-guide-real', how: 'Git Bash (as Claude Code\'s Bash tool) starts the guide\'s line', argv: [BASH, '-c', `powershell -NoProfile -Command "irm ${REAL} | iex"`] },
  { name: 'background-guide-real', how: 'a detached background process with no window starts the guide\'s line', argv: [PS, '-NoProfile', '-WindowStyle', 'Hidden', '-Command', `irm ${REAL} | iex`], detached: true },
  // Last night's blocked command lines, character for character (Defender events 1116/1117, 07:53-08:10 UTC)
  { name: 'replay-latest-json', how: 'replay of a command line Defender blocked last night (iex of latest.json, harmless)', argv: [PS, '-NoProfile -Command irm http://127.0.0.1:5690/latest/download/latest.json | iex'], verbatim: true },
  { name: 'replay-bypass-127', how: 'replay of a command line Defender blocked last night (-ExecutionPolicy Bypass, stand-in)', argv: [PS, '-NoProfile -ExecutionPolicy Bypass -Command irm http://127.0.0.1:5690/latest/download/install.ps1 | iex'], verbatim: true },
  { name: 'unquoted-real', how: 'the guide\'s line with no quotes, as Start-Process or a joined command line passes it', argv: [PS, `-NoProfile -Command irm ${REAL} | iex`], verbatim: true },
  { name: 'unquoted-127-new', how: 'never seen before: unquoted, the stand-in\'s IP, a new query string', argv: [PS, '-NoProfile -Command irm http://127.0.0.1:5690/latest/download/install.ps1?try=2 | iex'], verbatim: true },
  { name: 'unquoted-127-noquery', how: 'unquoted, the stand-in\'s IP, without -ExecutionPolicy', argv: [PS, '-NoProfile -Command irm http://127.0.0.1:5690/latest/download/install.ps1 | iex'], verbatim: true },
  { name: 'unquoted-localhost', how: 'unquoted, localhost instead of the IP', argv: [PS, '-NoProfile -Command irm http://localhost:5690/latest/download/install.ps1 | iex'], verbatim: true },
  { name: 'unquoted-real-bypass', how: 'unquoted, the real address, with -ExecutionPolicy Bypass', argv: [PS, `-NoProfile -ExecutionPolicy Bypass -Command irm ${REAL} | iex`], verbatim: true },
  { name: 'unquoted-real-nonoprofile', how: 'unquoted, the real address, nothing else', argv: [PS, `-Command irm ${REAL} | iex`], verbatim: true },
  { name: 'quoted-real-noprofile-less', how: 'quoted, the real address, no -NoProfile', argv: [PS, `-Command "irm ${REAL} | iex"`], verbatim: true },
  { name: 'quoted-real-bypass', how: 'quoted, the real address, -ExecutionPolicy Bypass', argv: [PS, `-NoProfile -ExecutionPolicy Bypass -Command "irm ${REAL} | iex"`], verbatim: true },
  { name: 'quoted-real-exe', how: 'quoted, powershell.exe -NoProfile -NonInteractive', argv: [PS, `-NoProfile -NonInteractive -Command "irm ${REAL} | iex"`], verbatim: true },
  { name: 'codex-shape', how: 'as Codex ran it last night: $env:IT_INSTALL_PLAIN then Invoke-RestMethod | Invoke-Expression, quoted', argv: [PS, `-Command "$env:IT_INSTALL_PLAIN = '1'; Invoke-RestMethod -Uri '${REAL}' | Invoke-Expression"`], verbatim: true },
  { name: 'two-step-download', how: 'step 1 of the two-step form: download to a file', argv: [PS, `-NoProfile -Command "irm ${REAL} -OutFile $env:TEMP\\it-install.ps1"`], verbatim: true, keepFor: 'file' },
  { name: 'two-step-run', how: 'step 2: powershell -NoProfile -ExecutionPolicy Bypass -File', argv: [PS, '-NoProfile -ExecutionPolicy Bypass -File %TEMP%\\it-install.ps1'], verbatim: true, needs: 'two-step-download' },
  { name: 'start-process-hidden', how: 'a background PowerShell with no window (Start-Process -WindowStyle Hidden), as a tool that runs things in the background starts it', argv: [PS, '-NoProfile', '-Command', `Start-Process powershell.exe -WindowStyle Hidden -Wait -ArgumentList '-NoProfile','-Command','irm ${REAL} | iex'`] },
  // d. Other forms of the same script
  { name: 'iex-spelt-out', how: 'Invoke-Expression (Invoke-RestMethod …) spelt out', argv: [PS, '-NoProfile', '-Command', `Invoke-Expression (Invoke-RestMethod -Uri '${REAL}')`] },
  { name: 'iwr-iex', how: 'iwr -UseBasicParsing … | iex', argv: [PS, '-NoProfile', '-Command', `(iwr -UseBasicParsing '${REAL}').Content | iex`] },
  { name: 'scriptblock', how: 'irm into a variable, then & ([scriptblock]::Create($s))', argv: [PS, '-NoProfile', '-Command', `$s = Invoke-RestMethod '${REAL}'; & ([scriptblock]::Create($s))`] },
  { name: 'pipe-to-command-dash', how: 'irm … | powershell -NoProfile -Command -', argv: [PS, '-NoProfile', '-Command', `Invoke-RestMethod '${REAL}' | powershell -NoProfile -Command -`] },
  { name: 'curl-pipe-command-dash', how: 'curl.exe -fsSL … | powershell -NoProfile -Command - (from cmd)', argv: [CMD, '/d', '/c', `curl.exe -fsSL ${REAL} | powershell -NoProfile -Command -`], verbatim: true },
  { name: 'encoded-command', how: 'powershell -EncodedCommand of "irm … | iex"', argv: [PS, '-NoProfile', '-EncodedCommand', b64(`irm ${REAL} | iex`)] },
  // Two steps: download to a file, then run the file, under each execution policy
  { name: 'irm-outfile', how: 'step 1: irm … -OutFile (download only)', argv: [PS, '-NoProfile', '-Command', `Invoke-RestMethod '${REAL}' -OutFile "$env:TEMP\\it-install.ps1"`], keepFor: 'file' },
  { name: 'file-default-restricted', how: 'step 2: powershell -File, stock policy (Restricted, as -ExecutionPolicy Restricted)', argv: [PS, '-NoProfile', '-ExecutionPolicy', 'Restricted', '-File', '%TEMP%\\it-install.ps1'], needs: 'irm-outfile' },
  { name: 'file-remotesigned', how: 'step 2: powershell -File under RemoteSigned', argv: [PS, '-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', '%TEMP%\\it-install.ps1'], needs: 'irm-outfile' },
  { name: 'file-allsigned', how: 'step 2: powershell -File under AllSigned (as a locked-down laptop)', argv: [PS, '-NoProfile', '-ExecutionPolicy', 'AllSigned', '-File', '%TEMP%\\it-install.ps1'], needs: 'irm-outfile' },
  { name: 'file-bypass', how: 'step 2: powershell -ExecutionPolicy Bypass -File', argv: [PS, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '%TEMP%\\it-install.ps1'], needs: 'irm-outfile' },
  { name: 'curl-o-then-bypass', how: 'curl.exe -o, then powershell -ExecutionPolicy Bypass -File (from cmd, one line)', argv: [CMD, '/d', '/c', `curl.exe -fsSL -o "%TEMP%\\it-install2.ps1" ${REAL} && powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\\it-install2.ps1"`], verbatim: true },
  { name: 'file-content-scriptblock', how: 'saved file read and run as a script block (no policy needed)', argv: [PS, '-NoProfile', '-ExecutionPolicy', 'Restricted', '-Command', `& ([scriptblock]::Create((Get-Content -Raw "$env:TEMP\\it-install.ps1")))`], needs: 'irm-outfile' },
  { name: 'file-content-pipe', how: 'Get-Content -Raw file | powershell -Command - (no policy needed)', argv: [PS, '-NoProfile', '-ExecutionPolicy', 'Restricted', '-Command', `Get-Content -Raw "$env:TEMP\\it-install.ps1" | powershell -NoProfile -Command -`], needs: 'irm-outfile' },
]

function envFor(home) {
  const itHome = path.join(home, '.it')
  return {
    env: {
      PATH: systemPath().join(';'),
      HOME: home,
      ...homeOnWindows(home),
      IT_HOME: itHome,
      IT_INSTALL_BASE: 'http://127.0.0.1:5690',
      IT_INSTALL_PLAIN: '1',
      IT_INSTALL_NO_PATH: '1',
      IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
      USERNAME: process.env.USERNAME,
      COMPUTERNAME: process.env.COMPUTERNAME,
      USERDOMAIN: process.env.USERDOMAIN,
    },
    itHome,
  }
}

function events(since) {
  const r = spawnSync(
    PS,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1116,1117,1118,1119,1121,1122; StartTime=[datetime]::Parse('${since}').ToLocalTime()} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ t=$_.TimeCreated.ToUniversalTime().ToString('o'); id=$_.Id; name=([regex]::Match($_.Message,'Name: (\\S+)').Groups[1].Value); path=([regex]::Match($_.Message,'Path: (.*?)\\r?\\n\\s*Detection Origin').Groups[1].Value); action=([regex]::Match($_.Message,'Action: (.*?)\\r?\\n').Groups[1].Value) } } | ConvertTo-Json -Compress`,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  try {
    return [JSON.parse(r.stdout)].flat().filter(Boolean)
  } catch {
    return []
  }
}

function runTry(t, env, cwd) {
  return new Promise((resolve) => {
    const [cmd, ...args] = t.argv.map((a) => a.replace(/%TEMP%/g, env.TEMP))
    const started = Date.now()
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(cmd, args, { env, cwd, windowsHide: true, windowsVerbatimArguments: Boolean(t.verbatim), stdio: ['ignore', 'pipe', 'pipe'], detached: Boolean(t.detached) })
    } catch (e) {
      return resolve({ code: null, spawnError: String(e.message), out, err, seconds: 0 })
    }
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const late = setTimeout(() => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }), 240_000)
    child.on('error', (e) => {
      clearTimeout(late)
      resolve({ code: null, spawnError: String(e.message), out, err, seconds: (Date.now() - started) / 1000 })
    })
    child.on('close', (code) => {
      clearTimeout(late)
      resolve({ code, out, err, seconds: (Date.now() - started) / 1000 })
    })
  })
}

const results = []
const homes = {}
for (const t of tries) {
  if (only.length && !only.includes(t.name)) continue
  const home = t.needs && homes[t.needs] ? homes[t.needs] : path.join(ROOT, t.name)
  if (!t.needs) {
    rmSync(home, { recursive: true, force: true })
    mkdirSync(home, { recursive: true })
  } else if (homes[t.needs]) {
    // A fresh It folder for each step 2, the saved script kept
    rmSync(path.join(home, '.it'), { recursive: true, force: true })
  }
  if (t.keepFor) homes[t.name] = home
  const { env, itHome } = envFor(home)
  const since = new Date(Date.now() - 1000).toISOString()
  const r = await runTry(t, env, home)
  await new Promise((s) => setTimeout(s, 12_000))
  const evs = events(since)
  const installed = existsSync(path.join(itHome, 'bin', 'it.exe'))
  const saved = existsSync(path.join(env.TEMP, 'it-install.ps1'))
  const tail = `${r.out}\n${r.err}`.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' / ').slice(0, 600)
  const res = {
    name: t.name,
    how: t.how,
    commandLine: t.argv.map((a) => (a.includes(' ') && !t.verbatim ? `"${a}"` : a)).join(' ').replace(/[A-Za-z0-9+/=]{60,}/, (m) => `${m.slice(0, 20)}…`),
    at: since,
    exit: r.code,
    spawnError: r.spawnError ?? null,
    seconds: r.seconds,
    installed,
    savedScript: t.keepFor ? saved : undefined,
    blocked: evs.length > 0,
    events: evs,
    tail,
  }
  results.push(res)
  console.log(`${t.name}: exit ${r.code}${r.spawnError ? ` (${r.spawnError})` : ''}, installed ${installed}, Defender ${evs.length ? evs.map((e) => `${e.id} ${e.name}`).join('; ') : 'nothing'} — ${tail.slice(0, 200)}`)
  writeFileSync(path.join(OUT, 'tries.json'), `${JSON.stringify(results, null, 2)}\n`)
}
// The throwaway profiles go; the results stay
for (const t of tries) rmSync(path.join(ROOT, t.name), { recursive: true, force: true })
console.log(`results: ${path.join(OUT, 'tries.json')}`)
