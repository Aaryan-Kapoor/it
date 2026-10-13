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
let machines: { harnesses: { id: string; addon: string }[]; lastSeenAt?: number; connectorVersion?: string | null; off?: boolean; paused?: string | null }[]
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
/** What the film on the first screen was last told: whether to stand still when it was begun, and each time since. */
const film: { begun: boolean[]; told: boolean[] } = { begun: [], told: [] }
vi.mock('./film/play', () => ({
  play: async (_panel: unknown, _stage: unknown, _told: unknown, still: boolean) => {
    film.begun.push(still)
    return { cards: [{ key: 'whiteboard' }, { key: 'map' }], show: () => {}, hold: () => {}, still: (on: boolean) => void film.told.push(on), stop: () => {} }
  },
}))

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
  machines = [{ harnesses: [{ id: 'claude-code', addon: 'connected' }], lastSeenAt: NOW, connectorVersion: '0.1.22' }]
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

  test('an agent app is said to be listening only while its machine is there and hands things to it: not one whose machine has stopped, gone quiet or is paused', async () => {
    await shown()
    const { Grid } = await import('./pages')
    /** What the first screen says is listening, of a machine as the backend then gives it. */
    const said = async (machine: Partial<(typeof machines)[number]>) => {
      machines = [{ harnesses: [{ id: 'claude-code', addon: 'connected' }], lastSeenAt: NOW, connectorVersion: '0.1.22', ...machine }]
      await act(async () => root.render(createElement(Grid, { pages: [], owner: true, query: '', onQuery: () => {} })))
      // Its app is connected all the same, and is not said to want connecting
      expect(host.textContent).not.toContain('No agent app is connected yet')
      return host.querySelector('.hello-eyebrow')!.textContent
    }
    expect(await said({})).toBe('Claude Code is listening')
    expect(await said({ off: true })).toBe('It is listening')
    expect(await said({ lastSeenAt: NOW - 10 * 60_000 })).toBe('It is listening')
    expect(await said({ connectorVersion: null })).toBe('It is listening')
    expect(await said({ paused: 'versions' })).toBe('It is listening')
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

  test('the tour asked for again there is said to be on its way until it comes, though the agent that took the asking waits no longer', async () => {
    tour = { ...NOBODY, doneAt: NOW - 1000, waitingUntil: NOW + 10_000, by: 'claude-code' }
    await shown()
    await act(async () => button('Take the tour')!.click())
    expect(host.textContent).toContain('Claude Code is starting the tour. It comes up here by itself.')
    // The agent heard the asking, which is taken up once: it is not said to be waiting from then on
    tour = { ...tour, waitingUntil: null, askedAt: NOW, takenAt: NOW }
    const { Grid } = await import('./pages')
    await act(async () => root.render(createElement(Grid, { pages: [], owner: true, query: '', onQuery: () => {} })))
    expect(host.textContent).toContain('Claude Code is starting the tour. It comes up here by itself.')
    expect(host.querySelector('.starters')).toBeNull()
  })

  test('nothing is shown until the backend has said how things stand, so that neither screen flashes before the other', async () => {
    tour = undefined
    await shown()
    expect(host.querySelector('.hello, .starters')).toBeNull()
  })
})

describe('the film on the first screen', () => {
  /** Whether the person's system asks for less motion, and what the site asked to be told when that changes. */
  let less: boolean
  const hearers = new Set<(e: { matches: boolean }) => void>()
  const changes = (to: boolean) =>
    act(async () => {
      less = to
      for (const hear of hearers) hear({ matches: to })
    })
  beforeEach(() => {
    less = false
    hearers.clear()
    film.begun.length = 0
    film.told.length = 0
    // What a browser has that this stand-in does not, and the film is not played without
    vi.stubGlobal('FontFace', class {})
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion') && less,
      addEventListener: (_kind: string, hear: (e: { matches: boolean }) => void) => void hearers.add(hear),
      removeEventListener: (_kind: string, hear: (e: { matches: boolean }) => void) => void hearers.delete(hear),
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  test('plays for someone whose system asks for nothing else, and stands still from the start for someone whose system asks for less motion', async () => {
    await shown()
    await act(async () => {})
    expect(film.begun).toEqual([false])
    await act(async () => root.unmount())
    host.remove()
    less = true
    await shown()
    await act(async () => {})
    expect(film.begun).toEqual([false, true])
    expect(film.told).toEqual([])
  })

  test('has a button that stops it and starts it again, which the keyboard reaches, and says which of the two it would do', async () => {
    await shown()
    await act(async () => {})
    const stops = () => host.querySelector<HTMLButtonElement>('.hello-things button[aria-label$="the film"]')!
    expect([stops().textContent, stops().getAttribute('aria-label'), stops().tabIndex]).toEqual(['Pause', 'Pause the film', 0])
    await act(async () => stops().click())
    expect(film.told).toEqual([true])
    expect([stops().textContent, stops().getAttribute('aria-label')]).toEqual(['Play', 'Play the film'])
    await act(async () => stops().click())
    expect(film.told).toEqual([true, false])
    // Begun standing still, for less motion, it is the way to have it played all the same
    await act(async () => root.unmount())
    host.remove()
    less = true
    await shown()
    await act(async () => {})
    expect(stops().textContent).toBe('Play')
  })

  test('is told to stand still, or to play again, when the person changes that in their system while the screen is up', async () => {
    await shown()
    await act(async () => {})
    await changes(true)
    await changes(false)
    expect(film.told).toEqual([true, false])
  })
})
