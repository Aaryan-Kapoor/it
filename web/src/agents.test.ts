// The Agents page, an experiment, in a stand-in browser with a stand-in backend: what it says
// where no machine offers project agents, starting one in a folder a machine offers, and what
// each agent shows and lets the person do as it stands.
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const calls: { fn: string; args: any }[] = []
const answers: Record<string, (args: any) => unknown> = {}
let watched: Record<string, unknown>
const ask = async (fn: unknown, args: unknown) => {
  const name = getFunctionName(fn as never)
  calls.push({ fn: name, args })
  return answers[name]?.(args) ?? null
}
vi.mock('convex/react', () => ({
  useMutation: (fn: unknown) => (args: unknown) => ask(fn, args),
  useQuery: (fn: unknown, args: unknown) => (args === 'skip' ? undefined : watched[getFunctionName(fn as never)]),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { Agents, agentsShown } from './agents'

const NOW = Date.now()
const laptop = { name: 'laptop', lastSeenAt: NOW, off: false, connectorVersion: '0.9.0' }
const OFFERING = {
  id: 'machine-1',
  ...laptop,
  most: 3,
  projects: [
    { id: 'p-one', name: 'garden', where: '~/code/garden' },
    { id: 'p-two', name: 'shed', where: '~/code/shed' },
  ],
  apps: ['claude-code', 'codex'],
}
const SESSION = '3f0c3c55-1d4b-4a8e-9b1a-2a8a1c1c0b11'
const agent = (extra: Record<string, unknown> = {}) => ({
  id: 'agent-1',
  machineId: 'machine-1',
  project: 'p-one',
  name: 'garden',
  where: '~/code/garden',
  app: 'claude-code',
  want: 'run',
  state: 'ready',
  why: null,
  session: SESSION,
  said: { text: 'I watered the beds and put the plan on a page.', at: NOW - 60_000 },
  createdAt: NOW - 3_600_000,
  changedAt: NOW - 60_000,
  waiting: 0,
  machine: laptop,
  ...extra,
})

let root: Root
let host: HTMLElement
const show = async () => {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root.render(createElement(Agents)))
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined
const press = (b: HTMLButtonElement | undefined) => act(async () => b!.click())
const type = (el: HTMLTextAreaElement | HTMLSelectElement, value: string) =>
  act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
const submit = (form: HTMLFormElement) => act(async () => form.requestSubmit())

beforeEach(() => {
  calls.length = 0
  for (const name of Object.keys(answers)) delete answers[name]
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('the Agents page', () => {
  test('has no tab until a machine offers project agents, and then says how a machine offers them where none does', async () => {
    expect(agentsShown(undefined)).toBe(false)
    expect(agentsShown({ machines: [], agents: [] })).toBe(false)
    expect(agentsShown({ machines: [OFFERING as never], agents: [] })).toBe(true)
    watched = { 'agents:list': { machines: [], agents: [] } }
    await show()
    expect(host.textContent).toContain('No machine offers project agents')
    expect([...host.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['it agents on', 'it agents add ~/code/your-project'])
  })

  test('starts an agent in a folder a machine offers, with an app connected there, and what it is to do first', async () => {
    watched = { 'agents:list': { machines: [OFFERING], agents: [] } }
    await show()
    const [, folder, app] = [...host.querySelectorAll('select')]
    expect([...folder!.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['garden (~/code/garden)', 'shed (~/code/shed)'])
    await type(folder!, 'p-two')
    await type(app!, 'codex')
    await type(host.querySelector('textarea')!, 'tidy the shed')
    await submit(host.querySelector('form')!)
    expect(calls).toEqual([{ fn: 'agents:start', args: { machineId: 'machine-1', project: 'p-two', app: 'codex', text: 'tidy the shed' } }])
    // And says why where It refuses
    answers['agents:start'] = () => {
      throw new ConvexError({ code: 'limit', message: 'laptop runs at most 3 agents at once. Stop one of them first.' })
    }
    await submit(host.querySelector('form')!)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('laptop runs at most 3 agents at once. Stop one of them first.')
  })

  test('cannot start one where the machine names no folder or has no app connected, and says what to do', async () => {
    watched = { 'agents:list': { machines: [{ ...OFFERING, projects: [], apps: [] }], agents: [] } }
    await show()
    expect(button('Start agent')!.disabled).toBe(true)
    expect(host.textContent).toContain('names no folder yet')
    expect(host.textContent).toContain('Connect Claude Code or Codex on laptop')
  })

  test('shows a running agent as it stands, with what it said, and sends it a message, restarts it and stops it', async () => {
    watched = { 'agents:list': { machines: [OFFERING], agents: [agent({ waiting: 2 })] } }
    await show()
    const card = host.querySelector('.agent-card')!
    expect(card.querySelector('.status')?.textContent).toBe('Ready')
    expect(card.textContent).toContain('I watered the beds and put the plan on a page.')
    expect(card.textContent).toContain('2 messages wait for it')
    // Opening it by hand is offered only once It is not running it
    expect(card.textContent).not.toContain('claude --resume')
    await type(card.querySelector('textarea')!, 'now the shed')
    await submit(card.querySelector('form')!)
    await press(button('Restart'))
    await press(button('Stop'))
    expect(calls).toEqual([
      { fn: 'agents:send', args: { agentId: 'agent-1', text: 'now the shed' } },
      { fn: 'agents:restart', args: { agentId: 'agent-1' } },
      { fn: 'agents:stop', args: { agentId: 'agent-1' } },
    ])
  })

  test('shows a stopped agent with the command that opens its conversation, and starts it again or removes it', async () => {
    watched = { 'agents:list': { machines: [OFFERING], agents: [agent({ want: 'stop', state: 'stopped' })] } }
    await show()
    const card = host.querySelector('.agent-card')!
    expect(card.querySelector('.status')?.textContent).toBe('Stopped')
    expect(card.querySelector('textarea')).toBeNull()
    expect(card.textContent).toContain(`cd ~/code/garden && claude --resume ${SESSION}`)
    await press(button('Start again'))
    await press(button('Remove'))
    expect(calls.map((c) => c.fn)).toEqual(['agents:restart', 'agents:forget'])
  })

  test('says why one stopped by a problem, and that one whose machine is offline waits for it', async () => {
    watched = {
      'agents:list': {
        machines: [OFFERING],
        agents: [
          agent({ state: 'failed', why: 'Claude Code ended by itself, with 1. Its last words were: Invalid API key' }),
          agent({ id: 'agent-2', app: 'codex', session: 'thread-1', machine: { ...laptop, lastSeenAt: NOW - 3_600_000 } }),
        ],
      },
    }
    await show()
    const [failed, away] = [...host.querySelectorAll('.agent-card')]
    expect(failed!.querySelector('.status')?.textContent).toBe('Stopped by a problem')
    expect(failed!.textContent).toContain('Invalid API key')
    expect(failed!.textContent).toContain('Start again')
    expect(away!.querySelector('.status')?.textContent).toBe('Waits for laptop')
  })
})
