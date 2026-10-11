// What someone with no pages is shown: the way into the tour, which is a button where an agent
// is waiting to give it and a sentence to copy where none is, and things to ask for once the
// tour is over. In a stand-in browser with a stand-in backend.
import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const NOW = Date.now()
const NOBODY = { waitingUntil: null, by: null, askedAt: null, takenAt: null, doneAt: null }
/** What the backend says of the tour and of the machines, which each test sets before the screen is drawn. */
let tour: Record<string, unknown> | undefined
let machines: { harnesses: { id: string; addon: string }[] }[]
/** What the backend was asked to do, and what it answers an asking for the tour with. */
const asked: string[] = []
let waitingWhenAsked = true
vi.mock('convex/react', () => ({
  useConvex: () => ({}),
  useMutation: (fn: unknown) => async () => {
    asked.push(getFunctionName(fn as never))
    return getFunctionName(fn as never) === 'tour:ask' ? { waiting: waitingWhenAsked, by: 'claude-code' } : null
  },
  useQuery: (fn: unknown, args: unknown) => (args === 'skip' ? undefined : { 'tour:get': tour, 'machines:list': machines }[getFunctionName(fn as never)]),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
async function shown(owner = true) {
  const { Grid } = await import('./pages')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root.render(createElement(Grid, { pages: [], owner, query: '', onQuery: () => {} })))
}

beforeEach(() => {
  vi.resetModules()
  tour = { ...NOBODY }
  machines = [{ harnesses: [{ id: 'claude-code', addon: 'connected' }] }]
  asked.length = 0
  waitingWhenAsked = true
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('the way into the tour, for someone with no pages', () => {
  test('is the sentence to give an agent where no agent is waiting to give it', async () => {
    await shown()
    expect(host.textContent).toContain('Say this to your agent')
    expect(host.querySelector('.hello-say .copyable-text')!.textContent).toBe('Give me the It tour.')
    expect(button('Take the tour')).toBeUndefined()
  })

  test('is a button where an agent is waiting, and pressing it tells that agent and says the tour is on its way', async () => {
    tour = { ...NOBODY, waitingUntil: NOW + 10_000, by: 'claude-code' }
    await shown()
    expect(host.textContent).toContain('Claude Code is ready')
    expect(host.querySelector('.hello-say .copyable')).toBeNull()
    await act(async () => button('Take the tour')!.click())
    expect(asked).toEqual(['tour:ask'])
    expect(host.textContent).toContain('Claude Code is starting the tour. It comes up here by itself.')
    expect(button('Take the tour')).toBeUndefined()
  })

  test('falls back to the sentence when the agent that was waiting turns out to have gone', async () => {
    tour = { ...NOBODY, waitingUntil: NOW + 10_000, by: 'codex' }
    waitingWhenAsked = false
    await shown()
    await act(async () => button('Take the tour')!.click())
    expect(host.textContent).toContain('Say this to your agent')
    expect(host.querySelector('.hello-say .copyable-text')!.textContent).toBe('Give me the It tour.')
  })

  test('an agent that stopped waiting a while ago is not said to be ready', async () => {
    tour = { ...NOBODY, waitingUntil: NOW - 60_000, by: 'claude-code' }
    await shown()
    expect(button('Take the tour')).toBeUndefined()
    expect(host.textContent).toContain('Say this to your agent')
  })

  test('says what a setup at a terminal would have asked: the other agent apps found, and another screen', async () => {
    machines = [
      {
        harnesses: [
          { id: 'claude-code', addon: 'connected' },
          { id: 'codex', addon: 'not_connected' },
          { id: 'pi', addon: 'not_connected' },
          { id: 'openclaw', addon: 'unavailable' },
        ],
      },
    ]
    await shown()
    const links = [...host.querySelectorAll('.hello-setup a')].map((a) => [a.textContent, a.getAttribute('href')])
    expect(links).toEqual([
      ['Codex and Pi are on this machine too. Connect them', '/machines'],
      ['Add your phone or another screen', '/displays'],
    ])
  })

  test('a screen, which is not the owner’s browser, is offered none of that', async () => {
    await shown(false)
    expect(host.querySelector('.hello-setup')).toBeNull()
    expect(host.textContent).toContain('Say this to your agent')
  })
})

describe('once the tour is over, or the person wanted none', () => {
  test('pressing "Skip the tour" says so to the backend', async () => {
    await shown()
    await act(async () => button('Skip the tour')!.click())
    expect(asked).toEqual(['tour:done'])
  })

  test('someone with no pages is shown things to ask for, each to copy, and the way back into the tour', async () => {
    tour = { ...NOBODY, doneAt: NOW - 1000 }
    await shown()
    expect(host.querySelector('.hello')).toBeNull()
    const { STARTERS } = await import('./welcome')
    expect([...host.querySelectorAll('.starters-list .copyable-text')].map((c) => c.textContent)).toEqual(STARTERS.map((s) => s.say))
    expect(STARTERS.length).toBeGreaterThanOrEqual(4)
    await act(async () => button('Take the tour again')!.click())
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain('Give me the It tour.')
  })

  test('an agent that waits to give the tour again brings its screen back', async () => {
    tour = { ...NOBODY, doneAt: NOW - 1000, waitingUntil: NOW + 10_000, by: 'claude-code' }
    await shown()
    expect(button('Take the tour')).toBeDefined()
    expect(host.querySelector('.starters')).toBeNull()
  })

  test('nothing is shown until the backend has said how things stand, so that neither screen flashes before the other', async () => {
    tour = undefined
    await shown()
    expect(host.querySelector('.hello, .starters')).toBeNull()
  })
})
