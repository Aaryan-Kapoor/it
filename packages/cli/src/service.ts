// Keeping It running: one per-user background service, registered with whatever the operating
// system uses for that. All three run the same command, `it serve`.
//   Linux    a systemd user unit, it.service
//   macOS    a launchd agent, dev.it
//   Windows  a scheduled task at logon, named it
//
// However it is stopped, the service is asked to stop and waited for. It stops the backend
// program itself, last: by asking and by nothing else on Linux and macOS, and on Windows, where
// that program cannot be counted on to hear, by ending it once it has been asked. What stops
// the service is held to asking, on every system.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { home, inHome, PROFILE_VARS, psQuote, readJson, writeFlushed } from './lib'

const NAME = 'it'
const LABEL = 'dev.it'

export interface ServiceStatus {
  registered: boolean
  state: string
  where: string
  /** Something the person should know about how it was set up. */
  note?: string
}

/** The command the service runs: this program, by the address it was started from. */
export function command(): string[] {
  const script = process.argv[1]
  const underRuntime = script !== undefined && /\.(m?js|ts)$/.test(script)
  // The program is told where to write its log, and keeps that file to a sensible size itself:
  // a supervisor that appends output to a file never trims it
  return [process.execPath, ...(underRuntime ? [path.resolve(script)] : []), 'serve', '--log', logFile()]
}
export const logFile = () => inHome('logs', 'it.log')

/**
 * The file by which a service is asked to stop where the system has no way of its own to ask:
 * Windows ends a task's programs outright. The service looks for the file while it runs, and
 * stops as it does when it is signalled.
 */
export const stopFile = (folder = home()) => path.join(folder, 'service.stop')
const alive = (pid: unknown): pid is number => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** Whether a service is running for an It folder, by what a running one keeps there: the backend's lock, or, on a machine that only joined an It, the connector's note. */
export const runningFor = (folder: string): boolean =>
  alive(readJson<{ pid?: unknown }>(path.join(folder, 'backend', 'lock'))?.pid) || alive(readJson<{ pid?: unknown }>(path.join(folder, 'connector.json'))?.pid)
const sleep = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
/** How long a service that was asked to stop is waited for before that is said. It is never made to stop. */
const STOP_MS = 5 * 60_000
/**
 * Asks the service that runs for a folder to stop, and waits until it has. One that has not
 * stopped in time is left running and said to be: nothing here ever ends it another way.
 */
export function askToStop(folder: string, forMs = STOP_MS): void {
  if (!runningFor(folder)) return
  writeFileSync(stopFile(folder), '', { mode: 0o600 })
  for (const until = Date.now() + forMs; runningFor(folder); sleep(200))
    if (Date.now() > until) throw new Error('It was asked to stop and is still stopping. Run this again once it has stopped')
}

/**
 * Runs one of the system's own commands and gives what it printed. `forMs` is how long it is
 * given, for a command that only asks the system something: one that has not answered by then
 * is ended and has not answered. A command that changes something is given no limit, since
 * some of them wait for the service to stop, which takes as long as it takes.
 */
function run(cmd: string, args: string[], forMs?: number): { ok: boolean; out: string } {
  // The environment is named, though it is this program's own: Bun looks for a command along
  // the path it started with unless it is given one, and Node along the path as it is now.
  // Given it, both find the system's command where this program would be told to look.
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, env: process.env, ...(forMs === undefined ? {} : { timeout: forMs }) })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}
/** How long the system is given to answer a question about the service. */
const ASKED_MS = 10_000
/** And how long on Windows, where the question is put through PowerShell, which takes a while to start. */
const ASKED_WINDOWS_MS = 30_000
function must(cmd: string, args: string[], what: string): void {
  const r = run(cmd, args)
  if (!r.ok) throw new Error(`${what} failed: ${r.out || cmd}`)
}

