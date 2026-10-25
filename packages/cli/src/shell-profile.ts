import { spawn } from 'node:child_process'
import path from 'node:path'

/** What zsh's answer is marked with, among whatever its startup files print. */
export const ZSH_ANSWER = 'it-zdotdir-56e730c1'

/**
 * Asks zsh for the folder a new interactive zsh reads .zshrc from: the ZDOTDIR that .zshenv
 * leaves, whether or not it was exported, or else the home folder.
 *
 * Zsh is started with -f, so that of its startup files it reads only the system's zshenv, and the
 * person's .zshenv is then read from where zsh itself would look for it. The answer is the folder
 * as it stands then, before .zshrc can run, hang or set ZDOTDIR to another folder. With -i, a
 * .zshenv that chooses the folder only for an interactive shell chooses it here too. An error in
 * .zshenv still leaves zsh going on to .zshrc, and so the folder is said after one, while an
 * `exit` there ends zsh before any .zshrc and leaves nothing to say.
 */
export async function zshDirectory(env: NodeJS.ProcessEnv = process.env, timeoutMs = 5_000): Promise<string | undefined> {
  const shell = env.SHELL
  if (!shell || path.basename(shell) !== 'zsh' || !path.isAbsolute(shell)) return undefined
  const script = [
    `{ if [[ -r "\${ZDOTDIR-$HOME}/.zshenv" ]]; then builtin source "\${ZDOTDIR-$HOME}/.zshenv"; fi; }`,
    `always { builtin printf '\\0${ZSH_ANSWER}%s\\0' "\${ZDOTDIR-$HOME}"; }`,
  ].join(' ')
  return new Promise((resolve) => {
    const child = spawn(shell, ['-f', '-i', '-c', script], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    let out = ''
    let settled = false
    const finish = (value: string | undefined, quit: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Whatever is still running in the shell's process group was started for this question, and
      // a job .zshenv left there may be holding the output open after the shell has gone.
      if (quit) {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      child.stdout.destroy()
      // A shell that cannot be ended at once does not keep this program waiting for it either.
      child.unref()
      resolve(value !== undefined && path.isAbsolute(value) && !/[\r\n]/.test(value) ? value : undefined)
    }
    const timer = setTimeout(() => finish(undefined, true), timeoutMs)
    child.stdout.on('data', (data: Buffer) => {
      out += data.toString('utf8')
      const at = out.lastIndexOf(`\0${ZSH_ANSWER}`)
      const end = at < 0 ? -1 : out.indexOf('\0', at + ZSH_ANSWER.length + 1)
      if (end >= 0) finish(out.slice(at + ZSH_ANSWER.length + 1, end), true)
      else if (out.length > 64 * 1024) finish(undefined, true)
    })
    child.once('error', () => finish(undefined, false))
    child.once('close', () => finish(undefined, false))
  })
}
