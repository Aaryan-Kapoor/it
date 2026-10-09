// It kept running by the system itself, as a person has it after `it setup`: a systemd unit of
// their own on Linux, a launchd agent on macOS, a task of the Task Scheduler on Windows. The
// browser suite starts It by hand (`it serve`) and never asks the system for anything, so this
// is where that part is tried: that setup registers the service and it comes up; that the
// system starts it again after it is ended from outside; that a second setup, which is what an
// update runs, leaves it running; and that it is taken away again whole.
//
//   IT_BIN=<the standalone program> node e2e/service.mjs
//
// It registers a service under It's own name for whoever runs it, so it is only ever run on a
// machine made for the run: it refuses unless CI is set, or IT_E2E_SERVICE=1 says the machine
// is one, and it refuses where a service of that name is there already. It uses a folder of
// its own for It and takes everything away at its end, whatever became of the checks.
import './node.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const program = process.env.IT_BIN
if (!program || !existsSync(program)) {
  console.error('IT_BIN has to name the standalone program to run.')
  process.exit(2)
}
if (!process.env.CI && process.env.IT_E2E_SERVICE !== '1') {
  console.error('This registers a service for whoever runs it, and is run only where CI is set, or IT_E2E_SERVICE=1 says the machine was made for it.')
  process.exit(2)
}
const windows = process.platform === 'win32'
const home = mkdtempSync(path.join(os.tmpdir(), 'it-service-'))
const port = Number(process.env.IT_PORT ?? 4700)
const env = { ...process.env, IT_HOME: home, IT_PORT: String(port), IT_TELEMETRY_ENABLED: 'false' }
for (const name of ['IT_SESSION', 'IT_HARNESS', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) delete env[name]

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : `\n         ${String(detail).slice(0, 900)}`}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Runs the program with some words and gives how it ended, what it printed as JSON where it is JSON, and everything it said. */
const it = (words, forMs = 600_000) => {
  const ran = spawnSync(program, words, { env, encoding: 'utf8', timeout: forMs, windowsHide: true })
  const said = `${ran.stdout ?? ''}${ran.stderr ?? ''}`
  let json
  try {
    json = JSON.parse((ran.stdout ?? '').slice((ran.stdout ?? '').indexOf('{')))
  } catch {}
  return { code: ran.status, json, said }
}
const until = async (what, forMs, every = 1000) => {
  for (const end = Date.now() + forMs; Date.now() < end; await sleep(every)) {
    const got = await what()
    if (got) return got
  }
  return undefined
}
const answers = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(4000) })).status === 200
  } catch {
    return false
  }
}
/** The service as the program says it stands: whether the system has it, whether it runs, and the number of the program that is it. */
const stands = () => {
  const s = it(['service', 'status', '--json'], 60_000).json ?? {}
  return { registered: s.registered === true, running: s.running === true, pid: s.connector?.pid, state: s.state }
}
/** Ends a program outright, as a crash does: nothing is asked of it. */
const end = (pid) => {
  if (windows) spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true })
  else process.kill(pid, 'SIGKILL')
}
const tail = (most = 1500) => {
  try {
    return readFileSync(path.join(home, 'logs', 'it.log'), 'utf8').slice(-most)
  } catch {
    return '(the service wrote no log)'
  }
}
/** What the system itself says of the service and of the programs that are It's, for a run in which a check failed to say why. */
const seen = () => {
  const asked = (cmd, args) => {
    const ran = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    return `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim()
  }
  if (windows)
    return [
      asked('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ProgressPreference = 'SilentlyContinue'; Get-ScheduledTask -TaskName 'it' | Get-ScheduledTaskInfo | Format-List LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns; Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(it|it-windows-x64|convex-local-backend|conhost|cmd)' } | Select-Object ProcessId, ParentProcessId, Name, CommandLine | Format-Table -AutoSize -Wrap | Out-String -Width 220",
      ]),
    ].join('\n')
  if (process.platform === 'darwin') return asked('launchctl', ['print', `gui/${process.getuid()}/dev.it`]).slice(0, 1500)
  return asked('systemctl', ['--user', 'status', 'it', '--no-pager']).slice(0, 1500)
}
/** Said apart from a check that failed, in full: a check's own line holds little. */
const why = (what) => console.log(`\n--- ${what}\nwhat the system says:\n${seen()}\nthe end of the service's log:\n${tail(4000)}\n---\n`)

let registered = false
try {
  const before = stands()
  if (before.registered) {
    console.error(`A service of It is registered on this machine already (${before.state}), and this would put its own in its place. Nothing was done.`)
    process.exit(2)
  }
  console.log(
    `${process.platform} ${process.arch}, ${it(['--version'], 60_000).json?.version ?? 'a program that did not say its version'}, It's folder ${home}`,
  )

  // ---------- setup registers it, and it comes up ----------
  const setup = it(['setup', '--none', '--json'])
  registered = true
  check('setup registers It with the system and ends well', setup.code === 0 && setup.json?.service?.registered === true, setup.said.slice(-900))
  const up = await until(async () => (await answers()) && stands().running, 300_000, 2000)
  const first = stands()
  check(
    'the system has it running, and its site answers',
    Boolean(up) && first.registered && first.running && Number.isInteger(first.pid),
    `${JSON.stringify(first)}\n${tail()}`,
  )

  // ---------- ended from outside, the system starts it again ----------
  // systemd and launchd start it again within seconds. The Task Scheduler is told to try again a minute after a task has failed.
  if (Number.isInteger(first.pid)) {
    end(first.pid)
    const down = await until(async () => !(await answers()), 30_000, 500)
    const again = await until(
      async () => {
        const now = stands()
        return (await answers()) && now.running && now.pid !== first.pid ? now : undefined
      },
      windows ? 240_000 : 90_000,
      2000,
    )
    check(
      'ended from outside, as a crash ends it, it is started again by the system, and its site answers again',
      Boolean(down) && Boolean(again),
      `went down: ${Boolean(down)}; now: ${JSON.stringify(stands())}`,
    )
    if (!down || !again) why('after it was ended from outside')
  } else
    check('ended from outside, as a crash ends it, it is started again by the system, and its site answers again', false, 'there was no running service to end')

  // ---------- a second setup, which is what an update runs ----------
  const second = it(['setup', '--none', '--json'])
  const still = await until(async () => (await answers()) && stands().running, 180_000, 2000)
  check(
    'a second setup, which is what an update runs over a service that is running, ends well and leaves it running',
    second.code === 0 && second.json?.service?.registered === true && Boolean(still),
    `${second.said.slice(-600)}\nnow: ${JSON.stringify(stands())}`,
  )
  if (!(second.code === 0 && second.json?.service?.registered === true && still)) why('after the second setup')

  // ---------- taken away ----------
  const off = it(['service', 'uninstall', '--json'], 180_000)
  const gone = await until(
    async () => {
      const now = stands()
      return !now.registered && !now.running && !(await answers())
    },
    60_000,
    1000,
  )
  registered = !gone
  check(
    'taken away, the system has it no more, nothing of it runs, and its site answers nothing',
    off.code === 0 && Boolean(gone),
    `${off.said.slice(-600)}\nnow: ${JSON.stringify(stands())}`,
  )

  const whole = it(['uninstall', '--yes', '--json'], 180_000)
  const emptied = await until(() => !existsSync(home), 20_000, 500)
  check(
    'and It is taken off the machine whole, its folder with it',
    whole.code === 0 && whole.json?.removed === true && Boolean(emptied),
    whole.said.slice(-900),
  )
} finally {
  // Whatever became of the checks, nothing is left registered or running on the machine
  if (registered) it(['service', 'uninstall', '--json'], 180_000)
  if (windows) {
    // What the uninstall left Windows to run at the next sign-in, which never comes on a machine made for a run
    try {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'
      for (const [, name] of execFileSync('reg.exe', ['query', key], { encoding: 'utf8' }).matchAll(/^\s+(ItRemoved\d+)\s/gm))
        spawnSync('reg.exe', ['delete', key, '/v', name, '/f'])
    } catch {}
  }
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch {}
}
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed} of ${results.length} passed`)
process.exit(passed === results.length && results.length > 0 ? 0 : 1)
