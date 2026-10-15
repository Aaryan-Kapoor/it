// A newer It: learning that one is out, and putting it in place of the one that is here. A
// stand-in for the place releases are kept is on this machine, laid out as a release is, and
// what stands for the program is a script that says its version as the program does.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { newer } from '@it/protocol'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type Problem, VERSION } from './src/lib'
import { aloneAt } from './src/serve/backend'
import { fetchNewer, keepBase, LOOKS_EVERY_MS, latest, programName, releases, watch, watched, watching } from './src/upgrade'

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
  /** The file that never ends: its first half is sent, and then a byte now and again for as long as anyone listens. */
  let trickled: string | null
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
    trickled = null
    server = http.createServer((req, res) => {
      asked.push(req.url ?? '')
      const file = files[(req.url ?? '').replace('/latest/download/', '')]
      if (!(req.url ?? '').startsWith('/latest/download/') || file === undefined) return void res.writeHead(404).end()
      if ((req.url ?? '').endsWith(`/${trickled}`)) {
        const whole = Buffer.from(file)
        res.writeHead(200, { 'content-length': String(whole.length + 1_000_000) })
        res.write(whole.subarray(0, Math.ceil(whole.length / 2)))
        const drip = setInterval(() => res.write('.'), 40)
        res.once('close', () => clearInterval(drip))
        return
      }
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

  test('refuses a latest release that changed since the host approved a site update', async () => {
    const before = readFileSync(here(), 'utf8')
    await expect(fetchNewer({ program: here(), expectedVersion: '9.9.8' })).rejects.toMatchObject({ code: 'upgrade_program' })
    expect(asked).toEqual(['/latest/download/latest.json'])
    expect(readFileSync(here(), 'utf8')).toBe(before)
    expect(existsSync(path.join(folder, 'LICENSE.md'))).toBe(false)
    expect(await fetchNewer({ program: here(), expectedVersion: '9.9.9' })).toMatchObject({ to: '9.9.9' })
  })

  test('is given up when the time for fetching it is over, though a little of it goes on coming, and can then be fetched again', async () => {
    const before = readFileSync(here(), 'utf8')
    for (const never of ['SHA256SUMS', name, 'LICENSE.md']) {
      trickled = never
      const began = Date.now()
      const slow = (await fetchNewer({ program: here(), within: 700 }).catch((err) => err)) as Problem
      expect([never, slow.code, slow.message]).toEqual([
        never,
        'offline',
        'The newest release of It had not been fetched after 0 minutes, so it was given up and nothing was changed.',
      ])
      expect(slow.hint).toContain('run the line It was installed with again')
      expect(Date.now() - began).toBeLessThan(5000)
      // Nothing was changed, and nothing is left beside the program
      expect(readFileSync(here(), 'utf8')).toBe(before)
      expect(existsSync(path.join(folder, 'LICENSE.md'))).toBe(false)
    }
    // Whoever calls it off is told that, and not that it was slow
    trickled = name
    const off = new AbortController()
    setTimeout(() => off.abort(), 200)
    expect(((await fetchNewer({ program: here(), within: 60_000, signal: off.signal }).catch((err) => err)) as Problem).message).toBe(
      `The newest release of It could not be fetched (${name}).`,
    )
    // The next try is not held up by the one that was given up
    trickled = null
    expect(await fetchNewer({ program: here() })).toMatchObject({ to: '9.9.9' })
    expect(readFileSync(here(), 'utf8')).toBe(says('9.9.9'))
  })

  test.each([false, true])(
    'is put in place of the program that is here, with its terms and notices, once it matches its checksum, starts, and says it is newer, through a linked folder too (%s)',
    async (linked) => {
      const named = path.join(folder, 'linked')
      if (linked) symlinkSync(folder, named, 'dir')
      const program = linked ? path.join(named, 'bin', 'it') : here()
      const said: string[] = []
      const done = await fetchNewer({ program, say: (line) => said.push(line) })
      expect(done).toEqual({ from: VERSION, to: '9.9.9', program })
      expect(readFileSync(here(), 'utf8')).toBe(says('9.9.9'))
      expect(statSync(here()).mode & 0o111).not.toBe(0)
      expect(readFileSync(path.join(folder, 'LICENSE.md'), 'utf8')).toBe('the terms of 9.9.9\n')
      expect(readFileSync(path.join(folder, 'THIRD_PARTY_NOTICES.md'), 'utf8')).toBe('the notices of 9.9.9\n')
      expect(said).toEqual([
        `It 9.9.9 is out, and this is ${VERSION}.`,
        'Downloaded, and checked against its checksum.',
        `Installed in ${path.dirname(program)}.`,
      ])
      // Nothing of the fetching is left beside it
      expect(existsSync(path.join(folder, 'bin', `.it-upgrade-${process.pid}`))).toBe(false)
    },
  )

  test.each([false, true])(
    'is not put over a newer one that another update put in place while this one was being fetched, through a linked folder too (%s)',
    async (linked) => {
      const named = path.join(folder, 'linked')
      if (linked) symlinkSync(folder, named, 'dir')
      const program = linked ? path.join(named, 'bin', 'it') : here()
      release('9.9.8')
      const said: string[] = []
      const done = await fetchNewer({
        program,
        say: (line) => {
          said.push(line)
          // While this update has 9.9.8 in hand, another, asked for elsewhere, puts 9.9.9 in place
          if (line.startsWith('Downloaded')) {
            writeFileSync(here(), says('9.9.9'), { mode: 0o755 })
            writeFileSync(path.join(folder, 'LICENSE.md'), 'the terms of 9.9.9\n')
          }
        },
      })
      // What is there stays, with its terms, and it is what this update says is there now
      expect(readFileSync(here(), 'utf8')).toBe(says('9.9.9'))
      expect(readFileSync(path.join(folder, 'LICENSE.md'), 'utf8')).toBe('the terms of 9.9.9\n')
      expect(done).toEqual({ from: VERSION, to: '9.9.9', program })
      expect(said.at(-1)).toBe('It 9.9.9 was put in place by another update meanwhile, and is left as it is.')
      expect(existsSync(path.join(folder, 'bin', `.it-upgrade-${process.pid}`))).toBe(false)
      // One that put the very same version there is left as it is too
      release('9.9.9')
      expect(await fetchNewer({ program })).toEqual({ from: VERSION, to: '9.9.9', program })
    },
  )

  test('is put in place by one update at a time: an update waits for another that is putting its program in place, and then looks at what that one left', async () => {
    release('9.9.8')
    let other: Promise<void> | undefined
    let finished = false
    const done = await fetchNewer({
      program: here(),
      say: (line) => {
        if (!line.startsWith('Downloaded')) return
        // Another update has this program to itself at this moment, and takes a while to put 9.9.9 in place.
        other = aloneAt(`${here()}.upgrade.lock`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 700))
          writeFileSync(here(), says('9.9.9'), { mode: 0o755 })
          finished = true
        })
      },
    })
    expect(finished).toBe(true)
    await other
    expect(done).toMatchObject({ to: '9.9.9' })
    expect(readFileSync(here(), 'utf8')).toBe(says('9.9.9'))
  })

  test.each([
    { through: 'its own path', secondVersion: '9.9.8' },
    { through: 'a linked folder', secondVersion: '9.9.8' },
    { through: 'its own path', secondVersion: '9.9.9' },
    { through: 'a linked folder', secondVersion: '9.9.9' },
  ])('two data folders share one update lock through $through when the second fetches $secondVersion', async ({ through, secondVersion }) => {
    const homes = ['newer-home', 'older-home'].map((name) => path.join(folder, name))
    for (const home of homes) mkdirSync(home)
    writeFileSync(path.join(homes[1]!, 'LICENSE.md'), 'the earlier terms\n')
    const linked = path.join(folder, 'linked-bin')
    symlinkSync(path.dirname(here()), linked, 'dir')
    const otherProgram = through === 'a linked folder' ? path.join(linked, 'it') : here()
    const worker = path.join(folder, 'updater.mjs')
    await build({
      stdin: {
        contents: `
          import child from 'node:child_process'
          import { writeFileSync } from 'node:fs'
          import { syncBuiltinESMExports } from 'node:module'
          import path from 'node:path'
          const execFile = child.execFile
          child.execFile = (file, args, options, done) => {
            const candidate = path.basename(file).startsWith('.it-upgrade-')
            if (!candidate) writeFileSync(path.join(process.env.IT_HOME, 'attempted'), '')
            return execFile(file, args, options, (...answer) => {
              done(...answer)
              if (candidate) setImmediate(() => writeFileSync(path.join(process.env.IT_HOME, 'validated'), ''))
            })
          }
          syncBuiltinESMExports()
          const { fetchNewer } = await import('./src/upgrade')
          console.log(JSON.stringify(await fetchNewer({ program: process.argv[2] })))
        `,
        resolveDir: __dirname,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: worker,
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      loader: { '.md': 'text', '.txt': 'text' },
      logLevel: 'silent',
    })
    const runs: Promise<{ code: number | null; out: string; err: string }>[] = []
    const run = (home: string, program: string) => {
      const child = spawn(process.execPath, [worker, program], {
        env: { ...process.env, IT_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (bytes) => (out += bytes))
      child.stderr.on('data', (bytes) => (err += bytes))
      const ended = new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve({ code, out, err }))
      })
      runs.push(ended)
      return ended
    }
    const until = async (file: string) => {
      for (const end = Date.now() + 10_000; !existsSync(file); ) {
        if (Date.now() >= end) throw new Error(`the updater did not reach ${path.basename(file)}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    writeFileSync(here(), `${says(VERSION)}: > "$IT_HOME/probing"\nwhile [ ! -f "$IT_HOME/release" ]; do sleep 0.02; done\n`)
    try {
      const newer = run(homes[0]!, here())
      await until(path.join(homes[0]!, 'probing'))
      release(secondVersion)
      const older = run(homes[1]!, otherProgram)
      // The candidate's callback has run and its continuations have had their turn. An updater
      // with a separate lock has started its destination probe by then, and is held there too.
      await until(path.join(homes[1]!, 'validated'))
      const bothProbed = existsSync(path.join(homes[1]!, 'attempted'))
      if (bothProbed) await until(path.join(homes[1]!, 'probing'))
      writeFileSync(path.join(homes[0]!, 'release'), '')
      const first = await newer
      writeFileSync(path.join(homes[1]!, 'release'), '')
      const second = await older
      expect([first.code, first.err, second.code, second.err]).toEqual([0, '', 0, ''])
      expect([bothProbed, JSON.parse(first.out).to, JSON.parse(second.out).to, readFileSync(here(), 'utf8')]).toEqual([false, '9.9.9', '9.9.9', says('9.9.9')])
      for (const [file, text] of [
        ['LICENSE.md', 'the terms'],
        ['THIRD_PARTY_NOTICES.md', 'the notices'],
      ]) {
        expect(readFileSync(path.join(homes[0]!, file!), 'utf8')).toBe(`${text} of 9.9.9\n`)
        if (secondVersion === '9.9.9') expect(readFileSync(path.join(homes[1]!, file!), 'utf8')).toBe(`${text} of 9.9.9\n`)
      }
      if (secondVersion === '9.9.8') {
        expect(readFileSync(path.join(homes[1]!, 'LICENSE.md'), 'utf8')).toBe('the earlier terms\n')
        expect(existsSync(path.join(homes[1]!, 'THIRD_PARTY_NOTICES.md'))).toBe(false)
      }
    } finally {
      for (const home of homes) writeFileSync(path.join(home, 'release'), '')
      await Promise.allSettled(runs)
    }
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
    // A checksum-valid program from another newer release is not the release selected.
    release('9.9.9', says('9.9.8'))
    expect((await refused()).message).toBe('The program that was fetched says it is version 9.9.8, but the release advertises 9.9.9, so nothing was changed.')
    untouched()
    release('9.9.9', says('not a version'))
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

  test('compares the normalized version of the program with the advertised release', async () => {
    release('9.9.9', says(' v9.9.9 '))
    expect(await fetchNewer({ program: here() })).toMatchObject({ to: '9.9.9' })
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
    process.env.IT_INSTALL_BASE = 'https://itcan.do/releases'
    keepBase()
    delete process.env.IT_INSTALL_BASE
    expect(existsSync(path.join(folder, 'releases.json'))).toBe(false)
  })

  test('is looked for every half hour until that is turned off, by the command or by a variable', () => {
    expect(LOOKS_EVERY_MS).toBe(30 * 60_000)
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
