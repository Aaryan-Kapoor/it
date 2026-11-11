// The tour's first page, which holds the whole of a first run of It on one page: a room, a
// whiteboard, a packing list, a game of chess, a cube, a drum machine, an approval and an ending.
// It is run as it is published, in a stand-in for a browser: what it sends is kept until the test
// accepts or refuses it, the state is what the test sets as the agent would with `it patch`, and
// the clock is moved by the test. The chessboard and the drum machine are held here to what their
// own pages are held to in tour.test.ts.
import { readFileSync } from 'node:fs'
import { LIMITS } from '@it/protocol'
import { describe, expect, test } from 'vitest'
import { GUIDE, tourPage } from '../src/tour'

// The stand-in for a browser comes with no types of its own, so it is asked for by a name the type check does not follow
const { JSDOM } = (await import('jsdom' as string)) as any

const STEPS = ['room', 'board', 'checklist', 'chess', 'cube', 'drums', 'approval', 'end']
const SLOW = 40_000

/** Something the page sent, which the test accepts or refuses as It would. */
interface Sent {
  name: string
  data: any
  accept: () => Promise<void>
  refuse: () => Promise<void>
}
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
/** What `it patch` does to the state: objects are merged into what is there, and anything else takes its place. */
const merged = (into: unknown, patch: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = isObject(into) ? { ...into } : {}
  for (const [k, v] of Object.entries(patch)) out[k] = isObject(v) && isObject(out[k]) ? merged(out[k], v) : v
  return out
}

/**
 * The page in a stand-in browser. `before` is done to the window first, for what a part needs of
 * a browser that the stand-in has not got. The sheet and the room are laid out at the size of
 * their drawings, so that a point on them is a point in the drawing.
 */
async function opened(given: Record<string, unknown> = {}, before: (w: any) => void = () => {}) {
  const page = tourPage('start', given, 'Claude Code')
  const sent: Sent[] = []
  const listeners: (() => void)[] = []
  const errors: string[] = []
  const settled = () => new Promise<void>((done) => setImmediate(done))
  let now = 0
  let timers: { id: number; at: number; fn: () => void }[] = []
  let next = 0
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
      w.setTimeout = (fn: () => void, ms = 0) => {
        timers.push({ id: ++next, at: now + ms, fn })
        return next
      }
      w.clearTimeout = (id: number) => {
        timers = timers.filter((t) => t.id !== id)
      }
      w.setInterval = () => 0
      w.clearInterval = () => {}
      // The seconds the page counts are the test's
      w.Date.now = () => now
      w.Element.prototype.getBoundingClientRect = function (this: any) {
        return this.id === 'pen' ? { left: 0, top: 0, width: 720, height: 420 } : { left: 0, top: 0, width: 720, height: 520 }
      }
      w.Element.prototype.setPointerCapture = () => {}
      w.addEventListener('error', (e: any) => errors.push(String(e.message)))
      before(w)
    },
  })
  const w = dom.window
  if (w.document.readyState !== 'complete') await new Promise((done) => w.addEventListener('load', done))
  const $ = (selector: string) => w.document.querySelector(selector)
  const section = (step: string) => $(`[data-step="${step}"]`)
  return {
    w,
    sent,
    errors,
    $,
    section,
    /** The part of the page that is shown. */
    shown: () => STEPS.find((step) => !section(step).hidden),
    /** Goes on with Next until the part is shown. */
    to(step: string) {
      while (this.shown() !== step) $('section.stage:not([hidden]) [data-go="next"]').click()
    },
    /** What the page says of the agent in a part, and what the agent said there. */
    state: (step: string) => section(step).querySelector('.agent .state').textContent as string,
    /** What the agent said in a part. What the page says there of its own, before the agent has said anything, is not that. */
    said: (step: string) => {
      const line = section(step).querySelector('.agent .line')
      return line.classList.contains('hint') ? '' : (line.textContent as string)
    },
    you: (step: string) => section(step).querySelector('.agent .you').textContent as string,
    sentOf: (name: string) => sent.filter((s) => s.name === name),
    /** The agent sets something in the page's state, as `it patch` does. */
    async set(patch: Record<string, unknown>) {
      It.state = merged(It.state, patch)
      It.revision++
      for (const fn of listeners) fn()
      await settled()
    },
    /** Moves the clock on, running whatever comes due, and what that sets in turn. */
    async advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        timers = timers.filter((t) => t !== due)
        due.fn()
      }
      now = until
      await settled()
    },
    settled,
    close: () => w.close(),
  }
}
type Page = Awaited<ReturnType<typeof opened>>
const pointer = (page: Page, el: any, kind: string, x: number, y: number) =>
  el.dispatchEvent(new page.w.PointerEvent(kind, { clientX: x, clientY: y, pointerId: 1, bubbles: true }))

