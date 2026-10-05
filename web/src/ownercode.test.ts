// A screen's code in the address a browser was opened at. An address can be opened anywhere,
// so the code is asked about and not redeemed. What the site must get right: the owner who
// opens it in their own browser stays the owner, is told in a sentence that the address is for
// the other screen, and nothing is redeemed; any other browser is asked whether it is that
// screen, and the code is redeemed only when the person says so there.
import { getFunctionName } from 'convex/server'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const CODE = 'screencode0000000002'
const SENTENCE = 'This browser is already paired with It as the owner’s, so the code was not used here. Open the address on the other screen.'
const OFFER = 'This address pairs one screen, once. Use it here only if this browser is that screen.'

/** Everything asked of the door and of the backend, in the order it was asked. */
const asked: string[] = []
/** What the door says the code is for, and what it answers when the code is put to be redeemed. */
let codeIs: { status: number; body?: unknown }
let redeemed: { status: number; body?: unknown }
/** The role of the session this browser holds, or none, and what it is once the code has been redeemed. */
let role: 'owner' | 'screen' | null
let roleOnceRedeemed: 'owner' | 'screen' | null
const door = async (path: string) => {
  asked.push(path)
  const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status })
  if (path === '/session/code') return answer(codeIs.status, codeIs.body)
  if (path === '/session/redeem') {
    if (redeemed.status === 200) role = roleOnceRedeemed
    return answer(redeemed.status, redeemed.body)
  }
  if (path === '/session/token')
    return role ? answer(200, { token: 'a-token', expiresIn: 300, user: 'user-1', session: `session-of-${role}`, role }) : answer(401)
  return answer(200)
}