// The settings a service needs are passed in its definition, because it does not start from a
// shell. This one list is what all three systems are given: where It's folder is, which port
// It counts from, which backend program it runs or where it fetches one from, and which backend
// it talks to, when the shell that installed it said, which harnesses the service may touch at
// all (it reconciles add-ons by itself, and must leave alone what the shell that installed it
// was told to leave alone), where usage is reported to, and where the person keeps each
// harness's settings when that is not the usual place, so that the connector looks where the
// shell that ran `it setup` looked.
//
// Whether usage is reported at all is not in the list. That is kept in a file in It's folder,
// which the service reads. A copy of the off switch saved in a service's definition would turn
// reporting off again every time the service started, after the person had turned it back on.
export function environment(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { PATH: from.PATH ?? from.Path ?? '' }
  for (const k of [
    'IT_HOME',
    'IT_PORT',
    'IT_BACKEND_BIN',
    'IT_BACKEND_RELEASES',
    'IT_BACKEND_FETCH_MINUTES',
    'IT_URL',
    'IT_SITE_URL',
    'IT_HARNESSES',
    'IT_EXPERIMENTAL',
    'IT_TELEMETRY_URL',
    ...PROFILE_VARS,
  ])
    if (from[k]) out[k] = from[k]!
  // A folder or a file named from where the shell stood would be looked for from wherever the
  // service stands: It's own, the backend program, and each place the person keeps a harness's
  // settings. Where a backend program is fetched from is an address, and is carried as it was given.
  for (const k of ['IT_HOME', 'IT_BACKEND_BIN', ...PROFILE_VARS]) if (out[k] && !path.isAbsolute(out[k])) out[k] = path.resolve(out[k])
  return out
}

// systemd reads a backslash, a quote and a percent sign as more than themselves, and in the
// command it starts a dollar sign too
const systemdQuote = (v: string, command = false) => {
  const quoted = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  return `"${command ? quoted.replace(/\$/g, '$$$$') : quoted}"`
}
export function systemdUnit(cmd: string[], env: Record<string, string>): string {
  return `[Unit]
Description=It: shows your agents' pages on your displays, and brings what you do on them back to your agents
After=network-online.target

[Service]
Type=simple
ExecStart=${cmd.map((w) => systemdQuote(w, true)).join(' ')}
# Asked to stop, the service alone is told. It stops the backend program itself, last and by
# asking, which is the only way that program stops cleanly. And nothing the service leaves
# behind keeps it from being started again: where the service dies, the backend program is
# left running, and the service that starts next asks it to stop. (With KillMode=mixed and
# SendSIGKILL=no, systemd starts no service while anything of its last run is left.)
KillMode=process
# It is given as long as that takes, which is what the service itself gives the backend
# program, and nothing of It is killed for being slow to stop.
TimeoutStopSec=infinity
SendSIGKILL=no
${Object.entries(env)
  .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
  .join('\n')}
# Restarted if it fails. Stopped on purpose, it stays stopped.
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

const xml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/**
 * How long launchd waits for the service once it has asked it to stop, in seconds. The service
 * stops the backend program by asking and waits for it, so it is given far longer than a clean
 * stop takes. The backend program is in a group of its own and is not launchd's to end.
 */
const EXIT_S = 600
export function launchdPlist(cmd: string[], env: Record<string, string>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${cmd.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>${EXIT_S}</integer>
</dict>
</plist>
`
}

