// The service being asked to stop while its backend is slow to answer. The backend, the door
// and the settings are stand-ins here, so that what the backend answers, and when, is the
// test's to say: the service itself is the real one, and is asked to stop as Windows asks it,
// by the file in its folder.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { bases } from './test-ports'

const stand = vi.hoisted(() => ({
  port: 0,
  /** What the backend answers when it is told how the door stands, each time it is told. */
  told: [] as (() => Promise<unknown>)[],
  /** How often it was told. */
  tellings: 0,
  doorClosed: false,
  contentClosed: false,
  backendStopped: false,
}))
vi.mock('./src/serve/config', async (original) => ({
  ...(await original<typeof import('./src/serve/config')>()),
  readConfig: () => ({ port: stand.port, network: false, instanceSecret: 'ab'.repeat(32), adminKey: 'x', doorSecret: 'x' }),
}))
vi.mock('./src/serve/backend', async (original) => ({
  ...(await original<typeof import('./src/serve/backend')>()),
  startBackend: async () => ({
    api: 'http://127.0.0.1:1',
    site: 'http://127.0.0.1:1',
    adminKey: 'x',
    stop: async () => {
      stand.backendStopped = true
    },
    ended: new Promise(() => {}),
  }),
  asAdmin: async (_backend: unknown, name: string) => {
    if (name !== 'network:report') return null
    stand.tellings++
    return (stand.told.shift() ?? (async () => null))()
  },
}))
vi.mock('./src/serve/door', () => ({
  makeContent: () => ({
    close: async () => {
      stand.contentClosed = true
    },
  }),
  startDoor: async () => ({
    stop: async () => {
      stand.doorClosed = true
    },
  }),
}))

import { serve } from './src/serve/index'
import { stopFile } from './src/service'

const ports = bases(28_000, 10)
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe.skipIf(process.platform === 'win32')('a service that is asked to stop while its backend is slow to answer', () => {
  const KEPT = ['IT_HOME', 'XDG_CONFIG_HOME'] as const
  let before: Record<string, string | undefined>
  let folder: string
  beforeEach(async () => {
    before = Object.fromEntries(KEPT.map((name) => [name, process.env[name]]))
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-stopping-'))
    // Nothing of whoever runs the tests is looked at: not their It, and not their service's definition
    process.env.IT_HOME = folder
    process.env.XDG_CONFIG_HOME = path.join(folder, 'config')
    stand.port = await ports.next()
    stand.told = []
    stand.tellings = 0
    stand.doorClosed = false
    stand.contentClosed = false
    stand.backendStopped = false
  })
  afterEach(async () => {
    for (const name of KEPT)
      if (before[name] === undefined) delete process.env[name]
      else process.env[name] = before[name]
    rmSync(folder, { recursive: true, force: true })
    await ports.release()
  })

  test('closes its door at once, though the backend has not answered what it was last told of how the door stands, and tells it nothing more', async () => {
    // As the service starts, the backend cannot be told, so the next look tells it again: and that telling is never answered
    let fail: (err: Error) => void = () => {}
    stand.told = [
      async () => {
        throw new Error('busy')
      },
      async () => {
        throw new Error('busy')
      },
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    ]
    const said: string[] = []
    let ended = false
    const serving = serve((line) => said.push(line)).then(() => {
      ended = true
    })
    for (const until = Date.now() + 20_000; stand.tellings < 3 && Date.now() < until; ) await pause(25)
    expect([stand.tellings, stand.doorClosed]).toEqual([3, false])
    // Asked to stop by its file, it stops: the door is closed without the answer being waited for
    writeFileSync(stopFile(folder), '')
    for (const until = Date.now() + 10_000; !ended && Date.now() < until; ) await pause(25)
    expect([ended, stand.doorClosed]).toEqual([true, true])
    expect(said.at(-1)).toBe('service stopped')
    await serving
    // The telling that was under way fails in the end, as one does that was given up: the shorter word is not sent after it
    fail(new Error('gone'))
    await pause(100)
    expect(stand.tellings).toBe(3)
    expect(said.filter((line) => line.includes('could not be told'))).toHaveLength(1)
  }, 60_000)

  test('closes its door and content service and stops the backend when stopping interrupts the first status report', async () => {
    let fail: (err: Error) => void = () => {}
    stand.told = [
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    ]
    const said: string[] = []
    let ended = false
    const serving = serve((line) => said.push(line)).then(() => {
      ended = true
    })
    try {
      for (const until = Date.now() + 10_000; stand.tellings < 1 && Date.now() < until; ) await pause(25)
      expect(stand.tellings).toBe(1)
      writeFileSync(stopFile(folder), '')
      for (const until = Date.now() + 3000; !ended && Date.now() < until; ) await pause(25)
      expect([ended, stand.doorClosed, stand.contentClosed, stand.backendStopped]).toEqual([true, true, true, true])
    } finally {
      fail(new Error('the first report timed out'))
      await serving
    }
    await pause(100)
    expect(stand.tellings).toBe(1)
    expect(said.some((line) => line.includes('could not be told'))).toBe(false)
    expect(said.at(-1)).toBe('service stopped')
  })
})
