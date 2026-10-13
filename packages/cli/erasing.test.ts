// A person erasing everything while the connector is still running. The connector keeps what
// it has heard of conversations in memory and writes it down again as it goes, so what the
// service removes when it is told of the erasing can come back before the connector has
// stopped. The backend, the door and the connector are stand-ins here, and the service itself
// is the real one.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { bases } from './test-ports'

const stand = vi.hoisted(() => ({
  port: 0,
  /** What the service gave the content service to tell it of an erasing by. */
  erased: undefined as ((person: string) => void | Promise<void>) | undefined,
  /** Called by the test when the stand-in connector is to stop by itself, as one does whose machine It no longer knows. */
  connectorStops: () => {},
  connectorRuns: 0,
  /** Whether the stand-in connector has written down, on its way out, what it held. */
  wrote: false,
}))
vi.mock('./src/serve/config', async (original) => ({
  ...(await original<typeof import('./src/serve/config')>()),
  readConfig: () => ({ port: stand.port, network: false, instanceSecret: 'ab'.repeat(32), adminKey: 'x', doorSecret: 'x' }),
}))
vi.mock('./src/serve/backend', async (original) => ({
  ...(await original<typeof import('./src/serve/backend')>()),
  startBackend: async () => ({ api: 'http://127.0.0.1:1', site: 'http://127.0.0.1:1', adminKey: 'x', stop: async () => {}, ended: new Promise(() => {}) }),
  asAdmin: async () => null,
}))
vi.mock('./src/serve/door', () => ({
  makeContent: (_config: unknown, _backend: unknown, _say: unknown, erased: (person: string) => void) => {
    stand.erased = erased
    return { close: async () => {} }
  },
  startDoor: async () => ({ stop: async () => {} }),
}))
vi.mock('./src/connector', async (original) => ({
  ...(await original<typeof import('./src/connector')>()),
  // A connector that runs until it is told that its machine is not one of It's any more, and
  // on its way out writes down what it had in memory, as the real one does
  runConnector: async () => {
    stand.connectorRuns++
    await new Promise<void>((resolve) => {
      stand.connectorStops = resolve
    })
    for (const name of ['heard.json', 'cut-off.json']) writeFileSync(path.join(process.env.IT_HOME!, name), JSON.stringify({ 'pi:a-conversation': 1 }))
    stand.wrote = true
  },
}))

import { serve } from './src/serve/index'
import { stopFile } from './src/service'

const ports = bases(28_500, 10)
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const until = async (what: () => boolean, ms = 20_000) => {
  for (const end = Date.now() + ms; !what() && Date.now() < end; ) await pause(25)
  return what()
}

describe.skipIf(process.platform === 'win32')('a person who erases everything while the connector is running', () => {
  const KEPT = ['IT_HOME', 'XDG_CONFIG_HOME'] as const
  let before: Record<string, string | undefined>
  let folder: string
  beforeEach(async () => {
    before = Object.fromEntries(KEPT.map((name) => [name, process.env[name]]))
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-erasing-'))
    // Nothing of whoever runs the tests is looked at: not their It, and not their service's definition
    process.env.IT_HOME = folder
    process.env.XDG_CONFIG_HOME = path.join(folder, 'config')
    stand.port = await ports.next()
    stand.erased = undefined
    stand.connectorRuns = 0
    stand.wrote = false
  })
  afterEach(async () => {
    for (const name of KEPT)
      if (before[name] === undefined) delete process.env[name]
      else process.env[name] = before[name]
    rmSync(folder, { recursive: true, force: true })
    await ports.release()
  })

  test('has what the connector wrote down of their conversations on its way out removed as well, once the connector has stopped', async () => {
    const [folders, heard, cutOff] = ['conversations.json', 'heard.json', 'cut-off.json'].map((name) => path.join(folder, name))
    writeFileSync(path.join(folder, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key: {} }))
    writeFileSync(folders!, JSON.stringify({ 'pi:a-conversation': { cwd: '/home/a person/a client of theirs', at: 1 } }))
    writeFileSync(heard!, JSON.stringify({ 'pi:a-conversation': 1 }))
    let ended = false
    const serving = serve(() => {}).then(() => {
      ended = true
    })
    expect(await until(() => stand.connectorRuns === 1 && stand.erased !== undefined)).toBe(true)
    // The service is told of the erasing, and removes what is written down
    await stand.erased!('the person who erased everything')
    expect([existsSync(folders!), existsSync(heard!)]).toEqual([false, false])
    // The connector learns a moment later that its machine is gone, writes down what it still held, and stops
    stand.connectorStops()
    expect(await until(() => stand.wrote)).toBe(true)
    expect(await until(() => !existsSync(heard!) && !existsSync(cutOff!), 5000)).toBe(true)
    writeFileSync(stopFile(folder), '')
    expect(await until(() => ended)).toBe(true)
    await serving
  }, 60_000)
})
