// Reopening a conversation that was closed: the command Claude Code is run with, where it is
// run, how the click is given to it, and the note of each conversation's folder that says where.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { conversationFolder, conversationsFile, noteConversation } from './src/publish'
import { Budget, carrying, carryOn, claudeModeOf, claudeResume, claudeWroteAt, codexWroteAt, mayWake, STOPPED, WOKEN } from './src/wake'

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
    for (const harness of ['openclaw', 'made-up']) expect(mayWake(new Map([[harness, at]]), harness, at + MINUTE)).toBe(false)
    for (const harness of ['codex', 'pi', 'opencode', 'hermes']) expect(mayWake(new Map([[harness, at]]), harness, at + MINUTE)).toBe(true)
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

describe('the command each agent app is carried on with', () => {
  const has = { codex: ['codex'], itHome: '/home/someone/.it' }
  const UUID = '3f6c2f0e-1a2b-4c3d-9e8f-000000000001'

  test('each is the app’s own command for a conversation named by its id, with the message on its input and never among its words', () => {
    const said = 'the page sent: approve {"secret":"s3cret"}'
    const all = {
      'claude-code': carrying('claude-code', UUID, said, has),
      codex: carrying('codex', '01a10f7c-062c-7010-8d57-8e1007169551', said, has),
      pi: carrying('pi', UUID, said, has),
      opencode: carrying('opencode', 'ses_6f2a9c01ffe4', said, has),
      hermes: carrying('hermes', '20261006_005959_a9a014', said, has),
    }
    for (const how of Object.values(all)) {
      if (typeof how === 'string') throw new Error(how)
      expect(how.input).toBe(said)
      expect(how.argv.join(' ')).not.toContain('s3cret')
    }
    expect((all['claude-code'] as { argv: string[] }).argv).toEqual(['claude', '--resume', UUID, '--print', '--allowedTools', 'Bash(it:*)'])
    expect((all.pi as { argv: string[] }).argv).toEqual(['pi', '--print', '--session', UUID])
    expect((all.opencode as { argv: string[] }).argv).toEqual(['opencode', 'run', '--session', 'ses_6f2a9c01ffe4'])
    expect((all.hermes as { argv: string[] }).argv).toEqual(['hermes', 'chat', '--resume', '20261006_005959_a9a014', '--query-file', '-'])
    // Codex in its sandbox for a workspace, with the network and It's own folder, which is what `it` needs, and nothing bypassed
    const codex = (all.codex as { argv: string[] }).argv
    expect(codex.slice(0, 3)).toEqual(['codex', 'exec', 'resume'])
    expect(codex).toContain('sandbox_mode="workspace-write"')
    expect(codex).toContain('sandbox_workspace_write.network_access=true')
    expect(codex).toContain('sandbox_workspace_write.writable_roots=["/home/someone/.it"]')
    expect(codex.slice(-2)).toEqual(['01a10f7c-062c-7010-8d57-8e1007169551', '-'])
    expect(codex.join(' ')).not.toMatch(/bypass|danger/)
  })

  test('an id of a shape the app does not make is never put on its command line, and an app with no such command has none', () => {
    for (const [harness, ids] of Object.entries({
      'claude-code': ['--dangerously-skip-permissions', 'abc', ''],
      codex: ['--dangerously-bypass-approvals-and-sandbox', '-c', 'a b', ''],
      pi: ['--no-session', '-p', 'x', ''],
      opencode: ['--auto', 'ses_', 'ses_a b', 'session', ''],
      // A title, or the word that means the newest conversation, is not an id
      hermes: ['--yolo', 'latest', 'my plan', '20261006', ''],
    }))
      for (const id of ids) expect(carrying(harness, id, 'x', has), `${harness} ${id}`).toMatch(/conversation id is not one/)
    expect(carrying('openclaw', 'main', 'x', has)).toMatch(/no way to reopen/)
    expect(carrying('codex', 'thr-1', 'x', { codex: null, itHome: '/x' })).toBe('Codex was not found')
  })
})

