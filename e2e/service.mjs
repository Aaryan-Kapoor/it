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
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { holdBase } from '../packages/cli/test-ports.ts'

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
const heldPorts = await holdBase(Number(process.env.IT_PORT ?? 27_000), process.env.IT_PORT ? 1 : 20)
const port = heldPorts.base
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
        "$ProgressPreference = 'SilentlyContinue'; Get-ScheduledTask -TaskPath '\\' -TaskName ('it-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) | Get-ScheduledTaskInfo | Format-List LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns; Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(it|it-windows-x64|convex-local-backend|conhost|cmd)' } | Select-Object ProcessId, ParentProcessId, Name, CommandLine | Format-Table -AutoSize -Wrap | Out-String -Width 220",
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

  // ---------- on Windows, stopped and started again from Task Scheduler ----------
  // Told to stop a task, Task Scheduler ends only the console its launcher runs in. The service
  // sees that and stops, as it does when it is asked to, and its launcher ends with it: started
  // again, the task starts one launcher and one service, and nothing is left of the first.
  if (windows) {
    const task = "Get-ScheduledTask -TaskPath '\\' -TaskName ('it-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)"
    const ps = (script) =>
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; ${script}`],
        {
          encoding: 'utf8',
          timeout: 120_000,
          windowsHide: true,
        },
      )
    /** It's processes on the runner: each launcher, by the file it runs, and the service and the backend program, by It's folder in their command lines. */
    const ours = () => {
      const ran = ps(
        // The question's own PowerShell has both in its command line, and is left out
        `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine -like '*it-service.cmd*' -or $_.CommandLine.Contains('${home.replace(/'/g, "''")}')) } | ForEach-Object { $_.Name + ' ' + $_.CommandLine }`,
      )
      // A question that failed says nothing of what runs, and is never taken for nothing running
      if (ran.status !== 0) return [`the processes could not be listed: ${ran.error?.code ?? `exit ${ran.status}`} ${(ran.stderr ?? '').trim().slice(0, 300)}`]
      return (ran.stdout ?? '').split(/\r?\n/).filter((line) => line.trim())
    }
    const stopped = ps(`${task} | Stop-ScheduledTask`)
    const quiet = await until(async () => !(await answers()) && ours().length === 0, 90_000, 1000)
    check(
      'stopped from Task Scheduler, It stops: its launcher, the service and the backend program all end, and its site answers nothing',
      stopped.status === 0 && Boolean(quiet),
      `${stopped.stderr ?? ''}\nstill running:\n${ours().join('\n')}`,
    )
    if (!quiet) why('after the task was stopped from Task Scheduler')
    const started = ps(`${task} | Start-ScheduledTask`)
    const back = await until(async () => (await answers()) && stands().running, 240_000, 2000)
    // A second launcher, where there was one, would be running by now beside the first
    await sleep(10_000)
    const running = ours()
    const launchers = running.filter((line) => /^cmd\.exe /i.test(line)).length
    const services = running.filter((line) => / serve --supervised /.test(line) && !/^(cmd|conhost)\.exe /i.test(line)).length
    check(
      'started again from Task Scheduler, exactly one launcher and one service run, and its site answers',
      started.status === 0 && Boolean(back) && launchers === 1 && services === 1 && (await answers()),
      `${started.stderr ?? ''}\n${running.join('\n')}`,
    )
    if (!back || launchers !== 1 || services !== 1) why('after the task was started again from Task Scheduler')
  }

  // ---------- a second setup, which is what an update runs ----------
  const second = it(['setup', '--none', '--json'])
  const still = await until(async () => (await answers()) && stands().running, 180_000, 2000)
  check(
    'a second setup, which is what an update runs over a service that is running, ends well and leaves it running',
    second.code === 0 && second.json?.service?.registered === true && Boolean(still),
    `${second.said.slice(-600)}\nnow: ${JSON.stringify(stands())}`,
  )
  if (!(second.code === 0 && second.json?.service?.registered === true && still)) why('after the second setup')

  // A permanent startup failure must stop retries under the real supervisor too. No database
  // is touched: only the settings file is made unreadable, and its exact bytes are restored.
  const settings = path.join(home, 'service.json')
  const savedSettings = readFileSync(settings)
  const beforeFailure = it(['service', 'uninstall', '--json'], 180_000)
  if (beforeFailure.code === 0) {
    try {
      writeFileSync(settings, '{not settings')
      const failedStart = it(['service', 'install', '--json'])
      const paused = await until(() => {
        try {
          return JSON.parse(readFileSync(path.join(home, 'startup.json'), 'utf8')).retryAt === null
        } catch {
          return false
        }
      }, 60_000)
      await sleep(7000)
      const afterFailure = it(['service', 'status', '--json']).json
      check(
        'a permanent startup failure stops automatic attempts and reports how to retry',
        failedStart.code === 0 && paused && afterFailure?.startup?.paused === true && afterFailure.startup.failures === 1 && !(await answers()),
        JSON.stringify(afterFailure),
      )
    } finally {
      writeFileSync(settings, savedSettings)
    }
    const retried = it(['service', 'install', '--json'])
    const recovered = await until(async () => (await answers()) && stands().running, 180_000, 2000)
    check(
      'an explicit retry starts the repaired service and clears its startup failure',
      retried.code === 0 && recovered && !existsSync(path.join(home, 'startup.json')),
      retried.said.slice(-600),
    )
  } else check('the service stops before a permanent startup failure is tested', false, beforeFailure.said.slice(-600))

  const macDefinition = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.it.plist') : null
  const savedDefinition = macDefinition ? readFileSync(macDefinition, 'utf8') : null

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

  // A real launchd job deliberately takes five seconds to stop. Replacing it exercises the
  // unload boundary on macOS; the tests with a stand-in separately force several print polls.
  if (macDefinition && savedDefinition && gone) {
    const slow = path.join(home, 'slow-stop.mjs')
    const ready = path.join(home, 'slow-ready')
    const stopped = path.join(home, 'slow-stopped')
    writeFileSync(
      slow,
      `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(ready)}, String(process.pid))
const keep = setInterval(() => {}, 1000)
process.once('SIGTERM', () => {
  clearInterval(keep)
  setTimeout(() => { writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0) }, 5000)
})
`,
    )
    const xml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    writeFileSync(
      macDefinition,
      savedDefinition.replace(
        /<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/,
        `<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(slow)}</string><string>--log</string><string>${xml(path.join(home, 'logs', 'it.log'))}</string></array>`,
      ),
    )
    registered = true
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, macDefinition], { timeout: 30_000 })
    const started = await until(() => existsSync(ready), 20_000, 100)
    const began = Date.now()
    const replacement = it(['service', 'install', '--json'])
    const took = Date.now() - began
    const back = await until(async () => (await answers()) && stands().running, 180_000, 2000)
    check(
      'launchd finishes a deliberately slow stop before the replacement starts',
      started && replacement.code === 0 && took >= 5000 && existsSync(stopped) && back,
      replacement.said.slice(-600),
    )
    const removed = it(['service', 'uninstall', '--json'], 180_000)
    registered = removed.code !== 0
    check('the replacement is removed after the slow-stop check', !registered, removed.said.slice(-600))
    // The fixture removes its own files before uninstall checks that the installation is empty.
    // Unknown files at the top of It's folder are deliberately kept by uninstall.
    if (!registered) for (const file of [slow, ready, stopped]) rmSync(file, { force: true })
  }

  // ---------- on a Mac, a load that launchd refuses, and an account launchd has no domain for ----------
  // The real launchd is told to keep It's label switched off, as Login Items or a tool that
  // manages what starts on the Mac leaves it. Setup is then run so that it registers the
  // service, with no agent app looked for: launchd refuses, and setup is to say why with what
  // turns it on, and to count nothing as registered. Switched on again, the same setup registers it.
  if (macDefinition && !registered) {
    const target = `gui/${process.getuid()}/dev.it`
    const launchctl = (...words) => {
      const ran = spawnSync('launchctl', words, { encoding: 'utf8', timeout: 60_000 })
      return { code: ran.status, said: `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim() }
    }
    const registering = (more = {}) => {
      const ran = spawnSync(program, ['setup', '--yes', '--json'], { env: { ...env, IT_HARNESSES: 'none', ...more }, encoding: 'utf8', timeout: 600_000 })
      let json
      try {
        json = JSON.parse((ran.stdout ?? '').slice((ran.stdout ?? '').indexOf('{')))
      } catch {}
      return { code: ran.status, json, said: `${ran.stdout ?? ''}${ran.stderr ?? ''}` }
    }
    const off = launchctl('disable', target)
    let on = { code: null, said: 'it was never switched on again' }
    try {
      const listed = launchctl('print-disabled', `gui/${process.getuid()}`)
      console.log(
        `macOS ${spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim()} lists the label as:${listed.said.split('\n').find((line) => line.includes('"dev.it"')) ?? ' (no line)'}`,
      )
      const refused = registering({ IT_HARNESS: 'pi', IT_SESSION: 'a-conversation' })
      registered = existsSync(macDefinition)
      const problem = String(refused.json?.problem ?? '')
      check(
        'with its label switched off in launchd, setup says that macOS has the service switched off and what turns it on, and not what launchctl printed',
        off.code === 0 &&
          refused.code === 1 &&
          refused.json?.service?.registered === false &&
          problem.includes('macOS has It’s background service switched off') &&
          problem.includes(`launchctl enable ${target}`) &&
          !refused.said.includes('Input/output error'),
        `${off.said}\n${refused.said.slice(-1200)}`,
      )
      check(
        'and an agent that led that setup is told to pass the reason on, and not to start `it serve` itself',
        refused.said.includes('Do not start `it serve` yourself') &&
          !refused.said.includes('Run `it serve`') &&
          String(refused.json?.tell ?? '').includes(problem),
        refused.said.slice(-1200),
      )
      const after = it(['service', 'status', '--json'], 60_000).json ?? {}
      check(
        'the definition launchd refused is kept and is no registration: the service is said not to be registered, and nothing of it runs',
        existsSync(macDefinition) && after.registered === false && after.state === 'disabled' && after.running === false && !(await answers()),
        JSON.stringify(after),
      )
      const again = it(['service', 'install', '--json'], 180_000)
      check(
        '`it service install` says the same of it',
        again.code === 1 && again.said.includes('macOS has It’s background service switched off') && !again.said.includes('Input/output error'),
        again.said.slice(-600),
      )
    } finally {
      on = launchctl('enable', target)
    }
    const loaded = registering()
    registered = existsSync(macDefinition)
    const up = await until(async () => (await answers()) && stands().running, 180_000, 2000)
    check(
      'switched on again with `launchctl enable`, the same setup registers the service, and launchd runs it',
      on.code === 0 && loaded.code === 0 && loaded.json?.service?.registered === true && Boolean(up) && stands().registered,
      `${on.said}\n${loaded.said.slice(-900)}\nnow: ${JSON.stringify(stands())}`,
    )
    if (!up) why('after the label was switched on again')
    const removed = it(['service', 'uninstall', '--json'], 180_000)
    registered = removed.code !== 0
    check('and it is taken away again', !registered && !existsSync(macDefinition), removed.said.slice(-600))

    // An account with no login at the Mac's own screen has no domain in launchd to load an
    // agent into, which is how a Mac reached only over SSH stands. Setup is run as such an
    // account, made for this and taken away after: nothing can be loaded, the definition is
    // kept for the next login, and that is a registration, said as it was said before.
    const account = 'itnologin'
    const sudo = (...words) => {
      const ran = spawnSync('sudo', ['-n', ...words], { encoding: 'utf8', timeout: 600_000 })
      return { code: ran.status, out: ran.stdout ?? '', said: `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim() }
    }
    const made = sudo('sysadminctl', '-addUser', account, '-password', `${randomBytes(18).toString('base64url')}aA1!`)
    const uid = spawnSync('id', ['-u', account], { encoding: 'utf8' }).stdout.trim()
    if (made.code !== 0 || !/^\d+$/.test(uid)) {
      // Only a machine made for the run lets an account be made without asking: said, and counted where CI is one
      console.log(`  ----  an account with no login at the screen could not be made here, so that case was not tried: ${made.said.slice(-300)}`)
      if (process.env.CI) check('an account with no login at the screen is made for the run', false, made.said.slice(-600))
    } else {
      const shared = mkdtempSync(path.join('/tmp', 'it-no-login-'))
      try {
        // The program keeps a lock beside its own file, so the account is given a copy in a folder of its own
        const handed = path.join(shared, 'it')
        writeFileSync(handed, readFileSync(program), { mode: 0o755 })
        spawnSync('chmod', ['755', shared, handed])
        const theirs = sudo('-u', account, '-H', 'sh', '-c', 'echo "$HOME"').out.trim()
        const copy = `${theirs}/it-program/it`
        sudo('-u', account, '-H', 'mkdir', '-p', `${theirs}/it-program`)
        const copied = sudo('-u', account, '-H', 'cp', handed, copy)
        if (copied.code !== 0) console.log(`  ----  the program could not be handed to the account: ${copied.said.slice(-300)}`)
        const as = (words, forMs = 600_000) => {
          const ran = spawnSync(
            'sudo',
            ['-n', '-u', account, '-H', 'env', `IT_HOME=${theirs}/.it`, `IT_PORT=${port}`, 'IT_TELEMETRY_ENABLED=false', 'CI=1', copy, ...words],
            { encoding: 'utf8', timeout: forMs, cwd: shared },
          )
          let json
          try {
            json = JSON.parse((ran.stdout ?? '').slice((ran.stdout ?? '').indexOf('{')))
          } catch {}
          return { code: ran.status, json, said: `${ran.stdout ?? ''}${ran.stderr ?? ''}` }
        }
        const asked = sudo('-u', account, '-H', 'launchctl', 'print', `gui/${uid}/dev.it`)
        console.log(`launchd, asked of an account with no login at the screen: exit ${asked.code}, ${asked.said.split('\n').join(' / ')}`)
        const alone = as(['setup', '--none', '--json'])
        const kept = sudo('-u', account, '-H', 'test', '-f', `${theirs}/Library/LaunchAgents/dev.it.plist`).code === 0
        const stood = as(['service', 'status', '--json'], 60_000).json ?? {}
        check(
          'for an account with no login at the screen, as over SSH, setup says the service could not be registered and keeps its definition for the next login, which is a registration',
          alone.code === 1 &&
            String(alone.json?.problem ?? '').startsWith('It could not be registered as a background service') &&
            !String(alone.json?.problem ?? '').includes('switched off') &&
            kept &&
            stood.registered === true &&
            stood.state === 'not loaded',
          `${alone.said.slice(-900)}\nstatus: ${JSON.stringify(stood)}`,
        )
        const out = as(['uninstall', '--yes', '--json'], 180_000)
        check('and that account’s It is taken off again whole', out.code === 0 && out.json?.removed === true, out.said.slice(-600))
      } finally {
        const gone = sudo('sysadminctl', '-deleteUser', account)
        if (gone.code !== 0) console.log(`  ----  the account made for the run could not be taken away: ${gone.said.slice(-300)}`)
        rmSync(shared, { recursive: true, force: true })
      }
    }
  }

  const whole = it(['uninstall', '--yes', '--json'], 180_000)
  const emptied = await until(() => !existsSync(home), 20_000, 500)
  check(
    'and It is taken off the machine whole, its folder with it',
    whole.code === 0 && whole.json?.removed === true && Boolean(emptied),
    whole.said.slice(-900),
  )
} finally {
  // Whatever became of the checks, nothing is left registered or running on the machine
  const cleanup = registered ? it(['service', 'uninstall', '--json'], 180_000) : null
  const stopped = !cleanup || cleanup.code === 0
  if (!stopped) check('the test service is stopped during cleanup', false, cleanup.said.slice(-600))
  if (windows) {
    // What the uninstall left Windows to run at the next sign-in, which never comes on a machine made for a run
    try {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'
      for (const [, name] of execFileSync('reg.exe', ['query', key], { encoding: 'utf8' }).matchAll(/^\s+(ItRemoved\d+)\s/gm))
        spawnSync('reg.exe', ['delete', key, '/v', name, '/f'])
    } catch {}
  }
  try {
    if (stopped) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch {}
  await heldPorts.release()
}
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed} of ${results.length} passed`)
process.exit(passed === results.length && results.length > 0 ? 0 : 1)
