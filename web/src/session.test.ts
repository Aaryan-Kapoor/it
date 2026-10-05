// This browser's pairing with It, against a stand-in for the door: what counts as paired, when
// the token for the live connection is fetched again, signing out, and redeeming a code.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

interface Asked {
  path: string
  method?: string
  site?: string
  body?: string
}
type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | Error
/** A stand-in for the door: each request is answered by what `answer` gives for it, and all of them are remembered. */
function door(answer: (asked: Asked) => Answer | Promise<Answer>) {
  const asked: Asked[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const one: Asked = { path, method: init.method, site: new Headers(init.headers).get('x-it-site') ?? undefined, body: init.body as string | undefined }
      asked.push(one)
      const said = await answer(one)
      if (said instanceof Error) throw said
      return new Response(said.body === undefined ? null : JSON.stringify(said.body), { status: said.status, headers: said.headers })
    }),
  )
  return { asked, to: (path: string) => asked.filter((a) => a.path === path) }
}
let made = 0
/** What the backend answers a paired browser: a token of five minutes, and whose session it is. */
const paired = (over: Record<string, unknown> = {}): Answer => ({
  status: 200,
  body: { token: `token-${++made}`, expiresIn: 300, user: 'user-1', session: 'session-1', role: 'owner', ...over },
})
const refused: Answer = { status: 401, body: { error: 'unauthenticated' } }
const load = () => import('./session')

/**
 * What each site that a test loaded listens for on the window. A site loaded for one test is
 * another tab to the next, and would answer what the next is told with requests of its own, so
 * what it listens with is taken off again when its test is over.
 */
const listening: Parameters<typeof window.addEventListener>[] = []
beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  sessionStorage.clear()
  made = 0
  history.replaceState(null, '', '/')
  const listen = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((...asked: Parameters<typeof window.addEventListener>) => {
    listening.push(asked)
    listen(...asked)
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const [kind, listener, how] of listening.splice(0)) window.removeEventListener(kind, listener, how)
})

describe('whether this browser is paired', () => {
  test('a browser the backend gives a token to is paired, and is told who it is paired as', async () => {
    const d = door(() => paired({ role: 'screen' }))
    const session = await load()
    expect(session.current()).toMatchObject({ loaded: false, paired: false })
    await session.begin()
    expect(session.current()).toEqual({ loaded: true, paired: true, user: 'user-1', session: 'session-1', role: 'screen', code: null, wait: null })
    // Asked as the site asks: a request no other site's page can make look like this one
    expect(d.asked).toEqual([{ path: '/session/token', method: 'POST', site: '1', body: undefined }])
  })

  test('a 401 means this browser is not paired, and there is no token to give', async () => {
    door(() => refused)
    const session = await load()
    await session.begin()
    expect(session.current()).toEqual({ loaded: true, paired: false, user: null, session: null, role: null, code: null, wait: null })
    expect(await session.token(false)).toBeNull()
  })

  test('until the door has answered, nothing is said either way, and it is asked again', async () => {
    vi.useFakeTimers()
    let up = false
    const d = door(() => (up ? paired() : new Error('no connection')))
    const session = await load()
    const beginning = session.begin()
    await vi.advanceTimersByTimeAsync(2500)
    expect(session.current().loaded).toBe(false)
    expect(d.asked.length).toBeGreaterThan(1)
    // An answer that is neither a token nor a refusal says nothing either
    up = true
    await vi.advanceTimersByTimeAsync(20_000)
    await beginning
    expect(session.current()).toMatchObject({ loaded: true, paired: true })
  })

  test('a role the site does not know is given the least a session may do', async () => {
    door(() => paired({ role: 'admin' }))
    const session = await load()
    await session.begin()
    expect(session.current().role).toBe('screen')
  })
})

describe('the token for the live connection', () => {
  test('it is kept while it has time left, and fetched again before it runs out', async () => {
    vi.useFakeTimers()
    const d = door(() => paired())
    const session = await load()
    await session.begin()
    expect(await session.token(false)).toBe('token-1')
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(await session.token(false)).toBe('token-1')
    expect(d.asked.length).toBe(1)
    // Four and a half minutes in, it has half a minute left: that is too little to begin anything with
    await vi.advanceTimersByTimeAsync(90_000)
    expect(await session.token(false)).toBe('token-2')
    expect(d.asked.length).toBe(2)
    // And the new one is kept in its turn
    expect(await session.token(false)).toBe('token-2')
    expect(d.asked.length).toBe(2)
  })

  test('it is fetched at once when the connection asks for a new one, however long the kept one has left', async () => {
    const d = door(() => paired())
    const session = await load()
    await session.begin()
    expect(await session.token(true)).toBe('token-2')
    expect(await session.token(true)).toBe('token-3')
    expect(d.to('/session/token').every((a) => a.method === 'POST' && a.site === '1')).toBe(true)
  })

  test('two askings at the same moment are one request', async () => {
    const d = door(() => paired())
    const session = await load()
    await session.begin()
    expect(await Promise.all([session.token(true), session.token(true)])).toEqual(['token-2', 'token-2'])
    expect(d.asked.length).toBe(2)
  })

  test('a session that has ended is found out the next time a token is asked for', async () => {
    let ended = false
    door(() => (ended ? refused : paired()))
    const session = await load()
    await session.begin()
    ended = true
    expect(await session.token(true)).toBeNull()
    expect(session.current()).toMatchObject({ loaded: true, paired: false, user: null, session: null, role: null })
  })

  test('trouble reaching the door says nothing about the pairing, and the token last given is all there is to give', async () => {
    let trouble: Answer | null = null
    door(() => trouble ?? paired())
    const session = await load()
    await session.begin()
    trouble = new Error('no connection')
    expect(await session.token(true)).toBe('token-1')
    trouble = { status: 503 }
    expect(await session.token(true)).toBe('token-1')
    // Nor does an answer that is not what the backend gives
    trouble = { status: 200, body: { hello: 'there' } }
    expect(await session.token(true)).toBe('token-1')
    expect(session.current()).toMatchObject({ paired: true, session: 'session-1' })
  })

  test('a token asked for under one session is not given to a connection once another session is the one here', async () => {
    let now = 'session-1'
    door(() => paired({ session: now }))
    const session = await load()
    await session.begin()
    now = 'session-2'
    expect(await session.tokenFor('session-1', true)).toBeNull()
    expect(session.current().session).toBe('session-2')
    expect(await session.tokenFor('session-2', false)).toBe('token-2')
  })
})

