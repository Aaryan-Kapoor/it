import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Problem } from './src/lib'
import { program } from './src/serve/backend'
import { recoverStartup, resetStartup, STARTUP_WAITS, startupKey, startupStatus } from './src/serve/startup'

describe('a background service that cannot start', () => {
  let folder: string
  let was: NodeJS.ProcessEnv
  let said: string[]
  const options = () => ({ supervised: true, signal: new AbortController().signal, say: (line: string) => said.push(line) })
  const fail = (code = 'offline') =>
    recoverStartup(async () => {
      throw new Problem('private explanation', code)
    }, options())
  const record = () => JSON.parse(readFileSync(path.join(folder, 'startup.json'), 'utf8'))
  beforeEach(() => {
    was = { ...process.env }
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-startup-'))
    process.env.IT_HOME = folder
    process.env.IT_PORT = '39001'
    process.env.IT_SHELL_ENV = 'off'
    delete process.env.IT_BACKEND_BIN
    said = []
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    process.env = was
    rmSync(folder, { recursive: true, force: true })
  })

  test('stops downloading a backend whose checksum is wrong until a person retries it', async () => {
    let requests = 0
    const server = http.createServer((_req, res) => {
      requests++
      res.writeHead(200).end('not a backend archive')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The test server has no port.')
    process.env.IT_BACKEND_RELEASES = `http://127.0.0.1:${address.port}`
    const start = () =>
      recoverStartup(async () => {
        await program(() => {})
        return false
      }, options())
    try {
      expect(await start()).toBe(false)
      expect(startupStatus()).toMatchObject({ failures: 1, code: 'checksum', paused: true, retryAt: null })
      expect(await start()).toBe(false)
      expect(requests).toBe(1)
      expect(said.join('\n')).toContain('it service install')
      expect(said.join('\n')).not.toContain('private explanation')
      // A new process sees the persisted stop before it tries to read settings or fetch anything.
      const child = spawnSync(process.execPath, ['packages/cli/dist/it.mjs', 'serve', '--supervised'], { env: process.env, encoding: 'utf8', timeout: 15_000 })
      expect([child.status, child.stderr]).toEqual([0, expect.stringContaining('automatic startup stopped')])
      expect(requests).toBe(1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test.each([
    new Problem('The backend program could not be fetched.', 'offline'),
    ...['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].map((code) => Object.assign(new Error('private explanation'), { code })),
    new TypeError('fetch failed', { cause: Object.assign(new Error('DNS is unavailable'), { code: 'ENOTFOUND' }) }),
    new DOMException('The request timed out.', 'TimeoutError'),
  ])('keeps retrying a temporary failure at the last interval, then starts when it clears: %s', async (error) => {
    const run = vi.fn(async () => {
      throw error
    })
    for (const [index, delay] of [30_000, 120_000, 600_000, 600_000, 600_000, 600_000, 600_000].entries()) {
      const failures = index + 1
      const now = Date.now()
      await expect(recoverStartup(run, options())).rejects.toBe(error)
      expect(startupStatus()).toMatchObject({ failures, retryAt: now + delay, paused: false })
      vi.setSystemTime(now + delay)
    }
    expect(run).toHaveBeenCalledTimes(7)
    const ready = vi.fn(async (ready: () => void) => {
      ready()
      return false
    })
    expect(await recoverStartup(ready, options())).toBe(false)
    expect(ready).toHaveBeenCalledOnce()
    expect(startupStatus()).toBeUndefined()
    expect(said.join('\n')).not.toContain('private explanation')
  })

  test('keeps retrying a missing backend download after the fourth attempt', async () => {
    let requests = 0
    const server = http.createServer((_req, res) => {
      requests++
      res.writeHead(404).end('not here')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The test server has no port.')
    process.env.IT_BACKEND_RELEASES = `http://127.0.0.1:${address.port}`
    try {
      for (let failures = 1; failures <= 5; failures++) {
        await expect(
          recoverStartup(async () => {
            await program(() => {})
            return false
          }, options()),
        ).rejects.toMatchObject({ code: 'offline' })
        expect(startupStatus()).toMatchObject({ failures, paused: false })
        vi.setSystemTime(record().retryAt)
      }
      expect(requests).toBe(5)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('does not start again while waiting, and can be stopped during the wait', async () => {
    await expect(fail()).rejects.toMatchObject({ code: 'offline' })
    const controller = new AbortController()
    const run = vi.fn(async () => false)
    const pending = recoverStartup(run, { ...options(), signal: controller.signal })
    controller.abort()
    expect(await pending).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(record().failures).toBe(1)
  })

  test.each(['manual start', 'reset', 'later retry', 'paused retry', 'changed settings'])(
    'does not use a stale attempt after waiting through a %s',
    async (change) => {
      await expect(fail()).rejects.toMatchObject({ code: 'offline' })
      const before = { ...record(), retryAt: Date.now() + 10 }
      writeFileSync(path.join(folder, 'startup.json'), JSON.stringify(before))
      const run = vi.fn(async () => {
        throw new Problem('a manual service is already running', 'already_running')
      })
      const pending = recoverStartup(run, options())
      expect(said.at(-1)).toContain('startup retry waits')
      if (change === 'manual start') {
        const manual = vi.fn(async (ready: () => void) => {
          ready()
          return false
        })
        await recoverStartup(manual, { ...options(), supervised: false })
        expect(manual).toHaveBeenCalledOnce()
      } else if (change === 'reset') resetStartup()
      else if (change === 'later retry') {
        writeFileSync(path.join(folder, 'startup.json'), JSON.stringify({ ...before, failures: 2, retryAt: Date.now() + STARTUP_WAITS[1] }))
      } else if (change === 'paused retry') {
        writeFileSync(path.join(folder, 'startup.json'), JSON.stringify({ ...before, code: 'settings', retryAt: null }))
      } else if (change === 'changed settings') writeFileSync(path.join(folder, 'service.json'), 'changed settings')
      const kept = existsSync(path.join(folder, 'startup.json')) ? readFileSync(path.join(folder, 'startup.json'), 'utf8') : undefined
      await expect(pending).resolves.toBe(false)
      expect(run).not.toHaveBeenCalled()
      if (kept === undefined) expect(existsSync(path.join(folder, 'startup.json'))).toBe(false)
      else expect(readFileSync(path.join(folder, 'startup.json'), 'utf8')).toBe(kept)
    },
  )

  test('counts another failure after waiting when the retry record and settings are unchanged', async () => {
    await expect(fail()).rejects.toMatchObject({ code: 'offline' })
    writeFileSync(path.join(folder, 'startup.json'), JSON.stringify({ ...record(), retryAt: Date.now() + 10 }))
    await expect(fail()).rejects.toMatchObject({ code: 'offline' })
    expect(record()).toMatchObject({ failures: 2, retryAt: Date.now() + STARTUP_WAITS[1] })
  })

  test('stops at once for a failure that requires changed data or settings, without changing either', async () => {
    writeFileSync(path.join(folder, 'service.json'), 'settings left intact')
    for (const code of ['settings', 'backend_releases', 'backend_program', 'backend_older', 'database_unopened', 'record_unread']) {
      resetStartup()
      expect(await fail(code)).toBe(false)
      expect(startupStatus()).toMatchObject({ failures: 1, code, paused: true })
    }
    expect(readFileSync(path.join(folder, 'service.json'), 'utf8')).toBe('settings left intact')
  })

  test('retries changed settings, a replaced custom backend, and an explicit manual start', async () => {
    expect(await fail('settings')).toBe(false)
    const key = startupKey()
    process.env.IT_PORT = '39011'
    expect(startupKey()).not.toBe(key)
    await expect(fail()).rejects.toMatchObject({ code: 'offline' })
    expect(record().failures).toBe(1)
    process.env.IT_BACKEND_BIN = path.join(folder, 'custom-backend')
    const missing = startupKey()
    writeFileSync(process.env.IT_BACKEND_BIN, 'a repaired program')
    expect(startupKey()).not.toBe(missing)
    // A new release has another key, so a record of an earlier release cannot suppress it.
    const earlier = { ...record(), key: '0'.repeat(64), retryAt: null }
    writeFileSync(path.join(folder, 'startup.json'), JSON.stringify(earlier))
    await expect(fail()).rejects.toMatchObject({ code: 'offline' })
    expect(record().failures).toBe(1)
    let ran = false
    await recoverStartup(
      async () => {
        ran = true
        return false
      },
      { ...options(), supervised: false },
    )
    expect(ran).toBe(true)
    expect(existsSync(path.join(folder, 'startup.json'))).toBe(false)
  })

  test('forgets startup failures once ready and lets a later crash restart normally', async () => {
    await expect(fail()).rejects.toMatchObject({ code: 'offline' })
    vi.setSystemTime(record().retryAt)
    await expect(
      recoverStartup(async (ready) => {
        ready()
        throw new Problem('crashed', 'backend_exited')
      }, options()),
    ).rejects.toMatchObject({ code: 'backend_exited' })
    expect(startupStatus()).toBeUndefined()
    await expect(fail()).rejects.toMatchObject({ code: 'offline' })
    expect(record().failures).toBe(1)
  })

  test('counts a backend that ends while the door is still starting', async () => {
    const controller = new AbortController()
    await expect(
      recoverStartup(
        async () => {
          controller.abort()
          return true
        },
        { ...options(), signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'backend_exited' })
    expect(startupStatus()).toMatchObject({ failures: 1, paused: false, code: 'backend_exited' })
  })

  test.each([
    { contents: '{broken', supervised: true },
    { contents: JSON.stringify({ failures: 'many' }), supervised: true },
    { contents: 'directory', supervised: true },
    { contents: '{broken', supervised: false },
  ])('moves an unreadable retry record aside, reports it once and starts: $contents, supervised $supervised', async ({ contents, supervised }) => {
    const file = path.join(folder, 'startup.json')
    if (contents === 'directory') mkdirSync(file)
    else writeFileSync(file, contents)
    const run = vi.fn(async (ready: () => void) => {
      ready()
      return false
    })
    expect(startupStatus()).toBeUndefined()
    expect(await recoverStartup(run, { ...options(), supervised })).toBe(false)
    expect(run).toHaveBeenCalledOnce()
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.unreadable`)).toBe(true)
    if (contents !== 'directory') expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe(contents)
    expect(said).toEqual(['startup.json could not be read; kept as startup.json.unreadable and its retry count forgotten'])
    expect(await recoverStartup(run, { ...options(), supervised })).toBe(false)
    expect(run).toHaveBeenCalledTimes(2)
    expect(said).toHaveLength(1)
  })

  test('starts with a fresh count when the retry record becomes unreadable during the wait', async () => {
    await expect(fail()).rejects.toMatchObject({ code: 'offline' })
    writeFileSync(path.join(folder, 'startup.json'), JSON.stringify({ ...record(), retryAt: Date.now() + 10 }))
    const run = vi.fn(async () => {
      throw new Problem('The connection is still down.', 'offline')
    })
    const pending = recoverStartup(run, options())
    writeFileSync(path.join(folder, 'startup.json'), '{broken')
    await expect(pending).rejects.toMatchObject({ code: 'offline' })
    expect(run).toHaveBeenCalledOnce()
    expect(record()).toMatchObject({ failures: 1, retryAt: Date.now() + STARTUP_WAITS[0] })
    expect(readFileSync(path.join(folder, 'startup.json.unreadable'), 'utf8')).toBe('{broken')
    expect(said.filter((line) => line.includes('startup.json.unreadable'))).toHaveLength(1)
  })
})
