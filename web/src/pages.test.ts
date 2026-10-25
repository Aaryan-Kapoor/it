// What a page's bar says of the last thing the person did, in a stand-in browser with a stand-in
// backend. What it must get right: it speaks of the click just made the moment it is made, and
// never goes on saying what became of the one before.
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Sent } from './outbox'

const NOW = Date.UTC(2026, 9, 15, 12)
const PAGE = { id: 'page-1', slug: 'plan', title: 'Plan', version: 1, agent: 'claude-code', machine: 'the laptop', machineSeenAt: NOW }
/** What the backend last said of the page's clicks, newest first. */
let recent: {
  at: number
  delivery: string
  outcome?: string | null
  route?: string | null
  handedAt?: number | null
  sequence?: number | null
  stoppedSequence?: number | null
}[]
/** The person's machines as the backend gives them to the owner's browser, with the agent apps chosen on each. */
let machines: { id: string; name?: string; wanted: string[]; harnesses?: { id: string; addon: string; version?: string }[] }[] | undefined
const inventoryAsked = vi.fn()
/** Whether there is a connection to the backend, and what was asked to be told when that changes. */
let connected: boolean
let functions: 'current' | 'retained' | undefined
const pageQueries: unknown[] = []
vi.mock('./session', () => ({ useSession: () => ({ service: functions ? { functions } : undefined }) }))
const told = new Set<() => void>()
/** What the backend answers each click with, in the order they were sent: nothing, until the test lets it. */
const answers: ((said: { actionId: string }) => void)[] = []
const client = {
  mutation: vi.fn((fn: unknown) =>
    getFunctionName(fn as never) === 'actions:replayGrant'
      ? Promise.resolve({ until: Date.now() + 6 * 86400_000 })
      : new Promise<{ actionId: string }>((resolve) => {
          answers.push(resolve)
        }),
  ),
  connectionState: () => ({ isWebSocketConnected: connected }),
  subscribeToConnectionState: (fn: () => void) => {
    told.add(fn)
    return () => void told.delete(fn)
  },
}
/** What the backend is to answer each stop with, in the order they were asked: nothing, until the test lets it. */
const stopsAsked: {
  input: { expectedRun?: string; expectedSession?: string }
  answer: (said: { stopping: boolean }) => void
  refuse: (why: unknown) => void
}[] = []
const askedToStop = (input: { expectedRun?: string; expectedSession?: string }) =>
  new Promise<{ stopping: boolean }>((answer, refuse) => void stopsAsked.push({ input, answer, refuse }))
