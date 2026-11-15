// One rehearsal run, from the host: a fresh clean machine, the build under test served to it as
// It's releases, a real agent app signed in with a copy of the owner's access token, the agent's
// terminal and the person's browser recorded together, and the flow played by the person.
//
//   node e2e/rehearsal-linux/run.mjs --flow L1 --app claude|codex [--browser chromium|firefox]
//        [--ubuntu 24|22] [--from <image>] [--snapshot <image>] [--keep]
//
// Results go to $IT_REHEARSAL_RESULTS (default ~/it-rehearsal/2026-11-15-linux)/<run id>/.
// The build under test is the folder $IT_REHEARSAL_STAGE, made by stage.sh, mounted read-only.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { filesHolding, holdsToken, injectCodex, redact, shareWithUserManager, startAgentShell, take, wipe } from './secrets.mjs'
import { writeReport } from './report.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)
const flow = arg('flow', 'L1')
const app = arg('app', 'claude')
const which = arg('browser', 'chromium')
const ubuntu = arg('ubuntu', '24')
const from = arg('from', `it-rehearsal-ubuntu${ubuntu}:base`)
const snapshot = arg('snapshot')
const minutes = Number(arg('minutes', flow === 'L8' ? '150' : '90'))
const RESULTS = process.env.IT_REHEARSAL_RESULTS ?? join(homedir(), 'it-rehearsal', '2026-11-15-linux')
const STAGE = process.env.IT_REHEARSAL_STAGE
if (!STAGE || !existsSync(join(STAGE, 'BUILD.json'))) throw new Error('Set IT_REHEARSAL_STAGE to a folder made by stage.sh.')
const build = JSON.parse(readFileSync(join(STAGE, 'BUILD.json'), 'utf8'))

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const id = `${stamp}-${flow}-${app}-${which}-u${ubuntu}`.toLowerCase()
const name = `it-rehearsal-${id}`.replace(/[^a-z0-9-]/g, '-')
const dir = join(RESULTS, id)
mkdirSync(dir, { recursive: true })
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`)

function sh(args, { input, timeout = 120_000, quiet = false } = {}) {
  const r = spawnSync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8', input, timeout, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0 && !quiet) log(`docker ${args.slice(0, 3).join(' ')} … exited ${r.status}: ${(r.stderr ?? '').slice(0, 300)}`)
  return r
}
const exec = (cmd, opts = {}) => sh(['exec', name, 'bash', '-c', cmd], opts)
const asAna = (cmd, opts = {}) => sh(['exec', name, 'su', '-l', 'ana', '-c', cmd], opts)

function freeGB() {
  const s = statfsSync('/home')
  return (s.bavail * s.bsize) / 1e9
}

const result = {
  id,
  flow,
  app,
  browser: which,
  ubuntu: `${ubuntu}.04`,
  build: build.commit,
  buildVersion: build.version,
  start: new Date().toISOString(),
  end: null,
  ok: false,
  blame: null,
  reason: null,
  steps: [],
}

let held = null
async function main() {
  const free = freeGB()
  log(`free disk ${free.toFixed(1)} GB`)
  if (free < 12) throw Object.assign(new Error(`Only ${free.toFixed(1)} GB free under /home, below 12 GB.`), { blame: 'harness' })

  // ---- the machine ----
  log(`starting ${name} from ${from}`)
  const run = sh([
    'run', '-d', '--name', name, '--hostname', 'laptop',
    '--cgroupns=private', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined',
    '--tmpfs', '/run', '--tmpfs', '/run/lock', '--shm-size=1g', '-e', 'container=docker',
    '-v', `${STAGE}:/build:ro`, '-v', `${dir}:/results/${id}`,
    from, 'sh', '-c', 'mount -o remount,rw /sys/fs/cgroup && exec /sbin/init',
  ])
  if (run.status !== 0) throw Object.assign(new Error('the container did not start'), { blame: 'harness' })
  for (let i = 0; i < 60; i++) {
    const s = exec('systemctl is-system-running', { quiet: true }).stdout.trim()
    if (s === 'running' || s === 'degraded') break
    await new Promise((r) => setTimeout(r, 1000))
  }
  exec('systemctl is-active user@1000.service rehearsal-xvfb.service rehearsal-wm.service')
  exec('mkdir -p /opt/person-profile && chown ana:ana /opt/person-profile /results/' + id)
  // The one difference from a participant's machine: the install script and `it upgrade` fetch the
  // build under test from the stand-in, set in the machine's environment before the video starts
  exec("echo 'IT_INSTALL_BASE=http://127.0.0.1:8765' >> /etc/environment")
  result.installBase = 'IT_INSTALL_BASE=http://127.0.0.1:8765 in /etc/environment, before the video starts: the install script fetches the build under test from a stand-in for the releases inside the machine'
  exec('systemd-run --unit=rehearsal-releases --property=User=nobody node /build/harness/releases.mjs /build/bin 8765')
  result.appVersion = exec(app === 'claude' ? 'claude --version' : 'codex --version').stdout.trim()
  result.os = exec('. /etc/os-release; echo $PRETTY_NAME').stdout.trim()

  // ---- the sign-in, and the terminal ----
  if (flow !== 'L5' && flow !== 'L7') {
    const t = take(app, Math.min(minutes, 50))
    held = t.held
    result.tokenMinutesLeftAtStart = t.minutesLeft
    if (app === 'codex') await injectCodex(name, held)
  }
  await startAgentShell(name, app === 'claude' ? held : null, { IT_INSTALL_BASE: 'http://127.0.0.1:8765' })
  if (app === 'claude' && held && ['L2', 'L3', 'L8'].includes(flow)) await shareWithUserManager(name, held)
  asAna('tmux set -g status off; tmux set -g history-limit 50000')
  sh(['exec', '-d', name, 'su', '-l', 'ana', '-c', 'DISPLAY=:1 xterm -T rehearsal-terminal -fa "DejaVu Sans Mono" -fs 11 -bg white -fg black -geometry 104x56+0+0 -e tmux attach -t agent'])
  await new Promise((r) => setTimeout(r, 2500))

  // ---- the recording ----
  exec(`ffmpeg -nostdin -y -loglevel error -f x11grab -framerate 12 -video_size 1920x1080 -i :1 -vf scale=1600:-2 -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p /results/${id}/video.mp4 > /results/${id}/ffmpeg.log 2>&1 & echo $! > /run/rehearsal-ffmpeg.pid`)
  result.videoStart = new Date().toISOString()

  // ---- the flow ----
  log(`flow ${flow} with ${app} in ${which}`)
  await new Promise((resolve) => {
    const child = spawn('sudo', ['-n', 'docker', 'exec', name, 'su', '-l', 'ana', '-c', `cd ~/work 2>/dev/null || mkdir -p ~/work && cd ~/work; DISPLAY=:1 PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright node /build/harness/flow.mjs ${flow} ${app} ${which} /results/${id}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    const kill = setTimeout(() => {
      log('the flow ran past its time')
      exec("pkill -INT -f 'node /build/harness/flow.mjs' || true")
    }, minutes * 60_000)
    child.stdout.on('data', (d) => process.stdout.write(redact(d.toString(), held)))
    child.stderr.on('data', (d) => process.stdout.write(redact(d.toString(), held)))
    child.on('close', () => {
      clearTimeout(kill)
      resolve()
    })
  })
}

