// Opening the address that pairs a browser in the person's own browser, on the machine It runs
// on: whether to, and how. Kept apart from the commands so that each case can be tried by itself,
// with the system's opener stood in for.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inHome, writePrivate } from './lib'
import { inWsl } from './service'

/**
 * How long one opening stands for an agent's commands: the ten minutes a pairing code lives. An
 * agent that asks for the link again within them is given the link and opens no second tab.
 */
export const OPENED_FOR_MS = 600_000
/** How recently a paired display has to have been seen for a browser to be taken as already open to It. The backend takes a display unseen for this long to have closed the site. */
export const SEEN_LATELY_MS = 600_000
/** How long the opener is given to fail before it is taken to have done its work. */
const OPENER_FAILS_WITHIN_MS = 1000

/** The note of when a browser was last opened here, and how that went, by a code. It holds nothing of the address. */
export const openedFile = () => inHome('browser-opened.json')

/** What is looked at of the machine: given by the tests. */
export interface Surroundings {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Whether a file is there. */
  exists: (file: string) => boolean
  /** The kernel's release, which tells WSL. */
  release: string
}
export const surroundings = (): Surroundings => ({ platform: process.platform, env: process.env, exists: existsSync, release: os.release() })

/** What a variable holds, read as `usage.ts` reads CI: anything but empty and the few values that plainly mean "no". */
const said = (env: NodeJS.ProcessEnv, name: string): boolean =>
  !['', '0', 'false', 'no', 'off'].includes((env[name] ?? '').replace(/^[\s'"]+|[\s'"]+$/g, '').toLowerCase())

/** The variables that systems which build and test software set, where nobody sits at the screen. */
const CI = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TF_BUILD', 'JENKINS_URL', 'TEAMCITY_VERSION']
/** The variables that development environments run elsewhere set: Codespaces, a dev container, Gitpod and Cloud Shell. */
const REMOTE = ['CODESPACES', 'REMOTE_CONTAINERS', 'GITPOD_WORKSPACE_ID', 'CLOUD_SHELL']

/**
 * The stand-in for the system's opener that the tests name: a JSON list of a program and the
 * words it is given first, to which the address is added as one more word. Nothing where none is
 * named, and null where what is named is not such a list.
 */
function standIn(env: NodeJS.ProcessEnv): string[] | null | undefined {
  const named = env.IT_BROWSER_OPENER
  if (!named) return undefined
  try {
    const list = JSON.parse(named) as unknown
    return Array.isArray(list) && list.length > 0 && list.every((word) => typeof word === 'string' && word.length > 0) ? (list as string[]) : null
  } catch {
    return null
  }
}

/**
 * Why nobody is taken to be at this machine's screen with a browser to open, or null where one
 * plausibly is. Over SSH the browser would open on a screen nobody is at; in CI, in a container,
 * in Codespaces or a dev container, there is no screen of the person's at all; on Linux with
 * neither X nor Wayland named there is none either, and with no `xdg-open` nothing to open one
 * with. Inside WSL the address would have to be opened by Windows, and whether Windows reaches
 * It at it depends on settings of WSL's that cannot be read from here, so the link is printed only.
 */
export function noScreen(s: Surroundings): 'ssh' | 'ci' | 'remote' | 'container' | 'wsl' | 'no_screen' | 'no_opener' | null {
  const { env } = s
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return 'ssh'
  if (CI.some((name) => said(env, name))) return 'ci'
  if (REMOTE.some((name) => said(env, name))) return 'remote'
  if (s.platform === 'darwin' || s.platform === 'win32') return standIn(env) === null ? 'no_opener' : null
  if (env.container || s.exists('/.dockerenv') || s.exists('/run/.containerenv')) return 'container'
  if (inWsl(s.platform, env, s.release)) return 'wsl'
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return 'no_screen'
  const stood = standIn(env)
  if (stood === null) return 'no_opener'
  if (stood) return null
  const found = (env.PATH ?? '').split(path.delimiter).some((dir) => dir && s.exists(path.join(dir, 'xdg-open')))
  return found ? null : 'no_opener'
}

/**
 * The program that opens an address, and the words it is given, the address among them as one
 * word of its own. Never through a shell: the address carries a code. On Windows `start` is a
 * shell command, so the system's own handler for addresses is called directly instead.
 */
export function opener(url: string, s: Pick<Surroundings, 'platform' | 'env'>): [string, string[]] {
  const stood = standIn(s.env)
  if (stood) return [stood[0]!, [...stood.slice(1), url]]
  return s.platform === 'darwin' ? ['open', [url]] : s.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]]
}

/** How a program is started: `spawn`, or what the tests give in its place. */
export type Start = (cmd: string, args: string[], options: { stdio: 'ignore'; detached: true; shell: false; windowsHide: true }) => ChildProcess

/**
 * Starts the opener with the address, and says how that went, as a code: `opened` where it was
 * started and did not fail within a second, and otherwise the system's code for why it could not
 * be started or the status it ended with. Nothing of the address is in what it says.
 */
export function launch(url: string, s: Pick<Surroundings, 'platform' | 'env'>, start: Start = spawn as Start): Promise<string> {
  const [cmd, args] = opener(url, s)
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = start(cmd, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true })
    } catch (err) {
      return resolve(codeOf(err))
    }
    const timer = setTimeout(() => {
      child.unref()
      resolve('opened')
    }, OPENER_FAILS_WITHIN_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve(codeOf(err))
    })
    child.on('exit', (status, signal) => {
      clearTimeout(timer)
      resolve(status === 0 ? 'opened' : status !== null ? `exit_${status}` : `signal_${signal ?? 'unknown'}`)
    })
  })
}
const codeOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'not_started'
}

