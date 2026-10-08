// What the program needs of Node when it is run as a script: which versions it runs under, and
// that Node's own notice about its database module is the one warning kept off the terminal.
import { spawn } from 'node:child_process'
import net from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { lenientAboutServiceMarks, nodeTooOld, quietAboutItsDatabase } from './src/node'

describe('the Node this program is run under', () => {
  test('is new enough from 22.13 on, and under anything older the person is told in one sentence which Node is needed', () => {
    for (const version of ['22.13.0', '22.22.3', '23.4.0', '23.11.1', '24.0.0', '24.18.0', '25.1.0', '100.0.0'])
      expect([version, nodeTooOld(version)]).toEqual([version, undefined])
    for (const version of ['22.12.0', '22.0.0', '22.3.0', '20.20.0', '18.19.1', '9.11.2']) {
      const refused = nodeTooOld(version)!
      expect([version, refused.code, refused.message]).toEqual([version, 'unsupported', `It needs Node 22.13 or later, and this is Node ${version}.`])
      expect(refused.hint).toBe('Run it under a newer Node, or install the standalone `it` program, which needs no Node at all.')
    }
    // The one this test runs under is one it runs under
    expect(nodeTooOld(process.versions.node)).toBeUndefined()
  })

  test('the first releases of Node 23 are newer than 22.13 and still need a flag for their database, so they are refused, and told which Node 23 is needed', () => {
    for (const version of ['23.0.0', '23.1.0', '23.3.0']) {
      const refused = nodeTooOld(version)!
      expect([version, refused.code, refused.message]).toEqual([
        version,
        'unsupported',
        `It needs Node 23.4 or later among the releases of Node 23, and this is Node ${version}.`,
      ])
      expect(refused.hint).toBe('Run it under a newer Node, or install the standalone `it` program, which needs no Node at all.')
    }
  })
})

describe('what Node says of itself', () => {
  const emit = process.emitWarning
  afterEach(() => {
    process.emitWarning = emit
  })

  test('that its database module is experimental is kept off the terminal, and every other warning is passed on as it was', async () => {
    const passed: unknown[][] = []
    process.emitWarning = ((...args: unknown[]) => void passed.push(args)) as typeof process.emitWarning
    quietAboutItsDatabase()
    // As Node itself says it, in both of the ways a warning is given
    process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning')
    process.emitWarning('SQLite is an experimental feature and might change at any time', { type: 'ExperimentalWarning' })
    expect(passed).toEqual([])
    process.emitWarning('Something else is an experimental feature', 'ExperimentalWarning')
    process.emitWarning('SQLite could not be opened', 'DeprecationWarning')
    process.emitWarning(new Error('SQLite is on fire'))
    process.emitWarning('A plain warning')
    expect(passed.map((args) => String(args[0]))).toEqual([
      'Something else is an experimental feature',
      'SQLite could not be opened',
      'Error: SQLite is on fire',
      'A plain warning',
    ])
    expect(passed[0]).toEqual(['Something else is an experimental feature', 'ExperimentalWarning'])
  })
})

describe("what Node's own fetch does with a connection that was reset as it was made", () => {
  const sockets = net.Socket.prototype as unknown as { setTypeOfService?: (this: net.Socket, tos: number) => unknown }
  const set = sockets.setTypeOfService
  afterEach(() => {
    if (set) sockets.setTypeOfService = set
  })

  // The refusal itself is macOS's alone, so this is the test of it only where it runs there:
  // it says how many marks the system refused, and elsewhere that number is nought
  test('a fetch to a server that resets every connection as it is made fails as a fetch, and nothing is thrown where no caller could catch it', async () => {
    // In a process of its own, as the backend is, so that a reset can come while this one is still busy with the connection
    const server = spawn(
      process.execPath,
      ['-e', "require('node:net').createServer((s) => s.resetAndDestroy()).listen(0, '127.0.0.1', function () { console.log(this.address().port) })"],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    const thrown: unknown[] = []
    const noted = (err: unknown) => void thrown.push(err)
    process.on('uncaughtException', noted)
    try {
      const port = await new Promise<string>((resolve, reject) => {
        server.stdout.once('data', (chunk) => resolve(String(chunk).trim()))
        server.once('exit', () => reject(new Error('the server ended before it listened')))
      })
      let refused = 0
      if (set)
        sockets.setTypeOfService = function (this: net.Socket, tos: number) {
          try {
            return set.call(this, tos)
          } catch (err) {
            refused++
            throw err
          }
        }
      lenientAboutServiceMarks()
      const ends = await Promise.allSettled(Array.from({ length: 400 }, () => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(30_000) })))
      // What Node throws of its own comes a turn later than what it answers
      await new Promise((resolve) => setTimeout(resolve, 300))
      console.log(`the system refused ${refused} of ${ends.length} marks (${process.platform}, Node ${process.versions.node})`)
      expect(thrown).toEqual([])
      expect(ends.filter((end) => end.status === 'fulfilled')).toEqual([])
      expect(new Set(ends.map((end) => (end.status === 'rejected' ? String((end.reason as Error).name) : '')))).toEqual(new Set(['TypeError']))
    } finally {
      process.off('uncaughtException', noted)
      server.kill('SIGKILL')
    }
  }, 60_000)

  test("the system's refusal of a mark is let pass, and a value that is no type of service is still the caller's mistake", async () => {
    if (!set) return
    const server = net.createServer((socket) => socket.on('error', () => {}))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const socket = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1')
    try {
      await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject))
      // The system's answer on macOS for a connection that was reset, given here on every system
      const handle = (socket as unknown as { _handle: { setTypeOfService: (tos: number) => number } })._handle
      handle.setTypeOfService = () => -22
      expect(() => socket.setTypeOfService(8)).toThrow(/EINVAL/)
      lenientAboutServiceMarks()
      expect(socket.setTypeOfService(16)).toBe(socket)
      expect(() => socket.setTypeOfService(300)).toThrow(/tos/)
    } finally {
      socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
