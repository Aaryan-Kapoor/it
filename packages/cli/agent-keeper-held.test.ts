// The keeper of project agents where the system will not say for certain that what an agent's
// program started has ended, which a machine with processes it may not look into gives: an agent
// whose own program has gone may be started again, and the rest is looked at again later, while
// one whose own program is still there has no other started beside it.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CLAUDE } from './stand-in-agents'

const held = vi.hoisted(() => ({ pids: new Set<number>() }))
vi.mock('./src/wake', async (original) => {
  const real = await original<typeof import('./src/wake')>()
  return {
    ...real,
    // Nothing can be told for certain to have ended
    endTree: async (pid: number, since: string, of: unknown) => {
      await real.endTree(pid, since, of as never)
      return 'unknown' as const
    },
    // And the processes the test holds are there, as they were noted
    processes: (pids: number[]) => {
      const found = real.processes(pids)
      for (const pid of pids) if (held.pids.has(pid)) found?.set(pid, 'tick 1')
      return found
    },
  }
})

import { AgentKeeper, type KeeperDeps } from './src/agent-keeper'

let dir: string
const keepers: AgentKeeper[] = []
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-held-')))
  mkdirSync(path.join(dir, 'garden'))
  writeFileSync(path.join(dir, 'claude.js'), CLAUDE)
  chmodSync(path.join(dir, 'claude.js'), 0o755)
  writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ on: true, most: 2, projects: [{ id: 'p-one', path: path.join(dir, 'garden') }] }))
  held.pids.clear()
})
afterEach(async () => {
  for (const k of keepers.splice(0)) await k.close()
  rmSync(dir, { recursive: true, force: true })
})

function world() {
  const reports: { state: string; why?: string; round: number }[] = []
  const deps: KeeperDeps = {
    offer: async () => {},
    report: async (r) => {
      reports.push(r)
      return { gone: false }
    },
    taken: async () => {},
    clicks: async () => [],
    ack: async () => {},
    connected: () => true,
    env: async () => ({ ...process.env, SEEN: path.join(dir, 'seen.json') }),
    say: () => {},
    itHome: dir,
    itAt: [],
    commandFor: () => [process.execPath, path.join(dir, 'claude.js')],
    settingsFile: path.join(dir, 'agents.json'),
    runsFile: path.join(dir, 'agent-runs.json'),
    everyMs: 50,
  }
  return { reports, deps }
}
const agent = {
  id: 'agent-000001',
  project: 'p-one',
  app: 'claude-code',
  want: 'run' as const,
  round: 1,
  state: 'resting',
  session: '3f0c3c55-1d4b-4a8e-9b1a-2a8a1c1c0b11',
  messages: [],
}
async function until(done: () => boolean): Promise<void> {
  const end = Date.now() + 8000
  while (!done()) {
    if (Date.now() > end) throw new Error('it did not happen in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const notes = () => JSON.parse(readFileSync(path.join(dir, 'agent-runs.json'), 'utf8'))
const note = (pid: number) => ({ pid, since: 'tick 1', told: 3, run: 'agent-old', app: 'claude-code', session: agent.session })

describe.skipIf(process.platform === 'win32')('the keeper, where what an agent started cannot be told to have ended', () => {
  test('starts the agent again once its own program has gone, and looks at the rest again later', async () => {
    // A program from before whose number nobody has now
    writeFileSync(path.join(dir, 'agent-runs.json'), JSON.stringify({ runs: { 'agent-000001': note(999_999_999) }, cutOff: [] }))
    const w = world()
    const k = new AgentKeeper(w.deps)
    keepers.push(k)
    k.update([{ ...agent, messages: [{ id: 'm1', text: 'go on' }] }])
    await k.begin()
    await until(() => w.reports.some((r) => r.state === 'ready'))
    expect(notes().left).toEqual([note(999_999_999)])
  })

  test('starts no program beside one of the agent’s that is still there, and says which', async () => {
    held.pids.add(424_242)
    writeFileSync(path.join(dir, 'agent-runs.json'), JSON.stringify({ runs: { 'agent-000001': note(424_242) }, cutOff: [] }))
    const w = world()
    const k = new AgentKeeper(w.deps)
    keepers.push(k)
    k.update([{ ...agent, messages: [{ id: 'm1', text: 'go on' }] }])
    await k.begin()
    await until(() => w.reports.some((r) => r.state === 'failed'))
    expect(w.reports.at(-1)!.why).toMatch(/process 424242\) is still running and could not be ended/)
    expect(notes().runs['agent-000001']).toEqual(note(424_242))
    // Once it has gone, the agent can be started again
    held.pids.clear()
    k.update([{ ...agent, round: 2, state: 'starting' }])
    await until(() => w.reports.some((r) => r.round === 2 && r.state === 'ready'))
  })
})