describe('the tour’s first page', () => {
  test('is eight parts with a count of them, and Next, Back and Skip go between them by themselves and send nothing', async () => {
    const page = await opened()
    expect(page.shown()).toBe('room')
    expect(page.$('#steps').textContent).toBe('1 of 8')
    for (let i = 1; i < STEPS.length; i++) {
      page.$('section.stage:not([hidden]) [data-go="next"]').click()
      expect([page.shown(), page.$('#steps').textContent]).toEqual([STEPS[i], `${i + 1} of 8`])
    }
    page.section('approval').querySelector('[data-go="back"]').click()
    expect(page.shown()).toBe('approval')
    page.$('#again').click()
    expect(page.shown()).toBe('room')
    // A person may stop at any point and still reach the ending
    page.to('cube')
    page.$('#skip').click()
    expect([page.shown(), page.$('#skip').hidden]).toEqual(['end', true])
    // However long it is left, nothing goes to the agent that the person did not do
    await page.advance(5 * 60_000)
    expect(page.sent).toEqual([])
    expect(page.errors).toEqual([])
    page.close()
  })

  test('names the agent app that gives it, and says only that the agent is watching until something is done', async () => {
    const page = await opened()
    for (const step of STEPS.slice(0, 7)) {
      expect(page.section(step).querySelector('.who').textContent).toBe('Claude Code')
      expect(page.state(step)).toBe('is watching the page')
    }
    page.close()
  })

  test('where the conversation that put it up cannot hear it yet, says so in amber with the line to type, until the first answer', async () => {
    const quiet = await opened()
    expect(quiet.$('#asleep').hidden).toBe(true)
    quiet.close()
    const page = await opened({ asleep: true })
    expect(page.$('#asleep').hidden).toBe(false)
    expect(page.$('#asleep').textContent).toContain('/reload-plugins')
    expect(page.$('#asleep').textContent).toContain('What you do here is kept')
    // What the person does is sent all the same, for It to keep
    page.$('#yes').click()
    const asked = page.sentOf('answered')[0]!
    await asked.accept()
    expect(page.$('#asleep').hidden).toBe(false)
    await page.set({ approval: { request: asked.data.request, say: 'Merged, in the demo.' } })
    expect(page.$('#asleep').hidden).toBe(true)
    page.close()
  })
})

describe('the room', () => {
  /** The armchair taken by its middle and put down with its corner at the place given, in the drawing's units. */
  const dragged = (page: Page, to: [number, number]) => {
    const chair = page.$('#chair')
    const at = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(chair.style.transform)!.slice(1).map(Number)
    pointer(page, chair, 'pointerdown', at[0]! + 39, at[1]! + 39)
    pointer(page, chair, 'pointermove', to[0] + 39, to[1] + 39)
    pointer(page, chair, 'pointerup', to[0] + 39, to[1] + 39)
    return page.sentOf('moved').at(-1)!
  }
  const corner = (page: Page) => /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(page.$('#chair').style.transform)!.slice(1).map(Number)
  const lit = (page: Page, id: string) => page.$(`#${id}`).classList.contains('on')

  test('a move goes to the agent in centimetres, with what is in the way, the free places nearest and the door, and the answer is drawn from the state', async () => {
    const page = await opened()
    const move = dragged(page, [430, 230])
    expect(move.data).toMatchObject({
      armchair: [390, 190],
      size: 78,
      room: [640, 440],
      in_the_way: 'coffee table',
      door_clears_by: expect.any(Number),
      from_sofa: expect.any(Number),
      by_window: false,
    })
    expect(move.data.request).toMatch(/^[0-9a-f]{32}$/)
    expect(move.data.free).toHaveLength(3)
    // The armchair is the person's again only once the agent has answered
    expect(page.$('#chair').classList.contains('still')).toBe(true)
    expect(page.state('room')).toBe('sending what you did')
    await move.accept()
    expect(page.state('room')).toBe('has what you did and has not answered yet · 1 s')
    await page.set({ room: { request: move.data.request, armchair: move.data.free[1], lamp: true, say: 'Moved it off the table, by the rug.' } })
    expect(corner(page)).toEqual([move.data.free[1][0] + 40, move.data.free[1][1] + 40])
    expect([lit(page, 'lamp'), lit(page, 'dim'), lit(page, 'ghost')]).toEqual([true, true, true])
    expect(page.said('room')).toBe('Moved it off the table, by the rug.')
    expect(page.state('room')).toMatch(/^answered in \d+\.\d s$/)
    expect(page.$('#chair').classList.contains('still')).toBe(false)
    page.close()
  })

  test('a place where the armchair cannot stand is not used: the nearest free one is, and the sentence is still shown', async () => {
    for (const armchair of [[0, 0], [530, 130], 'by the window', [Number.NaN, 2]]) {
      const page = await opened()
      const move = dragged(page, [430, 230])
      await move.accept()
      await page.set({ room: { request: move.data.request, armchair, lamp: false, say: 'There.' } })
      expect(corner(page), String(armchair)).toEqual([move.data.free[0][0] + 40, move.data.free[0][1] + 40])
      expect([page.said('room'), lit(page, 'lamp')]).toEqual(['There.', false])
      page.close()
    }
  })

  test('an answer is held to the move it names: one to an earlier move is left alone, and one heard before It took the move is drawn once it has', async () => {
    const page = await opened()
    const first = dragged(page, [430, 230])
    await first.accept()
    // Nothing came for a while: the armchair is the person's again, and they move it on
    await page.advance(SLOW)
    expect(page.state('room')).toContain('has not answered after 40 s')
    expect(page.$('#chair').classList.contains('still')).toBe(false)
    const second = dragged(page, [300, 120])
    await page.set({ room: { request: first.data.request, armchair: first.data.free[0], lamp: true, say: 'Late.' } })
    expect([corner(page), page.said('room'), lit(page, 'lamp')]).toEqual([[300, 120], '', false])
    // The answer to this move comes before the page hears that It took it
    await page.set({ room: { request: second.data.request, armchair: second.data.free[0], lamp: true, say: 'By the window.' } })
    expect(page.said('room')).toBe('')
    await second.accept()
    expect([page.said('room'), lit(page, 'lamp')]).toEqual(['By the window.', true])
    // And it is drawn once only
    await page.set({ room: { request: second.data.request, armchair: [500, 300], say: 'Again.' } })
    expect(page.said('room')).toBe('By the window.')
    page.close()
  })

  test('a move It refused is the person’s to make again at once, and an answer to it is never drawn', async () => {
    const page = await opened()
    const move = dragged(page, [200, 200])
    await move.refuse()
    expect(page.state('room')).toBe('did not get that. Do it again')
    expect(page.$('#chair').classList.contains('still')).toBe(false)
    await page.set({ room: { request: move.data.request, armchair: [10, 10], say: 'No.' } })
    expect(page.said('room')).toBe('')
    expect(dragged(page, [210, 200]).data.request).not.toBe(move.data.request)
    page.close()
  })

  test('leaving the room in the middle of a wait throws nothing, and the answer is there to come back to', async () => {
    const page = await opened()
    const move = dragged(page, [430, 230])
    await move.accept()
    page.to('chess')
    await page.set({ room: { request: move.data.request, armchair: move.data.free[0], lamp: true, say: 'Done while you were away.' } })
    await page.advance(SLOW * 2)
    expect(page.errors).toEqual([])
    page.$('#again').click()
    expect(page.said('room')).toBe('Done while you were away.')
    page.close()
  })
})

