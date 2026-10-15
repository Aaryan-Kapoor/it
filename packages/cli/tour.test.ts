// The tour: the guide an agent follows, and the pages it shows. What the guide tells an agent to
// run is held to the pages there are, what it tells the agent to expect of a page is held to
// what the page sends, and what a page is filled in with is held to its place in the page,
// since some of it is the agent's own words.
import { existsSync } from 'node:fs'
import { LIMITS } from '@it/protocol'
import { chromium } from 'playwright'
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

  test('an agent that nothing arrives for by itself is told to wait for each thing in turn, with a command that ends, and never with one left in the background', () => {
    const rule = GUIDE.split('\n').find((line) => line.startsWith('1. **Never block.**'))!
    // A waiter left running prints what was done to nobody: in most agent apps what a command
    // in the background prints is seen only when it is asked for, and an agent that has ended its turn asks for nothing
    expect(rule).toContain('run `it wait --timeout 100` and act on what it prints')
    expect(rule).toContain('`it wait --id tour-menu --timeout 100`')
    expect(rule).toContain('do not use `--follow` or put a wait in the background')
    // Nowhere does the guide have the agent start a waiter that goes on, or stop one
    expect(GUIDE).not.toContain('it wait --follow')
    expect(GUIDE).not.toMatch(/it wait [^`]*--follow/)
  })

  test('every action a page sends by name is spoken of where the guide tells the agent of that page', () => {
    const parts = GUIDE.split(/^## /m)
    for (const name of NAMES) {
      const part = parts.find((text) => text.includes(`\nit tour show ${name}\n`))!
      const sends = [...tourPage(name).html.matchAll(/(?:It\.action|Tour\.act)\("([a-z:]+)"/g)].map((m) => m[1]!)
      for (const action of new Set(sends)) expect(part, `${name} sends ${action}`).toContain(`\`${action}\``)
    }
    // A board that was wiped is wiped of the agent's lines only on the page: the agent is told to take them out of the state, where the page reads them again
    expect(parts.find((text) => text.startsWith('The whiteboard'))).toContain('it patch tour-whiteboard \'{"agent_strokes":[],"note":""}\'')
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
})

