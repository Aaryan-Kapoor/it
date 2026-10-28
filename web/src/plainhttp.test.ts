// The site on a screen that reached It over plain http, at the address of the machine on the
// home network. A browser does not count such an address as secure, and takes a good deal away
// there. Here it is all taken away from the stand-in browser, as Chromium and Firefox take it,
// and the site is held to what it must still do: keep its display's key, keep and send what a
// person did on a page, sign out, and say in a sentence, where notifications are read, the one
// thing it cannot do there. And the whole site is shown there, paired, with a page opened and
// the controls a paired display shows each used once, so that whatever is called on that path
// is called where a browser has taken all of this away. Nothing may throw, and nothing may be
// offered that cannot work.
//
// The stand-in browser is at the address of a machine on the network, as such a screen is:
// @vitest-environment-options {"url": "http://workstation.lan:4700/"}
import { createHash } from 'node:crypto'
import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/** What the stand-in browser had before it was taken away, to be put back afterwards. */
let before: { subtle: PropertyDescriptor | undefined; randomUUID: PropertyDescriptor | undefined }
/** Everything asked of the backend, and of the door where a test stands one in, in the order it was asked. */
const calls: string[] = []
/** What the stand-in backend answers, by function. Anything not named here answers null. */
const answers: Record<string, (args: any) => unknown> = {}
const ask = async (fn: unknown, args?: unknown) => {
  const name = getFunctionName(fn as never)
  if (name === 'actions:replayGrant') return { until: Date.now() + 6 * 86400_000 }
  calls.push(name)
  return answers[name]?.(args) ?? null
}
const client = {
  mutation: vi.fn(ask),
  query: vi.fn(ask),
  action: vi.fn(ask),
  connectionState: () => ({ isWebSocketConnected: true }),
  subscribeToConnectionState: () => () => {},
}
/** What the queries the site watches say, by function. */
let watched: Record<string, unknown>
vi.mock('convex/react', () => ({
  useConvex: () => client,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useMutation: (fn: unknown) => (args: unknown) => client.mutation(fn, args),
  // A query answers by its arguments where the stand-in gives it a function, and with the same thing however it is asked otherwise
  useQuery: (fn: unknown, args?: unknown) => {
    if (args === 'skip') return undefined
    const answer = watched[getFunctionName(fn as never)]
    return typeof answer === 'function' ? answer(args) : answer
  },
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
  watched = { 'notifications:list': [] }
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

describe('copying, on plain http', () => {
  test('is done the older way, from a field that holds the text, and the keyboard is left on the button that was pressed', async () => {
    plainHttp()
    const { copy } = await import('./brand')
    // As a browser does it: choosing what is in a field takes the keyboard to that field
    const select = HTMLTextAreaElement.prototype.select
    vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(function (this: HTMLTextAreaElement) {
      this.focus()
      select.call(this)
    })
    const copied: string[] = []
    Object.assign(document, { execCommand: () => copied.push((document.activeElement as HTMLTextAreaElement).value) > 0 })
    const pressed = document.body.appendChild(document.createElement('button'))
    try {
      pressed.focus()
      expect(await copy('it network on')).toBe(true)
      expect(copied).toEqual(['it network on'])
      expect(document.activeElement).toBe(pressed)
      expect(document.querySelector('textarea')).toBeNull()
      // And when the browser will not copy that way either
      Object.assign(document, {
        execCommand: () => {
          throw new Error('NotAllowedError')
        },
      })
      expect(await copy('it network on')).toBe(false)
      expect(document.activeElement).toBe(pressed)
      expect(document.querySelector('textarea')).toBeNull()
    } finally {
      pressed.remove()
      Reflect.deleteProperty(document, 'execCommand')
      vi.restoreAllMocks()
    }
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
      watched['notifications:list'] = [{ id: 'n1', text: 'Dinner is ready', slug: null, sticky: false, buttons: [], at: Date.now(), seen: true, answer: null }]
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

describe('the whole site, paired, on plain http', () => {
  const NOW = Date.now()
  const DISPLAY = { id: 'display-1', name: 'Chrome on Linux', named: false, lastSeenAt: NOW, push: false, epoch: 0, showing: null }
  const CARD = { id: 'page-1', slug: 'plan', title: 'Plan', version: 1, updatedAt: NOW, agent: 'claude-code', machine: 'the laptop', pending: 0, pinned: false }
  const NOTE = {
    id: 'n1',
    text: 'Ship the plan?',
    slug: 'plan',
    sticky: true,
    buttons: [{ label: 'Ship it', action: 'ship' }],
    at: NOW,
    seen: false,
    answer: null,
  }
  const MACHINE = { id: 'machine-1', name: 'the laptop', lastSeenAt: NOW, connectorVersion: '0.1.0', runsIt: true, harnesses: [], wanted: [], wakes: [] }

  /** The session this browser's cookie stands for, as the stand-in door says, or none. */
  let cookie: { session: string; role: 'owner' | 'screen' } | null
  /** Each file the door took from the site, by its number and the SHA-256 it was sent under. */
  let uploaded: { n: number; sha256: string }[]
  const door = async (to: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(to)
    calls.push(path)
    const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status })
    if (path === '/session/token') return cookie ? answer(200, { token: 'a-token', expiresIn: 300, user: 'user-1', ...cookie }) : answer(401)
    if (path === '/session/end') {
      cookie = null
      return answer(200)
    }
    if (path.startsWith('/upload/')) {
      uploaded.push({ n: Number(path.slice('/upload/'.length)), sha256: (init.headers as Record<string, string>)['x-it-sha256']! })
      return new Response(null, { status: 200 })
    }
    return answer(200)
  }

  /** What the site wrote to the console as an error or a warning, and what it threw that nothing caught. */
  const trouble: unknown[] = []
  const thrown = (e: ErrorEvent) => void trouble.push(e.error ?? e.message)
  /** What was copied, the older way, which is the only way there is at such an address. */
  const copied: string[] = []
  /** What each site a test started listens for on the window, taken off again when its test is over. */
  const listening: Parameters<typeof window.addEventListener>[] = []

  let root: Root
  let host: HTMLElement
  const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms))
  const settle = () => act(() => tick())
  /** Starts the site at an address, as loading it does, and waits for it to come to rest. */
  async function start(at = '/') {
    history.replaceState(null, '', at)
    const session = await import('./session')
    const { App } = await import('./app')
    const { caught } = await import('./backend')
    void session.begin()
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host, { onCaughtError: caught })
    await act(async () => {
      root.render(createElement(App))
      await tick()
    })
  }
  const button = (label: string, within: ParentNode = host) =>
    [...within.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label)
  const press = async (label: string, within: ParentNode = host) => {
    const pressed = button(label, within)
    expect(pressed, `a button "${label}"`).toBeDefined()
    await act(async () => {
      pressed!.click()
      await tick()
    })
  }
  const type = (field: Element | null, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      field!.dispatchEvent(new Event('input', { bubbles: true }))
    })
  const key = (to: EventTarget, named: string, more: KeyboardEventInit = {}) =>
    act(async () => void to.dispatchEvent(new KeyboardEvent('keydown', { key: named, bubbles: true, cancelable: true, ...more })))
  const sections = () => [...host.querySelectorAll('nav a')].map((a) => a.textContent)
  const go = (section: string) =>
    act(async () => {
      ;[...host.querySelectorAll<HTMLAnchorElement>('nav a')].find((a) => a.textContent === section)!.click()
      await tick()
    })
  /** What the screen says has gone wrong: anything said as an alert, and the site's last resort. */
  const wrong = () =>
    [...host.querySelectorAll('[role="alert"]')]
      .map((a) => a.textContent)
      .concat(host.textContent?.includes('Something went wrong') ? ['Something went wrong'] : [])

  beforeEach(async () => {
    plainHttp()
    cookie = null
    uploaded = []
    trouble.length = 0
    copied.length = 0
    Object.assign(answers, {
      'displays:register': () => DISPLAY,
      'displays:heartbeat': () => ({ now: Date.now() }),
      'displays:signOutToken': () => ({ token: 'sign-out-token', raisesTo: 1, display: 'display-1' }),
      'displays:signOut': () => ({ job: 'job-1' }),
      'displays:signOutConfirmed': () => true,
      'mounts:create': () => ({ mountId: 'mount-1', version: 1 }),
      'mounts:ticket': ({ mountId }: { mountId: string }) => ({ ticket: `ticket-for-${mountId}` }),
      // It has the click's one file once the door has taken it
      'files:prepare': () => (uploaded.length ? { id: 'attachment-1', stored: true } : { id: 'attachment-1', stored: false, missing: [1], grant: 'grant-1' }),
      'actions:submit': () => ({ actionId: 'action-1' }),
      'actions:message': () => ({ actionId: 'action-2' }),
      'state:store': () => ({ revision: 2 }),
      'sessions:inviteScreen': () => ({ code: 'screencode0000000002', expiresAt: Date.now() + 600_000 }),
    })
    watched = {
      'displays:mine': DISPLAY,
      'artifacts:list': [CARD],
      'artifacts:get': { ...CARD, machineSeenAt: NOW, run: null },
      'actions:forArtifact': [],
      // The whole state to a display that has none, and nothing new to one that has revision 1
      'state:live': ({ since }: { since?: number }) => (since === 1 ? { revision: 1 } : { revision: 1, whole: true, state: '{"plan":"A"}', kept: [] }),
      'deletions:list': [],
      'notifications:list': [NOTE],
      'tour:get': { waitingUntil: null, by: null, askedAt: null, takenAt: null, doneAt: null },
      'machines:list': [MACHINE],
      'displays:list': [{ ...DISPLAY, paired: true }],
      'sessions:list': [
        {
          id: 'session-1',
          role: 'owner',
          pairedAt: NOW,
          lastSeenAt: NOW,
          mine: true,
          displays: [{ id: 'display-1', name: 'Chrome on Linux' }],
          invitedBy: { kind: 'machine', name: 'the laptop' },
          along: { browsers: [], machines: [] },
        },
      ],
      'sessions:leftBehind': [],
      'network:get': { on: true, addresses: ['http://workstation.lan:4700'], tailnet: false, canTailnet: false, exposed: null, asked: null, answered: null },
      'network:service': { port: 4700, background: true, usage: false },
    }
    sessionStorage.clear()
    vi.stubGlobal('fetch', vi.fn(door))
    // A browser's channel carries a file as the file it is, which the stand-in browser's does
    // not. What comes before anything listens at a port waits there, as it does in a browser
    class Port {
      other!: Port
      private waiting: unknown[] = []
      private heard: ((m: { data: unknown }) => void) | null = null
      get onmessage() {
        return this.heard
      }
      set onmessage(fn) {
        this.heard = fn
        for (const data of this.waiting.splice(0)) this.take(data)
      }
      take(data: unknown) {
        if (this.heard) setTimeout(() => this.heard?.({ data }))
        else this.waiting.push(data)
      }
      postMessage(data: unknown) {
        this.other.take(data)
      }
      close() {}
    }
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = new Port()
        port2 = new Port()
        constructor() {
          this.port1.other = this.port2
          this.port2.other = this.port1
        }
      },
    )
    // As a browser does it: choosing what is in a field takes the keyboard to that field
    const select = HTMLTextAreaElement.prototype.select
    vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(function (this: HTMLTextAreaElement) {
      this.focus()
      select.call(this)
    })
    Object.assign(document, { execCommand: () => copied.push((document.activeElement as HTMLTextAreaElement).value) > 0 })
    // Not React's word that a clock of the site's moved the screen between a test's steps, which
    // the bar over a page does every second: that is about how long the test took
    const ours = (what: unknown[]) => !(typeof what[0] === 'string' && what[0].includes('not wrapped in act('))
    for (const said of ['error', 'warn'] as const) vi.spyOn(console, said).mockImplementation((...what: unknown[]) => void (ours(what) && trouble.push(what)))
    window.addEventListener('error', thrown)
    const listen = window.addEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation((...wanted: Parameters<typeof window.addEventListener>) => {
      listening.push(wanted)
      listen(...wanted)
    })
    // Files are kept in IndexedDB, which a browser has at such an address and the stand-in browser does not
    const kept = await import('./kept')
    kept.keepBytesIn(kept.inMemory())
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    window.removeEventListener('error', thrown)
    for (const [kind, listener, how] of listening.splice(0)) window.removeEventListener(kind, listener, how)
    Reflect.deleteProperty(document, 'execCommand')
    vi.restoreAllMocks()
    expect(trouble).toEqual([])
  })

  test('the owner’s display is paired, shows its pages, and every control over them works, with nothing thrown', async () => {
    const { NOT_SECURE } = await import('./push')
    expect(location.origin).toBe('http://workstation.lan:4700')
    cookie = { session: 'session-1', role: 'owner' }
    await start()
    // Registered as a display, and shown the pages
    expect(calls).toEqual(expect.arrayContaining(['/session/token', 'displays:register', 'displays:heartbeat', 'displays:signOutToken']))
    expect(sections()).toEqual(['Pages', 'Machines', 'Displays'])
    expect(host.querySelector('.card-title')?.textContent).toBe('Plan')
    // The token that signs this display out is kept
    expect(JSON.stringify({ ...localStorage })).toContain('sign-out-token')
    // Notifications that could not come once the site is closed are not offered
    expect(button('Turn on notifications')).toBeUndefined()

    // The bell: the notification, the sentence that says why none come with the site closed, and an answer to the notification
    await press('Notifications, 1 new')
    const tray = host.querySelector('.notif-panel')!
    expect(tray.querySelector('.tray-note')?.textContent).toBe(NOT_SECURE)
    expect(calls).toContain('notifications:seen')
    await press('Ship it', tray)
    expect(calls).toContain('notifications:answer')
    await key(document.activeElement ?? document, 'Escape')
    expect(host.querySelector('.notif-panel')).toBeNull()

    // The finder, opened and closed from the keyboard
    await key(document, 'k', { ctrlKey: true })
    expect(document.activeElement).toBe(host.querySelector('.finder-input'))
    await type(host.querySelector('.finder-input'), 'pla')
    expect(host.querySelector('.finder-result-title')?.textContent).toBe('Plan')
    await key(document.activeElement!, 'Escape')
    expect(host.querySelector('.finder-input')).toBeNull()

    // The tour's sentence, copied
    await press('Take the tour')
    await press('Copy prompt', host.querySelector('.modal-panel')!)
    expect(copied).toEqual(['Give me the It tour.'])
    expect(host.querySelector('.modal-panel .copyable-btn')?.textContent).toBe('Copied')
    await key(document, 'Escape')
    expect(host.querySelector('.modal-panel')).toBeNull()

    // A card's link, copied
    await press('Copy link')
    expect(copied.at(-1)).toBe('http://workstation.lan:4700/p/plan')
    expect(host.querySelector('.toast-stack')?.textContent).toContain('Link copied')

    // This display, named
    await press('Name this display')
    await type(host.querySelector('input[aria-label="Name for this display"]'), 'Kitchen TV')
    await press('Save')
    expect(calls).toContain('displays:rename')

    // Settings, the machines, and the displays, with a code for another screen shown as an address and a QR code
    await press('More')
    await press('Settings')
    expect(host.textContent).toContain('Paired as yours')
    await go('Machines')
    expect(host.querySelector('h2')?.textContent).toBe('Machines')
    expect(host.textContent).toContain('the laptop')
    await go('Displays')
    expect(host.querySelector('h2')?.textContent).toBe('Displays')
    await press('Add a display')
    await settle()
    expect(calls).toContain('sessions:inviteScreen')
    expect(host.querySelector('.pair-address')?.textContent).toBe('http://workstation.lan:4700/pair#screencode0000000002')
    expect(host.querySelector('svg.qr')).not.toBeNull()
    await press('Done')
    await go('Pages')
    expect(host.querySelector('.card-title')?.textContent).toBe('Plan')
    expect(wrong()).toEqual([])
  })

  test.each(['owner', 'screen'] as const)('a display paired as the %s’s opens a page, and what is done on it reaches It, a photo with it', async (role) => {
    cookie = { session: 'session-1', role }
    await start()
    expect(sections()).toEqual(role === 'owner' ? ['Pages', 'Machines', 'Displays'] : ['Pages'])
    // Opened from its card
    await act(async () => {
      host.querySelector<HTMLAnchorElement>('a.card-title')!.click()
      await tick()
    })
    expect(location.pathname).toBe('/p/plan')
    expect(host.querySelector('.page-title')?.textContent).toBe('Plan')
    const frame = host.querySelector<HTMLIFrameElement>('.mount iframe')!
    expect(frame.src).toBe('http://workstation.lan:4701/open/ticket-for-mount-1')

    // The page's own script says hello, and is given its channel and the page's state
    type Channel = { onmessage: ((m: { data: unknown }) => void) | null; postMessage: (data: unknown) => void }
    const posted: { data: { type: string }; ports: Channel[] }[] = []
    Object.assign(frame.contentWindow!, { postMessage: (data: { type: string }, _to: string, ports: Channel[] = []) => void posted.push({ data, ports }) })
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'it:hello', doc: 'doc-1' }, origin: 'null', source: frame.contentWindow }))
      await tick()
    })
    expect(frame.dataset.shown).toBe('true')
    const port = posted.find((p) => p.data.type === 'it:port')!.ports[0]!
    const heard: unknown[] = []
    port.onmessage = (m) => void heard.push(m.data)
    await settle()
    expect(heard).toEqual([{ type: 'it:state', state: { plan: 'A' }, revision: 1 }])

    // A click that carries a photo, and something the page keeps
    const photo = new File([new Uint8Array(5000).fill(7)], 'receipt.jpg', { type: 'image/jpeg' })
    await act(async () => {
      port.postMessage({
        type: 'it:action',
        requestId: 'r-1',
        envelope: { clientActionId: 'click-0001', name: 'approve', payload: { plan: 'B', photo }, contentVersion: 1 },
      })
      port.postMessage({ type: 'it:store', requestId: 'r-2', changes: [['draft', '{"plan":"B"}']] })
      await vi.waitFor(() => expect(heard).toHaveLength(3))
    })
    expect(heard.slice(1)).toEqual(
      expect.arrayContaining([
        { type: 'it:result', requestId: 'r-1', ok: true, actionId: 'action-1' },
        { type: 'it:result', requestId: 'r-2', ok: true, revision: 2 },
      ]),
    )
    // The photo went to the door under its SHA-256, which the site worked out without the browser's own
    expect(uploaded).toEqual([{ n: 1, sha256: createHash('sha256').update(new Uint8Array(5000).fill(7)).digest('hex') }])
    expect(calls).toEqual(expect.arrayContaining(['files:prepare', 'actions:submit', 'state:store']))

    // Typed to the page's agent
    await press('Type to Claude Code')
    await type(host.querySelector('input[aria-label="Type to Claude Code"]'), 'Plan B, please')
    await press('Send')
    expect(calls).toContain('actions:message')
    // The page's link, copied
    await press('Copy link')
    expect(copied).toEqual(['http://workstation.lan:4700/p/plan'])
    // And back to the pages
    await press('Back to your pages')
    expect(location.pathname).toBe('/')
    expect(host.querySelector('.card-title')?.textContent).toBe('Plan')
    expect(wrong()).toEqual([])
  })

  test('signing out stops this display’s pages and ends the pairing, and the browser then shows how to pair', async () => {
    cookie = { session: 'session-1', role: 'owner' }
    await start()
    calls.length = 0
    await press('More')
    await press('Sign out')
    await settle()
    expect(calls.filter((c) => ['push:unsubscribe', 'displays:signOut', 'displays:signOutConfirmed', '/session/end'].includes(c)).slice(0, 4)).toEqual([
      'push:unsubscribe',
      'displays:signOut',
      'displays:signOutConfirmed',
      '/session/end',
    ])
    expect(host.textContent).toContain('Connect this browser')
    expect(wrong()).toEqual([])
  })
})