describe('the whiteboard', () => {
  const PICTURE = 'a picture'
  /** A browser whose canvas makes the picture given, or none. */
  const canvas = (picture: string | null) => (w: any) => {
    const ink = new Proxy({}, { get: () => () => {}, set: () => true })
    w.HTMLCanvasElement.prototype.getContext = () => ink
    w.HTMLCanvasElement.prototype.toBlob = (made: (b: Blob | null) => void) => made(picture ? new w.Blob([picture], { type: 'image/png' }) : null)
  }
  /** One line written with the pen through the points given, in the drawing's units. */
  const written = (page: Page, points: [number, number][]) => {
    const pen = page.$('#pen')
    points.forEach(([x, y], i) => {
      pointer(page, pen, i ? 'pointermove' : 'pointerdown', x, y)
    })
    pointer(page, pen, 'pointerup', 0, 0)
  }
  /** What was sent last, once the picture of the sheet has been made, which takes a moment. */
  const checked = async (page: Page) => {
    page.$('#check').click()
    for (let i = 0; i < 5; i++) await page.settled()
    return page.sentOf('checked').at(-1)!
  }
  const on = (page: Page, id: string) => page.$(`#${id}`).classList.contains('on')

  test('Check it is there to press once something is written, and sends the question with a picture of the sheet as a file beside the lines', async () => {
    const page = await opened({}, canvas(PICTURE))
    page.to('board')
    expect(page.$('#check').disabled).toBe(true)
    written(page, [
      [330, 220],
      [345, 210],
      [345, 290],
    ])
    written(page, [
      [380, 220],
      [410, 290],
    ])
    expect(page.$('#check').disabled).toBe(false)
    const sent = await checked(page)
    expect(sent.data).toMatchObject({ question: 'A square garden has sides of 12 m. What is its area?', sum: '12 × 12 =' })
    expect(sent.data.png).toBeInstanceOf(page.w.Blob)
    expect(sent.data.png.type).toBe('image/png')
    expect(sent.data.strokes.map((s: any) => s.points.length)).toEqual([3, 2])
    expect(sent.data.strokes[0].points[0]).toEqual([Math.round((330 / 720) * 1000) / 1000, Math.round((220 / 420) * 1000) / 1000])
    // Nothing more is written on the sheet while the agent marks it
    expect([page.$('#check').disabled, page.$('#wipe').disabled]).toEqual([true, true])
    page.close()
  })

  test('where the browser can make no picture, the lines go by themselves, and where there are too many for an action the person is told what to do', async () => {
    const page = await opened({}, canvas(null))
    page.to('board')
    written(page, [
      [330, 220],
      [345, 290],
    ])
    const sent = await checked(page)
    expect(sent.data.png).toBeNull()
    expect(sent.data.strokes).toHaveLength(1)
    await sent.refuse()
    page.$('#wipe').click()
    for (let i = 0; i < 600; i++) written(page, [[300 + (i % 200), 200 + (i % 100)]])
    page.$('#check').click()
    for (let i = 0; i < 5; i++) await page.settled()
    expect(page.sentOf('checked')).toHaveLength(1)
    expect(page.you('board')).toBe('That is too many lines to send at once. Clear the sheet, and write it again.')
    expect(page.$('#check').disabled).toBe(false)
    page.close()
  })

  test('the agent’s marking is drawn from the state: a ring, its answer and a hint where the person is wrong, a tick where they are right, and one for an earlier check is left alone', async () => {
    const page = await opened({}, canvas(PICTURE))
    page.to('board')
    written(page, [
      [330, 220],
      [345, 210],
      [345, 290],
    ])
    const wrong = await checked(page)
    await wrong.accept()
    await page.set({ board: { request: 'another', right: true, say: 'Not this one.' } })
    expect(on(page, 'tick')).toBe(false)
    await page.set({
      board: { request: wrong.data.request, read: '1', right: false, answer: '144', hint: 'try 12 × 10 + 12 × 2', say: 'Not quite. 12 × 12 is 144.' },
    })
    await page.advance(1300)
    expect([on(page, 'ring'), on(page, 'arrow'), on(page, 'right'), on(page, 'hint'), on(page, 'tick')]).toEqual([true, true, true, true, false])
    expect([page.$('#right').textContent, page.$('#hint').textContent]).toEqual(['144', 'try 12 × 10 + 12 × 2'])
    // The ring goes round what the person wrote
    expect(Number(page.$('#ring').getAttribute('cx'))).toBeCloseTo(337.5, 0)
    expect(page.said('board')).toBe('Not quite. 12 × 12 is 144.')
    // They write it again, and it is right
    page.$('#wipe').click()
    expect(on(page, 'ring')).toBe(false)
    written(page, [
      [330, 220],
      [345, 290],
    ])
    const right = await checked(page)
    await right.accept()
    await page.set({ board: { request: wrong.data.request, right: false, answer: '12', say: 'Stale.' } })
    expect(on(page, 'ring')).toBe(false)
    await page.set({ board: { request: right.data.request, read: '144', right: true, hint: 'that is it', say: 'Right: 144 square metres.' } })
    await page.advance(1300)
    expect([on(page, 'tick'), on(page, 'ring'), on(page, 'hint')]).toEqual([true, false, true])
    page.close()
  })

  test('fits a drawing into an action with the whiteboard page’s own code, which whiteboard.test.ts holds', () => {
    const board = readFileSync(new URL('./pages/whiteboard.html', import.meta.url), 'utf8')
    const fitting = board.slice(board.indexOf('    function snapshot('), board.indexOf('    sendBtn.addEventListener'))
    expect(fitting).toContain('function fitted(png)')
    expect(tourPage('start').html).toContain(fitting.trimEnd())
  })
})