describe('the whiteboard', () => {
  type Page = Awaited<ReturnType<typeof opened>>
  /** A board 900 by 600, whose picture is the text given: the stand-in draws nothing, and has no picture of its own to give. */
  const board = (picture: string | null) => (w: any) => {
    const ink = new Proxy({}, { get: () => () => {}, set: () => true })
    w.ResizeObserver = class {
      observe() {}
    }
    w.HTMLCanvasElement.prototype.getContext = () => ink
    w.HTMLCanvasElement.prototype.toDataURL = () => picture
    w.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600 })
    w.Element.prototype.setPointerCapture = () => {}
  }
  /** One line drawn with the pen, through the points given as parts of the board. */
  const drawn = (page: Page, points: [number, number][]) => {
    const canvas = page.$('#c')
    points.forEach(([x, y], i) => {
      canvas.dispatchEvent(new page.w.PointerEvent(i ? 'pointermove' : 'pointerdown', { clientX: x * 900, clientY: y * 600, pointerId: 1, bubbles: true }))
    })
    canvas.dispatchEvent(new page.w.PointerEvent('pointerup', { pointerId: 1, bubbles: true }))
  }
  /** Many lines of so many points each, no two alike, as a hand draws them. */
  const scribbled = (page: Page, lines: number, points: number) => {
    for (let l = 0; l < lines; l++)
      drawn(
        page,
        Array.from({ length: points }, (_, i) => [((l * 37 + i * 11) % 899) / 899 + 0.0004, ((l * 53 + i * 7) % 599) / 599 + 0.0004] as [number, number]),
      )
  }
  const bytes = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)).length
  const PICTURE = `data:image/png;base64,${'A'.repeat(9000)}`

  test('a drawing is sent small enough for an action to hold, with fewer points along its lines where it must be, and without its picture where that is not enough', async () => {
    // A short drawing goes whole, with its picture
    const short = await opened('whiteboard', board(PICTURE))
    scribbled(short, 3, 20)
    short.$('#send').click()
    expect(short.sent.at(-1)).toMatchObject({ name: 'snapshot', data: { png: PICTURE } })
    expect(short.sent.at(-1)!.data.strokes.map((s: any) => s.points.length)).toEqual([20, 20, 20])
    short.close()
    // Many short lines, which is where most of what is sent is not points at all: each line keeps its two ends and loses what is between
    for (const [lines, points, picture] of [
      [70, 30, null],
      [180, 10, null],
      [180, 10, PICTURE],
      [300, 12, PICTURE],
    ] as const) {
      const page = await opened('whiteboard', board(picture))
      scribbled(page, lines, points)
      page.$('#send').click()
      const { name, data } = page.sent.at(-1)!
      expect(name).toBe('snapshot')
      expect(bytes(data), `${lines} lines of ${points}`).toBeLessThanOrEqual(LIMITS.actionPayloadBytes)
      expect(data.strokes.length).toBe(lines)
      for (const s of data.strokes) expect(s.points.length).toBeGreaterThanOrEqual(2)
      page.close()
    }
    // One long line is thinned, and still begins and ends where it did
    const long = await opened('whiteboard', board(null))
    scribbled(long, 1, 4000)
    long.$('#send').click()
    const [line] = long.sent.at(-1)!.data.strokes
    expect(bytes(long.sent.at(-1)!.data)).toBeLessThanOrEqual(LIMITS.actionPayloadBytes)
    expect(line.points.length).toBeGreaterThan(1000)
    expect([line.points[0], line.points.at(-1)]).toEqual([
      [0, 0],
      [0.931, 0.733],
    ])
    long.close()
  })

  test('a drawing of more lines than an action holds goes as its picture alone, and where that does not fit either the person is told what to do, and not to send the same again', async () => {
    const page = await opened('whiteboard', board(PICTURE))
    scribbled(page, 600, 1)
    page.$('#send').click()
    expect(page.sent.at(-1)).toMatchObject({ name: 'snapshot', data: { png: PICTURE, strokes: [] } })
    page.close()
    // No picture to be had, or one that is too large by itself: nothing is sent, since it would only be refused
    for (const picture of [null, `data:image/png;base64,${'A'.repeat(40_000)}`]) {
      const stuck = await opened('whiteboard', board(picture))
      scribbled(stuck, 600, 1)
      stuck.$('#send').click()
      expect(stuck.sent).toEqual([])
      expect(stuck.$('#t-you b').textContent).toBe('That is too many lines to send at once. Undo some, or clear the board, and send it again.')
      // Sending is theirs again once the drawing is another
      expect(stuck.$('#send').disabled).toBe(true)
      for (let i = 0; i < 300; i++) stuck.$('#undo').click()
      expect(stuck.$('#send').disabled).toBe(false)
      stuck.$('#send').click()
      expect(stuck.sent.at(-1)).toMatchObject({ name: 'snapshot', data: { png: null } })
      expect(stuck.sent.at(-1)!.data.strokes.length).toBe(300)
      expect(bytes(stuck.sent.at(-1)!.data)).toBeLessThanOrEqual(LIMITS.actionPayloadBytes)
      stuck.close()
    }
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
    await after.set({ reply: `${first.data.request}:e7e5` })
    expect([piece(after, 'e7'), piece(after, 'e5') !== '', waits(after)]).toEqual(['', true, false])
    after.close()
    // A connection that dropped brings the two back in the other order: the answer is kept
    // for the move it was heard after, and played when that move is known to have reached the agent
    const before = await opened('chess')
    const move = moved(before, 'e2', 'e4')
    await before.set({ reply: `${move.data.request}:e7e5` })
    expect([piece(before, 'e5'), waits(before)]).toEqual(['', true])
    await move.accept()
    expect([piece(before, 'e7'), piece(before, 'e5') !== '', waits(before)]).toEqual(['', true, false])
    // And the board is the person's again
    expect(moved(before, 'g1', 'f3')).toMatchObject({ name: 'move', data: { move: 'g1f3' } })
    before.close()
  })

  test('an answer that was heard early is not played in a new game, nor after a move that did not go', async () => {
    const page = await opened('chess')
    const first = moved(page, 'e2', 'e4')
    await page.set({ reply: `${first.data.request}:e7e5` })
    page.$('#new').click()
    const again = moved(page, 'd2', 'd4')
    await again.accept()
    expect([piece(page, 'e7') !== '', piece(page, 'e5'), waits(page)]).toEqual([true, '', true])
    page.close()
    const other = await opened('chess')
    const lost = moved(other, 'e2', 'e4')
    await other.set({ reply: `${lost.data.request}:e7e5` })
    await lost.refuse()
    // The move was taken back, and what was set for it is not an answer to the one made in its place
    expect([piece(other, 'e2') !== '', waits(other)]).toEqual([true, false])
    await moved(other, 'd2', 'd4').accept()
    expect([piece(other, 'e7') !== '', piece(other, 'e5'), waits(other)]).toEqual([true, '', true])
    other.close()
  })

  test('a reply names the pending move, so an old answer cannot play after a reset or another turn', async () => {
    const page = await opened('chess')
    const old = moved(page, 'e2', 'e4')
    await old.accept()
    page.$('#new').click()
    const reset = page.sent.at(-1)!
    const current = moved(page, 'd2', 'd4')
    await current.accept()
    await reset.accept()
    expect(waits(page)).toBe(true)
    expect(current.data.request).not.toBe(old.data.request)
    for (const reply of ['e7e5', `${old.data.request}:e7e5`]) {
      await page.set({ reply })
      expect([piece(page, 'e7') !== '', piece(page, 'e5'), waits(page)]).toEqual([true, '', true])
    }
    // The correct first answer after reset is accepted, even when an old answer arrived first.
    await page.set({ reply: `${current.data.request}:e7e5` })
    expect([piece(page, 'e7'), piece(page, 'e5') !== '', waits(page)]).toEqual(['', true, false])
    const next = moved(page, 'g1', 'f3')
    await next.accept()
    await page.set({ reply: `${current.data.request}:g8f6`, note: 'A late note.' })
    expect([piece(page, 'g8') !== '', piece(page, 'f6'), waits(page)]).toEqual([true, '', true])
    await page.set({ reply: `${next.data.request}:g8f6` })
    expect([piece(page, 'g8'), piece(page, 'f6') !== '', waits(page)]).toEqual(['', true, false])
    page.close()
  })

  test('an early illegal answer requests a correction for the same move only once', async () => {
    const page = await opened('chess')
    const move = moved(page, 'e2', 'e4')
    const reply = `${move.data.request}:e7e9`
    await page.set({ reply })
    await page.set({ reply })
    await move.accept()
    expect(page.sent.filter((x) => x.name === 'illegal')).toMatchObject([{ data: { request: move.data.request, move: 'e7e9' } }])
    await page.set({ reply, note: 'Try again.' })
    expect(page.sent.filter((x) => x.name === 'illegal')).toHaveLength(1)
    await page.set({ reply: `${move.data.request}:e7e5` })
    expect(waits(page)).toBe(false)
    page.close()
  })
})

