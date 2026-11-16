// The rehearsal's guard, for runs under the owner's own Windows account. It stands where `it.exe`
// is (first on the PATH, and in place of the installed program once an agent has installed It),
// and passes every command on to the real It program (IT_REHEARSAL_REAL_IT) unchanged, with the
// same arguments, standard input and output, and exit status, except the few that would register
// a background service for the owner's account, ask the owner's own It to stop, or write the
// owner's registry:
//
// - `setup` or `login` without `--no-service` (but `setup --refresh`): with IT_REHEARSAL_GUARD=owner
//   they are refused; with IT_REHEARSAL_GUARD=convert, `--no-service` is added, and once setup has
//   run, `it serve` is started, which is the one thing the background service would have done for
//   a person on their own account. Both are written down in IT_REHEARSAL_GUARD_LOG.
// - `service install`, `service uninstall`, `upgrade` and `uninstall`: refused, except `upgrade`
//   where IT_REHEARSAL_ALLOW_UPGRADE=1 and It says no service is registered for this folder.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, openSync } from 'node:fs'
import path from 'node:path'

const real = process.env.IT_REHEARSAL_REAL_IT
const mode = process.env.IT_REHEARSAL_GUARD
const args = process.argv.slice(2)
const words = args.filter((a) => !a.startsWith('-'))
const flags = new Set(args.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]))
const cmd = words[0]
const note = (line: string) => {
  try {
    if (process.env.IT_REHEARSAL_GUARD_LOG) appendFileSync(process.env.IT_REHEARSAL_GUARD_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}
let refused: string | null = null
let convert = false
if (mode === 'owner' || mode === 'convert') {
  if ((cmd === 'setup' || cmd === 'login') && !flags.has('--no-service') && !flags.has('--refresh') && !flags.has('--help')) {
    if (mode === 'convert') convert = true
    else refused = `${cmd} without --no-service`
  } else if (cmd === 'service' && words[1] === 'install') {
    // In convert mode `it serve` already runs, as the service would: what It says of the service is given
    if (mode === 'convert') {
      note('converted: it service install → it service status (it serve already runs, started by the harness)')
      const s = spawnSync(real as string, ['service', 'status', ...args.filter((a) => a.startsWith('--json'))], { stdio: 'inherit', windowsHide: false })
      process.exit(s.status ?? 0)
    }
    refused = 'service install'
  } else if (cmd === 'service' && words[1] === 'uninstall') refused = 'service uninstall'
  else if (cmd === 'upgrade' && !flags.has('--check')) {
    // Only in a run that tests an update, and only once It itself says that no service is
    // registered for this folder, so that the update restarts no task of the owner's
    let mine: boolean | null = null
    if (process.env.IT_REHEARSAL_ALLOW_UPGRADE === '1') {
      const s = spawnSync(real as string, ['service', 'status', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 90_000 })
      try {
        const st = JSON.parse(s.stdout)
        mine = st && typeof st === 'object' && (st.installed === false || st.registered === false) ? false : null
      } catch {}
    }
    if (mine === false) note('passed: it upgrade (It says no service is registered for this folder)')
    else refused = 'upgrade'
  }
  else if (cmd === 'uninstall') refused = 'uninstall'
}
if (refused) {
  note(`refused: it ${args.join(' ').slice(0, 300)}`)
  process.stderr.write(
    `${JSON.stringify({ error: { code: 'rehearsal_guard', message: `This rehearsal does not let \`it ${refused}\` run under the owner's Windows account, since it would touch the owner's own It.` } })}\n`,
  )
  process.exit(64)
}
if (!real) {
  process.stderr.write('IT_REHEARSAL_REAL_IT is not set\n')
  process.exit(70)
}
if (!convert) {
  const r = spawnSync(real, args, { stdio: 'inherit', windowsHide: false })
  process.exit(r.status ?? 1)
}
note(`converted: it ${args.join(' ').slice(0, 300)} → with --no-service, then it serve`)
const r = spawnSync(real, [...args, '--no-service'], { stdio: 'inherit', windowsHide: false })
// What the background service would have done at once: It runs
const running = () => {
  const s = spawnSync(real, ['status', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 90_000 })
  try {
    return JSON.parse(s.stdout).running === true
  } catch {
    return false
  }
}
if (!running()) {
  const logFile = process.env.IT_REHEARSAL_SERVE_LOG
  const out = logFile ? openSync(logFile, 'a') : 'ignore'
  // With IT_REHEARSAL_LAUNCHER_PATH=1 (arun --launcher-path), `it serve` gets the PATH of the shell
  // that ran setup without this guard's own folder, which holds an `it.exe`: the PATH a real
  // service's launcher would hold, where no guard exists
  const env = { ...process.env }
  if (process.env.IT_REHEARSAL_LAUNCHER_PATH === '1') {
    const own = path.dirname(process.execPath).toLowerCase()
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') env[k] = String(env[k]).split(';').filter((d) => d && path.resolve(d).toLowerCase() !== own).join(';')
  }
  const serve = spawn(real, ['serve'], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env })
  note(`started it serve (pid ${serve.pid})`)
  if (process.env.IT_REHEARSAL_SERVE_PIDS)
    try {
      appendFileSync(process.env.IT_REHEARSAL_SERVE_PIDS, `${serve.pid}\n`)
    } catch {}
  serve.unref()
  for (let i = 0; i < 40 && !running(); i++) spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep 2'], { windowsHide: true })
  note(`it serve is ${running() ? 'running' : 'NOT running'}`)
}
process.exit(r.status ?? 1)
