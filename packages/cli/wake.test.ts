// Reopening a conversation that was closed: the command Claude Code is run with, where it is
// run, how the click is given to it, and the note of each conversation's folder that says where.

import childProcess, { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs, {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { conversationFolder, conversationsFile, noteConversation } from './src/publish'
import {
  Budget,
  bootId,
  carrying,
  carryOn,
  claudeModeOf,
  claudeResume,
  claudeWroteAt,
  codexHeld,
  codexWroteAt,
  endJob,
  endTree,
  IN_JOB,
  identity,
  jobName,
  KEPT_NOT,
  keeper,
  lastWords,
  listsProcesses,
  mayWake,
  NO_PS,
  SINCE_TOLD,
  STOPPED,
  WAS_CUT_OFF,
  WAS_STOPPED,
  WOKEN,
  windowsLine,
  windowsProgram,
} from './src/wake'

test('macOS reads the run marks once and checks all identities together on each Stop tick', async () => {
  const platform = process.platform
  const spawnSync = childProcess.spawnSync
  const since = 'Fri Oct 16 09:00:00 2026'
  const leader = 900_001
  const reused = leader + 20
  const live = new Set(Array.from({ length: 13 }, (_, n) => leader + n))
  const checked: number[] = []
  let listings = 0
  const killed: number[] = []
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
    killed.push(pid)
    live.delete(Math.abs(pid))
    return true
  })
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    childProcess.spawnSync = new Proxy(spawnSync, {
      apply(_target, _self, [file, args]) {
        expect(file).toBe('/bin/ps')
        let stdout = ''
        if (args.includes('-E')) {
          expect(args).toEqual(['-A', '-E', '-ww', '-o', 'pid=', '-o', 'lstart=', '-o', 'command='])
          listings++
          checked.push(0)
          stdout = [...live, reused].map((pid) => `${pid} ${since} tool IT_RUN=batch-test`).join('\n')
        } else if (args.includes('lstart=')) {
          if (listings) checked[listings - 1]!++
          const pids = String(args[args.indexOf('-p') + 1])
            .split(',')
            .map(Number)
          stdout = pids
            .filter((pid) => live.has(pid) || pid === reused)
            .map((pid) => `${pid} ${pid === reused ? 'Fri Oct 16 09:00:01 2026' : since}`)
            .join('\n')
        } else if (args.includes('ppid=')) {
          stdout = [...live]
            .filter((pid) => pid !== leader)
            .map((pid) => `${pid} ${leader}`)
            .join('\n')
        } else {
          expect(args).toEqual(['-A', '-o', 'pid=', '-o', 'pgid='])
          stdout = [...live].map((pid) => `${pid} ${leader}`).join('\n')
        }
        return { pid: 1, status: 0, signal: null, stdout, stderr: '', output: [null, stdout, ''] }
      },
    })
    syncBuiltinESMExports()
    expect(await endTree(leader, since, { harness: 'pi', session: 'batch', run: 'batch-test', told: SINCE_TOLD })).toBe('ended')
    expect(live.size).toBe(0)
    expect(killed).not.toContain(reused)
    expect(killed).toContain(-leader)
    expect(checked.length).toBeGreaterThanOrEqual(3)
    expect(checked.every((count) => count === 1)).toBe(true)
  } finally {
    Object.defineProperty(process, 'platform', { value: platform })
    childProcess.spawnSync = spawnSync
    syncBuiltinESMExports()
    kill.mockRestore()
  }
})

