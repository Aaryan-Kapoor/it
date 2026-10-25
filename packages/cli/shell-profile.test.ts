import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { INSTALLATION, INSTALLATION_FILE } from './src/installation'
import { zshDirectory } from './src/shell-profile'
import { standInZsh, zsh } from './test-zsh'

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
const cli = path.resolve('packages/cli/dist/it.mjs')
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`
/** Whether a process is gone. A killed child can remain a zombie until its parent is reaped, but cannot keep running. */
const gone = (pid: number) => {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return state === '' || state.startsWith('Z')
}

/**
 * What holds for zsh and for the stand-in alike, with a .zshenv in plain sh. `shellIn` gives the
 * zsh to name in SHELL for a test's home.
 */
function startupFolders(shellIn: (home: string) => string) {
  test('reads a nonexported ZDOTDIR from .zshenv despite startup output', async () => {
    const { home, dir, env } = fixture()
    const shell = shellIn(home)
    writeFileSync(path.join(home, '.zshenv'), `echo welcome\nZDOTDIR=${quote(dir)}\n`)
    expect(await zshDirectory({ ...env, SHELL: shell })).toBe(dir)
    expect(execFileSync(process.execPath, [cli, 'shell-profile'], { env: { ...env, SHELL: shell }, encoding: 'utf8' }).trim()).toBe(dir)
  })

  test.each(['relative', ''])('refuses a relative startup directory %j instead of guessing a profile', async (value) => {
    const { home, env } = fixture()
    const shell = shellIn(home)
    writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${quote(value)}\n`)
    expect(await zshDirectory({ ...env, SHELL: shell })).toBeUndefined()
  })

  test('says nothing where .zshenv ends the shell, which then reads no .zshrc at all', async () => {
    const { home, dir, env } = fixture()
    const shell = shellIn(home)
    writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${quote(dir)}\nexit 0\n`)
    expect(await zshDirectory({ ...env, SHELL: shell })).toBeUndefined()
  })

  test('bounds a hung .zshenv and terminates the shell process group', async () => {
    const { home, env } = fixture()
    const shell = shellIn(home)
    const pid = path.join(home, 'child.pid')
    writeFileSync(path.join(home, '.zshenv'), `sleep 60 &\necho $! > ${quote(pid)}\nwait\n`)
    const began = Date.now()
    expect(await zshDirectory({ ...env, SHELL: shell }, 200)).toBeUndefined()
    expect(Date.now() - began).toBeLessThan(3000)
    expect(gone(Number(readFileSync(pid, 'utf8')))).toBe(true)
  })

  test('answers once the folder is said, though .zshenv left a job holding the output, and ends that job', async () => {
    const { home, dir, env } = fixture()
    const shell = shellIn(home)
    const pid = path.join(home, 'child.pid')
    writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${quote(dir)}\nsleep 60 &\necho $! > ${quote(pid)}\n`)
    // The job keeps the output open after the shell has gone, so waiting for its end would wait out the bound.
    expect(await zshDirectory({ ...env, SHELL: shell }, 3000)).toBe(dir)
    expect(gone(Number(readFileSync(pid, 'utf8')))).toBe(true)
  })

  test('uses the same folder for the install script and uninstall, preserving a linked profile', () => {
    const { home, dir, env } = fixture()
    const shell = shellIn(home)
    const itHome = path.join(home, '.it')
    const bin = path.join(itHome, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(itHome, INSTALLATION_FILE), INSTALLATION)
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
    const allEnv = { ...env, PATH: `${bin}:/usr/bin:/bin`, SHELL: shell, IT_HOME: itHome, IT_PORT: '40100', IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage' }
    const said = execFileSync('/bin/sh', [script], { env: { ...allEnv, PATH: env.PATH }, encoding: 'utf8' })
    expect(said).toContain(path.join(dir, '.zshrc'))
    expect(existsSync(path.join(home, '.zshrc'))).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe(`export EDITOR=vi\n\n# It\nexport PATH=${quote(bin)}:"$PATH"\n`)
    // A fresh zsh is asked only where there is a real one to ask.
    if (shell === zsh) expect(execFileSync(zsh, ['-i', '-c', 'command -v it'], { env: allEnv, encoding: 'utf8' }).trim()).toBe(path.join(bin, 'it'))
    const removed = spawnSync(process.execPath, [cli, 'uninstall', '--yes'], { env: allEnv, encoding: 'utf8' })
    expect(removed.status, removed.stdout + removed.stderr).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('export EDITOR=vi\n')
    expect(readFileSync(path.join(dir, '.zshrc'), 'utf8')).toBe('export EDITOR=vi\n')
    expect(removed.stdout).not.toContain(`${target}.it-recovery`)
    expect(existsSync(`${target}.it-recovery`)).toBe(false)
  })
}

describe.skipIf(process.platform === 'win32' || !zsh)('zsh startup folders', () => {
  startupFolders(() => zsh!)

  test('uses the startup directory selected only for an interactive shell', async () => {
    const { home, dir, env } = fixture()
    writeFileSync(path.join(home, '.zshenv'), `if [[ -o interactive ]]; then ZDOTDIR=${quote(dir)}; fi\n`)
    expect(await zshDirectory({ ...env, SHELL: zsh })).toBe(dir)
  })

  test('reports the folder .zshrc is read from without running .zshrc, though .zshrc moves ZDOTDIR', async () => {
    const { home, dir, env } = fixture()
    const ran = path.join(home, 'zshrc ran')
    writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${quote(dir)}\n`)
    writeFileSync(path.join(dir, '.zshrc'), `print ran > ${quote(ran)}\nZDOTDIR=${quote(path.join(home, 'elsewhere'))}\n`)
    expect(await zshDirectory({ ...env, SHELL: zsh })).toBe(dir)
    expect(existsSync(ran)).toBe(false)
  })

  test('answers where .zshenv fails after choosing the folder, since zsh still reads .zshrc there', async () => {
    const { home, dir, env } = fixture()
    writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${quote(dir)}\nprint \${(\n`)
    expect(await zshDirectory({ ...env, SHELL: zsh })).toBe(dir)
  })
})

describe.skipIf(process.platform === 'win32')('zsh startup folders, with a stand-in for zsh', () => {
  startupFolders((home) => standInZsh(path.join(home, 'stand-in')))

  test('asks zsh, as an interactive shell, to read no startup file of the person’s own before It reads .zshenv', async () => {
    const { home, dir, env } = fixture()
    const shell = standInZsh(path.join(home, 'stand-in'))
    writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${quote(dir)}\n`)
    expect(await zshDirectory({ ...env, SHELL: shell })).toBe(dir)
    // -f leaves zsh to read only the system's zshenv, and so no .zshrc runs or moves ZDOTDIR before the answer.
    expect(
      readFileSync(path.join(home, 'stand-in', 'zsh arguments'), 'utf8')
        .split('\n')
        .slice(0, 3),
    ).toEqual(['-f', '-i', '-c'])
  })

  test('says nothing where SHELL names a zsh that is not there, or that is not zsh', async () => {
    const { home, env } = fixture()
    expect(await zshDirectory({ ...env, SHELL: path.join(home, 'no such folder', 'zsh') })).toBeUndefined()
    expect(await zshDirectory({ ...env, SHELL: '/bin/sh' })).toBeUndefined()
    expect(spawnSync(process.execPath, [cli, 'shell-profile'], { env: { ...env, SHELL: path.join(home, 'zsh') } }).status).not.toBe(0)
  })
})
