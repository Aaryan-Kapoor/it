// The Mac rehearsal, from this machine: rented Macs made and ended with the ledger kept, each
// prepared with the build under test served as It's releases, a run recorded with the agent's
// Terminal on the left and the browser on the right, and its files fetched, scanned and kept.
//
//   node run.mjs create --type 6x14|4x7 --minutes 75 --purpose "<what for>"
//   node run.mjs prepare <mac> --app codex|claude --browser safari|chrome
//   node run.mjs sign-in <mac> --app codex|claude        (prepare does it; again after a wipe)
//   node run.mjs look <mac>                              a screenshot for the tester
//   node run.mjs start <mac> --scenario s1 --app codex --browser safari
//   node run.mjs finish <run folder>                     stops the recording, collects, wipes
//   node run.mjs wipe <mac>
//   node run.mjs destroy <mac>                           wipes, ends the Mac, closes its ledger line
//   node run.mjs ledger
//
// Results go to ~/it-rehearsal/2026-11-15-mac/<run id>/, the ledger to ledger.md there. What a run
// is working on (the person's screenshots, its clock) is in $IT_REHEARSAL_LIVE.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NSC, HAIKU, SAFE_ENV, filesHolding, fingerprint, holdsSecret, inject, onMac, redact, take, wipe } from './secrets.mjs'
import { writeReport } from './report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const RESULTS = process.env.IT_REHEARSAL_RESULTS ?? join(homedir(), 'it-rehearsal', '2026-11-15-mac')
const LIVE = process.env.IT_REHEARSAL_LIVE ?? '/tmp/claude-1000/-home-cbak--t3-worktrees-it-t3-a3c24a76-20db2fab89311564/81820fb8-5917-4fab-a8f2-ea80cf68093b/scratchpad/live'
const BIN = process.env.IT_REHEARSAL_BIN ?? join(ROOT, 'packages', 'cli', 'dist', 'bin')
const BUDGET = 400
const PRICE = { '6x14': 0.09, '4x7': 0.06 }
const MODEL = { codex: 'gpt-6.1-sol at high reasoning effort', claude: `Claude Haiku 5.5 through OpenRouter (${HAIKU})` }
const GUI = 'sudo launchctl asuser 501 sudo -u runner -H'
const SHARED = '/Users/Shared/rehearsal'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`)
mkdirSync(RESULTS, { recursive: true })
mkdirSync(LIVE, { recursive: true })

// ---- the ledger ----
// One ledger for the whole night, wherever a run's results go
const LEDGER_DIR = join(homedir(), 'it-rehearsal', '2026-11-15-mac')
const LEDGER_JSON = join(LEDGER_DIR, 'ledger.json')
const ledger = () => (existsSync(LEDGER_JSON) ? JSON.parse(readFileSync(LEDGER_JSON, 'utf8')) : [])
function minutesOf(m) {
  const end = m.destroyed ? Date.parse(m.destroyed) : Date.now()
  return Math.ceil((end - Date.parse(m.made)) / 60_000)
}
function writeLedger(rows) {
  writeFileSync(LEDGER_JSON, `${JSON.stringify(rows, null, 2)}\n`)
  let total = 0
  let dollars = 0
  const lines = rows.map((m) => {
    const mins = minutesOf(m)
    total += mins
    dollars += mins * (PRICE[m.type] ?? 0.09)
    return `| ${m.id} | macos/arm64:${m.type} | ${m.purpose} | ${m.made.slice(0, 19).replace('T', ' ')} | ${m.destroyed ? m.destroyed.slice(0, 19).replace('T', ' ') : '**still running**'} | ${mins} | ${total} | $${dollars.toFixed(2)} |`
  })
  writeFileSync(
    join(LEDGER_DIR, 'ledger.md'),
    `# Mac ledger, 15 November 2026\n\nThe budget is ${BUDGET} Mac-minutes (forty dollars at about nine cents a minute for macos/arm64:6x14). A machine's minutes run from the moment \`nsc create\` was asked for it to the moment it was destroyed, rounded up. The dollars are estimates: nine cents a minute for 6x14 and six cents for 4x7, which is Namespace's price scaled by size and not a figure from the bill.\n\n| Machine | Shape | What for | Made (UTC) | Destroyed (UTC) | Minutes | Running total | Running dollars |\n|---|---|---|---|---|---|---|---|\n${lines.join('\n')}\n\n**Total: ${total} Mac-minutes, about $${dollars.toFixed(2)}.**\n`,
  )
  return total
}