let scratch: string
let was: string | undefined
beforeEach(() => {
  // As the system itself names it: on macOS the folder for scratch files is reached through a link, and a program started in it is told the folder the link leads to
  scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-wake-')))
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

  test('where an app is started by where its program is, as on Windows, it is started from there, and where none was found it is not started at all', () => {
    const at = { ...has, start: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\npm\\node_modules\\pi\\cli.js'] }
    expect((carrying('pi', UUID, 'x', at) as { argv: string[] }).argv).toEqual([...at.start, '--print', '--session', UUID])
    expect((carrying('claude-code', UUID, 'x', { ...has, start: ['C:\\bin\\claude.exe'] }) as { argv: string[] }).argv.slice(0, 2)).toEqual([
      'C:\\bin\\claude.exe',
      '--resume',
    ])
    for (const [harness, id, app] of [
      ['claude-code', UUID, 'Claude Code'],
      ['pi', UUID, 'Pi'],
      ['opencode', 'ses_6f2a9c01ffe4', 'OpenCode'],
      ['hermes', '20261006_005959_a9a014', 'Hermes'],
    ])
      expect(carrying(harness!, id!, 'x', { ...has, start: null })).toBe(`${app} was not found`)
  })
})

describe.skipIf(process.platform === 'win32')('a reopened conversation that is stopped', () => {
  test('is ended at once, says that it was stopped, and is not taken for a failure', async () => {
    const command = path.join(scratch, 'slow')
    // An agent in the middle of a command of its own: the command writes down that it is there, and waits
    const mark = path.join(scratch, 'its-command.pid')
    // It is started in a session of its own, as some apps start a tool's command: its group is not the agent's. Node
    // starts it so, where the system has no command of its own for that, as macOS has none
    const apart = path.join(scratch, 'apart.js')
    writeFileSync(
      apart,
      `require('node:child_process').spawn('sh', ['-c', 'echo $$ > "$1"; exec sleep 30', 'sh', ${JSON.stringify(mark)}], { detached: true, stdio: 'ignore' }).on('exit', () => process.exit(0))\n`,
    )
    writeFileSync(command, `#!/bin/sh\ncat > /dev/null\n"${process.execPath}" "${apart}" &\nwait\n`)
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

  test('one that ends badly by itself hands over its last line, for the person whose app it is, and leaves nothing of what it printed', async () => {
    const kept = path.join(scratch, 'kept')
    const failing = path.join(scratch, 'failing')
    writeFileSync(
      failing,
      '#!/bin/sh\ncat > /dev/null\necho "hook: SessionStart Completed"\nprintf "\\033[31mERROR: Missing environment variable: \\140OPENROUTER_API_KEY\\140.\\033[0m\\n" >&2\nexit 1\n',
    )
    chmodSync(failing, 0o755)
    const said: string[] = []
    const opts = { keepIn: kept, said: (words: string) => said.push(words) }
    expect(await carryOn({ argv: [failing], input: 'a click', app: 'Codex' }, scratch, { harness: 'codex', session: 'x' }, opts)).toBe('Codex exited with 1')
    expect(said).toEqual(['ERROR: Missing environment variable: `OPENROUTER_API_KEY`.'])
    expect(readdirSync(kept)).toEqual([])
    // One that ran says nothing, whatever it printed, and one that was stopped is no failure of its own
    said.length = 0
    expect(
      await carryOn({ argv: ['/bin/sh', '-c', 'echo "error: only a word it printed"'], input: '', app: 'Pi' }, scratch, { harness: 'pi', session: 'x' }, opts),
    ).toBeNull()
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 200)
    expect(
      await carryOn(
        { argv: ['/bin/sh', '-c', 'echo "error: about to wait" >&2; sleep 30'], input: '', app: 'Pi' },
        scratch,
        { harness: 'pi', session: 'x' },
        { ...opts, signal: stop.signal },
      ),
    ).toBe(STOPPED)
    expect(said).toEqual([])
    expect(readdirSync(kept)).toEqual([])
  })

  test('a command that does not end when it is asked to is ended for it, on Stop and at the time limit, and the run is not said to be over while it is still there', async () => {
    const command = path.join(scratch, 'stubborn')
    const mark = path.join(scratch, 'stubborn.pid')
    // The agent itself ends when asked. A command it started takes no notice of being asked.
    writeFileSync(command, `#!/bin/sh\ncat > /dev/null\nsh -c 'trap "" TERM; echo $$ > "${mark}"; while :; do sleep 1; done' &\nwait\n`)
    chmodSync(command, 0o755)
    const there = async () => {
      for (let n = 0; n < 100 && !(existsSync(mark) && readFileSync(mark, 'utf8').trim()); n++) await new Promise((r) => setTimeout(r, 50))
      const its = Number(readFileSync(mark, 'utf8'))
      rmSync(mark)
      return its
    }
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    // Stopped by the person
    const stop = new AbortController()
    // (It is said to whoever keeps the notes when a run is ended because its time is over, and never when it was stopped)
    let overtime = 0
    const ran = carryOn(
      { argv: [command], input: 'a click', app: 'Pi' },
      scratch,
      { harness: 'pi', session: 'x' },
      { signal: stop.signal, overtime: () => overtime++ },
    )
    const first = await there()
    const began = Date.now()
    stop.abort()
    expect(await ran).toBe(STOPPED)
    // It took the harder ending, a few seconds on, and nothing of the run was left by the time it was said to be over
    expect(alive(first)).toBe(false)
    expect(Date.now() - began).toBeGreaterThan(4000)
    expect(Date.now() - began).toBeLessThan(10_000)
    // And at the time limit, which is short here
    expect(overtime).toBe(0)
    const late = carryOn(
      { argv: [command], input: 'a click', app: 'Pi' },
      scratch,
      { harness: 'pi', session: 'x' },
      { patience: 600, overtime: () => overtime++ },
    )
    const second = await there()
    expect(await late).toBe('Pi had not finished in fifteen minutes')
    expect(alive(second)).toBe(false)
    expect(overtime).toBe(1)
  }, 40_000)

  test.each(['Stop', 'timeout'])(
    'a detached tool started by the termination handler is found and ended on %s',
    async (cause) => {
      const ready = path.join(scratch, 'ready')
      const childPid = path.join(scratch, 'late.pid')
      const tool = `require('node:fs').writeFileSync(${JSON.stringify(childPid)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
      const script = `
      process.stdin.resume()
      process.stdin.on('end', () => require('node:fs').writeFileSync(${JSON.stringify(ready)}, ''))
      process.on('SIGTERM', () => {
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(tool)}], { detached: true, stdio: 'ignore' }).unref()
        process.exit(0)
      })
      setInterval(() => {}, 1000)
    `
      const stop = new AbortController()
      const ran = carryOn(
        { argv: [process.execPath, '-e', script], input: 'a click', app: 'Pi' },
        scratch,
        { harness: 'pi', session: 'late-tool', run: `late-tool-${process.pid}-${cause}` },
        {
          signal: stop.signal,
          patience: cause === 'timeout' ? 1000 : 30_000,
        },
      )
      try {
        for (let n = 0; n < 100 && !existsSync(ready); n++) await new Promise((r) => setTimeout(r, 20))
        expect(existsSync(ready)).toBe(true)
        if (cause === 'Stop') stop.abort()
        expect(await ran).toBe(cause === 'Stop' ? STOPPED : 'Pi had not finished in fifteen minutes')
        expect(existsSync(childPid)).toBe(true)
        const pid = Number(readFileSync(childPid, 'utf8'))
        expect(identity([pid]).has(pid)).toBe(false)
        // Unreadable unrelated processes can conservatively hold the run. The connector's
        // persistence tests cover that hold; this regression proves its own late tool ended.
      } finally {
        stop.abort()
        await ran
        if (existsSync(childPid)) {
          const pid = Number(readFileSync(childPid, 'utf8'))
          if (identity([pid]).has(pid)) {
            process.kill(pid, 'SIGKILL')
            for (let n = 0; n < 100 && identity([pid]).has(pid); n++) await new Promise((r) => setTimeout(r, 20))
          }
        }
      }
    },
    20_000,
  )

  test.skipIf(process.platform !== 'linux')('Stop ends its known leader when discovering other processes fails, and keeps uncertainty', async () => {
    const ready = path.join(scratch, 'ready')
    const stop = new AbortController()
    let pid = 0
    let unsure = false
    const list = fs.readdirSync
    const ran = carryOn(
      {
        argv: [
          process.execPath,
          '-e',
          `process.stdin.resume(); process.stdin.on('end', () => require('node:fs').writeFileSync(${JSON.stringify(ready)}, '')); setInterval(() => {}, 1000)`,
        ],
        input: 'a click',
        app: 'Pi',
      },
      scratch,
      { harness: 'pi', session: 'failed-scan', run: 'failed-scan' },
      {
        signal: stop.signal,
        began: (started) => {
          pid = started
        },
        unsure: () => {
          unsure = true
        },
      },
    )
    try {
      for (let n = 0; n < 100 && !existsSync(ready); n++) await new Promise((r) => setTimeout(r, 20))
      expect(existsSync(ready)).toBe(true)
      fs.readdirSync = ((where: unknown, ...args: unknown[]) => {
        if (where === '/proc') throw Object.assign(new Error('process inspection failed'), { code: 'EACCES' })
        return (list as any)(where, ...args)
      }) as typeof fs.readdirSync
      syncBuiltinESMExports()
      stop.abort()
      expect(await ran).toBe(STOPPED)
      expect(unsure).toBe(true)
      expect(identity([pid]).has(pid)).toBe(false)
    } finally {
      fs.readdirSync = list
      syncBuiltinESMExports()
      stop.abort()
      await ran
      if (pid && identity([pid]).has(pid)) {
        process.kill(pid, 'SIGKILL')
        for (let n = 0; n < 100 && identity([pid]).has(pid); n++) await new Promise((r) => setTimeout(r, 20))
      }
    }
  })

  test.skipIf(process.platform !== 'linux')('a newly found marked process is not signalled after its number is reused', async () => {
    const leader = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
    const exited = new Promise((resolve) => leader.once('exit', resolve))
    const since = identity([leader.pid!]).get(leader.pid!)!
    const ticks = Number(since.slice(5))
    const candidate = 999_999_998
    const read = fs.readFileSync
    const list = fs.readdirSync
    const kill = process.kill.bind(process)
    let environments = 0
    let stats = 0
    const signalled: number[] = []
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, how) => {
      if (pid === candidate) {
        signalled.push(pid)
        return true
      }
      return kill(pid, how)
    })
    try {
      fs.readdirSync = ((where: unknown, ...args: unknown[]) =>
        where === '/proc' ? [String(candidate)] : (list as any)(where, ...args)) as typeof fs.readdirSync
      fs.readFileSync = ((where: unknown, ...args: unknown[]) => {
        if (where === `/proc/${candidate}/stat`) {
          // The first discovery sees one identity. Before a signal, the number names another.
          const fields = ['S', ...Array(18).fill('0'), String(ticks + (++stats >= 4 ? 2 : 1))]
          return `${candidate} (tool) ${fields.join(' ')}`
        }
        if (where === `/proc/${candidate}/environ`) return ++environments === 2 ? 'IT_RUN=late-reused\0' : ''
        return (read as any)(where, ...args)
      }) as typeof fs.readFileSync
      syncBuiltinESMExports()
      expect(await endTree(leader.pid!, since, { harness: 'pi', session: 'reuse', run: 'late-reused', told: SINCE_TOLD })).toBe('ended')
      expect(environments).toBeGreaterThanOrEqual(2)
      expect(stats).toBeGreaterThanOrEqual(4)
      expect(signalled).toEqual([])
    } finally {
      fs.readFileSync = read
      fs.readdirSync = list
      syncBuiltinESMExports()
      signal.mockRestore()
      if (identity([leader.pid!]).has(leader.pid!)) leader.kill('SIGKILL')
      await exited
    }
  })

  test('the app is told the folder it is in, and not the one this program was started in', async () => {
    // OpenCode believes PWD over the folder it is started in. Left with this program's own, it
    // held the conversation in one folder, waited for it in another, and never ended.
    const folder = path.join(scratch, 'held here')
    mkdirSync(folder)
    const log = path.join(scratch, 'where.json')
    const [pwd, oldpwd] = [process.env.PWD, process.env.OLDPWD]
    process.env.PWD = path.join(scratch, 'started here')
    process.env.OLDPWD = path.join(scratch, 'and before that')
    try {
      // The program itself and no shell, which would put PWD right before anything could read it
      const how = {
        argv: [
          process.execPath,
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify([process.env.PWD, process.env.OLDPWD ?? null, process.cwd()]))`,
        ],
        input: '',
        app: 'OpenCode',
      }
      expect(await carryOn(how, folder, { harness: 'opencode', session: 'x' })).toBeNull()
    } finally {
      for (const [k, v] of [
        ['PWD', pwd],
        ['OLDPWD', oldpwd],
      ] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual([folder, null, folder])
  })
})