describe('the packing list', () => {
  test('goes to the agent whole a moment after the person stops, and what the agent adds is put on it as its own', async () => {
    const page = await opened()
    page.to('checklist')
    const rows = () => [...page.section('checklist').querySelectorAll('.item')]
    rows()[0].click()
    rows()[2].click()
    await page.advance(1199)
    expect(page.sent).toEqual([])
    await page.advance(1)
    const list = page.sentOf('list')[0]!
    expect(list.data.items.map((i: any) => [i.text, i.done])).toEqual([
      ['Passport', true],
      ['Phone charger', false],
      ['Toothbrush', true],
      ['Rain jacket', false],
      ['Book for the train', false],
    ])
    expect(page.you('checklist')).toBe('ticked 2 things')
    await list.accept()
    expect(page.state('checklist')).toContain('has what you did and has not answered yet')
    await page.set({ checklist: { added: [{ text: 'Umbrella', why: 'rain on Saturday' }] } })
    expect(rows().map((r) => r.textContent)).toContain('UmbrellaClaude Coderain on Saturday')
    expect(page.said('checklist')).toBe('added Umbrella, for rain on Saturday')
    expect(page.state('checklist')).toMatch(/^answered in/)
    // An answer elsewhere on the page is nothing new here
    await page.set({ room: { request: 'x', say: 'Elsewhere.' } })
    expect(page.said('checklist')).toBe('added Umbrella, for rain on Saturday')
    page.close()
  })
})

