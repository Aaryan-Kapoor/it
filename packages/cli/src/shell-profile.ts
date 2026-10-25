import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** What zsh's answer is marked with, among whatever its startup files print. */
export const ZSH_ANSWER = 'it-zdotdir-56e730c1'

/**
 * The .zshenv of the folder It gives zsh as its ZDOTDIR. It puts back the ZDOTDIR that the
 * person's zsh has once the system's zshenv has run, which It passes in IT_ZDOTDIR_SET and
 * IT_ZDOTDIR_WAS, and reads the person's .zshenv from there as zsh would. Zsh then goes on as it
 * always does, to the system's zshrc and then to the .zshrc of the folder ZDOTDIR names by then,
 * and the trap says that folder and ends zsh before the first command of that .zshrc runs. All of
 * it is one block, read before anything of the person's runs, so that nothing they define can
 * change how it is read. Inside a startup file, an error or `setopt err_exit` in .zshenv does not
 * end zsh, as it does not in any other start.
 */
const PROBE = `{
  if [[ -n \${IT_ZDOTDIR_SET-} ]]; then ZDOTDIR=$IT_ZDOTDIR_WAS; else unset ZDOTDIR; fi
  unset IT_ZDOTDIR_SET IT_ZDOTDIR_WAS
  {
    if [[ -r "\${ZDOTDIR-$HOME}/.zshenv" ]]; then builtin source "\${ZDOTDIR-$HOME}/.zshenv"; fi
  } always {
    builtin setopt debug_before_cmd
    builtin trap '[[ \${(%):-%x} == "\${ZDOTDIR-$HOME}/.zshrc" ]] && { builtin printf "\\0${ZSH_ANSWER}%s\\0" "\${ZDOTDIR-$HOME}"; builtin exit 0; }' DEBUG
  }
}
`

/** Says ZDOTDIR as the system's zshenv leaves it: `=` and the folder, or `-` where it is not set. */
const LEFT = `if [[ -n \${ZDOTDIR+set} ]]; then builtin printf '\\0${ZSH_ANSWER}=%s\\0' "$ZDOTDIR"; else builtin printf '\\0${ZSH_ANSWER}-\\0'; fi`

/**
 * Asked of a zsh started with -p, after the system's zshenv has run with RCS set and nothing of
 * the person's has. It reads the person's .zshenv from the folder the system's zshenv chose, and
 * says the folder ZDOTDIR names then. The options that -p and no_global_rcs changed are put back
 * first, so that .zshenv sees them as in any start. Where .zshenv unsets RCS, zsh reads no .zshrc,
 * and nothing is said.
 */
const NARROWER = `builtin unsetopt privileged; builtin setopt global_rcs; { if [[ -r "\${ZDOTDIR-$HOME}/.zshenv" ]]; then builtin source "\${ZDOTDIR-$HOME}/.zshenv"; fi; } always { if [[ -o rcs ]]; then builtin printf '\\0${ZSH_ANSWER}%s\\0' "\${ZDOTDIR-$HOME}"; fi; }`

/**
 * Run once startup is over, which is only where no command of any .zshrc was reached: a .zshrc
 * that is not there or holds none. It says the folder as long as zsh would have read a .zshrc
 * there, the probe's .zshenv ran, and its trap was still set, so that no .zshrc ran unseen.
 */
const after = (probe: string) =>
  `if [[ -o rcs && \${ZDOTDIR-} != '${probe.replaceAll("'", `'\\''`)}' && "$(builtin trap)" == *${ZSH_ANSWER}* ]]; then builtin printf '\\0${ZSH_ANSWER}%s\\0' "\${ZDOTDIR-$HOME}"; fi`

/**
 * Asks zsh for the folder a new interactive zsh reads .zshrc from, without running any .zshrc:
 * the ZDOTDIR in effect once the system's zshenv, the person's .zshenv and the system's zshrc have
 * run, whether or not it was exported, or else the home folder.
 *
 * Zsh is started as an ordinary interactive shell, with the options it always starts with, and
 * with ZDOTDIR naming a folder of It's own whose .zshenv is PROBE. The system's zshenv runs first
 * and sees that folder in ZDOTDIR, so it is asked twice beforehand, with -p, which keeps zsh from
 * reading anything of the person's and from the system's zshrc: once with the person's ZDOTDIR,
 * to learn what it makes of that, and once with It's folder, which it must leave as it is.
 *
 * A system zshenv that sets ZDOTDIR of its own, as one may to keep everyone's zsh files in
 * ~/.config/zsh, would send zsh past It's folder and into the person's own .zshrc. Zsh is then
 * asked something narrower instead: the folder that the person's .zshenv leaves, read in the
 * folder the system's zshenv chose. That cannot see a system zshrc that changes ZDOTDIR once more,
 * which should be rare where the system's zshenv has already chosen it. There is no answer only
 * where even that cannot be learned: where zsh fails, hangs or ends before it says.
 *
 * A login shell would also read .zprofile, which is not read here. All the starts share one bound.
 */
export async function zshDirectory(env: NodeJS.ProcessEnv = process.env, timeoutMs = 5_000): Promise<string | undefined> {
  const shell = env.SHELL
  if (!shell || path.basename(shell) !== 'zsh' || !path.isAbsolute(shell)) return undefined
  const until = Date.now() + timeoutMs
  const { IT_ZDOTDIR_SET: _set, IT_ZDOTDIR_WAS: _was, ...theirs } = env
  let probe: string
  try {
    probe = mkdtempSync(path.join(os.tmpdir(), 'it-zsh-'))
    writeFileSync(path.join(probe, '.zshenv'), PROBE)
  } catch {
    return undefined
  }
  try {
    const systemOnly = ['-p', '-i', '-o', 'no_global_rcs', '-c', LEFT]
    const [left, kept] = await Promise.all([ask(shell, systemOnly, theirs, until), ask(shell, systemOnly, { ...theirs, ZDOTDIR: probe }, until)])
    if (kept === undefined || (left !== '-' && !left?.startsWith('='))) return undefined
    const was = left === '-' ? {} : { IT_ZDOTDIR_SET: '1', IT_ZDOTDIR_WAS: left.slice(1) }
    const answer =
      kept === `=${probe}`
        ? await ask(shell, ['-i', '-c', after(probe)], { ...theirs, ZDOTDIR: probe, ...was }, until)
        : await ask(shell, ['-p', '-i', '-o', 'no_global_rcs', '-c', NARROWER], theirs, until)
    return answer !== undefined && path.isAbsolute(answer) && !/[\r\n]/.test(answer) ? answer : undefined
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

/** Starts zsh and returns what it marked as its answer, or nothing if it gave none by `until`. */
function ask(shell: string, args: string[], env: NodeJS.ProcessEnv, until: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(shell, args, { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    let out = ''
    let settled = false
    const finish = (value: string | undefined, quit: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Whatever is still running in the shell's process group was started for this question, and
      // a job a startup file left there may be holding the output open after the shell has gone.
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
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined, true), Math.max(0, until - Date.now()))
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