const DISPLAY = { id: 'display-1', name: 'Chrome on Linux', named: false, lastSeenAt: Date.now(), push: false, epoch: 0, showing: null }
const backend = async (fn: unknown, _args?: unknown) => {
  const name = getFunctionName(fn as never)
  asked.push(name)
  return (
    {
      'displays:register': DISPLAY,
      'displays:heartbeat': { now: Date.now() },
      'displays:signOutToken': { token: 'sign-out-token', raisesTo: 1, display: 'display-1' },
    }[name] ?? null
  )
}
const client = {
  mutation: vi.fn(backend),
  query: vi.fn(backend),
  action: vi.fn(backend),
  connectionState: () => ({ isWebSocketConnected: true }),
  subscribeToConnectionState: () => () => {},
}
vi.mock('convex/react', () => ({
  useConvex: () => client,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useMutation: (fn: unknown) => (args: unknown) => client.mutation(fn, args),
  useQuery: (fn: unknown) => ({ 'displays:mine': DISPLAY, 'artifacts:list': [], 'notifications:list': [] })[getFunctionName(fn as never)],
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  vi.resetModules()
  asked.length = 0
  codeIs = { status: 200, body: { role: 'screen' } }
  redeemed = { status: 409, body: { error: 'This browser is already paired as the owner’s.', code: 'already_owner' } }
  role = 'owner'
  roleOnceRedeemed = 'screen'
  localStorage.clear()
  sessionStorage.clear()
  history.replaceState(null, '', `/pair#${CODE}`)
  vi.stubGlobal('fetch', vi.fn(door))
  // This stand-in browser cannot say how the site is being shown
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a screen’s code in the address of the browser that is the owner’s', () => {
  test('is asked about and never put to be redeemed, leaves the browser the owner’s, and is remembered as left unused until the person has read so', async () => {
    const session = await import('./session')
    await session.begin()
    expect(asked).toEqual(['/session/code', '/session/token'])
    expect(location.pathname + location.hash).toBe('/')
    expect(session.current()).toEqual({ loaded: true, paired: true, user: 'user-1', session: 'session-of-owner', role: 'owner', code: 'owner', wait: null })
    // The token is fetched again and again while the site is open, and what is still to be said is not lost by that
    await session.token(true)
    expect(session.current().code).toBe('owner')
    // It is held no more: nothing is redeemed, whatever is pressed
    await session.pairAsScreen()
    expect(asked).not.toContain('/session/redeem')
    session.codeSeen()
    expect(session.current()).toMatchObject({ paired: true, role: 'owner', code: null })
  })

  test('typed in the owner’s own browser, it is left unused by the backend, and that is said in the same sentence', async () => {
    history.replaceState(null, '', '/')
    const session = await import('./session')
    await session.begin()
    await session.pair(CODE)
    expect(asked).toEqual(['/session/token', '/session/redeem'])
    expect(session.current()).toMatchObject({ paired: true, role: 'owner', code: 'owner' })
  })

  test('an answer of that status that does not say why is trouble, and the code is put again', async () => {
    vi.useFakeTimers()
    history.replaceState(null, '', '/')
    redeemed = { status: 409, body: { error: 'something else' } }
    const session = await import('./session')
    await session.begin()
    const pairing = session.pair(CODE, 4)
    await vi.advanceTimersByTimeAsync(60_000)
    await pairing
    expect(asked.filter((path) => path === '/session/redeem').length).toBe(4)
    // The browser is paired as it was, and what is said of the code is that it could not be judged
    expect(session.current()).toMatchObject({ paired: true, role: 'owner', code: 'trouble' })
  })

  test('is offered, as to any browser that is not the owner’s, to one that turns out not to be paired after all', async () => {
    role = null
    const session = await import('./session')
    await session.begin()
    expect(session.current()).toMatchObject({ loaded: true, paired: false, role: null, code: 'screen' })
    expect(asked).not.toContain('/session/redeem')
  })
})

describe('what the person is shown', () => {
  let root: Root
  let host: HTMLElement
  let act: (work: () => Promise<void>) => Promise<void>
  const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms))
  async function start() {
    const react = await import('react')
    const { createRoot } = await import('react-dom/client')
    const session = await import('./session')
    const { App } = await import('./app')
    act = react.act as typeof act
    void session.begin()
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => {
      root.render(react.createElement(App))
      await tick()
    })
    return session
  }
  const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)
  const press = (label: string) =>
    act(async () => {
      button(label)!.click()
      await tick()
    })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  test('the owner: the site as it was, with a sentence that the address is for the other screen, which goes once it has been read', async () => {
    const session = await start()
    // Everything the owner's browser shows is there: it is paired as it was, and registers as the display it is
    expect([...host.querySelectorAll('nav a')].map((a) => a.textContent)).toEqual(['Pages', 'Machines', 'Displays'])
    expect(asked).toContain('displays:register')
    expect(host.textContent).not.toContain('Connect this browser')
    const notice = host.querySelector('.notice[role="status"]')!
    expect(notice.querySelector('span')!.textContent).toBe(SENTENCE)
    // There is nothing to press that would make this browser a screen
    expect(button('Make this browser a screen of It')).toBeUndefined()
    await press('OK')
    expect(host.querySelector('.notice')).toBeNull()
    expect(session.current()).toMatchObject({ paired: true, role: 'owner', code: null })
    expect(asked).not.toContain('/session/redeem')
  })

  test('the owner at another of the machine’s names, where the browser is not paired: one sentence and a button, and the code is as good as it was until the button is pressed', async () => {
    // No session is held at this address: the owner's is held at `localhost`, which this is not
    role = null
    redeemed = { status: 200, body: { ok: true } }
    await start()
    expect(host.querySelector('.offer[role="status"] span')!.textContent).toBe(OFFER)
    expect(host.textContent).toContain('Connect this browser')
    expect(asked.filter((path) => path.startsWith('/session/'))).toEqual(['/session/code', '/session/token'])
    // Nothing more is asked however long the tab is left open, and closing it leaves the code for the screen it was made for
    await act(async () => tick(200))
    expect(asked).not.toContain('/session/redeem')
  })

  test('the screen the code was made for: pressing the button redeems it, and the browser is a screen', async () => {
    role = null
    redeemed = { status: 200, body: { ok: true } }
    const session = await start()
    await press('Make this browser a screen of It')
    expect(asked.filter((path) => path === '/session/redeem').length).toBe(1)
    expect(session.current()).toMatchObject({ paired: true, role: 'screen', code: null })
    expect(host.querySelector('.offer')).toBeNull()
    expect([...host.querySelectorAll('nav a')].map((a) => a.textContent)).toEqual(['Pages'])
  })

  test('a browser that is paired as a screen already is asked too, under the bar, and may decline', async () => {
    role = 'screen'
    redeemed = { status: 200, body: { ok: true } }
    const session = await start()
    expect(host.querySelector('.notice[role="status"] span')!.textContent).toBe(OFFER)
    expect([...host.querySelectorAll('.notice button')].map((b) => b.textContent)).toEqual(['Make this browser a screen of It', 'Not now'])
    await press('Not now')
    expect(host.querySelector('.notice')).toBeNull()
    expect(asked).not.toContain('/session/redeem')
    expect(session.current()).toMatchObject({ paired: true, role: 'screen', code: null })
  })

  test('a code that has been used by the time the button is pressed is said to be, on the screen that says how to pair', async () => {
    role = null
    redeemed = { status: 401, body: { error: 'That code is wrong, used or expired. Ask for a new one.' } }
    await start()
    await press('Make this browser a screen of It')
    expect(host.querySelector('.offer')).toBeNull()
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('That code is wrong, has already been used, or has run out. Get a new one and try again.')
  })
})