function nsc(args, { timeout = 600_000 } = {}) {
  return spawnSync(NSC, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, env: SAFE_ENV })
}

async function create() {
  const type = arg('type', '6x14')
  const minutes = Math.min(Number(arg('minutes', '75')), 75)
  const purpose = arg('purpose', 'It rehearsal on a Mac')
  const used = writeLedger(ledger())
  if (used + minutes > BUDGET + 30) throw new Error(`The ledger has ${used} minutes; a ${minutes}-minute Mac would pass the budget.`)
  const cid = join(LIVE, `cid-${Date.now()}`)
  const made = new Date().toISOString()
  const r = nsc(['create', '--machine_type', `macos/arm64:${type}`, '--selectors', 'macos.version=15.x', '--ephemeral', '--duration', `${minutes}m`, '--bare', '--purpose', purpose, '--cidfile', cid, '--wait_timeout', '5m'])
  const id = existsSync(cid) ? readFileSync(cid, 'utf8').trim() : ''
  if (!id) {
    console.log(r.stdout, r.stderr)
    // A machine that was asked for and maybe made is looked for, so that none is lost
    const rows = ledger()
    rows.push({ id: '(none made)', type, purpose: `${purpose}: nsc create failed (exit ${r.status})`, made, destroyed: new Date().toISOString() })
    writeLedger(rows)
    throw new Error('nsc create gave no machine id.')
  }
  const rows = ledger()
  rows.push({ id, type, purpose, made, destroyed: null, duration: minutes })
  writeLedger(rows)
  log(`made ${id} (${type}, ends itself after ${minutes} minutes)`)
  console.log(id)
}

async function destroy(id) {
  await wipeAll(id)
  const r = nsc(['destroy', id, '--force'], { timeout: 180_000 })
  log(`destroy ${id}: exit ${r.status} ${redact((r.stderr || r.stdout || '').trim().slice(0, 200))}`)
  if (r.status !== 0) {
    const l = nsc(['list', '-o', 'json'])
    let gone = false
    try {
      gone = l.status === 0 && !(JSON.parse(l.stdout || 'null') ?? []).some((m) => m.cluster_id === id)
    } catch {}
    if (!gone) throw new Error(`${id} could not be shown to be destroyed; its ledger line stays open.`)
  }
  const rows = ledger()
  const m = rows.find((x) => x.id === id && !x.destroyed)
  if (m) m.destroyed = new Date().toISOString()
  const total = writeLedger(rows)
  log(`ledger: ${total} Mac-minutes used of ${BUDGET}`)
}

/** Wipes both apps' credentials off the Mac, with the values of each held so copies are found. */
async function wipeAll(id) {
  for (const app of ['codex', 'claude']) {
    let held = null
    try {
      held = take(app, 0).held
    } catch (err) {
      log(`wipe: the ${app} values could not be read (${err.message}); the files are wiped all the same`)
    }
    const left = await wipe(id, held)
    const fp = join(LIVE, `mac-${id}-${app}.fp`)
    if (held && existsSync(fp) && readFileSync(fp, 'utf8').trim() !== fingerprint(held)) left.push('(the values read now are not the ones written to this Mac, so copies of those were not looked for)')
    log(`wipe ${app}: ${left.length ? `not clean: ${redact(left.join(', '), held)}` : 'nothing left'}`)
    held = null
  }
}