describe('the chessboard on the first page', () => {
  /** The board with the person's move made on it: one square tapped, then the other. */
  const moved = (page: Page, from: string, to: string) => {
    page.$(`[data-sq="${from}"]`).click()
    page.$(`[data-sq="${to}"]`).click()
    return page.sent.at(-1)!
  }
  const piece = (page: Page, at: string) => page.$(`[data-sq="${at}"] .pc`)?.textContent ?? ''
  const waits = (page: Page) => page.$('#chess-card').getAttribute('data-wait') === '1'
  const chess = async () => {
    const page = await opened()
    page.to('chess')
    return page
  }
  const reply = (page: Page, reply: string, note?: string) => page.set({ chess: { reply, ...(note === undefined ? {} : { note }) } })

  test('plays the agent’s answer when it is heard after the move is known to have gone, and when it is heard before', async () => {
    const after = await chess()
    const first = moved(after, 'e2', 'e4')
    expect(first).toMatchObject({ name: 'move', data: { move: 'e2e4' } })
    await first.accept()
    await reply(after, `${first.data.request}:e7e5`)
    expect([piece(after, 'e7'), piece(after, 'e5') !== '', waits(after)]).toEqual(['', true, false])
    expect(after.said('chess')).toBe('moved its pawn to e5')
    after.close()
    const before = await chess()
    const move = moved(before, 'e2', 'e4')
    await reply(before, `${move.data.request}:e7e5`)
    expect([piece(before, 'e5'), waits(before)]).toEqual(['', true])
    await move.accept()
    expect([piece(before, 'e7'), piece(before, 'e5') !== '', waits(before)]).toEqual(['', true, false])
    expect(moved(before, 'g1', 'f3')).toMatchObject({ name: 'move', data: { move: 'g1f3' } })
    before.close()
  })

  test('an answer that was heard early is not played in a new game, nor after a move that did not go', async () => {
    const page = await chess()
    const first = moved(page, 'e2', 'e4')
    await reply(page, `${first.data.request}:e7e5`)
    page.$('#new-game').click()
    const again = moved(page, 'd2', 'd4')
    await again.accept()
    expect([piece(page, 'e7') !== '', piece(page, 'e5'), waits(page)]).toEqual([true, '', true])
    page.close()
    const other = await chess()
    const lost = moved(other, 'e2', 'e4')
    await reply(other, `${lost.data.request}:e7e5`)
    await lost.refuse()
    expect([piece(other, 'e2') !== '', waits(other)]).toEqual([true, false])
    expect(other.state('chess')).toBe('did not get that. Do it again')
    await moved(other, 'd2', 'd4').accept()
    expect([piece(other, 'e7') !== '', piece(other, 'e5'), waits(other)]).toEqual([true, '', true])
    other.close()
  })

  test('a reply names the pending move, so an old answer cannot play after a reset or another turn', async () => {
    const page = await chess()
    const old = moved(page, 'e2', 'e4')
    await old.accept()
    page.$('#new-game').click()
    const reset = page.sent.at(-1)!
    expect(reset.name).toBe('reset')
    const current = moved(page, 'd2', 'd4')
    await current.accept()
    await reset.accept()
    expect(waits(page)).toBe(true)
    expect(current.data.request).not.toBe(old.data.request)
    for (const r of ['e7e5', `${old.data.request}:e7e5`]) {
      await reply(page, r)
      expect([piece(page, 'e7') !== '', piece(page, 'e5'), waits(page)]).toEqual([true, '', true])
    }
    await reply(page, `${current.data.request}:e7e5`)
    expect([piece(page, 'e7'), piece(page, 'e5') !== '', waits(page)]).toEqual(['', true, false])
    const next = moved(page, 'g1', 'f3')
    await next.accept()
    await reply(page, `${current.data.request}:g8f6`, 'A late note.')
    expect([piece(page, 'g8') !== '', piece(page, 'f6'), waits(page)]).toEqual([true, '', true])
    await reply(page, `${next.data.request}:g8f6`)
    expect([piece(page, 'g8'), piece(page, 'f6') !== '', waits(page)]).toEqual(['', true, false])
    page.close()
  })

  test('an early illegal answer requests a correction for the same move only once', async () => {
    const page = await chess()
    const move = moved(page, 'e2', 'e4')
    const r = `${move.data.request}:e7e9`
    await reply(page, r)
    await reply(page, r)
    await move.accept()
    expect(page.sentOf('illegal')).toMatchObject([{ data: { request: move.data.request, move: 'e7e9' } }])
    await reply(page, r, 'Try again.')
    expect(page.sentOf('illegal')).toHaveLength(1)
    await reply(page, `${move.data.request}:e7e5`)
    expect(waits(page)).toBe(false)
    page.close()
  })

  test('an illegal answer written twice before the move is accepted still asks the agent for a correction once, with the moves it may make', async () => {
    const page = await chess()
    const move = moved(page, 'e2', 'e4')
    await reply(page, `${move.data.request}:e7e4`)
    await reply(page, `${move.data.request}:e7e4`)
    expect(page.sent.map((s) => s.name)).toEqual(['move'])
    await move.accept()
    expect(page.sent.map((s) => s.name)).toEqual(['move', 'illegal'])
    expect(page.sent[1]!.data).toMatchObject({ request: move.data.request, move: 'e7e4', legal: expect.arrayContaining(['e7e5']) })
    await reply(page, `${move.data.request}:e7e4`)
    expect(page.sent.map((s) => s.name)).toEqual(['move', 'illegal'])
    await reply(page, `${move.data.request}:e7e5`)
    expect([piece(page, 'e7'), piece(page, 'e5') !== '', waits(page)]).toEqual(['', true, false])
    page.close()
  })

  test('a different early answer replaces the illegal one before the move is accepted', async () => {
    const page = await chess()
    const move = moved(page, 'e2', 'e4')
    await reply(page, `${move.data.request}:e7e4`)
    await reply(page, `${move.data.request}:e7e5`)
    await move.accept()
    expect(page.sent.map((s) => s.name)).toEqual(['move'])
    expect([piece(page, 'e5') !== '', waits(page)]).toEqual([true, false])
    page.close()
  })

  test('what was set for chess when the page opened is of an earlier game, and the agent’s note is said', async () => {
    const page = await chess()
    const move = moved(page, 'e2', 'e4')
    await move.accept()
    await reply(page, `${move.data.request}:e7e5`, 'The open game.')
    expect(page.said('chess')).toBe('The open game.')
    page.close()
  })
})

