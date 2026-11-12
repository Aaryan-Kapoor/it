// What the Machines page says of an agent app that has It's add-on turned off, in a stand-in
// browser with a stand-in backend. What it must get right: such an app is said to be turned off
// and never to be connecting, Turn back on asks the machine with nothing but the app's name, and
// what the machine answers is said beside it.
import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const NOW = Date.UTC(2026, 10, 11, 12)
type Turn = { harness: string; at: number; state: 'asked' | 'working' | 'failed' | 'done'; why?: string }
let machines: Record<string, unknown>[]
const asked: { name: string; args: unknown }[] = []
vi.mock('convex/react', () => ({
  useConvex: () => ({}),
  useMutation: (fn: unknown) => async (args: unknown) => void asked.push({ name: getFunctionName(fn as never), args }),
  useQuery: (fn: unknown) => (getFunctionName(fn as never) === 'machines:list' ? machines : undefined),
}))
// Revoking a machine, and the addresses of the network, have tests of their own
vi.mock('./paired', () => ({ RevokeMachine: () => null }))
vi.mock('./network', () => ({ useWhere: () => ({}), NoAddress: () => null, OtherAddresses: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const machine = (over: Record<string, unknown> = {}) => ({
  id: 'machine-1',
  name: 'the laptop',
  lastSeenAt: NOW,
  connectorVersion: '0.1.38',
  system: 'win32',
  reopens: true,
  paused: null,
  off: false,
  runsIt: true,
  latest: null,
  upgrade: null,
  turnOn: [] as Turn[],
  wanted: ['claude-code', 'codex', 'pi'],
  wakes: [],
  harnesses: [
    { id: 'claude-code', version: '2.1.322', addon: 'disabled', detail: 'what the machine says' },
    { id: 'codex', version: '0.167.0', addon: 'not_connected' },
    { id: 'pi', version: '0.82.0', addon: 'disabled', detail: 'what the machine says' },
  ],
  descendants: { browsers: 0, mine: false, machines: 0 },
  ...over,
})
/** The row of one agent app, by its name. */
const row = (name: string) => [...host.querySelectorAll('li.row')].find((li) => li.querySelector('.row-name')?.textContent?.startsWith(name)) as HTMLElement
const buttons = (within: HTMLElement, words: string) => [...within.querySelectorAll('button')].filter((b) => b.textContent === words)
async function shown() {
  const { Machines } = await import('./machines')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root.render(createElement(Machines)))
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  asked.length = 0
  machines = [machine()]
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('an agent app that has It’s add-on turned off', () => {
  test('is said to be turned off in that app, and not to be connecting', async () => {
    await shown()
    const claude = row('Claude Code')
    expect(claude.querySelector('.check-note')?.textContent).toBe('Turned off in Claude Code')
    expect(claude.textContent).toContain('It stays off until you turn it back on.')
    expect(claude.textContent).not.toContain('Connecting')
    // An app that is still being put in is connecting, as before
    expect(row('Codex').querySelector('.check-note')?.textContent).toBe('Connecting…')
  })

  test('has Turn back on, which asks the machine with nothing but the app’s name', async () => {
    await shown()
    const [button] = buttons(row('Claude Code'), 'Turn back on')
    expect(button).toBeDefined()
    expect(button!.disabled).toBe(false)
    await act(async () => button!.click())
    expect(asked).toEqual([{ name: 'machines:turnOn', args: { machineId: 'machine-1', harness: 'claude-code' } }])
  })

  test('in Pi says how to turn it back on there, since Pi has no command It could run for it', async () => {
    await shown()
    const pi = row('Pi')
    expect(pi.querySelector('.check-note')?.textContent).toBe('Turned off in Pi')
    expect(pi.textContent).toContain('Run pi config in a terminal there')
    expect(buttons(pi, 'Turn back on')).toEqual([])
  })

  test('says that it is being turned back on while the machine is at it, and offers nothing to press', async () => {
    machines = [machine({ turnOn: [{ harness: 'claude-code', at: NOW - 10_000, state: 'working' }] })]
    await shown()
    const claude = row('Claude Code')
    expect(claude.textContent).toContain('Turning It’s add-on back on in Claude Code…')
    expect(claude.querySelectorAll('button')).toHaveLength(0)
  })

  test('says why the machine could not turn it back on, and offers to try again', async () => {
    machines = [
      machine({
        turnOn: [
          {
            harness: 'claude-code',
            at: NOW - 10_000,
            state: 'failed',
            why: 'Claude Code refused to turn It’s add-on back on. Run `claude plugin enable it-bridge@it` in a terminal on that machine to see why.',
          },
        ],
      }),
    ]
    await shown()
    const claude = row('Claude Code')
    expect(claude.querySelector('.turn-on-why')?.textContent).toBe(
      'It could not be turned back on: Claude Code refused to turn It’s add-on back on. Run claude plugin enable it-bridge@it in a terminal on that machine to see why.',
    )
    // The command to run there is shown as code
    expect(claude.querySelector('.turn-on-why code')?.textContent).toBe('claude plugin enable it-bridge@it')
    expect(claude.querySelector('.turn-on')?.getAttribute('data-tone')).toBe('bad')
    expect(buttons(claude, 'Try again')).toHaveLength(1)
  })

  test('says that the machine never answered where it has been asked for longer than turning on takes', async () => {
    machines = [machine({ turnOn: [{ harness: 'claude-code', at: NOW - 10 * 60_000, state: 'asked' }] })]
    await shown()
    const claude = row('Claude Code')
    expect(claude.textContent).toContain('the laptop did not say whether it turned It’s add-on back on.')
    expect(buttons(claude, 'Try again')).toHaveLength(1)
  })

  test('cannot be turned back on while the machine is off', async () => {
    machines = [machine({ lastSeenAt: NOW - 60 * 60_000 })]
    await shown()
    expect(buttons(row('Claude Code'), 'Turn back on')[0]?.disabled).toBe(true)
  })

  test('that the person has not chosen on the machine is only off, with nothing to turn on', async () => {
    machines = [machine({ wanted: [] })]
    await shown()
    const claude = row('Claude Code')
    expect(claude.querySelector('.check-note')?.textContent).toBe('Off')
    expect(buttons(claude, 'Turn back on')).toEqual([])
  })
})