describe('the drum machine', () => {
  type Page = Awaited<ReturnType<typeof opened>>
  /** A page that makes no sound and keeps no time of its own: what is asked here is only what it tells the agent. */
  const silent = (w: any) => {
    w.setInterval = () => 0
    w.clearInterval = () => {}
    w.requestAnimationFrame = () => 0
    w.cancelAnimationFrame = () => {}
  }
  /** One pad tapped: the drum, from the top, and the step. */
  const tapped = (page: Page, drum: number, step: number) => page.$(`.pad[data-r="${drum}"][data-c="${step}"]`).click()
  const told = (page: Page) => page.sent.map((s) => [s.name, s.data.pattern?.join('/')])

  test('a beat of a single hit goes to the agent a moment after the person leaves it alone, as any beat does', async () => {
    const page = await opened('drums', silent)
    tapped(page, 3, 0)
    await page.advance(1400)
    expect(page.sent).toEqual([])
    await page.advance(100)
    expect(told(page)).toEqual([['beat', '......../......../......../x.......']])
    expect(page.$('#t-you b').textContent).toBe('put down 1 hit')
    page.close()
  })

  test('a beat the person takes hits off goes again as it is left, and the agent is told when the last hit is off', async () => {
    const page = await opened('drums', silent)
    tapped(page, 3, 0)
    tapped(page, 2, 4)
    await page.advance(1500)
    await page.sent[0]!.accept()
    tapped(page, 2, 4)
    await page.advance(1500)
    tapped(page, 3, 0)
    await page.advance(1500)
    expect(told(page)).toEqual([
      ['beat', '......../......../....x.../x.......'],
      ['beat', '......../......../......../x.......'],
      ['cleared', undefined],
    ])
    expect(page.$('#t-you b').textContent).toBe('took the last hit off')
    // Left empty, nothing more is said of it
    await page.advance(5000)
    expect(page.sent.length).toBe(3)
    page.close()
    // Pads that were emptied before the agent heard of any beat are nothing to tell it
    const idle = await opened('drums', silent)
    tapped(idle, 0, 1)
    tapped(idle, 0, 1)
    await idle.advance(5000)
    expect(idle.sent).toEqual([])
    idle.close()
  })

  test('taking off the last hit clears the agent pattern and stops playback before the agent answers', async () => {
    const page = await opened('drums', silent)
    tapped(page, 3, 0)
    await page.advance(1500)
    await page.sent[0]!.accept()
    await page.set({ theirs: ['x.......', '........', '........', '........'] })
    expect(page.$('#play').getAttribute('data-on')).toBe('1')
    tapped(page, 3, 0)
    await page.advance(1500)
    expect(page.$('#play').getAttribute('data-on')).toBe('0')
    expect(page.$('.pad[data-r="0"][data-c="0"]').classList.contains('theirs')).toBe(false)
    expect(page.$('#t-did').classList.contains('in')).toBe(false)
    expect(page.sent.at(-1)?.name).toBe('cleared')
    // Repeating unrelated state does not bring the old agent pattern back.
    await page.set({ theirs: ['x.......', '........', '........', '........'], note: 'Still here' })
    expect(page.$('#play').getAttribute('data-on')).toBe('0')
    page.close()
  })
})

