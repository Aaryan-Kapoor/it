// What the person in a rehearsal container uses: the terminal the agent app runs in (through
// tmux), a headed browser on the virtual display (through Playwright), a clock that every step is
// written down against, and short pauses after each thing they do, so that a viewer can follow.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const T0 = Date.now()
export const since = () => Math.round((Date.now() - T0) / 100) / 10

let runDir = '/tmp'
export function setRunDir(d) {
  runDir = d
  mkdirSync(d, { recursive: true })
}
export function runPath(name) {
  return join(runDir, name)
}

/** Writes one step down, with the time on the video's clock (seconds since the run began). */
export function step(name, seen = {}, ok = true) {
  const line = { t: since(), at: new Date().toISOString(), name, ok, ...seen }
  appendFileSync(join(runDir, 'steps.jsonl'), `${JSON.stringify(line)}\n`)
  console.log(`[${line.t}s] ${ok ? '' : 'FAIL '}${name} ${JSON.stringify(seen).slice(0, 300)}`)
  return line
}

// ---------- the terminal ----------
export const SESSION = 'agent'
export function tmux(...args) {
  return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
/** What the terminal shows now. */
export function screen() {
  try {
    return tmux('capture-pane', '-p', '-J', '-t', SESSION)
  } catch {
    return ''
  }
}
/** Everything the terminal has shown, scrollback included. */
export function history() {
  try {
    return tmux('capture-pane', '-p', '-J', '-S', '-', '-t', SESSION)
  } catch {
    return ''
  }
}
/** Types `text` as a person would, a few characters at a time, then waits a moment. */
export async function type(text, { enter = true } = {}) {
  for (let i = 0; i < text.length; i += 6) {
    tmux('send-keys', '-t', SESSION, '-l', '--', text.slice(i, i + 6))
    await sleep(35)
  }
  await sleep(600)
  if (enter) {
    tmux('send-keys', '-t', SESSION, 'Enter')
    await sleep(1500)
  }
}
export async function key(...keys) {
  for (const k of keys) {
    tmux('send-keys', '-t', SESSION, k)
    await sleep(350)
  }
  await sleep(900)
}
export function saveTerminal(name = 'terminal.txt') {
  writeFileSync(join(runDir, name), history())
}

// ---------- the windows ----------
export function placeWindows() {
  try {
    execFileSync('sh', ['-c', 'wmctrl -l | awk \'/xterm|rehearsal-terminal/ {print $1}\' | while read w; do wmctrl -i -r "$w" -e 0,0,0,960,1080; done'], { env: { ...process.env, DISPLAY: ':1' } })
  } catch {}
}