describe('what a conversation is told when it is reopened after a turn of it was cut off', () => {
  test('says that an earlier turn was cut off, that what it is given may be that work again or something new, and to look before it does any of it', () => {
    expect(WAS_CUT_OFF).toMatch(/^\[It\] An earlier turn of this conversation that It had reopened was cut off before it ended/)
    // Why it was cut off is not said, and neither is that all of this was given before: neither is known
    expect(WAS_CUT_OFF).not.toMatch(/restarted|once before/)
    expect(WAS_CUT_OFF).toContain('go by the action ids')
    expect(WAS_CUT_OFF).toContain('do not do twice what was already done')
  })
})

describe('what a conversation is told after the person stopped it', () => {
  test('says that its last turn was stopped, and not to carry on with it', () => {
    expect(WAS_STOPPED).toMatch(/^\[It\] One thing more\. The person stopped this conversation’s last turn, from the page/)
    // What had reached the conversation and was never answered is said to be cancelled, and not left for the agent to judge
    expect(WAS_STOPPED).toContain('even where you see it earlier in this conversation with no answer after it')
    expect(WAS_STOPPED).toContain('Leave all of that undone.')
    // And what it was reopened for is said last, as new and wanted: an agent told only what not to do did nothing
    expect(WAS_STOPPED.endsWith('It is new, and it is what this turn is for: do it, and only it.')).toBe(true)
  })
})

describe('whether some Codex has a conversation open', () => {
  test('says so by the file Codex keeps for each conversation that is being written, and only while a program has that file open', () => {
    const codexHome = path.join(scratch, 'codex-home')
    const locks = path.join(codexHome, 'thread-writer-locks')
    mkdirSync(locks, { recursive: true })
    const lock = (thread: string) => path.join(locks, `${thread}.lock`)
    // No Codex has ever had it open, or Codex has put its file away again
    expect(codexHeld('thread-none', codexHome)).toBe(false)
    // Open in some Codex: the file is there, and a program has it open (this one stands in for
    // Codex). Windows is asked for the lock Codex holds on the file, which this program does not
    // take, and a file that is only open is not held there: the tests that follow hold that.
    writeFileSync(lock('thread-open'), '')
    const held = openSync(lock('thread-open'), 'r')
    try {
      expect(codexHeld('thread-open', codexHome)).toBe(process.platform !== 'win32')
    } finally {
      closeSync(held)
    }
    // Left behind by a Codex that was ended without warning: where the system says who has a file
    // open, or who holds a lock on it, that is not taken for an open conversation. Elsewhere the
    // file is all there is to go by.
    writeFileSync(lock('thread-left'), '')
    expect(codexHeld('thread-left', codexHome)).toBe(['linux', 'darwin', 'win32'].includes(process.platform) ? false : null)
    // What was found is good for a moment only: closed a moment later, it is found closed
    const t = Date.now()
    writeFileSync(lock('thread-then'), '')
    const then = openSync(lock('thread-then'), 'r')
    expect(codexHeld('thread-then', codexHome, t)).toBe(process.platform !== 'win32')
    closeSync(then)
    rmSync(lock('thread-then'))
    expect(codexHeld('thread-then', codexHome, t + 500)).toBe(process.platform !== 'win32')
    expect(codexHeld('thread-then', codexHome, t + 2000)).toBe(false)
    // An id that is not one Codex makes names no file at all
    expect(codexHeld('../thread-open', codexHome)).toBe(false)
  })

  test('on Windows, a read refused for a lock says that the conversation is open, and no other refusal says anything either way', () => {
    const platform = process.platform
    const { openSync: open, readSync: read } = fs
    const codexHome = path.join(scratch, 'codex-home')
    const locks = path.join(codexHome, 'thread-writer-locks')
    mkdirSync(locks, { recursive: true })
    // What Windows answers, as Node and Bun give it: the opening, or the read of the first byte, refused with a code
    type Refusal = { at: 'open' | 'read'; code: string } | null
    let refused: Refusal = null
    const ours = new Set<number>()
    const refusal = (code: string) => Object.assign(new Error(code), { code })
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      fs.openSync = new Proxy(open, {
        apply(target, self, args) {
          const asked = String(args[0]).startsWith(locks)
          if (asked && refused?.at === 'open') throw refusal(refused.code)
          const fd = Reflect.apply(target, self, args)
          if (asked) ours.add(fd)
          return fd
        },
      })
      fs.readSync = new Proxy(read, {
        apply(target, self, args) {
          if (ours.has(args[0]) && refused?.at === 'read') throw refusal(refused.code)
          return Reflect.apply(target, self, args)
        },
      })
      syncBuiltinESMExports()
      const said: [Refusal, boolean | null][] = [
        // Read, so that nothing holds a lock on it: a Codex that held it has gone
        [null, false],
        // The read refused for the lock that a Codex holds while it writes the conversation
        [{ at: 'read', code: 'EBUSY' }, true],
        [{ at: 'read', code: 'EIO' }, null],
        // Refused at the opening, EBUSY is another program's having the file to itself, or its being removed: not a lock
        [{ at: 'open', code: 'EBUSY' }, null],
        [{ at: 'open', code: 'EPERM' }, null],
        // Gone between the look for it and the opening: Codex put it away
        [{ at: 'open', code: 'ENOENT' }, false],
      ]
      said.forEach(([how, held], n) => {
        writeFileSync(path.join(locks, `thread-${n}.lock`), '')
        refused = how
        expect(codexHeld(`thread-${n}`, codexHome), JSON.stringify(how)).toBe(held)
      })
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
      fs.openSync = open
      fs.readSync = read
      syncBuiltinESMExports()
    }
  })
})

// Codex holds the lock on a conversation's file with a call that Windows alone has, so only a
// program on Windows can stand in for it, and only there is that lock what It asks for.
if (process.platform !== 'win32')
  console.log('  skip  the tests of the lock Codex holds on a conversation’s file on Windows: only Windows has that lock, and only there is it asked for')
