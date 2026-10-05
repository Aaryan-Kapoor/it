// The displays and settings views, in a stand-in browser with a stand-in backend. What they
// must get right: a screen is offered nothing that is the owner's, and erasing everything is
// asked of the backend only for the person who confirmed it. Adding a display has tests of its
// own (network.test.ts).
import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const CODE = 'abcdefghij0123456789'
const calls: { fn: string; args: any }[] = []
/** What the stand-in backend answers, by function. */
const answers: Record<string, (args: any) => unknown> = {}
const ask = async (fn: unknown, args: unknown) => {
  const name = getFunctionName(fn as never)
  calls.push({ fn: name, args })
  return answers[name]?.(args) ?? null
}
const client = { mutation: vi.fn(ask), query: vi.fn(ask), action: vi.fn(ask) }
const DISPLAYS = [
  { id: 'display-1', name: 'Chrome on Linux', named: false, lastSeenAt: Date.now(), push: false },
  { id: 'display-2', name: 'Kitchen TV', named: true, lastSeenAt: Date.now() - 3_600_000, push: true },
]
/** What the queries the site watches say, by function. */
let watched: Record<string, unknown>
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
const show = async (what: React.ReactElement) => {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root.render(what))
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)
const press = (label: string) => act(async () => button(label)!.click())
const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

beforeEach(() => {
  calls.length = 0
  for (const name of Object.keys(answers)) delete answers[name]
  answers['sessions:inviteScreen'] = () => ({ code: CODE, expiresAt: Date.now() + 600_000 })
  watched = { 'displays:list': DISPLAYS }
  localStorage.clear()
  sessionStorage.clear()
  // This stand-in browser has no notifications, and cannot say how the site is being shown
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  browser.reconfigure({ url: HOME })
})

describe('what each kind of session is offered', () => {
  const mine = DISPLAYS[0]!

  test('the owner may name and forget every display', async () => {
    vi.stubGlobal('confirm', () => true)
    const { Displays } = await import('./settings')
    await show(createElement(Displays, { thisDisplay: 'display-1' }))
    const rows = [...host.querySelectorAll('li')].map((li) => [...li.querySelectorAll('button')].map((b) => b.textContent))
    expect(rows).toEqual([
      ['Rename', 'Forget'],
      ['Rename', 'Forget'],
    ])
    await act(async () => [...host.querySelectorAll('li')][1]!.querySelectorAll('button')[1]!.click())
    expect(calls).toEqual([{ fn: 'displays:forget', args: { displayId: 'display-2' } }])
  })

  test('a display whose browser’s pairing has ended is said to be not paired, and not when it was last open', async () => {
    watched['displays:list'] = [
      { ...DISPLAYS[0]!, paired: true },
      { ...DISPLAYS[1]!, paired: false, push: false },
    ]
    const { Displays } = await import('./settings')
    await show(createElement(Displays, { thisDisplay: 'display-1' }))
    const said = [...host.querySelectorAll('ul.rows')[0]!.querySelectorAll('li')].map((li) => [
      li.querySelector('.row-name')!.textContent,
      li.querySelector('.row-sub')!.textContent,
    ])
    expect(said).toEqual([
      ['Chrome on LinuxThis display', 'Open now'],
      ['Kitchen TVNot paired', 'Shows nothing until its browser is paired again'],
    ])
    // It can still be named and forgotten
    expect([...host.querySelectorAll('ul.rows')[0]!.querySelectorAll('li')][1]!.textContent).toContain('RenameForget')
  })

  test('before a display is forgotten, the owner is told what goes with the pairing of the browser it is', async () => {
    const asked: string[] = []
    vi.stubGlobal('confirm', (text: string) => {
      asked.push(text)
      return false
    })
    const row = { role: 'owner', pairedAt: 0, lastSeenAt: 0, invitedBy: null }
    // The kitchen's browser paired a screen and added a machine, from which the browser being read on was paired
    watched['sessions:list'] = [
      { ...row, id: 'session-1', mine: true, displays: [{ id: 'display-1', name: 'Chrome on Linux' }], along: { browsers: [], machines: [] } },
      {
        ...row,
        id: 'session-2',
        mine: false,
        displays: [{ id: 'display-2', name: 'Kitchen TV' }],
        along: { browsers: ['session-3', 'session-1'], machines: ['machine-2'] },
      },
    ]
    const { Displays } = await import('./settings')
    await show(createElement(Displays, { thisDisplay: 'display-1' }))
    const forget = (row: number) =>
      act(async () => [...host.querySelectorAll('ul.rows')[0]!.querySelectorAll('li')][row]!.querySelectorAll('button')[1]!.click())
    await forget(1)
    await forget(0)
    expect(asked).toEqual([
      'Forget “Kitchen TV”? It is signed out, and pages open on it stop working, usually at once. It has to be paired again before it can be used. 2 paired browsers and 1 machine came from it, and are ended with it. This browser is one of them.',
      'Forget this display? This browser is signed out, and has to be paired again before it can be used.',
    ])
    expect(calls).toEqual([])
  })

  test('a screen may name itself and sign itself out, and is offered nothing of the owner’s', async () => {
    const onSignOut = vi.fn()
    const { Settings } = await import('./settings')
    await show(createElement(Settings, { user: 'user-1', owner: false, display: mine, onSignOut }))
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Rename', 'Sign out'])
    expect(host.textContent).toContain('Paired as a screen')
    for (const theOwners of ['Download my data', 'Erase everything', 'Forget', 'Add a display']) expect(host.textContent).not.toContain(theOwners)
    await press('Rename')
    await type(host.querySelector('input[aria-label="Display name"]') as HTMLInputElement, 'Kitchen TV')
    await press('Save')
    await press('Sign out')
    expect(calls).toEqual([{ fn: 'displays:rename', args: { displayId: 'display-1', name: 'Kitchen TV' } }])
    expect(onSignOut).toHaveBeenCalledOnce()
  })
})

