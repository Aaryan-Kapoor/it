import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { INSTALLATION, INSTALLATION_FILE } from './src/installation'
import { zshDirectory } from './src/shell-profile'
import { standInZsh, zsh, zshEtc } from './test-zsh'

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

/** Writes a startup file of the system's for one test, in the folder `etc` that zsh reads them from. */
function systemFile(etc: string, name: 'zshenv' | 'zshrc', text: string) {
  const file = path.join(etc, name)
  writeFileSync(file, text)
  made.push(file)
}

/**
 * What holds for zsh and for the stand-in alike, with startup files in plain sh. `shellIn` gives
 * the zsh to name in SHELL for a test's home, and `etcOf` the folder it reads the system's startup
 * files from, where a test may write them. The tests of those files are left out where there is none.
 */
function startupFolders(shellIn: (home: string) => string, etcOf: (home: string) => string | undefined, noEtc: boolean) {
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

  test.skipIf(noEtc)('reports the folder the system’s zshrc moves ZDOTDIR to, and runs no .zshrc', async () => {
    const { home, dir, env } = fixture()
    const shell = shellIn(home)
    const other = path.join(home, 'other files')
    mkdirSync(other)
    writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${quote(dir)}\n`)
    systemFile(etcOf(home)!, 'zshrc', `ZDOTDIR=${quote(other)}\n`)
    for (const folder of [dir, other]) writeFileSync(path.join(folder, '.zshrc'), `echo ran > ${quote(path.join(home, 'zshrc ran'))}\n`)
    expect(await zshDirectory({ ...env, SHELL: shell })).toBe(other)
    expect(existsSync(path.join(home, 'zshrc ran'))).toBe(false)
  })

  test.skipIf(noEtc)('where the system’s zshenv sets ZDOTDIR itself, says the folder the .zshenv there leaves, and runs no .zshrc', async () => {
    const { home, dir, env } = fixture()
    const shell = shellIn(home)
    const other = path.join(home, 'other files')
    mkdirSync(other)
    // As the Arch wiki suggests: zsh then reads that folder's files and never It's, and is asked something narrower.
    systemFile(etcOf(home)!, 'zshenv', `ZDOTDIR=${quote(dir)}\nexport ZDOTDIR\n`)
    for (const folder of [dir, other]) writeFileSync(path.join(folder, '.zshrc'), `echo ran > ${quote(path.join(home, 'zshrc ran'))}\n`)
    expect(await zshDirectory({ ...env, SHELL: shell })).toBe(dir)
    expect(await zshDirectory({ ...env, SHELL: shell, ZDOTDIR: dir })).toBe(dir)
    writeFileSync(path.join(dir, '.zshenv'), `ZDOTDIR=${quote(other)}\n`)
    expect(await zshDirectory({ ...env, SHELL: shell })).toBe(other)
    expect(existsSync(path.join(home, 'zshrc ran'))).toBe(false)
  })

  test.skipIf(noEtc)('says nothing where the system’s zshenv sets ZDOTDIR and the .zshenv there ends the shell', async () => {
    const { home, dir, env } = fixture()
    const shell = shellIn(home)
    systemFile(etcOf(home)!, 'zshenv', `ZDOTDIR=${quote(dir)}\nexport ZDOTDIR\n`)
    writeFileSync(path.join(dir, '.zshenv'), 'exit 0\n')
    expect(await zshDirectory({ ...env, SHELL: shell })).toBeUndefined()
  })

  test.skipIf(noEtc)('follows a ZDOTDIR that the system’s zshenv gives only where none is set', async () => {
    const { home, dir, env } = fixture()
    const shell = shellIn(home)
    const other = path.join(home, 'other files')
    systemFile(etcOf(home)!, 'zshenv', `: "\${ZDOTDIR:=${dir}}"\n`)
    expect(await zshDirectory({ ...env, SHELL: shell })).toBe(dir)
    expect(await zshDirectory({ ...env, SHELL: shell, ZDOTDIR: other })).toBe(other)
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
  startupFolders(
    () => zsh!,
    () => zshEtc,
    !zshEtc,
  )

  test('follows a ZDOTDIR that .zshenv sets only where RCS is set, as it is in every ordinary start', async () => {
    const { home, dir, env } = fixture()
    writeFileSync(path.join(home, '.zshenv'), `if [[ -o rcs && -o globalrcs ]]; then ZDOTDIR=${quote(dir)}; fi\n`)
    expect(await zshDirectory({ ...env, SHELL: zsh })).toBe(dir)
  })

  test.skipIf(!zshEtc)('runs the system’s zshenv with RCS set, as zsh always does', async () => {
    const { home, dir, env } = fixture()
    systemFile(zshEtc!, 'zshenv', `if [[ -o rcs && -o globalrcs ]]; then IT_TEST_FILES=${quote(dir)}; fi\n`)
    writeFileSync(path.join(home, '.zshenv'), 'ZDOTDIR=$IT_TEST_FILES\n')
    expect(await zshDirectory({ ...env, SHELL: zsh })).toBe(dir)
  })

  test.skipIf(!zshEtc)('reads the .zshenv in the folder the system’s zshenv chose with the options of any start', async () => {
    const { home, dir, env } = fixture()
    const other = path.join(home, 'other files')
    systemFile(zshEtc!, 'zshenv', `if [[ -o rcs ]]; then export ZDOTDIR=${quote(dir)}; fi\n`)
    writeFileSync(path.join(dir, '.zshenv'), `if [[ -o rcs && -o globalrcs && ! -o privileged ]]; then ZDOTDIR=${quote(other)}; fi\n`)
    expect(await zshDirectory({ ...env, SHELL: zsh })).toBe(other)
    // Without RCS zsh reads no .zshrc at all.
    writeFileSync(path.join(dir, '.zshenv'), 'unsetopt rcs\n')
    expect(await zshDirectory({ ...env, SHELL: zsh })).toBeUndefined()
  })

  test.skipIf(!zshEtc)('says nothing where the system’s zshrc takes away the trap that stops zsh before .zshrc', async () => {
    const { home, dir, env } = fixture()
    systemFile(zshEtc!, 'zshrc', 'trap - DEBUG\n')
    writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${quote(dir)}\n`)
    writeFileSync(path.join(dir, '.zshrc'), 'ZDOTDIR=/elsewhere\n')
    expect(await zshDirectory({ ...env, SHELL: zsh })).toBeUndefined()
  })

  test('leaves the history file that .zshenv names as it was', async () => {
    const { home, dir, env } = fixture()
    const history = path.join(home, 'history')
    writeFileSync(history, ': 1:0;one\n: 2:0;two\n: 3:0;three\n')
    writeFileSync(path.join(home, '.zshenv'), `HISTFILE=${quote(history)}\nSAVEHIST=1\nHISTSIZE=1\nZDOTDIR=${quote(dir)}\n`)
    writeFileSync(path.join(dir, '.zshrc'), 'setopt share_history\n')
    expect(await zshDirectory({ ...env, SHELL: zsh })).toBe(dir)
    expect(readFileSync(history, 'utf8')).toBe(': 1:0;one\n: 2:0;two\n: 3:0;three\n')
  })

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
  startupFolders(
    (home) => standInZsh(path.join(home, 'stand-in')),
    (home) => path.join(home, 'stand-in'),
    false,
  )

  test('asks the system’s zshenv alone first, and then starts zsh as an ordinary interactive shell', async () => {
    const { home, dir, env } = fixture()
    const shell = standInZsh(path.join(home, 'stand-in'))
    writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${quote(dir)}\n`)
    expect(await zshDirectory({ ...env, SHELL: shell })).toBe(dir)
    // -p keeps zsh from the person's files, and no_global_rcs from the system's zshrc. The last start changes no option.
    const starts = readFileSync(path.join(home, 'stand-in', 'zsh arguments'), 'utf8')
      .trimEnd()
      .split('\n')
    expect(starts.map((words) => words.split(' -c ')[0])).toEqual(['-p -i -o no_global_rcs', '-p -i -o no_global_rcs', '-i'])
  })

  test('says nothing where SHELL names a zsh that is not there, or that is not zsh', async () => {
    const { home, env } = fixture()
    expect(await zshDirectory({ ...env, SHELL: path.join(home, 'no such folder', 'zsh') })).toBeUndefined()
    expect(await zshDirectory({ ...env, SHELL: '/bin/sh' })).toBeUndefined()
    expect(spawnSync(process.execPath, [cli, 'shell-profile'], { env: { ...env, SHELL: path.join(home, 'zsh') } }).status).not.toBe(0)
  })
})