describe('a token asked for while what the browser is was being found out afresh', () => {
  /** A door that holds each answer to a request for a token until it is let go, once `slow` is set. */
  function slowDoor(session = { now: 'session-1' as string | null }) {
    const held: (() => void)[] = []
    const state = { slow: false, session, end: { status: 200, body: { ok: true } } as Answer }
    const d = door(async (a) => {
      if (state.slow) await new Promise<void>((r) => held.push(r))
      if (a.path === '/session/end') return state.end
      return state.session.now ? paired({ session: state.session.now }) : refused
    })
    /** Lets every answer that is being held go, and those that are asked for while that is done. */
    const letAllGo = async () => {
      state.slow = false
      for (let n = 0; n < 5; n++) {
        for (const go of held.splice(0)) go()
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    return { d, held, state, letAllGo }
  }
  const anotherTabChanged = () => window.dispatchEvent(new StorageEvent('storage', { key: 'it.session', newValue: String(Date.now()) }))

  test('it comes to the token of the session the browser has, and never to none, when a refusal sent the tab to ask afresh', async () => {
    const { held, state, letAllGo } = slowDoor()
    const session = await load()
    await session.begin()
    state.slow = true
    // The live connection asks for a new token, and while that is on its way the tab asks afresh
    const forTheConnection = session.tokenFor('session-1', true)
    const asking = session.recheck()
    await vi.waitFor(() => expect(held.length).toBe(2))
    await letAllGo()
    await asking
    expect(await forTheConnection).toMatch(/^token-\d+$/)
    expect(session.current()).toMatchObject({ paired: true, session: 'session-1' })
  })

  test('so it does when another tab’s word arrived while it was on its way, and the browser is the session it was', async () => {
    const { held, state, letAllGo } = slowDoor()
    const session = await load()
    await session.begin()
    state.slow = true
    const forTheConnection = session.tokenFor('session-1', true)
    anotherTabChanged()
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(1))
    await letAllGo()
    expect(await forTheConnection).toMatch(/^token-\d+$/)
  })

  test('so it does when a sign-out’s answer arrived late, after the browser was paired again: the connection is given the new session’s token', async () => {
    const now = { now: 'session-1' as string | null }
    const { held, state, letAllGo } = slowDoor(now)
    const session = await load()
    await session.begin()
    // Sign out is pressed, and its answer is on its way
    state.slow = true
    const signing = session.signOut()
    await vi.waitFor(() => expect(held.length).toBe(1))
    const lateAnswer = held.shift()!
    // The browser is paired again in another tab, and this tab learns of it and is that session
    state.slow = false
    now.now = 'session-2'
    anotherTabChanged()
    await vi.waitFor(() => expect(session.current().session).toBe('session-2'))
    // The live connection, begun again under that session, asks for a new token, and the late answer arrives while it is on its way
    state.slow = true
    const forTheConnection = session.tokenFor('session-2', true)
    await vi.waitFor(() => expect(held.length).toBe(1))
    lateAnswer()
    await vi.waitFor(() => expect(held.length).toBe(2))
    await letAllGo()
    expect(await signing).toBe(true)
    expect(await forTheConnection).toMatch(/^token-\d+$/)
    expect(session.current()).toMatchObject({ paired: true, session: 'session-2' })
  })

  test('it is none when the answer that overtook it says the browser is not paired', async () => {
    const now = { now: 'session-1' as string | null }
    const { held, state, letAllGo } = slowDoor(now)
    const session = await load()
    await session.begin()
    state.slow = true
    const forTheConnection = session.tokenFor('session-1', true)
    now.now = null
    anotherTabChanged()
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(1))
    await letAllGo()
    expect(await forTheConnection).toBeNull()
    expect(session.current().paired).toBe(false)
  })

  test('with no token to give and no word of whether the browser is paired, the connection is kept waiting and is not told that it is not', async () => {
    vi.useFakeTimers()
    let now: Answer = paired()
    const d = door(() => now)
    const session = await load()
    await session.begin()
    // Another tab's word lets go of the token that was kept, and the door is then in trouble: it is told to wait, or cannot be reached
    now = { status: 429 }
    anotherTabChanged()
    await vi.advanceTimersByTimeAsync(10)
    let given: string | null | undefined
    void session.tokenFor('session-1', true).then((token) => {
      given = token
    })
    await vi.advanceTimersByTimeAsync(4000)
    now = new Error('no connection')
    await vi.advanceTimersByTimeAsync(8000)
    expect(given).toBeUndefined()
    expect(d.to('/session/token').length).toBeGreaterThan(3)
    // It answers, and the connection has its token
    now = paired()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(given).toMatch(/^token-\d+$/)
    expect(session.current()).toMatchObject({ paired: true, session: 'session-1' })
  })
})

