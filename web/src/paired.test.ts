// The paired browsers the owner is shown and ends, and what revoking a machine says it takes
// along, in a stand-in browser with a stand-in backend.
import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const calls: { fn: string; args: any }[] = []
/** What the stand-in backend answers, by function, and what the queries the site watches say. */
const answers: Record<string, (args: any) => unknown> = {}
let watched: Record<string, unknown>
const ask = async (fn: unknown, args: unknown) => {
  const name = getFunctionName(fn as never)
  calls.push({ fn: name, args })
  return answers[name]?.(args) ?? null
}
vi.mock('convex/react', () => ({
  useMutation: (fn: unknown) => (args: unknown) => ask(fn, args),
  useQuery: (fn: unknown) => watched[getFunctionName(fn as never)],
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.now()
const HOUR = 3_600_000
const SESSIONS = [
  {
    id: 'session-1',
    role: 'owner',
    pairedAt: NOW - 50 * HOUR,
    lastSeenAt: NOW,
    mine: true,
    displays: [{ id: 'display-1', name: 'Laptop' }],
    invitedBy: { kind: 'machine', name: 'the laptop' },
    along: { browsers: ['session-2'], machines: [] },
  },
  {
    id: 'session-2',
    role: 'screen',
    pairedAt: NOW - 30 * HOUR,
    lastSeenAt: NOW - 5 * HOUR,
    mine: false,
    displays: [
      { id: 'display-2', name: 'Kitchen TV' },
      { id: 'display-3', name: 'Safari on iPad' },
    ],
    invitedBy: { kind: 'browser', paired: true, name: 'Laptop' },
    along: { browsers: [], machines: [] },
  },
  {
    id: 'session-3',
    role: 'owner',
    pairedAt: NOW - 2 * HOUR,
    lastSeenAt: NOW - 2 * HOUR,
    mine: false,
    displays: [],
    invitedBy: { kind: 'machine', name: 'the server' },
    along: { browsers: [], machines: [] },
  },
]

let root: Root
let host: HTMLElement
/** What the person was asked to confirm, and what they answer. */
let asked: string[]
let agree: boolean
const show = async (what: React.ReactElement) => {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root.render(what))
}
const rows = () => [...host.querySelectorAll('li')]
const button = (label: string, within: Element = host) =>
  [...within.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined
const press = (b: HTMLButtonElement | undefined) => act(async () => b!.click())

beforeEach(() => {
  calls.length = 0
  for (const name of Object.keys(answers)) delete answers[name]
  watched = { 'sessions:list': SESSIONS }
  asked = []
  agree = true
  vi.stubGlobal('confirm', (text: string) => {
    asked.push(text)
    return agree
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('the paired browsers on the Displays page', () => {
  test('every paired browser is shown, with the displays it is or that it is none, what it may do, and what let it in', async () => {
    const { PairedBrowsers } = await import('./paired')
    await show(createElement(PairedBrowsers))
    expect(rows().map((li) => li.querySelector('.row-name')!.textContent)).toEqual([
      'LaptopThis browserYours',
      'Kitchen TV, Safari on iPadScreen',
      'No displayYours',
    ])
    const said = rows().map((li) => li.querySelector('.row-sub')!.textContent)
    expect(said[0]).toContain('Paired 2 d ago with a code the machine “the laptop” asked for')
    expect(said[1]).toContain('with a code the browser “Laptop” asked for')
    expect(said[1]).toContain('Last used 5 h ago')
    // The one that is no display is there with the rest, and says which machine made it
    expect(said[2]).toContain('with a code the machine “the server” asked for')
    expect(rows().map((li) => [...li.querySelectorAll('button')].map((b) => b.textContent))).toEqual([['End'], ['End'], ['End']])
  })

  test('a browser that came of a browser which is no display, or whose pairing has ended since, is said to', async () => {
    watched = {
      'sessions:list': [
        SESSIONS[0],
        { ...SESSIONS[1]!, invitedBy: { kind: 'browser', paired: true, name: null } },
        { ...SESSIONS[2]!, invitedBy: { kind: 'browser', paired: false, name: null } },
      ],
    }
    const { PairedBrowsers } = await import('./paired')
    await show(createElement(PairedBrowsers))
    const said = rows().map((li) => li.querySelector('.row-sub')!.textContent)
    expect(said[1]).toContain('Paired 1 d ago with a code a paired browser asked for')
    expect(said[2]).toContain('Paired 2 h ago with a code asked for by a browser whose pairing has ended since')
  })

  test('ending one is asked of the backend for that session, once the person has confirmed', async () => {
    const { PairedBrowsers } = await import('./paired')
    await show(createElement(PairedBrowsers))
    agree = false
    await press(button('End', rows()[2]))
    expect(calls).toEqual([])
    agree = true
    await press(button('End', rows()[2]))
    expect(calls).toEqual([{ fn: 'sessions:end', args: { session: 'session-3' } }])
    // Nothing came from that one, and nothing is said to go with it
    expect(asked[1]).toBe(
      'End this paired browser? It is signed out at once, and pages open on it stop working. It has to be paired again before it can be used.',
    )
    // Ending the browser the person is at says that it is this one, and that the screen it paired goes with it
    await press(button('End', rows()[0]))
    expect(asked[2]).toBe(
      'End this browser’s pairing? This browser is signed out, and has to be paired again before it can be used. 1 paired browser came from it, and is ended with it.',
    )
    expect(calls[1]).toEqual({ fn: 'sessions:end', args: { session: 'session-1' } })
  })

  test('before an ending is confirmed, the person is told how many paired browsers and machines go with it, and when this browser is one of them', async () => {
    // The server's browser added a machine, and the browser being read on was paired from that machine
    watched = {
      'sessions:list': [
        { ...SESSIONS[0]!, along: { browsers: [], machines: [] } },
        SESSIONS[1],
        { ...SESSIONS[2]!, along: { browsers: ['session-1', 'session-4'], machines: ['machine-2', 'machine-3'] } },
      ],
    }
    const { PairedBrowsers } = await import('./paired')
    await show(createElement(PairedBrowsers))
    await press(button('End', rows()[2]))
    expect(asked[0]).toBe(
      'End this paired browser? It is signed out at once, and pages open on it stop working. It has to be paired again before it can be used. 2 paired browsers and 2 machines came from it, and are ended with it. This browser is one of them.',
    )
    await press(button('End all others'))
    expect(asked[1]).toBe(
      'End all others? The 2 paired browsers besides this one are signed out at once, and each has to be paired again before it can be used. 2 machines that came from them are ended with them. This browser came from one of them, and stays paired.',
    )
  })

  test('“End all others” ends every one but the browser it is pressed in, and is offered only when there are others', async () => {
    const { PairedBrowsers } = await import('./paired')
    await show(createElement(PairedBrowsers))
    answers['sessions:endOthers'] = () => ({ ended: 2 })
    await press(button('End all others'))
    expect(asked[0]).toBe(
      'End all others? The 2 paired browsers besides this one are signed out at once, and each has to be paired again before it can be used.',
    )
    expect(calls).toEqual([{ fn: 'sessions:endOthers', args: {} }])
    await act(async () => root.unmount())
    host.remove()
    watched = { 'sessions:list': [SESSIONS[0]] }
    await show(createElement(PairedBrowsers))
    expect(button('End all others')!.disabled).toBe(true)
  })

  test('what the backend refuses is said where it was asked', async () => {
    const { ConvexError } = await import('convex/values')
    answers['sessions:end'] = () => Promise.reject(new ConvexError({ code: 'not_found', message: 'No such paired browser.' }))
    const { PairedBrowsers } = await import('./paired')
    await show(createElement(PairedBrowsers))
    await press(button('End', rows()[1]))
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('No such paired browser.')
  })
})

describe('revoking a machine', () => {
  const MACHINE = { id: 'machine-2', name: 'the server', runsIt: false, descendants: { browsers: 0, mine: false, machines: 0 } }
  const revoking = async (m: typeof MACHINE) => {
    const { RevokeMachine } = await import('./paired')
    const act = vi.fn(async (p: Promise<unknown>) => void (await p))
    await show(createElement(RevokeMachine, { m, act }))
    await press(button('Revoke'))
    return asked[0]!
  }

  test('before the person confirms, they are told how many paired browsers and machines go with it', async () => {
    const said = await revoking({ ...MACHINE, descendants: { browsers: 3, mine: false, machines: 1 } })
    expect(said).toContain('Revoke “the server”?')
    expect(said).toContain('3 paired browsers and 1 machine came from it, and are ended with it.')
    expect(said).toContain('run it logout on it and add it again with “Add a machine”')
    expect(calls).toEqual([{ fn: 'machines:revoke', args: { machineId: 'machine-2' } }])
  })

  test('a machine nothing came from is said to take nothing along, and one that takes this browser says so', async () => {
    expect(await revoking(MACHINE)).not.toContain('ended with it')
    await act(async () => root.unmount())
    host.remove()
    asked = []
    const said = await revoking({ ...MACHINE, descendants: { browsers: 1, mine: true, machines: 0 } })
    expect(said).toContain('1 paired browser came from it, and is ended with it.')
    expect(said).toContain('This browser is that one')
  })

  test('on the machine It runs on, that is every browser, and the person is told how to pair one again', async () => {
    const said = await revoking({ id: 'machine-1', name: 'the laptop', runsIt: true, descendants: { browsers: 4, mine: true, machines: 2 } })
    expect(said).toContain('4 paired browsers and 2 machines came from it, and are ended with it.')
    expect(said).toContain('This is the machine It runs on, so that is every browser you have paired, this one too.')
    expect(said).toContain('run it setup on that machine, which enrols it anew and gives it back the pages it made, and then it site')
  })

  test('nothing is asked of the backend when the person does not confirm', async () => {
    agree = false
    await revoking(MACHINE)
    expect(calls).toEqual([])
  })
})
