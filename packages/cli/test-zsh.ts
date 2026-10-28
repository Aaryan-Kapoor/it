// Zsh for the tests that ask it which folder it reads .zshrc from: the real one where this
// machine has it, and a stand-in that runs wherever /bin/sh does.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ZSH_ANSWER } from './src/shell-profile'

/** The zsh on this machine, or the one IT_TEST_ZSH names. */
export const zsh = [process.env.IT_TEST_ZSH, '/bin/zsh', '/usr/bin/zsh'].find((file): file is string => Boolean(file && existsSync(file)))
/**
 * The folder that zsh reads its system-wide zshenv and zshrc from, where a test may write them.
 * That is never the system's own folder, so it is given only with a zsh built or changed to read
 * them from another one, in IT_TEST_ZSH_ETC.
 */
export const zshEtc = zsh && zsh === process.env.IT_TEST_ZSH ? process.env.IT_TEST_ZSH_ETC : undefined

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`

/**
 * Puts a program called zsh in a folder, to be named by SHELL. It does in plain sh what It relies
 * on zsh to do, with startup files written in plain sh, and its system-wide zshenv and zshrc are
 * the files `zshenv` and `zshrc` beside it. Started with -p, it reads the system's zshenv and says
 * what ZDOTDIR is then, or, where the script it is given reads .zshenv, it reads the person's
 * .zshenv from there as well and says the folder ZDOTDIR names after that. Started otherwise, it
 * reads the system's zshenv, and where ZDOTDIR is still the folder It gave it, it puts back the
 * ZDOTDIR It names, reads the person's .zshenv and then the system's zshrc, and says the folder
 * whose .zshrc zsh would read next. Where the system's zshenv set ZDOTDIR to another folder, it
 * reads that folder's .zshenv, the system's zshrc and the .zshrc, as zsh would, and says nothing.
 * It adds the words of each start as one line to `zsh arguments` beside it.
 */
export function standInZsh(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'zsh')
  const here = quote(dir)
  writeFileSync(
    file,
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: The literals are shell source.
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${quote(path.join(dir, 'zsh arguments'))}`,
      'given=${ZDOTDIR-}',
      `if [ -r ${here}/zshenv ]; then . ${here}/zshenv; fi`,
      'if [ "$1" = -p ]; then',
      '  case "$*" in',
      '  *.zshenv*)',
      '    if [ -r "${ZDOTDIR-$HOME}/.zshenv" ]; then . "${ZDOTDIR-$HOME}/.zshenv"; fi',
      `    printf '\\0${ZSH_ANSWER}%s\\0' "\${ZDOTDIR-$HOME}" ;;`,
      `  *) if [ -n "\${ZDOTDIR+set}" ]; then printf '\\0${ZSH_ANSWER}=%s\\0' "$ZDOTDIR"; else printf '\\0${ZSH_ANSWER}-\\0'; fi ;;`,
      '  esac',
      '  exit 0',
      'fi',
      'if [ "${ZDOTDIR-}" = "$given" ]; then',
      '  if [ -n "${IT_ZDOTDIR_SET-}" ]; then ZDOTDIR=$IT_ZDOTDIR_WAS; else unset ZDOTDIR; fi',
      '  unset IT_ZDOTDIR_SET IT_ZDOTDIR_WAS',
      '  if [ -r "${ZDOTDIR-$HOME}/.zshenv" ]; then . "${ZDOTDIR-$HOME}/.zshenv"; fi',
      `  if [ -r ${here}/zshrc ]; then . ${here}/zshrc; fi`,
      `  printf '\\0${ZSH_ANSWER}%s\\0' "\${ZDOTDIR-$HOME}"`,
      '  exit 0',
      'fi',
      'if [ -r "${ZDOTDIR-$HOME}/.zshenv" ]; then . "${ZDOTDIR-$HOME}/.zshenv"; fi',
      `if [ -r ${here}/zshrc ]; then . ${here}/zshrc; fi`,
      'if [ -r "${ZDOTDIR-$HOME}/.zshrc" ]; then . "${ZDOTDIR-$HOME}/.zshrc"; fi',
      '',
    ].join('\n'),
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: The literals are shell source.
  )
  chmodSync(file, 0o755)
  return file
}
