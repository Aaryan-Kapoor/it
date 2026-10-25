// Zsh for the tests that ask it which folder it reads .zshrc from: the real one where this
// machine has it, and a stand-in that runs wherever /bin/sh does.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ZSH_ANSWER } from './src/shell-profile'

/** The zsh on this machine, or the one IT_TEST_ZSH names. */
export const zsh = [process.env.IT_TEST_ZSH, '/bin/zsh', '/usr/bin/zsh'].find((file): file is string => Boolean(file && existsSync(file)))

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`

/**
 * Puts a program called zsh in a folder, to be named by SHELL. It reads the person's .zshenv as
 * zsh would, which works for one written in plain sh, and then says the folder that is left in
 * ZDOTDIR, or else the home folder, as It asks zsh to. It notes the words it was started with,
 * one to a line, in `zsh arguments` beside it.
 */
export function standInZsh(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'zsh')
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${quote(path.join(dir, 'zsh arguments'))}`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: The literal is shell source.
      'if [ -r "${ZDOTDIR-$HOME}/.zshenv" ]; then . "${ZDOTDIR-$HOME}/.zshenv"; fi',
      `printf '\\0${ZSH_ANSWER}%s\\0' "\${ZDOTDIR-$HOME}"`,
      '',
    ].join('\n'),
  )
  chmodSync(file, 0o755)
  return file
}
