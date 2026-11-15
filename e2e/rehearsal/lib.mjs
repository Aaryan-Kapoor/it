// What every rehearsal run shares: the throwaway profile and what its programs are given, the
// programs it starts and stops by their own process ids, the screen recording, the steps it
// writes down, and the run's result.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { homeOnWindows, nodeAlone, systemPath } from '../apps/windows.mjs'
import { scrub } from './credentials.mjs'

export const here = path.dirname(fileURLToPath(import.meta.url))
export const repo = path.resolve(here, '..', '..')
export const RESULTS = process.env.IT_REHEARSAL_RESULTS || 'D:\\it-rehearsal\\2026-11-15'
export const WORK = process.env.IT_REHEARSAL_WORK || 'D:\\it-rehearsal\\work'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const stamp = () => new Date().toISOString()

/** The folders of a run: its results (kept) and its throwaway profile (deleted at the end). */
export function runFolders(id, profileName = 'rehearsal') {
  const results = path.join(RESULTS, id)
  const top = path.join(WORK, 'runs', id)
  const home = path.join(top, profileName)
  const f = {
    id,
    results,
    top,
    home,
    itHome: path.join(home, '.it'),
    codexHome: path.join(home, '.codex'),
    work: path.join(home, 'project'),
    noT3: path.join(top, 'no-t3-code'),
    browserProfile: path.join(top, 'browser'),
    viewProfile: path.join(top, 'terminal-view'),
    logs: path.join(results, 'logs'),
  }
  for (const d of [results, home, f.work, f.noT3, f.logs]) mkdirSync(d, { recursive: true })
  return f
}

/**
 * What every program of the run is given, and nothing else of this process's surroundings: a
 * home of the run's own (every folder Windows programs read and write points into it), It's
 * folder and port, an empty T3CODE_HOME, and a PATH with the guard first (where `guard` is on),
 * the agent app's own folder, a Node of its own, and the system's folders.
 */