describe('the cube', () => {
  const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB'
  const cube = async () => {
    const page = await opened()
    page.to('cube')
    return page
  }

  test('turns as a cube turns', async () => {
    const page = await cube()
    const { turn } = page.w.__cube
    const after = (moves: string[]) => moves.reduce((f: string, m: string) => turn(f, m), SOLVED)
    expect(after(['R'])).toBe('UUFUUFUUFRRRRRRRRRFFDFFDFFDDDBDDBDDBLLLLLLLLLUBBUBBUBB')
    expect(after(['U'])).toBe('UUUUUUUUUBBBRRRRRRRRRFFFFFFDDDDDDDDDFFFLLLLLLLLLBBBBBB')
    for (const face of 'URFDLB') {
      expect(after([face, face, face, face]), face).toBe(SOLVED)
      expect(after([face, `${face}'`]), face).toBe(SOLVED)
      expect(after([`${face}2`]), face).toBe(after([face, face]))
    }
    // The six turns of R U R' U' are no turn at all
    expect(after(Array.from({ length: 6 }, () => ['R', 'U', "R'", "U'"]).flat())).toBe(SOLVED)
    expect(after(['F', 'B', 'L'])).not.toBe(SOLVED)
    page.close()
  })

  test('is turned with its buttons and its keys, and goes to the agent only when it is asked for, with its letters and its turns', async () => {
    const page = await cube()
    expect(page.$('#cube-ask').disabled).toBe(true)
    page.$('[aria-label="Turn R"]').click()
    page.$('#cube-front').dispatchEvent(new page.w.KeyboardEvent('keydown', { key: 'u', bubbles: true }))
    page.$('#cube-front').dispatchEvent(new page.w.KeyboardEvent('keydown', { key: 'F', shiftKey: true, bubbles: true }))
    expect(page.sent).toEqual([])
    expect(page.$('#cube-turns').textContent).toBe('3 turns since it was solved')
    page.$('#cube-ask').click()
    const turned = page.sentOf('turned')[0]!
    const { turn } = page.w.__cube
    expect(turned.data).toMatchObject({ faces: ['R', 'U', "F'"].reduce((f, m) => turn(f, m), SOLVED), turns: ['R', 'U', "F'"], solved: false })
    expect(turned.data.faces).toMatch(/^[URFDLB]{54}$/)
    // A turn and its undoing are no turn
    await turned.refuse()
    page.$('[aria-label="Turn F"]').click()
    expect(page.$('#cube-turns').textContent).toBe('2 turns since it was solved')
    page.close()
  })

  test('the agent’s turns are played one at a time, and only those that are turns’ names', async () => {
    const page = await cube()
    for (const m of ['R', 'U', 'F']) page.$(`[aria-label="Turn ${m}"]`).click()
    page.$('#cube-ask').click()
    const turned = page.sentOf('turned')[0]!
    await turned.accept()
    await page.set({ cube: { request: 'earlier', moves: ["F'"], say: 'Stale.' } })
    expect(page.$('#cube-turns').textContent).toBe('3 turns since it was solved')
    await page.set({ cube: { request: turned.data.request, moves: ["F'", 'X', "U'", 5, 'R2 R', "R'"], say: 'Undoing your three turns.' } })
    expect(page.said('cube')).toBe('Undoing your three turns.')
    await page.advance(0)
    expect(page.$('#cube-turns').textContent).toBe('solved')
    expect(page.$('#cube-said').textContent).toBe("Played 3 turns. 3 were not turns' names, and were left out. Solved.")
    page.close()
  })
})