describe.skipIf(process.platform !== 'win32')('whether some Codex has a conversation open, on Windows', () => {
  // What opens the file as Codex does, for reading and writing, made where it is not there, and
  // shared with every other program for all three. With `lock` it then takes the lock Codex
  // takes, as Rust's File::try_lock takes it: LockFileEx, to itself and without waiting, over
  // every byte from the first. With `alone` it lets no other program open the file at all.
  const HOLDER = `$ErrorActionPreference = 'Stop'
$share = if ($env:IT_TEST_HOW -eq 'alone') { [System.IO.FileShare]::None } else { [System.IO.FileShare]'ReadWrite, Delete' }
$file = [System.IO.File]::Open($env:IT_TEST_FILE, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, $share)
if ($env:IT_TEST_HOW -eq 'lock') {
  Add-Type -Namespace ItTest -Name Kernel32 -MemberDefinition '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool LockFileEx(Microsoft.Win32.SafeHandles.SafeFileHandle file, uint flags, uint reserved, uint lengthLow, uint lengthHigh, ref System.Threading.NativeOverlapped overlapped);'
  $overlapped = New-Object System.Threading.NativeOverlapped
  if (-not [ItTest.Kernel32]::LockFileEx($file.SafeFileHandle, 3, 0, [uint32]::MaxValue, [uint32]::MaxValue, [ref]$overlapped)) { exit 3 }
}
[Console]::Out.WriteLine('holding')
[Console]::Out.Flush()
Start-Sleep -Seconds 600
`
  const ending: (() => Promise<void>)[] = []
  afterEach(async () => {
    // Every program that holds a file is ended and waited for before the scratch folder is removed
    await Promise.all(ending.splice(0).map((end) => end()))
  })
  /** Starts a program that holds the file as it is told, and says when it does. Ending it ends it as a crash would, without warning. */
  const holding = (file: string, how: 'lock' | 'alone') =>
    new Promise<{ end: () => Promise<void> }>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(HOLDER, 'utf16le').toString('base64')], {
        env: { ...process.env, IT_TEST_FILE: file, IT_TEST_HOW: how },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const gone = new Promise<void>((done) => child.once('exit', () => done()))
      const end = async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await gone
      }
      ending.push(end)
      let said = ''
      child.stdout.on('data', (bytes) => {
        said += bytes
        if (said.includes('holding')) resolve({ end })
      })
      child.stderr.on('data', (bytes) => {
        said += bytes
      })
      child.once('error', reject)
      child.once('exit', (code) => reject(new Error(`the program that holds the file ended with ${code} before it held it: ${said}`)))
    })
  const codexHome = () => path.join(scratch, 'codex-home')
  const lockOf = (thread: string) => {
    const locks = path.join(codexHome(), 'thread-writer-locks')
    mkdirSync(locks, { recursive: true })
    return path.join(locks, `${thread}.lock`)
  }
  /** What reading the first byte of a file gives: what it read, or the code it was refused with. */
  const readFirst = (file: string) => {
    const fd = openSync(file, 'r')
    try {
      return `read ${fs.readSync(fd, Buffer.alloc(1), 0, 1, 0)}`
    } catch (err) {
      return (err as NodeJS.ErrnoException).code
    } finally {
      closeSync(fd)
    }
  }

  test('a conversation whose Codex holds the lock on its file is open, and one whose Codex was ended without warning is not, though the file is left', async () => {
    const thread = '019a0000-0000-7000-8000-000000000001'
    const lock = lockOf(thread)
    // A file that a Codex left behind and nothing holds: it is not open, and asking took nothing
    // that keeps a Codex from opening the conversation and taking the lock after
    writeFileSync(lock, '')
    let t = Date.now()
    expect(codexHeld(thread, codexHome(), t)).toBe(false)
    const codex = await holding(lock, 'lock')
    // Codex writes nothing into the file: Windows refuses to read it while the lock is held
    expect(readFirst(lock)).toBe('EBUSY')
    t += 2000
    expect(codexHeld(thread, codexHome(), t)).toBe(true)
    // Asking does not take the lock, nor loosen it: it is held all the same after
    t += 2000
    expect(codexHeld(thread, codexHome(), t)).toBe(true)
    await codex.end()
    // Ended as a crash ends it, Codex leaves the file. The system lets go of the lock as it closes
    // what the program had open, which may be a moment after the program has gone.
    expect(existsSync(lock)).toBe(true)
    const until = Date.now() + 10_000
    let held: boolean | null
    do {
      t += 2000
      held = codexHeld(thread, codexHome(), t)
      if (held !== false) await new Promise((r) => setTimeout(r, 200))
    } while (held !== false && Date.now() < until)
    expect(held).toBe(false)
    expect(readFirst(lock)).toBe('read 0')
  }, 120_000)

  test('a conversation whose file another program has to itself is not known to be open or closed', async () => {
    const thread = '019a0000-0000-7000-8000-000000000002'
    const lock = lockOf(thread)
    const other = await holding(lock, 'alone')
    // Nothing can be read of the file, so nothing is known of a lock on it: the click waits, as for a conversation that may be open
    expect(codexHeld(thread, codexHome())).toBeNull()
    await other.end()
    expect(codexHeld(thread, codexHome(), Date.now() + 2000)).toBe(false)
  }, 120_000)
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
    // The agent has moved into a folder inside the one the conversation began in, and ran `it` there, so that is the folder It has noted.
    // Claude Code files the conversation where it began, and it is found there by its id
    expect(claudeModeOf(UUID, '/home/someone/board/pages/round-two', config)).toBe('bypassPermissions')
    expect(claudeModeOf(UUID, '/home/someone/elsewhere', config)).toBe('bypassPermissions')
    // Nothing written of it, or nothing but It's own turns: not known
    expect(claudeModeOf(UUID.replace(/^./, UUID.startsWith('f') ? 'e' : 'f'), '/home/someone/board', config)).toBeNull()
    writeFileSync(file, row({ permissionMode: 'default', entrypoint: 'sdk-cli' }))
    expect(claudeModeOf(UUID, '/home/someone/board', config)).toBeNull()
    expect(claudeModeOf('../../etc/passwd', '/home/someone/board', config)).toBeNull()
  })

  test('a reopened conversation is told that nobody can approve anything, how to run `it`, and to say so on the page where it cannot do what was asked', () => {
    expect(WOKEN).toMatch(/^\[It\] /)
    // It says what a page sent, and never that a person did it or wants it: whether anyone was there is said with each thing
    expect(WOKEN).toContain('which a page of yours sent while the conversation was closed')
    expect(WOKEN).not.toMatch(/someone did|they did|is wanted/)
    expect(WOKEN).toContain('Run `it` by that name alone')
    expect(WOKEN).toContain('`it notify`')
    expect(WOKEN).toContain('`it ack <action id> --failed`')
    // It is not a rule that only `it` may run: a real agent once read an earlier wording as one, and refused its own work
    expect(WOKEN).toContain('You can do here what you could do while they were with you')
    expect(WOKEN).toContain('Try what the work needs before you conclude that you may not')
    expect(WOKEN).not.toMatch(/not already allowed|is refused\. Run/)
  })
})

describe('when Claude Code last wrote of a conversation', () => {
  test('is read from the file it keeps of it, under the folder the conversation was begun in whichever folder its agent has moved to since, and is not known where there is none', () => {
    const config = path.join(scratch, 'claude')
    const id = '3f6c2f0e-1a2b-4c3d-9e8f-000000000001'
    const dir = path.join(config, 'projects', '-home-someone-my-site-v2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${id}.jsonl`), '{}\n')
    utimesSync(path.join(dir, `${id}.jsonl`), 1_791_000_000, 1_791_000_000)
    expect(claudeWroteAt(id, '/home/someone/my site.v2', config)).toBe(1_791_000_000_000)
    // Its agent moved into a folder inside that one and ran `it` there, which is then the folder It has noted: it is at work all the same,
    // and It has to see that it is, or it would start a second turn beside the one that is running
    expect(claudeWroteAt(id, '/home/someone/my site.v2/pages', config)).toBe(1_791_000_000_000)
    expect(claudeWroteAt('3f6c2f0e-1a2b-4c3d-9e8f-000000000002', '/home/someone/my site.v2', config)).toBeNull()
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
    // Start at the boundary, then write past it. Building the fixture through 300
    // flushed writes makes this a disk-speed test on Windows.
    writeFileSync(
      conversationsFile(),
      JSON.stringify(Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`claude-code:session-${n}`, { cwd: folder, at: n }]))),
    )
    for (let n = 300; n < 305; n++) noteConversation({ harness: 'claude-code', id: `session-${n}` }, folder)
    const kept = Object.keys(JSON.parse(readFileSync(conversationsFile(), 'utf8')))
    expect(kept.length).toBe(300)
    expect(new Set(kept)).toEqual(new Set(Array.from({ length: 300 }, (_, n) => `claude-code:session-${n + 5}`)))
    expect(conversationFolder({ harness: 'claude-code', id: 'session-304' })).toBe(folder)
  })

  test('a note that is not as It wrote it says nothing', () => {
    writeFileSync(conversationsFile(), '{"claude-code:session-1": {"cwd": "relative/path"}, "claude-code:session-2": "text"}')
    expect(conversationFolder(session)).toBeUndefined()
    expect(conversationFolder({ harness: 'claude-code', id: 'session-2' })).toBeUndefined()
  })
})

// Away from Linux the command is asked for by its place, whatever the PATH says
test.skipIf(process.platform !== 'linux')('a machine with no ps to list processes with is told from one that has it', () => {
  const before = process.env.PATH
  expect(listsProcesses()).toBe(true)
  process.env.PATH = '/nowhere'
  try {
    expect(listsProcesses()).toBe(false)
    expect(NO_PS).toContain('procps')
  } finally {
    process.env.PATH = before
  }
})