const queries: { name: string; args: unknown }[] = []
vi.mock('convex/react', () => ({
  useConvex: () => client,
  useMutation: (fn: unknown) => (getFunctionName(fn as never) === 'artifacts:stop' ? askedToStop : async () => null),
  useQuery: (fn: unknown, args: unknown) => {
    const name = getFunctionName(fn as never)
    if (name === 'artifacts:get') pageQueries.push(args)
    queries.push({ name, args })
    if (name === 'machines:list' && args !== 'skip') inventoryAsked()
    return args === 'skip' ? undefined : { 'artifacts:get': PAGE, 'actions:forArtifact': recent, 'machines:list': machines }[name]
  },
}))
// The frame a page is shown in has tests of its own
vi.mock('./mount', () => ({ Mount: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const said = () => host.querySelector('.status')?.textContent ?? null
/** Everything the bar says beside whether the agent is working, in the order it says it. */
const allSaid = () => [...host.querySelectorAll('.status')].map((s) => s.textContent)
/** The button that stops the page's agent, where it is offered. */
const stops = () => [...host.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === 'Stop the agent')
const envelope = (id: string): Sent => ({ v: 1, clientActionId: id, name: 'approve', payload: '{"n":1}', contentVersion: 1 })
const tick = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)))
/** Longer than a stop is on its way before the bar says so. */
const aWhile = () => act(async () => new Promise<void>((r) => setTimeout(r, 800)))
async function shown(owner = true) {
  const { PageView } = await import('./pages')
  const outbox = await import('./outbox')
  outbox.outboxBelongsTo('user-1', 'session-1')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root.render(createElement(PageView, { slug: 'plan', user: 'user-1', owner })))
  return outbox
}
/** Draws the page again where it is, as it is drawn when the backend has something new to say of it. */
async function drawnAgain(owner = true) {
  const { PageView } = await import('./pages')
  await act(async () => root.render(createElement(PageView, { slug: 'plan', user: 'user-1', owner })))
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.resetModules()
  localStorage.clear()
  localStorage.setItem('it.display', 'a-display-key-000001')
  recent = [{ at: NOW - 5000, delivery: 'handed_off', outcome: 'succeeded' }]
  machines = [
    {
      id: 'machine-1',
      name: PAGE.machine,
      wanted: ['claude-code', 'pi'],
      harnesses: [
        { id: 'claude-code', addon: 'connected' },
        { id: 'pi', addon: 'connected' },
      ],
    },
  ]
  connected = true
  functions = undefined
  pageQueries.length = 0
  told.clear()
  answers.length = 0
  stopsAsked.length = 0
  queries.length = 0
  client.mutation.mockClear()
  inventoryAsked.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
/** Lets so much time pass, on a clock the test holds. */
const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
/** The connection says that it has gone, or that it is there again, to whatever asked to be told. */
const connection = (up: boolean) =>
  act(async () => {
    connected = up
    for (const fn of told) fn()
  })

describe('what the page’s bar says of the last thing the person did', () => {
  test.each([true, false])('the live page omits version history from its subscription when owner is %s', async (owner) => {
    functions = 'current'
    await shown(owner)
    const pageQueries = () => queries.filter((q) => q.name === 'artifacts:get').map((q) => q.args)
    expect(pageQueries()).toEqual([{ slug: 'plan', history: false }])
    queries.length = 0
    recent = [{ at: NOW - 2000, delivery: 'pending', outcome: null }]
    await drawnAgain(owner)
    expect(pageQueries()).toEqual([{ slug: 'plan', history: false }])
    expect(said()).toBe('Sent. Waiting for your agent')
  })

  test('when It has not been reachable for a few seconds the bar says so, whatever was last done, and stops saying so when It is back', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    await shown()
    expect(said()).toBe('Done')
    await connection(false)
    // A moment without a connection is not said
    await pass(3000)
    expect(said()).toBe('Done')
    await pass(2500)
    expect(said()).toBe('Can’t reach It. What you do here is saved on this browser, and sent when It is back')
    await connection(true)
    expect(said()).toBe('Done')
  })

  test('once the agent has changed the page since, the bar says nothing more of it: the answer is on the page', async () => {
    // As It records a click an add-on has taken: handed over, and running until its agent says more
    recent = [{ at: NOW - 5000, delivery: 'handed_off', outcome: 'running' }]
    Object.assign(PAGE, { answeredAt: NOW - 9000 })
    await shown()
    expect(said()).toBe('Your agent has it')
    await act(async () => root.unmount())
    host.remove()
    // The agent wrote the page's state three seconds after the click
    Object.assign(PAGE, { answeredAt: NOW - 2000 })
    await shown()
    expect(said()).toBeNull()
    // What the agent said became of it is still said
    await act(async () => root.unmount())
    host.remove()
    recent = [{ at: NOW - 5000, delivery: 'handed_off', outcome: 'failed' }]
    await shown()
    expect(said()).toBe('Your agent could not do that')
    Object.assign(PAGE, { answeredAt: 0 })
  })

  test('a click nobody has taken after a few seconds is said to be that, with what it may mean; and why a conversation could not be reopened is said in words', async () => {
    Object.assign(PAGE, { machineSeenAt: NOW, agent: 'pi' })
    recent = [{ at: NOW - 2000, delivery: 'pending', outcome: null }]
    await shown()
    expect(said()).toBe('Sent. Waiting for your agent')
    await act(async () => root.unmount())
    host.remove()
    recent = [{ at: NOW - 8000, delivery: 'pending', outcome: null }]
    await shown()
    // Nothing on its machine took it: nobody was listening
    expect(said()).toBe('Sent. Pi is not listening. Open its conversation and check the add-on under Machines')
    await act(async () => root.unmount())
    host.remove()
    // A machine has it in hand and cannot give it to the agent yet: the agent is at work
    recent = [{ at: NOW - 8000, delivery: 'leased', outcome: null }]
    await shown()
    expect(said()).toBe('Sent. Pi is busy, and gets it when it is free')
    await act(async () => root.unmount())
    host.remove()
    Object.assign(PAGE, { wakeFailed: { at: NOW - 1000, why: 'the folder its conversation was held in is not known on this machine, or is gone' } })
    await shown()
    expect(said()).toBe('Couldn’t wake Pi: the folder its conversation was held in is not known on this machine, or is gone')
    Object.assign(PAGE, { wakeFailed: null })
  })

  test('a waiting page gives the loaded add-on’s repair advice instead of diagnosing a closed conversation', async () => {
    Object.assign(PAGE, {
      machineSeenAt: NOW,
      agent: 'opencode',
      addonRuntime: { state: 'active', idle: false, detail: 'Open the saved conversation and send a message to start listening.' },
    })
    recent = [{ at: NOW - 8000, delivery: 'pending', outcome: null }]
    await shown()
    expect(said()).toBe('Sent. Open the saved conversation and send a message to start listening.')
    expect(host.textContent).not.toContain('Wake it')
    Object.assign(PAGE, { addonRuntime: { state: 'incompatible', detail: 'Restart the app to load its updated add-on.' } })
    await drawnAgain()
    expect(said()).toBe('Sent. Restart the app to load its updated add-on.')
    Object.assign(PAGE, { addonRuntime: null, agent: 'pi' })
  })

  test('what was settled is said for ten minutes and then no more, and what is still waiting is said for as long as it waits', async () => {
    Object.assign(PAGE, { machineSeenAt: NOW, agent: 'pi' })
    // Done eleven minutes ago: nothing more to say of it
    recent = [{ at: NOW - 11 * 60_000, delivery: 'handed_off', outcome: 'succeeded' }]
    await shown()
    expect(said()).toBeNull()
    await act(async () => root.unmount())
    host.remove()
    // Waiting for eleven minutes, with nobody listening: still said, since nothing has come of it
    recent = [{ at: NOW - 11 * 60_000, delivery: 'pending', outcome: null }]
    await shown()
    expect(said()).toBe('Sent. Pi is not listening. Open its conversation and check the add-on under Machines')
    Object.assign(PAGE, { agent: 'claude-code' })
  })

  test('a click for a machine that is off waits for the machine and is not laid to a closed conversation: one not heard from for a minute and a half, one whose connector said it was stopping, and one that was removed', async () => {
    // Heard from a minute ago, which is two of the times it says it is alive: it is there
    Object.assign(PAGE, { machineSeenAt: NOW - 60_000, agent: 'pi' })
    recent = [{ at: NOW - 8000, delivery: 'pending', outcome: null }]
    await shown()
    expect(said()).toBe('Sent. Pi is not listening. Open its conversation and check the add-on under Machines')
    await act(async () => root.unmount())
    host.remove()
    // Quiet for longer than three of them: a laptop whose lid was closed
    Object.assign(PAGE, { machineSeenAt: NOW - 101_000 })
    await shown()
    expect(said()).toBe('Waiting for the laptop to come online')
    await act(async () => root.unmount())
    host.remove()
    // Its connector said it was stopping a moment ago, which the backend gives as no time at all
    Object.assign(PAGE, { machineSeenAt: null })
    recent = [
      { at: NOW - 1000, delivery: 'pending', outcome: null },
      { at: NOW - 2000, delivery: 'pending', outcome: null },
    ]
    await shown()
    expect(said()).toBe('Waiting for the laptop to come online (2)')
    await act(async () => root.unmount())
    host.remove()
    // The machine was removed from the person's machines: nothing is waited for there, and what would get it to the agent is said
    Object.assign(PAGE, { machineGone: true })
    await shown()
    expect(said()).toBe('the laptop was removed from It. Your agent gets this when its conversation is open on one of your machines (2)')
    Object.assign(PAGE, { machineSeenAt: NOW, machineGone: false, agent: 'claude-code' })
  })

  test('a click made with no connection is said at once to be saved in this browser, and what became of the click before it is said no more', async () => {
    const outbox = await shown()
    expect(said()).toBe('Done')
    connected = false
    await act(async () => void outbox.submit(client as never, 'user-1', 'page-1', envelope('click-0002')))
    // Without waiting for the bar to look again by itself, which it does every few seconds
    expect(said()).toBe('Saved on this browser, not sent yet')
    // The connection comes back: it is on its way, and then the backend's word is the word again
    await connection(true)
    expect(said()).toBe('Sending…')
    recent = [{ at: NOW, delivery: 'pending' }, ...recent]
    await act(async () => answers[0]!({ actionId: 'action-2' }))
    await tick()
    expect(said()).toBe('Sent. Waiting for your agent')
  })

  test('a click made with a connection is said to be on its way, and to be saved in this browser the moment the connection is known to have gone', async () => {
    const outbox = await shown()
    expect(said()).toBe('Done')
    await act(async () => void outbox.submit(client as never, 'user-1', 'page-1', envelope('click-0003')))
    expect(said()).toBe('Sending…')
    // The connection goes while it is on its way: it is saved here, and that is said
    await connection(false)
    expect(said()).toBe('Saved on this browser, not sent yet')
  })

  test('a click that has not been taken a few seconds after it was made is said to be saved in this browser and not sent, whatever the connection claims, until it is taken', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    // The page's machine goes on saying it is there for the three minutes this takes
    Object.assign(PAGE, { machineSeenAt: NOW + 180_000 })
    const outbox = await shown()
    // The connection is open and carries nothing, as a phone's in a pocket: it says it is there throughout
    await act(async () => void outbox.submit(client as never, 'user-1', 'page-1', envelope('click-0006')))
    expect(said()).toBe('Sending…')
    await pass(3900)
    expect(said()).toBe('Sending…')
    // Five seconds at most, and by itself: nothing else has changed
    await pass(200)
    expect(said()).toBe('Saved on this browser, not sent yet')
    // The client gives the connection up a minute on and has another at once, which says it is there too
    await pass(55_000)
    await connection(false)
    expect(said()).toBe('Saved on this browser, not sent yet')
    await connection(true)
    expect(said()).toBe('Saved on this browser, not sent yet')
    await pass(120_000)
    expect(said()).toBe('Saved on this browser, not sent yet')
    // Taken at last, it is the backend's word again
    recent = [{ at: Date.now(), delivery: 'pending' }, ...recent]
    await act(async () => answers[0]!({ actionId: 'action-6' }))
    await pass(10)
    expect(said()).toBe('Sent. Waiting for your agent')
    Object.assign(PAGE, { machineSeenAt: NOW })
  })

  test('a new click made while an older one is still waiting is not said to be on its way: the older one has not been sent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const outbox = await shown()
    await act(async () => void outbox.submit(client as never, 'user-1', 'page-1', envelope('click-0007')))
    await pass(10_000)
    expect(said()).toBe('Saved on this browser, not sent yet')
    await act(async () => void outbox.submit(client as never, 'user-1', 'page-1', envelope('click-0008')))
    expect(said()).toBe('Saved on this browser, not sent yet')
    await pass(2000)
    expect(said()).toBe('Saved on this browser, not sent yet')
    // The older one is taken: the newer was made two seconds ago, and is on its way for two more
    await act(async () => answers[0]!({ actionId: 'action-7' }))
    await pass(10)
    expect(said()).toBe('Sending…')
    await pass(2100)
    expect(said()).toBe('Saved on this browser, not sent yet')
  })

  test('a click another tab of this browser kept for the same page is said here as soon as the browser says so', async () => {
    await shown()
    expect(said()).toBe('Done')
    const key = 'it.outbox.user-1.page-1.click-0004'
    localStorage.setItem(key, JSON.stringify({ user: 'user-1', artifactId: 'page-1', envelope: envelope('click-0004'), at: Date.now(), left: true }))
    await act(async () => void window.dispatchEvent(new StorageEvent('storage', { key })))
    expect(said()).toBe('Saved on this browser, not sent yet')
    // Sent from that tab, it is let go of there, and here the backend's word is the word again
    localStorage.removeItem(key)
    await act(async () => void window.dispatchEvent(new StorageEvent('storage', { key })))
    expect(said()).toBe('Done')
  })

  test('a click this browser would not store says that the tab must stay open, from the moment it is made', async () => {
    const outbox = await shown()
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    try {
      await act(async () => void outbox.submit(client as never, 'user-1', 'page-1', envelope('click-0005')))
      expect(said()).toBe('Sending. This browser could not save it, so keep this tab open')
    } finally {
      full.mockRestore()
    }
    await act(async () => answers[0]!({ actionId: 'action-5' }))
    await tick()
    expect(said()).toBe('Done')
  })

  test('a click this browser would not store, and that has not been taken a few seconds on, is said not to have been sent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const outbox = await shown()
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    try {
      await act(async () => void outbox.submit(client as never, 'user-1', 'page-1', envelope('click-0009')))
    } finally {
      full.mockRestore()
    }
    expect(said()).toBe('Sending. This browser could not save it, so keep this tab open')
    await pass(4100)
    expect(said()).toBe('Not sent yet. This browser could not save it, so keep this tab open')
    await pass(60_000)
    expect(said()).toBe('Not sent yet. This browser could not save it, so keep this tab open')
    await act(async () => answers[0]!({ actionId: 'action-9' }))
    await pass(10)
    expect(said()).toBe('Done')
  })
  test('something older that is still waiting is said, though what was done after it was dealt with, and however long ago that was', async () => {
    // The last thing done here was handed over and done; the one before it never reached the agent
    recent = [
      { at: NOW - 5000, delivery: 'handed_off', outcome: 'succeeded' },
      { at: NOW - 60_000, delivery: 'pending', outcome: null },
    ]
    Object.assign(PAGE, { pending: 1, wake: null })
    await shown()
    expect(said()).toBe('Sent. Claude Code is not listening. Open its conversation and check the add-on under Machines')
    await act(async () => root.unmount())
    host.remove()
    // And where what still waits is older than the last things done that the bar is told of, It’s own count says so
    recent = [{ at: NOW - 30 * 60_000, delivery: 'handed_off', outcome: 'succeeded' }]
    Object.assign(PAGE, { pending: 3 })
    await shown()
    expect(said()).toBe('3 earlier things done here are still waiting for Claude Code')
    Object.assign(PAGE, { pending: 0 })
  })

  test('to wake the agent is offered only for something done in the last day, which is what a conversation is reopened for', async () => {
    Object.assign(PAGE, { wake: { machineId: 'machine-1', harness: 'claude-code', on: false }, pending: 1 })
    recent = [{ at: NOW - 60_000, delivery: 'pending', outcome: null }]
    await shown()
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Wake it')).toBe(true)
    await act(async () => root.unmount())
    host.remove()
    recent = [{ at: NOW - 2 * 24 * 60 * 60_000, delivery: 'pending', outcome: null }]
    await shown()
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Wake it')).toBe(false)
    expect(said()).toBe('Sent more than a day ago. Claude Code gets it when its conversation is next open')
    Object.assign(PAGE, { wake: null, pending: 0 })
  })

  test('a paired screen says of a click not yet taken what the owner’s browser says, with Auto-wake on or off, and is not offered the switch', async () => {
    const { PageView } = await import('./pages')
    const outbox = await import('./outbox')
    outbox.outboxBelongsTo('user-1', 'session-1')
    /** What the bar says to the owner and to a screen, and whether each is offered to wake the agent. */
    const each = async () => {
      const seen: [string | null, boolean][] = []
      for (const owner of [true, false]) {
        host = document.body.appendChild(document.createElement('div'))
        root = createRoot(host)
        await act(async () => root.render(createElement(PageView, { slug: 'plan', user: 'user-1', owner })))
        seen.push([said(), [...host.querySelectorAll('button')].some((b) => b.textContent === 'Wake it')])
        if (owner) {
          await act(async () => root.unmount())
          host.remove()
        }
      }
      return seen
    }
    recent = [{ at: NOW - 60_000, delivery: 'pending', outcome: null }]
    // On: It is reopening the conversation, or it waits its turn among those being reopened
    Object.assign(PAGE, { wake: { machineId: 'machine-1', harness: 'claude-code', on: true }, pending: 1 })
    expect(await each()).toEqual([
      ['Sent. Waiting for your agent', false],
      ['Sent. Waiting for your agent', false],
    ])
    await act(async () => root.unmount())
    host.remove()
    Object.assign(PAGE, { wake: { machineId: 'machine-1', harness: 'claude-code', on: false } })
    expect(await each()).toEqual([
      ['Sent. Claude Code is not listening. Open its conversation and check the add-on under Machines', true],
      ['Sent. Claude Code is not listening. Open its conversation and check the add-on under Machines', false],
    ])
    Object.assign(PAGE, { wake: null, pending: 0 })
  })

  test('a click for an agent app that is not connected on its machine is said to wait for that, and to wake it is not offered: reopening its conversation would not hand the click over', async () => {
    Object.assign(PAGE, { agent: 'pi', wake: { machineId: 'machine-1', harness: 'pi', on: false }, pending: 1 })
    recent = [{ at: NOW - 60_000, delivery: 'pending', outcome: null }]
    machines = [{ id: 'machine-1', wanted: ['claude-code'] }]
    try {
      await shown()
      expect(said()).toBe('Sent. Pi is not connected on the laptop, and gets it once it is connected there, under Machines')
      expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Wake it')).toBe(false)
      // The same with Auto-wake left on from when the app was connected: nothing is reopened for an app that is not
      Object.assign(PAGE, { wake: { machineId: 'machine-1', harness: 'pi', on: true } })
      await drawnAgain()
      expect(said()).toBe('Sent. Pi is not connected on the laptop, and gets it once it is connected there, under Machines')
      // Connected again, it is as any click nobody has taken
      machines = [
        {
          id: 'machine-1',
          wanted: ['claude-code', 'pi'],
          harnesses: [
            { id: 'claude-code', addon: 'connected' },
            { id: 'pi', addon: 'connected' },
          ],
        },
      ]
      Object.assign(PAGE, { wake: { machineId: 'machine-1', harness: 'pi', on: false } })
      await drawnAgain()
      expect(said()).toBe('Sent. Pi is not listening. Open its conversation and check the add-on under Machines')
      expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Wake it')).toBe(true)
    } finally {
      Object.assign(PAGE, { agent: 'claude-code', wake: null, pending: 0 })
    }
  })

  test.each([true, false])('page readiness explains disconnected and transitional apps to owner=%s, including apps without wake support', async (owner) => {
    const { PageView } = await import('./pages')
    recent = [{ at: NOW - 60_000, delivery: 'pending', outcome: null }]
    Object.assign(PAGE, { agent: 'openclaw', wake: null, pending: 1, connection: { harness: 'openclaw', state: 'disconnected', queue: false } })
    await shown()
    const expectations = {
      disconnected: 'is not connected',
      connecting: 'is still connecting',
      needs_approval: 'needs approval',
      error: 'could not connect',
      too_old: 'needs an update',
      unavailable: 'is unavailable',
      unknown: 'has not confirmed',
    }
    try {
      for (const [state, message] of Object.entries(expectations)) {
        Object.assign(PAGE, { connection: { harness: 'openclaw', state, queue: false } })
        await act(async () => root.render(createElement(PageView, { slug: 'plan', user: 'user-1', owner })))
        expect(said()).toContain(message)
        expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Wake it')).toBe(false)
        expect(said()).not.toContain('conversation looks closed')
      }
    } finally {
      Object.assign(PAGE, { agent: 'claude-code', pending: 0, connection: undefined })
    }
  })

  test('Codex awaiting hook approval still describes its supported queue, without treating it as disconnected', async () => {
    recent = [{ at: NOW - 60_000, delivery: 'pending', outcome: null }]
    Object.assign(PAGE, {
      agent: 'codex',
      wake: { machineId: 'machine-1', harness: 'codex', on: false },
      connection: { harness: 'codex', state: 'needs_approval', queue: true },
    })
    try {
      await shown()
      expect(said()).toContain('open conversation can still receive queued clicks')
      expect(said()).not.toContain('not connected')
      expect(said()).not.toContain('looks closed')
      expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Wake it')).toBe(false)
    } finally {
      Object.assign(PAGE, { agent: 'claude-code', wake: null, connection: undefined })
    }
  })

  test('an older backend owner fallback uses the reported add-on state, not just the desired selection', async () => {
    recent = [{ at: NOW - 60_000, delivery: 'pending', outcome: null }]
    Object.assign(PAGE, { wake: { machineId: 'machine-1', harness: 'claude-code', on: false } })
    machines = [{ id: 'machine-1', wanted: ['claude-code'], harnesses: [{ id: 'claude-code', addon: 'error' }] }]
    try {
      await shown()
      expect(said()).toContain('could not connect')
      expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Wake it')).toBe(false)
    } finally {
      Object.assign(PAGE, { wake: null })
    }
  })

  test.each(['openclaw', 'pi'])('an older backend reports %s readiness when waking is unavailable', async (harness) => {
    recent = [{ at: NOW - 60_000, delivery: 'pending', outcome: null }]
    Object.assign(PAGE, { agent: harness, session: { harness, id: 'conversation-1' }, wake: null, connection: undefined })
    const app = { id: harness, addon: 'not_connected' }
    machines = [
      { id: 'another-machine', name: 'the desktop', wanted: [harness], harnesses: [{ id: harness, addon: 'connected' }] },
      { id: 'machine-1', name: PAGE.machine, wanted: [harness], harnesses: [app] },
    ]
    try {
      await shown()
      for (const [addon, message] of [
        ['not_connected', 'is still connecting'],
        ['needs_approval', 'needs approval'],
        ['error', 'could not connect'],
      ] as const) {
        app.addon = addon
        await drawnAgain()
        expect(said()).toContain(message)
        expect(said()).not.toContain('conversation looks closed')
        expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Wake it')).toBe(false)
      }
      // Older backends do not give paired screens permission to read the inventory.
      inventoryAsked.mockClear()
      const { PageView } = await import('./pages')
      await act(async () => root.render(createElement(PageView, { slug: 'plan', user: 'user-1', owner: false })))
      expect(inventoryAsked).not.toHaveBeenCalled()
    } finally {
      Object.assign(PAGE, { agent: 'claude-code', session: null })
    }
  })

  test('an older backend does not guess which of two machines with the same name owns a page', async () => {
    recent = [{ at: NOW - 60_000, delivery: 'pending', outcome: null }]
    Object.assign(PAGE, { agent: 'openclaw', session: { harness: 'openclaw', id: 'conversation-1' }, wake: null, connection: undefined })
    machines = ['machine-1', 'machine-2'].map((id) => ({
      id,
      name: PAGE.machine,
      wanted: ['openclaw'],
      harnesses: [{ id: 'openclaw', addon: id === 'machine-1' ? 'connected' : 'error' }],
    }))
    try {
      await shown()
      expect(said()).toContain("has not confirmed OpenClaw's connection")
      expect(said()).not.toContain('conversation looks closed')
      expect(said()).not.toContain('could not connect')
    } finally {
      Object.assign(PAGE, { agent: 'claude-code', session: null })
    }
  })

  test('what the agent had already done is not said to have been stopped by a stop that came after it', async () => {
    // Done a minute ago, and the conversation was stopped since, from another of its pages
    recent = [{ at: NOW - 60_000, delivery: 'handed_off', outcome: 'succeeded', route: 'addon', handedAt: NOW - 59_000 }]
    Object.assign(PAGE, { stoppedAt: NOW - 1000, answeredAt: 0 })
    await shown()
    expect(said()).toBe('Done')
    await act(async () => root.unmount())
    host.remove()
    recent = [{ at: NOW - 60_000, delivery: 'handed_off', outcome: 'failed', route: 'addon', handedAt: NOW - 59_000 }]
    await shown()
    expect(said()).toBe('Your agent could not do that')
    await act(async () => root.unmount())
    host.remove()
    // What its agent had and had not finished when it was stopped is said as stopped, as before
    recent = [{ at: NOW - 60_000, delivery: 'handed_off', outcome: 'running', route: 'addon', handedAt: NOW - 59_000 }]
    await shown()
    expect(said()).toBe('Stopped')
    Object.assign(PAGE, { stoppedAt: null })
  })

  test('a stop is said with what else it dropped, and not with what an earlier stop of the same conversation dropped', async () => {
    const stopped = (at: number, handedAt?: number) => ({ at, delivery: 'handed_off', outcome: 'failed', route: 'stopped', ...(handedAt ? { handedAt } : {}) })
    // Stopped forty minutes ago with one click, and now again with one
    Object.assign(PAGE, { stoppedAt: NOW - 1000 })
    recent = [stopped(NOW - 9000, NOW - 1000), stopped(NOW - 2_400_000, NOW - 2_390_000)]
    await shown()
    expect(said()).toBe('Stopped')
    await act(async () => root.unmount())
    host.remove()
    // Two more were waiting when it was stopped, one of them dropped a moment after the stop, as the rest of many are
    recent = [stopped(NOW - 3000, NOW - 400), stopped(NOW - 6000, NOW - 1000), stopped(NOW - 9000, NOW - 1000), stopped(NOW - 2_400_000, NOW - 2_390_000)]
    await shown()
    expect(said()).toBe('Stopped, with 2 more that were waiting')
    await act(async () => root.unmount())
    host.remove()
    // Functions that do not say when each was dropped: what was done in the hour before the stop is counted, as it was
    recent = [stopped(NOW - 9000), stopped(NOW - 2_400_000), stopped(NOW - 4_000_000)]
    await shown()
    expect(said()).toBe('Stopped, with 1 more that was waiting')
    Object.assign(PAGE, { stoppedAt: null })
  })

  test('what was done after a stop is not said to be stopped when the clock puts it before the stop, and a stop counts what went with it by its place', async () => {
    // Stopped at place 10. Done after that, at place 11, with the clock set back an hour since
    Object.assign(PAGE, { stoppedAt: NOW - 1000, stoppedSequence: 10, answeredAt: 0, machineSeenAt: NOW })
    recent = [{ at: NOW - 3_600_000, delivery: 'pending', outcome: null, sequence: 11 }]
    await shown()
    expect(said()).not.toContain('Stopped')
    await act(async () => root.unmount())
    host.remove()
    // Two that went with this stop, whatever the clock says of them, and one an earlier stop dropped
    const dropped = (at: number, sequence: number, stoppedSequence: number) => ({
      at,
      delivery: 'handed_off',
      outcome: 'failed',
      route: 'stopped',
      handedAt: NOW,
      sequence,
      stoppedSequence,
    })
    recent = [dropped(NOW + 60_000, 9, 10), dropped(NOW - 5000, 8, 10), dropped(NOW - 9000, 3, 4)]
    await shown()
    expect(said()).toBe('Stopped, with 1 more that was waiting')
    Object.assign(PAGE, { stoppedAt: null, stoppedSequence: null })
  })

  test('what a stop dropped is said to be stopped, and never to be something the agent could not do, also once the page says no more when it was stopped', async () => {
    // The page has changed conversation or machine since, and the stop was noted with the one it had then
    Object.assign(PAGE, { stoppedAt: null })
    recent = [{ at: NOW - 9000, delivery: 'handed_off', outcome: 'failed', route: 'stopped', handedAt: NOW - 1000 }]
    await shown()
    expect(said()).toBe('Stopped')
  })

  test('something waiting for a machine that is there and hands nothing over for now is said as that, and nothing is offered that would not help', async () => {
    recent = [{ at: NOW - 20_000, delivery: 'pending' }]
    Object.assign(PAGE, { machineSeenAt: NOW, agent: 'pi', pending: 1, wake: { machineId: 'machine-1', harness: 'pi', on: false }, machinePaused: 'unfit' })
    await shown()
    expect(said()).toBe(
      'Sent. the laptop and It are of versions that do not work together, so Pi gets it once the one that is behind is updated. The Machines page says more',
    )
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Wake it')).toBe(false)
    await act(async () => root.unmount())
    host.remove()
    Object.assign(PAGE, { machinePaused: 'unchecked', pending: 3 })
    await shown()
    expect(said()).toBe('Sent (3). the laptop is still asking It whether the two work together, and hands it to Pi once it knows')
    await act(async () => root.unmount())
    host.remove()
    // Fitting again, it is said as anything else that waits
    Object.assign(PAGE, { machinePaused: null, pending: 1 })
    await shown()
    expect(said()).toBe('Sent. Pi is not listening. Open its conversation and check the add-on under Machines')
    Object.assign(PAGE, { wake: null, pending: 0, agent: 'claude-code' })
  })

  test('an agent said to be working on a machine that has gone quiet is not said to be working: whether it is, is not known, and a stop is said to wait for the machine', async () => {
    Object.assign(PAGE, { run: { stopping: false }, machineSeenAt: NOW })
    await shown()
    expect(host.querySelector('.working')?.textContent).toContain('Working')
    await act(async () => root.unmount())
    host.remove()
    // Quiet for longer than it may be, or its connector said it was stopping
    Object.assign(PAGE, { machineSeenAt: NOW - 200_000 })
    await shown()
    expect(host.querySelector('.working')).toBeNull()
    expect(said()).toBe('the laptop is not answering. Whether Claude Code is still at work there is not known')
    // It can still be asked to stop, which It keeps for the machine until it is back
    expect(stops().length).toBe(1)
    await act(async () => stops()[0]!.click())
    await act(async () => stopsAsked[0]!.answer({ stopping: true }))
    expect(said()).toBe('Asked to stop. the laptop is not answering, and is told when it is back')
    expect(stops().length).toBe(0)
    await act(async () => root.unmount())
    host.remove()
    Object.assign(PAGE, { run: { stopping: true }, machineSeenAt: null })
    await shown()
    expect(said()).toBe('Asked to stop. the laptop is not answering, and is told when it is back')
    Object.assign(PAGE, { run: null, machineSeenAt: NOW })
  })

  test('a stop It has not answered is said to be on its way, with the tab to keep open, and to be kept for a quiet machine only once It has answered', async () => {
    Object.assign(PAGE, { run: { stopping: false }, machineSeenAt: NOW - 200_000 })
    await shown()
    await act(async () => stops()[0]!.click())
    // Nothing is kept anywhere yet: the machine is not said to be told, and the stop is not asked a second time.
    // For the moment an answer usually takes, nothing more is said either, so that no sentence comes and goes with it
    expect(allSaid()).toEqual(['the laptop is not answering. Whether Claude Code is still at work there is not known'])
    expect(stops().length).toBe(0)
    await aWhile()
    expect(allSaid()).toEqual([
      'the laptop is not answering. Whether Claude Code is still at work there is not known',
      'Sending the stop. Keep this tab open until it is sent',
    ])
    expect(stops().length).toBe(0)
    expect(stopsAsked.length).toBe(1)
    await act(async () => stopsAsked[0]!.answer({ stopping: true }))
    expect(allSaid()).toEqual(['Asked to stop. the laptop is not answering, and is told when it is back'])
    expect(stops().length).toBe(0)
    Object.assign(PAGE, { run: null, machineSeenAt: NOW })
  })

  test('a stop the page hears that It has, before the asking itself is answered, is said to be kept and no longer to be on its way', async () => {
    Object.assign(PAGE, { run: { stopping: false }, machineSeenAt: NOW - 200_000 })
    await shown()
    await act(async () => stops()[0]!.click())
    await aWhile()
    expect(allSaid()).toContain('Sending the stop. Keep this tab open until it is sent')
    // What It says of the page's run reaches the page before the answer to the asking does
    Object.assign(PAGE, { run: { stopping: true } })
    await drawnAgain()
    expect(allSaid()).toEqual(['Asked to stop. the laptop is not answering, and is told when it is back'])
    Object.assign(PAGE, { run: null, machineSeenAt: NOW })
  })

  test('a stop that It answers by saying nothing was running, or refuses, is offered again, and the agent is not said to be stopping', async () => {
    Object.assign(PAGE, { run: { stopping: false }, machineSeenAt: NOW })
    await shown()
    await act(async () => stops()[0]!.click())
    // On its way: the agent is at work still, for all that is known
    expect(host.querySelector('.working')?.textContent).toBe('Working')
    await aWhile()
    expect(allSaid()).toEqual(['Sending the stop. Keep this tab open until it is sent'])
    expect(stops().length).toBe(0)
    // The run had ended by the time It had the stop, which the page has yet to hear
    await act(async () => stopsAsked[0]!.answer({ stopping: false }))
    expect(host.querySelector('.working')?.textContent).not.toContain('Stopping')
    expect(allSaid()).toEqual([])
    expect(stops().length).toBe(1)
    // And one It refuses is no more kept than that
    await act(async () => stops()[0]!.click())
    expect(stops().length).toBe(0)
    await act(async () => stopsAsked[1]!.refuse(new Error('It could not take it')))
    expect(host.querySelector('.working')?.textContent).not.toContain('Stopping')
    expect(allSaid()).toEqual([])
    expect(stops().length).toBe(1)
    Object.assign(PAGE, { run: null })
  })

  test('a stop that was asked of one run of the conversation is not said of the next, which can be stopped in its turn', async () => {
    Object.assign(PAGE, { run: { identity: 'original-run', since: NOW - 60_000, stopping: false }, machineSeenAt: NOW })
    await shown()
    const { hasPending } = await import('./pending')
    await act(async () => stops()[0]!.click())
    expect(hasPending()).toBe(true)
    expect(stopsAsked[0]!.input).toMatchObject({ expectedRun: 'original-run', expectedSession: 'session-1' })
    await act(async () => stopsAsked[0]!.answer({ stopping: true }))
    expect(hasPending()).toBe(false)
    expect(host.querySelector('.working')?.textContent).toBe('Stopping')
    // The machine reopens the conversation for something done since, before the page has heard that the first run ended
    Object.assign(PAGE, { run: { identity: 'next-run', since: NOW - 60_000, stopping: false } })
    await drawnAgain()
    expect(host.querySelector('.working')?.textContent).toContain('Working')
    expect(stops().length).toBe(1)
    Object.assign(PAGE, { run: null })
  })
})