describe('the drum machine on the first page', () => {
  /** One pad tapped: the drum, from the top, and the step. */
  const tapped = (page: Page, drum: number, step: number) => page.$(`.pad[data-r="${drum}"][data-c="${step}"]`).click()
  const told = (page: Page) => page.sent.map((s) => [s.name, s.data.pattern?.join('/')])
  const drums = async () => {
    const page = await opened({}, (w) => {
      w.requestAnimationFrame = () => 0
      w.cancelAnimationFrame = () => {}
    })
    page.to('drums')
    return page
  }
  const theirs = (page: Page, value: unknown, note?: string) => page.set({ drums: { theirs: value, ...(note === undefined ? {} : { note }) } })
  const playing = (page: Page) => page.$('#play').getAttribute('data-on')
  const noted = (page: Page) => page.said('drums')

  test('a beat of a single hit goes to the agent a moment after the person leaves it alone, as any beat does', async () => {
    const page = await drums()
    tapped(page, 3, 0)
    await page.advance(1400)
    expect(page.sent).toEqual([])
    await page.advance(100)
    expect(told(page)).toEqual([['beat', '......../......../......../x.......']])
    expect(page.you('drums')).toBe('put down 1 hit')
    page.close()
  })

  test('a beat the person takes hits off goes again as it is left, and the agent is told when the last hit is off', async () => {
    const page = await drums()
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
    expect(page.you('drums')).toBe('took the last hit off')
    await page.advance(5000)
    expect(page.sent.length).toBe(3)
    page.close()
    const idle = await drums()
    tapped(idle, 0, 1)
    tapped(idle, 0, 1)
    await idle.advance(5000)
    expect(idle.sent).toEqual([])
    idle.close()
  })

  test.each(['adding a hit', 'removing a hit', 'removing the last hit', 'undoing an edit'])(
    'a reply to the previous beat is ignored during the pause after %s',
    async (edit) => {
      const page = await drums()
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
        for (const value of [stale, stale.pattern]) {
          await theirs(page, value, 'Old beat')
          expect(page.$('.pad.theirs')).toBeNull()
          expect(playing(page)).toBe('0')
          expect(noted(page)).toBe('')
        }
        await page.advance(100)
        expect(page.sent).toHaveLength(2)
        if (edit === 'removing the last hit') {
          expect(page.sent[1]!.name).toBe('cleared')
          await theirs(page, stale)
          expect(page.$('.pad.theirs')).toBeNull()
          expect(playing(page)).toBe('0')
          return
        }
        const next = page.sent[1]!.data.request
        expect(next).not.toBe(first)
        expect(page.sent[1]!.name).toBe('beat')
        await theirs(page, { request: next, pattern: ['..x.....', '........', '........', '........'], note: 'New beat' })
        expect(page.$('.pad[data-r="0"][data-c="2"]').classList.contains('theirs')).toBe(true)
        expect(noted(page)).toBe('New beat')
        expect(playing(page)).toBe('1')
        await theirs(page, stale)
        expect(page.$('.pad[data-r="0"][data-c="0"]').classList.contains('theirs')).toBe(false)
        expect(page.$('.pad[data-r="0"][data-c="2"]').classList.contains('theirs')).toBe(true)
        expect(noted(page)).toBe('New beat')
      } finally {
        page.close()
      }
    },
  )

  test.each(['last hit', 'clear button'])('a late reply cannot restore the pads after clearing with %s', async (how) => {
    const page = await drums()
    tapped(page, 3, 0)
    await page.advance(1500)
    await page.sent[0]!.accept()
    if (how === 'last hit') {
      tapped(page, 3, 0)
      await page.advance(1500)
    } else page.$('#clear').click()
    await theirs(page, ['x.......', '........', '........', '........'], 'Late reply')
    expect(page.$('.pad.theirs')).toBeNull()
    expect(playing(page)).not.toBe('1')
    expect(noted(page)).toBe('')
    tapped(page, 2, 4)
    await page.advance(1500)
    await theirs(page, { request: page.sent.at(-1)!.data.request, pattern: ['..x.....', '........', '........', '........'], note: 'New reply' })
    expect(page.$('.pad[data-r="0"][data-c="2"]').classList.contains('theirs')).toBe(true)
    page.close()
  })

  test.each(['last hit', 'clear button'])('a reply for a beat cleared with %s stays ignored after the next beat was sent', async (how) => {
    const page = await drums()
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
    for (const value of [stale.pattern, stale]) {
      await theirs(page, value, 'Old beat')
      expect(page.$('.pad.theirs')).toBeNull()
      expect(playing(page)).toBe('0')
      expect(noted(page)).toBe('')
    }
    await theirs(page, { request: next, pattern: ['..x.....', '........', '........', '........'], note: 'New beat' })
    expect(page.$('.pad[data-r="0"][data-c="2"]').classList.contains('theirs')).toBe(true)
    expect(noted(page)).toBe('New beat')
    expect(playing(page)).toBe('1')
    await theirs(page, stale)
    expect(page.$('.pad[data-r="0"][data-c="0"]').classList.contains('theirs')).toBe(false)
    expect(page.$('.pad[data-r="0"][data-c="2"]').classList.contains('theirs')).toBe(true)
    expect(noted(page)).toBe('New beat')
    page.close()
  })

  test('taking off the last hit clears the agent pattern and stops playback before the agent answers', async () => {
    const page = await drums()
    tapped(page, 3, 0)
    await page.advance(1500)
    await page.sent[0]!.accept()
    await theirs(page, { request: page.sent.at(-1)!.data.request, pattern: ['x.......', '........', '........', '........'] })
    expect(playing(page)).toBe('1')
    tapped(page, 3, 0)
    await page.advance(1500)
    expect(playing(page)).toBe('0')
    expect(page.$('.pad[data-r="0"][data-c="0"]').classList.contains('theirs')).toBe(false)
    expect(noted(page)).toBe('')
    expect(page.sent.at(-1)?.name).toBe('cleared')
    await theirs(page, ['x.......', '........', '........', '........'], 'Still here')
    expect(playing(page)).toBe('0')
    page.close()
  })

  test('the beat stops when the person goes on to another part, and an answer heard there plays nothing until they come back and press Play', async () => {
    const page = await drums()
    tapped(page, 3, 0)
    await page.advance(1500)
    await page.sent[0]!.accept()
    page.section('drums').querySelector('[data-go="next"]').click()
    await theirs(page, { request: page.sent[0]!.data.request, pattern: ['x.......', '........', '........', '........'] })
    expect(playing(page)).toBe('0')
    expect(page.$('.pad[data-r="0"][data-c="0"]').classList.contains('theirs')).toBe(true)
    page.section('approval').querySelector('[data-go="back"]').click()
    page.$('#play').click()
    expect(playing(page)).toBe('1')
    page.section('drums').querySelector('[data-go="back"]').click()
    expect(playing(page)).toBe('0')
    page.close()
  })
})

