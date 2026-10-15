import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { zshDirectory } from './src/shell-profile'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'it-zdot-'))
  made.push(home)
  const dir = path.join(home, 'shell files')
  mkdirSync(dir)
  return { home, dir, env: { HOME: home, PATH: '/usr/bin:/bin' } }
}
const zsh = [process.env.IT_TEST_ZSH, '/bin/zsh', '/usr/bin/zsh'].find((file): file is string => Boolean(file && existsSync(file)))
const cli = path.resolve('packages/cli/dist/it.mjs')
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`

describe.skipIf(process.platform === 'win32' || !zsh)('zsh startup folders', () => {
  test('reads a nonexported ZDOTDIR from .zshenv despite startup output', async () => {
    const { home, dir, env } = fixture()
    writeFileSync(path.join(home, '.zshenv'), `echo welcome\nZDOTDIR=${quote(dir)}\n`)
    expect(await zshDirectory({ ...env, SHELL: zsh })).toBe(dir)
    expect(execFileSync(process.execPath, [cli, 'shell-profile'], { env: { ...env, SHELL: zsh }, encoding: 'utf8' }).trim()).toBe(dir)
  })

  test.each(['relative', ''])('refuses a relative startup directory %j instead of guessing a profile', async (value) => {
    const { home, env } = fixture()
    writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${quote(value)}\n`)
    expect(await zshDirectory({ ...env, SHELL: zsh })).toBeUndefined()
  })

  test('bounds a hung .zshenv and terminates the shell process group', async () => {
    const { home, env } = fixture()
    const pid = path.join(home, 'child.pid')
    writeFileSync(path.join(home, '.zshenv'), `sleep 60 &\nprint $! > ${quote(pid)}\nwait\n`)
    const began = Date.now()
    expect(await zshDirectory({ ...env, SHELL: zsh }, 200)).toBeUndefined()
    expect(Date.now() - began).toBeLessThan(3000)
    const child = Number(readFileSync(pid, 'utf8'))
    // A killed child can remain a zombie until its parent is reaped, but cannot keep running.
    const state = spawnSync('ps', ['-o', 'stat=', '-p', String(child)], { encoding: 'utf8' }).stdout.trim()
    expect(state === '' || state.startsWith('Z')).toBe(true)
  })

  test('uses the same folder for the install script and uninstall, preserving a linked profile', () => {
    const { home, dir, env } = fixture()
    const itHome = path.join(home, '.it')
    const bin = path.join(itHome, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(itHome, 'machine.json'), JSON.stringify({ id: 'test-machine', key: {} }))
    for (const name of ['systemctl', 'launchctl']) {
      writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n')
      chmodSync(path.join(bin, name), 0o755)
    }
    writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${quote(dir)}\n`)
    const target = path.join(dir, 'my-profile')
    writeFileSync(target, 'export EDITOR=vi\n', { mode: 0o640 })
    execFileSync('ln', ['-s', target, path.join(dir, '.zshrc')])
    // Run the real installer's PATH portion and the generated CLI, without downloading or setup.
    writeFileSync(path.join(bin, 'it'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`)
    chmodSync(path.join(bin, 'it'), 0o755)
    const install = readFileSync('install/install.sh', 'utf8')
    const start = install.indexOf('# The folder is put on the PATH by one line')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: The literal marks the shell source.
    const end = install.indexOf('\n# ', install.indexOf('else say "${DIR} is already on the PATH', start))
    const block = install.slice(start, end)
    const script = path.join(home, 'path.sh')
    writeFileSync(script, `set -eu\nsay() { printf '%s\\n' "$*"; }\nquoted() { printf "'%s'" "$1"; }\nDIR=${quote(bin)}\nled=0\n${block}\n`)
    const allEnv = { ...env, PATH: `${bin}:/usr/bin:/bin`, SHELL: zsh, IT_HOME: itHome, IT_PORT: '40100', IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage' }
    execFileSync('/bin/sh', [script], { env: { ...allEnv, PATH: env.PATH } })
    expect(existsSync(path.join(home, '.zshrc'))).toBe(false)
    expect(execFileSync(zsh!, ['-i', '-c', 'command -v it'], { env: allEnv, encoding: 'utf8' }).trim()).toBe(path.join(bin, 'it'))
    const removed = spawnSync(process.execPath, [cli, 'uninstall', '--yes'], { env: allEnv, encoding: 'utf8' })
    expect(removed.status, removed.stdout + removed.stderr).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('export EDITOR=vi\n')
    expect(readFileSync(path.join(dir, '.zshrc'), 'utf8')).toBe('export EDITOR=vi\n')
    expect(removed.stdout).toContain(`${target}.it-recovery`)
    expect(readFileSync(`${target}.it-recovery/1/original`, 'utf8')).toContain('export PATH=')
  })
})
