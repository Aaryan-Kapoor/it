// The tour: the guide an agent follows, and the pages it shows. What the guide tells an agent to
// run is held to the pages there are, what it tells the agent to expect of a page is held to
// what the page sends, and what a page is filled in with is held to its place in the page,
// since some of it is the agent's own words.
import { describe, expect, test } from 'vitest'
import { END, GUIDE, MENU, NAMES, STEPS, TOUR_PREFIX, tourPage } from './src/tour'

// The stand-in for a browser comes with no types of its own, so it is asked for by a name the type check does not follow
const { JSDOM } = (await import('jsdom' as string)) as any

const params = (html: string) => JSON.parse(/window\.__PARAMS = (\{.*\})<\/script>/.exec(html)![1]!)

/** Something a page sent, which the test accepts or refuses as It would. */
interface Sent {
  name: string
  data: any
  accept: () => Promise<void>
  refuse: () => Promise<void>
}
/**
 * A page of the tour as it is published, run in a stand-in for a browser. It is stood in for by
 * hand: what the page sends is kept until the test accepts or refuses it, the state is what the
 * test sets as the page's agent would, and the clock is moved by the test. `before` is done to
 * the window first, for what a page needs of a browser that the stand-in has not got.
 */
async function opened(name: string, before: (w: any) => void = () => {}) {
  const page = tourPage(name)
  const sent: Sent[] = []
  const listeners: (() => void)[] = []
  const settled = () => new Promise<void>((done) => setImmediate(done))
  let now = 0
  let timers: { id: number; at: number; fn: () => void }[] = []
  const It = {
    state: JSON.parse(page.state) as Record<string, unknown>,
    revision: 1,
    onState: (fn: () => void) => {
      listeners.push(fn)
      return () => {}
    },
    action: (name: string, data: unknown) =>
      new Promise((resolve, reject) => {
        sent.push({
          name,
          data,
          accept: () => {
            resolve({ ok: true })
            return settled()
          },
          refuse: () => {
            reject(new Error('refused'))
            return settled()
          },
        })
      }),
  }
  const dom = new JSDOM(page.html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w: any) {
      w.It = It
      // Nothing moves on the page, so nothing is asked of the stand-in that it cannot draw
      w.matchMedia = () => ({ matches: true })
      w.setTimeout = (fn: () => void, ms = 0) => timers.push({ id: timers.length + 1, at: now + ms, fn })
      w.clearTimeout = (id: number) => {
        timers = timers.filter((t) => t.id !== id)
      }
      before(w)
    },
  })
  const w = dom.window
  if (w.document.readyState !== 'complete') await new Promise((done) => w.addEventListener('load', done))
  return {
    w,
    sent,
    $: (selector: string) => w.document.querySelector(selector),
    /** The agent sets something in the page's state. */
    async set(patch: Record<string, unknown>) {
      It.state = { ...It.state, ...patch }
      It.revision++
      for (const fn of listeners) fn()
      await settled()
    },
    /** Moves the clock on, running whatever comes due. */
    async advance(ms: number) {
      now += ms
      const due = timers.filter((t) => t.at <= now)
      timers = timers.filter((t) => t.at > now)
      for (const t of due) t.fn()
      await settled()
    },
    close: () => w.close(),
  }
}