/**
 * Whether a display paired with It has been seen lately, as `displays:list` gives them: a browser
 * is already open to It, and opening another would only add a tab. Where the list is not one, as
 * where It could not be asked, that is taken for yes, and nothing is opened.
 */
export function seenLately(displays: unknown, now: number): boolean {
  if (!Array.isArray(displays)) return true
  return displays.some((d) => {
    const seen = (d as { lastSeenAt?: unknown } | null)?.lastSeenAt
    return (d as { paired?: unknown } | null)?.paired !== false && typeof seen === 'number' && now - seen < SEEN_LATELY_MS
  })
}

/**
 * Takes the one opening that the ten minutes allow, by making the note of it, and says whether
 * it was taken. A note made less than ten minutes ago, either way of the clock, means it was
 * taken already. A note that is there and cannot be read is never taken for no note: it may be
 * one that another command is writing at this moment. An older note is put aside first by a
 * rename, which only one command can do, and the new one is made only where no file has the name.
 * So of commands run together, at most one opens a browser, and where It's folder cannot be
 * written, as in a sandbox that keeps it read-only, none does.
 */
export function takeOpening(file: string, now: number): boolean {
  let text: string | undefined
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  if (text !== undefined) {
    let at: unknown
    try {
      at = (JSON.parse(text) as { at?: unknown } | null)?.at
    } catch {
      return false
    }
    if (typeof at !== 'number' || !Number.isFinite(at) || Math.abs(now - at) < OPENED_FOR_MS) return false
    const aside = `${file}.${randomBytes(8).toString('hex')}.old`
    try {
      renameSync(file, aside)
    } catch {
      return false
    }
    rmSync(aside, { force: true })
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const fd = openSync(file, 'wx', 0o600)
    try {
      writeSync(fd, JSON.stringify({ at: now }))
    } finally {
      closeSync(fd)
    }
    return true
  } catch {
    return false
  }
}

/** Notes how the opening went, by its code. A note that cannot be written leaves the one made when the opening was taken, which stands as well. */
function noteHow(file: string, at: number, result: string): void {
  try {
    writePrivate(file, { at, result })
  } catch {}
}

export interface Asked {
  /** `--no-open` was given. */
  noOpen: boolean
  /** Standard output is a terminal. */
  terminal: boolean
  /** An agent app marked the command as its agent's (`sessionAsked`). */
  agent: boolean
  /** This machine joined an It on another computer, whose site this would be. */
  joined: boolean
  /** The displays as `displays:list` gives them, asked only where an agent ran the command. */
  displays: () => Promise<unknown>
}

/**
 * Opens the address that pairs a browser in the person's browser on this machine, where that is
 * wanted, and says whether it did. Not with `--no-open`; not for a script, which is a command
 * whose output is no terminal and which no agent ran; not on a machine that joined another's It;
 * and not where nobody is taken to be at the screen (`noScreen`). For an agent's command, also
 * not where a paired display has been seen in the last ten minutes, and not more than once in
 * ten minutes, whichever commands ask. A person who runs `it site` at a terminal asked for the
 * browser in so many words, and is not held to those two. Nothing of the address is kept or said.
 */
export async function openPairing(
  url: string,
  asked: Asked,
  s: Surroundings = surroundings(),
  start: Start = spawn as Start,
  file: string = openedFile(),
  now: number = Date.now(),
): Promise<boolean> {
  if (asked.noOpen || (!asked.terminal && !asked.agent) || asked.joined || noScreen(s) !== null) return false
  if (asked.agent) {
    const displays = await asked.displays().catch(() => null)
    if (seenLately(displays, now) || !takeOpening(file, now)) return false
  }
  const result = await launch(url, s, start)
  noteHow(file, now, result)
  return result === 'opened'
}
