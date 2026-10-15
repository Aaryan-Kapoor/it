import { spawn } from 'node:child_process'
import path from 'node:path'

/** Asks zsh after it reads .zshenv, including a ZDOTDIR it did not export. */
export async function zshDirectory(env: NodeJS.ProcessEnv = process.env, timeoutMs = 5_000): Promise<string | undefined> {
  const shell = env.SHELL
  if (!shell || path.basename(shell) !== 'zsh' || !path.isAbsolute(shell)) return undefined
  return new Promise((resolve) => {
    const mark = 'it-zdotdir-56e730c1'
    // The value is expanded by zsh itself, so a shell-local ZDOTDIR is visible.
    const child = spawn(shell, ['-c', `printf '\\0${mark}%s\\0' "\${ZDOTDIR-$HOME}"`], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    })
    let out = ''
    let timedOut = false
    const quit = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      quit()
      child.stdout.destroy()
      resolve(undefined)
    }, timeoutMs)
    child.stdout.on('data', (data: Buffer) => {
      out += data.toString('utf8')
      if (out.length > 64 * 1024) {
        timedOut = true
        quit()
      }
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const at = out.lastIndexOf(`\0${mark}`)
      const value = at < 0 ? '' : out.slice(at + mark.length + 1).split('\0')[0]!
      resolve(!timedOut && code === 0 && path.isAbsolute(value) && !/[\r\n]/.test(value) ? value : undefined)
    })
  })
}