describe('the approval', () => {
  test('the answer goes to the agent, and the pull requests of the demonstration are marked merged only once the agent has answered', async () => {
    const page = await opened()
    page.to('approval')
    page.$('#yes').click()
    const asked = page.sentOf('answered')[0]!
    expect(asked.data).toMatchObject({ answer: 'merge' })
    expect([page.$('#yes').disabled, page.$('#no').disabled]).toEqual([true, true])
    await asked.accept()
    expect(page.$('#prs .done')).toBeNull()
    await page.set({ approval: { request: asked.data.request, say: 'All three are merged, in the demo.' } })
    await page.advance(0)
    expect(page.section('approval').querySelectorAll('#prs .done')).toHaveLength(3)
    expect(page.said('approval')).toBe('All three are merged, in the demo.')
    page.close()
    const later = await opened()
    later.to('approval')
    later.$('#no').click()
    const not = later.sentOf('answered')[0]!
    expect(not.data).toMatchObject({ answer: 'not_yet' })
    await not.accept()
    await later.set({ approval: { request: not.data.request, say: 'I will ask again in the morning.' } })
    expect([later.$('#prs .done'), later.$('#yes').disabled]).toEqual([null, false])
    later.close()
  })

  test('where the agent has not answered a while after, the buttons are the person’s again, and what the page says is only what it knows', async () => {
    const page = await opened()
    page.to('approval')
    page.$('#no').click()
    await page.sentOf('answered')[0]!.accept()
    await page.advance(3000)
    expect(page.state('approval')).toBe('has what you did and has not answered yet · 3 s')
    await page.advance(SLOW - 3000)
    expect(page.state('approval')).toBe('has not answered after 40 s. It is yours again, and a late answer is still shown')
    expect(page.$('#no').disabled).toBe(false)
    page.close()
  })
})

describe('the ending', () => {
  test('“Go to my pages” asks the agent to finish, and is the person’s to press again where nothing comes of it', async () => {
    const page = await opened()
    page.$('#skip').click()
    page.$('#fin').click()
    const finish = page.sentOf('finish')[0]!
    expect(finish.data).toEqual({ from: 'start' })
    expect(page.$('#fin').disabled).toBe(true)
    await finish.accept()
    expect(page.$('#fin-status').textContent).toBe('Claude Code has it, and has not answered yet. It takes the tour away, and then you are at your pages.')
    await page.advance(SLOW)
    expect(page.$('#fin').disabled).toBe(false)
    page.$('#fin').click()
    await page.sentOf('finish')[1]!.refuse()
    expect([page.$('#fin').disabled, page.$('#fin-status').textContent]).toEqual([false, 'That did not go. Press it again.'])
    page.close()
  })
})

describe('the guide for the first page', () => {
  const part = GUIDE.slice(GUIDE.indexOf('\n## The first page'), GUIDE.indexOf('\n## If they ask to see more'))

  test('shows the first page before anything else, and before the pairing link where no screen is paired', () => {
    expect([...GUIDE.matchAll(/^it tour show ([a-z]+)/gm)][0]![1]).toBe('start')
    expect(part).toContain('give them the link that `it site --no-open` prints')
    expect(part).toContain('`"asleep": true`')
  })

  test('names every action the page sends, and the page sends each it names', () => {
    const page = tourPage('start').html
    for (const action of ['moved', 'checked', 'list', 'move', 'illegal', 'reset', 'turned', 'beat', 'cleared', 'answered', 'finish']) {
      expect(part, action).toContain(`\`${action}\``)
      expect(page, action).toContain(`"${action}"`)
    }
  })

  test('answers each with one patch, under a part the page reads and starts with, carrying the request where the page waits on one', () => {
    const page = tourPage('start')
    const patches = [...part.matchAll(/^it patch tour-start '([^']*)'$/gm)].map((m) => JSON.parse(m[1]!))
    expect(patches.flatMap((p) => Object.keys(p))).toEqual(['room', 'board', 'checklist', 'chess', 'cube', 'drums', 'approval'])
    for (const p of patches) {
      const [key, value] = Object.entries(p)[0]! as [string, any]
      expect(page.html, key).toMatch(new RegExp(`(part|Asker)\\("${key}"`))
      expect(Object.keys(JSON.parse(page.state)), key).toContain(key)
      if (['room', 'board', 'cube', 'approval'].includes(key)) expect(value.request, key).toBe('the exact request')
    }
    // What the page reads of each answer is what the guide gives
    for (const field of ['armchair', 'lamp', 'say', 'right', 'answer', 'hint', 'moves', 'added', 'reply', 'theirs', 'note'])
      expect(page.html, field).toMatch(new RegExp(`\\.${field}\\b`))
  })

  test('tells the agent that nothing in the tour touches the person’s things, and how to look at the picture and let it go', () => {
    expect(GUIDE).toContain("2. **Nothing in the tour touches the person's things.**")
    expect(part).toContain('you merge nothing and touch no repository')
    expect(part).toContain("it save <the action's id> sheet.png")
    expect(part).toContain('If you cannot read images')
    expect(part).not.toMatch(/it action [^\n]*--save/)
  })

  test('keeps every patch within what an action and a state may hold', () => {
    for (const m of part.matchAll(/^it patch tour-start '([^']*)'$/gm)) expect(new TextEncoder().encode(m[1]).length).toBeLessThan(LIMITS.stateBytes)
  })
})
