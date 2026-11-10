// Which Claude Code conversations are open at a person's keyboard, as Claude Code keeps note of
// them in its folder's `sessions`: the ones the site asks the person to load It's add-on in.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openClaude, ranFor, sameProcess } from './src/claude-open'

const folders: string[] = []
afterEach(() => {
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

describe('the Claude Code conversations open at a person’s keyboard', () => {
  test('are those of a running Claude Code that a person types to', () => {
    const folder = folderWith([session(1), session(2, { entrypoint: 'claude-vscode' })])
    expect(openClaude([folder], alive, started)).toEqual([
      { id: id(1), startedAt: 1_001 },
      { id: id(2), startedAt: 1_002 },
    ])
  })

  test('are not those run for a script or by T3 Code, which no person types to here', () => {
    const folder = folderWith([session(1, { kind: 'sdk-cli' }), session(2, { entrypoint: 't3-code' }), session(3)])
    expect(openClaude([folder], alive, started).map((c) => c.id)).toEqual([id(3)])
  })

  test('are not those whose Claude Code has ended, or whose process number is another program’s by now, or that cannot be checked', () => {
    const folder = folderWith([session(7), session(1, { procStart: 'another-start' }), session(2)])
    expect(openClaude([folder], alive, started).map((c) => c.id)).toEqual([id(2)])
    // Where it cannot be told that the running process is the Claude Code that wrote the note, it is passed over
    expect(openClaude([folder], alive, () => false)).toEqual([])
  })

  test('a process is the Claude Code that wrote its note only where it began no later than the session did, as `ps` says it', () => {
    expect(ranFor('  05:03\n')).toBe(303_000)
    expect(ranFor('1:02:03')).toBe(3_723_000)
    expect(ranFor('2-01:02:03')).toBe(2 * 86_400_000 + 3_723_000)
    expect(ranFor('not a time')).toBeUndefined()
    if (process.platform === 'win32') return
    // This test's own process began before now, and after a moment long ago: a note from long ago is another program's
    expect(sameProcess(process.pid, { startedAt: Date.now() })).toBe(true)
    expect(sameProcess(process.pid, { startedAt: 1_000 })).toBe(false)
    // And a process that is not running is nobody's
    expect(sameProcess(2 ** 22 + 7, { startedAt: Date.now() })).toBe(false)
  })

  test('pass over a file that is not as Claude Code writes one, and a folder that has none', () => {
    const folder = folderWith([session(1, { sessionId: 'not an id' }), session(2, { startedAt: 'yesterday' }), session(3)])
    writeFileSync(path.join(folder, 'sessions', '4.json'), '{ cut short')
    writeFileSync(path.join(folder, 'sessions', '5.json'), JSON.stringify(session(6)))
    expect(openClaude([folder, path.join(folder, 'no-such-folder')], alive, started).map((c) => c.id)).toEqual([id(3)])
  })

  test('count a conversation open in two Claude Codes once, as the later of the two', () => {
    const folder = folderWith([session(1, { sessionId: id(9) }), session(2, { sessionId: id(9) })])
    const other = folderWith([session(3, { sessionId: id(9).toUpperCase() })])
    expect(openClaude([folder, other, folder], alive, started)).toEqual([{ id: id(9), startedAt: 1_003 }])
  })

  test('read the running process’s own start on Linux, as Claude Code writes it', () => {
    if (process.platform !== 'linux') return
    // This test's own process, written down as Claude Code would write it
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
    const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    const folder = folderWith([session(process.pid, { sessionId: id(5), procStart })])
    expect(openClaude([folder]).map((c) => c.id)).toEqual([id(5)])
    const wrong = folderWith([session(process.pid, { sessionId: id(5), procStart: '1' })])
    expect(openClaude([wrong])).toEqual([])
  })
})
