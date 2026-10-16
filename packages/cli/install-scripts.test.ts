import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
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
