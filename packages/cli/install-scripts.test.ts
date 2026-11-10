import { execFile, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { INSTALL } from '@it/protocol'
import { expect, test } from 'vitest'
import { markedInstallation, markInstallation } from './src/installation'
import { withInstallationLock } from './src/uninstall-files'

const exec = promisify(execFile)
const windows = process.platform === 'win32'

test.each(['installer', 'uninstall'])(
  'when %s holds the installation lock, the other cannot begin its work',
  async (first) => {
    const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-install-lock-')))
    markInstallation(folder)
    let release = () => {}
    const requested = new Promise<void>((resolve) => {
      release = resolve
    })
    let finish = () => {}
    let downloads = 0
    const server = http.createServer((_request, response) => {
      downloads++
      release()
      finish = () => response.writeHead(503).end()
      if (first === 'uninstall') finish()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The download server has no port.')
    const run = () =>
      exec(
        windows ? 'powershell.exe' : 'sh',
        windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'install/install.ps1'] : ['install/install.sh'],
        {
          env: {
            ...process.env,
            IT_HOME: folder,
            IT_INSTALL_BASE: `http://127.0.0.1:${address.port}`,
            IT_VERSION: 'latest',
            IT_INSTALL_NO_PATH: '1',
            IT_INSTALL_PLAIN: '1',
          },
          // The server deliberately holds a request. A broken script must not keep a test
          // worker alive forever; twenty seconds also allows PowerShell to start on CI.
          timeout: 20_000,
        },
      ).catch((err: Error) => err)
    try {
      if (first === 'installer') {
        const installing = run()
        try {
          await Promise.race([
            requested,
            installing.then((result) => {
              throw new Error(`The installer ended before requesting a download: ${result}`)
            }),
          ])
          await expect(withInstallationLock(folder, async () => 'removed')).rejects.toMatchObject({ code: 'busy' })
          expect(markedInstallation(folder)).toBe(true)
        } finally {
          finish()
          expect(await installing).toBeInstanceOf(Error)
        }
        expect(existsSync(path.join(folder, '.installing'))).toBe(false)
      } else {
        await withInstallationLock(folder, async () => {
          const result = await run()
          expect(result).toBeInstanceOf(Error)
          expect(String(result)).toContain('Another install of It')
          expect(downloads).toBe(0)
          expect(readdirSync(folder).filter((name) => name.startsWith('.install.'))).toEqual([])
        })
      }
      expect(markedInstallation(folder)).toBe(true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(folder, { recursive: true, force: true })
    }
  },
  30_000,
)

const script = (name: string) => readFileSync(path.join(__dirname, '../../install', name), 'utf8')

test("both install scripts download from It's releases on GitHub, the place the program looks for a newer It, and the lines that run them are fetched from there too", () => {
  expect(INSTALL.releases).toBe('https://github.com/Aaryan-Kapoor/it/releases')
  expect(INSTALL.sh).toBe(`curl -fsSL ${INSTALL.releases}/latest/download/install.sh | sh`)
  expect(INSTALL.ps).toBe(`irm ${INSTALL.releases}/latest/download/install.ps1 | iex`)
  expect(script('install.sh')).toContain(`\nUSUAL="${INSTALL.releases}"\nBASE="\${IT_INSTALL_BASE:-\${USUAL}}"\n`)
  expect(script('install.ps1')).toContain(`\n  $usual = '${INSTALL.releases}'\n`)
  for (const name of ['install.sh', 'install.ps1']) {
    // The line in each script's own heading is the line a person runs
    expect(script(name), name).toContain(name === 'install.sh' ? INSTALL.sh : INSTALL.ps)
    expect(script(name), name).not.toMatch(/itcan\.do\/(releases|install\.(sh|ps1))/)
  }
})

test.skipIf(windows)('install.sh notes another place it downloaded from, and takes the note away when it downloads from GitHub again', () => {
  const text = script('install.sh')
  const start = text.indexOf('# Where this was downloaded from is noted for the program')
  const end = text.indexOf('# The folder is put on the PATH by one line', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-install-note-')))
  const usual = /\nUSUAL="([^"]+)"\n/.exec(text)?.[1]
  const note = path.join(folder, 'releases.json')
  const run = (base: string) => {
    writeFileSync(path.join(folder, 'note.sh'), `set -eu\nsay() { printf '%s\\n' "$1"; }\n${text.slice(start, end)}`)
    execFileSync('/bin/sh', [path.join(folder, 'note.sh')], { env: { PATH: process.env.PATH, HOME_DIR: folder, USUAL: usual, BASE: base } })
  }
  try {
    run('https://example.com/mirror')
    expect(JSON.parse(readFileSync(note, 'utf8'))).toEqual({ base: 'https://example.com/mirror' })
    run(INSTALL.releases)
    expect(existsSync(note)).toBe(false)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