async function collect() {
  // The recording, stopped as ffmpeg finishes a file
  exec('kill -INT $(cat /run/rehearsal-ffmpeg.pid) 2>/dev/null; for i in $(seq 30); do kill -0 $(cat /run/rehearsal-ffmpeg.pid) 2>/dev/null || exit 0; sleep 1; done', { quiet: true })
  // It's own record, as It keeps it
  const itLog = asAna('cat ~/.it/logs/it.log 2>/dev/null', { quiet: true }).stdout
  const status = asAna('~/.it/bin/it status 2>&1', { quiet: true, timeout: 60_000 }).stdout
  const journal = exec('journalctl -u rehearsal-releases --no-pager -o cat 2>/dev/null | tail -200', { quiet: true }).stdout
  const userJournal = asAna('journalctl --user -u it.service --no-pager -o cat 2>/dev/null | tail -300', { quiet: true }).stdout
  // Every trace of the token out of the machine, before anything else is kept from it
  const left = await wipe(name, held)
  result.tokenFilesLeftAfterWipe = left.length
  if (left.length) log(`after the wipe ${left.length} file(s) still hold a token value: ${left.join(', ')}`)
  const keep = (file, text) => {
    const clean = redact(text, held)
    if (clean !== text) result.redacted = [...(result.redacted ?? []), file]
    writeFileSync(join(dir, file), clean)
  }
  keep('it.log', itLog)
  keep('it-status.txt', status)
  keep('releases-stand-in.log', journal)
  keep('it-service-journal.txt', userJournal)
  // The terminal the flow saved, scanned before it is kept
  const term = join(dir, 'terminal.txt')
  if (existsSync(term)) {
    const text = readFileSync(term, 'utf8')
    if (holdsToken(text, held)) {
      result.tokenShownInTerminal = true
      keep('terminal.txt', text)
      // The video showed what the terminal showed: it is not kept
      if (existsSync(join(dir, 'video.mp4'))) renameSync(join(dir, 'video.mp4'), join(dir, 'video.withheld'))
      spawnSync('shred', ['-u', join(dir, 'video.withheld')])
    }
    const model = /(?:Opus|Sonnet|Haiku|Fable)\s+[0-9.]+|model:\s*([a-z0-9.\-]+(?: (?:low|medium|high|xhigh))?)|gpt-[0-9][a-z0-9.\-]*/i.exec(text)
    if (model) result.model = (model[1] ?? model[0]).trim()
  }
  const steps = join(dir, 'steps.jsonl')
  if (existsSync(steps)) {
    const text = readFileSync(steps, 'utf8')
    keep('steps.jsonl', text)
    result.steps = redact(text, held)
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }
  const fj = join(dir, 'flow.json')
  if (existsSync(fj)) {
    const v = JSON.parse(redact(readFileSync(fj, 'utf8'), held))
    result.ok = !!v.ok
    result.reason = v.reason
    result.blame = v.blame
    result.parts = v.parts
    result.counts = v.counts
    result.approvalsDuringTour = v.approvalsDuringTour
    result.lastWords = v.lastWords
    result.observations = v.observations
  } else {
    result.reason ??= 'the flow wrote no verdict'
    result.blame ??= 'harness'
  }
}

let failure = null
try {
  await main()
} catch (err) {
  failure = err
  result.reason = String(err?.message ?? err)
  result.blame = err?.blame ?? 'harness'
  log(`run failed: ${result.reason}`)
}
try {
  await collect()
} catch (err) {
  log(`collecting failed: ${err?.message ?? err}`)
  await wipe(name, held).catch(() => {})
}
if (failure) {
  result.ok = false
  result.reason = String(failure?.message ?? failure)
  result.blame = failure?.blame ?? 'harness'
}
result.end = new Date().toISOString()
held = null
writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
if (snapshot && !failure) {
  log(`keeping the machine as ${snapshot}`)
  sh(['stop', '-t', '60', name], { timeout: 120_000 })
  sh(['commit', name, snapshot], { timeout: 600_000 })
}
if (!has('keep')) sh(['rm', '-f', name], { timeout: 120_000 })
writeReport(RESULTS)
log(`${result.ok ? 'PASS' : 'FAIL'} ${id}${result.reason ? `: ${result.reason}` : ''}`)
