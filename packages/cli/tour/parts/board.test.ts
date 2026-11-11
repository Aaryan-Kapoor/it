// The whiteboard of the tour’s first page: what the markers and the eraser write, what Check it sends, how the agent’s marking is drawn, and the typed answer an agent that cannot look at pictures is given.

import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { describe, expect, test } from 'vitest'
import { tourPage } from '../../src/tour'
import { opened, type Page, pointer, SLOW } from '../start-page'

describe('the whiteboard', () => {
  const PICTURE = 'a picture'
  /** The marks the agent's marker makes, by the name each has on the board. */
  const MARKS = ['ring', 'arrow', 'head', 'right', 'tick', 'star', 'hint']
  /**
   * A browser whose canvas makes the picture given, or none. Each canvas keeps the colours it
   * was drawn on with, so that a test can tell what went onto the picture from what went onto
   * the board.
   */
  const canvas = (picture: string | null) => (w: any) => {
    w.HTMLCanvasElement.prototype.getContext = function (this: any) {
      this.colours ??= []
      const colours: string[] = this.colours
      w.canvases ??= []
      if (!w.canvases.includes(this)) w.canvases.push(this)
      return new Proxy(
        {},
        {
          get: () => () => {},
          set: (_, key, value) => {
            if (key === 'strokeStyle' || key === 'fillStyle') colours.push(String(value))
            return true
          },
        },
      )
    }
    w.HTMLCanvasElement.prototype.toBlob = (made: (b: Blob | null) => void) => made(picture ? new w.Blob([picture], { type: 'image/png' }) : null)
  }
  /** One line written on the board through the points given, in pixels of the board as the stand-in lays it out. */
  const written = (page: Page, points: [number, number][]) => {
    const pen = page.$('#pen')
    points.forEach(([x, y], i) => {
      pointer(page, pen, i ? 'pointermove' : 'pointerdown', x, y)
    })
    pointer(page, pen, 'pointerup', 0, 0)
  }
  /** A point of the board, in pixels, as the board's own measure: from the place for the answer, in the units the board is drawn in. */
  const measured = (page: Page, [x, y]: [number, number]): [number, number] => {
    const [, , w, h] = page.$('#pen').getAttribute('viewBox').split(' ').map(Number)
    const [ox, oy] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(page.$('#board-at').getAttribute('transform'))!.slice(1).map(Number)
    return [(x * w) / 720 - ox!, (y * h) / 420 - oy!]
  }
  /** What was sent last, once the picture of the board has been made, which takes a moment. */
  const checked = async (page: Page) => {
    page.$('#board-check').click()
    for (let i = 0; i < 5; i++) await page.settled()
    return page.sentOf('checked').at(-1)!
  }
  const on = (page: Page, mark: string) => !!page.$(`#board-${mark}`)?.classList.contains('on')
  const drawn = (page: Page) => MARKS.filter((mark) => on(page, mark))
  const typed = (page: Page, text: string) => {
    page.$('#board-typed').value = text
    page.$('#board-typed').dispatchEvent(new page.w.Event('input', { bubbles: true }))
  }
  /** The page with something moving on it, so that the agent's marks come one after another. */
  const moving = (w: any) => {
    canvas(PICTURE)(w)
    w.matchMedia = () => ({ matches: false })
  }

  test('Check it is there to press once something is written, and sends the right answer and where the picture is first, with a picture of the board as a file under the name It saves it by for the agent', async () => {
    const page = await opened({}, canvas(PICTURE))
    page.to('board')
    expect(page.$('#board-check').disabled).toBe(true)
    expect(page.$('#board-slot').classList.contains('board-off')).toBe(false)
    written(page, [
      [330, 220],
      [345, 210],
      [345, 290],
    ])
    written(page, [
      [380, 220],
      [410, 290],
    ])
    expect(page.$('#board-check').disabled).toBe(false)
    // The words that say where to write go once something is written
    expect(page.$('#board-slot').classList.contains('board-off')).toBe(true)
    const sent = await checked(page)
    expect(Object.keys(sent.data).slice(0, 4)).toEqual(['part', 'request', 'answer', 'saved'])
    expect(sent.data).toMatchObject({
      part: 'board',
      answer: '144',
      question: 'A square garden has sides of 12 m. What is its area?',
      sum: '12 × 12 =',
      working: '12 × 10 + 12 × 2',
    })
    expect(sent.data.png).toBeInstanceOf(page.w.Blob)
    expect(sent.data.png.type).toBe('image/png')
    // The picture is what the agent reads, so the lines are left out, and the file's name is the request's own
    expect(sent.data.request).toMatch(/^[0-9a-f]{32}$/)
    expect(sent.data.saved).toBe(`.it-tour-${sent.data.request}.png`)
    expect(sent.data.strokes).toEqual([])
    expect('typed' in sent.data).toBe(false)
    // What an action carries is all shown to the agent as it arrives
    expect(JSON.stringify({ ...sent.data, png: { file: 1 } }).length).toBeLessThan(500)
    expect(page.you('board')).toBe('wrote an answer')
    // Nothing more is written on the board while the agent marks it
    expect([page.$('#board-check').disabled, page.$('#board-wipe').disabled]).toEqual([true, true])
    written(page, [
      [100, 100],
      [140, 140],
    ])
    page.close()
  })

  test('the picture is dark on white whichever marker was taken, and the board itself is written on in the marker’s colour', async () => {
    const page = await opened({}, canvas(PICTURE))
    page.to('board')
    const red = page.$('[data-tool="red"]')
    red.click()
    expect([red.getAttribute('aria-pressed'), page.$('[data-tool="blue"]').getAttribute('aria-pressed')]).toEqual(['true', 'false'])
    // Green is the agent's, and is not among the markers to take
    expect([...page.$('#board-tray').querySelectorAll('button')].map((b: any) => b.getAttribute('data-tool'))).toEqual([
      'black',
      'blue',
      'red',
      'purple',
      'eraser',
    ])
    written(page, [
      [330, 220],
      [345, 290],
    ])
    await checked(page)
    const board = page.$('#board-ink')
    expect(board.colours).toContain('#d2372c')
    const others = page.w.canvases.filter((c: any) => c !== board).flatMap((c: any) => c.colours)
    expect(others).toContain('#111111')
    expect(new Set(others)).toEqual(new Set(['#111111', '#ffffff']))
    page.close()
  })

  test('where the browser can make no picture, the lines go by themselves, each as parts of the picture there would have been, and where there are too many for an action the person is told what to do', async () => {
    const page = await opened({}, canvas(null))
    page.to('board')
    written(page, [
      [330, 220],
      [345, 290],
    ])
    // What the eraser wiped goes as a line too, wider than a marker's
    page.$('[data-tool="eraser"]').click()
    written(page, [
      [500, 100],
      [520, 110],
    ])
    const sent = await checked(page)
    expect(sent.data.png).toBeNull()
    expect(sent.data.saved).toBeNull()
    expect(sent.data.strokes).toHaveLength(2)
    expect(sent.data.strokes.map((s: any) => [s.erase, s.color, s.width])).toEqual([
      [false, '#2450c8', 7],
      [true, '', 46],
    ])
    for (const [x, y] of sent.data.strokes.flatMap((s: any) => s.points)) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
    }
    await sent.refuse()
    page.$('#board-wipe').click()
    page.$('[data-tool="black"]').click()
    for (let i = 0; i < 600; i++) written(page, [[300 + (i % 200), 200 + (i % 100)]])
    page.$('#board-check').click()
    for (let i = 0; i < 5; i++) await page.settled()
    expect(page.sentOf('checked')).toHaveLength(1)
    expect(page.read('board').hint).toBe('That is too many lines to send at once. Clear the board, and write it again.')
    expect(page.$('#board-check').disabled).toBe(false)
    page.close()
  })

  test('the agent’s marking is drawn from the state: a ring round what the person wrote, an arrow to its answer and a hint where they are wrong, a tick and a star where they are right, and one for an earlier check is left alone', async () => {
    const page = await opened({}, canvas(PICTURE))
    page.to('board')
    const line: [number, number][] = [
      [330, 220],
      [345, 210],
      [345, 290],
    ]
    written(page, line)
    const wrong = await checked(page)
    await wrong.accept()
    await page.set({ board: { request: 'another', right: true, say: 'Not this one.' } })
    expect(drawn(page)).toEqual([])
    await page.set({
      board: { request: wrong.data.request, read: '1', right: false, answer: '144', hint: 'try 12 × 10 + 12 × 2', say: 'Not quite. 12 × 12 is 144.' },
    })
    expect(drawn(page)).toEqual(['ring', 'arrow', 'head', 'right', 'hint'])
    expect([page.$('#board-right').textContent, page.$('#board-hint').textContent]).toEqual(['144', 'try 12 × 10 + 12 × 2'])
    // The ring goes round what the person wrote, and the answer is beside it and not on it
    const ring = [
      ...page
        .$('#board-ring')
        .getAttribute('d')
        .matchAll(/(-?[\d.]+) (-?[\d.]+)/g),
    ].map((m) => [Number(m[1]), Number(m[2])])
    const inside = (p: [number, number]) => {
      const xs = ring.map((q) => q[0]!)
      const ys = ring.map((q) => q[1]!)
      return p[0] > Math.min(...xs) && p[0] < Math.max(...xs) && p[1] > Math.min(...ys) && p[1] < Math.max(...ys)
    }
    for (const point of line) expect(inside(measured(page, point))).toBe(true)
    expect(inside([Number(page.$('#board-right').getAttribute('x')), Number(page.$('#board-right').getAttribute('y'))])).toBe(false)
    // What the agent read is said of the marks, for whoever asks what they are
    expect(page.$('#board-marks title').textContent).toBe('Claude Code read this as 1')
    expect(page.said('board')).toBe('Not quite. 12 × 12 is 144.')
    // They clear it and write it again, and it is right
    page.$('#board-wipe').click()
    expect(drawn(page)).toEqual([])
    written(page, [
      [330, 220],
      [345, 290],
    ])
    const right = await checked(page)
    await right.accept()
    await page.set({ board: { request: wrong.data.request, right: false, answer: '12', say: 'Stale.' } })
    expect(drawn(page)).toEqual([])
    await page.set({ board: { request: right.data.request, read: '144', right: true, hint: 'that is it', say: 'Right: 144 square metres.' } })
    expect(drawn(page)).toEqual(['tick', 'star', 'hint'])
    expect(page.errors).toEqual([])
    page.close()
  })

  test('a hint that the state still holds from the last marking is not written beside a tick the agent gave no hint with', async () => {
    const page = await opened({}, canvas(PICTURE))
    page.to('board')
    written(page, [
      [330, 220],
      [345, 290],
    ])
    const wrong = await checked(page)
    await wrong.accept()
    await page.set({ board: { request: wrong.data.request, read: '1', right: false, answer: '144', hint: '12 × 10 + 12 × 2', say: 'Not quite.' } })
    expect(drawn(page)).toEqual(['ring', 'arrow', 'head', 'right', 'hint'])
    const right = await checked(page)
    await right.accept()
    await page.set({ board: { request: right.data.request, read: '144', right: true, say: 'Right.' } })
    expect(page.w.It.state.board.hint).toBe('12 × 10 + 12 × 2')
    expect(drawn(page)).toEqual(['tick', 'star'])
    page.close()
  })

  test('what an answer says is put on the board as text and never as markup, and only so much of it', async () => {
    const page = await opened({}, canvas(PICTURE))
    page.to('board')
    written(page, [
      [330, 220],
      [345, 290],
    ])
    const sent = await checked(page)
    await sent.accept()
    await page.set({
      board: {
        request: sent.data.request,
        read: { not: 'words' },
        right: 'yes',
        answer: '<b>144</b> and more',
        hint: `<img src=x onerror=alert(1)> ${'long '.repeat(30)}`,
        say: 'Marked.',
      },
    })
    // Anything but `true` is not right, so it is ringed
    expect(drawn(page)).toEqual(['ring', 'arrow', 'head', 'right', 'hint'])
    expect(page.$('#board-right').textContent).toBe('<b>144</')
    expect(page.$('#board-marks').querySelector('b, img')).toBeNull()
    expect([...page.$('#board-marks').querySelectorAll('text')].map((t: any) => t.textContent).join(' ').length).toBeLessThanOrEqual(8 + 1 + 44)
    expect(page.$('#board-marks title')).toBeNull()
    expect(page.errors).toEqual([])
    page.close()
  })

  test.each(['clears the board', 'writes more', 'wipes some of it with the eraser'])(
    'an answer that comes late, after the person has the board back and %s, is no answer to what is there, and is not drawn',
    async (does) => {
      const page = await opened({}, canvas(PICTURE))
      page.to('board')
      written(page, [
        [330, 220],
        [345, 290],
      ])
      const sent = await checked(page)
      await sent.accept()
      await page.advance(SLOW)
      expect(page.$('#board-wipe').disabled).toBe(false)
      if (does === 'clears the board') page.$('#board-wipe').click()
      else {
        if (does !== 'writes more') page.$('[data-tool="eraser"]').click()
        written(page, [
          [400, 220],
          [430, 290],
        ])
      }
      expect(page.state('board')).toContain('Claude Code hears what you do here')
      await page.set({ board: { request: sent.data.request, read: '1', right: false, answer: '144', hint: 'try again', say: 'Late.' } })
      await page.advance(5000)
      expect(drawn(page)).toEqual([])
      expect(page.said('board')).toBe('')
      expect(page.errors).toEqual([])
      page.close()
    },
  )

  test('the marks come one after another, as the marker gets to each, and those that have not come yet do not come once the person clears the board or writes on it', async () => {
    const page = await opened({}, moving)
    page.to('board')
    const answered = async () => {
      written(page, [
        [330, 220],
        [345, 290],
      ])
      const sent = await checked(page)
      await sent.accept()
      await page.set({ board: { request: sent.data.request, read: '1', right: false, answer: '144', hint: 'try again', say: 'Not quite.' } })
      // The marker has first to come from the tray
      expect(drawn(page)).toEqual([])
      await page.advance(600)
      expect(drawn(page)).toEqual(['ring'])
    }
    await answered()
    page.$('#board-wipe').click()
    await page.advance(5000)
    expect(drawn(page)).toEqual([])
    await answered()
    written(page, [
      [400, 220],
      [430, 290],
    ])
    await page.advance(5000)
    expect(drawn(page)).toEqual([])
    // Left alone, they all come
    page.$('#board-wipe').click()
    await answered()
    await page.advance(5000)
    expect(drawn(page)).toEqual(['ring', 'arrow', 'head', 'right', 'hint'])
    expect(page.errors).toEqual([])
    page.close()
  })

  test('marks on their way when the person goes to another part are all there when they come back, and marks that come while they are away are drawn once they are back', async () => {
    const page = await opened({}, moving)
    page.to('board')
    written(page, [
      [330, 220],
      [345, 290],
    ])
    const first = await checked(page)
    await first.accept()
    await page.set({ board: { request: first.data.request, read: '1', right: false, answer: '144', hint: 'try again', say: 'Not quite.' } })
    await page.advance(600)
    page.$('#next').click()
    expect(drawn(page)).toEqual(['ring', 'arrow', 'head', 'right', 'hint'])
    page.$('#back').click()
    page.$('#board-wipe').click()
    written(page, [
      [330, 220],
      [345, 290],
    ])
    const second = await checked(page)
    await second.accept()
    page.$('#next').click()
    await page.set({ board: { request: second.data.request, read: '144', right: true, hint: 'that is it', say: 'Right.' } })
    await page.advance(5000)
    expect(drawn(page)).toEqual([])
    expect(page.said('board')).toBe('Right.')
    page.$('#back').click()
    await page.advance(5000)
    expect(drawn(page)).toEqual(['tick', 'star', 'hint'])
    expect(page.errors).toEqual([])
    page.close()
  })

  test('an answer that comes late to a board the person left as it was is still drawn', async () => {
    const page = await opened({}, canvas(PICTURE))
    page.to('board')
    written(page, [
      [330, 220],
      [345, 290],
    ])
    const sent = await checked(page)
    await sent.accept()
    await page.advance(SLOW)
    await page.set({ board: { request: sent.data.request, read: '144', right: true, hint: 'that is it', say: 'Right.' } })
    expect([on(page, 'tick'), page.said('board')]).toEqual([true, 'Right.'])
    page.close()
  })

  test('fits a drawing into an action with the whiteboard page’s own code, which whiteboard.test.ts holds', () => {
    const board = readFileSync(new URL('../pages/whiteboard.html', import.meta.url), 'utf8')
    const fitting = board.slice(board.indexOf('    function snapshot('), board.indexOf('    sendBtn.addEventListener'))
    expect(fitting).toContain('function fitted(png)')
    expect(tourPage('start').html).toContain(fitting.trimEnd())
  })

  test('an agent that cannot look at pictures says so, and nothing is marked: no ring, no tick and no correction, only its sentence, and the board offers a typed answer', async () => {
    const page = await opened({}, canvas(PICTURE))
    page.to('board')
    expect(page.$('#board-type').hidden).toBe(true)
    written(page, [
      [330, 220],
      [345, 290],
    ])
    const sent = await checked(page)
    await sent.accept()
    // Whatever else it sets beside the flag is not drawn
    await page.set({
      board: {
        request: sent.data.request,
        blind: true,
        right: true,
        answer: '144',
        hint: 'guessing',
        say: 'I cannot look at pictures, so I have not marked this.',
      },
    })
    await page.advance(5000)
    expect(drawn(page)).toEqual([])
    expect(page.$('#board-marks').childNodes).toHaveLength(0)
    expect(page.said('board')).toBe('I cannot look at pictures, so I have not marked this.')
    expect(page.read('board').stage).toBe('answered')
    // And the board is the person's again, with a place to type their answer under it
    expect([page.$('#board-check').disabled, page.$('#board-wipe').disabled]).toEqual([false, false])
    expect(page.$('#board-type').hidden).toBe(false)
    expect(page.$('#line').textContent).toBe('Type your answer under the board, and press Check it. Claude Code marks what you typed.')
    page.close()
  })

  test('a typed answer is written on the board in place of the handwriting, and goes as the same action with the text in it and no picture, which the agent marks as it would one it read', async () => {
    const page = await opened({}, canvas(PICTURE))
    page.to('board')
    written(page, [
      [330, 220],
      [345, 290],
    ])
    const unread = await checked(page)
    await unread.accept()
    await page.set({ board: { request: unread.data.request, blind: true, say: 'I cannot look at pictures.' } })
    typed(page, ' 144  ')
    expect(page.$('#board-said').textContent).toBe('144')
    expect(page.$('#board-said').getAttribute('fill')).toBe('#2450c8')
    const sent = await checked(page)
    expect(page.sentOf('checked')).toHaveLength(2)
    expect(Object.keys(sent.data).slice(0, 5)).toEqual(['part', 'request', 'answer', 'typed', 'saved'])
    expect(sent.data).toMatchObject({ part: 'board', answer: '144', typed: '144', saved: null, png: null, strokes: [], sum: '12 × 12 =' })
    expect(sent.data.request).not.toBe(unread.data.request)
    expect(page.you('board')).toBe('typed an answer')
    expect(page.$('#board-typed').disabled).toBe(true)
    await sent.accept()
    // The state goes on saying `blind` under an answer that does not say it again, as `it tour answer` merges it in
    await page.set({ board: { request: sent.data.request, read: '144', right: true, hint: 'that is it', say: 'Right: 144 square metres.' } })
    expect(page.w.It.state.board.blind).toBe(true)
    expect(page.errors).toEqual([])
    expect(drawn(page)).toEqual(['tick', 'star', 'hint'])
    // Nothing was read from a picture, so nothing is said to have been
    expect(page.$('#board-marks title')).toBeNull()
    expect(page.said('board')).toBe('Right: 144 square metres.')
    // Typing another answer takes the marks off, as writing does, and a hand on the board takes the place of what was typed
    typed(page, '124')
    expect(drawn(page)).toEqual([])
    written(page, [
      [330, 220],
      [345, 290],
    ])
    expect([page.$('#board-typed').value, page.$('#board-said').textContent]).toEqual(['', ''])
    const again = await checked(page)
    expect('typed' in again.data).toBe(false)
    expect(again.data.png).toBeInstanceOf(page.w.Blob)
    // And Clear empties what was typed with what was written
    await again.refuse()
    typed(page, '12')
    page.$('#board-wipe').click()
    expect([page.$('#board-typed').value, page.$('#board-said').textContent, page.$('#board-check').disabled]).toEqual(['', '', true])
    expect(page.errors).toEqual([])
    page.close()
  })

  test('an agent that cannot mark a typed answer either says so, and nothing is marked', async () => {
    const page = await opened({}, canvas(null))
    page.to('board')
    written(page, [
      [330, 220],
      [345, 290],
    ])
    const unread = await checked(page)
    await unread.accept()
    await page.set({ board: { request: unread.data.request, blind: true, say: 'There is no picture to look at.' } })
    typed(page, '144')
    const sent = await checked(page)
    await sent.accept()
    await page.set({ board: { request: sent.data.request, blind: true, say: 'Still nothing I can mark.' } })
    expect(drawn(page)).toEqual([])
    expect(page.said('board')).toBe('Still nothing I can mark.')
    expect(page.$('#board-said').textContent).toBe('144')
    page.close()
  })
})

