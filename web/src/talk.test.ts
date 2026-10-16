// The strip under a page's bar: what the page's agent last said above the page, and the box a
// person types to it in. In a stand-in browser with a stand-in backend.
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const NOW = Date.now()
/** The page as the backend gives it, which each test may change before it is drawn. */
let page: Record<string, unknown>
/** What the backend answers a typed message with: nothing, until the test lets it. */
let answer: { accept: (said: { actionId: string }) => void; refuse: (why: unknown) => void } | null
const client = {
  mutation: vi.fn(
    (_fn: unknown, _args: Record<string, unknown>) =>
      new Promise<{ actionId: string }>((accept, refuse) => {
        answer = { accept, refuse }
      }),
  ),
  connectionState: () => ({ isWebSocketConnected: true }),
  subscribeToConnectionState: () => () => {},
}
vi.mock('convex/react', () => ({
  useConvex: () => client,
  useMutation: () => async () => null,
  useQuery: (fn: unknown) => ({ 'artifacts:get': page, 'actions:forArtifact': [] })[getFunctionName(fn as never)],
}))
vi.mock('./mount', () => ({ Mount: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const opener = () => [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Type to Claude Code')!
const box = () => host.querySelector<HTMLInputElement>('.page-talk-form input')
const send = () => host.querySelector<HTMLButtonElement>('.page-talk-send')!
const line = () => host.querySelector('.page-talk-said span')?.textContent ?? null
const tick = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)))
/** Types into the box as a person does, so that the site hears of it. */
async function type(text: string) {
  const input = box()!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function shown() {
  const { PageView } = await import('./pages')
  const outbox = await import('./outbox')
  outbox.outboxBelongsTo('user-1', 'session-1')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root.render(createElement(PageView, { slug: 'plan', user: 'user-1', owner: true })))
}
async function drawnAgain() {
  const { PageView } = await import('./pages')
  await act(async () => root.render(createElement(PageView, { slug: 'plan', user: 'user-1', owner: true })))
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('it.display', 'a-display-key-000001')
  page = { id: 'page-1', slug: 'plan', title: 'Plan', version: 1, agent: 'claude-code', machine: 'the laptop', machineSeenAt: NOW, said: null }
  answer = null
  client.mutation.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('the box a person types to a page’s agent in', () => {
  test('is closed until it is asked for, and sends what is typed as a message of the site’s own', async () => {
    await shown()
    expect(host.querySelector('.page-talk')).toBeNull()
    await act(async () => opener().click())
    expect(box()).not.toBeNull()
    expect(document.activeElement).toBe(box())
    expect(send().disabled).toBe(true)
    await type('make the board bigger')
    await act(async () => send().click())
    expect(client.mutation).toHaveBeenCalledTimes(1)
    const [fn, args] = client.mutation.mock.calls[0]!
    expect(getFunctionName(fn as never)).toBe('actions:message')
    expect(args).toMatchObject({ artifactId: 'page-1', displayKey: 'a-display-key-000001', text: 'make the board bigger' })
    expect(args.clientActionId).toMatch(/^typed-[0-9a-f]{24}$/)
    // On its way: it is not sent a second time by a second press
    expect(send().disabled).toBe(true)
    await act(async () => answer!.accept({ actionId: 'a1' }))
    expect(box()!.value).toBe('')
  })

  test('what is typed while a message is on its way is still in the box when that message has been taken', async () => {
    await shown()
    await act(async () => opener().click())
    await type('first message')
    await act(async () => send().click())
    await type('second message, typed while waiting')
    await act(async () => answer!.accept({ actionId: 'a1' }))
    expect(box()!.value).toBe('second message, typed while waiting')
    // And is a message of its own when it is sent
    await act(async () => send().click())
    expect(client.mutation.mock.calls.map((c) => c[1].text)).toEqual(['first message', 'second message, typed while waiting'])
    expect(client.mutation.mock.calls[1]![1].clientActionId).not.toBe(client.mutation.mock.calls[0]![1].clientActionId)
    await act(async () => answer!.accept({ actionId: 'a2' }))
    expect(box()!.value).toBe('')
  })

  test('a draft edited away and back to the words on their way stays in the box and is sent as a message of its own', async () => {
    await shown()
    await act(async () => opener().click())
    await type('please try again')
    await act(async () => send().click())
    await type('another draft')
    await type('please try again')
    await act(async () => answer!.accept({ actionId: 'a1' }))
    expect(client.mutation.mock.calls.map((c) => c[1].text)).toEqual(['please try again'])
    expect(box()!.value).toBe('please try again')
    await act(async () => send().click())
    expect(client.mutation.mock.calls.map((c) => c[1].text)).toEqual(['please try again', 'please try again'])
    expect(client.mutation.mock.calls[1]![1].clientActionId).not.toBe(client.mutation.mock.calls[0]![1].clientActionId)
    await act(async () => answer!.accept({ actionId: 'a2' }))
    expect(box()!.value).toBe('')
  })

  test('a message on its way is said to be in this tab alone, and the site is not loaded afresh over it, until It has taken it', async () => {
    vi.useFakeTimers()
    try {
      await shown()
      const outbox = await import('./outbox')
      const status = () => host.querySelector('.status')?.textContent ?? null
      await act(async () => opener().click())
      await type('are you there')
      expect(outbox.anyUnsaved()).toBe(false)
      await act(async () => send().click())
      expect(status()).toBe('Sending. What you typed is only in this tab, so keep it open')
      expect(outbox.anyUnsaved()).toBe(true)
      // A few seconds on with no answer, as when It cannot be reached, it is not said to be on its way
      await act(async () => void (await vi.advanceTimersByTimeAsync(4100)))
      expect(status()).toBe('Not sent yet. What you typed is only in this tab, so keep it open')
      expect(box()!.value).toBe('are you there')
      await act(async () => answer!.accept({ actionId: 'a1' }))
      expect(outbox.anyUnsaved()).toBe(false)
      expect(status()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('keeps what was typed when it was refused, says why, and sends it again under the same id', async () => {
    await shown()
    await act(async () => opener().click())
    await type('hello')
    await act(async () => send().click())
    const first = client.mutation.mock.calls[0]![1].clientActionId
    await act(async () => answer!.refuse(new ConvexError({ code: 'rate_limited', message: 'Too fast. Try again in a moment.' })))
    expect(box()!.value).toBe('hello')
    expect(host.querySelector('.page-talk .error')?.textContent).toBe('Too fast. Try again in a moment.')
    await act(async () => send().click())
    expect(client.mutation.mock.calls[1]![1].clientActionId).toBe(first)
    await act(async () => answer!.accept({ actionId: 'a1' }))
    // The next thing typed is another message
    await type('again')
    await act(async () => send().click())
    expect(client.mutation.mock.calls[2]![1].clientActionId).not.toBe(first)
  })

  test('closes on Escape, which does not leave the page from there', async () => {
    await shown()
    await act(async () => opener().click())
    history.replaceState(null, '', '/p/plan')
    await act(async () => void box()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    await tick()
    expect(box()).toBeNull()
    expect(location.pathname).toBe('/p/plan')
  })

  test('closed with Escape, it leaves the keyboard on the button that opened it', async () => {
    await shown()
    await act(async () => opener().click())
    expect(document.activeElement).toBe(box())
    await act(async () => void box()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(box()).toBeNull()
    expect(document.activeElement).toBe(opener())
  })

  test('is not offered on a page that has nothing published', async () => {
    page = { ...page, version: null }
    await shown()
    expect(opener()).toBeUndefined()
  })
})

describe('what a page’s agent said above the page', () => {
  test('is shown by itself while it is new, and stays away once it was dismissed', async () => {
    page = { ...page, said: { text: 'Bigger now.', at: NOW - 60_000 } }
    await shown()
    expect(line()).toBe('Bigger now.')
    expect(box()).toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('.page-talk-x')!.click())
    expect(host.querySelector('.page-talk')).toBeNull()
    // The next thing it says is another line
    page = { ...page, said: { text: 'And centred.', at: NOW } }
    await drawnAgain()
    expect(line()).toBe('And centred.')
  })

  test('one that was dismissed is not brought back by opening the box, nor by drawing the page again in that tab', async () => {
    page = { ...page, said: { text: 'Bigger now.', at: NOW - 60_000 } }
    await shown()
    await act(async () => host.querySelector<HTMLButtonElement>('.page-talk-x')!.click())
    await act(async () => opener().click())
    expect(box()).not.toBeNull()
    expect(line()).toBeNull()
    await act(async () => root.unmount())
    host.remove()
    await shown()
    expect(host.querySelector('.page-talk')).toBeNull()
  })

  test('is not brought up by itself long after, and is there for whoever opens the box', async () => {
    page = { ...page, said: { text: 'Yesterday’s answer.', at: NOW - 24 * 3_600_000 } }
    await shown()
    expect(host.querySelector('.page-talk')).toBeNull()
    await act(async () => opener().click())
    expect(line()).toBe('Yesterday’s answer.')
  })
})