export function profileEnv(f, { port, appBin, guard = true, extra = {} }) {
  const guardDir = path.join(WORK, 'guard')
  const env = {
    PATH: [...(guard ? [guardDir] : []), ...(appBin ? [appBin] : []), nodeAlone(path.join(f.top, 'node')), ...systemPath()].join(';'),
    HOME: f.home,
    ...homeOnWindows(f.home),
    IT_HOME: f.itHome,
    IT_PORT: String(port),
    T3CODE_HOME: f.noT3,
    CODEX_HOME: f.codexHome,
    XDG_CONFIG_HOME: path.join(f.home, '.config'),
    XDG_DATA_HOME: path.join(f.home, '.local', 'share'),
    XDG_STATE_HOME: path.join(f.home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(f.home, '.cache'),
    npm_config_cache: path.join(f.home, 'AppData', 'Local', 'npm-cache'),
    npm_config_prefix: path.join(f.home, 'AppData', 'Roaming', 'npm'),
    // Usage counts of a rehearsal are not the owner's to send
    IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
    USERNAME: os.userInfo().username,
    COMPUTERNAME: process.env.COMPUTERNAME ?? '',
    USERDOMAIN: process.env.USERDOMAIN ?? '',
    LANG: 'C.UTF-8',
    ...(guard
      ? {
          IT_REHEARSAL_GUARD: 'owner',
          IT_REHEARSAL_REAL_IT: path.join(f.itHome, 'bin', 'it.exe'),
          IT_REHEARSAL_GUARD_LOG: path.join(f.logs, 'guard.log'),
        }
      : {}),
    ...extra,
  }
  mkdirSync(env.CODEX_HOME, { recursive: true })
  return env
}

/** Runs a program to its end within `ms`, and resolves with its exit code and what it printed. */
export function run(command, argv, { env, cwd, input, ms = 300_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { env, cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    if (input !== undefined) child.stdin.end(input)
    const late = setTimeout(() => killTree(child.pid), ms)
    child.on('error', (e) => {
      clearTimeout(late)
      resolve({ code: null, out, err: `${err}${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(late)
      resolve({ code, out, err })
    })
  })
}

/** Ends a process this run started, and what it started, by its own process id. */
export function killTree(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

/** Waits for a child to end, asking and then ending it by its process id after `ms`. */
export function stopChild(child, ms = 8000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve()
    const hard = setTimeout(() => killTree(child.pid), ms)
    const never = setTimeout(resolve, ms + 5000)
    child.once('close', () => {
      clearTimeout(hard)
      clearTimeout(never)
      resolve()
    })
    spawnSync('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore', windowsHide: true })
  })
}

/**
 * The processes left whose program is in, or whose command line names, the run's own folder:
 * only their ids and program names are kept, never a command line, since the listing also holds
 * the owner's own processes.
 */
export function leftIn(folder) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  )
  let all = []
  try {
    all = [JSON.parse(r.stdout)].flat()
  } catch {
    return null
  }
  const at = folder.toLowerCase()
  return all
    .filter((p) => p.ProcessId !== process.pid && !/Get-CimInstance/.test(p.CommandLine ?? ''))
    .filter((p) => String(p.ExecutablePath ?? '').toLowerCase().startsWith(at) || String(p.CommandLine ?? '').toLowerCase().includes(at))
    .map((p) => ({ pid: p.ProcessId, name: p.Name }))
}

/**
 * A fingerprint of the owner's scheduled tasks for It and of whether the owner's It has been
 * asked to stop: the hash of what Task Scheduler says of every task whose name begins `it`, and
 * whether a `service.stop` file is in the owner's It folder. Nothing of either is printed or
 * kept but the hash and the yes or no.
 */
export function ownerFingerprint() {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -like 'it*' } | ForEach-Object { $_.TaskName + '|' + $_.State + '|' + (Export-ScheduledTask -TaskName $_.TaskName -TaskPath '\\') } | Out-String",
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  )
  const tasks = createHash('sha256').update(r.stdout ?? '').digest('hex').slice(0, 16)
  const count = (r.stdout?.match(/^it[^|]*\|/gm) ?? []).length
  const stop = existsSync(path.join(os.userInfo().homedir, '.it', 'service.stop'))
  return { tasks, count, ownerStopAsked: stop }
}

/** The screen, recorded with ffmpeg from the desktop, above the taskbar, at 12 frames a second, about 1600 pixels wide. */
export function recorder(file, { width = 2560, height = 1376 } = {}) {
  const child = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'gdigrab',
      '-framerate',
      '12',
      '-offset_x',
      '0',
      '-offset_y',
      '0',
      '-video_size',
      `${width}x${height}`,
      '-draw_mouse',
      '1',
      '-i',
      'desktop',
      '-vf',
      'scale=1600:-2',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-y',
      file,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
  )
  let err = ''
  child.stderr.on('data', (d) => (err += d))
  const started = Date.now()
  return {
    started,
    child,
    at: () => (Date.now() - started) / 1000,
    async stop() {
      if (child.exitCode !== null) return err
      child.stdin.write('q')
      await new Promise((r) => {
        const t = setTimeout(() => {
          killTree(child.pid)
          r()
        }, 20_000)
        child.once('close', () => {
          clearTimeout(t)
          r()
        })
      })
      return err
    },
  }
}

/** The steps of a run, each with its time in the video and what was seen, written as they come. */
export function stepLog(f, rec) {
  const steps = []
  const file = path.join(f.results, 'steps.log')
  const log = (name, seen = '', ok = true) => {
    const t = rec ? Math.round(rec.at() * 10) / 10 : null
    const step = { at: stamp(), video: t, name, ok, seen: scrub(String(seen)).text.slice(0, 2000) }
    steps.push(step)
    const mmss = t === null ? '--:--' : `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`
    const line = `${mmss} ${ok ? 'ok  ' : 'FAIL'} ${name}${seen ? ` — ${step.seen.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`
    console.log(line)
    appendFileSync(file, `${line}\n`)
    return ok
  }
  return { steps, log }
}

/** Writes the run's result.json. */
export function writeResult(f, result) {
  writeFileSync(path.join(f.results, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
}

/** Copies a log into the run's results, scrubbed of anything shaped like a token, and says how many were taken out. */
export function keepLog(from, name, f) {
  if (!existsSync(from)) return 0
  const { text, found } = scrub(readFileSync(from, 'utf8'))
  writeFileSync(path.join(f.logs, name), text)
  return found
}

export { copyFileSync, execFileSync }