describe('the ways on', () => {
  const SLOW = 40_000

  test('the two buttons of a page are the person’s again when the agent has not moved on a while after it was asked to', async () => {
    const page = await opened('button')
    const [more, next] = [page.$('#t-more'), page.$('#t-next')]
    next.click()
    expect(page.sent.at(-1)).toMatchObject({ name: 'next', data: { from: 'button' } })
    expect([more.disabled, next.disabled, next.textContent]).toEqual([true, true, 'Coming up…'])
    await page.sent.at(-1)!.accept()
    // An agent that moves on takes the page away. One that is only slow is not hurried
    await page.advance(SLOW - 1)
    expect([more.disabled, next.disabled, next.textContent]).toEqual([true, true, 'Coming up…'])
    await page.advance(1)
    expect([more.disabled, next.disabled, next.textContent]).toEqual([false, false, 'Next'])
    expect(page.$('#t-plate small').textContent).toBe('has not answered')
    // And the other way is open, as it was
    more.click()
    expect(page.sent.at(-1)).toMatchObject({ name: 'menu' })
    expect([more.disabled, next.disabled, more.textContent]).toEqual([true, true, 'One moment…'])
    // A press that It did not take is given back at once
    await page.sent.at(-1)!.refuse()
    expect([more.disabled, next.disabled, more.textContent]).toEqual([false, false, 'All of them'])
    page.close()
    // A button that is given back may be pressed twice, so the agent is told how a second press is known
    expect(GUIDE).toContain('`next` and `menu` carry `from`, the page they were pressed on')
  })

  test('the menu is open again when the agent has not shown what was picked a while after, unless it is something of the person’s own, which takes as long as it takes', async () => {
    const page = await opened('menu')
    const thing = (choice: string) => page.$(`.thing[data-choice="${choice}"]`)
    thing('chess').click()
    expect(page.sent.at(-1)).toMatchObject({ name: 'pick', data: { choice: 'chess' } })
    await page.sent.at(-1)!.accept()
    await page.advance(SLOW - 1)
    expect([thing('chess').disabled, thing('drums').disabled, page.$('#enough').disabled]).toEqual([true, true, true])
    await page.advance(1)
    expect([thing('chess').disabled, thing('drums').disabled, page.$('#enough').disabled]).toEqual([false, false, false])
    expect(page.$('#status').textContent).toBe('Your agent has not answered. Pick again, or pick another.')
    // A menu the agent opens again in the meantime is not said to be unanswered later
    thing('drums').click()
    await page.sent.at(-1)!.accept()
    await page.set({ seen: ['drums'] })
    await page.advance(SLOW)
    expect([thing('drums').disabled, page.$('#status').textContent]).toEqual([false, ''])
    // "That's enough for now" is given back in the same way
    page.$('#enough').click()
    await page.sent.at(-1)!.accept()
    await page.advance(SLOW)
    expect([page.$('#enough').disabled, page.$('#status').textContent]).toEqual([false, 'Your agent has not answered. Pick again, or pick another.'])
    // What the person names is made from nothing, which takes an agent longer than this: the menu waits for it
    page.$('#text').value = 'a tip calculator'
    page.$('#own').dispatchEvent(new page.w.Event('submit', { cancelable: true }))
    expect(page.sent.at(-1)).toMatchObject({ name: 'pick', data: { choice: 'other', text: 'a tip calculator' } })
    await page.sent.at(-1)!.accept()
    await page.advance(SLOW * 5)
    expect([thing('chess').disabled, page.$('#enough').disabled]).toEqual([true, true])
    page.close()
  })

  test('the two buttons of the ending are the person’s again when the agent has not answered a while after', async () => {
    const page = await opened('done')
    const [finish, more] = [page.$('#finish'), page.$('#more')]
    finish.click()
    expect(page.sent.at(-1)).toMatchObject({ name: 'finish' })
    await page.sent.at(-1)!.accept()
    await page.advance(SLOW - 1)
    expect([finish.disabled, more.disabled, page.$('#status').textContent]).toEqual([true, true, 'Wrapping up'])
    await page.advance(1)
    expect([finish.disabled, more.disabled, page.$('#status').textContent]).toEqual([false, false, 'Your agent has not answered. Try again.'])
    // An ending the agent opens again in the meantime is not said to be unanswered later
    more.click()
    await page.sent.at(-1)!.accept()
    await page.set({ status: 'open' })
    await page.advance(SLOW)
    expect([finish.disabled, more.disabled, page.$('#status').textContent]).toEqual([false, false, ''])
    page.close()
  })
})

