// What a page's bar says of the last thing the person did, in a stand-in browser with a stand-in
// backend. What it must get right: it speaks of the click just made the moment it is made, and
// never goes on saying what became of the one before.
import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Sent } from './outbox'

const NOW = Date.now()
const PAGE = { id: 'page-1', slug: 'plan', title: 'Plan', version: 1, agent: 'claude-code', machine: 'the laptop', machineSeenAt: NOW }
/** What the backend last said of the page's clicks, newest first. */
let recent: { at: number; delivery: string; outcome?: string | null }[]
/** Whether there is a connection to the backend, and what was asked to be told when that changes. */
let connected: boolean
const told = new Set<() => void>()
/** What the backend answers each click with, in the order they were sent: nothing, until the test lets it. */
const answers: ((said: { actionId: string }) => void)[] = []
const client = {
  mutation: vi.fn(
    () =>
      new Promise<{ actionId: string }>((resolve) => {
        answers.push(resolve)
      }),
  ),
  connectionState: () => ({ isWebSocketConnected: connected }),
  subscribeToConnectionState: (fn: () => void) => {
    told.add(fn)
    return () => void told.delete(fn)
  },
}
vi.mock('convex/react', () => ({
  useConvex: () => client,
  useMutation: () => async () => null,
  useQuery: (fn: unknown) => ({ 'artifacts:get': PAGE, 'actions:forArtifact': recent })[getFunctionName(fn as never)],
}))
// The frame a page is shown in has tests of its own
vi.mock('./mount', () => ({ Mount: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const said = () => host.querySelector('.status')?.textContent ?? null
const envelope = (id: string): Sent => ({ v: 1, clientActionId: id, name: 'approve', payload: '{"n":1}', contentVersion: 1 })
const tick = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)))
async function shown() {
  const { PageView } = await import('./pages')
  const outbox = await import('./outbox')
  outbox.outboxBelongsTo('user-1', 'session-1')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root.render(createElement(PageView, { slug: 'plan', user: 'user-1', owner: true })))
  return outbox
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  localStorage.setItem('it.display', 'a-display-key-000001')
  recent = [{ at: NOW - 5000, delivery: 'handed_off', outcome: 'succeeded' }]
  connected = true
  told.clear()
  answers.length = 0
  client.mutation.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
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
  test('when It has not been reachable for a few seconds the bar says so, whatever was last done, and stops saying so when It is back', async () => {
    vi.useFakeTimers()
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
    expect(said()).toBe('Sent. Pi is not listening: its conversation looks closed')
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

  test('a click for a machine that is off waits for the machine and is not laid to a closed conversation: one not heard from for a minute and a half, one whose connector said it was stopping, and one that was removed', async () => {
    // Heard from a minute ago, which is two of the times it says it is alive: it is there
    Object.assign(PAGE, { machineSeenAt: NOW - 60_000, agent: 'pi' })
    recent = [{ at: NOW - 8000, delivery: 'pending', outcome: null }]
    await shown()
    expect(said()).toBe('Sent. Pi is not listening: its conversation looks closed')
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
})