describe('erasing everything', () => {
  test('it is asked of the backend only once the phrase is typed, for the person who confirmed, and then this browser’s session is ended', async () => {
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        asked.push(path)
        // The session is ended, and from then on this browser is given no token
        return path === '/session/end' ? new Response('{"ok":true}', { status: 200 }) : new Response('{}', { status: 401 })
      }),
    )
    // What the site keeps in this browser: which display it is, a click not yet sent, a sign-out token, and what was chosen here
    localStorage.setItem('it.display', 'a-display-key-000001')
    localStorage.setItem('it.outbox.user-1.page-1.click-0001', JSON.stringify({ user: 'user-1', envelope: { payload: '{"typed":"private"}' }, at: Date.now() }))
    localStorage.setItem('it.signout', JSON.stringify({ user: 'user-1', token: 'sign-out-token', raisesTo: 1, display: 'display-1' }))
    localStorage.setItem('it.pushAsked', 'yes')
    sessionStorage.setItem('it.shownAt.user-1', '7')
    localStorage.setItem('another-programs', 'kept')
    const { Settings } = await import('./settings')
    await show(createElement(Settings, { user: 'user-1', owner: true, display: DISPLAYS[0]!, onSignOut: () => {} }))
    // The row opens a dialog, which says in two sentences what is removed and what it takes to use It again
    expect(host.querySelector('input[aria-label="Type erase everything to confirm"]')).toBeNull()
    await press('Erase…')
    const said = host.querySelector('[role="dialog"]')!.textContent
    expect(said).toContain('This removes every page, its files and every record of them, and signs out every display and machine. It cannot be undone.')
    expect(said).toContain('Afterwards, run it setup to use It again.')
    expect(said).not.toMatch(/this machine|this computer/)
    const erase = () => button('Erase everything') as HTMLButtonElement
    const phrase = host.querySelector('input[aria-label="Type erase everything to confirm"]') as HTMLInputElement
    expect(erase().disabled).toBe(true)
    await type(phrase, 'erase')
    expect(erase().disabled).toBe(true)
    await type(phrase, 'Erase everything ')
    expect(erase().disabled).toBe(false)
    await press('Erase everything')
    expect(calls).toEqual([{ fn: 'account:requestDeletion', args: { confirm: 'erase everything', user: 'user-1' } }])
    // Its session is ended by name, and then it asks what this browser is now
    expect(asked).toEqual(['/session/end', '/session/token'])
    // And the browser that asked for the erasing keeps nothing of It's from that moment
    expect([...Object.keys(localStorage), ...Object.keys(sessionStorage)]).toEqual(['another-programs'])
  })

  test('when the backend refuses, nothing is ended here and the person is told what it said', async () => {
    const { ConvexError } = await import('convex/values')
    const door = vi.fn()
    vi.stubGlobal('fetch', door)
    answers['account:requestDeletion'] = () => Promise.reject(new ConvexError({ code: 'conflict', message: 'Nothing was erased.' }))
    const { Settings } = await import('./settings')
    const { isLeaving } = await import('./lib')
    await show(createElement(Settings, { user: 'user-1', owner: true, display: DISPLAYS[0]!, onSignOut: () => {} }))
    await press('Erase…')
    await type(host.querySelector('input[aria-label="Type erase everything to confirm"]') as HTMLInputElement, 'erase everything')
    await press('Erase everything')
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Nothing was erased.')
    expect(door).not.toHaveBeenCalled()
    // The site is not left believing this browser is on its way out
    expect(isLeaving()).toBe(false)
  })
})