describe('signing out', () => {
  /** A door that ends the session when asked to, and from then on gives no token: the browser holds no session. */
  const ending = (answer: Answer = { status: 200, body: { ok: true } }) => {
    let over = false
    return door((a) => {
      if (a.path !== '/session/end') return over ? refused : paired()
      over = true
      return answer
    })
  }

  test('it ends the session this browser holds, by naming it, and from then on the browser is not paired', async () => {
    const d = ending()
    const session = await load()
    await session.begin()
    expect(await session.signOut()).toBe(true)
    expect(d.to('/session/end')[0]).toEqual({ path: '/session/end', method: 'POST', site: '1', body: JSON.stringify({ session: 'session-1' }) })
    expect(session.current()).toEqual({ loaded: true, paired: false, user: null, session: null, role: null, code: null, wait: null })
    // The session's name is kept, apart from the session the browser holds, until its cookie is surely cleared
    expect([localStorage.getItem('it.person.session'), JSON.parse(localStorage.getItem('it.cookies')!).map((o: { id: string }) => o.id)]).toEqual([
      null,
      ['session-1'],
    ])
    // The token that was kept is not handed out again
    const before = d.to('/session/token').length
    await session.token(false)
    expect(d.to('/session/token').length).toBe(before + 1)
  })

  test('a session that was already over counts as signed out', async () => {
    ending(refused)
    const session = await load()
    await session.begin()
    expect(await session.signOut()).toBe(true)
    expect(session.current().paired).toBe(false)
  })

  test('told that the browser holds another session, it has ended nothing: it asks what this browser is now, and is that', async () => {
    // The browser was paired again in another tab, and holds that pairing
    let now = 'session-1'
    const d = door((a) => (a.path === '/session/end' ? { status: 409, body: { code: 'another_session' } } : paired({ session: now })))
    const session = await load()
    await session.begin()
    now = 'session-2'
    expect(await session.signOut()).toBe(true)
    expect(d.to('/session/end').map((a) => a.body)).toEqual([JSON.stringify({ session: 'session-1' })])
    expect(session.current()).toMatchObject({ loaded: true, paired: true, session: 'session-2' })
    // And the token it hands out from then on is the new session's
    expect(await session.tokenFor('session-1', false)).toBeNull()
    expect(await session.tokenFor('session-2', false)).toBe('token-2')
  })

  test('a sign-out the backend never heard of is said to have failed, and the browser stays as it was', async () => {
    let answer: Answer = new Error('no connection')
    door((a) => (a.path === '/session/end' ? answer : paired()))
    const session = await load()
    await session.begin()
    expect(await session.signOut()).toBe(false)
    answer = { status: 500 }
    expect(await session.signOut()).toBe(false)
    expect(session.current()).toMatchObject({ paired: true, session: 'session-1' })
  })

  test('a token that was on its way when the browser signed out does not pair it again', async () => {
    let give!: (a: Answer) => void
    let slow = false
    let over = false
    door((a) => {
      if (a.path === '/session/end') {
        over = true
        return { status: 200 }
      }
      if (over) return refused
      if (!slow) return paired()
      return new Promise<Answer>((r) => {
        give = r
      })
    })
    const session = await load()
    await session.begin()
    slow = true
    const asked = session.token(true)
    expect(await session.signOut()).toBe(true)
    give(paired())
    expect(await asked).toBeNull()
    expect(session.current().paired).toBe(false)
  })

  test('another tab of this browser is told, and asks for itself whether it is still paired', async () => {
    let ended = false
    const d = door(() => (ended ? refused : paired()))
    const session = await load()
    await session.begin()
    // What the tab that signed out leaves for the others
    ended = true
    window.dispatchEvent(new StorageEvent('storage', { key: 'it.session', newValue: '1' }))
    await vi.waitFor(() => expect(session.current().paired).toBe(false))
    expect(d.to('/session/token').length).toBeGreaterThan(1)
  })

  test('with no word of what the browser is now, a tab that has signed out takes it to be unpaired, and follows the answer when it comes', async () => {
    vi.useFakeTimers()
    let give!: (a: Answer) => void
    let over = false
    door((a) => {
      if (a.path === '/session/end') {
        over = true
        return { status: 200 }
      }
      if (!over) return paired()
      return new Promise<Answer>((r) => {
        give = r
      })
    })
    const session = await load()
    await session.begin()
    const signing = session.signOut()
    await vi.advanceTimersByTimeAsync(3000)
    expect(session.current().paired).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await signing).toBe(true)
    expect(session.current()).toMatchObject({ loaded: true, paired: false, session: null })
    // The browser had been paired again, and the answer that says so arrives at last
    give(paired({ session: 'session-2' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(session.current()).toMatchObject({ paired: true, session: 'session-2' })
  })
})

describe('a sign-out’s answer that arrives after the browser was paired again in another tab', () => {
  /**
   * A door that holds its answer to the sign-out until it is let go, and gives tokens as the
   * session the browser holds at that moment.
   */
  function slowEnd() {
    let letGo!: () => void
    const held = new Promise<void>((r) => {
      letGo = r
    })
    const now = { session: 'session-1' as string | null, tokens: [] as Promise<void>[] }
    const d = door(async (a) => {
      if (a.path === '/session/end') {
        await held
        return { status: 200, body: { ok: true } }
      }
      await Promise.all(now.tokens)
      return now.session ? paired({ session: now.session }) : refused
    })
    return { d, now, letGo }
  }
  /** What another tab leaves for this one when it has paired the browser. */
  const anotherTabPaired = () => window.dispatchEvent(new StorageEvent('storage', { key: 'it.session', newValue: String(Date.now()) }))

  test('this tab has learned of the new pairing already: it stays under it, and ends nothing more', async () => {
    const { d, now, letGo } = slowEnd()
    const session = await load()
    await session.begin()
    const signing = session.signOut()
    now.session = 'session-2'
    anotherTabPaired()
    await vi.waitFor(() => expect(session.current().session).toBe('session-2'))
    letGo()
    expect(await signing).toBe(true)
    expect(session.current()).toMatchObject({ loaded: true, paired: true, session: 'session-2' })
    expect(d.to('/session/end').map((a) => a.body)).toEqual([JSON.stringify({ session: 'session-1' })])
    expect(await session.tokenFor('session-2', false)).not.toBeNull()
  })

  test('this tab is still finding out what the browser is: it waits for that, and is the new pairing', async () => {
    const { now, letGo } = slowEnd()
    const session = await load()
    await session.begin()
    const signing = session.signOut()
    // The other tab's word arrives, and the token this tab asks for is slow in coming
    let give!: () => void
    now.tokens.push(
      new Promise<void>((r) => {
        give = r
      }),
    )
    now.session = 'session-2'
    anotherTabPaired()
    letGo()
    await new Promise((r) => setTimeout(r, 20))
    expect(session.current()).toMatchObject({ paired: true, session: 'session-1' })
    give()
    expect(await signing).toBe(true)
    expect(session.current()).toMatchObject({ loaded: true, paired: true, session: 'session-2' })
  })

  test('this tab has not been told yet: it asks what the browser is before it says anything, and is the new pairing', async () => {
    const { now, letGo } = slowEnd()
    const session = await load()
    await session.begin()
    const seen: boolean[] = []
    const signing = session.signOut()
    now.session = 'session-2'
    letGo()
    // Watched all the while: at no moment does the tab take the browser to be unpaired
    const watching = setInterval(() => seen.push(session.current().paired), 1)
    expect(await signing).toBe(true)
    clearInterval(watching)
    expect(session.current()).toMatchObject({ loaded: true, paired: true, session: 'session-2' })
    expect(seen.includes(false)).toBe(false)
  })
})

describe('a refusal from the backend as if this browser were nobody', () => {
  test('whether the browser is paired is asked afresh and followed, and no session is ended because of it', async () => {
    let now: Answer | null = null
    const d = door(() => now ?? paired())
    const session = await load()
    await session.begin()
    // Paired again in another tab: the cookie is the new session's
    now = paired({ session: 'session-2', role: 'screen' })
    await session.recheck()
    expect(session.current()).toMatchObject({ paired: true, session: 'session-2', role: 'screen' })
    expect(d.to('/session/end')).toEqual([])
    // The session really is over
    now = refused
    await session.recheck()
    expect(session.current()).toMatchObject({ loaded: true, paired: false, session: null })
    // Only then, on the backend's word that nothing the browser holds is a session, is the one it held named, for its cookie to be cleared
    await vi.waitFor(() => expect(d.to('/session/end').length).toBe(1))
    expect(d.asked.map((a) => a.path).filter((path) => path !== '/session/person')).toEqual([
      '/session/token',
      '/session/token',
      '/session/token',
      '/session/end',
    ])
    expect(d.to('/session/end')[0]!.body).toBe(JSON.stringify({ session: 'session-2' }))
  })

  test('it is asked until the backend has answered one way or the other', async () => {
    vi.useFakeTimers()
    let now: Answer | null = null
    const d = door(() => now ?? paired())
    const session = await load()
    await session.begin()
    now = new Error('no connection')
    let done = false
    const asking = session.recheck().then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect([done, session.current().session]).toEqual([false, 'session-1'])
    // With no answer, nothing is said of the session it holds
    expect(d.to('/session/end')).toEqual([])
    now = refused
    await vi.advanceTimersByTimeAsync(20_000)
    await asking
    expect(session.current().paired).toBe(false)
  })
})

describe('what this browser keeps for the person it was paired for', () => {
  /** What the site would keep in a browser: which display it is, a click not yet sent, a sign-out still owed, and what was chosen and seen here. */
  const keep = () => {
    localStorage.setItem('it.display', 'a-display-key-000001')
    localStorage.setItem('it.display.session', 'session-1')
    localStorage.setItem('it.person.session', 'session-1')
    localStorage.setItem(
      'it.outbox.user-1.page-1.click-0001',
      JSON.stringify({ user: 'user-1', artifactId: 'page-1', envelope: { payload: '{"typed":"private"}' }, at: Date.now() }),
    )
    localStorage.setItem('it.signout.pending.0f', 'sign-out-token')
    localStorage.setItem('it.pushAsked', 'yes')
    sessionStorage.setItem('it.shownAt.user-1', '7')
    // And something that is not It's, which a browser keeps for the same address
    localStorage.setItem('another-programs', 'kept')
  }
  const kept = () => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].sort()
  const EVERYTHING = [
    'another-programs',
    'it.display',
    'it.display.session',
    'it.outbox.user-1.page-1.click-0001',
    'it.person',
    'it.person.session',
    'it.pushAsked',
    'it.shownAt.user-1',
    'it.signout.pending.0f',
  ]
  /**
   * A door that gives tokens while `now` is a session, and says whether It still holds anything
   * for a person. Asked to end a session, it ends none, as the backend ends none for a browser
   * that holds none: it answers as it does once it has cleared that session's cookie.
   */
  function doorFor(now: { user: string | null; there: Answer }) {
    return door((a) =>
      a.path === '/session/person'
        ? now.there
        : a.path === '/session/end'
          ? now.user
            ? { status: 409 }
            : refused
          : now.user
            ? paired({ user: now.user })
            : refused,
    )
  }
  /**
   * What a browser keeps once its pairing has ended and the person is still there: everything but
   * the session it holds, which it holds no more, with that session's name among those whose
   * cookies are still to be cleared.
   */
  const WITHOUT_ITS_SESSION = [...EVERYTHING.filter((name) => name !== 'it.person.session'), 'it.cookies'].sort()
  /** All that is left of the site's once everything was erased: the names of the sessions whose cookies are still to be cleared. */
  const ERASED = ['another-programs', 'it.cookies']
  /** The sessions whose cookies are still to be cleared, by name. */
  const stillToClear = () => (JSON.parse(localStorage.getItem('it.cookies') ?? '[]') as { id: string }[]).map((o) => o.id)
  test('a browser that is paired notes whom it is paired for, and keeps what it keeps', async () => {
    const d = doorFor({ user: 'user-1', there: { status: 200, body: { there: true } } })
    const session = await load()
    keep()
    await session.begin()
    expect(kept()).toEqual(EVERYTHING)
    expect(localStorage.getItem('it.person')).toBe('user-1')
    expect(d.to('/session/person')).toEqual([])
  })

  test('found not to be paired, it asks whether It still holds anything for that person, and keeps what it keeps while It does', async () => {
    const now = { user: 'user-1' as string | null, there: { status: 200, body: { there: true } } as Answer }
    const d = doorFor(now)
    const session = await load()
    keep()
    await session.begin()
    // The owner ended this browser's pairing: the person is there as before
    now.user = null
    await session.recheck()
    await vi.waitFor(() => expect(d.to('/session/person').length).toBe(1))
    expect(d.to('/session/person')[0]).toEqual({ path: '/session/person', method: 'POST', site: '1', body: JSON.stringify({ person: 'user-1' }) })
    await new Promise((r) => setTimeout(r, 10))
    // Paired again, it is the display it was, and sends what it had not sent
    expect(kept()).toEqual(WITHOUT_ITS_SESSION)
  })

  test('told that everything was erased, it lets go of all it kept, and of nothing that is not It’s', async () => {
    const now = { user: 'user-1' as string | null, there: { status: 200, body: { there: false } } as Answer }
    const d = doorFor(now)
    const session = await load()
    keep()
    await session.begin()
    now.user = null
    await session.recheck()
    await vi.waitFor(() => expect(kept()).toEqual(ERASED))
    expect(stillToClear()).toEqual(['session-1'])
    // It has nobody left to ask about
    await session.recheck()
    expect(d.to('/session/person').length).toBe(1)
  })

  test('a browser that was closed while everything was erased learns of it when the site is next opened in it', async () => {
    const d = doorFor({ user: null, there: { status: 200, body: { there: false } } })
    keep()
    localStorage.setItem('it.person', 'user-1')
    const session = await load()
    await session.begin()
    await vi.waitFor(() => expect(kept()).toEqual(ERASED))
    // The session it held when it was closed is named to the backend, which clears the cookie of a session that is no more
    expect(d.asked.map((a) => a.path)).toEqual(['/session/token', '/session/end', '/session/person'])
    expect(d.to('/session/end')[0]).toEqual({ path: '/session/end', method: 'POST', site: '1', body: JSON.stringify({ session: 'session-1' }) })
  })

  test('nothing is let go of on anything but the backend’s own word that the person is gone', async () => {
    for (const there of [
      new Error('no connection'),
      { status: 503 },
      { status: 401 },
      { status: 200, body: {} },
      { status: 200, body: { there: 'no' } },
    ] as Answer[]) {
      vi.resetModules()
      localStorage.clear()
      sessionStorage.clear()
      const d = doorFor({ user: null, there })
      keep()
      localStorage.setItem('it.person', 'user-1')
      const session = await load()
      await session.begin()
      await vi.waitFor(() => expect(d.to('/session/person').length).toBe(1))
      await new Promise((r) => setTimeout(r, 10))
      expect(kept()).toEqual(WITHOUT_ITS_SESSION)
    }
  })

  test('a browser that keeps things for nobody, and finds it is not paired, keeps nothing of the site’s in either of its stores', async () => {
    const d = doorFor({ user: null, there: { status: 200, body: { there: true } } })
    // What a tab wrote before it heard that everything was let go of, and what a tab that was closed then comes back with
    keep()
    localStorage.removeItem('it.person.session')
    const session = await load()
    await session.begin()
    expect(session.current()).toMatchObject({ loaded: true, paired: false })
    expect(kept()).toEqual(['another-programs'])
    // There is nobody to ask about, and no session to name
    expect(d.asked.map((a) => a.path)).toEqual(['/session/token'])
  })

  test('a tab told by another that everything was let go of lets go of what it keeps to itself, and asks what the browser is now', async () => {
    const now = { user: 'user-1' as string | null, there: { status: 200, body: { there: false } } as Answer }
    const d = doorFor(now)
    const session = await load()
    keep()
    await session.begin()
    expect(session.current()).toMatchObject({ paired: true, session: 'session-1' })
    // In the other tab everything was erased: it removed what every tab shares, and said for whom
    for (const name of Object.keys(localStorage)) if (name.startsWith('it.')) localStorage.removeItem(name)
    now.user = null
    window.dispatchEvent(new StorageEvent('storage', { key: 'it.letgo', newValue: 'user-1' }))
    // At once, before anything is answered
    expect(kept()).toEqual(['another-programs'])
    await vi.waitFor(() => expect(session.current()).toMatchObject({ loaded: true, paired: false }))
    // The session this tab was under is named, though the browser kept its id no more, and its name is all that is left
    await vi.waitFor(() => expect(d.to('/session/end').map((a) => a.body)).toEqual([JSON.stringify({ session: 'session-1' })]))
    await new Promise((r) => setTimeout(r, 10))
    expect([kept(), stillToClear()]).toEqual([ERASED, ['session-1']])
  })

  test('the name of a session that is over outlasts the erasing, and is named on every later visit until a day has passed and the backend has answered', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let reachable = false
    const d = door((a) =>
      a.path === '/session/person' ? { status: 200, body: { there: false } } : a.path === '/session/end' && !reachable ? new Error('no connection') : refused,
    )
    keep()
    localStorage.setItem('it.person', 'user-1')
    // The browser was closed while everything was erased. Opened again, it cannot reach the backend to have its cookie cleared
    await (await load()).begin()
    await vi.waitFor(() => expect(kept()).toEqual(ERASED))
    expect([d.to('/session/end').length, stillToClear()]).toEqual([1, ['session-1']])
    // The tab is closed, and the site is opened again another time: the name was kept, and the session is named
    reachable = true
    vi.resetModules()
    const session = await load()
    await session.begin()
    await vi.waitFor(() => expect(d.to('/session/end').length).toBe(2))
    expect(d.to('/session/end').map((a) => a.body)).toEqual(Array(2).fill(JSON.stringify({ session: 'session-1' })))
    // Answered, the name stays its day: an answer that was on its way could still give the cookie again, and it is named each time
    await session.recheck()
    await vi.waitFor(() => expect(d.to('/session/end').length).toBe(3))
    expect([kept(), stillToClear()]).toEqual([ERASED, ['session-1']])
    // A day on, the backend answers about it once more, and the name goes: the browser keeps nothing of the site's
    vi.setSystemTime(Date.now() + 86_400_000 + 1000)
    await session.recheck()
    await vi.waitFor(() => expect(kept()).toEqual(['another-programs']))
    expect(d.to('/session/end').length).toBe(4)
    await session.recheck()
    await new Promise((r) => setTimeout(r, 10))
    expect(d.to('/session/end').length).toBe(4)
  })

  test('an answer about the session that was here before, arriving after the browser signed out, has that session named again: it may have given the cookie again', async () => {
    let over = false
    let late: ((a: Answer) => void) | null = null
    let hold = false
    const d = door((a) => {
      if (a.path === '/session/end') {
        over = true
        return { status: 200, body: { ok: true } }
      }
      if (a.path === '/session/person') return { status: 200, body: { there: true } }
      if (hold) {
        hold = false
        return new Promise<Answer>((give) => {
          late = give
        })
      }
      return over ? refused : paired()
    })
    const session = await load()
    await session.begin()
    // A token is asked for, and its answer, which gives the cookie again for another year, is held up on its way
    hold = true
    void session.token(true)
    await vi.waitFor(() => expect(late).not.toBeNull())
    expect(await session.signOut()).toBe(true)
    await vi.waitFor(() => expect(d.to('/session/end').length).toBe(2))
    // It arrives now, after the cookie was cleared: the session is named at once, and again when the browser is found not to be paired
    late!(paired())
    await vi.waitFor(() => expect(d.to('/session/end').length).toBe(4))
    expect(d.to('/session/end').map((a) => a.body)).toEqual(Array(4).fill(JSON.stringify({ session: 'session-1' })))
    expect(session.current().paired).toBe(false)
  })

  test('a session the backend gives a token for is not over, whatever was noted of it, and is never named to be cleared', async () => {
    const now = { user: null as string | null }
    const d = door((a) =>
      a.path === '/session/person'
        ? { status: 200, body: { there: true } }
        : a.path === '/session/end'
          ? new Error('no connection')
          : now.user
            ? paired()
            : refused,
    )
    keep()
    localStorage.setItem('it.person', 'user-1')
    const session = await load()
    await session.begin()
    await vi.waitFor(() => expect(stillToClear()).toEqual(['session-1']))
    // The backend says after all that the browser holds that very session
    now.user = 'user-1'
    await session.recheck()
    expect([session.current().session, stillToClear()]).toEqual(['session-1', []])
    await new Promise((r) => setTimeout(r, 10))
    expect(d.to('/session/end').length).toBe(1)
  })

  test('a browser that is paired has what is left of the sessions it held before seen to, once in each tab, and its own session is not among them', async () => {
    localStorage.setItem('it.cookies', JSON.stringify([{ id: 'session-0', at: Date.now() - 1000 }, { id: 'not a name', at: 1 }, 'nor this']))
    const d = door((a) => (a.path === '/session/end' ? { status: 409, body: { code: 'another_session' } } : paired()))
    const session = await load()
    await session.begin()
    await vi.waitFor(() => expect(d.to('/session/end').map((a) => a.body)).toEqual([JSON.stringify({ session: 'session-0' })]))
    await session.token(true)
    await session.recheck()
    await new Promise((r) => setTimeout(r, 10))
    expect(d.to('/session/end').length).toBe(1)
    expect([session.current().paired, localStorage.getItem('it.person.session'), stillToClear()]).toEqual([true, 'session-1', ['session-0']])
  })

  test('only so many names are kept, the oldest going first, and what is kept there that is no list of names is taken for none', async () => {
    localStorage.setItem('it.cookies', JSON.stringify(Array.from({ length: 20 }, (_, n) => ({ id: `session-old-${n}`, at: Date.now() - n }))))
    const d = door((a) =>
      a.path === '/session/end' ? new Error('no connection') : a.path === '/session/person' ? { status: 200, body: { there: true } } : refused,
    )
    localStorage.setItem('it.person', 'user-1')
    localStorage.setItem('it.person.session', 'session-1')
    await (await load()).begin()
    await vi.waitFor(() => expect(d.to('/session/end').length).toBe(20))
    expect(stillToClear()).toEqual([...Array.from({ length: 19 }, (_, n) => `session-old-${n + 1}`), 'session-1'])
    vi.resetModules()
    localStorage.setItem('it.cookies', '{not a list')
    const before = d.asked.length
    await (await load()).begin()
    await new Promise((r) => setTimeout(r, 10))
    expect(d.asked.slice(before).map((a) => a.path)).toEqual(['/session/token', '/session/person'])
  })

  test('paired for another person than it kept things for, it lets go of what it kept before it does anything as the new one', async () => {
    const d = doorFor({ user: 'user-2', there: { status: 200, body: { there: true } } })
    keep()
    localStorage.setItem('it.person', 'user-1')
    const session = await load()
    await session.begin()
    expect(session.current()).toMatchObject({ paired: true, user: 'user-2' })
    expect(kept()).toEqual(['another-programs', 'it.person', 'it.person.session'])
    expect(stillToClear()).toEqual([])
    expect(localStorage.getItem('it.person')).toBe('user-2')
    expect(d.to('/session/person')).toEqual([])
  })

  test('a browser that is paired again before the answer comes keeps what it has: the answer was about a browser that was not paired', async () => {
    let give!: (a: Answer) => void
    const now = { user: null as string | null }
    door((a) => {
      if (a.path !== '/session/person') return now.user ? paired({ user: now.user }) : refused
      return new Promise<Answer>((r) => {
        give = r
      })
    })
    keep()
    localStorage.setItem('it.person', 'user-1')
    const session = await load()
    await session.begin()
    now.user = 'user-1'
    await session.recheck()
    give({ status: 200, body: { there: false } })
    await new Promise((r) => setTimeout(r, 10))
    expect(kept()).toEqual(EVERYTHING)
  })
})