// Where the marker's ink lands, what the picture looks like and whether the board fills the stage are only known in a browser, so this is run in one, where one is installed
describe.skipIf('Bun' in globalThis || !existsSync(chromium.executablePath()))('the whiteboard in a browser', () => {
  // It takes whatever the page sends, and the test answers as the agent would
  const IT = `window.sent = []; window.It = { state: {}, revision: 1, heard: [], onState(fn) { this.heard.push(fn); return () => {} },
    action(name, data) { window.sent.push(data); return Promise.resolve({ ok: true, id: 'a' + window.sent.length }) } };
    window.answer = (answer) => { It.state = { board: { ...answer, request: window.sent.at(-1).request } }; It.heard.forEach((fn) => fn()) }`
  test.each([
    [1366, 768],
    [390, 844],
  ])(
    'fills the stage of a %i by %i screen, writes where the marker is, sends a dark picture of a red answer, and has the green marker draw the marking',
    async (width, height) => {
      const browser = await chromium.launch({ timeout: 0 })
      try {
        const tab = await browser.newPage({ viewport: { width, height } })
        await tab.setContent(tourPage('start', {}, 'Claude Code').html.replace('<head>', () => `<head><script>${IT}</script>`))
        await tab.locator('#next').click()
        await tab.evaluate(() => document.fonts.ready)
        // Nothing scrolls, and the board has nearly all of the stage
        const room = await tab.evaluate(() => {
          const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect()
          const [stage, face] = [rect('stage'), rect('board-face')]
          return {
            scrolls: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
            part: (face.width * face.height) / (stage.width * stage.height),
          }
        })
        expect(room.scrolls).toBe(false)
        expect(room.part).toBeGreaterThan(0.72)
        const slot = (await tab.locator('#board-slot rect').boundingBox())!
        const [x, y] = [slot.x + slot.width * 0.3, slot.y + slot.height * 0.3]
        await tab.locator('[data-tool="red"]').click()
        await tab.mouse.move(x, y)
        await tab.mouse.down()
        await tab.mouse.move(x + slot.width * 0.3, y + slot.height * 0.4, { steps: 8 })
        await tab.mouse.up()
        /** The colour of the board's ink under a point of the screen. */
        const inkAt = (px: number, py: number) =>
          tab.evaluate(
            ([px, py]) => {
              const c = document.getElementById('board-ink') as HTMLCanvasElement
              const r = c.getBoundingClientRect()
              return [
                ...c.getContext('2d')!.getImageData(Math.round(((px! - r.left) * c.width) / r.width), Math.round(((py! - r.top) * c.height) / r.height), 1, 1)
                  .data,
              ]
            },
            [px, py],
          )
        expect(await inkAt(x, y)).toEqual([210, 55, 44, 255])
        expect((await inkAt(slot.x + 4, slot.y + slot.height - 4))[3]).toBe(0)
        await tab.locator('#board-check').click()
        await tab.waitForFunction(() => (window as any).sent.length === 1)
        // The picture holds the question and the answer in dark ink on white, and nothing of the marker's red
        const picture = await tab.evaluate(async () => {
          const data = (window as any).sent[0]
          const bitmap = await createImageBitmap(data.png)
          const c = document.createElement('canvas')
          c.width = bitmap.width
          c.height = bitmap.height
          const g = c.getContext('2d')!
          g.drawImage(bitmap, 0, 0)
          const d = g.getImageData(0, 0, c.width, c.height).data
          let dark = 0
          let coloured = 0
          for (let i = 0; i < d.length; i += 4) {
            if (d[i]! < 60 && d[i + 1]! < 60 && d[i + 2]! < 60) dark++
            if (Math.max(d[i]!, d[i + 1]!, d[i + 2]!) - Math.min(d[i]!, d[i + 1]!, d[i + 2]!) > 24) coloured++
          }
          return {
            saved: data.saved,
            strokes: data.strokes.length,
            wide: c.width,
            tall: c.height,
            corner: [...d.slice(0, 4)],
            dark: dark / (d.length / 4),
            coloured,
          }
        })
        expect(picture.saved).toMatch(/^\.it-tour-[0-9a-f]{32}\.png$/)
        expect(picture.strokes).toBe(0)
        // As large as a model reads a picture at, and no larger
        expect(Math.max(picture.wide, picture.tall)).toBeGreaterThan(900)
        expect(Math.max(picture.wide, picture.tall)).toBeLessThanOrEqual(1280)
        expect(picture.corner).toEqual([255, 255, 255, 255])
        expect(picture.dark).toBeGreaterThan(0.01)
        expect(picture.coloured).toBe(0)
        // The marking is drawn by the green marker, which is back in the tray when it is done
        await tab.evaluate(() => (window as any).answer({ read: '1', right: false, answer: '144', hint: '12 × 10 + 12 × 2', say: 'Not quite.' }))
        await tab.waitForFunction(() => !document.getElementById('board-hand')!.hidden)
        await tab.waitForFunction(
          () => document.getElementById('board-hint')?.classList.contains('on') && document.getElementById('board-hand')!.hidden,
          null,
          { timeout: 15_000 },
        )
        const marks = await tab.evaluate(() => {
          const face = document.getElementById('board-face')!.getBoundingClientRect()
          return ['ring', 'arrow', 'head', 'right', 'hint'].map((mark) => {
            const r = document.getElementById(`board-${mark}`)!.getBoundingClientRect()
            return r.width > 0 && r.left >= face.left && r.right <= face.right && r.top >= face.top && r.bottom <= face.bottom
          })
        })
        expect(marks).toEqual([true, true, true, true, true])
        // Wiped quite clean with the eraser, there is nothing to check
        await tab.locator('[data-tool="eraser"]').click()
        await tab.mouse.move(x - 30, y - 30)
        await tab.mouse.down()
        for (let i = 0; i < 12; i++) await tab.mouse.move(x + (i % 2 ? -30 : slot.width * 0.4), y - 20 + i * slot.height * 0.07, { steps: 6 })
        await tab.mouse.up()
        expect(await tab.locator('#board-check').isDisabled()).toBe(true)
        expect(await tab.locator('#board-marks').evaluate((el) => el.childNodes.length)).toBe(0)
      } finally {
        await browser.close()
      }
    },
  )
})