describe('the last line an app printed', () => {
  test('is the last of its closing lines that speaks of something going wrong, plain, short, and with nothing that could be a key', () => {
    expect(lastWords('hook: SessionStart\nERROR: Missing environment variable: `KEY`.\n\n')).toBe('ERROR: Missing environment variable: `KEY`.')
    // The line that says what went wrong, and not the trailer after it
    expect(lastWords('Error: Invalid API key · Please run /login\nSession ended.\n')).toBe('Error: Invalid API key · Please run /login')
    expect(lastWords('one\ntwo\n')).toBe('two')
    expect(lastWords('\u001b[31mfailed\u001b[0m to reach the model\r\n')).toBe('failed to reach the model')
    expect(lastWords('401 Unauthorized for key sk-or-v1-0123456789abcdef0123456789abcdef0123')).toBe('401 Unauthorized for key …')
    expect(lastWords(`error: ${'x '.repeat(200)}`)!.length).toBe(160)
    expect(lastWords('  \n\n')).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('ending a run that was noted before, by its number and when it began', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const until = async (what: () => boolean, ms = 8000) => {
    for (const end = Date.now() + ms; !what(); ) {
      if (Date.now() > end) throw new Error('what the test waited for did not happen')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  test('says what became of it: ended where it and what it started were there, gone where nothing of it is, and gone too where another process has its number, which is left alone', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-endtree-'))
    try {
      const mark = path.join(folder, 'its-command.pid')
      const run = spawn('sh', ['-c', `sh -c 'echo $$ > "${mark}"; exec sleep 300' & wait`], { detached: true, stdio: 'ignore' })
      run.unref()
      await until(() => existsSync(mark) && readFileSync(mark, 'utf8').trim() !== '')
      const its = Number(readFileSync(mark, 'utf8'))
      const since = identity([run.pid!]).get(run.pid!)!
      expect(await endTree(run.pid!, since)).toBe('ended')
      expect([alive(run.pid!), alive(its)]).toEqual([false, false])
      // Asked again, there is nothing of it
      expect(await endTree(run.pid!, since)).toBe('gone')
      // This program's own number, noted with another beginning, is another process: nothing is done to it
      expect(await endTree(process.pid, 'Thu Jan  1 00:00:00 1970')).toBe('gone')
      expect(await endTree(process.pid, 'Thu Jan  1 00:00:00 1970', { harness: 'pi', session: 's', told: SINCE_TOLD })).toBe('gone')
      // On Linux a process is told by the tick it started at, as the system keeps it, and not by a calendar
      // time that is worked out from the machine's clock and changes when that is set right
      if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
        expect(identity([process.pid]).get(process.pid)).toBe(`tick ${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`)
        // A note that tells this very process by the calendar time, as an earlier It wrote it, is neither ended nor forgotten
        expect(await endTree(process.pid, 'Thu Oct  8 09:00:00 2026', { harness: 'pi', session: 's', told: 2 })).toBe('unknown')
      }
      // Noted by a program that told a start another way: whether it is that process cannot be said, and it is neither ended nor forgotten
      expect(await endTree(process.pid, 'Thu Jan  1 00:00:00 1970', { harness: 'pi', session: 's' })).toBe('unknown')
      expect(alive(process.pid)).toBe(true)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 30_000)

  test('where the run itself is gone and a command it started is still in its group, that command is ended, by the marks it carries of which run it belongs to, and a group that carries none is left alone', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-endtree-'))
    const of = { harness: 'pi', session: 'conversation-7' }
    const left: number[] = []
    const list = fs.readdirSync
    try {
      // This test proves what happens to these real children. A whole-machine Linux scan
      // can also find an unrelated, unreadable process of the same user and correctly say
      // unknown. That made the expected ended/gone outcomes depend on other work running
      // on the test machine. Keep the real stat and environment reads for our children;
      // the separate unreadable-process test covers the uncertainty from that other case.
      if (process.platform === 'linux') {
        fs.readdirSync = new Proxy(list, {
          apply(target, self, args) {
            return args[0] === '/proc' ? left.map(String) : Reflect.apply(target, self, args)
          },
        })
        syncBuiltinESMExports()
      }
      // The run starts a command, and then ends by itself while the command goes on
      const orphan = async (env: Record<string, string>) => {
        const mark = path.join(folder, `its-command-${left.length}.pid`)
        const go = path.join(folder, `go-${left.length}`)
        const run = spawn('sh', ['-c', `sleep 300 & echo $! > "${mark}"; while [ ! -e "${go}" ]; do sleep 0.05; done; exit 0`], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ...env },
        })
        await until(() => existsSync(mark) && readFileSync(mark, 'utf8').trim() !== '')
        const its = Number(readFileSync(mark, 'utf8'))
        left.push(its)
        const since = identity([run.pid!]).get(run.pid!)!
        const ended = new Promise((r) => run.once('exit', r))
        writeFileSync(go, '')
        await ended
        await until(() => !identity([run.pid!]).has(run.pid!))
        return { pid: run.pid!, since, its }
      }
      // A command the run started in a group of its own is found by the run's own name, which it
      // carries, though the run is gone and its group is empty: nothing else would say it was the run's
      const strayed = path.join(folder, 'strayed.pid')
      // (Started by a program that can put what it starts in a group of its own on every system, which a shell cannot)
      const leader = spawn(
        process.execPath,
        [
          '-e',
          `const stray = require('node:child_process').spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
           require('node:fs').writeFileSync(${JSON.stringify(strayed)}, String(stray.pid))
           stray.unref()
           setTimeout(() => process.exit(1), 300)`,
        ],
        { detached: true, stdio: 'ignore', env: { ...process.env, IT_HARNESS: of.harness, IT_SESSION: of.session, IT_RUN: 'a-run-of-its-own' } },
      )
      await until(() => existsSync(strayed) && readFileSync(strayed, 'utf8').trim() !== '')
      const leaderSince = identity([leader.pid!]).get(leader.pid!)!
      await new Promise((r) => leader.once('exit', r))
      await until(() => !identity([leader.pid!]).has(leader.pid!))
      const stray = Number(readFileSync(strayed, 'utf8'))
      left.push(stray)
      expect(alive(stray)).toBe(true)
      // By a note that does not name the run, as an earlier It wrote them, nothing of it is found: it is taken for gone
      expect(await endTree(leader.pid!, leaderSince, { ...of, told: SINCE_TOLD })).toBe('gone')
      expect(alive(stray)).toBe(true)
      // By one that names another run, the same
      expect(await endTree(leader.pid!, leaderSince, { ...of, told: SINCE_TOLD, run: 'another-run' })).toBe('gone')
      expect(alive(stray)).toBe(true)
      // By its own name it is found and ended
      expect(await endTree(leader.pid!, leaderSince, { ...of, told: SINCE_TOLD, run: 'a-run-of-its-own' })).toBe('ended')
      await until(() => !alive(stray))
      // Nor is such a command lost sight of where another process has the run's number by now.
      // That process is not the run, and neither it nor its group is touched: here it is this
      // very test. What carries the run's name is ended all the same.
      const later = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env: { ...process.env, IT_RUN: 'a-run-whose-number-was-reused' } })
      later.unref()
      left.push(later.pid!)
      await until(() => alive(later.pid!))
      const reused = { ...of, told: SINCE_TOLD }
      expect(await endTree(process.pid, identity([later.pid!]).get(later.pid!)!, { ...reused, run: 'another-run' })).toBe('gone')
      expect(alive(later.pid!)).toBe(true)
      expect(await endTree(process.pid, identity([later.pid!]).get(later.pid!)!, { ...reused, run: 'a-run-whose-number-was-reused' })).toBe('ended')
      await until(() => !alive(later.pid!))
      // Started as a reopened run is, with the two marks, which what it starts carries on
      const ours = await orphan({ IT_HARNESS: of.harness, IT_SESSION: of.session })
      expect(alive(ours.its)).toBe(true)
      // With nothing to go by, nothing is signalled, and that is said as not known
      expect(await endTree(ours.pid, ours.since)).toBe('unknown')
      expect(alive(ours.its)).toBe(true)
      expect(await endTree(ours.pid, ours.since, of)).toBe('ended')
      expect(alive(ours.its)).toBe(false)
      // A group of the same kind that carries another run's marks, or none: it may be somebody else's, or a
      // command of this run's that was started with nothing handed on. It is left alone, and said to be not known
      const anothers = await orphan({ IT_HARNESS: of.harness, IT_SESSION: 'conversation-8' })
      expect(await endTree(anothers.pid, anothers.since, of)).toBe('unknown')
      expect(alive(anothers.its)).toBe(true)
      const nobodys = await orphan({ IT_HARNESS: '', IT_SESSION: '' })
      expect(await endTree(nobodys.pid, nobodys.since, of)).toBe('unknown')
      expect(alive(nobodys.its)).toBe(true)
      // Once it has gone by itself, so has the run
      process.kill(nobodys.its, 'SIGKILL')
      await until(() => !alive(nobodys.its))
      expect(await endTree(nobodys.pid, nobodys.since, of)).toBe('gone')
      // A note that names the machine's start some other way than this system does says nothing of it, and what
      // it noted is looked at as any other is: the time a Mac started at, which was once what was noted there,
      // reads differently after a change of time zone
      expect(bootId()).toMatch(/^[0-9a-f-]{36}$/)
      for (const boot of ['{ sec = 1791400000, usec = 0 } Wed Oct  7 09:00:00 2026', 'another start of this machine', bootId()])
        expect(await endTree(anothers.pid, anothers.since, { ...of, boot })).toBe('unknown')
      expect(alive(anothers.its)).toBe(true)
      // And a run noted under another start of this machine is gone, whatever has its number
      expect(await endTree(anothers.pid, anothers.since, { ...of, session: 'conversation-8', boot: '00000000-0000-4000-8000-000000000000' })).toBe('gone')
      expect(alive(anothers.its)).toBe(true)
    } finally {
      fs.readdirSync = list
      syncBuiltinESMExports()
      for (const pid of left)
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      rmSync(folder, { recursive: true, force: true })
    }
  }, 60_000)

  test.skipIf(process.platform !== 'linux')(
    'an unrelated process whose environment cannot be read keeps a run uncertain until inspection succeeds',
    async () => {
      const candidate = process.pid
      const list = fs.readdirSync
      const read = fs.readFileSync
      let readable = false
      try {
        fs.readdirSync = new Proxy(list, {
          apply(target, self, args) {
            return args[0] === '/proc' ? [String(candidate)] : Reflect.apply(target, self, args)
          },
        })
        fs.readFileSync = new Proxy(read, {
          apply(target, self, args) {
            if (args[0] === `/proc/${candidate}/stat`) return `${candidate} (tool) ${['S', ...Array(18).fill('0'), '1'].join(' ')}`
            if (args[0] === `/proc/${candidate}/environ`) {
              if (!readable) throw Object.assign(new Error('the environment cannot be read'), { code: 'EACCES' })
              return 'IT_RUN=another-run\0'
            }
            return Reflect.apply(target, self, args)
          },
        })
        // This process's directory belongs to this user. Only its environment is unreadable, as with
        // a process that has disabled inspection; it cannot be dismissed as another user's.
        syncBuiltinESMExports()
        const of = { harness: 'pi', session: 'unreadable', run: 'finished-run', told: SINCE_TOLD }
        expect(await endTree(process.pid, 'tick 0', of)).toBe('unknown')
        readable = true
        expect(await endTree(process.pid, 'tick 0', of)).toBe('gone')
      } finally {
        fs.readdirSync = list
        fs.readFileSync = read
        syncBuiltinESMExports()
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'a command carrying the run’s name is ended though another process of the same person’s cannot be read, and the run stays uncertain',
    async () => {
      const candidate = process.pid
      const list = fs.readdirSync
      const read = fs.readFileSync
      // The run's own command, in a group of its own, which nothing but the run's name says is the run's
      const command = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env: { ...process.env, IT_RUN: 'a-run-with-company' } })
      command.unref()
      await until(() => identity([command.pid!]).has(command.pid!))
      try {
        fs.readdirSync = new Proxy(list, {
          apply(target, self, args) {
            return args[0] === '/proc' ? [String(candidate), String(command.pid)] : Reflect.apply(target, self, args)
          },
        })
        // And a process of the same person's, begun since, whose environment cannot be read
        fs.readFileSync = new Proxy(read, {
          apply(target, self, args) {
            if (args[0] === `/proc/${candidate}/stat`) return `${candidate} (tool) ${['S', ...Array(18).fill('0'), '1'].join(' ')}`
            if (args[0] === `/proc/${candidate}/environ`) throw Object.assign(new Error('the environment cannot be read'), { code: 'EACCES' })
            return Reflect.apply(target, self, args)
          },
        })
        syncBuiltinESMExports()
        const of = { harness: 'pi', session: 'with-company', run: 'a-run-with-company', told: SINCE_TOLD }
        expect(await endTree(process.pid, 'tick 0', of)).toBe('unknown')
        await until(() => !identity([command.pid!]).has(command.pid!))
      } finally {
        fs.readdirSync = list
        fs.readFileSync = read
        syncBuiltinESMExports()
        if (identity([command.pid!]).has(command.pid!)) process.kill(command.pid!, 'SIGKILL')
      }
    },
  )
})