// Kept after everything above: what is said of a click there goes by how many seconds old it is,
// counted from when this file was loaded, and whatever runs before it uses those seconds up
describe('the line that moves under a page’s bar', () => {
  test('is there while the last thing done is on its way or with the agent, and gone once it is answered, stopped or old', async () => {
    await shown()
    const { inHand } = await import('./pages')
    const at = NOW - 5000
    // Sent and not taken, and taken and not yet answered
    expect(inHand([{ at, delivery: 'pending' }], null, false, NOW)).toBe(true)
    expect(inHand([{ at, delivery: 'leased' }], null, false, NOW)).toBe(true)
    expect(inHand([{ at, delivery: 'handed_off', outcome: 'running' }], at - 1000, false, NOW)).toBe(true)
    expect(inHand([{ at, delivery: 'handed_off', outcome: null }], null, false, NOW)).toBe(true)
    // The agent changed the page since, said it was done or could not be, or was stopped
    expect(inHand([{ at, delivery: 'handed_off', outcome: 'running' }], at + 1000, false, NOW)).toBe(false)
    expect(inHand([{ at, delivery: 'handed_off', outcome: 'succeeded' }], null, false, NOW)).toBe(false)
    expect(inHand([{ at, delivery: 'handed_off', outcome: 'failed' }], null, false, NOW)).toBe(false)
    expect(inHand([{ at, delivery: 'handed_off', outcome: 'failed', route: 'stopped' }], null, false, NOW)).toBe(false)
    // Something older that still waits counts before a later thing that was dealt with
    expect(
      inHand(
        [
          { at, delivery: 'handed_off', outcome: 'succeeded' },
          { at: at - 1000, delivery: 'pending' },
        ],
        null,
        false,
        NOW,
      ),
    ).toBe(true)
    // Long ago is not under way, nothing done is nothing, and a reopened conversation at work always is
    expect(inHand([{ at: NOW - 11 * 60_000, delivery: 'pending' }], null, false, NOW)).toBe(false)
    expect(inHand([], null, false, NOW)).toBe(false)
    expect(inHand(undefined, null, false, NOW)).toBe(false)
    expect(inHand([], null, true, NOW)).toBe(true)
  })

  test('is drawn on the bar for something that waits, and not for something that was done', async () => {
    recent = [{ at: NOW - 2000, delivery: 'pending' }]
    await shown()
    expect(host.querySelector('.page-nav .page-progress')).not.toBeNull()
    recent = [{ at: NOW - 2000, delivery: 'handed_off', outcome: 'succeeded' }]
    await drawnAgain()
    expect(host.querySelector('.page-progress')).toBeNull()
  })
})

