import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { askConnectorWith, closedToNetwork, keptFromIt, notLet } from './src/lib'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.join(here, 'dist', 'it.mjs')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'it-shutin-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** An error as the system gives it for a connection, with its code. */
const failed = (code: string) => Object.assign(new Error(`connect ${code}`), { code, syscall: 'connect' })

describe('a command that the system keeps from the network', () => {
  test('is told from one that nothing answered: by the system’s own word for it, and here, where this program may listen, by nothing else', async () => {
    expect([notLet(failed('EPERM')), notLet(failed('EACCES')), notLet(failed('ECONNREFUSED')), notLet(new Error('no code'))]).toEqual([
      true,
      true,
      false,
      false,
    ])
    // A runtime that gives the refusal as a connection nothing answered is asked whether it may use the network at all
    expect(await closedToNetwork()).toBe(false)
    expect([await keptFromIt(failed('EPERM')), await keptFromIt(failed('ECONNREFUSED')), await keptFromIt(new Error('no code'))]).toEqual([true, false, false])
  })

  test('is found, where it is given a network of its own with nothing on it, by the part of It that hands clicks on answering at its socket while nothing answers at It’s port', async () => {
    // A folder that is set up: only there is It this machine's own to ask after
    const home = path.join(tmp, 'asked')
    mkdirSync(home, { recursive: true })
    writeFileSync(path.join(home, 'service.json'), JSON.stringify({ port: 17_700 }))
    const before = { home: process.env.IT_HOME, url: process.env.IT_URL, port: process.env.IT_PORT }
    process.env.IT_HOME = home
    delete process.env.IT_URL
    delete process.env.IT_PORT
    try {
      askConnectorWith(async () => true)
      expect(await keptFromIt(failed('ECONNREFUSED'))).toBe(true)
      // Nothing answers at the socket either: It is not running, and that is what is said
      askConnectorWith(async () => false)
      expect(await keptFromIt(failed('ECONNREFUSED'))).toBe(false)
      askConnectorWith(() => Promise.reject(new Error('no socket')))
      expect(await keptFromIt(failed('ECONNREFUSED'))).toBe(false)
      // An It at another address is not this machine's: what answers at this machine's socket says nothing of it
      askConnectorWith(async () => true)
      process.env.IT_URL = 'http://192.0.2.1:4700'
      expect(await keptFromIt(failed('ECONNREFUSED'))).toBe(false)
    } finally {
      askConnectorWith(async () => false)
      for (const [name, value] of [
        ['IT_HOME', before.home],
        ['IT_URL', before.url],
        ['IT_PORT', before.port],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test('says so, and neither that It is not running nor to start it: `it status`, where every connection is refused as a sandbox refuses it', async () => {
    // A folder that is set up, on a port nothing listens at, and a program whose every connection the system refuses
    const home = path.join(tmp, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(path.join(home, 'service.json'), JSON.stringify({ port: 17_650 }))
    const refuses = path.join(tmp, 'refuses.mjs')
    writeFileSync(
      refuses,
      [
        "import net from 'node:net'",
        'net.Socket.prototype.connect = function () {',
        "  queueMicrotask(() => this.destroy(Object.assign(new Error('connect EPERM'), { code: 'EPERM', syscall: 'connect' })))",
        '  return this',
        '}',
      ].join('\n'),
    )
    const run = (args: string[], refused: boolean) =>
      new Promise<{ code: number; out: string; err: string }>((resolve) => {
        const env = { ...process.env, IT_HOME: home, IT_TELEMETRY_ENABLED: 'false', NODE_OPTIONS: refused ? `--import=${pathToFileURL(refuses).href}` : '' }
        for (const name of ['IT_PORT', 'IT_URL', 'IT_SITE_URL']) delete (env as Record<string, string | undefined>)[name]
        execFile(process.execPath, [bundle, ...args], { env }, (error, out, err) => resolve({ code: (error as { code?: number } | null)?.code ?? 0, out, err }))
      })
    const kept = await run(['status', '--json'], true)
    const stands = JSON.parse(kept.out) as { blocked?: boolean; running: boolean | null; hint: string; connector: { running: boolean | null } }
    // Whether It is running cannot be seen from there: said first, and as not known, so that no agent reads it as stopped
    expect(Object.keys(stands).slice(0, 2)).toEqual(['blocked', 'hint'])
    expect([stands.blocked, stands.running, stands.connector.running]).toEqual([true, null, null])
    expect(stands.hint).toContain('It could not be asked from here')
    expect(stands.hint).toContain('It may well be running')
    expect(stands.hint).not.toContain('it serve')
    // The same folder, with nothing refused: nothing answers, and that is what is said
    const free = await run(['status', '--json'], false)
    const freely = JSON.parse(free.out) as { blocked?: boolean; running: boolean; hint: string }
    expect(freely.hint).toContain('It is not running on this machine.')
    expect([freely.blocked, freely.running]).toEqual([undefined, false])
  })
})
