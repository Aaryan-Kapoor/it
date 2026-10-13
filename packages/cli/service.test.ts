// What the background service is given when it is registered, and what is kept of it when it
// is registered again: checked on the definitions themselves, with no system asked to take one.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { alone } from './src/serve/backend'
import { againWith, askToStop, command, environment, given, kept, launchdPlist, runningFor, stopFile, systemdUnit, windowsLauncher } from './src/service'

describe('what a service is given of the shell that registered it', () => {
  test('that the person’s shell is not to be asked is said to the service, which is what would ask it', () => {
    expect(environment({ PATH: '/bin', IT_SHELL_ENV: 'off' })).toEqual({ PATH: '/bin', IT_SHELL_ENV: 'off' })
  })
  test('that It is not to look for a newer version is not, since `it updates on` could then never turn it back on', () => {
    expect(environment({ PATH: '/bin', IT_UPDATE_CHECK: 'false' })).toEqual({ PATH: '/bin' })
  })
})

describe('what a registered service was given, read back from its definition', () => {
  const cmd = ['/home/a user/.it/bin/it', 'serve', '--log', '/home/a user/.it/logs/it.log']
  // Every character that one of the three definitions writes as something other than itself
  const env = {
    PATH: '/bin:/usr/bin',
    IT_HOME: '/home/a user/50% & <done> "it" \\ $HOME',
    IT_PORT: '4800',
    IT_BACKEND_BIN: '/opt/back^end/(convex)|local',
    IT_URL: 'http://127.0.0.1:23000',
  }
  test('is every setting as the shell gave it, on all three systems, whatever characters are in it', () => {
    expect(given(systemdUnit(cmd, env), 'linux')).toEqual(env)
    expect(given(launchdPlist(cmd, env), 'darwin')).toEqual(env)
    expect(given(windowsLauncher(['C:\\it\\bin\\it.exe', 'serve'], env), 'win32')).toEqual(env)
  })
  test('is nothing where the definition gives nothing, or is not one', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(given('', platform)).toEqual({})
      expect(given('not a definition\nset\nEnvironment=\n<key>IT_PORT</key>', platform)).toEqual({})
    }
    expect(given(systemdUnit(cmd, env), 'freebsd')).toEqual({})
  })
  test.skipIf(process.platform !== 'linux')(
    'is kept when the service is registered again from a shell that names less, as an upgrade registers it, and gives way to what that shell does name',
    () => {
      const user = mkdtempSync(path.join(os.tmpdir(), 'it-kept-'))
      const before = { home: process.env.IT_HOME, config: process.env.XDG_CONFIG_HOME }
      try {
        process.env.IT_HOME = path.join(user, 'it')
        process.env.XDG_CONFIG_HOME = path.join(user, 'config')
        const registered = path.join(user, 'config', 'systemd', 'user', 'it.service')
        mkdirSync(path.dirname(registered), { recursive: true })
        // Nothing is registered: nothing was given
        expect(kept()).toEqual({})
        expect(againWith({ PATH: '/bin', TERM: 'xterm' })).toEqual({ PATH: '/bin', TERM: 'xterm' })
        // Registered with a port and a backend program that only the shell of that day named
        const saved = { PATH: '/then/bin', IT_HOME: process.env.IT_HOME, IT_PORT: '4800', IT_BACKEND_BIN: '/opt/backend/convex-local-backend' }
        writeFileSync(registered, systemdUnit(command(), saved))
        // The PATH is each shell's own to give, and is not kept
        expect(kept()).toEqual({ IT_HOME: saved.IT_HOME, IT_PORT: '4800', IT_BACKEND_BIN: '/opt/backend/convex-local-backend' })
        // A terminal that names neither: both go on to the setup that registers the service again
        expect(againWith({ PATH: '/now/bin', TERM: 'xterm' })).toEqual({
          PATH: '/now/bin',
          TERM: 'xterm',
          IT_HOME: saved.IT_HOME,
          IT_PORT: '4800',
          IT_BACKEND_BIN: '/opt/backend/convex-local-backend',
        })
        // What the terminal does name is what it says, as it always was
        expect(againWith({ PATH: '/now/bin', IT_PORT: '4900' }).IT_PORT).toBe('4900')
        // A definition that is another folder's says nothing of this one
        process.env.IT_HOME = path.join(user, 'another')
        expect(kept()).toEqual({})
      } finally {
        for (const [name, was] of [
          ['IT_HOME', before.home],
          ['XDG_CONFIG_HOME', before.config],
        ] as const)
          if (was === undefined) delete process.env[name]
          else process.env[name] = was
        rmSync(user, { recursive: true, force: true })
      }
    },
  )
})

describe.skipIf(process.platform === 'win32')('whether a service is running for a folder', () => {
  test('is told by the very process its lock names, and a number that has come to be another process’s is not waited for', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-running-'))
    const before = process.env.IT_HOME
    try {
      process.env.IT_HOME = folder
      // A lock as It writes one, which says of this very process when it was started and where
      let mine = { pid: 0, started: '', where: '', holder: '' }
      await alone('connector', async () => {
        mine = JSON.parse(readFileSync(path.join(folder, 'connector.lock'), 'utf8'))
      })
      expect([mine.pid, typeof mine.started, typeof mine.where]).toEqual([process.pid, 'string', 'string'])
      mkdirSync(path.join(folder, 'backend'))
      const [backend, connector, note] = [path.join(folder, 'backend', 'lock'), path.join(folder, 'connector.lock'), path.join(folder, 'connector.json')]
      // A process that was started at another time under the same number, as one is after the service has died and its number was given out again
      const another = { ...mine, started: `${mine.started} and later` }
      for (const [lock, held] of [
        [mine, true],
        [another, false],
      ] as const) {
        // The service of a machine that runs It, by the backend's lock
        writeFileSync(backend, JSON.stringify(lock))
        expect(runningFor(folder)).toBe(held)
        rmSync(backend)
        // And of one that only joined an It, by the connector's note, whose lock says which process the note's number was
        writeFileSync(note, JSON.stringify({ pid: lock.pid, token: 'x', version: 'x', startedAt: 0 }))
        writeFileSync(connector, JSON.stringify(lock))
        expect(runningFor(folder)).toBe(held)
        rmSync(note)
        rmSync(connector)
      }
      // What is left of a service that is gone is not asked to stop, and nothing is waited for
      writeFileSync(backend, JSON.stringify(another))
      writeFileSync(note, JSON.stringify({ pid: another.pid, token: 'x', version: 'x', startedAt: 0 }))
      writeFileSync(connector, JSON.stringify(another))
      askToStop(folder, 50)
      expect(existsSync(stopFile(folder))).toBe(false)
      // A note with no lock beside it to say which process it meant is gone by as it always was: by its number alone
      rmSync(connector)
      expect(runningFor(folder)).toBe(true)
    } finally {
      if (before === undefined) delete process.env.IT_HOME
      else process.env.IT_HOME = before
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