describe.skipIf(process.platform === 'win32')('a reopened conversation that is stopped', () => {
  test('is ended at once, says that it was stopped, and is not taken for a failure', async () => {
    const command = path.join(scratch, 'slow')
    // An agent in the middle of a command of its own: the command writes down that it is there, and waits
    const mark = path.join(scratch, 'its-command.pid')
    // It is started in a session of its own, as some apps start a tool's command: its group is not the agent's
    writeFileSync(command, `#!/bin/sh\ncat > /dev/null\nsetsid sh -c 'echo $$ > ${mark}; exec sleep 30' &\nwait\n`)
    chmodSync(command, 0o755)
    const stop = new AbortController()
    const began = Date.now()
    const ran = carryOn({ argv: [command], input: 'a click', app: 'Claude Code' }, scratch, { harness: 'claude-code', session: 'x' }, { signal: stop.signal })
    setTimeout(() => stop.abort(), 500)
    expect(await ran).toBe(STOPPED)
    expect(Date.now() - began).toBeLessThan(5000)
    // What it had started is stopped with it, and does not run on
    const its = Number(readFileSync(mark, 'utf8'))
    await new Promise((r) => setTimeout(r, 300))
    expect(() => process.kill(its, 0)).toThrow()
    // One that was stopped before it began is never started
    expect(
      await carryOn({ argv: [path.join(scratch, 'never')], input: '', app: 'Pi' }, scratch, { harness: 'pi', session: 'x' }, { signal: stop.signal }),
    ).toBe(STOPPED)
  })
})

describe('how often a conversation is reopened', () => {
  test('so many at once, and then one more for each while that passes, never more than it holds', () => {
    const t = 1_800_000_000_000
    const b = new Budget(3, 20_000, t)
    expect([b.take(t), b.take(t), b.take(t), b.take(t)]).toEqual([true, true, true, false])
    expect(b.has(t + 19_999)).toBe(false)
    expect(b.take(t + 20_000)).toBe(true)
    expect(b.take(t + 20_001)).toBe(false)
    // A long while later it holds what it holds, and no more
    const later = t + 24 * 60 * 60_000
    expect([b.take(later), b.take(later), b.take(later), b.take(later)]).toEqual([true, true, true, false])
    // What is left of a while is kept toward the next one
    const c = new Budget(1, 10_000, t)
    c.take(t)
    expect(c.has(t + 9_000)).toBe(false)
    expect(c.take(t + 10_000)).toBe(true)
    expect(c.has(t + 19_000)).toBe(false)
    expect(c.has(t + 20_000)).toBe(true)
  })
})

describe('when Codex last wrote of a conversation', () => {
  test('is read from the file Codex keeps of it, wherever among its days that is, and is not known where there is none', () => {
    const codexHome = path.join(scratch, 'codex')
    const day = path.join(codexHome, 'sessions', '2026', '10', '05')
    mkdirSync(day, { recursive: true })
    mkdirSync(path.join(codexHome, 'sessions', '2026', '10', '06'), { recursive: true })
    const thread = '01a10f7c-062c-7010-8d57-8e1007169551'
    const file = path.join(day, `rollout-2026-10-05T10-00-00-${thread}.jsonl`)
    writeFileSync(file, '{}\n')
    utimesSync(file, 1_791_000_000, 1_791_000_000)
    expect(codexWroteAt(thread, codexHome)).toBe(1_791_000_000_000)
    utimesSync(file, 1_791_000_500, 1_791_000_500)
    expect(codexWroteAt(thread, codexHome)).toBe(1_791_000_500_000)
    expect(codexWroteAt('01a10f7c-0000-7010-8d57-000000000000', codexHome)).toBeNull()
    expect(codexWroteAt('../../etc', codexHome)).toBeNull()
    expect(codexWroteAt(thread, path.join(scratch, 'no-such-codex'))).toBeNull()
  })
})