// ---- preparing a Mac ----
function upload(id) {
  const files = ['it-darwin-arm64', 'install.sh', 'SHA256SUMS', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md', 'latest.json']
  for (const f of files) if (!existsSync(join(BIN, f))) throw new Error(`The build has no ${f} in ${BIN}.`)
  // Staged in one folder (the build's files under bin/, the harness beside them) and sent as one tar
  const stage = join(LIVE, 'upload')
  spawnSync('rm', ['-rf', stage], { env: SAFE_ENV })
  mkdirSync(join(stage, 'bin'), { recursive: true })
  for (const f of files) copyFileSync(join(BIN, f), join(stage, 'bin', f))
  for (const f of ['hands.swift', 'prepare.sh', 'releases.mjs', 'site.mjs']) copyFileSync(join(HERE, f), join(stage, f))
  // The guide the person gives the agent, where one is named, without the notes above it
  if (process.env.IT_REHEARSAL_GUIDE) writeFileSync(join(stage, 'install.md'), readFileSync(process.env.IT_REHEARSAL_GUIDE, 'utf8').replace(/^<!--[\s\S]*?-->\s*/, ''))
  // A throwaway authority and certificate for the itcan.do stand-in, made fresh for each upload and
  // never kept: they are trusted only on the rented Mac, which is destroyed after the run
  mkdirSync(join(stage, 'site'))
  const ssl = (args) => spawnSync('openssl', args, { cwd: join(stage, 'site'), env: SAFE_ENV, stdio: 'ignore' })
  ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=It rehearsal CA', '-keyout', 'ca.key', '-out', 'ca.pem'])
  ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=itcan.do', '-keyout', 'key.pem', '-out', 'site.csr'])
  writeFileSync(join(stage, 'site', 'ext'), 'subjectAltName=DNS:itcan.do\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n')
  ssl(['x509', '-req', '-in', 'site.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'ext', '-out', 'cert.pem'])
  rmSync(join(stage, 'site', 'ca.key'))
  const tar = spawn('tar', ['-czf', '-', '-C', stage, '.'], { stdio: ['ignore', 'pipe', 'inherit'], env: SAFE_ENV })
  const ssh = spawn(NSC, ['ssh', '-T', id, 'rm -rf ~/rehearsal-upload && mkdir -p ~/rehearsal-upload && tar -xzf - -C ~/rehearsal-upload && ls ~/rehearsal-upload/bin | wc -l'], { stdio: ['pipe', 'inherit', 'ignore'], env: SAFE_ENV })
  tar.stdout.pipe(ssh.stdin)
  return new Promise((resolve, reject) => ssh.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`upload exited ${c}`)))))
}

async function step(id, what, timeout = 600_000) {
  const t = Date.now()
  const { code, out } = await onMac(id, `bash ~/rehearsal-upload/prepare.sh ${what}`, { timeout })
  log(`prepare ${what}: exit ${code} in ${Math.round((Date.now() - t) / 1000)} s\n${redact(out.trim())}`)
  if (code !== 0) throw new Error(`prepare ${what} failed`)
  return out
}

/** When the Mac ends itself, from its ledger line, less three minutes: when the watch on it wipes. */
function wipeAt(id) {
  const m = ledger().find((x) => x.id === id && !x.destroyed)
  const end = m ? Date.parse(m.made) + (m.duration ?? 75) * 60_000 : Date.now() + 70 * 60_000
  return Math.floor(end / 1000) - 180
}

async function signIn(id, app) {
  const { held, minutesLeft } = take(app, 50)
  writeFileSync(join(LIVE, `mac-${id}-${app}.fp`), `${fingerprint(held)}\n`, { mode: 0o600 })
  try {
    await inject(id, held, wipeAt(id))
  } catch (err) {
    await wipe(id, held)
    throw err
  }
  log(`signed in ${app} on ${id}${minutesLeft ? ` (the copy lives ${minutesLeft} more minutes)` : ''}`)
}

async function prepare(id) {
  try {
    await prepareSteps(id)
  } catch (err) {
    log(`prepare failed (${redact(err.message)}): wiping the credentials off ${id}`)
    await wipeAll(id)
    throw err
  }
}

async function prepareSteps(id) {
  const app = arg('app', 'codex')
  const browser = arg('browser', 'safari')
  const t = Date.now()
  await upload(id)
  log(`uploaded in ${Math.round((Date.now() - t) / 1000)} s`)
  await step(id, 'tools')
  await step(id, 'standin')
  const version = (await step(id, `app ${app}`)).trim().split('\n').at(-1)
  await signIn(id, app)
  await step(id, `desktop ${browser}`)
  await step(id, `place ${browser === 'chrome' ? '"Google Chrome"' : 'Safari'}`)
  await clearScreen(id, browser)
  const facts = await step(id, 'facts')
  const machine = { id, app, browser, appVersion: version, facts: Object.fromEntries(facts.trim().split('\n').map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)])) }
  writeFileSync(join(LIVE, `mac-${id}.json`), `${JSON.stringify(machine, null, 2)}\n`)
  await look(id)
}

/**
 * Clears what the test itself puts on a new Mac's screen and a participant never meets: the
 * prompt macOS shows the first time the recorder's helper captures the screen (its Allow button
 * is at the same place each time), and Safari's first-run "What's New" card.
 */
