// The site on a screen that reached It over plain http, at the address of the machine on the
// home network. A browser does not count such an address as secure, and takes a good deal away
// there. Here it is all taken away from the stand-in browser, as Chromium and Firefox take it,
// and the site is held to what it must still do: keep its display's key, keep and send what a
// person did on a page, sign out, and say in a sentence, where notifications are read, the one
// thing it cannot do there. Nothing may throw, and nothing may be offered that cannot work.
import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/** What the stand-in browser had before it was taken away, to be put back afterwards. */
let before: { subtle: PropertyDescriptor | undefined; randomUUID: PropertyDescriptor | undefined }
const calls: string[] = []
const answers: Record<string, () => unknown> = {}
const ask = async (fn: unknown, _args?: unknown) => {
  const name = getFunctionName(fn as never)
  calls.push(name)
  return answers[name]?.() ?? null
}
const client = { mutation: vi.fn(ask), query: vi.fn(ask), action: vi.fn(ask), connectionState: () => ({ isWebSocketConnected: true }) }
let notes: unknown[]
vi.mock('convex/react', () => ({
  useConvex: () => client,
  useMutation: (fn: unknown) => (args: unknown) => client.mutation(fn, args),
  useQuery: () => notes,
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Makes the stand-in browser what a real one is at such an address. `as` says which: Firefox has no PushManager there at all. */
function plainHttp(as: 'chromium' | 'firefox' = 'chromium') {
  vi.stubGlobal('isSecureContext', false)
  Object.defineProperty(crypto, 'subtle', { configurable: true, value: undefined })
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
  for (const gone of ['locks', 'serviceWorker', 'clipboard', 'storage', 'credentials']) Reflect.deleteProperty(navigator, gone)
  vi.stubGlobal('caches', undefined)
  // What is left of notifications: the word for them, and a permission that is always refused
  vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn(async () => 'denied') })
  vi.stubGlobal('PushManager', as === 'chromium' ? class {} : undefined)
  if (as === 'firefox') Reflect.deleteProperty(window, 'PushManager')
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
}

beforeEach(() => {
  vi.resetModules()
  before = { subtle: Object.getOwnPropertyDescriptor(crypto, 'subtle'), randomUUID: Object.getOwnPropertyDescriptor(crypto, 'randomUUID') }
  calls.length = 0
  for (const name of Object.keys(answers)) delete answers[name]
  notes = []
  localStorage.clear()
})
afterEach(() => {
  for (const name of ['subtle', 'randomUUID'] as const) {
    if (before[name]) Object.defineProperty(crypto, name, before[name])
    else Reflect.deleteProperty(crypto, name)
  }
  vi.unstubAllGlobals()
})

describe('what a browser takes away at such an address', () => {
  test('is gone from the stand-in browser as it is from a real one', () => {
    plainHttp()
    expect([window.isSecureContext, crypto.subtle, crypto.randomUUID, 'locks' in navigator, 'serviceWorker' in navigator, typeof caches]).toEqual([
      false,
      undefined,
      undefined,
      false,
      false,
      'undefined',
    ])
    // What is left is what the site is written with
    expect(typeof crypto.getRandomValues).toBe('function')
  })
})

describe('this display, on plain http', () => {
  test('makes the key it is known by, and the name of a sign-out it owes, from random bytes alone', async () => {
    plainHttp()
    const lib = await import('./lib')
    const key = lib.displayKey()
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(lib.displayKey()).toBe(key)
    lib.keepSignOutToken('sign-out-token', 'user-1', 1, 'display-1')
    expect(lib.signOutLater()).toBe(true)
    const owed = Object.keys(localStorage).filter((name) => name.startsWith('it.signout.pending.'))
    expect(owed.map((name) => [/^it\.signout\.pending\.[0-9a-f]{32}$/.test(name), localStorage.getItem(name)])).toEqual([[true, 'sign-out-token']])
  })

  test('keeps what a person did on a page and sends it, with no locks for its tabs to share: one tab sends a click, and the tab beside it leaves that click alone', async () => {
    plainHttp()
    const { outboxBelongsTo, submit, drain, unsent } = await import('./outbox')
    outboxBelongsTo('user-1', 'session-1')
    let accept!: (value: unknown) => void
    answers['actions:submit'] = () =>
      new Promise((resolve) => {
        accept = resolve
      })
    const envelope = { v: 1 as const, clientActionId: 'click-0001', name: 'approve', payload: '{"n":1}', contentVersion: 1 }
    const sending = submit(client as never, 'user-1', 'page-1', envelope)
    await vi.waitFor(() => expect(calls).toEqual(['actions:submit']))
    // Kept in this browser until its fate is known
    expect(unsent('user-1', 'page-1')).toBe(1)
    // The tab beside it, asked to send what is left over, passes by a click that is being sent
    await drain(client as never, 'user-1')
    expect(calls).toEqual(['actions:submit'])
    accept({ actionId: 'action-1' })
    expect(await sending).toEqual({ actionId: 'action-1' })
    expect(unsent('user-1', 'page-1')).toBe(0)
  })
})

describe('notifications, on plain http', () => {
  for (const as of ['chromium', 'firefox'] as const) {
    test(`in ${as} nothing is offered that cannot work, and nothing throws: turning them on answers with why not, and asks nothing of the browser or the backend`, async () => {
      plainHttp(as)
      const push = await import('./push')
      expect(push.notSecure()).toBe(true)
      expect(push.pushSupport()).toBe('unsupported')
      expect(await push.turnOnPush(client as never)).toBe('Needs a secure address')
      expect((Notification.requestPermission as ReturnType<typeof vi.fn>).mock.calls).toEqual([])
      expect(calls).toEqual([])
      // What runs by itself when the session ends, or when the backend believes this display is subscribed
      await expect(push.dropPushHere()).resolves.toBeUndefined()
      await expect(push.mendPush(client as never)).resolves.toBeUndefined()
      expect(calls).toEqual([])
      // Signing out takes the display's subscription off at the backend, where there is one to take off, and does not stop at the browser having none
      await expect(push.turnOffPush(client as never)).resolves.toBeUndefined()
      expect(calls).toEqual(['push:unsubscribe'])
    })
  }

  test('an iPhone there is not told to add the site to its Home Screen, which would change nothing', async () => {
    plainHttp('firefox')
    vi.stubGlobal('Notification', undefined)
    Reflect.deleteProperty(window, 'Notification')
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
    })
    try {
      const push = await import('./push')
      expect(push.pushSupport()).toBe('unsupported')
      expect(await push.turnOnPush(client as never)).toBe('Needs a secure address')
    } finally {
      Reflect.deleteProperty(navigator, 'userAgent')
    }
  })

  describe('where they are read', () => {
    let root: Root
    let host: HTMLElement
    const tray = async () => {
      const { Bell } = await import('./notifications')
      host = document.body.appendChild(document.createElement('div'))
      root = createRoot(host)
      await act(async () => root.render(createElement(Bell)))
      await act(async () => (host.querySelector('button.bell') as HTMLButtonElement).click())
      return host.querySelector('[role="dialog"]')!
    }
    afterEach(async () => {
      await act(async () => root.unmount())
      host.remove()
    })
    const SENTENCE =
      'On this screen, notifications show while the site is open. A browser allows one after the site is closed only at a secure address, and this screen reached It over plain http.'

    test('the screen says in a sentence that notifications show while the site is open, and why none can come once it is closed', async () => {
      plainHttp()
      const panel = await tray()
      expect(panel.querySelector('.tray-note')!.textContent).toBe(SENTENCE)
      // Said beside the notifications there are, too
      notes = [{ id: 'n1', text: 'Dinner is ready', slug: null, sticky: false, buttons: [], at: Date.now(), seen: true, answer: null }]
      await act(async () => root.render(createElement((await import('./notifications')).Bell)))
      expect(host.textContent).toContain('Dinner is ready')
      expect(host.querySelector('.tray-note')!.textContent).toBe(SENTENCE)
    })

    test('and says nothing of it at a secure address, where they can', async () => {
      vi.stubGlobal('isSecureContext', true)
      vi.stubGlobal('matchMedia', () => ({ matches: false }))
      const panel = await tray()
      expect(panel.querySelector('.tray-note')).toBeNull()
      expect(panel.textContent).toContain('Nothing new.')
    })
  })
})
