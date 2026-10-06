// What the person's shell would add to the background service's environment, asked of real
// shells with files of their own in a home of their own.
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { added, shellEnv, shellFlags } from './src/shell-env'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
/** A home with a shell's files in it, and a program that prints its environment as `it shell-env` does. */
function homeWith(files: Record<string, string>): { home: string; self: string[]; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'it-shell-'))
  made.push(home)
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(home, name), text)
  const printer = path.join(home, 'print.mjs')
  writeFileSync(printer, "process.stdout.write('it-env-7c1d9e42' + JSON.stringify(process.env) + 'it-env-7c1d9e42')\n")
  chmodSync(printer, 0o755)
  // What the system gives a service: a home, a PATH, and little else
  return { home, self: [process.execPath, printer], env: { HOME: home, PATH: '/usr/bin:/bin', LOGNAME: os.userInfo().username } }
}
// The files a new account has on Debian and Ubuntu: the profile reads the shell's own file, which does nothing for a shell nobody is at
const PROFILE = 'if [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n'
const BASHRC = 'case $- in *i*) ;; *) return;; esac\n'

const bash = ['/bin/bash', '/usr/bin/bash'].find(existsSync)
const zsh = ['/bin/zsh', '/usr/bin/zsh'].find(existsSync)

describe.skipIf(process.platform === 'win32' || !bash)('what bash would give a program', () => {
  test('is what its files export, those read only by a shell someone is at included', async () => {
    const { self, env } = homeWith({
      '.profile': `${PROFILE}export FROM_PROFILE="a b"\nexport PATH="$HOME/bin:$PATH"\n`,
      '.bashrc': `${BASHRC}export MODEL_KEY=sk-from-the-shell\necho "a greeting that is no part of it"\n`,
    })
    const found = await shellEnv({ shell: bash!, self, env })
    expect(found).toMatchObject({ FROM_PROFILE: 'a b', MODEL_KEY: 'sk-from-the-shell' })
    expect(found!.PATH!.split(':')[0]).toBe(path.join(env.HOME!, 'bin'))
  })

  test('is asked for as a login alone where the shell does not answer as a terminal’s would', async () => {
    // Its own file hands over to another program, as one that starts a different shell does: asked as a terminal's, it answers nothing
    const { self, env } = homeWith({ '.profile': `${PROFILE}export FROM_PROFILE=1\n`, '.bashrc': `${BASHRC}exec true\n` })
    expect(await shellEnv({ shell: bash!, self, env })).toMatchObject({ FROM_PROFILE: '1' })
  })

  test('is nothing where its files never finish, and that is known within the time allowed', async () => {
    const { self, env } = homeWith({ '.profile': 'sleep 30\n' })
    const began = Date.now()
    expect(await shellEnv({ shell: bash!, self, env, timeoutMs: 400 })).toBeNull()
    expect(Date.now() - began).toBeLessThan(5000)
  })
})

describe.skipIf(process.platform === 'win32' || !zsh)('what zsh would give a program', () => {
  test('is what its files export', async () => {
    const { self, env } = homeWith({ '.zshrc': 'export MODEL_KEY=from-zshrc\n', '.zprofile': 'export FROM_PROFILE=1\n' })
    expect(await shellEnv({ shell: zsh!, self, env })).toMatchObject({ FROM_PROFILE: '1', MODEL_KEY: 'from-zshrc' })
  })
})

describe('what of the shell’s environment is added to the service’s own', () => {
  test('is what the service lacks, and never anything it has', () => {
    const own = { HOME: '/home/u', PATH: '/opt/it/bin:/usr/bin', LANG: 'C', IT_PORT: '4700' }
    const shell = {
      HOME: '/home/other',
      PATH: '/home/u/.nvm/bin:/usr/bin:/home/u/bin',
      LANG: 'en_US.UTF-8',
      OPENROUTER_API_KEY: 'k',
      HTTPS_PROXY: 'http://proxy:3128',
      CLAUDE_CODE_USE_BEDROCK: '1',
      // The shell's own, the asking's own, and what marks a conversation
      SHLVL: '2',
      _: '/usr/bin/env',
      PWD: '/home/u',
      IT_ENV_0: '/x/it',
      IT_RESOLVING_ENVIRONMENT: '1',
      IT_SESSION: 's',
      IT_HARNESS: 'pi',
    }
    expect(added(own, shell, 'linux')).toEqual({
      OPENROUTER_API_KEY: 'k',
      HTTPS_PROXY: 'http://proxy:3128',
      CLAUDE_CODE_USE_BEDROCK: '1',
      // Its own folders first and in their order, then the shell's that it lacks
      PATH: '/opt/it/bin:/usr/bin:/home/u/.nvm/bin:/home/u/bin',
    })
    // With nothing to add, nothing is: its PATH is not written again
    expect(added(own, { PATH: '/usr/bin', LANG: 'x' }, 'linux')).toEqual({})
  })

  test('a shell this does not know how to ask is not asked, and Windows has no need', async () => {
    expect(shellFlags('/usr/bin/pwsh')).toBeNull()
    expect(shellFlags('/bin/tcsh')).toEqual([['-ic'], ['-c']])
    expect(shellFlags('/usr/bin/fish')![0]).toEqual(['-i', '-l', '-c'])
    expect(await shellEnv({ platform: 'win32' })).toBeNull()
    expect(await shellEnv({ shell: 'bash', env: {} })).toBeNull()
  })
})