async function clearScreen(id, browser) {
  const h = `${GUI} /usr/local/bin/hands`
  await onMac(id, `${GUI} screencapture -x ${SHARED}/prompt.png; sleep 3; ${h} click 640 372; sleep 1${browser === 'safari' ? `; ${h} click 734 171` : ''}; sleep 0.5; ${h} click 300 400`)
  log('cleared the capture prompt and the browser\'s first-run card')
}

/** One short question to Claude Code through OpenRouter, outside the person's folder, before any recording. */
async function checkClaude(id) {
  const q = 'Which model are you, exactly? Answer in one short sentence.'
  const r = await onMac(id, `mkdir -p /tmp/check && cd /tmp/check && claude -p "${q}" 2>&1 | head -5; rm -rf ~/.claude/projects/-private-tmp-check ~/.claude/projects/-tmp-check`, { timeout: 180_000 })
  log(`Claude Code answered (exit ${r.code}): ${redact(r.out.trim())}`)
}

async function look(id, file = join(LIVE, `look-${id}-${Date.now()}.png`)) {
  const { out } = await onMac(id, `${GUI} screencapture -x -C -t png ${SHARED}/tester.png && sips -Z 1280 ${SHARED}/tester.png --out ${SHARED}/tester-s.png >/dev/null && cat ${SHARED}/tester-s.png`, { binary: true })
  writeFileSync(file, out)
  console.log(file)
}