describe('pairing with a code', () => {
  const CODE = 'abcdefghij0123456789'
  /** What the backend says a code is for, when it would pair a browser. */
  const isFor = (role: 'owner' | 'screen'): Answer => ({ status: 200, body: { role } })

  test('the person’s own code in the address is redeemed at once, and none is left in the address bar from the moment the site starts', async () => {
    history.replaceState(null, '', `/pair#${CODE}`)
    let nowPaired = false
    let addressWhenAsked = ''
    const d = door((a) => {
      if (a.path === '/session/code') {
        addressWhenAsked = location.href
        return isFor('owner')
      }
      if (a.path === '/session/redeem') {
        nowPaired = true
        return { status: 200, body: { ok: true } }
      }
      return nowPaired ? paired() : refused
    })
    const session = await load()
    const beginning = session.begin()
    // Before the backend has even been asked
    expect(location.hash).toBe('')
    expect(location.href).not.toContain(CODE)
    await beginning
    expect(addressWhenAsked).not.toContain(CODE)
    // What it is for is asked first, and then it is redeemed
    expect(d.asked.map((a) => [a.path, a.method, a.site, a.body])).toEqual([
      ['/session/code', 'POST', '1', JSON.stringify({ code: CODE })],
      ['/session/redeem', 'POST', '1', JSON.stringify({ code: CODE })],
      ['/session/token', 'POST', '1', undefined],
    ])
    expect(location.pathname).toBe('/')
    expect(location.hash).toBe('')
    expect(history.length).toBe(1)
    expect(session.current()).toMatchObject({ loaded: true, paired: true, role: 'owner', code: null })
  })

  test('a screen’s code in the address is not redeemed by the address being opened: it is held until the person says this browser is that screen', async () => {
    history.replaceState(null, '', `/pair#${CODE}`)
    let nowPaired = false
    const d = door((a) => {
      if (a.path === '/session/code') return isFor('screen')
      if (a.path === '/session/redeem') {
        nowPaired = true
        return { status: 200, body: { ok: true } }
      }
      return nowPaired ? paired({ role: 'screen' }) : refused
    })
    const session = await load()
    await session.begin()
    expect(d.asked.map((a) => a.path)).toEqual(['/session/code', '/session/token'])
    expect(session.current()).toMatchObject({ loaded: true, paired: false, code: 'screen' })
    // It is in no address and no storage meanwhile
    expect([location.pathname + location.hash, JSON.stringify(localStorage) + JSON.stringify(sessionStorage)]).toEqual(['/', '{}{}'])
    // Asked again whether it is paired, as a tab left on that screen is, it is still offered
    window.dispatchEvent(new StorageEvent('storage', { key: 'it.session', newValue: '1' }))
    await vi.waitFor(() => expect(d.to('/session/token').length).toBeGreaterThan(1))
    expect(session.current().code).toBe('screen')
    await session.pairAsScreen()
    expect(d.to('/session/redeem')).toEqual([{ path: '/session/redeem', method: 'POST', site: '1', body: JSON.stringify({ code: CODE }) }])
    expect(session.current()).toMatchObject({ paired: true, role: 'screen', code: null })
    // It was redeemed once, and is held no more
    await session.pairAsScreen()
    expect(d.to('/session/redeem').length).toBe(1)
  })

  test('a screen’s code that the person declines is let go of, and is never put to be redeemed', async () => {
    history.replaceState(null, '', `/pair#${CODE}`)
    const d = door((a) => (a.path === '/session/code' ? isFor('screen') : refused))
    const session = await load()
    await session.begin()
    session.codeSeen()
    expect(session.current().code).toBeNull()
    await session.pairAsScreen()
    expect(d.to('/session/redeem')).toEqual([])
  })

  test('a browser paired as a screen is offered a screen’s code too, and the offer stays while its token is fetched again', async () => {
    history.replaceState(null, '', `/pair#${CODE}`)
    const d = door((a) => (a.path === '/session/code' ? isFor('screen') : paired({ role: 'screen' })))
    const session = await load()
    await session.begin()
    expect(session.current()).toMatchObject({ paired: true, role: 'screen', code: 'screen' })
    await session.token(true)
    expect(session.current().code).toBe('screen')
    expect(d.to('/session/redeem')).toEqual([])
  })

  test('a code of a kind this site does not know is held like a screen’s, and is not redeemed unasked', async () => {
    history.replaceState(null, '', `/pair#${CODE}`)
    const d = door((a) => (a.path === '/session/code' ? { status: 200, body: { role: 'admin' } } : refused))
    const session = await load()
    await session.begin()
    expect([session.current().code, d.to('/session/redeem')]).toEqual(['screen', []])
  })

  test('a code that is wrong, used or expired is said to be, and the browser is not paired', async () => {
    history.replaceState(null, '', `/pair#${CODE}`)
    const d = door(() => refused)
    const session = await load()
    await session.begin()
    expect(session.current()).toMatchObject({ loaded: true, paired: false, code: 'refused' })
    expect(location.href).not.toContain(CODE)
    expect(location.pathname).toBe('/')
    expect(d.to('/session/redeem')).toEqual([])
  })

  test('a browser that is already paired stays paired when the code it was given does nothing', async () => {
    history.replaceState(null, '', `/pair#${CODE}`)
    door((a) => (a.path === '/session/code' ? refused : paired()))
    const session = await load()
    await session.begin()
    expect(session.current()).toMatchObject({ loaded: true, paired: true, code: null })
  })

  test('a code the backend could not be asked about is asked about again, and then said not to have been tried', async () => {
    vi.useFakeTimers()
    history.replaceState(null, '', `/pair#${CODE}`)
    let tries = 0
    const d = door((a) => {
      if (a.path === '/session/redeem') return { status: 200 }
      if (a.path !== '/session/code') return refused
      tries++
      return tries < 3 ? new Error('no connection') : isFor('owner')
    })
    const session = await load()
    const beginning = session.begin()
    await vi.advanceTimersByTimeAsync(10_000)
    await beginning
    expect([d.to('/session/code').length, d.to('/session/redeem').length]).toEqual([3, 1])
    // And when it never could be: that is said, which is not the same as the code being wrong
    vi.resetModules()
    history.replaceState(null, '', `/pair#${CODE}`)
    const never = door((a) => (a.path === '/session/code' ? { status: 503 } : refused))
    const again = await load()
    const second = again.begin()
    await vi.advanceTimersByTimeAsync(60_000)
    await second
    expect(again.current()).toMatchObject({ loaded: true, paired: false, code: 'trouble' })
    expect([never.to('/session/code').length, never.to('/session/redeem').length]).toEqual([4, 0])
  })

  test('a code that could not be redeemed for trouble is put again a few times', async () => {
    vi.useFakeTimers()
    let tries = 0
    const d = door((a) => {
      if (a.path !== '/session/redeem') return refused
      tries++
      return tries < 3 ? new Error('no connection') : { status: 200 }
    })
    const session = await load()
    await session.begin()
    const pairing = session.pair(CODE, 4)
    await vi.advanceTimersByTimeAsync(10_000)
    await pairing
    expect(d.to('/session/redeem').length).toBe(3)
  })

  /** What the door answers once ten codes from one address have been refused within a minute: it tries no more from that address until the minute is over. */
  const tooMany = (seconds: number): Answer => ({ status: 429, body: { error: 'too_many_wrong_codes' }, headers: { 'retry-after': String(seconds) } })

  test('a typed code the door did not try, for the wrong ones before it, is said to wait for, with how long, and is put once', async () => {
    let now = tooMany(43)
    let waited = false
    const d = door((a) => (a.path === '/session/redeem' ? now : a.path === '/session/token' && waited ? paired() : refused))
    const session = await load()
    await session.begin()
    await session.pair(CODE)
    expect(session.current()).toMatchObject({ paired: false, code: null, wait: 43 })
    expect(d.to('/session/redeem').length).toBe(1)
    // The minute is nearly over: said afresh, with what is left of it
    now = tooMany(7)
    await session.pair(CODE)
    expect(session.current()).toMatchObject({ paired: false, code: null, wait: 7 })
    // And once it is over the same code pairs the browser, and nothing more is said of waiting
    now = { status: 200, body: { ok: true } }
    waited = true
    await session.pair(CODE)
    expect(session.current()).toMatchObject({ paired: true, code: null, wait: null })
  })

  test('a screen’s code that was held is held still when the door did not try it, and pairs the browser once the wait is over', async () => {
    let now = tooMany(30)
    let waited = false
    const d = door((a) => (a.path === '/session/code' ? isFor('screen') : a.path === '/session/redeem' ? now : waited ? paired({ role: 'screen' }) : refused))
    history.replaceState(null, '', `/pair#${CODE}`)
    const session = await load()
    await session.begin()
    expect(session.current()).toMatchObject({ code: 'screen', wait: null })
    await session.pairAsScreen()
    expect(session.current()).toMatchObject({ paired: false, code: 'screen', wait: 30 })
    now = { status: 200, body: { ok: true } }
    waited = true
    await session.pairAsScreen()
    expect(session.current()).toMatchObject({ paired: true, role: 'screen', code: null, wait: null })
    expect(d.to('/session/redeem').map((a) => a.body)).toEqual(Array(2).fill(JSON.stringify({ code: CODE })))
  })

  test('a code in the address that the door would not be asked about is said to wait for, and what was said is let go of when the person has read it', async () => {
    const d = door((a) => (a.path === '/session/code' ? tooMany(60) : refused))
    history.replaceState(null, '', `/pair#${CODE}`)
    const session = await load()
    await session.begin()
    expect(session.current()).toMatchObject({ paired: false, code: null, wait: 60 })
    expect(d.to('/session/code').length).toBe(1)
    expect(d.to('/session/redeem')).toEqual([])
    session.codeSeen()
    expect(session.current().wait).toBeNull()
  })

  test('told to wait only a moment, or told so by anything but the door’s own count of wrong codes, a code is taken to have met trouble', async () => {
    for (const answer of [
      tooMany(1),
      { status: 429, body: { error: 'Too many requests. Try again shortly.' } },
      { status: 429, body: { error: 'too_many_wrong_codes' } },
    ] as Answer[]) {
      vi.resetModules()
      door((a) => (a.path === '/session/redeem' ? answer : refused))
      const session = await load()
      await session.begin()
      await session.pair(CODE)
      expect(session.current()).toMatchObject({ paired: false, code: 'trouble', wait: null })
    }
  })

  test('a code typed by hand is redeemed as it was made, whatever spaces and capitals it was typed with, with nothing asked first', async () => {
    let nowPaired = false
    const d = door((a) => {
      if (a.path === '/session/redeem') {
        nowPaired = true
        return { status: 200 }
      }
      return nowPaired ? paired({ role: 'screen' }) : refused
    })
    const session = await load()
    await session.begin()
    expect(session.current().paired).toBe(false)
    await session.pair(' Abcde FGHIJ\t01234 56789 ')
    expect(d.to('/session/redeem')[0]!.body).toBe(JSON.stringify({ code: CODE }))
    expect(d.to('/session/code')).toEqual([])
    expect(session.current()).toMatchObject({ paired: true, role: 'screen', code: null })
  })

  test('nothing is asked of the backend for a code that is not there, and the address is put right all the same', async () => {
    history.replaceState(null, '', '/pair')
    const d = door(() => refused)
    const session = await load()
    await session.begin()
    expect([d.to('/session/code'), d.to('/session/redeem')]).toEqual([[], []])
    expect(location.pathname).toBe('/')
    await session.pair('   ')
    expect(d.to('/session/redeem')).toEqual([])
    expect(session.current().code).toBe('refused')
  })

  test('a code is shown in fours, so that it can be read across a room and typed', async () => {
    const session = await load()
    expect(session.spaced(CODE)).toBe('abcd efgh ij01 2345 6789')
  })
})