describe('the pages of the tour', () => {
  test('are a menu, the things it offers in the order the tour goes on through them, and an ending', () => {
    expect(NAMES).toEqual(['menu', 'whiteboard', 'chess', 'checklist', 'drums', 'button', 'done'])
    expect(STEPS).toEqual(['whiteboard', 'chess', 'checklist', 'drums', 'button'])
    expect([MENU, END]).toEqual(['menu', 'done'])
  })

  test('each is a whole page with an id of its own, what it is to say filled in, and the state it starts with', () => {
    for (const name of NAMES) {
      const page = tourPage(name)
      expect(page.slug).toBe(`${TOUR_PREFIX}${name}`)
      expect(page.title.length).toBeGreaterThan(0)
      expect(page.html.startsWith('<!doctype html>')).toBe(true)
      // Nothing is left for the page to say that was not said, and nothing of what the pages share is left to be set in
      expect(page.html, name).not.toMatch(/\{\{[a-z_]+\}\}/)
      expect(page.html, name).not.toMatch(/\/\*kit\.(css|js)\*\/|<!--rail-->/)
      expect(page.html).toContain('<script>window.__PARAMS = {')
      expect(params(page.html).tour_id).toBe(name)
      expect(typeof JSON.parse(page.state)).toBe('object')
      // It speaks to It through the script every page is given, and to nothing else
      expect(page.html).toMatch(/It\.(action|onState)\(/)
      expect(page.html, name).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|localStorage/)
    }
  })

  test('every thing carries the agent’s plate, the two lines of what each did, and the two buttons that go on', () => {
    for (const step of STEPS) {
      const { html } = tourPage(step)
      for (const id of ['t-plate', 't-you', 't-did', 't-more', 't-next']) expect(html, `${step} #${id}`).toContain(`id="${id}"`)
      // Each button is an ordinary action: the agent is what moves the tour on
      expect(html).toContain("go(more, 'menu'")
      expect(html).toContain("go(next, 'next'")
    }
    // The menu and the ending are ways on themselves
    expect(tourPage(MENU).html).not.toContain('id="t-next"')
    expect(tourPage(END).html).not.toContain('id="t-next"')
  })

  test('the name of the agent app that gives the tour is given to the page, for the plate, where it is known', () => {
    expect(params(tourPage('button', {}, 'Claude Code').html).agent).toBe('Claude Code')
    expect(params(tourPage('button').html).agent).toBeUndefined()
    // Unknown, the plate says whose agent it is
    expect(tourPage('button').html).toContain("'Your agent'")
  })

  test('what a page is told to say is set over what it says by default, and nothing it has no place for is taken', () => {
    const page = tourPage('whiteboard', { prompt: 'Draw the bug.' })
    expect(page.html).toContain('<h1 class="t-h">Draw the bug.</h1>')
    expect(() => tourPage('whiteboard', { colour: 'red' })).toThrow('The page "whiteboard" has nothing called "colour".')
    expect(() => tourPage('nothing')).toThrow('The tour has no page called "nothing".')
    // A name every object has is not a page
    expect(() => tourPage('constructor')).toThrow('The tour has no page called "constructor".')
  })

  test('words given to a page stay words, in its markup and in its script', () => {
    const page = tourPage('whiteboard', { prompt: '</script><script>alert(2)</script><img src=x onerror=alert(1)>' })
    expect(page.html).not.toContain('<img src=x')
    expect(page.html).not.toContain('</script><script>alert(2)')
    // And they arrive in the page's script as they were given
    expect(params(page.html).prompt).toBe('</script><script>alert(2)</script><img src=x onerror=alert(1)>')
    // The agent's name is words too
    expect(tourPage('button', {}, '</script><script>alert(3)</script>').html).not.toContain('</script><script>alert(3)')
  })
})