describe('a reopened run on Windows, as it is put to the system', () => {
  const decoded = (args: string[]) => Buffer.from(args.at(-1)!, 'base64').toString('utf16le')

  test('words are put on one line as a Windows program reads them back', () => {
    expect(windowsLine(['C:\\Program Files\\nodejs\\node.exe', 'C:\\npm\\cli.js', '--session', 'ses_1', '-'])).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" C:\\npm\\cli.js --session ses_1 -',
    )
    // Nothing at all, a quote, and backslashes before a quote and before the closing quote
    expect(windowsLine(['', 'say "hi"', 'a\\\\"b', 'two words\\', 'C:\\dir\\', 'Bash(it:*)'])).toBe(
      '"" "say \\"hi\\"" "a\\\\\\\\\\"b" "two words\\\\" C:\\dir\\ Bash(it:*)',
    )
  })

  test('a run is started by a keeper that is told its job, its command line and who started it in its environment, with nothing of the app on its own command line', () => {
    const run = randomUUID()
    const started = keeper(['C:\\Users\\a b\\.local\\bin\\claude.exe', '--resume', 'x', '--allowedTools', 'Bash(it:*)'], run, {
      PSModulePath: 'C:\\mods',
      KEY: 'v',
    })
    if (typeof started === 'string') throw new Error(started)
    expect(started.file).toMatch(/[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/)
    expect(started.args.slice(0, -1)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    const script = decoded(started.args)
    expect(script).toContain("Add-Type -TypeDefinition @'")
    expect(script).toContain('$kept = [ItJob]::Keep()')
    expect(script).toContain(`exit ${KEPT_NOT}`)
    expect(script).not.toContain('claude')
    expect(started.env).toMatchObject({
      KEY: 'v',
      PSModulePath: 'C:\\mods',
      IT_JOB: `Global\\it-run-${run}`,
      IT_JOB_LINE: '"C:\\Users\\a b\\.local\\bin\\claude.exe" --resume x --allowedTools Bash(it:*)',
      IT_JOB_PARENT: String(process.pid),
      IT_JOB_MODULES: '+C:\\mods',
    })
    // An environment without the folders of PowerShell's modules has none given to the app either
    expect((keeper(['C:\\x.exe'], run, {}) as { env: NodeJS.ProcessEnv }).env.IT_JOB_MODULES).toBe('-')
  })

  test('nothing is started by a keeper for a program that is not named in full, a command script, a word Windows cannot be given, or a run with no name a job can have', () => {
    const run = randomUUID()
    expect(keeper(['claude', '--resume'], run, {})).toBe('where its program is on this machine is not known')
    for (const script of ['C:\\npm\\pi.cmd', 'C:\\npm\\PI.BAT'])
      expect(keeper([script, '--print'], run, {})).toBe('its program is a command script, which It does not start with nobody watching')
    expect(keeper(['C:\\x.exe', 'a\0b'], run, {})).toBe('a word of its command cannot be given on Windows')
    for (const name of ['', 'a b', 'x\\y', 'r'.repeat(65)]) {
      expect(keeper(['C:\\x.exe'], name, {})).toBe('its run has no name a job can be given')
      expect(jobName(name)).toBeNull()
    }
  })

  test('on Windows a run noted before is ended by its job and by nothing else, and only the job says whether anything of it is left', async () => {
    const platform = process.platform
    const execFile = childProcess.execFile
    const asked: { file: string; script: string; job?: string }[] = []
    let answer = 'ended'
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      childProcess.execFile = new Proxy(execFile, {
        apply(_target, _self, [file, args, opts, done]) {
          asked.push({ file, script: decoded(args), job: opts.env.IT_JOB })
          setImmediate(() => (answer === 'fails' ? done(new Error('it could not be run'), '', '') : done(null, `WARNING: something\r\n${answer}\r\n`, '')))
          return {}
        },
      })
      syncBuiltinESMExports()
      const run = randomUUID()
      const of = { harness: 'pi', session: 's-1', run, told: SINCE_TOLD }
      expect(await endTree(4242, IN_JOB, of)).toBe('ended')
      expect(asked.at(-1)!.file).toMatch(/[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/)
      expect(asked.at(-1)!.script).toContain('[ItJob]::End($env:IT_JOB, 5000)')
      expect(asked.at(-1)!.job).toBe(`Global\\it-run-${run}`)
      answer = 'gone'
      expect(await endTree(4242, IN_JOB, of)).toBe('gone')
      for (answer of ['unknown', 'something else', '', 'fails']) expect(await endTree(4242, IN_JOB, of), answer).toBe('unknown')
      // A note that names no run, or that does not say it was kept in a job, says nothing by which to find it, and nothing is asked
      const before = asked.length
      expect(await endTree(4242, IN_JOB, { harness: 'pi', session: 's-1' })).toBe('unknown')
      expect(await endTree(4242, 'tick 100', of)).toBe('unknown')
      expect(await endJob('not a name')).toBe('unknown')
      expect(asked.length).toBe(before)
      // And no process was ever signalled by its number
      expect(kill).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
      childProcess.execFile = execFile
      syncBuiltinESMExports()
      kill.mockRestore()
    }
  })

  describe('where an agent app is on Windows', () => {
    /** A person's disk as a map of files, read as Windows reads names: with no case. */
    const disk = (files: Record<string, string>) => {
      const kept = new Map(Object.entries(files).map(([file, text]) => [file.toLowerCase(), text]))
      return {
        exists: (file: string) => kept.has(file.toLowerCase()),
        read: (file: string) => {
          const text = kept.get(file.toLowerCase())
          if (text === undefined) throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
          return text
        },
      }
    }
    // As npm writes it for a package whose command is a script for Node
    const npmScript = (target: string) =>
      `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`
    const NODE = 'C:\\Program Files\\nodejs\\node.exe'

    test('a program of the name is started itself, from the first folder of the PATH that has one, and only folders named in full are looked in', () => {
      const { exists, read } = disk({ 'C:\\Users\\a\\.local\\bin\\claude.exe': '', 'C:\\Tools\\claude.exe': '', 'claude.exe': '', '.\\claude.exe': '' })
      expect(windowsProgram('claude', '.;bin;C:\\Users\\a\\.local\\bin;C:\\Tools', exists, read)).toEqual(['C:\\Users\\a\\.local\\bin\\claude.exe'])
      expect(windowsProgram('claude', '"C:\\Tools";C:\\Users\\a\\.local\\bin', exists, read)).toEqual(['C:\\Tools\\claude.exe'])
      expect(windowsProgram('claude', '.;bin', exists, read)).toBeNull()
      expect(windowsProgram('hermes', 'C:\\Tools', exists, read)).toBeNull()
    })

    test('a command script that npm or pnpm wrote is read for what it starts, which is started without the script', () => {
      const pi = 'node_modules\\@mariozechner\\pi-coding-agent\\dist\\cli.js'
      // npm's, with the Node on the PATH, and with a Node beside it
      let { exists, read } = disk({ 'C:\\npm\\pi.cmd': npmScript(pi), [`C:\\npm\\${pi}`]: '', [NODE]: '' })
      expect(windowsProgram('pi', 'C:\\npm;C:\\Program Files\\nodejs', exists, read)).toEqual([NODE, `C:\\npm\\${pi}`])
      ;({ exists, read } = disk({ 'C:\\npm\\pi.cmd': npmScript(pi), [`C:\\npm\\${pi}`]: '', 'C:\\npm\\node.exe': '', [NODE]: '' }))
      expect(windowsProgram('pi', 'C:\\npm;C:\\Program Files\\nodejs', exists, read)).toEqual(['C:\\npm\\node.exe', `C:\\npm\\${pi}`])
      // A script with no extension, as OpenCode's is
      ;({ exists, read } = disk({
        'C:\\npm\\opencode.cmd': npmScript('node_modules\\opencode-ai\\bin\\opencode'),
        'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode': '',
        [NODE]: '',
      }))
      expect(windowsProgram('opencode', 'C:\\npm;C:\\Program Files\\nodejs', exists, read)).toEqual([NODE, 'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode'])
      // pnpm's, which names the script from a folder beside its own
      const pnpm = `@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n  @SET "NODE_PATH=C:\\pnpm\\global\\5\\node_modules"\r\n)\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\pnpm\\global\\5\\node_modules\\pi\\dist\\cli.js" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\..\\pnpm\\global\\5\\node_modules\\pi\\dist\\cli.js" %*\r\n)\r\n`
      ;({ exists, read } = disk({
        'C:\\Users\\a\\AppData\\Local\\bin\\pi.CMD': pnpm,
        'C:\\Users\\a\\AppData\\Local\\pnpm\\global\\5\\node_modules\\pi\\dist\\cli.js': '',
        [NODE]: '',
      }))
      expect(windowsProgram('pi', 'C:\\Users\\a\\AppData\\Local\\bin;C:\\Program Files\\nodejs', exists, read)).toEqual([
        NODE,
        'C:\\Users\\a\\AppData\\Local\\pnpm\\global\\5\\node_modules\\pi\\dist\\cli.js',
      ])
      // One that starts a program, which is started itself
      const exe = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`
      ;({ exists, read } = disk({ 'C:\\npm\\claude.cmd': exe, 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe': '' }))
      expect(windowsProgram('claude', 'C:\\npm', exists, read)).toEqual(['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'])
    })

    test('a command script whose program is not there, that starts something other than Node, or that cannot be read, starts nothing, and a later folder is not looked in for another', () => {
      const pi = 'node_modules\\pi\\cli.js'
      for (const files of <Record<string, string>[]>[
        { 'C:\\npm\\pi.cmd': npmScript(pi), [NODE]: '' },
        { 'C:\\npm\\pi.cmd': npmScript(pi), [`C:\\npm\\${pi}`]: '' },
        { 'C:\\npm\\pi.cmd': '@ECHO off\r\n"%dp0%\\pi.sh" %*\r\nsh', 'C:\\npm\\pi.sh': '', [NODE]: '' },
        { 'C:\\npm\\pi.cmd': '@ECHO off\r\ncall something-else %*\r\n', [NODE]: '' },
      ]) {
        const { exists, read } = disk({ ...files, 'C:\\Tools\\pi.exe': '' })
        expect(windowsProgram('pi', 'C:\\npm;C:\\Program Files\\nodejs;C:\\Tools', exists, read)).toBeNull()
      }
      const { exists } = disk({ 'C:\\npm\\pi.cmd': '' })
      expect(
        windowsProgram('pi', 'C:\\npm', exists, () => {
          throw new Error('it cannot be read')
        }),
      ).toBeNull()
    })
  })
})

describe.skipIf(process.platform !== 'win32')('a reopened run on Windows, kept in a job of its own', () => {
  // A stand-in for an agent app: it writes down what it was given and how, starts something
  // that runs until it is ended, and then ends as it is told, or waits. What it starts is
  // started apart from it, as a command an agent leaves running in the background is: Node puts
  // what it starts otherwise in a job of its own, which ends it with Node, and only the run's job
  // is to be what ends it here
  const AGENT = `const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const [dir, mode] = process.argv.slice(2)
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (piece) => { input += piece })
process.stdin.on('end', () => {
  const left = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true })
  left.unref()
  const ran = { input, pid: process.pid, left: left.pid, cwd: process.cwd(), run: process.env.IT_RUN || null, told: Object.keys(process.env).filter((k) => /^IT_JOB/i.test(k)), modules: process.env.PSModulePath === undefined ? null : process.env.PSModulePath }
  fs.writeFileSync(path.join(dir, 'ran.part'), JSON.stringify(ran))
  fs.renameSync(path.join(dir, 'ran.part'), path.join(dir, 'ran.json'))
  if (mode === 'wait') setInterval(() => {}, 1000)
  else {
    console.log('a last line')
    setTimeout(() => process.exit(mode === 'fail' ? 3 : 0), 50)
  }
})
`
  // A stand-in for It's service: it starts the keeper as the service does, and then waits until it is ended
  const SERVICE = `const fs = require('fs')
const { spawn } = require('child_process')
const how = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const keeper = spawn(how.file, how.args, { cwd: how.cwd, env: { ...how.env, IT_JOB_PARENT: how.parent ?? String(process.pid) }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
keeper.on('exit', (code) => fs.writeFileSync(how.ended, String(code)))
keeper.stdin.end(how.input)
setInterval(() => {}, 1000)
`
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const until = async (ok: () => boolean, ms = 90_000) => {
    const by = Date.now() + ms
    while (!ok()) {
      if (Date.now() > by) throw new Error('it did not come to be in time')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  type Ran = { input: string; pid: number; left: number; cwd: string; run: string | null; told: string[]; modules: string | null }
  const ranIn = (dir: string): Ran => JSON.parse(readFileSync(path.join(dir, 'ran.json'), 'utf8'))
  const agentIn = (dir: string) => {
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'agent.js')
    writeFileSync(file, AGENT)
    return file
  }
  const standIn = (dir: string, mode: 'done' | 'fail' | 'wait') => ({
    argv: [process.execPath, agentIn(dir), dir, mode],
    input: 'what was done on the page',
    app: 'Stand-in',
  })
  // What a run left running is ended after each test, and waited for. It was in the scratch
  // folder and had the run's output open, and Windows refuses to remove either while a program
  // holds them, which it may still do for a moment after it is reported to have ended: so the
  // folder is removed here, as soon as Windows lets it be
  const left: number[] = []
  afterEach(async () => {
    const pids = left.splice(0)
    for (const pid of pids)
      try {
        process.kill(pid)
      } catch {}
    await until(() => !pids.some(alive), 15_000)
    await until(() => {
      try {
        rmSync(scratch, { recursive: true, force: true })
        return true
      } catch {
        return false
      }
    }, 15_000)
  })

  test('is given its message on its input, in its folder, with the name of its run and with nothing the keeper was told by, and what it left running when it ended by itself is let be', async () => {
    const run = randomUUID()
    const noted: [number, string | undefined][] = []
    const said: string[] = []
    const ended = await carryOn(
      standIn(scratch, 'done'),
      scratch,
      { harness: 'pi', session: 's-1', run },
      { env: process.env, keepIn: path.join(scratch, 'logs'), said: (words) => said.push(words), began: (pid, since) => noted.push([pid, since]) },
    )
    expect(ended).toBeNull()
    const ran = ranIn(scratch)
    left.push(ran.left)
    expect(ran.input).toBe('what was done on the page')
    expect(realpathSync(ran.cwd).toLowerCase()).toBe(scratch.toLowerCase())
    expect(ran.run).toBe(run)
    expect(ran.told).toEqual([])
    expect(ran.modules).toBe(process.env.PSModulePath ?? null)
    expect(noted).toEqual([[expect.any(Number), IN_JOB]])
    expect(said).toEqual([])
    expect(alive(ran.pid)).toBe(false)
    expect(alive(ran.left)).toBe(true)
    process.kill(ran.left)
    await until(() => !alive(ran.left))
    expect(await endJob(run)).toBe('gone')
  }, 180_000)

  test('that ends badly by itself says so, with its code and the last line it printed', async () => {
    const said: string[] = []
    const ended = await carryOn(
      standIn(scratch, 'fail'),
      scratch,
      { harness: 'pi', session: 's-1', run: randomUUID() },
      { env: process.env, keepIn: path.join(scratch, 'logs'), said: (words) => said.push(words) },
    )
    left.push(ranIn(scratch).left)
    expect(ended).toBe('Stand-in exited with 3')
    expect(said).toEqual(['a last line'])
  }, 180_000)

  test('that is stopped is ended with everything it started, and its job is gone after', async () => {
    const run = randomUUID()
    const stop = new AbortController()
    const unsure = vi.fn()
    const ending = carryOn(standIn(scratch, 'wait'), scratch, { harness: 'pi', session: 's-1', run }, { env: process.env, signal: stop.signal, unsure })
    await until(() => existsSync(path.join(scratch, 'ran.json')))
    const ran = ranIn(scratch)
    left.push(ran.left, ran.pid)
    expect([alive(ran.pid), alive(ran.left)]).toEqual([true, true])
    stop.abort()
    expect(await ending).toBe(STOPPED)
    expect(unsure).not.toHaveBeenCalled()
    await until(() => !alive(ran.pid) && !alive(ran.left), 5_000)
    expect(await endJob(run)).toBe('gone')
  }, 180_000)

  test('that was noted by a connector which started again is found by its job and ended with everything it started, by no number', async () => {
    const run = randomUUID()
    const ending = carryOn(standIn(scratch, 'wait'), scratch, { harness: 'pi', session: 's-1', run }, { env: process.env })
    await until(() => existsSync(path.join(scratch, 'ran.json')))
    const ran = ranIn(scratch)
    left.push(ran.left, ran.pid)
    // As a connector that started again does with what it finds noted: by a number that is nobody's, which is never signalled
    expect(await endTree(2_000_000_000, IN_JOB, { harness: 'pi', session: 's-1', run, told: SINCE_TOLD })).toBe('ended')
    expect([alive(ran.pid), alive(ran.left)]).toEqual([false, false])
    expect(await ending).toMatch(/^Stand-in exited with /)
    expect(await endTree(2_000_000_000, IN_JOB, { harness: 'pi', session: 's-1', run, told: SINCE_TOLD })).toBe('gone')
  }, 180_000)

  test('ends with the program that started it, however that ended', async () => {
    const run = randomUUID()
    const started = keeper(standIn(scratch, 'wait').argv, run, { ...process.env })
    if (typeof started === 'string') throw new Error(started)
    const how = path.join(scratch, 'how.json')
    writeFileSync(how, JSON.stringify({ ...started, cwd: scratch, input: 'hello', ended: path.join(scratch, 'keeper-ended') }))
    writeFileSync(path.join(scratch, 'service.js'), SERVICE)
    const service = spawn(process.execPath, [path.join(scratch, 'service.js'), how], { stdio: 'ignore', windowsHide: true })
    left.push(service.pid!)
    await until(() => existsSync(path.join(scratch, 'ran.json')))
    const ran = ranIn(scratch)
    left.push(ran.left, ran.pid)
    expect(ran.input).toBe('hello')
    expect([alive(ran.pid), alive(ran.left)]).toEqual([true, true])
    // Ended from outside, with no word to anything it started
    service.kill()
    await until(() => !alive(ran.pid) && !alive(ran.left), 15_000)
    expect(await endJob(run)).toBe('gone')
  }, 180_000)

  test('starts nothing where the program that started it cannot be made sure of, or a job of its name is there already', async () => {
    // Told of a program that is not there
    const run = randomUUID()
    const started = keeper(standIn(scratch, 'done').argv, run, { ...process.env })
    if (typeof started === 'string') throw new Error(started)
    const how = path.join(scratch, 'how.json')
    const ended = path.join(scratch, 'keeper-ended')
    writeFileSync(how, JSON.stringify({ ...started, cwd: scratch, input: 'hello', ended, parent: '2000000000' }))
    writeFileSync(path.join(scratch, 'service.js'), SERVICE)
    const service = spawn(process.execPath, [path.join(scratch, 'service.js'), how], { stdio: 'ignore', windowsHide: true })
    left.push(service.pid!)
    await until(() => existsSync(ended))
    expect(Number(readFileSync(ended, 'utf8'))).toBe(KEPT_NOT)
    expect(existsSync(path.join(scratch, 'ran.json'))).toBe(false)
    // And a run whose job's name another run has
    const first = new AbortController()
    const running = carryOn(standIn(scratch, 'wait'), scratch, { harness: 'pi', session: 's-1', run }, { env: process.env, signal: first.signal })
    await until(() => existsSync(path.join(scratch, 'ran.json')))
    left.push(ranIn(scratch).left, ranIn(scratch).pid)
    const other = path.join(scratch, 'other')
    expect(await carryOn(standIn(other, 'done'), other, { harness: 'pi', session: 's-2', run }, { env: process.env })).toBe(
      'Stand-in could not be started: Windows would not keep it in a job of its own, which It needs to be able to end it',
    )
    expect(existsSync(path.join(other, 'ran.json'))).toBe(false)
    first.abort()
    expect(await running).toBe(STOPPED)
  }, 180_000)

  test('whose program is not there says so', async () => {
    expect(
      await carryOn(
        { argv: [path.join(scratch, 'nowhere.exe'), '--print'], input: 'x', app: 'Stand-in' },
        scratch,
        { harness: 'pi', session: 's-1', run: randomUUID() },
        { env: process.env },
      ),
    ).toBe('Stand-in was not found')
  }, 180_000)
})