// How a page is laid out is only known in a browser, so this is run in one, where one is installed
describe.skipIf('Bun' in globalThis || !existsSync(chromium.executablePath()))('the menu on a phone', () => {
  test.each([320, 390])('keeps the exit button inside a %i pixel page while the status changes', async (width) => {
    const browser = await chromium.launch({ timeout: 0 })
    try {
      const tab = await browser.newPage({ viewport: { width, height: 844 } })
      // It takes whatever the page sends, and never answers
      await tab.clock.install()
      await tab.setContent(
        tourPage('menu').html.replace(
          '<head>',
          '<head><script>window.It = { state: {}, onState: () => () => {}, action: () => Promise.resolve({ ok: true }) }</script>',
        ),
      )
      const enough = () =>
        tab.locator('#enough').evaluate((el) => ({ shows: el.clientHeight, holds: el.scrollHeight, tall: el.getBoundingClientRect().height }))
      const alone = await enough()
      expect(alone.holds).toBeLessThanOrEqual(alone.shows)
      await tab.locator('.thing[data-choice="chess"]').click()
      expect(await tab.locator('#status').textContent()).toBe('Your agent is getting it ready. It takes a few seconds.')
      // The words beside it take the lines they need, and the button is as it was
      expect(await enough()).toEqual(alone)
      // And the light before those words is as round as it was made
      const light = await tab.locator('#status').evaluate((el) => getComputedStyle(el, '::before').width)
      expect(light).toBe('8px')
      await tab.clock.fastForward(40_001)
      expect(await tab.locator('#status').textContent()).toContain('has not answered')
      expect(await enough()).toEqual(alone)
      expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    } finally {
      await browser.close()
    }
  })
})
