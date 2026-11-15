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
import { filesHolding, holdsToken, injectClaudeFile, injectClaudeTokenInProfile, injectCodex, redact, shareWithUserManager, startAgentShell, take, wipe } from './secrets.mjs'
import { writeReport } from './report.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)
const flow = arg('scenario', arg('flow', 'S1'))
const person = arg('person', 'model')
const app = arg('app', 'claude')
const which = arg('browser', 'chromium')
const ubuntu = arg('ubuntu', '24')
const from = arg('from', `it-rehearsal-ubuntu${ubuntu}:base`)
const snapshot = arg('snapshot')
const minutes = Number(arg('minutes', '45'))
// The released It from its real site and release, as a participant gets it: no stand-in, no IT_INSTALL_BASE
// A machine set up exactly as a participant's, for Auto-wake: the released It, nothing put into the
// user manager's environment, Claude Code's sign-in in its own file alone (no variable in the
// terminal), and lingering left to what `it setup` itself does
const participant = has('participant')
const released = has('released') || participant
const BASE_ENV = released ? {} : { IT_INSTALL_BASE: 'http://127.0.0.1:8765' }
const RUNS = process.env.IT_REHEARSAL_RUNS ?? '/tmp/it-rehearsal-runs'
const RESULTS = process.env.IT_REHEARSAL_RESULTS ?? join(homedir(), 'it-rehearsal', '2026-11-15-linux')
const STAGE = process.env.IT_REHEARSAL_STAGE
if (!STAGE || !existsSync(join(STAGE, 'BUILD.json'))) throw new Error('Set IT_REHEARSAL_STAGE to a folder made by stage.sh.')
const build = JSON.parse(readFileSync(join(STAGE, 'BUILD.json'), 'utf8'))

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const id = `${stamp}-${flow}-${app}-${which}-u${ubuntu}`.toLowerCase()
const runHere = join(RUNS, id)
mkdirSync(runHere, { recursive: true })
const name = `it-rehearsal-${id}`.replace(/[^a-z0-9-]/g, '-')
const dir = join(RESULTS, id)
const FLOW = '/var/lib/rehearsal-flow'
const MODEL = { codex: { model: 'gpt-6.1-sol', effort: 'high' }, claude: { model: 'claude-sonnet-5-5', effort: 'high' } }
mkdirSync(dir, { recursive: true })
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`)

function sh(args, { input, timeout = 120_000, quiet = false } = {}) {
  const r = spawnSync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8', input, timeout, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0 && !quiet) log(`docker ${args.slice(0, 3).join(' ')} … exited ${r.status}: ${redact(r.stderr ?? '', held).slice(0, 300)}`)
  return r
}
const exec = (cmd, opts = {}) => sh(['exec', name, 'bash', '-c', cmd], opts)
// Always bash for the harness's own commands, whatever login shell the person has
const asAna = (cmd, opts = {}) => sh(['exec', name, 'su', '-l', 'ana', '-s', '/bin/bash', '-c', cmd], opts)

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
  build: released ? `released ${build.version}${arg('installed') ? `; ${arg('installed')}` : ''}` : arg('installed') ? `${arg('installed')} (installed in the snapshot ${from}); stand-in serves ${build.commit}` : build.commit,
  harness: build.harness,
  buildVersion: build.version,
  person: person === 'model' ? 'Claude Opus 5.5 at high effort, looking at the screen' : 'a script',
  start: new Date().toISOString(),
  end: null,
  ok: false,
  blame: null,
  reason: null,
  steps: [],
}

let held = null
let refresher = null
let refreshing = false
async function main() {
  const free = freeGB()
  log(`free disk ${free.toFixed(1)} GB`)
  if (free < 12) throw Object.assign(new Error(`Only ${free.toFixed(1)} GB free under /home, below 12 GB.`), { blame: 'harness' })

  // ---- the machine ----
  log(`starting ${name} from ${from}`)
  const run = sh([
    'run', '-d', '--name', name, '--hostname', 'laptop',
    // systemd needs a cgroup tree it can write (SYS_ADMIN, to remount its own namespace's), and the
    // system's bubblewrap, which Codex's sandbox uses, needs to make namespaces and mount a /proc
    // of its own, as on a laptop: so AppArmor, seccomp and Docker's masking of /proc are lifted.
    // No device, no other capability, and nothing of the host's but the build, read-only.
    '--cgroupns=private', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined',
    '--security-opt', 'seccomp=unconfined', '--security-opt', 'systempaths=unconfined',
    // Scenario 11 alone shapes the machine's own network with tc
    ...(has('net-admin') ? ['--cap-add', 'NET_ADMIN'] : []),
    '--tmpfs', '/run', '--tmpfs', '/run/lock', '--shm-size=1g', '-e', 'container=docker',
    '-v', `${STAGE}:/build:ro`,
    from, 'sh', '-c', 'mount -o remount,rw /sys/fs/cgroup && exec /sbin/init',
  ])
  if (run.status !== 0) throw Object.assign(new Error('the container did not start'), { blame: 'harness' })
  for (let i = 0; i < 60; i++) {
    const s = exec('systemctl is-system-running', { quiet: true }).stdout.trim()
    if (s === 'running' || s === 'degraded') break
    await new Promise((r) => setTimeout(r, 1000))
  }
  exec('systemctl is-active user@1000.service rehearsal-xvfb.service rehearsal-wm.service')
  // Nothing of the host's results folder is in the machine: ana has the owner's uid, so a folder
  // mounted for her would be one an agent could write into. The flow writes here, the recording
  // goes to a folder only root can enter, and both are copied out and scanned afterwards.
  exec(`mkdir -p /opt/person-profile ${FLOW} && chown ana:ana /opt/person-profile ${FLOW} && mkdir -p -m 700 /var/lib/rehearsal-video`)
  // The one difference from a participant's machine: the install script and `it upgrade` fetch the
  // build under test from the stand-in, set in the machine's environment before the video starts
  if (released) result.installBase = 'none: the real https://itcan.do and the real GitHub release, as a participant has them'
  else {
    exec("echo 'IT_INSTALL_BASE=http://127.0.0.1:8765' >> /etc/environment")
    result.installBase = 'IT_INSTALL_BASE=http://127.0.0.1:8765 in /etc/environment, before the video starts: the install script fetches the build under test from a stand-in for the releases inside the machine'
    exec('systemd-run --unit=rehearsal-releases --property=User=nobody node /build/harness/releases.mjs /build/bin 8765')
  }
  result.appVersion = exec(app === 'claude' ? 'claude --version' : 'codex --version').stdout.trim()
  result.os = exec('. /etc/os-release; echo $PRETTY_NAME').stdout.trim()

  // ---- the agent app, as a participant who chose its model would have it ----
  // Set in ana's own settings, keeping what is there (on a machine from a snapshot, what
  // `it setup` wrote to turn It's add-on on)
  asAna(`node /build/harness/settings.mjs ${app} ${MODEL[app].model} ${MODEL[app].effort}`)
  if (app === 'claude') {
    // Claude Code 2.1.325 shows "Medium effort" with effortLevel in its settings alone, and takes
    // the variable: in ana's own shell, and in her user manager for a conversation It reopens
    asAna(`grep -q CLAUDE_CODE_EFFORT_LEVEL ~/.bashrc || printf '\\nexport CLAUDE_CODE_EFFORT_LEVEL=${MODEL.claude.effort}\\n' >> ~/.bashrc${participant ? '' : `; systemctl --user set-environment CLAUDE_CODE_EFFORT_LEVEL=${MODEL.claude.effort}`}`)
  }
  // The owner's ChatGPT account has apps of its own (one named it_dot_test among them), which
  // Codex offers its model as tools; a participant's account has none of those
  if (app === 'codex') result.codexAppsOff = 'features.apps = false in ~/.codex/config.toml, so that the ChatGPT apps on the owner\'s account are not offered to the model'
  result.modelSetting = { ...MODEL[app], where: app === 'codex' ? '~/.codex/config.toml' : '~/.claude/settings.json, and CLAUDE_CODE_EFFORT_LEVEL in ~/.bashrc and the user manager' }
  asAna('mkdir -p ~/work')

  // ---- the sign-in, and the terminal ----
  {
    const t = take(app, Math.min(minutes + 5, 55))
    held = t.held
    result.tokenMinutesLeftAtStart = t.minutesLeft
    if (app === 'codex') await injectCodex(name, held)
    // Scenario 13: Codex signed in beside Claude Code, with its own copy; both copies' values are
    // looked for and redacted, and the wipe takes Codex's file as it always does
    if (app === 'claude' && has('also-codex')) {
      const c = take('codex', Math.min(minutes + 5, 55))
      await injectCodex(name, c.held)
      asAna(`node /build/harness/settings.mjs codex ${MODEL.codex.model} ${MODEL.codex.effort}`)
      held = { ...held, values: [...held.values, ...c.held.values] }
      result.alsoCodex = { model: MODEL.codex, tokenMinutesLeftAtStart: c.minutesLeft }
    }
  }
  await startAgentShell(name, app === 'claude' && !participant ? held : null, BASE_ENV)
  // A laptop keeps Claude Code's sign-in on its disk, so a conversation It reopens by itself is
  // signed in too. Here the token is in memory alone: ana's user manager is given the variable, and
  // an It already running (on a machine from a snapshot) is started again to take it, all before
  // the video starts
  if (participant) {
    // Lingering as a participant's account has it before It: off, until `it setup` turns it on
    exec('rm -f /var/lib/systemd/linger/ana')
    if (app === 'claude' && has('claude-token-in-profile')) {
      await injectClaudeTokenInProfile(name, held)
      result.claudeSignIn = 'CLAUDE_CODE_OAUTH_TOKEN exported in ~/.bashrc alone (mode 600), no credentials file'
    } else if (app === 'claude') await injectClaudeFile(name, held)
    result.participant = 'released It from itcan.do; the service as it setup registers it; no variable put into the user manager; Claude Code signed in by its own ~/.claude/.credentials.json alone; Codex by its own ~/.codex/auth.json; lingering removed before setup'
  }
  if (app === 'claude' && held && !participant) {
    await shareWithUserManager(name, held)
    // It starts a reopened conversation without the terminal's CLAUDE_* variables, so a run that
    // needs Auto-wake gives Claude Code its sign-in as a laptop keeps it, in its own file
    if (has('claude-file')) {
      await injectClaudeFile(name, held)
      result.claudeFile = '~/.claude/.credentials.json, the access token alone (refresh token blank), mode 600, shredded at the end'
    }
    // A run longer than the token lives (the night's soak): when the owner's own Claude Code has a
    // newer access token, the machine is given a copy of it the same way, into the same file and the
    // user manager, and its value joins those the run looks for and redacts. Never a refresh token.
    if (has('claude-file') && has('follow-claude-token')) {
      result.claudeTokenFollowed = 0
      let delivered = held.token
      refresher = setInterval(async () => {
        if (refreshing || !held) return
        refreshing = true
        try {
          const t = take('claude', 30)
          if (t.held.token !== delivered) {
            // Looked for and redacted from the moment it is read, delivered or not
            for (const v of t.held.values) if (!held.values.includes(v)) held.values.push(v)
            const next = { ...held, token: t.held.token, json: t.held.json }
            await injectClaudeFile(name, next)
            await shareWithUserManager(name, next)
            held.token = next.token
            held.json = next.json
            delivered = next.token
            result.claudeTokenFollowed++
            log(`gave the machine the owner's newer Claude Code access token (${t.minutesLeft} minutes)`)
          }
        } catch {
          // An older token is kept until a newer one is there; the error names no part of a token
        } finally {
          refreshing = false
        }
      }, 5 * 60_000)
    }
    if (!from.endsWith(':base')) asAna('systemctl --user restart it.service', { quiet: true, timeout: 180_000 })
  }
  // The state the scenario wants the machine in, after anything above that starts It again
  if (has('prepare')) result.prepared = exec(arg('prepare')).status
  asAna('tmux set -g status off; tmux set -g history-limit 50000')
  // What the terminal shows, kept every few seconds where it changed: an app that clears the
  // screen as it leaves takes its scrollback with it
  exec(`nohup su ana -c 'p=""; while sleep 4; do c=$(tmux capture-pane -p -J -t agent 2>/dev/null) || continue; [ "$c" = "$p" ] && continue; printf "=== %s\\n%s\\n" "$(date -u +%T)" "$c" >> ${FLOW}/screens.txt; p="$c"; done' >/dev/null 2>&1 &`)
  // The person's desktop: a terminal on the left, open and empty, and the web browser on the right
  sh(['exec', '-d', name, 'su', '-l', 'ana', '-s', '/bin/bash', '-c', 'DISPLAY=:1 xfce4-terminal --disable-server --hide-menubar --hide-toolbar --hide-scrollbar --title=Terminal --font="DejaVu Sans Mono 11" --geometry=104x54+0+0 -x tmux attach -t agent'])
  await new Promise((r) => setTimeout(r, 2500))
  exec(`install -m 755 /build/harness/${which === 'firefox' ? 'firefox' : 'browser'}.sh /usr/local/bin/browser`)
  if (person === 'script') exec('touch /etc/rehearsal-cdp')
  if (has('fake-media')) exec('touch /etc/rehearsal-fake-media')
  sh(['exec', '-d', name, 'su', '-l', 'ana', '-s', '/bin/bash', '-c', 'DISPLAY=:1 browser about:blank'])
  // The windows placed side by side, twice, since a browser's window may come up late
  for (const wait of [5000, 6000]) {
    await new Promise((r) => setTimeout(r, wait))
    exec(`DISPLAY=:1 su ana -c 'wmctrl -r Terminal -e 0,0,0,960,1080; for w in Chromium Firefox Nightly; do wmctrl -r "$w" -b remove,maximized_vert,maximized_horz; wmctrl -r "$w" -e 0,960,0,960,1080; done; wmctrl -a Terminal'`, { quiet: true })
  }

  // ---- the recording ----
  exec(`ffmpeg -nostdin -y -loglevel error -f x11grab -framerate 12 -video_size 1920x1080 -i :1 -vf scale=1600:-2 -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p /var/lib/rehearsal-video/video.mp4 > /var/lib/rehearsal-video/ffmpeg.log 2>&1 & echo $! > /run/rehearsal-ffmpeg.pid`)
  result.videoStart = new Date().toISOString()

  if (flow === 'S7') {
    // The machine restarted as a reboot: everything stops as systemd stops it, and comes back
    log('rebooting the machine')
    await new Promise((r) => setTimeout(r, 20_000))
    exec('kill -INT $(cat /run/rehearsal-ffmpeg.pid) 2>/dev/null; sleep 3')
    sh(['cp', `${name}:/var/lib/rehearsal-video/video.mp4`, join(runHere, 'before-reboot.mp4')], { timeout: 300_000 })
    sh(['restart', '-t', '90', name], { timeout: 240_000 })
    for (let i = 0; i < 60; i++) {
      const st = exec('systemctl is-system-running', { quiet: true }).stdout.trim()
      if (st === 'running' || st === 'degraded') break
      await new Promise((r) => setTimeout(r, 1000))
    }
    result.serviceAfterBootBeforeLogin = asAna('systemctl --user is-active it.service', { quiet: true }).stdout.trim()
    if (!released) exec('systemctl start rehearsal-releases 2>/dev/null || systemd-run --unit=rehearsal-releases --property=User=nobody node /build/harness/releases.mjs /build/bin 8765', { quiet: true })
    exec('mkdir -p /var/lib/rehearsal-flow /opt/person-profile && chown ana:ana /var/lib/rehearsal-flow && touch /etc/rehearsal-cdp && install -m 755 /build/harness/browser.sh /usr/local/bin/browser')
    // The person signs in again: their session, their terminal and their browser
    await startAgentShell(name, app === 'claude' ? held : null, BASE_ENV)
    if (app === 'claude' && held) {
      await shareWithUserManager(name, held)
      asAna('systemctl --user restart it.service', { quiet: true, timeout: 180_000 })
    }
    asAna('tmux set -g status off')
    exec(`nohup su ana -c 'p=""; while sleep 4; do c=$(tmux capture-pane -p -J -t agent 2>/dev/null) || continue; [ "$c" = "$p" ] && continue; printf "=== %s\\n%s\\n" "$(date -u +%T)" "$c" >> ${FLOW}/screens.txt; p="$c"; done' >/dev/null 2>&1 &`)
    exec(`ffmpeg -nostdin -y -loglevel error -f x11grab -framerate 12 -video_size 1920x1080 -i :1 -vf scale=1600:-2 -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p /var/lib/rehearsal-video/video.mp4 > /var/lib/rehearsal-video/ffmpeg.log 2>&1 & echo $! > /run/rehearsal-ffmpeg.pid`)
    sh(['exec', '-d', name, 'su', '-l', 'ana', '-s', '/bin/bash', '-c', 'DISPLAY=:1 xfce4-terminal --disable-server --hide-menubar --hide-toolbar --hide-scrollbar --title=Terminal --font="DejaVu Sans Mono 11" --geometry=104x54+0+0 -x tmux attach -t agent'])
    await new Promise((r) => setTimeout(r, 2500))
    sh(['exec', '-d', name, 'su', '-l', 'ana', '-s', '/bin/bash', '-c', 'DISPLAY=:1 browser'])
    await new Promise((r) => setTimeout(r, 6000))
    exec(`DISPLAY=:1 su ana -c "wmctrl -r Terminal -e 0,0,0,960,1080; wmctrl -r Chromium -e 0,960,0,960,1080"`, { quiet: true })
  }
  spawnSync('chmod', ['700', runHere])
  writeFileSync(join(runHere, 't0'), `${Math.floor(Date.now() / 1000)}\n`)
  writeFileSync(join(runHere, 'ready'), name)

  // ---- the person ----
  if (person === 'model') {
    log(`ready for the person: PERSON_RUN=${runHere}`)
    const until = Date.now() + minutes * 60_000
    while (Date.now() < until && !existsSync(join(runHere, 'finish'))) await new Promise((r) => setTimeout(r, 2000))
    if (!existsSync(join(runHere, 'finish'))) log('the run ran past its time')
    return
  }
  log(`flow ${flow} with ${app} in ${which}`)
  await new Promise((resolve) => {
    const child = spawn('sudo', ['-n', 'docker', 'exec', name, 'su', '-l', 'ana', '-s', '/bin/bash', '-c', `cd ~/work 2>/dev/null || mkdir -p ~/work && cd ~/work; DISPLAY=:1 PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright node /build/harness/${/^(S\d|SOAK|WAKE)/.test(flow) ? 'scripted' : 'flow'}.mjs ${flow === 'WAKEBOOT' ? 'WAKEBOOT1' : flow} ${app} ${which === 'chromium' && /^(S\d|SOAK|WAKE)/.test(flow) ? '' : which} ${FLOW}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    // A change the flow asks for between two clicks, run as root (an update of the agent app)
    const between = setInterval(() => {
      if (exec('test -f /var/lib/rehearsal-flow/between-now && test ! -f /var/lib/rehearsal-flow/between-done && echo yes', { quiet: true }).stdout.trim() !== 'yes') return
      exec('sh /var/lib/rehearsal-flow/between.sh > /var/lib/rehearsal-flow/between.log 2>&1; touch /var/lib/rehearsal-flow/between-done', { quiet: true, timeout: 600_000 })
      log('ran the change between the clicks')
    }, 5000)
    child.on('close', () => clearInterval(between))
    const kill = setTimeout(() => {
      log('the flow ran past its time')
      exec("pkill -INT -f 'node /build/harness/' || true")
    }, minutes * 60_000)
    // Redacted a whole line at a time, so that a token split across two reads is still found
    // Each stream with a buffer of its own, so that one's newline never flushes half a line of the other
    const rest = { out: '', err: '' }
    const out = (k) => (d) => {
      rest[k] += d.toString()
      const lines = rest[k].split('\n')
      rest[k] = lines.pop()
      for (const l of lines) process.stdout.write(`${redact(l, held)}\n`)
    }
    child.stdout.on('data', out('out'))
    child.stderr.on('data', out('err'))
    child.on('close', () => {
      for (const k of ['out', 'err']) if (rest[k]) process.stdout.write(`${redact(rest[k], held)}\n`)
      clearTimeout(kill)
      resolve()
    })
  })
  if (flow === 'WAKEBOOT') {
    // The whole machine restarted, and nobody signs in or opens a terminal: the click comes from a
    // second screen, a browser of its own that is no login session of the person's
    if (has('linger-as-desktop')) {
      // What `it setup` gets on a desktop, where polkit lets a person keep their own services
      // after logout, and this container's lack of polkit refused it
      exec('loginctl enable-linger ana')
      result.lingerAsDesktop = 'loginctl enable-linger ana, by root, standing in for setup on a desktop'
    }
    result.lingerBeforeRestart = exec('loginctl show-user ana -p Linger 2>/dev/null; ls /var/lib/systemd/linger/', { quiet: true }).stdout.trim()
    log('restarting the machine')
    exec('kill -INT $(cat /run/rehearsal-ffmpeg.pid) 2>/dev/null; sleep 3')
    sh(['cp', `${name}:/var/lib/rehearsal-video/video.mp4`, join(runHere, 'before-reboot.mp4')], { timeout: 300_000 })
    sh(['restart', '-t', '90', name], { timeout: 240_000 })
    for (let i = 0; i < 60; i++) {
      const st = exec('systemctl is-system-running', { quiet: true }).stdout.trim()
      if (st === 'running' || st === 'degraded') break
      await new Promise((r) => setTimeout(r, 1000))
    }
    await new Promise((r) => setTimeout(r, 20_000))
    result.afterBootNobodySignedIn = {
      userManager: exec('systemctl is-active user@1000.service', { quiet: true }).stdout.trim(),
      sessions: exec('loginctl list-sessions --no-legend | wc -l', { quiet: true }).stdout.trim(),
      itService: exec('systemctl --user -M ana@ is-active it.service 2>&1 | head -1', { quiet: true }).stdout.trim(),
    }
    log(`after the restart, nobody signed in: ${JSON.stringify(result.afterBootNobodySignedIn)}`)
    exec(`ffmpeg -nostdin -y -loglevel error -f x11grab -framerate 12 -video_size 1920x1080 -i :1 -vf scale=1600:-2 -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p /var/lib/rehearsal-video/video.mp4 > /var/lib/rehearsal-video/ffmpeg.log 2>&1 & echo $! > /run/rehearsal-ffmpeg.pid`)
    exec('mkdir -p /var/lib/rehearsal-flow && chown ana:ana /var/lib/rehearsal-flow')
    // The second screen: started as ana without a login session (docker exec -u, no PAM)
    sh(['exec', '-d', '-u', 'ana', '-e', 'DISPLAY=:1', '-e', 'HOME=/home/ana', name, '/opt/ms-playwright/chromium-1228/chrome-linux64/chrome', '--user-data-dir=/opt/person-profile/screen2', '--no-sandbox', '--test-type', '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--remote-debugging-port=9223', '--window-position=980,40', '--window-size=900,1000', 'about:blank'])
    await new Promise((r) => setTimeout(r, 6000))
    await new Promise((resolve) => {
      const child = spawn('sudo', ['-n', 'docker', 'exec', '-u', 'ana', '-e', 'HOME=/home/ana', '-e', 'DISPLAY=:1', '-e', 'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright', '-w', '/home/ana', name, 'node', '/build/harness/scripted.mjs', 'WAKEBOOT2', app, FLOW], { stdio: ['ignore', 'pipe', 'pipe'] })
      const kill = setTimeout(() => exec("pkill -INT -f 'node /build/harness/' || true"), 20 * 60_000)
      child.stdout.on('data', (d) => process.stdout.write(redact(d.toString(), held)))
      child.stderr.on('data', (d) => process.stdout.write(redact(d.toString(), held)))
      child.on('close', () => {
        clearTimeout(kill)
        resolve()
      })
    })
  }
}

let collected = false
let videoWithheld = false
async function collect() {
  if (refresher) clearInterval(refresher)
  refresher = null
  while (refreshing) await new Promise((r) => setTimeout(r, 500))
  // The recording, stopped as ffmpeg finishes a file
  exec('kill -INT $(cat /run/rehearsal-ffmpeg.pid) 2>/dev/null; for i in $(seq 30); do kill -0 $(cat /run/rehearsal-ffmpeg.pid) 2>/dev/null || exit 0; sleep 1; done', { quiet: true })
  // Where the token is in the machine before it is wiped. Codex's own auth.json is expected; a
  // copy anywhere else (the agent's transcript, a page, a log) means the agent saw it, and what it
  // saw may be in the recording, so the recording is not kept.
  const expected = [...(app === 'codex' || has('also-codex') ? ['/home/ana/.codex/auth.json'] : []), ...(app === 'claude' && (has('claude-file') || participant) && !has('claude-token-in-profile') ? ['/home/ana/.claude/.credentials.json'] : []), ...(app === 'claude' && has('claude-token-in-profile') ? ['/home/ana/.bashrc'] : [])]
  const before = held ? await filesHolding(name, held) : []
  result.tokenFilesBeforeWipe = redact(before.join(', '), held)
  const elsewhere = before.filter((f) => !expected.includes(f))
  // The terminal as tmux has it, read by root and not from any file the agent could write
  const tmuxText = asAna('tmux capture-pane -p -J -S - -t agent 2>/dev/null', { quiet: true }).stdout
  if (elsewhere.length || holdsToken(tmuxText, held)) {
    videoWithheld = true
    result.tokenSeenInMachine = { files: elsewhere.length, inTerminal: holdsToken(tmuxText, held) }
  }
  const itLog = asAna('cat ~/.it/logs/it.log 2>/dev/null', { quiet: true }).stdout
  const status = asAna('~/.it/bin/it status 2>&1', { quiet: true, timeout: 60_000 }).stdout
  const journal = exec('journalctl -u rehearsal-releases --no-pager -o cat 2>/dev/null | tail -200', { quiet: true }).stdout
  const userJournal = asAna('journalctl --user -u it.service --no-pager -o cat 2>/dev/null | tail -300', { quiet: true }).stdout
  const fromFlow = (f) => exec(`cat ${FLOW}/${f} 2>/dev/null`, { quiet: true }).stdout
  const screens = fromFlow('screens.txt')
  if (holdsToken(screens, held)) {
    videoWithheld = true
    result.tokenSeenInMachine = { ...(result.tokenSeenInMachine ?? {}), inScreens: true }
  }
  const flowFiles = { 'steps.jsonl': fromFlow('steps.jsonl'), 'flow.json': fromFlow('flow.json'), 'terminal.txt': fromFlow('terminal.txt') }
  // Every trace of the token out of the machine, before anything is kept
  const left = await wipe(name, held)
  result.tokenFilesLeftAfterWipe = left.length
  if (left.length) log(`after the wipe ${left.length} file(s) still hold a token value: ${redact(left.join(', '), held)}`)
  // JSON is read and written again first, so that a value written with \\u escapes is redacted as itself
  const normal = (file, text) => {
    if (!text) return ''
    if (file.endsWith('.jsonl')) return text.split('\n').map((l) => { try { return l.trim() ? JSON.stringify(JSON.parse(l)) : l } catch { return l } }).join('\n')
    if (file.endsWith('.json')) { try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text } }
    return text
  }
  const keep = (file, raw) => {
    const text = normal(file, raw ?? '')
    const clean = redact(text, held)
    if (clean !== (text ?? '')) result.redacted = [...(result.redacted ?? []), file]
    writeFileSync(join(dir, file), clean, { mode: 0o600 })
    return clean
  }
  keep('it.log', itLog)
  keep('it-status.txt', status)
  keep('releases-stand-in.log', journal)
  keep('it-service-journal.txt', userJournal)
  keep('terminal.txt', flowFiles['terminal.txt'] || tmuxText)
  keep('terminal-screens.txt', screens)
  for (const f of ['person-log.txt', 'person-account.txt', 'actions.jsonl']) {
    if (existsSync(join(runHere, f))) keep(f, readFileSync(join(runHere, f), 'utf8'))
  }
  if (existsSync(join(runHere, 'person-log.txt'))) result.personLog = 'person-log.txt'
  const term = redact(`${screens}\n${tmuxText}`, held)
  const model = /(?:Opus|Sonnet|Haiku|Fable)\s+[0-9.]+|model:\s*([a-z0-9.\-]+(?: (?:low|medium|high|xhigh))?)|gpt-[0-9][a-z0-9.\-]*/i.exec(term)
  if (model) result.model = (model[1] ?? model[0]).trim()
  const steps = keep('steps.jsonl', flowFiles['steps.jsonl'])
  result.steps = steps
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
  const verdictText = keep('flow.json', flowFiles['flow.json'])
  if (verdictText.trim()) {
    const v = JSON.parse(verdictText)
    Object.assign(result, { ok: !!v.ok, reason: v.reason, blame: v.blame, parts: v.parts, counts: v.counts, approvalsDuringTour: v.approvalsDuringTour, lastWords: v.lastWords, observations: v.observations })
  } else {
    if (person === 'model') result.reason ??= 'to be judged by the tester from the video, the terminal and the person\'s account'
    else {
      result.reason ??= 'the flow wrote no verdict'
      result.blame ??= 'harness'
    }
  }
  // The recording, kept only where nothing says the token was on the screen
  if (!videoWithheld) {
    sh(['cp', `${name}:/var/lib/rehearsal-video/video.mp4`, join(dir, 'video.mp4')], { timeout: 300_000 })
    if (existsSync(join(runHere, 'before-reboot.mp4'))) {
      writeFileSync(join(runHere, 'parts.txt'), `file '${join(runHere, 'before-reboot.mp4')}'\nfile '${join(dir, 'video.mp4')}'\n`)
      spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(runHere, 'parts.txt'), '-c', 'copy', join(runHere, 'joined.mp4')])
      if (existsSync(join(runHere, 'joined.mp4'))) spawnSync('mv', ['-f', join(runHere, 'joined.mp4'), join(dir, 'video.mp4')])
      result.video = 'two parts joined: before the reboot, and from the person signing in again'
    }
  } else result.video = 'withheld: the token was seen in the machine, so it may be in the recording'
  collected = left.length === 0
}

/** Ends the machine and every trace of the token in it, whatever happened before. */
async function teardown() {
  if (refresher) clearInterval(refresher)
  refresher = null
  // A refresh already writing into the machine finishes before the wipe, so nothing lands after it
  for (let i = 0; refreshing && i < 400; i++) await new Promise((r) => setTimeout(r, 500))
  await wipe(name, held).catch(() => {})
  // A withheld recording takes the screenshots and any part kept outside the machine with it
  if (videoWithheld) spawnSync('sh', ['-c', 'find "$1" -type f \\( -name "*.png" -o -name "*.mp4" \\) -exec shred -u {} +', 'sh', runHere])
  const used = held !== null
  held = null
  if (has('keep') && !used) return
  const rm = sh(['rm', '-f', name], { timeout: 120_000, quiet: true })
  if (rm.status !== 0) log(`THE MACHINE ${name} COULD NOT BE REMOVED: remove it by hand`)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    log(`stopped by ${sig}: wiping and removing the machine`)
    await teardown()
    process.exit(130)
  })
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
try {
  writeFileSync(join(dir, 'result.json'), `${redact(JSON.stringify(result, null, 2), held)}\n`, { mode: 0o600 })
} catch (err) {
  log(`result.json could not be written: ${err?.message}`)
}
// A machine is kept as an image only where the run finished, everything was collected, and no
// trace of the token was found left after the wipe
if (snapshot && !failure && collected) {
  log(`keeping the machine as ${snapshot}`)
  exec('rm -rf /var/lib/rehearsal-video /var/lib/rehearsal-flow', { quiet: true })
  const stopped = sh(['stop', '-t', '90', name], { timeout: 180_000 })
  if (stopped.status === 0) sh(['commit', name, snapshot], { timeout: 600_000 })
  else log('the machine did not stop, so it is not kept')
} else if (snapshot) log('the machine is not kept: the run failed, or a trace of the token may be left')
await teardown()
try {
  writeReport(RESULTS)
} catch (err) {
  log(`the report could not be written: ${err?.message}`)
}
log(`${result.ok ? 'PASS' : 'FAIL'} ${id}${result.reason ? `: ${redact(result.reason)}` : ''}`)
