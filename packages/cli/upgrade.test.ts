// A newer It: learning that one is out, and putting it in place of the one that is here. A
// stand-in for the place releases are kept is on this machine, laid out as a release is, and
// what stands for the program is a script that says its version as the program does.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { newer } from '@it/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type Problem, VERSION } from './src/lib'
import { fetchNewer, keepBase, latest, programName, releases, watch, watched, watching } from './src/upgrade'

describe('which version is newer', () => {
  test('is told by the three numbers, and never by a version that is not written as three', () => {
    expect(newer('0.1.1', '0.1.0')).toBe(true)
    expect(newer('0.2.0', '0.1.9')).toBe(true)
    expect(newer('1.0.0', '0.99.99')).toBe(true)
    expect(newer('0.1.10', '0.1.9')).toBe(true)
    expect(newer('v0.1.1', '0.1.0')).toBe(true)
    for (const [a, b] of [
      ['0.1.0', '0.1.0'],
      ['0.1.0', '0.1.1'],
      ['', '0.1.0'],
      [null, '0.1.0'],
      ['0.1.1', null],
      ['latest', '0.1.0'],
      ['0.1', '0.1.0'],
      ['0.1.1-beta', '0.1.0'],
      ['0.1.1; rm -rf', '0.1.0'],
    ] as const)
      expect(newer(a, b), `${a} over ${b}`).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('a newer release', () => {
  let folder: string
  let server: http.Server
  let files: Record<string, Buffer | string>
  let asked: string[]
  const was = { ...process.env }
  const name = programName()!
  /** What stands for a program of It: it says its version, as `it --version` does, or fails to start. */
  const says = (version: string | null) => (version === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\nprintf '{"version": "%s", "protocol": 1}\\n' '${version}'\n`)
  /** A release of this version, with everything a release holds and the checksum of each. */
  const release = (version: string, program = says(version)) => {
    files = {
      [name]: program,
      'LICENSE.md': `the terms of ${version}\n`,
      'THIRD_PARTY_NOTICES.md': `the notices of ${version}\n`,
      'latest.json': JSON.stringify({ version }),
    }
    files.SHA256SUMS = Object.entries(files)
      .map(([file, holds]) => `${createHash('sha256').update(holds).digest('hex')}  ${file}\n`)
      .join('')
  }
  const here = () => path.join(folder, 'bin', 'it')
  const refused = async () => (await fetchNewer({ program: here() }).catch((err) => err)) as Problem

  beforeEach(async () => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-upgrade-'))
    process.env.IT_HOME = folder
    delete process.env.IT_UPDATE_CHECK
    mkdirSync(path.join(folder, 'bin'))
    writeFileSync(here(), says(VERSION), { mode: 0o755 })
    asked = []
    server = http.createServer((req, res) => {
      asked.push(req.url ?? '')
      const file = files[(req.url ?? '').replace('/latest/download/', '')]
      if (!(req.url ?? '').startsWith('/latest/download/') || file === undefined) return void res.writeHead(404).end()
      res.writeHead(200).end(file)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    process.env.IT_INSTALL_BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    release('9.9.9')
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    rmSync(folder, { recursive: true, force: true })
    for (const k of ['IT_HOME', 'IT_INSTALL_BASE', 'IT_UPDATE_CHECK'])
      if (was[k] === undefined) delete process.env[k]
      else process.env[k] = was[k]
  })

  test('is learned of by one request that says nothing of this installation, and not learned of where the place does not say', async () => {
    expect(await latest()).toBe('9.9.9')
    expect(asked).toEqual(['/latest/download/latest.json'])
    for (const said of ['{"version": "latest"}', '{"version": 3}', 'not json', '{}', `{"version": "${'9'.repeat(5000)}"}`]) {
      files['latest.json'] = said
      expect(await latest(), said.slice(0, 30)).toBeNull()
    }
    delete files['latest.json']
    expect(await latest()).toBeNull()
  })

  test('is put in place of the program that is here, with its terms and notices, once it matches its checksum, starts, and says it is newer', async () => {
    const said: string[] = []
    const done = await fetchNewer({ program: here(), say: (line) => said.push(line) })
    expect(done).toEqual({ from: VERSION, to: '9.9.9', program: here() })
    expect(readFileSync(here(), 'utf8')).toBe(says('9.9.9'))
    expect(statSync(here()).mode & 0o111).not.toBe(0)
    expect(readFileSync(path.join(folder, 'LICENSE.md'), 'utf8')).toBe('the terms of 9.9.9\n')
    expect(readFileSync(path.join(folder, 'THIRD_PARTY_NOTICES.md'), 'utf8')).toBe('the notices of 9.9.9\n')
    expect(said).toEqual([
      `It 9.9.9 is out, and this is ${VERSION}.`,
      'Downloaded, and checked against its checksum.',
      `Installed in ${path.join(folder, 'bin')}.`,
    ])
    // Nothing of the fetching is left beside it
    expect(existsSync(path.join(folder, 'bin', `.it-upgrade-${process.pid}`))).toBe(false)
  })

  test('is not fetched at all where this is the newest there is', async () => {
    release(VERSION)
    expect(await fetchNewer({ program: here() })).toBeNull()
    expect(asked).toEqual(['/latest/download/latest.json'])
  })

  test('leaves the program that is here exactly as it was where anything about it is wrong: its checksum, a file the release does not list, a program that does not start, or one that says it is no newer', async () => {
    const untouched = () => expect(readFileSync(here(), 'utf8')).toBe(says(VERSION))
    // Changed on its way: not the file its release says it is
    files[name] = `${says('9.9.9')}# and something more\n`
    expect([(await refused()).code, (await refused()).message]).toEqual([
      'checksum',
      `What was fetched as ${name} is not the file its release says it is, so nothing was changed.`,
    ])
    untouched()
    // The notices changed on their way: the program beside them is not put in either
    release('9.9.9')
    files['THIRD_PARTY_NOTICES.md'] = 'other notices\n'
    expect((await refused()).code).toBe('checksum')
    untouched()
    // A release whose checksums do not list the program has none to hold it to
    release('9.9.9')
    files.SHA256SUMS = String(files.SHA256SUMS)
      .split('\n')
      .filter((line) => !line.endsWith(name))
      .join('\n')
    expect((await refused()).code).toBe('checksum')
    untouched()
    // It matches its checksum and does not start on this system
    release('9.9.9', says(null))
    expect([(await refused()).code, (await refused()).message]).toEqual([
      'upgrade_program',
      'The program that was fetched does not start on this system, so the one that is here stays.',
    ])
    untouched()
    // It starts, and says that it is the version that is here already, whatever the release said of itself
    release('9.9.9', says(VERSION))
    expect((await refused()).code).toBe('upgrade_program')
    untouched()
    expect(existsSync(path.join(folder, 'LICENSE.md'))).toBe(false)
    // The place cannot be reached
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    expect((await refused()).code).toBe('offline')
    untouched()
  })

  test('is asked for over https or on this machine and nowhere else, and the place an It was installed from is where it looks from then on', () => {
    for (const bad of ['http://example.com/releases', 'ftp://127.0.0.1:1', 'http://127.0.0.1.evil.example:80', 'releases']) {
      process.env.IT_INSTALL_BASE = bad
      expect(() => releases(), bad).toThrow('IT_INSTALL_BASE must be an https address.')
    }
    process.env.IT_INSTALL_BASE = 'https://example.com/releases/'
    expect(releases()).toEqual({ base: 'https://example.com/releases', plain: false })
    // Set up with the variable, the place is written down, and is the place when the variable is gone
    keepBase()
    delete process.env.IT_INSTALL_BASE
    expect(releases().base).toBe('https://example.com/releases')
    expect(statSync(path.join(folder, 'releases.json')).mode & 0o777).toBe(0o600)
    // One that is neither is not written down
    process.env.IT_INSTALL_BASE = 'http://example.com'
    keepBase()
    delete process.env.IT_INSTALL_BASE
    expect(releases().base).toBe('https://example.com/releases')
    // Set up again from the usual place, it is the usual place again
    process.env.IT_INSTALL_BASE = 'https://github.com/Aaryan-Kapoor/it/releases'
    keepBase()
    delete process.env.IT_INSTALL_BASE
    expect(existsSync(path.join(folder, 'releases.json'))).toBe(false)
  })

  test('is looked for once a day until that is turned off, by the command or by a variable', () => {
    expect([watching(), watched()]).toEqual([true, { on: true }])
    expect(watch(false)).toEqual({ on: false, because: 'it updates off' })
    expect(watching()).toBe(false)
    expect(existsSync(path.join(folder, 'updates-off'))).toBe(true)
    expect(watch(true)).toEqual({ on: true })
    expect(existsSync(path.join(folder, 'updates-off'))).toBe(false)
    for (const off of ['false', '0', 'off', 'no']) {
      process.env.IT_UPDATE_CHECK = off
      expect([watching(), watched()], off).toEqual([false, { on: false, because: 'IT_UPDATE_CHECK' }])
    }
    process.env.IT_UPDATE_CHECK = 'true'
    expect(watching()).toBe(true)
  })
})
