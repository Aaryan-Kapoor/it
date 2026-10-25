// The connector's keeper of project agents, against stand-ins for Claude Code and Codex and a
// stand-in for what It and the connector say: an agent is started where it is wanted, given what
// waits for it a turn at a time, let go when it has had nothing to do and resumed when it has,
// stopped and started again as the person says, refused where its machine does not offer it,
// and, across a restart of It, ended and resumed, and told when its turn was cut off.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AgentKeeper, CUT_OFF, type Handed, type KeeperDeps, type Wanted } from './src/agent-keeper'
import { identity, processes } from './src/wake'
import { CLAUDE, CODEX } from './stand-in-agents'

let dir: string
let folder: string
const keepers: AgentKeeper[] = []
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-keep-')))
  folder = path.join(dir, 'garden')
  mkdirSync(folder)
  for (const [name, body] of [
    ['claude.js', CLAUDE],
    ['codex.js', CODEX],
  ] as const) {
    writeFileSync(path.join(dir, name), body)
    chmodSync(path.join(dir, name), 0o755)
  }
  writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ on: true, most: 2, projects: [{ id: 'p-one', path: folder }] }))
})
afterEach(async () => {
  for (const k of keepers.splice(0)) await k.close()
  rmSync(dir, { recursive: true, force: true })
})

/** What It and the connector stand in for: what was said to them, and what they hand over. */
function world(extra: Partial<KeeperDeps> = {}) {
  const said = {
    offers: [] as unknown[],
    reports: [] as { agentId: string; round: number; state: string; why?: string; session?: string; said?: string }[],
    taken: [] as string[],
    acked: [] as string[],
    lines: [] as string[],
  }
  const waiting: Handed[] = []
  const deps: KeeperDeps = {
    offer: async (o) => {
      said.offers.push(o)
    },
    report: async (r) => {
      said.reports.push(r)
      return { gone: false }
    },
    taken: async (_agent, ids) => {
      said.taken.push(...ids)
    },
    clicks: async () => [...waiting],
    ack: async (ids) => {
      said.acked.push(...ids)
      for (const id of ids) waiting.splice(waiting.findIndex((c) => c.id === id) >>> 0, 1)
    },
    connected: (app) => app === 'claude-code' || app === 'codex',
    env: async () => ({ ...process.env, SEEN: path.join(dir, 'seen.json') }),
    say: (line) => said.lines.push(line),
    itHome: path.join(dir, 'it-home'),
    itAt: [],
    commandFor: (app) => [process.execPath, path.join(dir, app === 'claude-code' ? 'claude.js' : 'codex.js')],
    settingsFile: path.join(dir, 'agents.json'),
    runsFile: path.join(dir, 'agent-runs.json'),
    everyMs: 50,
    ...extra,
  }
  return { said, waiting, deps }
}

