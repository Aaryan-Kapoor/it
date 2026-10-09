// Adding a display and adding a machine, in a stand-in browser with a stand-in backend. What
// they must get right: the address given is one another device can really open, which on the
// machine It runs on is the one the service told the backend and never `localhost`; while the
// network is off the person is told how to turn it on, and the address appears by itself when
// it is; and a code that has run out is taken down.
import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const CODE = 'abcdefghij0123456789'
const LAN = 'http://192.168.1.20:4700'
const WIRE = 'http://192.168.1.31:4700'
const SIX = 'http://[fd7a:115c:a1e0::ab12:4843]:4700'

const calls: string[] = []
/** What each was asked with, in the same order. */
const asked: unknown[] = []
/** What the stand-in backend answers, by function. */
const answers: Record<string, () => unknown> = {}
/** What the queries the site watches say, by function. */
let watched: Record<string, unknown>
const ask = async (fn: unknown, args?: unknown) => {
  const name = getFunctionName(fn as never)
  calls.push(name)
  asked.push(args)
  return answers[name]?.() ?? null
}
const client = { mutation: vi.fn(ask), query: vi.fn(ask), action: vi.fn(ask) }
vi.mock('convex/react', () => ({
  useConvex: () => client,
  useMutation: (fn: unknown) => (args: unknown) => client.mutation(fn, args),
  useQuery: (fn: unknown) => watched[getFunctionName(fn as never)],
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The stand-in browser itself, for giving the site another address to have been reached by. */
const browser = (globalThis as unknown as { jsdom: { reconfigure(to: { url: string }): void } }).jsdom
const HOME = location.href
let root: Root
let host: HTMLElement
let shown: React.ReactElement
const show = async (what: React.ReactElement) => {
  shown = what
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root.render(what))
}
/** What the backend says of the network changes, as it does under a browser that is watching. */
const networkIs = async (said: { on: boolean; addresses: string[] } | undefined) => {
  watched['network:get'] = said
  // Shown again as the same thing, so that everything it remembers is kept
  await act(async () => root.render(createElement(shown.type, shown.props as object)))
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)
const press = (label: string) => act(async () => button(label)!.click())
const choose = (address: string) =>
  act(async () => {
    const select = host.querySelector('select')!
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, address)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
const text = (selector: string) => host.querySelector(selector)?.textContent ?? null

beforeEach(() => {
  calls.length = 0
  asked.length = 0
  for (const name of Object.keys(answers)) delete answers[name]
  answers['sessions:inviteScreen'] = () => ({ code: CODE, expiresAt: Date.now() + 600_000 })
  answers['sessions:inviteMachine'] = () => ({ code: CODE, expiresAt: Date.now() + 600_000 })
  watched = { 'displays:list': [], 'machines:list': [], 'network:get': { on: false, addresses: [] } }
  localStorage.clear()
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  browser.reconfigure({ url: HOME })
})

describe('adding a display, in the browser on the machine It runs on', () => {
  const displays = async () => {
    const { Displays } = await import('./settings')
    await show(createElement(Displays, { thisDisplay: 'display-1' }))
  }

  test('with the network on, the owner is given the machine’s address on the network to open on the other screen, a QR code of it, and the code in letters', async () => {
    watched['network:get'] = { on: true, addresses: [LAN] }
    await displays()
    // Nothing is asked of the backend until the person asks for it
    expect(calls).toEqual([])
    expect(host.querySelector('.qr')).toBeNull()
    await press('Add a display')
    expect(calls).toEqual(['sessions:inviteScreen'])
    expect(text('.pair-address')).toBe(`${LAN}/pair#${CODE}`)
    expect(host.querySelector('.qr path')!.getAttribute('d')).toMatch(/^(M\d+ \d+h1v1h-1z)+$/)
    expect(text('.pair-code')).toBe('abcd efgh ij01 2345 6789')
    expect(host.textContent).toContain(`Or open ${LAN} and type`)
    expect(host.textContent).toContain('One screen, once, for ten minutes.')
    // Nothing of the name this browser reached the site by, which opens nothing on another screen
    expect(host.querySelector('.pairing')!.textContent).not.toContain('localhost')
    // With one address there is nothing to choose
    expect(host.querySelector('select')).toBeNull()
  })

  test('with the network off, it says to run `it network on` and gives no address, and the address appears by itself once the network is on', async () => {
    await displays()
    await press('Add a display')
    expect(host.querySelector('.pair-address')).toBeNull()
    expect(host.querySelector('.qr')).toBeNull()
    expect(host.textContent).toContain('It answers only its own machine for now. Turn the network on there:')
    expect(text('.copyable-text')).toBe('it network on')
    // A second browser on the same machine can be paired with the code meanwhile
    expect(host.textContent).toContain('A browser on this machine can use http://localhost:3000 with')
    expect(text('.pair-code')).toBe('abcd efgh ij01 2345 6789')
    // `it network on` is run: the service tells the backend, and the panel changes under the person's eyes, with the same code
    await networkIs({ on: true, addresses: [LAN] })
    expect(text('.pair-address')).toBe(`${LAN}/pair#${CODE}`)
    expect(host.querySelector('.qr')).not.toBeNull()
    expect(host.textContent).not.toContain('it network on')
    expect(calls).toEqual(['sessions:inviteScreen'])
    // And back, when it is turned off again
    await networkIs({ on: false, addresses: [] })
    expect(host.querySelector('.pair-address')).toBeNull()
    expect(text('.copyable-text')).toBe('it network on')
  })

  test('with several addresses, the one most likely to work is shown first and the others can be chosen, each with a QR code of its own', async () => {
    watched['network:get'] = { on: true, addresses: [LAN, WIRE, SIX] }
    await displays()
    await press('Add a display')
    expect(text('.pair-address')).toBe(`${LAN}/pair#${CODE}`)
    const first = host.querySelector('.qr path')!.getAttribute('d')
    expect([...host.querySelectorAll('option')].map((o) => o.textContent)).toEqual([LAN, WIRE, SIX])
    expect(host.textContent).toContain('Cannot open it? Try another address')
    await choose(SIX)
    expect(text('.pair-address')).toBe(`${SIX}/pair#${CODE}`)
    expect(host.querySelector('.qr path')!.getAttribute('d')).not.toBe(first)
    expect(host.textContent).toContain(`Or open ${SIX} and type`)
    // An address that has stopped being the machine's is not kept to: the first of those it has now is shown
    await networkIs({ on: true, addresses: [WIRE] })
    expect(text('.pair-address')).toBe(`${WIRE}/pair#${CODE}`)
    expect(host.querySelector('select')).toBeNull()
  })

  test('with the network on and the machine on no network, it says that, and until the backend has said anything it says nothing of the network', async () => {
    watched['network:get'] = undefined
    await displays()
    await press('Add a display')
    expect(host.querySelector('.pair-address')).toBeNull()
    expect(host.textContent).not.toContain('it network on')
    expect(host.textContent).not.toContain('no address')
    expect(text('.pair-code')).toBe('abcd efgh ij01 2345 6789')
    await networkIs({ on: true, addresses: [] })
    expect(host.textContent).toContain('The network is on, but the machine It runs on has no address on a network just now.')
    expect(host.textContent).not.toContain('it network on')
    expect(host.querySelector('.pair-address')).toBeNull()
  })

  test('a code that has run out is taken down, and another can be made', async () => {
    vi.useFakeTimers()
    watched['network:get'] = { on: true, addresses: [LAN] }
    answers['sessions:inviteScreen'] = () => ({ code: CODE, expiresAt: Date.now() + 20_000 })
    await displays()
    await press('Add a display')
    expect(host.querySelector('.pair-code')).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(host.querySelector('.pair-code')).toBeNull()
    expect(host.querySelector('.pair-address')).toBeNull()
    expect(host.textContent).toContain('That code has run out.')
    expect(button('Add a display')).toBeDefined()
  })

  test('when the backend will not make a code, what it said is shown and nothing else is', async () => {
    const { ConvexError } = await import('convex/values')
    answers['sessions:inviteScreen'] = () => Promise.reject(new ConvexError({ code: 'rate_limited', message: 'Too many at once. Try again in a moment.' }))
    await displays()
    await press('Add a display')
    expect(text('[role="alert"]')).toBe('Too many at once. Try again in a moment.')
    expect(host.querySelector('.pair-code')).toBeNull()
  })
})

describe('adding a display, in an owner’s browser that reached the site over the network', () => {
  test('the address this browser itself reached the site by is given first, since it is known to work, with the service’s others to choose from', async () => {
    browser.reconfigure({ url: 'http://192.168.1.31:4700/displays' })
    watched['network:get'] = { on: true, addresses: [LAN, WIRE, SIX] }
    const { Displays } = await import('./settings')
    await show(createElement(Displays, { thisDisplay: 'display-1' }))
    await press('Add a display')
    expect(text('.pair-address')).toBe(`${WIRE}/pair#${CODE}`)
    expect([...host.querySelectorAll('option')].map((o) => o.textContent)).toEqual([WIRE, LAN, SIX])
    // It is given whatever the backend has or has not said yet
    await networkIs(undefined)
    expect(text('.pair-address')).toBe(`${WIRE}/pair#${CODE}`)
  })
})

describe('what is said of an agent app on a machine', () => {
  const machine = (seen: number, harnesses: unknown[], wanted: string[], wakes: string[] = []) => ({
    id: 'machine-1',
    name: 'the desk',
    lastSeenAt: seen,
    connectorVersion: '0.1.0',
    system: 'linux',
    harnesses,
    wanted,
    wakes: wakes.map((harness) => ({ harness, since: seen })),
  })
  const notes = () => [...host.querySelectorAll('.check-note')].map((note) => note.textContent)

  test('an installed add-on is said to be connected, and to be offline while its machine is not heard from', async () => {
    const connected = [{ id: 'claude-code', version: '2.1.0', addon: 'connected' }]
    watched['machines:list'] = [machine(Date.now(), connected, ['claude-code'])]
    const { Machines } = await import('./machines')
    await show(createElement(Machines))
    expect(notes()).toEqual(['Connected'])
    await act(async () => root.unmount())
    host.remove()
    // The same machine, last heard from an hour ago
    watched['machines:list'] = [machine(Date.now() - 3_600_000, connected, ['claude-code'])]
    await show(createElement(Machines))
    // Its add-on is installed, and nothing is handed to a conversation there until the machine is online
    expect(notes()).toEqual(['Connected, offline'])
  })

  test('a machine is online while it goes on saying so, off once it has been quiet for a minute and a half or its connector has said it was stopping, and the one It runs on is marked', async () => {
    const connected = [{ id: 'claude-code', version: '2.1.0', addon: 'connected' }]
    const said = () => [...host.querySelectorAll('header .status')].map((x) => x.textContent)
    const { Machines } = await import('./machines')
    // Heard from a minute ago, and one that joined, of the same name
    watched['machines:list'] = [
      { ...machine(Date.now() - 60_000, connected, ['claude-code']), runsIt: true },
      { ...machine(Date.now() - 60_000, connected, ['claude-code']), id: 'machine-2', runsIt: false },
    ]
    await show(createElement(Machines))
    expect(said()).toEqual(['Online', 'It runs on this machine', 'Online'])
    expect(notes()).toEqual(['Connected', 'Connected'])
    await act(async () => root.unmount())
    host.remove()
    // Quiet for longer than three of the times it says it is alive
    watched['machines:list'] = [machine(Date.now() - 101_000, connected, ['claude-code'])]
    await show(createElement(Machines))
    expect(said()).toEqual(['Last seen 2 min ago'])
    expect(notes()).toEqual(['Connected, offline'])
    await act(async () => root.unmount())
    host.remove()
    // Heard from a moment ago, and then its connector said it was stopping
    watched['machines:list'] = [{ ...machine(Date.now() - 5000, connected, ['claude-code']), off: true }]
    await show(createElement(Machines))
    expect(said()).toEqual(['Last seen just now'])
    expect(notes()).toEqual(['Connected, offline'])
  })

  test('a newer It that a machine has learned is out is said under its name, with the button that has the machine put it in place, the machine It runs on first', async () => {
    const said = () => [...host.querySelectorAll('p.newer')].map((x) => x.textContent)
    const { Machines } = await import('./machines')
    const desk = { ...machine(Date.now(), [], []), runsIt: true }
    const laptop = { ...machine(Date.now(), [], []), id: 'machine-2', name: 'the laptop', runsIt: false }
    let shown = false
    const showing = async (list: object[]) => {
      if (shown) {
        await act(async () => root.unmount())
        host.remove()
      }
      shown = true
      watched['machines:list'] = list
      await show(createElement(Machines))
    }
    // None has learned of a newer one, or the one it knows of is the one it runs: nothing is said
    await showing([desk, { ...laptop, latest: '0.1.0' }, { ...laptop, id: 'machine-3', latest: '' }])
    expect(said()).toEqual([])
    // Both have: the one It runs on is offered it, and the other is told to wait for that one
    await showing([
      { ...desk, latest: '0.1.1' },
      { ...laptop, latest: '0.1.1' },
    ])
    expect(said()).toEqual([
      'It 0.1.1 is out. This machine runs 0.1.0. Update',
      'It 0.1.1 is out. This machine runs 0.1.0. Update the machine It runs on first.',
    ])
    await act(async () => host.querySelector<HTMLButtonElement>('p.newer button')!.click())
    expect([calls, asked]).toEqual([['machines:upgrade'], [{ machineId: 'machine-1' }]])
    // Asked for and at work, then failed with why and offered again, then done by the machine It runs on, after which the other is offered it
    await showing([{ ...desk, latest: '0.1.1', upgrade: { at: Date.now(), state: 'working' } }])
    expect(said()).toEqual(['Updating to It 0.1.1…'])
    // One that has said nothing more for longer than an upgrade takes was cut short: said so, and offered again
    await showing([{ ...desk, latest: '0.1.1', upgrade: { at: Date.now() - 16 * 60_000, state: 'working' } }])
    expect(said()).toEqual(['The update to It 0.1.1 did not finish. This machine still runs 0.1.0. Try again'])
    await showing([{ ...desk, latest: '0.1.1', upgrade: { at: 1, state: 'failed', why: 'The newest release of It could not be fetched (it-linux-x64).' } }])
    expect(said()).toEqual(['The update to It 0.1.1 did not finish: The newest release of It could not be fetched (it-linux-x64). Try again'])
    await showing([
      { ...desk, connectorVersion: '0.1.1', latest: '0.1.1' },
      { ...laptop, latest: '0.1.1' },
    ])
    expect(said()).toEqual(['It 0.1.1 is out. This machine runs 0.1.0. Update'])
    // A machine that is off cannot be asked now
    await showing([
      { ...desk, connectorVersion: '0.1.1' },
      { ...laptop, latest: '0.1.1', off: true },
    ])
    expect(host.querySelector<HTMLButtonElement>('p.newer button')!.disabled).toBe(true)
    // Where It was started by hand, the program is in place and the person starts It again
    await showing([
      { ...desk, connectorVersion: '0.1.1' },
      { ...laptop, latest: '0.1.1', upgrade: { at: 1, state: 'installed', version: '0.1.1' } },
    ])
    expect(said()).toEqual(['It 0.1.1 is installed on the laptop. It runs once It is started again there: stop it serve where it is running, and start it.'])
  })

  test('each connected app It can reopen a closed conversation of has a switch for that, off until the owner turns it on, and no other app has one', async () => {
    const found = [
      { id: 'claude-code', version: '2.1.0', addon: 'connected' },
      { id: 'codex', version: '0.160.0', addon: 'connected' },
      { id: 'openclaw', addon: 'unavailable' },
    ]
    const switches = () => [...host.querySelectorAll<HTMLInputElement>('.wake-row input')].map((input) => [input.getAttribute('aria-label'), input.checked])
    watched['machines:list'] = [machine(Date.now(), found, ['claude-code', 'codex'])]
    const { Machines } = await import('./machines')
    await show(createElement(Machines))
    expect(switches()).toEqual([
      ['Auto-wake Claude Code', false],
      ['Auto-wake Codex', false],
    ])
    await act(async () => host.querySelector<HTMLInputElement>('.wake-row input')!.click())
    expect(calls).toEqual(['machines:wake'])
    expect(asked).toEqual([{ machineId: 'machine-1', harness: 'claude-code', on: true }])
    await act(async () => root.unmount())
    host.remove()
    // As the backend then says it is, and turned off the same way
    watched['machines:list'] = [machine(Date.now(), found, ['claude-code', 'codex'], ['claude-code'])]
    await show(createElement(Machines))
    expect(switches()).toEqual([
      ['Auto-wake Claude Code', true],
      ['Auto-wake Codex', false],
    ])
    await act(async () => host.querySelector<HTMLInputElement>('.wake-row input')!.click())
    expect(asked.at(-1)).toEqual({ machineId: 'machine-1', harness: 'claude-code', on: false })
    await act(async () => root.unmount())
    host.remove()
    // An app that is not connected has nothing to reopen
    watched['machines:list'] = [machine(Date.now(), [{ id: 'claude-code', version: '2.1.0', addon: 'not_connected' }], [])]
    await show(createElement(Machines))
    expect(switches()).toEqual([])
    await act(async () => root.unmount())
    host.remove()
    // On a machine that runs Windows the switch is not there, and why is said in its place
    watched['machines:list'] = [{ ...machine(Date.now(), found, ['claude-code', 'codex']), system: 'win32' }]
    await show(createElement(Machines))
    expect(switches()).toEqual([])
    expect(host.textContent).toContain('It does not reopen closed conversations on a Windows machine yet.')
  })
})

describe('revoking a machine', () => {
  test('the owner is asked first, and told how a machine that joined is used again: by leaving and being added again', async () => {
    const asked: string[] = []
    vi.stubGlobal('confirm', (words: string) => {
      asked.push(words)
      return asked.length > 1
    })
    watched['machines:list'] = [{ id: 'machine-1', name: 'the desk', lastSeenAt: Date.now(), connectorVersion: '0.1.0', harnesses: [], wanted: [], wakes: [] }]
    const { Machines } = await import('./machines')
    await show(createElement(Machines))
    await press('Revoke')
    expect(asked).toEqual([
      'Revoke “the desk”? Its agents can ask nothing more of It from this moment, though an upload already begun may still finish. To use it again, run it logout on it and add it again with “Add a machine”.',
    ])
    // Not confirmed, nothing is asked of the backend
    expect(calls).toEqual([])
    await press('Revoke')
    expect(calls).toEqual(['machines:revoke'])
  })
})

describe('adding a machine', () => {
  const machines = async () => {
    const { Machines } = await import('./machines')
    await show(createElement(Machines))
  }

  test('with the network on, the owner is given one line to run on the other computer that installs It there and joins, and under it the joining alone, each with the machine’s address on the network and a code that works once', async () => {
    watched['network:get'] = { on: true, addresses: [LAN, SIX] }
    await machines()
    expect(calls).toEqual([])
    await press('Add a machine')
    expect(calls).toEqual(['sessions:inviteMachine'])
    // First the line that installs and joins: It installed by itself at a terminal is set up there, and a computer with an It of its own cannot join
    expect(host.querySelector('.pairing .modal-lede')!.textContent).toBe('Run this on the other computer. It installs It there and joins it to this one.')
    expect(text('.pair-command.install code')).toBe(`curl -fsSL https://itcan.do/install.sh | sh -s -- login --url ${LAN} --code ${CODE}`)
    // Then the joining alone, which is pasted where the install asks, as on Windows, and run by a computer that has the command already
    expect(host.querySelector('.pairing p.modal-sub')!.textContent).toBe(
      'On Windows, install It with irm https://itcan.do/install.ps1 | iex. When it asks where your It is, choose “On another computer of mine” and paste the line below. That line is also all that a computer needs that has the it command already.',
    )
    expect(text('.pair-command.join code')).toBe(`it login --url ${LAN} --code ${CODE}`)
    expect([...host.querySelectorAll('.pair-command')]).toHaveLength(2)
    expect(host.textContent).toContain('One machine, once, for ten minutes.')
    expect(host.querySelector('.pairing')!.textContent).not.toContain('localhost')
    // Another of the machine's addresses can be chosen, and one under IPv6 is written so that a shell reads it as one word, in both
    await choose(SIX)
    expect(text('.pair-command.install code')).toBe(`curl -fsSL https://itcan.do/install.sh | sh -s -- login --url "${SIX}" --code ${CODE}`)
    expect(text('.pair-command.join code')).toBe(`it login --url "${SIX}" --code ${CODE}`)
  })

  test('with the network off, it says to run `it network on` first, since another computer cannot reach It, and the command appears once it is on', async () => {
    await machines()
    await press('Add a machine')
    expect(host.querySelector('.pair-command')).toBeNull()
    expect(text('.pairing .copyable-text')).toBe('it network on')
    await networkIs({ on: true, addresses: [LAN] })
    expect(text('.pair-command.join code')).toBe(`it login --url ${LAN} --code ${CODE}`)
    expect(calls).toEqual(['sessions:inviteMachine'])
  })

  test('a code that has run out is taken down, and what the backend refused is said', async () => {
    vi.useFakeTimers()
    watched['network:get'] = { on: true, addresses: [LAN] }
    answers['sessions:inviteMachine'] = () => ({ code: CODE, expiresAt: Date.now() + 20_000 })
    await machines()
    await press('Add a machine')
    expect(host.querySelector('.pair-command')).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(host.querySelector('.pair-command')).toBeNull()
    expect(host.textContent).toContain('That code has run out.')
    const { ConvexError } = await import('convex/values')
    answers['sessions:inviteMachine'] = () => Promise.reject(new ConvexError({ code: 'rate_limited', message: 'Too many at once. Try again in a moment.' }))
    await press('Make another')
    expect(text('[role="alert"]')).toBe('Too many at once. Try again in a moment.')
  })
})