// ---- a run ----
async function start(id) {
  const scenario = arg('scenario', 's1')
  const app = arg('app', 'codex')
  const browser = arg('browser', 'safari')
  const machine = existsSync(join(LIVE, `mac-${id}.json`)) ? JSON.parse(readFileSync(join(LIVE, `mac-${id}.json`), 'utf8')) : { facts: {} }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
  const runId = `${stamp}-${scenario}-${app}-${browser}-mac15`.toLowerCase()
  const live = join(LIVE, runId)
  mkdirSync(join(live, 'shots'), { recursive: true })
  const build = { commit: spawnSync('git', ['-C', ROOT, 'log', '-1', '--format=%H', '--', '.', ':(exclude)e2e/rehearsal-mac'], { encoding: 'utf8', env: SAFE_ENV }).stdout.trim(), version: JSON.parse(readFileSync(join(BIN, 'latest.json'), 'utf8')).version }
  const result = {
    id: runId,
    scenario,
    app,
    appVersion: machine.appVersion ?? null,
    model: MODEL[app],
    browser: browser === 'chrome' ? `Chrome ${machine.facts.chrome ?? ''}`.trim() : `Safari ${machine.facts.safari ?? ''}`.trim(),
    macos: machine.facts.macos ?? null,
    mac: { instance: id, shape: machine.facts.model, cpus: machine.facts.cpus, screen: machine.facts.screen },
    build: build.commit,
    buildVersion: build.version,
    person: 'Claude Opus 5.5 at high effort, looking at the screen',
    installBase: 'IT_INSTALL_BASE=http://127.0.0.1:8765 in ~/.zshenv and the desktop session, before the video starts: the live install script fetches the build under test from a stand-in for the releases on the Mac itself',
    start: new Date().toISOString(),
    end: null,
    macMinutes: null,
    ok: false,
    blame: null,
    reason: null,
    steps: [],
  }
  // The person must meet a live, empty Terminal: a wipe ends the tmux session, and prepare's
  // desktop step is what opens it again
  if (!argv.includes('--plain') && (await onMac(id, '/opt/homebrew/bin/tmux has-session -t agent')).code !== 0) throw new Error('The Terminal\'s tmux session is not running: run prepare\'s desktop step again before starting.')
  // What the terminal shows, kept every four seconds where it changed: an app that clears the
  // screen as it leaves takes its scrollback with it
  await onMac(id, `rm -f ${SHARED}/video.mp4 ${SHARED}/screens.txt; sh -c 'trap "" HUP; p=""; while sleep 4; do c=$(/opt/homebrew/bin/tmux capture-pane -p -J -t agent 2>/dev/null) || continue; [ "$c" = "$p" ] && continue; printf "=== %s\\n%s\\n" "$(date -u +%T)" "$c" >> ${SHARED}/screens.txt; p="$c"; done' < /dev/null >/dev/null 2>&1 & echo $! > ${SHARED}/screens.pid`)
  // The recording: the whole screen with the pointer and its clicks, 12 frames a second, 1600 wide
  const rec = await onMac(id, `${GUI} sh -c 'trap "" HUP; cd ${SHARED} || exit 1; /usr/local/bin/ffmpeg -nostdin -y -loglevel warning -f avfoundation -capture_cursor 1 -capture_mouse_clicks 1 -framerate 12 -i "Capture screen 0:none" -vf "scale=1600:-2,format=yuv420p" -r 12 -c:v libx264 -preset veryfast -crf 28 -movflags +frag_keyframe+empty_moov+default_base_moof video.mp4 < /dev/null > ffmpeg.log 2>&1 & echo $! > ffmpeg.pid'; sleep 4; ls -la ${SHARED}/video.mp4; cat ${SHARED}/ffmpeg.log`)
  log(`recording: ${rec.out.trim()}`)
  result.videoStart = new Date().toISOString()
  writeFileSync(join(live, 't0'), `${Math.floor(Date.now() / 1000)}\n`)
  writeFileSync(join(live, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  copyFileSync(join(HERE, 'person.sh'), join(live, 'person'))
  chmodSync(join(live, 'person'), 0o755)
  writeFileSync(join(live, 'ready'), id)
  log(`ready for the person: ${join(live, 'person')}`)
  console.log(live)
}

async function finish(live) {
  const result = JSON.parse(readFileSync(join(live, 'result.json'), 'utf8'))
  const id = readFileSync(join(live, 'ready'), 'utf8').trim()
  writeFileSync(join(live, 'finished'), new Date().toISOString())
  const app = result.app
  const dir = join(RESULTS, result.id)
  mkdirSync(dir, { recursive: true })
  // The recording, stopped as ffmpeg finishes the file
  await onMac(id, `kill -INT $(cat ${SHARED}/ffmpeg.pid) 2>/dev/null; for i in $(seq 30); do kill -0 $(cat ${SHARED}/ffmpeg.pid) 2>/dev/null || break; sleep 1; done; kill $(cat ${SHARED}/screens.pid) 2>/dev/null; true`)
  let held = null
  try {
    held = take(app, 0).held
  } catch (err) {
    log(`the ${app} values could not be read for the scan (${err.message})`)
  }
  const fp = join(LIVE, `mac-${id}-${app}.fp`)
  const sameValues = held && existsSync(fp) && readFileSync(fp, 'utf8').trim() === fingerprint(held)
  if (!sameValues) result.credentialCheck = 'the values read now are not the ones written to the Mac, so the scan could not look for those: the video is withheld'
  // Where the credential is on the Mac before it is wiped. The file it was written to is expected;
  // a copy anywhere else (a transcript, a page, a log) means the agent saw it, and what it saw may
  // be in the recording, so the recording is not kept.
  const expected = [`/Users/runner/${held?.file}`]
  const before = held ? await filesHolding(id, held) : ['(the values could not be read)']
  const elsewhere = before.filter((f) => !expected.includes(f))
  result.credentialFilesBeforeWipe = elsewhere.length ? `${elsewhere.length} beyond the one written: ${redact(elsewhere.join(', '), held)}` : 'only the one written'
  const unread = []
  const text = async (cmd, name) => {
    const r = await onMac(id, cmd, { timeout: 120_000 })
    if (r.code !== 0) unread.push(name)
    return r.out
  }
  const tmuxText = await text(`/opt/homebrew/bin/tmux capture-pane -p -J -S - -t agent`, 'terminal')
  const screens = await text(`cat ${SHARED}/screens.txt`, 'terminal-screens')
  let withhold = elsewhere.length > 0 || !sameValues
  const itLogs = await text(`bash -c 'for f in ~/.it/logs/*; do [ -f "$f" ] && { echo "=== $(basename "$f")"; tail -n 400 "$f"; }; done 2>/dev/null; true'`, 'it-logs')
  const status = await text('~/.it/bin/it status 2>&1 | head -100; true', 'it-status')
  const standIn = await text(`tail -n 200 ${SHARED}/releases.log 2>/dev/null; true`, 'stand-in')
  const service = await text('ls ~/Library/LaunchAgents 2>/dev/null; launchctl print gui/501 2>/dev/null | grep -i " it" | head -20; true', 'service')
  const ffmpegLog = await text(`tail -20 ${SHARED}/ffmpeg.log 2>/dev/null; true`, 'ffmpeg')
  // The person's own notes: a note in which a value is seen withholds the video and is replaced whole
  for (const f of ['person-log.txt', 'person-account.txt']) {
    const p = join(live, f)
    if (existsSync(p) && holdsSecret(readFileSync(p, 'utf8'), held)) {
      withhold = true
      writeFileSync(p, '(not kept: something shaped like a credential was in it)\n')
    }
  }
  // Every trace of the credential off the Mac, before anything is kept
  const left = await wipe(id, held)
  result.credentialFilesLeftAfterWipe = left.length
  if (left.length) withhold = true
  if (left.length) log(`after the wipe the Mac is not clean: ${redact(left.join(', '), held)}`)
  // A file in which a value or its shape is seen is not kept at all, and the video is withheld
  const keep = (file, body) => {
    const raw = body ?? ''
    if (holdsSecret(raw, held)) {
      withhold = true
      result.notKept = [...(result.notKept ?? []), file]
      writeFileSync(join(dir, file), '(not kept: something shaped like a credential was in it)\n', { mode: 0o600 })
      return ''
    }
    writeFileSync(join(dir, file), raw, { mode: 0o600 })
    return raw
  }
  keep('terminal.txt', tmuxText)
  keep('terminal-screens.txt', screens)
  keep('it-logs.txt', itLogs)
  keep('it-status.txt', status)
  keep('releases-stand-in.log', standIn)
  keep('service.txt', service)
  keep('ffmpeg.log', ffmpegLog)
  for (const f of ['person-log.txt', 'person-account.txt', 'actions.jsonl']) {
    if (existsSync(join(live, f))) keep(f, readFileSync(join(live, f), 'utf8'))
  }
  if (unread.length) {
    result.unread = unread
    withhold = true
  }
  if (withhold) {
    rmSync(join(live, 'shots'), { recursive: true, force: true })
    for (const f of readdirSync(LIVE)) if (f.startsWith(`look-${id}-`)) rmSync(join(LIVE, f), { force: true })
  }
  if (!withhold) {
    const { out } = await onMac(id, `cat ${SHARED}/video.mp4`, { binary: true, timeout: 900_000 })
    writeFileSync(join(dir, 'video.mp4'), out)
    result.videoBytes = out.length
  } else result.video = 'withheld: a credential was seen on the Mac outside its own file or in what was collected, or could not be looked for, so it may be in the recording; the screenshots were deleted too'
  result.end = new Date().toISOString()
  result.macMinutes = Math.ceil((Date.parse(result.end) - Date.parse(result.start)) / 60_000)
  held = null
  writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  writeReport(RESULTS)
  log(`collected ${result.id}: video ${result.videoBytes ?? 'withheld'} bytes, credential files left ${left.length}`)
  console.log(dir)
}

const [cmd, target] = argv
// Stopped while a Mac holds a credential: wipe it before going
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    const id = cmd === 'finish' && target && existsSync(join(target, 'ready')) ? readFileSync(join(target, 'ready'), 'utf8').trim() : target
    if (['prepare', 'sign-in', 'start', 'finish'].includes(cmd) && id) {
      log(`stopped by ${sig}: wiping the credentials off ${id}`)
      await wipeAll(id).catch(() => {})
    }
    process.exit(130)
  })
}
try {
  if (cmd === 'create') await create()
  else if (cmd === 'prepare') await prepare(target)
  else if (cmd === 'sign-in') await signIn(target, arg('app', 'codex'))
  else if (cmd === 'look') await look(target)
  else if (cmd === 'upload') await upload(target)
  else if (cmd === 'check-claude') await checkClaude(target)
  else if (cmd === 'site') await step(target, 'site')
  else if (cmd === 'clear') await clearScreen(target, arg('browser', 'safari'))
  else if (cmd === 'step') await step(target, argv.slice(2).join(' '))
  else if (cmd === 'start') {
    try {
      await start(target)
    } catch (err) {
      await wipeAll(target)
      throw err
    }
  } else if (cmd === 'finish') {
    try {
      await finish(target)
    } catch (err) {
      const id = existsSync(join(target, 'ready')) ? readFileSync(join(target, 'ready'), 'utf8').trim() : null
      if (id) await wipeAll(id)
      throw err
    }
  } else if (cmd === 'wipe') await wipeAll(target)
  else if (cmd === 'destroy') await destroy(target)
  else if (cmd === 'ledger') console.log(`${writeLedger(ledger())} Mac-minutes used of ${BUDGET}`)
  else console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 16).join('\n'))
} catch (err) {
  console.error(`failed: ${redact(err?.message ?? String(err))}`)
  process.exitCode = 1
}
