// The whole site, in a stand-in browser with a stand-in backend and a stand-in for the door.
// What it must get right: a browser that is not paired is shown how to pair and nothing else,
// pairing registers it as a display, a display the person forgot comes back only by being
// paired again, a screen is shown nothing of the owner's, and signing out stops this display's
// pages before it ends the session.
import { getFunctionName } from 'convex/server'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// ---------- the stand-in backend ----------

/** Everything asked of the backend and of the door, in the order it was asked. */
const asked: { what: string; args?: any }[] = []
const DISPLAY = { id: 'display-1', name: 'Chrome on Linux', named: false, lastSeenAt: Date.now(), push: false, epoch: 0, showing: null }
/** What the stand-in backend answers, by function. Anything not named here answers null. */
let answers: Record<string, (args: any) => unknown>
/** What the queries the site watches say, by function. One that is a function is called, and may throw as a refused query does. */
let watched: Record<string, unknown>
const ask = async (fn: unknown, args: unknown) => {
  const name = getFunctionName(fn as never)
  asked.push({ what: name, args })
  return answers[name]?.(args) ?? null
}
const client = {
  mutation: vi.fn(ask),
  query: vi.fn(ask),
  action: vi.fn(ask),
  connectionState: () => ({ isWebSocketConnected: true }),
  subscribeToConnectionState: () => () => {},
}
vi.mock('convex/react', () => ({
  useConvex: () => client,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useMutation: (fn: unknown) => (args: unknown) => client.mutation(fn, args),
  useQuery: (fn: unknown) => {
    const said = watched[getFunctionName(fn as never)]
    return typeof said === 'function' ? said() : said
  },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------- the stand-in door ----------

/** The session this browser's cookie stands for, or none, and whose it is where that is not the first person's. */
let cookie: { session: string; role: 'owner' | 'screen'; user?: string } | null
/** The codes that pair a browser, and what each pairs it as. */
const CODES: Record<string, { session: string; role: 'owner' | 'screen' }> = {
  ownercode00000000001: { session: 'session-1', role: 'owner' },
  screencode0000000002: { session: 'session-2', role: 'screen' },
}
/** Set by a test that wants the door to stop answering a sign-out. */
let endFails = false
/** Set by a test to the seconds left of the minute in which the door has had ten wrong codes from this browser's address: it tries none until then. */
let wrongCodesFor: number | null = null
const door = async (path: string, init: RequestInit = {}) => {
  asked.push({ what: path, ...(init.body ? { args: JSON.parse(init.body as string) } : {}) })
  const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status })
  if (path === '/session/token') return cookie ? answer(200, { token: 'a-token', expiresIn: 300, user: 'user-1', ...cookie }) : answer(401)
  if (wrongCodesFor !== null && (path === '/session/code' || path === '/session/redeem'))
    return new Response(JSON.stringify({ error: 'too_many_wrong_codes' }), { status: 429, headers: { 'retry-after': String(wrongCodesFor) } })
  if (path === '/session/code') {
    // What a code is for, which uses nothing of it
    const made = CODES[(JSON.parse(init.body as string) as { code: string }).code]
    return made ? answer(200, { role: made.role }) : answer(401)
  }
  if (path === '/session/redeem') {
    const made = CODES[(JSON.parse(init.body as string) as { code: string }).code]
    if (made) cookie = made
    return answer(made ? 200 : 401)
  }
  if (path === '/session/end') {
    if (endFails) throw new Error('no connection')
    // As the backend does: only the session the cookie is, and only when that is the one named
    if (!cookie) return answer(401)
    if ((JSON.parse(init.body as string) as { session?: string }).session !== cookie.session) return answer(409, { code: 'another_session' })
    cookie = null
    return answer(200)
  }
  return answer(200)
}

// ---------- the site ----------

let root: Root
let host: HTMLElement
let act: (work: () => Promise<void>) => Promise<void>
const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms))
const settle = () => act(() => tick())
/** Starts the site afresh at an address, as loading it does, and waits for it to come to rest. */
async function start(at = '/') {
  vi.resetModules()
  history.replaceState(null, '', at)
  const react = await import('react')
  const { createRoot } = await import('react-dom/client')
  const session = await import('./session')
  const { App } = await import('./app')
  const { caught } = await import('./backend')
  act = react.act as typeof act
  void session.begin()
  host = document.body.appendChild(document.createElement('div'))
  // As the site itself is shown: what a view threw and the site caught is written to the console only where it is trouble
  root = createRoot(host, { onCaughtError: caught })
  await act(async () => {
    root.render(react.createElement(App))
    await tick()
  })
  return session
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label)
const press = (label: string) =>
  act(async () => {
    button(label)!.click()
    await tick()
  })
