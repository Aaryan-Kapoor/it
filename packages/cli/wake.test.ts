// Reopening a conversation that was closed: the command Claude Code is run with, where it is
// run, how the click is given to it, and the note of each conversation's folder that says where.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { claudeResume, mayWake } from './src/connector'
import { conversationFolder, conversationsFile, noteConversation } from './src/publish'

let scratch: string
let was: string | undefined
beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'it-wake-'))
  was = process.env.IT_HOME
  process.env.IT_HOME = path.join(scratch, 'home')
  mkdirSync(process.env.IT_HOME, { recursive: true })
})
afterEach(() => {
  if (was === undefined) delete process.env.IT_HOME
  else process.env.IT_HOME = was
  rmSync(scratch, { recursive: true, force: true })
})

/** A stand-in for Claude Code's command: it writes down how it was run, and ends as it is told to. */
function standIn(ends = 'exit 0'): { command: string; ran: () => { args: string[]; cwd: string; input: string; harness: string; session: string } | null } {
  const command = path.join(scratch, 'claude')
  const log = path.join(scratch, 'ran.json')
  writeFileSync(
    command,
    `#!/bin/sh\ninput=$(cat)\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd(), input: process.argv[2], harness: process.env.IT_HARNESS, session: process.env.IT_SESSION }))' '${log}' "$input" "$@"\n${ends}\n`,
  )
  chmodSync(command, 0o755)
  return { command, ran: () => (existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : null) }
}

describe.skipIf(process.platform === 'win32')('reopening a Claude Code conversation', () => {
  test('Claude Code’s own command carries the conversation on in its folder, with the click on its input and never on its command line', async () => {
    const claude = standIn()
    const folder = path.join(scratch, 'a project')
    mkdirSync(folder)
    const click = '[It] The page "Chess" (chess) sent this just after someone used it: move {"move":"Qb3"} [action click-1]'
    expect(await claudeResume('3f6c2f0e-1a2b-4c3d-9e8f-000000000001', folder, click, claude.command)).toBeNull()
    const ran = claude.ran()!
    expect(ran.args).toEqual(['--resume', '3f6c2f0e-1a2b-4c3d-9e8f-000000000001', '--print', '--allowedTools', 'Bash(it:*)'])
    expect(ran.args.join(' ')).not.toContain('Qb3')
    expect(ran.input).toBe(click)
    expect(ran.cwd).toBe(folder)
    // What it runs there says which conversation it is, as the conversation's own commands did
    expect([ran.harness, ran.session]).toEqual(['claude-code', '3f6c2f0e-1a2b-4c3d-9e8f-000000000001'])
  })

  test('why it did not run is said in this program’s own words', async () => {
    const ID = '3f6c2f0e-1a2b-4c3d-9e8f-000000000001'
    expect(await claudeResume(ID, scratch, 'a click', standIn('exit 3').command)).toBe('Claude Code exited with 3')
    expect(await claudeResume(ID, scratch, 'a click', path.join(scratch, 'no-such-command'))).toBe('Claude Code was not found')
    expect(await claudeResume(ID, scratch, 'a click', standIn('sleep 5').command, 200)).toBe('Claude Code had not finished in fifteen minutes')
  })

  test('an id that is not one Claude Code makes is never put on its command line, where one that begins with dashes would be read as an option', async () => {
    const never = standIn()
    for (const id of [
      '--dangerously-skip-permissions',
      '-p',
      'an id; rm -rf ~',
      'session-1',
      '',
      '3f6c2f0e-1a2b-4c3d-9e8f-000000000001 --print',
      '../3f6c2f0e-1a2b-4c3d-9e8f-000000000001',
    ])
      expect(await claudeResume(id, scratch, 'a click', never.command), id).toBe('its conversation id is not one Claude Code would have made')
    expect(never.ran()).toBeNull()
  })
})

describe('whether a closed conversation may be reopened for a click', () => {
  const MINUTE = 60_000
  const at = 1_800_000_000_000
  test('only for an agent app the person has switched it on for, on this machine', () => {
    expect(mayWake(new Map(), 'claude-code', at)).toBe(false)
    expect(mayWake(new Map([['claude-code', at]]), 'claude-code', at + MINUTE)).toBe(true)
  })

  test('never for an app It has no way to reopen, whatever is written down for it', () => {
    for (const harness of ['codex', 'openclaw', 'pi', 'made-up']) expect(mayWake(new Map([[harness, at]]), harness, at + MINUTE)).toBe(false)
  })

  test('for what was done from about the moment it was switched on, and not for all that had been waiting before', () => {
    const on = new Map([['claude-code', at]])
    // The click that made the person switch it on, and what they did in the day before it
    expect(mayWake(on, 'claude-code', at - MINUTE)).toBe(true)
    expect(mayWake(on, 'claude-code', at - 24 * 60 * MINUTE)).toBe(true)
    expect(mayWake(on, 'claude-code', at - 24 * 60 * MINUTE - 1)).toBe(false)
    expect(mayWake(on, 'claude-code', at - 30 * 24 * 60 * MINUTE)).toBe(false)
  })
})

describe('the folder a conversation was held in', () => {
  const session = { harness: 'claude-code', id: 'session-1' }
  test('is noted when the conversation publishes, kept on this machine alone, and found again while the folder is there', () => {
    const folder = path.join(scratch, 'held here')
    mkdirSync(folder)
    expect(conversationFolder(session)).toBeUndefined()
    noteConversation(session, folder)
    expect(conversationFolder(session)).toBe(folder)
    expect(conversationFolder({ harness: 'codex', id: 'session-1' })).toBeUndefined()
    // The note is this user's alone
    if (process.platform !== 'win32') expect(require('node:fs').statSync(conversationsFile()).mode & 0o077).toBe(0)
    // A folder that has gone is not one to run anything in
    rmSync(folder, { recursive: true })
    expect(conversationFolder(session)).toBeUndefined()
  })

  test('only so many are remembered, the ones noted last', () => {
    const folder = path.join(scratch, 'held here')
    mkdirSync(folder)
    for (let n = 0; n < 305; n++) noteConversation({ harness: 'claude-code', id: `session-${n}` }, folder)
    const kept = Object.keys(JSON.parse(readFileSync(conversationsFile(), 'utf8')))
    expect(kept.length).toBe(300)
    expect(conversationFolder({ harness: 'claude-code', id: 'session-304' })).toBe(folder)
  })

  test('a note that is not as It wrote it says nothing', () => {
    writeFileSync(conversationsFile(), '{"claude-code:session-1": {"cwd": "relative/path"}, "claude-code:session-2": "text"}')
    expect(conversationFolder(session)).toBeUndefined()
    expect(conversationFolder({ harness: 'claude-code', id: 'session-2' })).toBeUndefined()
  })
})
