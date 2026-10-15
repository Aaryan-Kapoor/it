import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  test.each([404, 200])('bounds real missing or checksum-rejected backend downloads across starts (%s)', async (status) => {
    let requests = 0
    const server = http.createServer((_req, res) => {
      requests++
      res.writeHead(status).end('not a backend archive')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    process.env.IT_BACKEND_RELEASES = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const start = () =>
      recoverStartup(async () => {
        await program(() => {})
        return false
      }, options())
    try {
      for (const [index, delay] of STARTUP_WAITS.entries()) {
        const now = Date.now()
        await expect(start()).rejects.toMatchObject({ code: status === 404 ? 'offline' : 'checksum' })
        expect(record()).toMatchObject({ failures: index + 1, retryAt: now + delay })
        vi.setSystemTime(now + delay)
      }
      expect(await start()).toBe(false)
      expect(startupStatus()).toMatchObject({ failures: 4, paused: true, retryAt: null })
      expect(await start()).toBe(false)
      expect(requests).toBe(4)
      expect(said.join('\n')).toContain('it service install')
      expect(said.join('\n')).not.toContain('private explanation')
      // A new process sees the persisted stop before it tries to read settings or fetch anything.
      const child = spawnSync(process.execPath, ['packages/cli/dist/it.mjs', 'serve', '--supervised'], { env: process.env, encoding: 'utf8', timeout: 15_000 })
      expect([child.status, child.stderr]).toEqual([0, expect.stringContaining('automatic startup stopped')])
      expect(requests).toBe(4)
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

  test('stops at once for a failure that requires changed data or settings, without changing either', async () => {
    writeFileSync(path.join(folder, 'service.json'), 'settings left intact')
    for (const code of ['settings', 'backend_releases', 'backend_older', 'database_unopened', 'record_unread']) {
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

  test('keeps an unreadable retry record and starts nothing until an explicit retry', async () => {
    writeFileSync(path.join(folder, 'startup.json'), '{broken')
    const run = vi.fn(async () => false)
    expect(await recoverStartup(run, options())).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(readFileSync(path.join(folder, 'startup.json'), 'utf8')).toBe('{broken')
    expect(said.join('\n')).toContain('record_unread')
    expect(() => startupStatus()).toThrow('startup.json')
    resetStartup()
    expect(await recoverStartup(run, options())).toBe(false)
    expect(run).toHaveBeenCalledOnce()
  })
})