test.each([undefined, 'retained', 'current'] as const)('the page uses only arguments supported by %s functions', async (state) => {
  functions = state
  await shown()
  expect(pageQueries.at(-1)).toEqual(state === 'current' ? { slug: 'plan', history: false } : { slug: 'plan' })
})

describe('Escape on a page', () => {
  const pressed = () => act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  afterEach(() => history.replaceState(null, '', '/'))

  test('closes the notifications where they are open and stays on the page, and goes back to the pages only when nothing is open over it', async () => {
    history.replaceState(null, '', '/p/plan')
    await shown()
    await act(async () => host.querySelector<HTMLButtonElement>('.notif-btn')!.click())
    expect(host.querySelector('.notif-panel')).not.toBeNull()
    await pressed()
    expect(host.querySelector('.notif-panel')).toBeNull()
    expect(location.pathname).toBe('/p/plan')
    await pressed()
    expect(location.pathname).toBe('/')
  })
})

test('a refused pre-upgrade request stays visible after reopening without being sent again', async () => {
  const outbox = await shown()
  const key = 'it.outbox.user-1.page-1.legacy-request'
  const message = 'Reload It before sending new requests. This saved request has no replay deadline. Check what your agent received before sending it again.'
  localStorage.setItem(key, JSON.stringify({ user: 'user-1', artifactId: 'page-1', envelope: envelope('legacy-request'), at: NOW - 60_000 }))
  const mutation = vi.fn(async () => {
    throw new ConvexError({ code: 'conflict', message })
  })
  const backend = { mutation, connectionState: () => ({ isWebSocketConnected: true }) } as never
  await act(async () => outbox.drain(backend, 'user-1'))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(message)
  expect(outbox.unsent('user-1', 'page-1')).toBe(0)
  await act(async () => root.unmount())
  host.remove()
  await shown()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(message)
  await act(async () => outbox.drain(backend, 'user-1'))
  expect(mutation).toHaveBeenCalledTimes(1)
  await act(async () => {
    vi.mocked(Date.now).mockReturnValue(NOW + 7 * 86400_000)
    await outbox.drain(backend, 'user-1')
  })
  expect(localStorage.getItem(key)).toBeNull()
  expect(host.querySelector('[role="alert"]')).toBeNull()
})
