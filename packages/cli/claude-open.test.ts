// Which Claude Code conversations are open at a person's keyboard, as Claude Code keeps note of
// them in its folder's `sessions`: the ones the site asks the person to load It's add-on in.
import childProcess from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openClaude, ranFor, sameProcess } from './src/claude-open'

const folders: string[] = []
afterEach(async () => {
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true })
})

/** A Claude Code folder with these sessions in it, each written as Claude Code writes one. */
function folderWith(sessions: Record<string, unknown>[]): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'it-claude-'))
  folders.push(folder)
  mkdirSync(path.join(folder, 'sessions'))
  for (const s of sessions) writeFileSync(path.join(folder, 'sessions', `${s.pid}.json`), JSON.stringify(s))
  return folder
}
const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`
const session = (pid: number, more: Record<string, unknown> = {}) => ({
  pid,
  sessionId: id(pid % 10),
  cwd: '/somewhere',
  startedAt: 1_000 + pid,
  procStart: `start-${pid}`,
  version: '2.1.321',
  kind: 'interactive',
  entrypoint: 'cli',
  ...more,
})
// Processes 1 to 6 are running, and each is the Claude Code that wrote its file where its file says the moment it began
const alive = (pid: number) => pid >= 1 && pid <= 6
const started = (pid: number, note: { procStart?: unknown }) => note.procStart === `start-${pid}`

describe('the Claude Code conversations open at a person’s keyboard', async () => {
  test('are those of a running Claude Code that a person types to', async () => {
    const folder = folderWith([session(1), session(2, { entrypoint: 'claude-vscode' })])
    expect(await openClaude([folder], alive, started)).toEqual([
      { id: id(1), startedAt: 1_001 },
      { id: id(2), startedAt: 1_002 },
    ])
  })

  test('are not those run for a script or by T3 Code, which no person types to here', async () => {
    const folder = folderWith([session(1, { kind: 'sdk-cli' }), session(2, { entrypoint: 't3-code' }), session(3)])
    expect((await openClaude([folder], alive, started)).map((c) => c.id)).toEqual([id(3)])
  })

  test('are not those whose Claude Code has ended, or whose process number is another program’s by now, or that cannot be checked', async () => {
    const folder = folderWith([session(7), session(1, { procStart: 'another-start' }), session(2)])
    expect((await openClaude([folder], alive, started)).map((c) => c.id)).toEqual([id(2)])
    // Where it cannot be told that the running process is the Claude Code that wrote the note, it is passed over
    expect(await openClaude([folder], alive, () => false)).toEqual([])
  })

  test('a process is the Claude Code that wrote its note only where it began no later than the session did, as `ps` says it', async () => {
    expect(ranFor('  05:03\n')).toBe(303_000)
    expect(ranFor('1:02:03')).toBe(3_723_000)
    expect(ranFor('2-01:02:03')).toBe(2 * 86_400_000 + 3_723_000)
    expect(ranFor('not a time')).toBeUndefined()
    if (process.platform === 'win32') return
    // This test's own process began before now, and after a moment long ago: a note from long ago is another program's
    expect(await sameProcess(process.pid, { startedAt: Date.now() })).toBe(true)
    expect(await sameProcess(process.pid, { startedAt: 1_000 })).toBe(false)
    // And a process that is not running is nobody's
    expect(await sameProcess(2 ** 22 + 7, { startedAt: Date.now() })).toBe(false)
  })

  test('Windows rejects a reused Claude PID and unreadable starts, and checks all notes in one batch', async () => {
    const platform = process.platform
    const spawn = childProcess.execFile
    let calls = 0
    let readable = true
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      childProcess.execFile = new Proxy(spawn, {
        apply(_target, _self, [file, _args, _opts, callback]) {
          calls++
          // The old image-only check accepts both, even though PID 1 now holds another Claude.
          const stdout = file === 'tasklist' ? '"claude.exe","1"' : readable ? '1 116444736100000000\n2 116444736010000000\n' : '1 unreadable\n'
          queueMicrotask(() => callback(null, stdout, ''))
          return {}
        },
      })
      syncBuiltinESMExports()
      const folder = folderWith([session(1), session(2)])
      expect(await openClaude([folder], alive)).toEqual([{ id: id(2), startedAt: 1_002 }])
      expect(calls).toBe(1)
      // The same identity rule applies when called directly, even on Windows hosts.
      expect(await sameProcess(1, { startedAt: 1_001 })).toBe(false)
      expect(await sameProcess(2, { startedAt: 1_002 })).toBe(true)
      readable = false
      expect(await openClaude([folder], alive)).toEqual([])
      expect(await sameProcess(1, { startedAt: 1_001 })).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
      childProcess.execFile = spawn
      syncBuiltinESMExports()
    }
  })

  test('Windows times out discovery, kills only its child PID, and passes the notes over', async () => {
    const platform = process.platform
    const run = childProcess.execFile
    let child: ReturnType<typeof run> | undefined
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      childProcess.execFile = new Proxy(run, {
        apply(_target, _self, [_file, _args, opts, callback]) {
          expect(opts.timeout).toBe(5000)
          expect(opts.killSignal).toBe('SIGKILL')
          child = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], opts, callback)
          return child
        },
      })
      syncBuiltinESMExports()
      const folder = folderWith([session(1), session(2)])
      expect(await openClaude([folder], alive)).toEqual([])
      expect(child?.pid).toBeGreaterThan(0)
      expect(child?.killed).toBe(true)
      expect(() => process.kill(child!.pid!, 0)).toThrow()
    } finally {
      childProcess.execFile = run
      syncBuiltinESMExports()
      Object.defineProperty(process, 'platform', { value: platform })
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await new Promise<void>((resolve) => child!.once('close', () => resolve()))
      }
    }
  })

  test('pass over a file that is not as Claude Code writes one, and a folder that has none', async () => {
    const folder = folderWith([session(1, { sessionId: 'not an id' }), session(2, { startedAt: 'yesterday' }), session(3)])
    writeFileSync(path.join(folder, 'sessions', '4.json'), '{ cut short')
    writeFileSync(path.join(folder, 'sessions', '5.json'), JSON.stringify(session(6)))
    expect((await openClaude([folder, path.join(folder, 'no-such-folder')], alive, started)).map((c) => c.id)).toEqual([id(3)])
  })

  test('count a conversation open in two Claude Codes once, as the later of the two', async () => {
    const folder = folderWith([session(1, { sessionId: id(9) }), session(2, { sessionId: id(9) })])
    const other = folderWith([session(3, { sessionId: id(9).toUpperCase() })])
    expect(await openClaude([folder, other, folder], alive, started)).toEqual([{ id: id(9), startedAt: 1_003 }])
  })

  test('read the running process’s own start on Linux, as Claude Code writes it', async () => {
    if (process.platform !== 'linux') return
    // This test's own process, written down as Claude Code would write it
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
    const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    const folder = folderWith([session(process.pid, { sessionId: id(5), procStart })])
    expect((await openClaude([folder])).map((c) => c.id)).toEqual([id(5)])
    const wrong = folderWith([session(process.pid, { sessionId: id(5), procStart: '1' })])
    expect(await openClaude([wrong])).toEqual([])
  })
})