const typeCode = (value: string) =>
  act(async () => {
    const input = host.querySelector('input[aria-label="Pairing code"]') as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const names = () => asked.map((a) => a.what)
/** What was written to the console as an error. */
const errors: unknown[][] = []
const sections = () => [...host.querySelectorAll('nav a')].map((a) => a.textContent)

/**
 * What each site that a test started listens for on the window. A site started for one test is
 * another tab to the next, and would answer what the next is told with requests of its own, so
 * what it listens with is taken off again when its test is over.
 */
const listening: Parameters<typeof window.addEventListener>[] = []

beforeEach(() => {
  asked.length = 0
  cookie = null
  endFails = false
  wrongCodesFor = null
  answers = {
    'displays:register': () => DISPLAY,
    'displays:heartbeat': () => ({ now: Date.now() }),
    'displays:signOutToken': () => ({ token: 'sign-out-token', raisesTo: 1, display: 'display-1' }),
    'displays:signOut': () => ({ job: 'job-1' }),
    'displays:signOutConfirmed': () => true,
  }
  watched = { 'displays:mine': DISPLAY, 'artifacts:list': [], 'notifications:list': [] }
  localStorage.clear()
  sessionStorage.clear()
  errors.length = 0
  vi.spyOn(console, 'error').mockImplementation((...said: unknown[]) => void errors.push(said))
  vi.stubGlobal('fetch', vi.fn(door))
  // This stand-in browser cannot say how the site is being shown
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const listen = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((...wanted: Parameters<typeof window.addEventListener>) => {
    listening.push(wanted)
    listen(...wanted)
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const [kind, listener, how] of listening.splice(0)) window.removeEventListener(kind, listener, how)
})

describe('a browser that is not paired', () => {
  test('it is shown how to pair it, and asks the backend for nothing', async () => {
    await start()
    expect(host.textContent).toContain('Connect this browser')
    // On the machine It runs on, and on any other screen
    expect(host.querySelector('.copyable-text')!.textContent).toBe('it site')
    expect(host.textContent).toContain('A second screen is added from Displays')
    expect(host.querySelector('input[aria-label="Pairing code"]')).not.toBeNull()
    expect(names()).toEqual(['/session/token'])
  })

  test('a code typed there pairs it, and it registers as a display at once, saying only which browser it is', async () => {
    await start()
    await typeCode('owne rcod e000 0000 0001')
    await press('Pair this browser')
    expect(asked.slice(0, 4)).toEqual([
      { what: '/session/token' },
      { what: '/session/redeem', args: { code: 'ownercode00000000001' } },
      { what: '/session/token' },
      { what: 'displays:register', args: { key: localStorage.getItem('it.display'), userAgent: navigator.userAgent } },
    ])
    expect(host.textContent).toContain('What should I make?')
    // The owner is offered the tour, and is not sent to connect an agent app while it is not known that none is connected
    expect(button('Start the tour')).toBeDefined()
    expect(host.querySelector('.empty-connect')).toBeNull()
  })

  test('the person’s own code in the address pairs it without a word, and the address is left without it', async () => {
    await start('/pair#ownercode00000000001')
    expect(location.pathname + location.hash).toBe('/')
    expect(names().slice(0, 4)).toEqual(['/session/code', '/session/redeem', '/session/token', 'displays:register'])
    expect(host.textContent).toContain('What should I make?')
  })

  test('a screen’s code in the address pairs it only when the person says this browser is that screen', async () => {
    await start('/pair#screencode0000000002')
    expect(location.pathname + location.hash).toBe('/')
    // Opened, and nothing redeemed: the browser is shown what the address is for, and how to pair it otherwise
    expect(names()).toEqual(['/session/code', '/session/token'])
    expect(host.querySelector('.offer')!.textContent).toContain('This address pairs one screen, once.')
    expect(host.textContent).toContain('Connect this browser')
    await press('Make this browser a screen of It')
    expect(asked.slice(2, 5)).toEqual([
      { what: '/session/redeem', args: { code: 'screencode0000000002' } },
      { what: '/session/token' },
      { what: 'displays:register', args: { key: localStorage.getItem('it.display'), userAgent: navigator.userAgent } },
    ])
    expect(sections()).toEqual(['Pages'])
  })

  test('a code that is wrong, used or run out is said to be, in so many words', async () => {
    await start('/pair#notacode000000000000')
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('That code is wrong, has already been used, or has run out. Get a new one and try again.')
    expect(host.textContent).toContain('Connect this browser')
    expect(names()).not.toContain('displays:register')
  })

  test('a code the door did not try, after too many wrong ones, is said to need only waiting for, with how long, and stays where it was typed', async () => {
    await start()
    const typed = () => (host.querySelector('input[aria-label="Pairing code"]') as HTMLInputElement).value
    wrongCodesFor = 43
    await typeCode('owne rcod e000 0000 0001')
    await press('Pair this browser')
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(
      'Too many wrong codes have come from this device in the last minute, so this one was not tried. Wait 43 seconds, and then try it again.',
    )
    expect(typed()).toBe('owne rcod e000 0000 0001')
    // A whole minute, and a single second, are each said as they are spoken
    wrongCodesFor = 60
    await press('Pair this browser')
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Wait a minute, and then try it again.')
    wrongCodesFor = 4
    await press('Pair this browser')
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Wait 4 seconds, and then try it again.')
    // The same code, put again once the minute is over, pairs the browser
    wrongCodesFor = null
    await press('Pair this browser')
    expect(host.textContent).toContain('What should I make?')
    expect(asked.filter((a) => a.what === '/session/redeem').map((a) => a.args)).toEqual(Array(4).fill({ code: 'ownercode00000000001' }))
  })

  test('a screen’s code that was not tried is still offered, with how long to wait beside it', async () => {
    await start('/pair#screencode0000000002')
    wrongCodesFor = 20
    await press('Make this browser a screen of It')
    expect(host.querySelector('.offer [role="alert"]')!.textContent).toBe(
      'Too many wrong codes have come from this device in the last minute, so this one was not tried. Wait 20 seconds, and then try it again.',
    )
    // Said once, where the code was put from
    expect(host.querySelectorAll('[role="alert"]').length).toBe(1)
    wrongCodesFor = null
    await press('Make this browser a screen of It')
    expect(sections()).toEqual(['Pages'])
  })
})

describe('what the site keeps in this browser', () => {
  test('nothing of it is in a cookie a script could read, which whatever else is served under the same host name could read too', async () => {
    const written: string[] = []
    const cookies = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => cookies.get!.call(document), set: (v: string) => void written.push(v) })
    try {
      // Paired, shown, and signed out again: everything the site ever remembers has been remembered by then
      await start('/pair#ownercode00000000001')
      await press('More')
      await press('Sign out')
      await settle()
      expect(host.textContent).toContain('Connect this browser')
      expect(written).toEqual([])
      expect(document.cookie).toBe('')
      // What it does keep is in the storage a browser holds apart for each port
      expect(Object.keys(localStorage).sort()).toEqual(['it.cookies', 'it.display', 'it.display.session', 'it.person', 'it.session'])
    } finally {
      Reflect.deleteProperty(document, 'cookie')
    }
  })
})

describe('a display the person forgot', () => {
  const forgotten = async () => {
    const { ConvexError } = await import('convex/values')
    const old = localStorage.getItem('it.display')
    answers['displays:register'] = ({ key }: { key: string }) =>
      key === old ? Promise.reject(new ConvexError({ code: 'forbidden', message: 'This display was forgotten.', forgotten: true })) : DISPLAY
  }

  test('it starts afresh as a new display once its browser has been paired again, and that pairing is not thrown away', async () => {
    // Registered under an earlier session, then forgotten; the person has just paired the browser again
    localStorage.setItem('it.display', 'the-forgotten-display-key')
    localStorage.setItem('it.display.session', 'session-0')
    cookie = CODES.ownercode00000000001!
    vi.resetModules()
    await forgotten()
    await start()
    const registered = asked.filter((a) => a.what === 'displays:register').map((a) => a.args.key)
    expect(registered.length).toBe(2)
    expect(registered[0]).toBe('the-forgotten-display-key')
    expect(registered[1]).not.toBe('the-forgotten-display-key')
    expect(localStorage.getItem('it.display')).toBe(registered[1])
    expect(names()).not.toContain('/session/end')
    expect(host.textContent).toContain('What should I make?')
  })

  test('it does not come back under the session it had: the browser is signed out, and its key let go of', async () => {
    localStorage.setItem('it.display', 'the-forgotten-display-key')
    localStorage.setItem('it.display.session', 'session-1')
    cookie = CODES.ownercode00000000001!
    vi.resetModules()
    await forgotten()
    await start()
    expect(asked.filter((a) => a.what === 'displays:register').length).toBe(1)
    expect(names()).toContain('/session/end')
    expect(localStorage.getItem('it.display')).toBeNull()
    expect(host.textContent).toContain('Connect this browser')
  })
})

describe('a display key that another paired browser holds', () => {
  test('it is let go of, and this browser registers as a display of its own under the session it has', async () => {
    // What this browser kept names a display that a session still live elsewhere holds: the
    // backend answers as it does for any display that is not this browser's to be
    localStorage.setItem('it.display', 'another-browsers-display-key')
    localStorage.setItem('it.display.session', 'session-0')
    cookie = CODES.ownercode00000000001!
    vi.resetModules()
    const { ConvexError } = await import('convex/values')
    answers['displays:register'] = ({ key }: { key: string }) =>
      key === 'another-browsers-display-key' ? Promise.reject(new ConvexError({ code: 'not_found', message: 'This display is not registered.' })) : DISPLAY
    await start()
    const registered = asked.filter((a) => a.what === 'displays:register').map((a) => a.args.key)
    expect(registered.length).toBe(2)
    expect(registered[0]).toBe('another-browsers-display-key')
    expect(localStorage.getItem('it.display')).toBe(registered[1])
    expect(registered[1]).not.toBe('another-browsers-display-key')
    expect(names()).not.toContain('/session/end')
    expect(host.textContent).toContain('What should I make?')
  })
})

describe('what each kind of session is shown', () => {
  test('the owner has the machines and the displays beside the pages', async () => {
    cookie = CODES.ownercode00000000001!
    await start()
    expect(sections()).toEqual(['Pages', 'Machines', 'Displays'])
  })

  test('a screen has its pages and its own settings, and no way to what is the owner’s, by a link or by an address', async () => {
    cookie = CODES.screencode0000000002!
    for (const at of ['/', '/machines', '/displays']) {
      if (at !== '/') {
        await act(async () => root.unmount())
        host.remove()
      }
      await start(at)
      expect(sections()).toEqual(['Pages'])
      expect(host.textContent).toContain('What should I make?')
      // Nor is it told to set anything up: that is done on the machine It runs on, by the owner
      expect(host.querySelector('.empty-connect')).toBeNull()
    }
    expect(names().filter((n) => /^(machines|sessions|account):|^displays:(list|forget)$/.test(n))).toEqual([])
    await act(async () => root.unmount())
    host.remove()
    await start('/settings')
    expect(host.textContent).toContain('Paired as a screen')
    expect([...host.querySelectorAll('main button')].map((b) => b.textContent)).toEqual(['Rename', 'Sign out'])
  })

  test('being refused something a session may not do is said where it happened, and does not sign the browser out', async () => {
    cookie = CODES.screencode0000000002!
    vi.resetModules()
    const { ConvexError } = await import('convex/values')
    watched['artifacts:get'] = () => {
      throw new ConvexError({ code: 'forbidden', message: 'Only the owner can do this.' })
    }
    await start('/p/plan')
    await settle()
    expect(host.textContent).toContain('That did not work')
    expect(host.textContent).toContain('Only the owner can do this.')
    expect(names()).not.toContain('/session/end')
    // The person was told. It is the backend's answer, and no error of the site's
    expect(errors).toEqual([])
  })

  test('a session the backend says is over is asked about and not ended from here, the browser shows how to pair, and nothing is written to the console as an error', async () => {
    cookie = CODES.ownercode00000000001!
    vi.resetModules()
    const { ConvexError } = await import('convex/values')
    watched['artifacts:get'] = () => {
      // The owner ended this session from another display
      cookie = null
      throw new ConvexError({ code: 'unauthenticated', message: 'This browser is not paired.' })
    }
    await start('/p/plan')
    await settle()
    expect(names().filter((n) => n === '/session/token').length).toBe(2)
    // The session is named to the backend only after it refused the browser a token, for that session's cookie to be cleared
    expect(asked.filter((a) => a.what === '/session/end')).toEqual([{ what: '/session/end', args: { session: 'session-1' } }])
    expect(names().lastIndexOf('/session/token')).toBeLessThan(names().indexOf('/session/end'))
    expect(host.textContent).toContain('Connect this browser')
    expect(errors).toEqual([])
  })

  test('a tab left open while the browser is paired again in another tab follows the new session, ends nothing, and writes nothing to the console as an error', async () => {
    cookie = CODES.ownercode00000000001!
    const session = await start()
    expect(session.current().session).toBe('session-1')
    asked.length = 0
    // The other tab redeems a fresh code: the session this tab was under is over, and the cookie is the new one's
    cookie = { session: 'session-3', role: 'owner' }
    const { ConvexError } = await import('convex/values')
    watched['artifacts:list'] = () => {
      if (session.current().session === 'session-1') throw new ConvexError({ code: 'unauthenticated', message: 'This browser is not paired.' })
      return []
    }
    // The person comes back to this tab and goes somewhere in it, and what it asks is refused
    await press('More')
    await press('Settings')
    await settle()
    expect(names()).not.toContain('/session/end')
    expect(session.current()).toMatchObject({ paired: true, session: 'session-3' })
    // It is a display again under the session it has now, and shows what was asked for
    expect(asked.filter((a) => a.what === 'displays:register').length).toBe(1)
    expect(localStorage.getItem('it.display.session')).toBe('session-3')
    expect(host.textContent).toContain('Paired as yours')
    expect(host.textContent).not.toContain('Something went wrong')
    expect(errors).toEqual([])
  })

  test('a refusal that comes back however often the backend says this browser is paired is not asked about for ever, and is then written down as an error', async () => {
    cookie = CODES.ownercode00000000001!
    vi.resetModules()
    const { ConvexError } = await import('convex/values')
    watched['artifacts:get'] = () => {
      throw new ConvexError({ code: 'unauthenticated', message: 'This browser is not paired.' })
    }
    await start('/p/plan')
    await settle()
    await settle()
    expect(names()).not.toContain('/session/end')
    expect(names().filter((n) => n === '/session/token').length).toBeLessThan(6)
    expect(host.textContent).toContain('Something went wrong.')
    expect(button('Start again')).toBeDefined()
    expect(errors.map(([error]) => (error as { data?: { code?: string } }).data?.code)).toEqual(['unauthenticated'])
  })
})

describe('something that failed while the site was being shown', () => {
  /** The backend refuses the owner their machines, which their first screen asks for, until the test says the trouble is over. */
  const troubled = async () => {
    const { ConvexError } = await import('convex/values')
    const trouble = { over: false }
    watched['machines:list'] = () => {
      if (!trouble.over) throw new ConvexError({ code: 'limit', message: 'Too much is being asked at once. Try again in a moment.' })
      return []
    }
    return trouble
  }

  test('what could not be shown can be tried again, and is shown once the backend answers', async () => {
    cookie = CODES.ownercode00000000001!
    const trouble = await troubled()
    await start()
    expect(host.textContent).toContain('That did not work')
    expect(host.textContent).toContain('Too much is being asked at once. Try again in a moment.')
    // The trouble passes, and nothing on the screen finds that out by itself
    trouble.over = true
    await settle()
    expect(host.textContent).toContain('That did not work')
    expect(button('Try again')).toBeDefined()
    await press('Try again')
    expect(host.textContent).not.toContain('That did not work')
    expect(host.textContent).toContain('What should I make?')
  })

  test('the way back to the pages shows them where it was the pages that could not be shown, and a page that is not there is offered nothing to try again', async () => {
    cookie = CODES.ownercode00000000001!
    const trouble = await troubled()
    await start()
    expect(host.textContent).toContain('That did not work')
    trouble.over = true
    await press('Back to your pages')
    expect(location.pathname).toBe('/')
    expect(host.textContent).not.toContain('That did not work')
    expect(host.textContent).toContain('What should I make?')
    // A page that was deleted is said to be that, and asking for it again would find it no more there
    await act(async () => root.unmount())
    host.remove()
    const { ConvexError } = await import('convex/values')
    watched['artifacts:get'] = () => {
      throw new ConvexError({ code: 'not_found', message: 'There is no such page.' })
    }
    await start('/p/gone')
    expect(host.textContent).toContain('No such page')
    expect(host.textContent).toContain('It may have been deleted, or the address is wrong.')
    expect(button('Try again')).toBeUndefined()
    await press('Back to your pages')
    expect(location.pathname).toBe('/')
    expect(host.textContent).toContain('What should I make?')
  })

  test('a page that is taken away while it is on the screen, as a tour’s pages are when the tour is over, sends the screen back to the person’s pages and not to "No such page"', async () => {
    cookie = CODES.ownercode00000000001!
    const { ConvexError } = await import('convex/values')
    let there = true
    watched['artifacts:get'] = () => {
      if (!there) throw new ConvexError({ code: 'not_found', message: 'No such page.' })
      return { id: 'page-1', slug: 'tour-menu', title: 'The It tour', version: 1, updatedAt: Date.now(), agent: 'pi', machine: 'here', run: null, pending: 0 }
    }
    await start('/p/tour-menu')
    expect(location.pathname).toBe('/p/tour-menu')
    expect(host.textContent).toContain('The It tour')
    // The agent takes the page away, and the site is told as it is told of anything it watches
    there = false
    const react = await import('react')
    const { App } = await import('./app')
    await act(async () => {
      root.render(react.createElement(App))
      await tick()
    })
    await settle()
    expect(location.pathname).toBe('/')
    expect(host.textContent).not.toContain('No such page')
  })

  test('the site does not load itself afresh while something done on a page is in this tab alone: the person is told it would be lost, and it is done once that has been sent', async () => {
    cookie = CODES.ownercode00000000001!
    let answerTheClick!: (said: { actionId: string }) => void
    answers['actions:submit'] = () => new Promise((done) => (answerTheClick = done))
    await start()
    const { submit } = await import('./outbox')
    // Something is done on a page while this browser can store nothing more, and the backend has yet to answer it
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const envelope = { v: 1 as const, clientActionId: 'click-0001', name: 'answer', payload: '{"n":1}', contentVersion: 1 }
    const sent = submit(client as never, 'user-1', 'page-1', envelope)
    full.mockRestore()
    await settle()
    // Then what the whole site stands on fails, as it does while the backend is being brought up to date
    watched['artifacts:list'] = () => {
      throw new Error('the backend is in trouble')
    }
    vi.useFakeTimers()
    try {
      await act(async () => button('More')!.click())
      await act(async () => button('Settings')!.click())
      expect(host.textContent).toContain('Something went wrong.')
      // The site does not start again by itself, however long it waits: that is the person's to do, who is told what it would cost
      await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)))
      expect(names()).not.toContain('/')
      expect(host.textContent).toContain('Something you did here has not been sent yet. Starting again now would lose it.')
      expect(button('Start again')).toBeDefined()
      // The backend takes the click: there is nothing left to lose, and the site puts itself right as it does otherwise
      await act(async () => {
        answerTheClick({ actionId: 'action-1' })
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(await sent).toEqual({ actionId: 'action-1' })
      expect(host.textContent).not.toContain('has not been sent yet')
      expect(names()).toContain('/')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('erasing everything', () => {
  test('the browser that asked for it keeps nothing of It’s, and is told what was done and how It is used again', async () => {
    cookie = CODES.ownercode00000000001!
    // The backend ends every session in the asking itself
    answers['account:requestDeletion'] = () => {
      cookie = null
      return null
    }
    await start('/settings')
    expect(Object.keys(localStorage).filter((name) => name.startsWith('it.')).length).toBeGreaterThan(2)
    // The phrase is asked for in a dialog of its own, which the row's button opens
    await press('Erase…')
    const phrase = host.querySelector('input[aria-label="Type erase everything to confirm"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(phrase, 'erase everything')
      phrase.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await press('Erase everything')
    await settle()
    expect(asked.find((a) => a.what === 'account:requestDeletion')!.args).toEqual({ confirm: 'erase everything', user: 'user-1' })
    expect(host.querySelector('[role="status"]')!.textContent).toBe('Everything It held is being erased. This browser is not paired with It.')
    // `it site` alone would be refused: the machine has to be set up again first
    expect(host.querySelector('.copyable-text')!.textContent).toBe('it setup && it site')
    // All that is left of the site's is the name of the session's cookie, kept a day to have the cookie cleared again if need be
    expect([...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((name) => name.startsWith('it.'))).toEqual(['it.cookies'])
    expect(JSON.parse(localStorage.getItem('it.cookies')!).map((o: { id: string }) => o.id)).toEqual(['session-1'])
  })

  /** What the site keeps in either of the browser's stores, by name, but for the names of the sessions whose cookies are still to be cleared. */
  const kept = () => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((name) => name.startsWith('it.') && name !== 'it.cookies').sort()
  const confirmErasing = async () => {
    // The phrase is asked for in a dialog of its own, which the row's button opens
    await press('Erase…')
    const phrase = host.querySelector('input[aria-label="Type erase everything to confirm"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(phrase, 'erase everything')
      phrase.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await press('Erase everything')
    await settle()
  }

  test('a click that was on its way when the person erased everything is not put back in the browser by the refusal that comes for it afterwards', async () => {
    cookie = CODES.ownercode00000000001!
    const { ConvexError } = await import('convex/values')
    let refuseTheClick!: (why: unknown) => void
    answers['actions:submit'] = () => new Promise((_, no) => (refuseTheClick = no))
    answers['account:requestDeletion'] = () => {
      cookie = null
      return null
    }
    await start('/settings')
    const { submit } = await import('./outbox')
    // A page in this tab sent something, the page has gone, and the backend has yet to answer
    const envelope = { v: 1 as const, clientActionId: 'click-0001', name: 'answer', payload: '{"typed":"what the person wrote"}', contentVersion: 1 }
    const sent = submit(client as never, 'user-1', 'page-1', envelope, () => false).catch((e: unknown) => e)
    await settle()
    expect(kept()).toContain('it.outbox.user-1.page-1.click-0001')
    await confirmErasing()
    expect(kept()).toEqual([])
    // Its session is over by now, and the click is refused as nobody's
    refuseTheClick(new ConvexError({ code: 'unauthenticated', message: 'This browser is not paired.' }))
    expect(await sent).toBeInstanceOf(Error)
    await settle()
    expect(kept()).toEqual([])
    expect(JSON.stringify({ ...localStorage })).not.toContain('what the person wrote')
  })

  test('the session’s cookie is let go of though the backend could not be told at the time: its name outlasts the erasing, and the session is named once the backend answers again', async () => {
    cookie = CODES.ownercode00000000001!
    answers['account:requestDeletion'] = () => {
      cookie = null
      endFails = true
      return null
    }
    await start('/settings')
    await confirmErasing()
    expect(kept()).toEqual([])
    expect(asked.filter((a) => a.what === '/session/end').length).toBe(2)
    // The connection is back: the site asks what the browser is, and names the session it had, though it keeps that session's id no more
    asked.length = 0
    endFails = false
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      await tick()
    })
    expect(asked.filter((a) => a.what.startsWith('/session/'))).toEqual([{ what: '/session/token' }, { what: '/session/end', args: { session: 'session-1' } }])
    // And names it each time it finds it is not paired, for the day the name is kept: an answer still on its way could give the cookie again
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      await tick()
    })
    expect(asked.filter((a) => a.what === '/session/end').length).toBe(2)
    expect(kept()).toEqual([])
    expect(host.textContent).toContain('Everything It held is being erased')
  })

  test('an erasing whose answer comes after It was set up again, and the browser paired for the new person in another tab, removes nothing of theirs', async () => {
    cookie = CODES.ownercode00000000001!
    let answerTheErasing!: (done: null) => void
    answers['account:requestDeletion'] = () => new Promise((done) => (answerTheErasing = done))
    const session = await start('/settings')
    await confirmErasing()
    // Everything was erased and It set up again. Another tab of this browser was paired for the new
    // person: it let go of what was the erased person's, is a display of its own, and has a click to send
    for (const name of Object.keys(localStorage)) if (name.startsWith('it.')) localStorage.removeItem(name)
    cookie = { session: 'session-9', role: 'owner', user: 'user-2' }
    const click = {
      user: 'user-2',
      artifactId: 'page-9',
      at: Date.now(),
      left: true,
      envelope: { v: 1, clientActionId: 'click-0009', name: 'answer', payload: '{"typed":"the new person’s"}', contentVersion: 1 },
    }
    localStorage.setItem('it.person', 'user-2')
    localStorage.setItem('it.person.session', 'session-9')
    localStorage.setItem('it.display', 'the-new-persons-display-key')
    localStorage.setItem('it.display.session', 'session-9')
    localStorage.setItem('it.outbox.user-2.page-9.click-0009', JSON.stringify(click))
    sessionStorage.setItem('it.shownAt.user-1', '7')
    // Only now does the answer to the erasing reach the tab that asked for it
    asked.length = 0
    await act(async () => {
      answerTheErasing(null)
      await tick()
    })
    // The new person's display is the display it was, and whose the browser is has not changed
    expect([localStorage.getItem('it.person'), localStorage.getItem('it.display')]).toEqual(['user-2', 'the-new-persons-display-key'])
    expect(sessionStorage.getItem('it.shownAt.user-1')).toBeNull()
    await settle()
    await settle()
    // The tab that asked is the new person's by now: it ended nothing of theirs, and says nothing of an erasing
    expect(session.current()).toMatchObject({ paired: true, user: 'user-2', session: 'session-9' })
    expect(cookie).toEqual({ session: 'session-9', role: 'owner', user: 'user-2' })
    expect(host.textContent).not.toContain('Everything It held is being erased')
    expect(localStorage.getItem('it.display')).toBe('the-new-persons-display-key')
    // And their click was not thrown away: it is sent as theirs, as any click kept for later is
    expect(asked.filter((a) => a.what === 'actions:submit').map((a) => [a.args.artifactId, a.args.displayKey, a.args.envelope.clientActionId])).toEqual([
      ['page-9', 'the-new-persons-display-key', 'click-0009'],
    ])
    expect(errors).toEqual([])
  })

  test('another tab of the browser that asked lets go of what it keeps to itself, and shows how to pair', async () => {
    cookie = CODES.ownercode00000000001!
    await start()
    sessionStorage.setItem('it.shownAt.user-1', '7')
    expect(kept()).toContain('it.shownAt.user-1')
    // In the other tab the person erases everything: it removes what the tabs share, says for whom, and the session is over
    for (const name of Object.keys(localStorage)) if (name.startsWith('it.')) localStorage.removeItem(name)
    cookie = null
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'it.letgo', newValue: 'user-1' }))
      await tick()
    })
    await settle()
    expect(host.textContent).toContain('Connect this browser')
    expect(kept()).toEqual([])
    expect(errors).toEqual([])
  })
})