describe('the guide', () => {
  test('every page it tells the agent to show is one the tour has, or the next one, and every id it names is such a page’s', () => {
    const shown = [...GUIDE.matchAll(/^it tour show ([a-z]+)/gm)].map((m) => m[1]!)
    expect([...new Set(shown)].sort()).toEqual([...NAMES, 'next'].sort())
    const ids = [...GUIDE.matchAll(/\btour-([a-z]+)\b/g)].map((m) => m[1]!)
    expect(ids.length).toBeGreaterThan(8)
    for (const id of ids) expect(NAMES, `tour-${id}`).toContain(id)
  })

  test('every action it tells the agent to expect is one its page sends', () => {
    for (const [name, action] of [
      ['menu', 'pick'],
      ['menu', 'done'],
      ['whiteboard', 'snapshot'],
      ['chess', 'move'],
      ['chess', 'illegal'],
      ['chess', 'reset'],
      ['checklist', 'list'],
      ['drums', 'beat'],
      ['drums', 'cleared'],
      ['button', 'press'],
      ['done', 'finish'],
      ['done', 'menu'],
    ] as const) {
      expect(GUIDE, action).toContain(`\`${action}\``)
      expect(tourPage(name).html, `${name} sends ${action}`).toContain(`"${action}"`)
    }
    // And the two ways on that every thing has
    expect(GUIDE).toContain('**`next`**')
    expect(GUIDE).toContain('**`menu`**')
  })

  test('what it tells the agent to set in a page’s state is what the page reads', () => {
    for (const [name, key] of [
      ['whiteboard', 'agent_strokes'],
      ['whiteboard', 'note'],
      ['chess', 'reply'],
      ['checklist', 'added'],
      ['drums', 'theirs'],
      ['button', 'status'],
      ['button', 'note'],
    ] as const) {
      expect(GUIDE, `tour-${name} ${key}`).toMatch(new RegExp(`it (set tour-${name} ${key}\\b|patch tour-${name} '\\{[^']*"${key}")`))
      expect(tourPage(name).html, `${name} reads ${key}`).toMatch(new RegExp(`\\.${key}\\b|["']${key}["']`))
      // And the page starts with a place for it
      expect(Object.keys(JSON.parse(tourPage(name).state)), `${name} starts with ${key}`).toContain(key)
    }
  })

  test('a drawing is sent small enough for an action to hold', () => {
    // An action holds 32 KB. The picture is left out where it alone is larger than this, and the strokes are thinned to what is left
    expect(tourPage('whiteboard').html).toContain('png.length > 14000')
    expect(tourPage('whiteboard').html).toContain('budget = 30000 - (png ? png.length : 0)')
  })
})

describe('the chessboard', () => {
  /** The board with the person's move made on it: one square tapped, then the other. */
  const moved = (page: Awaited<ReturnType<typeof opened>>, from: string, to: string) => {
    page.$(`[data-sq="${from}"]`).click()
    page.$(`[data-sq="${to}"]`).click()
    return page.sent.at(-1)!
  }
  const piece = (page: Awaited<ReturnType<typeof opened>>, at: string) => page.$(`[data-sq="${at}"] .pc`)?.textContent ?? ''
  const waits = (page: Awaited<ReturnType<typeof opened>>) => page.$('.t-card').getAttribute('data-wait') === '1'

  test('plays the agent’s answer when it is heard after the move is known to have gone, and when it is heard before', async () => {
    const after = await opened('chess')
    const first = moved(after, 'e2', 'e4')
    expect(first).toMatchObject({ name: 'move', data: { move: 'e2e4' } })
    await first.accept()
    await after.set({ reply: 'e7e5' })
    expect([piece(after, 'e7'), piece(after, 'e5') !== '', waits(after)]).toEqual(['', true, false])
    after.close()
    // A connection that dropped brings the two back in the other order: the answer is kept
    // for the move it was heard after, and played when that move is known to have reached the agent
    const before = await opened('chess')
    const move = moved(before, 'e2', 'e4')
    await before.set({ reply: 'e7e5' })
    expect([piece(before, 'e5'), waits(before)]).toEqual(['', true])
    await move.accept()
    expect([piece(before, 'e7'), piece(before, 'e5') !== '', waits(before)]).toEqual(['', true, false])
    // And the board is the person's again
    expect(moved(before, 'g1', 'f3')).toMatchObject({ name: 'move', data: { move: 'g1f3' } })
    before.close()
  })

  test('an answer that was heard early is not played in a new game, nor after a move that did not go', async () => {
    const page = await opened('chess')
    moved(page, 'e2', 'e4')
    await page.set({ reply: 'e7e5' })
    page.$('#new').click()
    const again = moved(page, 'd2', 'd4')
    await again.accept()
    expect([piece(page, 'e7') !== '', piece(page, 'e5'), waits(page)]).toEqual([true, '', true])
    page.close()
    const other = await opened('chess')
    const lost = moved(other, 'e2', 'e4')
    await other.set({ reply: 'e7e5' })
    await lost.refuse()
    // The move was taken back, and what was set for it is not an answer to the one made in its place
    expect([piece(other, 'e2') !== '', waits(other)]).toEqual([true, false])
    await moved(other, 'd2', 'd4').accept()
    expect([piece(other, 'e7') !== '', piece(other, 'e5'), waits(other)]).toEqual([true, '', true])
    other.close()
  })
})