const agent = (extra: Partial<Wanted> = {}): Wanted => ({
  id: 'agent-000001',
  project: 'p-one',
  app: 'claude-code',
  want: 'run',
  round: 1,
  state: 'starting',
  session: null,
  messages: [],
  ...extra,
})
const seen = () => {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'seen.json'), 'utf8')) as { argv: string[]; got: string[]; asked?: { method: string; params: any }[] }
  } catch {
    return null
  }
}
async function until(done: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error('it did not happen in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const states = (said: { reports: { state: string }[] }) => said.reports.map((r) => r.state)
const last = (said: { reports: { state: string }[] }) => said.reports.at(-1)?.state

async function keeperOf(w: ReturnType<typeof world>, wanted: Wanted[]) {
  const k = new AgentKeeper(w.deps)
  keepers.push(k)
  k.update(wanted)
  await k.begin()
  return k
}

describe('the keeper of project agents', () => {
  test('starts a new agent in its folder, gives it what waits for it as a turn, and says what it said', async () => {
    const w = world()
    const k = await keeperOf(w, [agent({ messages: [{ id: 'm1', text: 'tidy the beds' }] })])
    await until(() => w.said.reports.some((r) => r.said === 'heard: tidy the beds'))
    // Offered first, as this machine keeps it, by the folder's word and never its path beyond the home folder
    expect(w.said.offers).toEqual([
      { most: 2, projects: [{ id: 'p-one', name: 'garden', where: folder.startsWith(os.homedir()) ? expect.any(String) : folder }] },
    ])
    const session = w.said.reports.find((r) => r.session)?.session
    expect(session).toMatch(/^[0-9a-f-]{36}$/)
    expect(seen()!.argv).toEqual(expect.arrayContaining(['--session-id', session]))
    // It already says the agent is starting, which is not said again; at work is not said where the turn was over before it could be
    expect(states(w.said).filter((s) => s !== 'working')).toEqual(['ready', 'ready'])
    expect(last(w.said)).toBe('ready')
    expect(w.said.taken).toEqual(['m1'])
    // Its conversation is its own from now on: its clicks go to the keeper
    expect(k.owns(`claude-code:${session}`)).toBe(true)
    expect(k.owns('claude-code:someone-else')).toBe(false)
    // And while it runs it is written down, to be ended by the connector after this one if this one dies
    const notes = JSON.parse(readFileSync(path.join(dir, 'agent-runs.json'), 'utf8'))
    expect(notes.runs['agent-000001']).toMatchObject({ app: 'claude-code', session, told: expect.any(Number), run: expect.stringMatching(/^agent-/) })
  })

  test('hands over what was done on its pages once, however often the connector offers it', async () => {
    const w = world()
    w.waiting.push({ id: 'click-1', text: '[It] Someone pressed “water” on the page garden.' })
    await keeperOf(w, [agent({ session: '3f0c3c55-1d4b-4a8e-9b1a-2a8a1c1c0b11', state: 'resting' })])
    await until(() => w.said.acked.length > 0 && last(w.said) === 'ready')
    await new Promise((r) => setTimeout(r, 300))
    expect(seen()!.got).toEqual(['[It] Someone pressed “water” on the page garden.'])
    expect(w.said.acked).toEqual(['click-1'])
    // A resting agent with something to do is resumed in its own conversation
    expect(seen()!.argv).toEqual(expect.arrayContaining(['--resume', '3f0c3c55-1d4b-4a8e-9b1a-2a8a1c1c0b11']))
  })

  test('rests without a program where it has nothing to do, and is let go when it has had nothing to do for long enough', async () => {
    const w = world({ idleMs: 300 })
    await keeperOf(w, [agent({ session: '3f0c3c55-1d4b-4a8e-9b1a-2a8a1c1c0b11', state: 'ready' })])
    await until(() => last(w.said) === 'resting')
    expect(seen()).toBeNull()
    const w2 = world({ idleMs: 300 })
    await keeperOf(w2, [agent()])
    await until(() => states(w2.said).includes('ready'))
    await until(() => last(w2.said) === 'resting')
    const pid = JSON.parse(readFileSync(path.join(dir, 'agent-runs.json'), 'utf8')).runs['agent-000001']
    expect(pid).toBeUndefined()
  })

  test('is stopped when the person stops it, and started again in its own conversation when they start it again', async () => {
    const w = world()
    const k = await keeperOf(w, [agent()])
    await until(() => last(w.said) === 'ready')
    const session = w.said.reports.find((r) => r.session)!.session!
    k.update([agent({ want: 'stop', state: 'stopping', session })])
    await until(() => last(w.said) === 'stopped')
    expect(JSON.parse(readFileSync(path.join(dir, 'agent-runs.json'), 'utf8')).runs).toEqual({})
    k.update([agent({ want: 'run', round: 2, state: 'starting', session })])
    await until(() => w.said.reports.some((r) => r.round === 2 && r.state === 'ready'))
    await until(() => seen()?.argv.includes('--resume') === true)
    expect(seen()!.argv).toEqual(expect.arrayContaining(['--resume', session]))
  })

  test('is not run where its machine no longer offers its folder or its app is not connected, and says why', async () => {
    const w = world({ connected: () => false })
    await keeperOf(w, [agent()])
    await until(() => last(w.said) === 'failed')
    expect(w.said.reports.at(-1)!.why).toMatch(/Claude Code is not connected on this machine/)
    writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ on: true, most: 2, projects: [] }))
    const w2 = world()
    await keeperOf(w2, [agent()])
    await until(() => last(w2.said) === 'failed')
    expect(w2.said.reports.at(-1)!.why).toMatch(/does not offer this agent’s folder/)
    expect(seen()).toBeNull()
  })

  test('is failed with its app’s last words where its program ends by itself, and not started again until the person says', async () => {
    const w = world()
    const k = await keeperOf(w, [agent({ messages: [{ id: 'm1', text: 'crash' }] })])
    await until(() => last(w.said) === 'failed')
    expect(w.said.reports.at(-1)!.why).toBe('Claude Code ended by itself, with 3. Its last words were: error: the model could not be reached')
    const before = w.said.reports.length
    await new Promise((r) => setTimeout(r, 400))
    expect(w.said.reports.length).toBe(before)
    const session = w.said.reports.find((r) => r.session)!.session!
    k.update([agent({ round: 2, session })])
    await until(() => w.said.reports.some((r) => r.round === 2 && r.state === 'ready'))
  })

  test('runs no more at once than the machine said, and starts the next when there is room', async () => {
    writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ on: true, most: 1, projects: [{ id: 'p-one', path: folder }] }))
    const w = world()
    await keeperOf(w, [agent(), agent({ id: 'agent-000002' })])
    await until(() => w.said.reports.some((r) => r.agentId === 'agent-000001' && r.state === 'ready'))
    await new Promise((r) => setTimeout(r, 300))
    expect(w.said.reports.filter((r) => r.agentId === 'agent-000002').map((r) => r.state)).toEqual(['resting'])
  })

  test('opens a Codex thread for a new agent and says which', async () => {
    const w = world()
    await keeperOf(w, [agent({ app: 'codex', messages: [{ id: 'm1', text: 'water the beans' }] })])
    await until(() => w.said.reports.some((r) => r.said === 'did: water the beans'))
    expect(w.said.reports.find((r) => r.session)?.session).toBe('thread-made-1')
    expect(seen()!.asked!.map((a) => a.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])
  })

  test.skipIf(process.platform === 'win32')(
    'across a restart of It, ends what was left, and resumes a turn that was cut off with word of it',
    async () => {
      const w = world()
      const k = new AgentKeeper(w.deps)
      k.update([agent({ messages: [{ id: 'm1', text: 'slow' }] })])
      await k.begin()
      await until(() => last(w.said) === 'working')
      const session = w.said.reports.find((r) => r.session)!.session!
      await k.close()
      expect(JSON.parse(readFileSync(path.join(dir, 'agent-runs.json'), 'utf8'))).toMatchObject({ runs: {}, cutOff: ['agent-000001'], left: expect.any(Array) })
      expect(last(w.said)).toBe('resting')
      // The next connector resumes it and tells it
      const w2 = world()
      await keeperOf(w2, [agent({ state: 'resting', session })])
      await until(() => (seen()?.got ?? []).includes(CUT_OFF))
      expect(seen()!.argv).toEqual(expect.arrayContaining(['--resume', session]))
      expect(JSON.parse(readFileSync(path.join(dir, 'agent-runs.json'), 'utf8')).cutOff).toEqual([])
    },
    20_000,
  )

  test.skipIf(process.platform === 'win32')('ends a program a connector that died left running, by the note it left', async () => {
    // A program of an agent's, as a connector that then died would have started it and written it down
    const left = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env: { ...process.env, IT_RUN: 'agent-left-1' } })
    await until(() => identity([left.pid!]).has(left.pid!))
    const since = identity([left.pid!]).get(left.pid!)!
    writeFileSync(
      path.join(dir, 'agent-runs.json'),
      JSON.stringify({
        runs: { 'agent-000001': { pid: left.pid, since, told: 3, run: 'agent-left-1', app: 'claude-code', session: null, busy: true } },
        cutOff: [],
      }),
    )
    // Where the system would not say for certain that it had ended (a busy machine, with processes
    // of this user coming and going as it looked), the note is kept and it is looked at again by
    // the connector that starts next
    for (let tries = 0; tries < 3 && Object.keys(JSON.parse(readFileSync(path.join(dir, 'agent-runs.json'), 'utf8')).runs).length; tries++)
      await keeperOf(world(), [])
    expect(processes([left.pid!])?.has(left.pid!)).toBe(false)
    // It was at work, so it is down as cut off, to be told when it is resumed
    expect(JSON.parse(readFileSync(path.join(dir, 'agent-runs.json'), 'utf8'))).toMatchObject({ runs: {}, cutOff: ['agent-000001'] })
  })

  test('starts nothing where its note of what it ran cannot be read', async () => {
    writeFileSync(path.join(dir, 'agent-runs.json'), '{ cut short')
    const w = world()
    await keeperOf(w, [agent()])
    await until(() => last(w.said) === 'failed')
    expect(w.said.reports.at(-1)!.why).toMatch(/could not read its own note of the agents it ran/)
    expect(seen()).toBeNull()
    expect(existsSync(path.join(dir, 'agent-runs.json'))).toBe(true)
  })
})
