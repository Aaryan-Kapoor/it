// The whiteboard of the tour’s first page: what Check it sends, and how the agent’s marking is drawn.

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { tourPage } from '../../src/tour'
import { opened, type Page, pointer, SLOW } from '../start-page'

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

  test('Check it is there to press once something is written, and sends the question and its answer with a picture of the sheet as a file, under the name It saves it by for the agent', async () => {
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
    expect(sent.data).toMatchObject({ part: 'board', question: 'A square garden has sides of 12 m. What is its area?', sum: '12 × 12 =', answer: '144' })
    expect(sent.data.png).toBeInstanceOf(page.w.Blob)
    expect(sent.data.png.type).toBe('image/png')
    // The picture is what the agent reads, so the lines are left out, and the file's name is the request's own
    expect(sent.data.request).toMatch(/^[0-9a-f]{32}$/)
    expect(sent.data.saved).toBe(`.it-tour-${sent.data.request}.png`)
    expect(sent.data.strokes).toEqual([])
    expect(page.you('board')).toBe('wrote an answer')
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
    expect(sent.data.saved).toBeNull()
    expect(sent.data.strokes).toHaveLength(1)
    expect(sent.data.strokes[0].points[0]).toEqual([Math.round((330 / 720) * 1000) / 1000, Math.round((220 / 420) * 1000) / 1000])
    await sent.refuse()
    page.$('#wipe').click()
    for (let i = 0; i < 600; i++) written(page, [[300 + (i % 200), 200 + (i % 100)]])
    page.$('#check').click()
    for (let i = 0; i < 5; i++) await page.settled()
    expect(page.sentOf('checked')).toHaveLength(1)
    expect(page.read('board').hint).toBe('That is too many lines to send at once. Clear the sheet, and write it again.')
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

  test.each(['clears the sheet', 'writes more'])(
    'an answer that comes late, after the person has the sheet back and %s, is no answer to what is there, and is not drawn',
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
      expect(page.$('#wipe').disabled).toBe(false)
      if (does === 'clears the sheet') page.$('#wipe').click()
      else
        written(page, [
          [400, 220],
          [430, 290],
        ])
      expect(page.state('board')).toContain('Claude Code hears what you do here')
      await page.set({ board: { request: sent.data.request, read: '1', right: false, answer: '144', hint: 'try again', say: 'Late.' } })
      await page.advance(1300)
      expect([on(page, 'ring'), on(page, 'arrow'), on(page, 'right'), on(page, 'hint'), on(page, 'tick')]).toEqual([false, false, false, false, false])
      expect(page.said('board')).toBe('')
      expect(page.errors).toEqual([])
      page.close()
    },
  )

  test('marks that have not come onto the sheet yet do not come once the person clears it or writes on it', async () => {
    // Something moves here, so that the marks come one after another
    const page = await opened({}, (w) => {
      canvas(PICTURE)(w)
      w.matchMedia = () => ({ matches: false })
    })
    page.to('board')
    const answered = async () => {
      written(page, [
        [330, 220],
        [345, 290],
      ])
      const sent = await checked(page)
      await sent.accept()
      await page.set({ board: { request: sent.data.request, read: '1', right: false, answer: '144', hint: 'try again', say: 'Not quite.' } })
      expect(on(page, 'ring')).toBe(true)
    }
    await answered()
    await page.advance(100)
    page.$('#wipe').click()
    await page.advance(2000)
    expect([on(page, 'ring'), on(page, 'arrow'), on(page, 'right'), on(page, 'hint')]).toEqual([false, false, false, false])
    await answered()
    await page.advance(100)
    written(page, [
      [400, 220],
      [430, 290],
    ])
    await page.advance(2000)
    expect([on(page, 'ring'), on(page, 'arrow'), on(page, 'right'), on(page, 'hint')]).toEqual([false, false, false, false])
    // Left alone, they all come
    page.$('#wipe').click()
    await answered()
    await page.advance(2000)
    expect([on(page, 'ring'), on(page, 'arrow'), on(page, 'right'), on(page, 'hint')]).toEqual([true, true, true, true])
    expect(page.errors).toEqual([])
    page.close()
  })

  test('an answer that comes late to a sheet the person left as it was is still drawn', async () => {
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
    await page.advance(1300)
    expect([on(page, 'tick'), page.said('board')]).toEqual([true, 'Right.'])
    page.close()
  })

  test('fits a drawing into an action with the whiteboard page’s own code, which whiteboard.test.ts holds', () => {
    const board = readFileSync(new URL('../pages/whiteboard.html', import.meta.url), 'utf8')
    const fitting = board.slice(board.indexOf('    function snapshot('), board.indexOf('    sendBtn.addEventListener'))
    expect(fitting).toContain('function fitted(png)')
    expect(tourPage('start').html).toContain(fitting.trimEnd())
  })

  test('an agent that cannot look at pictures says so, and nothing is marked: no ring, no tick and no correction, only its sentence', async () => {
    const page = await opened({}, canvas(PICTURE))
    page.to('board')
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
    await page.advance(2000)
    expect(['ring', 'arrow', 'tick', 'right', 'hint'].map((id) => on(page, id))).toEqual([false, false, false, false, false])
    expect(page.said('board')).toBe('I cannot look at pictures, so I have not marked this.')
    expect(page.read('board').stage).toBe('answered')
    // And the sheet is the person's again
    expect([page.$('#check').disabled, page.$('#wipe').disabled]).toEqual([false, false])
    page.close()
  })
})