describe('signing out', () => {
  const signOut = async () => {
    await press('More')
    await press('Sign out')
    await settle()
  }

  test('the backend is told to stop this display’s pages before the session is ended, and the browser then shows how to pair', async () => {
    cookie = CODES.ownercode00000000001!
    await start()
    asked.length = 0
    await signOut()
    const order = names().filter((n) => ['displays:signOut', 'displays:signOutConfirmed', '/session/end'].includes(n))
    // The session is ended last. It is named once more when the browser is found not to be paired, in case its cookie was given again meanwhile
    expect(order).toEqual(['displays:signOut', 'displays:signOutConfirmed', '/session/end', '/session/end'])
    expect(asked.find((a) => a.what === 'displays:signOut')!.args).toEqual({ key: localStorage.getItem('it.display') })
    expect(host.textContent).toContain('Connect this browser')
    // It was confirmed that the pages had stopped, so nothing is said about their going on a while
    expect(host.textContent).not.toContain('may go on working')
    // The display's key is kept: paired again, this browser is the display it was
    expect(localStorage.getItem('it.display')).not.toBeNull()
  })

  test('a fetch of the token a display signs out with that met trouble is made once more by itself, and the token is kept with nothing written to the console as an error', async () => {
    cookie = CODES.ownercode00000000001!
    // The moment before the second asking, which is otherwise not the same for any two tabs, at its shortest
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let fetches = 0
    const token = answers['displays:signOutToken']!
    answers['displays:signOutToken'] = (args) =>
      ++fetches === 1 ? Promise.reject(new Error('[CONVEX A(displays:signOutToken)] [Request ID: 0123456789abcdef] Server Error')) : token(args)
    await start()
    const kept = () => JSON.stringify({ ...localStorage }).includes('sign-out-token')
    expect([fetches, kept()]).toEqual([1, false])
    await vi.waitFor(() => expect([fetches, kept()]).toEqual([2, true]), 5000)
    expect(errors).toEqual([])
  })

  test('when the backend could not be told and there is no token to tell it later, the browser stays paired and says so', async () => {
    cookie = CODES.ownercode00000000001!
    answers['displays:signOut'] = () => Promise.reject(new Error('no connection'))
    answers['displays:signOutToken'] = () => Promise.reject(new Error('no connection'))
    await start()
    asked.length = 0
    await signOut()
    expect(names()).not.toContain('/session/end')
    expect(host.textContent).toContain(
      'This browser could not be signed out, because It could not be reached to end its pairing. It is still paired with It: try again when the connection is back, or stay paired.',
    )
  })

  test('when the session itself could not be ended, the person is told that the browser is still paired', async () => {
    cookie = CODES.ownercode00000000001!
    endFails = true
    await start()
    await signOut()
    expect(names()).toContain('/session/end')
    expect(host.textContent).toContain(
      'This browser could not be signed out, because It could not be reached to end its pairing. It is still paired with It: try again when the connection is back, or stay paired.',
    )
    expect(button('Try again')).toBeDefined()
    expect(button('Stay paired')).toBeDefined()
  })
})
