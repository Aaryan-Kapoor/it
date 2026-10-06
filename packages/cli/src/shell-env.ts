/**
 * What the person's own shell would add to this program's environment.
 *
 * The background service is started by the system, and the system gives it next to nothing:
 * a PATH, a home, and what the service's definition names. What a person exports in their
 * shell's own files (`~/.profile`, `~/.bashrc`, `~/.zshrc` and the like) is in every terminal
 * they open and in no service. An agent app that takes its key or its proxy from such a
 * variable works in their terminal and fails when this program reopens it, with nothing to
 * say why. So the shell is asked once what it would give a program, as an editor that is
 * started from the desktop asks it, and what it has that this program lacks is added for the
 * apps this program runs. Nothing this program already has is changed by it, nothing of it is
 * written anywhere, and where the shell cannot be asked the apps get what the service has.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const MARK = 'it-env-7c1d9e42'
/** Variables a shell sets for itself, and those this asking sets: never taken for the person's. */
const NOT_THEIRS = /^(_|SHLVL|PWD|OLDPWD|IT_ENV_[0-9]+|IT_RESOLVING_ENVIRONMENT|IT_SESSION|IT_HARNESS)$/

/** Prints this program's environment between two marks: what the shell is asked to run. */
export function printEnv(): void {
  process.stdout.write(`${MARK}${JSON.stringify(process.env)}${MARK}`)
}

/**
 * How a shell is started so that it reads the files a terminal's shell reads, most telling
 * first. Null for a shell this does not know how to ask.
 */
export function shellFlags(shell: string): string[][] | null {
  const name = path
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (/^(pwsh|powershell|cmd)$/.test(name)) return null
  if (/^t?csh$/.test(name)) return [['-ic'], ['-c']]
  // As a terminal starts it, and then as a login alone: a shell whose own files wait for a
  // terminal, or hand over to another shell, answers nothing the first way
  return [
    ['-i', '-l', '-c'],
    ['-l', '-c'],
  ]
}

function ask(shell: string, flags: string[], self: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<NodeJS.ProcessEnv | null> {
  return new Promise((resolve) => {
    let out = ''
    let over = false
    const end = (found: NodeJS.ProcessEnv | null) => {
      if (over) return
      over = true
      clearTimeout(timer)
      resolve(found)
    }
    // The program is named in variables and not in the command's text, so that no shell has a path to quote
    const named = Object.fromEntries(self.map((part, i) => [`IT_ENV_${i}`, part]))
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, [...flags, `${self.map((_, i) => `"$IT_ENV_${i}"`).join(' ')} shell-env`], {
        env: { ...env, ...named, IT_RESOLVING_ENVIRONMENT: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
        // In a session of its own: a shell that is started as a terminal's would otherwise
        // reach for the terminal this program was started from, if it was from one
        detached: true,
        windowsHide: true,
      })
    } catch {
      return resolve(null)
    }
    const quit = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      quit()
      end(null)
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8')
      if (out.length > 4_000_000) {
        quit()
        end(null)
      }
    })
    child.once('error', () => end(null))
    child.once('close', () => {
      const from = out.indexOf(MARK)
      const to = out.lastIndexOf(MARK)
      if (from < 0 || to <= from) return end(null)
      try {
        const found = JSON.parse(out.slice(from + MARK.length, to)) as unknown
        end(found && typeof found === 'object' && !Array.isArray(found) ? (found as NodeJS.ProcessEnv) : null)
      } catch {
        end(null)
      }
    })
  })
}

/**
 * Asks the person's shell for the environment it gives a program. Null where it could not be
 * asked: on Windows, where a service has the person's variables already, with a shell this
 * does not know, or with one that did not answer in time.
 */
export async function shellEnv(
  opts: { shell?: string; self?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<NodeJS.ProcessEnv | null> {
  if ((opts.platform ?? process.platform) === 'win32') return null
  const env = opts.env ?? process.env
  let shell = opts.shell ?? env.SHELL
  if (!shell) {
    try {
      shell = os.userInfo().shell ?? undefined
    } catch {}
  }
  if (!shell || !path.isAbsolute(shell)) return null
  const ways = shellFlags(shell)
  if (!ways) return null
  const script = process.argv[1]
  const self = opts.self ?? [process.execPath, ...(script !== undefined && /\.(m?js|ts)$/.test(script) ? [path.resolve(script)] : [])]
  for (const flags of ways) {
    const found = await ask(shell, flags, self, env, opts.timeoutMs ?? 8_000)
    if (found) return found
  }
  return null
}

/**
 * What of the shell's environment is added to this program's own: every variable this program
 * lacks, and the folders of the shell's PATH that its own PATH lacks, after its own. What this
 * program has is never changed.
 */
export function added(own: NodeJS.ProcessEnv, shell: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const more: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(shell)) {
    if (typeof value !== 'string' || NOT_THEIRS.test(key) || key === 'PATH' || own[key] !== undefined) continue
    more[key] = value
  }
  const sep = platform === 'win32' ? ';' : ':'
  const mine = (own.PATH ?? '').split(sep).filter(Boolean)
  const theirs = (shell.PATH ?? '').split(sep).filter((dir) => dir && !mine.includes(dir))
  if (theirs.length) more.PATH = [...mine, ...new Set(theirs)].join(sep)
  return more
}
