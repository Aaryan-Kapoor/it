// The tour: the guide an agent follows, and the pages it shows. What the guide tells an agent to
// run is held to the pages there are, what it tells the agent to expect of a page is held to
// what the page sends, and what a page is filled in with is held to its place in the page,
// since some of it is the agent's own words.
import { existsSync } from 'node:fs'
import { LIMITS, TOUR_NAMES } from '@it/protocol'
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
async function opened(
  name: string,
  before: (w: any) => void = () => {},
  given: { state?: Record<string, unknown>; params?: Record<string, unknown>; calm?: boolean } = {},
) {
  const page = tourPage(name, given.params)
  const sent: Sent[] = []
  const listeners: (() => void)[] = []
  const settled = () => new Promise<void>((done) => setImmediate(done))
  let now = 0
  let timers: { id: number; at: number; fn: () => void }[] = []
  const It = {
    state: { ...JSON.parse(page.state), ...given.state } as Record<string, unknown>,
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
      // The stand-in draws nothing, and says so once for every page if it is asked to
      w.HTMLCanvasElement.prototype.getContext = () => null
      // Nothing moves on the page, so nothing is asked of the stand-in that it cannot draw
      w.matchMedia = () => ({ matches: given.calm !== false })
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
    all: (selector: string) => [...w.document.querySelectorAll(selector)] as any[],
    /** What stands on the agent's hand, and how the hand stands: `live` while it says the agent is at work. */
    hand: () => [w.document.querySelector('#w-tag').textContent.replace(/ · \d+ s$/, ''), w.document.querySelector('#w-hand').dataset.tone] as [string, string],
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
    expect(NAMES).toEqual(TOUR_NAMES)
    expect(STEPS).toEqual(['room', 'whiteboard', 'chess', 'checklist', 'drums', 'button'])
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
      expect(page.html, name).not.toMatch(/\/\*(kit|world|navigation)\.(css|js)\*\/|<!--rail-->/)
      expect(page.html).toContain('<script>window.__PARAMS = {')
      expect(params(page.html).tour_id).toBe(name)
      expect(typeof JSON.parse(page.state)).toBe('object')
      // It speaks to It through the script every page is given, and to nothing else
      expect(page.html).toMatch(/It\.(action|onState)\(/)
      expect(page.html, name).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|localStorage/)
    }
  })

  test('every thing carries the agent’s hand, the two lines of what each did, and the two buttons that go on', () => {
    for (const step of STEPS) {
      const { html } = tourPage(step)
      for (const id of ['t-you', 't-did', 't-more', 't-next']) expect(html, `${step} #${id}`).toContain(`id="${id}"`)
      // The hand is made by the world every page is held in
      expect(html, `${step} hand`).toContain("make('div', 'w-hand')")
      // Each button is an ordinary action: the agent is what moves the tour on
      expect(html).toContain("go(more, 'menu'")
      expect(html).toContain("go(next, 'next'")
    }
    // The menu and the ending are ways on themselves
    expect(tourPage(MENU).html).not.toContain('id="t-next"')
    expect(tourPage(END).html).not.toContain('id="t-next"')
  })

  test('the name of the agent app that gives the tour is given to the page, for the hand’s plate, where it is known', () => {
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
      ['menu', 'touched'],
      ['room', 'press'],
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
      ['menu', 'marks'],
      ['menu', 'mine'],
      ['menu', 'line'],
      ['room', 'tiles'],
      ['room', 'note'],
      ['room', 'doing'],
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
  /** A board 900 by 600, whose picture is the file given, or none: the stand-in draws nothing, and has no picture of its own to give. */
  const board = (picture: 'a picture' | null) => (w: any) => {
    const ink = new Proxy({}, { get: () => () => {}, set: () => true })
    w.ResizeObserver = class {
      observe() {}
    }
    w.HTMLCanvasElement.prototype.getContext = () => ink
    w.HTMLCanvasElement.prototype.toBlob = (made: (b: Blob | null) => void) => made(picture ? new w.Blob(['the picture'], { type: 'image/png' }) : null)
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
  const PICTURE = 'a picture'
  /** What was sent last, once the picture of the drawing has been made, which takes a moment. */
  const lastSent = async (page: Page) => {
    await new Promise((done) => setImmediate(done))
    return page.sent.at(-1)
  }

  test('a drawing is sent with its picture as a file beside it, and its lines small enough for an action to hold, with fewer points along them where they must be', async () => {
    // A short drawing goes whole, with its picture
    const short = await opened('whiteboard', board(PICTURE))
    scribbled(short, 3, 20)
    short.$('#send').click()
    const first = await lastSent(short)
    expect(first?.name).toBe('snapshot')
    expect(first?.data.png).toBeInstanceOf(short.w.Blob)
    expect(first?.data.png.type).toBe('image/png')
    expect(first!.data.strokes.map((s: any) => s.points.length)).toEqual([20, 20, 20])
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
      const { name, data } = (await lastSent(page))!
      expect(name).toBe('snapshot')
      expect(bytes(data), `${lines} lines of ${points}`).toBeLessThanOrEqual(LIMITS.actionPayloadBytes)
      expect(data.strokes.length).toBe(lines)
      expect(data.png === null).toBe(picture === null)
      for (const s of data.strokes) expect(s.points.length).toBeGreaterThanOrEqual(2)
      page.close()
    }
    // One long line is thinned, and still begins and ends where it did
    const long = await opened('whiteboard', board(null))
    scribbled(long, 1, 4000)
    long.$('#send').click()
    const thinned = (await lastSent(long))!
    const [line] = thinned.data.strokes
    expect(bytes(thinned.data)).toBeLessThanOrEqual(LIMITS.actionPayloadBytes)
    expect(line.points.length).toBeGreaterThan(1000)
    expect([line.points[0], line.points.at(-1)]).toEqual([
      [0, 0],
      [0.931, 0.733],
    ])
    long.close()
  })

  test('a drawing of more lines than an action holds goes as its picture alone, and where there is no picture the person is told what to do, and not to send the same again', async () => {
    const page = await opened('whiteboard', board(PICTURE))
    scribbled(page, 600, 1)
    page.$('#send').click()
    const alone = (await lastSent(page))!
    expect([alone.name, alone.data.strokes, alone.data.png.type]).toEqual(['snapshot', [], 'image/png'])
    page.close()
    // No picture to be had: nothing is sent, since it would only be refused
    const stuck = await opened('whiteboard', board(null))
    scribbled(stuck, 600, 1)
    stuck.$('#send').click()
    await lastSent(stuck)
    expect(stuck.sent).toEqual([])
    expect(stuck.$('#t-you b').textContent).toBe('That is too many lines to send at once. Undo some, or clear the board, and send it again.')
    // Sending is theirs again once the drawing is another
    expect(stuck.$('#send').disabled).toBe(true)
    for (let i = 0; i < 300; i++) stuck.$('#undo').click()
    expect(stuck.$('#send').disabled).toBe(false)
    stuck.$('#send').click()
    const fewer = (await lastSent(stuck))!
    expect(fewer).toMatchObject({ name: 'snapshot', data: { png: null } })
    expect(fewer.data.strokes.length).toBe(300)
    expect(bytes(fewer.data)).toBeLessThanOrEqual(LIMITS.actionPayloadBytes)
    stuck.close()
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

  test.each(['adding a hit', 'removing a hit', 'removing the last hit', 'undoing an edit'])(
    'a reply to the previous beat is ignored during the pause after %s',
    async (edit) => {
      const page = await opened('drums', silent)
      try {
        tapped(page, 3, 0)
        if (edit === 'removing a hit') tapped(page, 2, 4)
        await page.advance(1500)
        const first = page.sent[0]!.data.request
        await page.sent[0]!.accept()
        if (edit === 'removing the last hit') tapped(page, 3, 0)
        else tapped(page, 2, 4)
        if (edit === 'undoing an edit') tapped(page, 2, 4)
        await page.advance(1400)
        expect(page.sent).toHaveLength(1)
        const stale = { request: first, pattern: ['x.......', '........', '........', '........'], note: 'Old beat' }
        for (const theirs of [stale, stale.pattern]) {
          await page.set({ theirs, note: 'Old beat' })
          expect(page.$('.pad.theirs')).toBeNull()
          expect(page.$('#play').getAttribute('data-on')).toBe('0')
          expect(page.$('#t-did').classList.contains('in')).toBe(false)
        }
        await page.advance(100)
        expect(page.sent).toHaveLength(2)
        if (edit === 'removing the last hit') {
          expect(page.sent[1]!.name).toBe('cleared')
          await page.set({ theirs: stale })
          expect(page.$('.pad.theirs')).toBeNull()
          expect(page.$('#play').getAttribute('data-on')).toBe('0')
          return
        }
        const next = page.sent[1]!.data.request
        expect(next).not.toBe(first)
        expect(page.sent[1]!.name).toBe('beat')
        await page.set({ theirs: { request: next, pattern: ['..x.....', '........', '........', '........'], note: 'New beat' } })
        expect(page.$('.pad[data-r="0"][data-c="2"]').classList.contains('theirs')).toBe(true)
        expect(page.$('#t-did b').textContent).toBe('New beat')
        expect(page.$('#play').getAttribute('data-on')).toBe('1')
        await page.set({ theirs: stale })
        expect(page.$('.pad[data-r="0"][data-c="0"]').classList.contains('theirs')).toBe(false)
        expect(page.$('.pad[data-r="0"][data-c="2"]').classList.contains('theirs')).toBe(true)
        expect(page.$('#t-did b').textContent).toBe('New beat')
      } finally {
        page.close()
      }
    },
  )

  test.each(['last hit', 'clear button'])('a late reply cannot restore the pads after clearing with %s', async (how) => {
    const page = await opened('drums', silent)
    tapped(page, 3, 0)
    await page.advance(1500)
    await page.sent[0]!.accept()
    if (how === 'last hit') {
      tapped(page, 3, 0)
      await page.advance(1500)
    } else page.$('#clear').click()
    await page.set({ theirs: ['x.......', '........', '........', '........'], note: 'Late reply' })
    expect(page.$('.pad.theirs')).toBeNull()
    expect(page.$('#play').getAttribute('data-on')).not.toBe('1')
    expect(page.$('#t-did').classList.contains('in')).toBe(false)
    tapped(page, 2, 4)
    await page.advance(1500)
    await page.set({ theirs: { request: page.sent.at(-1)!.data.request, pattern: ['..x.....', '........', '........', '........'], note: 'New reply' } })
    expect(page.$('.pad[data-r="0"][data-c="2"]').classList.contains('theirs')).toBe(true)
    page.close()
  })

  test.each(['last hit', 'clear button'])('a reply for a beat cleared with %s stays ignored after the next beat was sent', async (how) => {
    const page = await opened('drums', silent)
    tapped(page, 3, 0)
    await page.advance(1500)
    const first = page.sent[0]!.data.request
    await page.sent[0]!.accept()
    if (how === 'last hit') {
      tapped(page, 3, 0)
      await page.advance(1500)
    } else page.$('#clear').click()
    tapped(page, 2, 4)
    await page.advance(1500)
    const next = page.sent.at(-1)!.data.request
    expect(typeof first).toBe('string')
    expect(next).not.toBe(first)
    const stale = { request: first, pattern: ['x.......', '........', '........', '........'], note: 'Old beat' }
    for (const theirs of [stale.pattern, stale]) {
      await page.set({ theirs, note: 'Old beat' })
      expect(page.$('.pad.theirs')).toBeNull()
      expect(page.$('#play').getAttribute('data-on')).toBe('0')
      expect(page.$('#t-did').classList.contains('in')).toBe(false)
    }
    await page.set({ theirs: { request: next, pattern: ['..x.....', '........', '........', '........'], note: 'New beat' } })
    expect(page.$('.pad[data-r="0"][data-c="2"]').classList.contains('theirs')).toBe(true)
    expect(page.$('#t-did b').textContent).toBe('New beat')
    expect(page.$('#play').getAttribute('data-on')).toBe('1')
    await page.set({ theirs: stale })
    expect(page.$('.pad[data-r="0"][data-c="0"]').classList.contains('theirs')).toBe(false)
    expect(page.$('.pad[data-r="0"][data-c="2"]').classList.contains('theirs')).toBe(true)
    expect(page.$('#t-did b').textContent).toBe('New beat')
    page.close()
  })

  test('taking off the last hit clears the agent pattern and stops playback before the agent answers', async () => {
    const page = await opened('drums', silent)
    tapped(page, 3, 0)
    await page.advance(1500)
    await page.sent[0]!.accept()
    await page.set({ theirs: { request: page.sent.at(-1)!.data.request, pattern: ['x.......', '........', '........', '........'] } })
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

describe('what the hand says of an answer', () => {
  test('an answer that comes before It has said that it took what was done is not undone when It then says so', async () => {
    const page = await opened('button')
    page.$('#big').click()
    expect(page.sent.at(-1)).toMatchObject({ name: 'press' })
    // The agent's answer is heard first, and then It's word that the press was taken
    await page.set({ status: 'done', note: 'shipped it' })
    const answered = page.hand()
    expect(answered[1]).not.toBe('live')
    await page.sent.at(-1)!.accept()
    await page.advance(2000)
    expect(page.hand()).toEqual(answered)
    expect(page.hand()[0]).not.toContain('has not answered yet')
    page.close()
  })

  test('something done after an answer is unanswered again once It has taken it', async () => {
    const page = await opened('checklist')
    page.all('.item input, .item button, li button')[0]?.click()
    if (!page.sent.length) return page.close()
    await page.sent.at(-1)!.accept()
    expect(page.hand()).toEqual(['Your agent · has not answered yet', 'live'])
    page.close()
  })
})

describe('what a page does with a state that is not as the guide gives it', () => {
  test('the whiteboard draws only the places of a line that are two numbers, and stops tracing a line that has none to go along', async () => {
    const page = await opened('whiteboard')
    await page.set({
      agent_strokes: [
        {
          points: [
            [0, 0],
            ['bad', 1],
            [0.5, Number.NaN],
            [0.4, 0.4],
          ],
          width: 4,
        },
        { points: [['x', 'y']] },
      ],
    })
    // Whatever it draws, it comes to rest: nothing is left asking for another frame for ever
    for (let i = 0; i < 40; i++) await page.advance(200)
    const before = page.w.__frames ?? 0
    for (let i = 0; i < 20; i++) await page.advance(200)
    expect(page.w.__frames ?? 0).toBe(before)
    page.close()
  })

  test('the control room takes a tile under any id, one that every object has among them', async () => {
    const page = await opened('room')
    await page.set({
      tiles: { toString: { at: 1, label: 'odd', title: 'A tile named toString' }, constructor: { at: 2, label: 'odd', title: 'And one named constructor' } },
    })
    for (let i = 0; i < 20; i++) await page.advance(300)
    expect(page.all('.tile .title').map((el: any) => el.textContent)).toEqual(expect.arrayContaining(['A tile named toString', 'And one named constructor']))
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
    // The button that was pressed is marked, and says what it said. The hand says nothing until It has taken the press
    expect([more.disabled, next.disabled, next.textContent, next.getAttribute('data-picked')]).toEqual([true, true, 'Next', '1'])
    expect(page.hand()).toEqual(['Your agent', ''])
    await page.sent.at(-1)!.accept()
    expect(page.hand()).toEqual(['Your agent · has not answered yet', 'live'])
    // An agent that moves on takes the page away. One that is only slow is not hurried
    await page.advance(SLOW - 1)
    expect([more.disabled, next.disabled, next.getAttribute('data-picked')]).toEqual([true, true, '1'])
    await page.advance(1)
    expect([more.disabled, next.disabled, next.textContent, next.getAttribute('data-picked')]).toEqual([false, false, 'Next', null])
    expect(page.hand()).toEqual(['Your agent · has not answered', ''])
    // And the other way is open, as it was
    more.click()
    expect(page.sent.at(-1)).toMatchObject({ name: 'menu' })
    expect([more.disabled, next.disabled, more.getAttribute('data-picked')]).toEqual([true, true, '1'])
    // A press that It did not take is given back at once
    await page.sent.at(-1)!.refuse()
    expect([more.disabled, next.disabled, more.textContent, more.getAttribute('data-picked')]).toEqual([false, false, 'All of them', null])
    page.close()
    // A button that is given back may be pressed twice, so the agent is told how a second press is known
    expect(GUIDE).toContain('`next` and `menu` carry `from`, the page they were pressed on')
  })

  test('the choices are open again when the agent has not shown what was picked a while after, unless it is something of the person’s own, which takes as long as it takes', async () => {
    const page = await opened('menu', undefined, { state: { seen: ['whiteboard'] } })
    const thing = (choice: string) => page.$(`.thing[data-choice="${choice}"]`)
    const UNANSWERED = 'Your agent · has not answered. Pick again, or say it in its chat'
    thing('chess').click()
    expect(page.sent.at(-1)).toMatchObject({ name: 'pick', data: { choice: 'chess' } })
    await page.sent.at(-1)!.accept()
    expect(page.hand()).toEqual(['Your agent · has not answered yet', 'live'])
    await page.advance(SLOW - 1)
    expect([thing('chess').disabled, thing('drums').disabled, page.$('#enough').disabled]).toEqual([true, true, true])
    await page.advance(1)
    expect([thing('chess').disabled, thing('drums').disabled, page.$('#enough').disabled]).toEqual([false, false, false])
    expect(page.hand()).toEqual([UNANSWERED, ''])
    // An agent that shows something in the meantime is not said to be unanswered later
    thing('drums').click()
    await page.sent.at(-1)!.accept()
    await page.set({ seen: ['whiteboard', 'drums'] })
    await page.advance(SLOW)
    expect([thing('drums').disabled, page.hand()]).toEqual([false, ['Your agent', '']])
    // "That is enough for now" is given back in the same way
    page.$('#enough').click()
    await page.sent.at(-1)!.accept()
    await page.advance(SLOW)
    expect([page.$('#enough').disabled, page.hand()]).toEqual([false, [UNANSWERED, '']])
    // What the person names is made from nothing, which takes an agent longer than this: the page waits for it
    page.$('#text').value = 'a tip calculator'
    page.$('#own').dispatchEvent(new page.w.Event('submit', { cancelable: true }))
    expect(page.sent.at(-1)).toMatchObject({ name: 'pick', data: { choice: 'other', text: 'a tip calculator' } })
    await page.sent.at(-1)!.accept()
    await page.advance(SLOW * 5)
    expect([thing('chess').disabled, page.$('#enough').disabled]).toEqual([true, true])
    expect(page.hand()).toEqual(['Your agent · has not answered yet', 'live'])
    page.close()
  })

  test('the two buttons of the ending are the person’s again when the agent has not answered a while after', async () => {
    const page = await opened('done')
    const [finish, more] = [page.$('#finish'), page.$('#more')]
    finish.click()
    expect(page.sent.at(-1)).toMatchObject({ name: 'finish' })
    await page.sent.at(-1)!.accept()
    await page.advance(SLOW - 1)
    expect([finish.disabled, more.disabled, page.hand()]).toEqual([true, true, ['Your agent · has not answered yet', 'live']])
    await page.advance(1)
    expect([finish.disabled, more.disabled, page.hand()]).toEqual([false, false, ['Your agent · has not answered. Try again', '']])
    // An ending the agent opens again in the meantime is not said to be unanswered later
    more.click()
    await page.sent.at(-1)!.accept()
    await page.set({ status: 'open' })
    await page.advance(SLOW)
    expect([finish.disabled, more.disabled, page.hand()]).toEqual([false, false, ['Your agent', '']])
    page.close()
  })

  test('the ending says the tour is over and offers the phone once, in words, by the names the site has for it', () => {
    const { html } = tourPage('done')
    expect(html).toContain('<h1 id="h">That is the tour.</h1>')
    expect(html).toContain('<b>Your phone can hold this too.</b><span>On this computer, open It, choose <em>Displays</em>, then <em>Add a display</em>.</span>')
    // Nowhere else in the tour is the person's phone offered
    for (const name of NAMES.filter((n) => n !== 'done')) expect(tourPage(name).html, name).not.toMatch(/your phone/i)
  })
})

describe('the first page', () => {
  type Page = Awaited<ReturnType<typeof opened>>
  const touch = (page: Page, x: number, y: number) =>
    page.w.document.body.dispatchEvent(
      new page.w.PointerEvent('pointerdown', { clientX: x * page.w.innerWidth, clientY: y * page.w.innerHeight, bubbles: true }),
    )
  const phase = (page: Page) => page.w.document.body.dataset.phase
  const POINTS = [
    [0.63, 0.68],
    [0.85, 0.37],
    [0.47, 0.46],
  ]
  const ANSWER = { marks: POINTS, mine: [0.7, 0.2], line: 'A triangle. I gave it a fourth corner, so now it is a kite.' }

  test('three touches go to the agent as one action, and nothing goes before the third', async () => {
    const page = await opened('menu')
    expect(phase(page)).toBe('touch')
    expect(page.$('#ask').textContent).toBe('This screen is ours now. Touch it, anywhere.')
    touch(page, 0.63, 0.68)
    touch(page, 0.85, 0.37)
    expect([page.sent.length, page.all('.mark').length, page.$('#ask').textContent]).toEqual([0, 2, 'Once more.'])
    touch(page, 0.47, 0.46)
    expect(page.sent.map((s) => [s.name, s.data])).toEqual([['touched', { points: POINTS }]])
    // A fourth touch is nothing, and neither is one made on the page's own switch
    touch(page, 0.2, 0.2)
    expect(page.sent.length).toBe(1)
    // The hand says nothing of the agent until It has taken the touches
    expect(page.hand()).toEqual(['Your agent', ''])
    await page.sent[0]!.accept()
    expect([page.$('#ask').textContent, page.hand()]).toEqual(['Sent. Watch the hand.', ['Your agent · has not answered yet', 'live']])
    // What the agent says it is doing is on the hand, in its own words
    await page.set({ doing: 'looking at your three points' })
    expect(page.hand()).toEqual(['Your agent · looking at your three points', 'live'])
    // Its answer is drawn: each place marked, its own added, the shape closed, and its sentence
    await page.set({ ...ANSWER, doing: '' })
    expect([phase(page), page.all('.mark.got').length, page.all('#w-ink line').length, page.$('#ask').textContent]).toEqual(['shape', 4, 4, ANSWER.line])
    expect(page.hand()[1]).toBe('')
    // The person is given a moment to read it, and then asked what the screen should be
    await page.advance(1500)
    expect([phase(page), page.$('#h').textContent, page.all('.thing').length]).toEqual(['choose', 'What should this screen be?', 5])
    page.close()
  })

  test('touches that It does not take are the person’s to make again', async () => {
    const page = await opened('menu')
    for (const [x, y] of POINTS) touch(page, x!, y!)
    await page.sent[0]!.refuse()
    expect([phase(page), page.all('.mark').length, page.$('#ask').textContent]).toEqual(['touch', 0, 'That did not send. Touch the screen again.'])
    for (const [x, y] of POINTS) touch(page, x!, y!)
    expect(page.sent.length).toBe(2)
    page.close()
  })

  test('the shape is drawn from the agent’s answer on a display that made no touches, and on one opened after it', async () => {
    // Another display, open on the same page while the touches were made elsewhere
    const beside = await opened('menu')
    await beside.set(ANSWER)
    expect([beside.sent.length, beside.all('.mark.got').length, beside.all('#w-ink line').length]).toEqual([0, 4, 4])
    expect([phase(beside), beside.all('.thing').length]).toEqual(['choose', 5])
    beside.close()
    // One opened afterwards, with the answer already in the page's state: it waits on no clock to reach its choices
    for (const calm of [true, false]) {
      const later = await opened('menu', undefined, { state: ANSWER, calm })
      expect([phase(later), later.all('.mark.got').length, later.all('#w-ink line').length, later.all('.thing').length]).toEqual(['choose', 4, 4, 5])
      later.close()
    }
  })

  test('shown again with something seen, it goes straight to its choices and says what was seen, with a control room first where the folder is known', async () => {
    for (const calm of [true, false]) {
      const page = await opened('menu', undefined, { state: { seen: ['chess'] }, params: { folder: 'shop', about: 'your 14 tests' }, calm })
      expect([phase(page), page.$('#h').textContent]).toEqual(['choose', 'What should this screen be?'])
      expect(page.all('.thing').map((t) => [t.dataset.choice, t.firstChild.textContent, t.lastChild.textContent])).toEqual([
        ['room', 'A control room for shop', 'your 14 tests'],
        ['whiteboard', 'A whiteboard', 'draw, and I draw back'],
        ['chess', 'A chessboard', 'you are white · seen'],
        ['drums', 'A drum machine', 'tap a beat, and I play between yours'],
        ['checklist', 'A checklist', 'tick and add, and I add what you forgot'],
        ['button', 'One big button', 'what an approval looks like'],
      ])
      // No touches are asked for, and none are taken
      touch(page, 0.5, 0.5)
      expect(page.all('.mark').length).toBe(0)
      page.$('.thing[data-choice="room"]').click()
      expect(page.sent.at(-1)).toMatchObject({ name: 'pick', data: { choice: 'room', from: 'menu' } })
      page.close()
    }
  })

  test('a conversation that cannot hear the screen yet is said to be so, in amber, with the one line to type, and the touches are kept', async () => {
    const page = await opened('menu', undefined, { params: { asleep: true } })
    expect(page.$('#ask').textContent).toBe('I cannot hear this screen yet. Type /reload-plugins in my chat, then touch it anywhere.')
    expect(page.hand()).toEqual(['Your agent · cannot hear this screen yet', 'amber'])
    for (const [x, y] of POINTS) touch(page, x!, y!)
    expect(page.all('.mark.kept').length).toBe(3)
    await page.sent[0]!.accept()
    expect(page.$('#ask').textContent).toBe('Kept. They reach Your agent the moment /reload-plugins is typed in its chat.')
    expect(page.hand()).toEqual(['Your agent · cannot hear yet, and It keeps them', 'amber'])
    // Once it hears, its answer is drawn as any is
    await page.set(ANSWER)
    expect([phase(page), page.all('.mark.got').length, page.hand()[1]]).toEqual(['shape', 4, ''])
    page.close()
  })
})

describe('the control room', () => {
  const BRANCH = {
    at: 1,
    label: 'branch',
    title: 'fix-cart',
    text: 'Three commits ahead of main.',
    lines: [['a41c9e2', 'Round the total once'], 'two files not committed'],
  }
  const TESTS = { at: 2, label: 'tests', title: '14 tests', dots: 'gg.b', button: 'Run them' }
  const tile = (page: Awaited<ReturnType<typeof opened>>, id: string) => page.$(`.tile[data-id="${id}"]`)

  test('a tile appears when the agent writes it, in the order the agent gives, with what the agent said of it and nothing else', async () => {
    const page = await opened('room', undefined, { params: { heading: 'shop' } })
    expect([page.$('#head').textContent, page.$('#room').dataset.n, page.$('#none').hidden]).toEqual(['shop', '0', false])
    expect(page.$('#none').textContent).toBe('What Your agent finds in this folder goes here.')
    await page.set({ tiles: { tests: TESTS } })
    await page.set({ tiles: { tests: TESTS, branch: BRANCH } })
    expect([page.$('#room').dataset.n, page.$('#none').hidden]).toEqual(['2', true])
    expect(page.all('.tile').map((t) => [t.dataset.id, t.classList.contains('in')])).toEqual([
      ['branch', true],
      ['tests', true],
    ])
    const branch = tile(page, 'branch')
    expect([branch.querySelector('.label').textContent, branch.querySelector('.title').textContent, branch.querySelector('.text').textContent]).toEqual([
      'branch',
      'fix-cart',
      'Three commits ahead of main.',
    ])
    expect([...branch.querySelectorAll('li')].map((li: any) => [li.querySelector('b')?.textContent ?? null, li.lastChild.textContent])).toEqual([
      ['a41c9e2', 'Round the total once'],
      [null, 'two files not committed'],
    ])
    // What a tile was not given is not shown
    expect([branch.querySelector('.dots').hidden, branch.querySelector('button').hidden, branch.dataset.busy, branch.dataset.ask]).toEqual([
      true,
      true,
      '0',
      '0',
    ])
    const tests = tile(page, 'tests')
    expect([...tests.querySelectorAll('.dots i')].map((d: any) => d.dataset.s)).toEqual(['g', 'g', 'u', 'b'])
    expect(tests.querySelector('.dots').getAttribute('aria-label')).toBe('2 good, 1 bad, 1 not yet known')
    expect([tests.querySelector('button').hidden, tests.querySelector('button').textContent, tests.querySelector('.text').hidden]).toEqual([
      false,
      'Run them',
      true,
    ])
    page.close()
  })

  test('a tile changes when the agent changes it, goes when the agent takes it away, and no more than four are shown', async () => {
    const page = await opened('room')
    await page.set({ tiles: { tests: TESTS } })
    await page.set({ tiles: { tests: { ...TESTS, busy: true, title: 'Running 14 tests', dots: 'gggg', button: null } } })
    const tests = tile(page, 'tests')
    expect([tests.dataset.busy, tests.querySelector('.title').textContent, tests.querySelector('button').hidden]).toEqual(['1', 'Running 14 tests', true])
    expect([...tests.querySelectorAll('.dots i')].map((d: any) => d.dataset.s)).toEqual(['g', 'g', 'g', 'g'])
    // The thing the agent will not do without the person's word is marked as that
    await page.set({ tiles: { push: { ask: true, label: 'push', title: 'Push fix-cart?', button: 'Push it' } } })
    expect([tile(page, 'tests'), tile(page, 'push').dataset.ask, tile(page, 'push').querySelector('.label').textContent]).toEqual([
      null,
      '1',
      'push · waits for your word',
    ])
    await page.set({ tiles: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id, at) => [id, { at, title: id }])) })
    expect(page.all('.tile').map((t) => t.dataset.id)).toEqual(['a', 'b', 'c', 'd'])
    // Words given to a tile stay words
    await page.set({ tiles: { a: { title: '<img src=x onerror=alert(1)>' } } })
    expect([tile(page, 'a').querySelector('.title').textContent, tile(page, 'a').querySelector('img')]).toEqual(['<img src=x onerror=alert(1)>', null])
    page.close()
  })

  test('a press on a tile’s button is one action that names the tile and the button, and the tile says it was pressed until the agent changes it', async () => {
    const page = await opened('room')
    await page.set({ tiles: { tests: TESTS, push: { ask: true, title: 'Push fix-cart?', button: 'Push it' } } })
    const button = tile(page, 'push').querySelector('button')
    button.click()
    expect(page.sent.map((s) => [s.name, s.data])).toEqual([['press', { tile: 'push', button: 'Push it' }]])
    // The hand says what the agent did last, and nothing of the press until It has taken it
    expect([button.getAttribute('data-picked'), page.$('#t-you b').textContent, page.hand()]).toEqual([
      '1',
      'pressed Push it',
      ['Your agent · set down 2 tiles', ''],
    ])
    await page.sent[0]!.accept()
    expect(page.hand()).toEqual(['Your agent · has not answered yet', 'live'])
    await page.set({ tiles: { tests: TESTS, push: { ask: true, title: 'Push fix-cart?', button: 'Push it', busy: true } }, doing: 'pushing fix-cart' })
    expect([button.getAttribute('data-picked'), tile(page, 'push').dataset.busy, page.hand()]).toEqual([null, '1', ['Your agent · pushing fix-cart', 'live']])
    await page.set({ tiles: { tests: TESTS, push: { title: 'fix-cart is on origin' } }, doing: '', note: 'Pushed.' })
    expect([tile(page, 'push').dataset.ask, page.$('#t-did b').textContent, page.hand()]).toEqual(['0', 'Pushed.', ['Your agent · changed a tile', '']])
    // A press that It does not take is the person's to make again
    const run = tile(page, 'tests').querySelector('button')
    run.click()
    await page.sent[1]!.refuse()
    expect([run.getAttribute('data-picked'), page.hand()]).toEqual([null, ['Your agent · did not get that', '']])
    page.close()
  })
})

describe('the agent’s hand', () => {
  test('says that the agent is at work only while something is unanswered or the agent has said what it is doing', async () => {
    // A page that has just been opened says nothing of the agent but its name, however long it stands
    for (const name of STEPS) {
      const page = await opened(name, (w) => {
        // The whiteboard draws on a board of its own, which the stand-in has not got
        w.ResizeObserver = class {
          observe() {}
        }
        w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true })
      })
      await page.advance(120_000)
      expect(page.hand(), name).toEqual(['Your agent', ''])
      // The agent's own word for what it is doing is said as it is, and is gone when the agent takes it back
      await page.set({ doing: 'reading the folder' })
      expect(page.hand(), name).toEqual(['Your agent · reading the folder', 'live'])
      await page.set({ doing: '' })
      expect(page.hand(), name).toEqual(['Your agent', ''])
      page.close()
    }
    // Something done is unanswered from when It took it, and not from when it was done
    const page = await opened('button')
    page.$('#big').click()
    expect(page.hand()).toEqual(['Your agent', ''])
    await page.sent[0]!.accept()
    expect(page.hand()).toEqual(['Your agent · has not answered yet', 'live'])
    await page.advance(600_000)
    expect(page.hand()).toEqual(['Your agent · has not answered yet', 'live'])
    await page.set({ status: 'done', note: 'shipped the homepage' })
    expect([page.hand(), page.$('#t-did b').textContent, page.$('#big').textContent]).toEqual([['Your agent · did it', ''], 'shipped the homepage', 'Done'])
    page.close()
    // A page of the tour sets no clock of its own that says the agent is doing something
    for (const name of NAMES) expect(tourPage(name).html, name).not.toMatch(/thinking|getting it ready|Wrapping up|Coming up|One moment/)
  })
})

// How a page is laid out is only known in a browser, so this is run in one, where one is installed
describe.skipIf('Bun' in globalThis || !existsSync(chromium.executablePath()))('the first page on a phone', () => {
  test.each([320, 390])('keeps the exit control as it is and nothing off the side of a %i pixel page while the hand’s words change', async (width) => {
    const browser = await chromium.launch({ timeout: 0 })
    try {
      const tab = await browser.newPage({ viewport: { width, height: 844 } })
      // It takes whatever the page sends, and never answers. The page is one the person has come back to, with its choices up
      await tab.clock.install()
      await tab.setContent(
        tourPage('menu', { folder: 'a-folder-with-a-long-name', about: 'your 14 tests, your branch, your 9 TODOs' }, 'Claude Code').html.replace(
          '<head>',
          '<head><script>window.It = { state: { seen: ["chess"] }, revision: 1, onState: () => () => {}, action: () => Promise.resolve({ ok: true }) }</script>',
        ),
      )
      await tab.addStyleTag({ content: 'body { font-family: monospace; }' })
      await tab.clock.runFor(3000)
      const enough = () =>
        tab.locator('#enough').evaluate((el) => ({
          shows: el.clientHeight,
          holds: el.scrollHeight,
          tall: Math.round(el.getBoundingClientRect().height),
          wide: Math.round(el.getBoundingClientRect().width),
        }))
      const inside = () => tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth)
      // The hand's plate, whatever it says, is within the page from side to side
      const plate = () => tab.locator('#w-tag').evaluate((el) => [el.getBoundingClientRect().left >= 0, el.getBoundingClientRect().right <= innerWidth])
      const alone = await enough()
      expect(alone.holds).toBeLessThanOrEqual(alone.shows)
      expect([await inside(), await plate()]).toEqual([true, [true, true]])
      await tab.locator('.thing[data-choice="chess"]').click()
      await tab.clock.runFor(3000)
      expect(await tab.locator('#w-tag').textContent()).toMatch(/^Claude Code · has not answered yet · \d+ s$/)
      // The words are on the hand and take no room from the page: the control is as it was
      expect([await enough(), await inside(), await plate()]).toEqual([alone, true, [true, true]])
      // And the light before those words is as round as it was made
      const light = await tab.locator('#w-tag').evaluate((el) => getComputedStyle(el, '::before').width)
      expect(light).toBe('7px')
      await tab.clock.runFor(40_001)
      expect(await tab.locator('#w-tag').textContent()).toBe('Claude Code · has not answered. Pick again, or say it in its chat')
      expect([await enough(), await inside(), await plate()]).toEqual([alone, true, [true, true]])
    } finally {
      await browser.close()
    }
  })
})