describe('the mode a Claude Code conversation is reopened in', () => {
  const UUID = '3f6c2f0e-1a2b-4c3d-9e8f-000000000001'
  const has = { codex: ['codex'], itHome: '/home/someone/.it' }
  const words = (how: unknown) => (how as { argv: string[] }).argv

  test('it is reopened in the mode the person last had it in, where that mode asks nobody, and `it` is allowed by its name and by where it is installed', () => {
    expect(words(carrying('claude-code', UUID, 'x', { ...has, mode: 'bypassPermissions', itAt: ['/home/someone/.it/bin/it'] }))).toEqual([
      'claude',
      '--resume',
      UUID,
      '--print',
      '--permission-mode',
      'bypassPermissions',
      '--allowedTools',
      'Bash(it:*)',
      'Bash(/home/someone/.it/bin/it:*)',
    ])
    for (const mode of ['acceptEdits', 'auto', 'dontAsk']) expect(words(carrying('claude-code', UUID, 'x', { ...has, mode }))).toContain(mode)
    // A mode that asks, one that only plans, one that is not known, and none: reopened as before, with `it` alone
    for (const mode of ['default', 'plan', 'made-up', '--dangerously-skip-permissions', null, undefined])
      expect(words(carrying('claude-code', UUID, 'x', { ...has, mode }))).toEqual(['claude', '--resume', UUID, '--print', '--allowedTools', 'Bash(it:*)'])
    // A place whose name could be read as more than a place is not made a rule of
    expect(words(carrying('claude-code', UUID, 'x', { ...has, itAt: ['/home/some one/.it/bin/it', '/x/it:*) Bash(rm', '/ok/it'] })).slice(-2)).toEqual([
      'Bash(it:*)',
      'Bash(/ok/it:*)',
    ])
  })

  test('the mode is read from what Claude Code wrote of the conversation, and a turn It started itself says nothing of what the person chose', () => {
    const config = path.join(scratch, 'claude')
    const dir = path.join(config, 'projects', '-home-someone-board')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${UUID}.jsonl`)
    const row = (over: Record<string, unknown>) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(400) }, ...over })}\n`
    // Held with full access in an app that drives Claude Code, and then reopened by It, twice, in the mode that asks
    writeFileSync(
      file,
      row({ permissionMode: 'default', entrypoint: 'cli' }) +
        row({ permissionMode: 'bypassPermissions', entrypoint: 'sdk-ts' }) +
        `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the word "permissionMode" in a reply is not a mode' }] } })}\n` +
        row({ permissionMode: 'default', entrypoint: 'sdk-cli' }) +
        row({ permissionMode: 'default', entrypoint: 'sdk-cli' }),
    )
    expect(claudeModeOf(UUID, '/home/someone/board', config)).toBe('bypassPermissions')
    // The person opens it again and holds it in another mode: that is the mode from then on
    writeFileSync(
      file,
      readFileSync(file, 'utf8') + row({ permissionMode: 'acceptEdits', entrypoint: 'cli' }) + row({ permissionMode: 'default', entrypoint: 'sdk-cli' }),
    )
    expect(claudeModeOf(UUID, '/home/someone/board', config)).toBe('acceptEdits')
    // A long conversation is read from its end
    writeFileSync(
      file,
      row({ permissionMode: 'bypassPermissions', entrypoint: 'sdk-ts' }) + `${JSON.stringify({ type: 'assistant', pad: 'y'.repeat(700_000) })}\n`.repeat(2),
    )
    expect(claudeModeOf(UUID, '/home/someone/board', config)).toBe('bypassPermissions')
    // Nothing written of it, or nothing but It's own turns: not known
    expect(claudeModeOf(UUID, '/home/someone/elsewhere', config)).toBeNull()
    writeFileSync(file, row({ permissionMode: 'default', entrypoint: 'sdk-cli' }))
    expect(claudeModeOf(UUID, '/home/someone/board', config)).toBeNull()
    expect(claudeModeOf('../../etc/passwd', '/home/someone/board', config)).toBeNull()
  })

  test('a reopened conversation is told that nobody can approve anything, how to run `it`, and to say so on the page where it cannot do what was asked', () => {
    expect(WOKEN).toMatch(/^\[It\] /)
    expect(WOKEN).toContain('Run `it` by that name alone')
    expect(WOKEN).toContain('`it notify`')
    expect(WOKEN).toContain('`it ack <action id> --failed`')
  })
})

describe('when Claude Code last wrote of a conversation', () => {
  test('is read from the file it keeps of it under the folder the conversation was held in, and is not known where there is none', () => {
    const config = path.join(scratch, 'claude')
    const id = '3f6c2f0e-1a2b-4c3d-9e8f-000000000001'
    const dir = path.join(config, 'projects', '-home-someone-my-site-v2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${id}.jsonl`), '{}\n')
    utimesSync(path.join(dir, `${id}.jsonl`), 1_791_000_000, 1_791_000_000)
    expect(claudeWroteAt(id, '/home/someone/my site.v2', config)).toBe(1_791_000_000_000)
    expect(claudeWroteAt(id, '/home/someone/elsewhere', config)).toBeNull()
    expect(claudeWroteAt('../../../etc/passwd', '/home/someone/my site.v2', config)).toBeNull()
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