// What cmd.exe reads as more than itself. A percent sign begins a variable's name, and is
// doubled to be one. Outside quotes a caret goes before every character that could end the
// command and begin another, a quote included: a quote would otherwise switch that reading on
// and off, and a value with one in it could say what is run next.
const cmdValue = (v: string) => v.replace(/[\^&|<>()"]/g, '^$&').replace(/%/g, '%%')
function cmdWord(w: string): string {
  if (/^[A-Za-z0-9_.-]+$/.test(w)) return w
  // No file on Windows has a quote in its name, so a word with one is not a path this program made
  if (/["\r\n]/.test(w)) throw new Error('a path on this machine has a character that cannot be written into the launcher')
  return `"${w.replace(/%/g, '%%')}"`
}
/**
 * What the scheduled task runs on Windows: a .cmd file that gives the service its settings and
 * then starts the program. A task has no environment of its own to put them in, so the file
 * holds them, the same ones a systemd unit and a launchd agent are given.
 */
export function windowsLauncher(cmd: string[], env: Record<string, string>): string {
  const lines = [
    '@echo off',
    // An exclamation mark in a value is then only itself
    'setlocal DisableDelayedExpansion',
    // The lines after this one are read as UTF-8, which is how this file is written: a folder
    // with an accent in its name is otherwise read as some other folder
    'chcp 65001 >nul 2>&1',
  ]
  for (const [k, v] of Object.entries(env)) {
    // Nothing set is left as the task has it: an empty value would take the variable away
    if (!v || /[\r\n]/.test(v)) continue
    const line = `set ${k}=${cmdValue(v)}`
    // cmd.exe reads no line longer than this. A PATH that is, is left as the task has it.
    if (line.length <= 8000) lines.push(line)
  }
  // The program is started again five seconds after it has ended as a failure, as systemd and
  // launchd are told to start it again: ended from outside or fallen over, it comes back by
  // itself. Stopped on purpose, it ends well and stays stopped, and a task that is ended takes
  // this file's own cmd.exe with it. The Task Scheduler is told to do the same a minute after
  // a task has failed, and was seen not to, which is why it is done here. The wait is a ping,
  // since `timeout` refuses to wait where it has no keyboard to be interrupted from.
  lines.push(':again', cmd.map(cmdWord).join(' '), 'if %errorlevel% equ 0 exit /b 0', 'ping -n 6 127.0.0.1 >nul 2>&1', 'goto again')
  return `${lines.join('\r\n')}\r\n`
}
const windowsLauncherFile = () => inHome('bin', 'it-service.cmd')

const ps = psQuote
export function windowsScript(folder: string, launcher: string): string {
  // The task runs the launcher by its bare name, started in the launcher's folder. The folder's
  // own name then passes through no command line, where a space, an ampersand or a caret in it
  // would have to be quoted for three programs in turn. A .cmd file is run by cmd.exe, which
  // is named here, and conhost --headless keeps a console window from appearing at logon.
  // A task that is still running is stopped first. Registering the task again does not touch
  // it, and starting a task that is running starts nothing, so one set up with the old settings
  // would otherwise go on as it was. By now the service itself has been asked to stop and has
  // (see `install`): what this ends is the window it was started in.
  return [
    `Stop-ScheduledTask -TaskName ${ps(NAME)} -ErrorAction SilentlyContinue`,
    `$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${ps(`--headless cmd.exe /d /c .\\${launcher}`)} -WorkingDirectory ${ps(folder)}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)',
    `Register-ScheduledTask -TaskName ${ps(NAME)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${ps(NAME)}`,
  ].join('\n')
}
/**
 * What every script given to PowerShell begins with. PowerShell says how far it has got with
 * what it is doing ("Preparing modules for first use", the first time a person's account runs
 * it) as a block of XML among what it prints, where it has no window to draw that in. Told
 * this, it says nothing of the kind, and what it prints is what the script printed.
 */
export const PS_QUIET = "$ProgressPreference = 'SilentlyContinue'"

/**
 * Runs a script in Windows PowerShell and gives what it printed, read as UTF-8. The script is
 * told first to print as UTF-8, which it otherwise does in the code page of its console. Where
 * it has no console to be told so, that is passed over, and what it prints is in the system's
 * own code page: so nothing this program goes by is read from PowerShell as plain text.
 */
function powershell(script: string, forMs?: number) {
  const asUtf8 = 'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}'
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`${PS_QUIET}\n${asUtf8}\n${script}`, 'utf16le').toString('base64')],
    forMs,
  )
}
/** PowerShell, asked something it only has to answer. */
const powershellAsked = (script: string) => powershell(script, ASKED_WINDOWS_MS)

/**
 * The It folder the task Windows has registered runs the service from, or null when no task is
 * registered or it cannot be asked. It is read from the task's own action: the task is started
 * in the folder's `bin`, where its launcher is. The folder's name is asked for as the bytes of
 * it in UTF-8, written in base64, and read back from those: a name with a letter outside the
 * code page PowerShell prints in would otherwise come back as the name of some other folder.
 */
export function windowsRegisteredFor(ask: (script: string) => { ok: boolean; out: string } = powershellAsked): string | null {
  const asked = ask(
    `[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((Get-ScheduledTask -TaskName ${ps(NAME)} -ErrorAction Stop).Actions[0].WorkingDirectory))`,
  )
  const said = asked.ok ? (asked.out.split(/\r?\n/)[0]?.trim() ?? '') : ''
  // Only what is base64 from end to end is the folder's name. Anything else is PowerShell saying something of its own
  const bin = said.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(said) ? Buffer.from(said, 'base64').toString('utf8') : ''
  return bin ? path.win32.dirname(bin.replace(/[\\/]+$/, '')) : null
}
/** Whether two addresses name the same folder on Windows, where the case of a letter and which way a slash leans make no difference. */
export const sameWindowsFolder = (a: string, b: string): boolean => {
  const plain = (folder: string) =>
    path.win32
      .resolve(folder)
      .replace(/[\\/]+$/, '')
      .toLowerCase()
  return plain(a) === plain(b)
}

// Where systemd looks for a person's own units: under the folder XDG_CONFIG_HOME names, where it
// names one in full, and under ~/.config otherwise. Written anywhere else, a unit is not found.
const unitPath = () => {
  const named = process.env.XDG_CONFIG_HOME
  return path.join(named && path.isAbsolute(named) ? named : path.join(os.homedir(), '.config'), 'systemd', 'user', `${NAME}.service`)
}
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const launchdDomain = () => `gui/${process.getuid?.() ?? 501}`

// A machine has one background service, and it belongs to the It folder it was set up from:
// taking It out of another folder (a second one kept elsewhere, a test) never takes the service
// away from the one that owns it. What is registered names its folder's log file, which is how
// it is told whose it is. The name is looked for as the definition's writer wrote it, as one
// whole word: a percent sign or an ampersand in it is not written there as itself, and another
// folder's name may end in this one's. On Windows the task is asked for its own action, which
// names the folder it is started in: a launcher left in a folder says only that the folder once
// registered the task, and another folder may have registered it since.
export function installedHere(): boolean {
  if (process.platform === 'win32') {
    const registered = windowsRegisteredFor()
    return registered !== null && sameWindowsFolder(registered, home())
  }
  const [registered, named] =
    process.platform === 'linux'
      ? [unitPath(), systemdQuote(logFile(), true)]
      : process.platform === 'darwin'
        ? [plistPath(), `<string>${xml(logFile())}</string>`]
        : [null, '']
  if (!registered) return false
  try {
    return readFileSync(registered, 'utf8').includes(named)
  } catch {
    return false
  }
}

/**
 * Whose the service is that this machine has a definition of: this folder's, another folder's,
 * or nobody's where there is no definition. That is one thing, and whether the system starts
 * the service by itself is another: a definition the system has not taken, or has been told
 * to leave alone, is still the folder's it names, and only that folder takes it away.
 */
export function definedFor(): 'this folder' | 'another folder' | 'none' {
  if (process.platform === 'win32') {
    const registered = windowsRegisteredFor()
    return registered === null ? 'none' : sameWindowsFolder(registered, home()) ? 'this folder' : 'another folder'
  }
  const definition = process.platform === 'linux' ? unitPath() : process.platform === 'darwin' ? plistPath() : null
  if (!definition || !existsSync(definition)) return 'none'
  return installedHere() ? 'this folder' : 'another folder'
}

/**
 * Whether systemd has this user's service down to be started by itself, which is what enabling
 * it does. The definition's file being there does not say so: it is written before systemd is
 * asked to take it, and stays where systemd would not.
 */
const enabled = (): boolean => {
  const asked = run('systemctl', ['--user', 'is-enabled', `${NAME}.service`], ASKED_MS)
  return asked.ok && asked.out.split('\n')[0] === 'enabled'
}
/** How long what systemd said of the service is gone by before it is asked again. */
const ENABLED_FOR_MS = 60_000
let enabledWhen: { file: string; at: number; enabled: boolean } | undefined

/**
 * Whether It is registered with the system to start by itself from this folder, as the running
 * service says it of itself.
 *
 * The definition on the disk says which folder the service is for. On macOS it is also what
 * makes the system start the service when the person logs in. On Linux it is not: systemd
 * starts what was enabled, so systemd is asked. The service asks often, and asking starts a
 * program, so what systemd said is gone by for a minute, and only for as long as the
 * definition's file is the one it was said of: whatever registers the service or takes it
 * away writes or removes that file.
 *
 * On Windows only the task can say, and asking it starts a PowerShell. Nothing registers or
 * removes the task there without first asking this folder's service to stop, so there it is
 * asked once and the answer is kept for as long as the service runs.
 */
export function startsByItself(): boolean {
  if (process.platform === 'win32') {
    registeredOnWindows ??= installedHere()
    return registeredOnWindows
  }
  if (!installedHere()) return false
  if (process.platform !== 'linux') return true
  let file = ''
  try {
    const seen = statSync(unitPath())
    file = `${seen.ino}:${seen.size}:${seen.mtimeMs}`
  } catch {
    return false
  }
  if (enabledWhen?.file !== file || Date.now() - enabledWhen.at >= ENABLED_FOR_MS) enabledWhen = { file, at: Date.now(), enabled: enabled() }
  return enabledWhen.enabled
}
let registeredOnWindows: boolean | undefined

/**
 * Whether systemd's services for this person can be reached from here. They cannot in a
 * container, or in a session that has no bus of its own, and there nothing registers It to
 * start by itself. True on any system but Linux, where this is not how it is asked.
 */
/** A note that It is what made this account stay after logout, kept in It's folder. */
const lingerNote = () => path.join(home(), 'linger-by-it')

export function reachable(): boolean {
  if (process.platform !== 'linux') return true
  const asked = run('systemctl', ['--user', 'show-environment'], ASKED_MS)
  return asked.ok
}

/**
 * Writes what the system is to start It by, whole or not at all: under another name first,
 * with every byte on the disk, and then given its name in one step. A disk that fills while
 * the definition is being written leaves the one that was there, and never a part of a new
 * one, which the system would read at the next start.
 */
function writeDefinition(file: string, text: string): void {
  const part = `${file}.${process.pid}.part`
  try {
    writeFlushed(part, text)
    if (process.platform !== 'win32') chmodSync(part, 0o644)
    renameSync(part, file)
  } finally {
    rmSync(part, { force: true })
  }
}

export function install(): ServiceStatus {
  mkdirSync(path.dirname(logFile()), { recursive: true, mode: 0o700 })
  const cmd = command()
  const env = environment()
  if (process.platform === 'linux') {
    // Where systemd keeps no services for this person (a container, some remote logins), that
    // is said in words, before anything is written: nothing It could put on the disk would
    // make it start by itself there, and a definition left behind would only say that it does
    if (!reachable())
      throw new Error(
        'this machine has no systemd for your account that can be reached from here, as in a container or over some remote logins, so nothing can start It by itself',
      )
    const before = existsSync(unitPath()) ? readFileSync(unitPath(), 'utf8') : null
    mkdirSync(path.dirname(unitPath()), { recursive: true })
    writeDefinition(unitPath(), systemdUnit(cmd, env))
    try {
      must('systemctl', ['--user', 'daemon-reload'], 'reloading systemd')
      must('systemctl', ['--user', 'enable', `${NAME}.service`], 'enabling the service')
      must('systemctl', ['--user', 'restart', `${NAME}.service`], 'starting the service')
    } catch (err) {
      // What was written is taken back, so that the definition's file says what is so, and
      // systemd is told, so that what it holds is what the file says
      try {
        if (before === null) rmSync(unitPath(), { force: true })
        else writeDefinition(unitPath(), before)
      } catch {}
      run('systemctl', ['--user', 'daemon-reload'])
      throw err
    }
    // Without this the service stops when the person logs out, which on a server is always.
    // Whether the account already stayed after logout is noted first: where It is what
    // turned that on, taking It off the machine turns it off again, and where the person
    // had it so for reasons of their own, it is left as they had it.
    const stayed = /^Linger=yes$/m.test(run('loginctl', ['show-user', os.userInfo().username, '--property=Linger'], ASKED_MS).out ?? '')
    try {
      if (!stayed && !existsSync(lingerNote())) writeFileSync(lingerNote(), '', { mode: 0o600 })
    } catch {}
    if (!run('loginctl', ['enable-linger', os.userInfo().username]).ok)
      return {
        ...status(),
        note: 'It will stop when you log out of this machine: `loginctl enable-linger` was refused. Ask whoever runs the machine to allow it.',
      }
  } else if (process.platform === 'darwin') {
    mkdirSync(path.dirname(plistPath()), { recursive: true })
    run('launchctl', ['bootout', `${launchdDomain()}/${LABEL}`])
    writeDefinition(plistPath(), launchdPlist(cmd, env))
    must('launchctl', ['bootstrap', launchdDomain(), plistPath()], 'loading the agent')
  } else if (process.platform === 'win32') {
    // Windows ends a task's programs outright, with no word to the service that it is to
    // close its door and stop its backend program in its turn. So the service that is running
    // is asked to stop, and waited for, before its task is touched: this folder's, and the
    // one the task was registered for when that is another.
    const registered = windowsRegisteredFor()
    for (const folder of registered && !sameWindowsFolder(registered, home()) ? [registered, home()] : [home()]) askToStop(folder)
    mkdirSync(path.dirname(windowsLauncherFile()), { recursive: true })
    writeDefinition(windowsLauncherFile(), windowsLauncher(cmd, env))
    const r = powershell(windowsScript(path.dirname(windowsLauncherFile()), path.basename(windowsLauncherFile())))
    if (!r.ok) throw new Error(`registering the task failed: ${r.out}`)
  } else {
    throw new Error(`It cannot register a background service on ${process.platform}. Run \`it serve\` under your own supervisor.`)
  }
  return status()
}

/**
 * Takes the service away from the system. On Windows the service that is running is asked to
 * stop first and waited for, for as long as `patience` says: while it has not stopped, its
 * task is neither ended nor taken away, and that is said.
 */
export function uninstall(patience = STOP_MS): void {
  if (process.platform === 'linux') {
    // Where there is a definition, the service is stopped before the definition goes. Where
    // it could not be stopped, or could not be asked, the definition stays and that is said:
    // taken away regardless, It would be said to be stopped while it went on running, with
    // nothing left to stop it by.
    if (existsSync(unitPath())) {
      const stopped = run('systemctl', ['--user', 'disable', '--now', `${NAME}.service`])
      if (!stopped.ok && (!reachable() || run('systemctl', ['--user', 'is-active', '--quiet', `${NAME}.service`]).ok))
        throw new Error(
          `the background service could not be stopped${stopped.out ? ` (${stopped.out.split('\n')[0]})` : ''}, so its definition was left where it is. Run this again from a session of your own on this machine, or stop it with \`systemctl --user stop ${NAME}\``,
        )
    }
    rmSync(unitPath(), { force: true })
    run('systemctl', ['--user', 'daemon-reload'])
    // The account stays after logout only because It asked for that: it stops doing so
    if (existsSync(lingerNote())) {
      run('loginctl', ['disable-linger', os.userInfo().username])
      rmSync(lingerNote(), { force: true })
    }
  } else if (process.platform === 'darwin') {
    const out = run('launchctl', ['bootout', `${launchdDomain()}/${LABEL}`])
    // Still loaded after being asked to go: its definition stays, and that is said
    if (!out.ok && run('launchctl', ['print', `${launchdDomain()}/${LABEL}`]).ok)
      throw new Error(`the background service could not be stopped${out.out ? ` (${out.out.split('\n')[0]})` : ''}, so its definition was left where it is`)
    rmSync(plistPath(), { force: true })
  } else if (process.platform === 'win32') {
    // The service is asked to stop and waited for first, as before its task is replaced
    askToStop(home(), patience)
    // A task that is not there is none to take away, and says nothing. One that is still there
    // after it was asked to go, which is what a refusal leaves, is said as that: and so is a
    // Windows that could not be asked at all
    const out = powershell(
      `Stop-ScheduledTask -TaskName ${ps(NAME)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${ps(NAME)} -Confirm:$false -ErrorAction SilentlyContinue; if (Get-ScheduledTask -TaskName ${ps(NAME)} -ErrorAction SilentlyContinue) { 'Windows still has the task'; exit 3 }`,
    )
    // What it starts stays where it is then: taken away, the task that is still there would start nothing at the next sign-in, with no word of why
    if (!out.ok)
      throw new Error(`the background task could not be taken away${out.out ? ` (${out.out.split('\n')[0]})` : ''}, so what it starts was left where it is`)
    rmSync(windowsLauncherFile(), { force: true })
  }
}

/**
 * How the system has the service: whether it is registered there to be started by itself, and
 * what state the system says it is in. On Linux the service is registered when systemd says it
 * is enabled, and not by its definition's file alone, which is there from before systemd was
 * asked to take it. On macOS the definition's file is the registration: the system loads it
 * when the person next logs in, whatever it says of it now.
 */
export function status(): ServiceStatus {
  // A machine has one definition. Where it is another folder's, the service it speaks of runs
  // that folder's It: of this one, nothing is registered, however that other stands
  if (process.platform !== 'win32' && definedFor() === 'another folder')
    return { registered: false, state: 'not installed', where: process.platform === 'darwin' ? plistPath() : unitPath() }
  if (process.platform === 'linux') {
    const r = run('systemctl', ['--user', 'is-active', `${NAME}.service`], ASKED_MS)
    return { registered: existsSync(unitPath()) && enabled(), state: r.out.split('\n')[0] || 'unknown', where: unitPath() }
  }
  if (process.platform === 'darwin') {
    const r = run('launchctl', ['print', `${launchdDomain()}/${LABEL}`], ASKED_MS)
    return { registered: existsSync(plistPath()), state: r.ok ? (/state = (\w+)/.exec(r.out)?.[1] ?? 'loaded') : 'not loaded', where: plistPath() }
  }
  if (process.platform === 'win32') {
    const r = powershellAsked(`(Get-ScheduledTask -TaskName ${ps(NAME)} -ErrorAction Stop).State`)
    // The state is one word, on the first line of what was printed. Anything PowerShell said after it is not the state
    return { registered: r.ok, state: r.ok ? (r.out.split(/\r?\n/)[0]?.trim() ?? '') || 'unknown' : 'not registered', where: `Scheduled Task "${NAME}"` }
  }
  return { registered: false, state: 'unsupported', where: home() }
}
