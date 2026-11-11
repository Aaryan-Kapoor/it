// The room of the tour’s first page: what a move of the armchair tells the agent, and how its answer is drawn.
import { describe, expect, test } from 'vitest'
import { opened, type Page, pointer, SLOW } from '../start-page'

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
    expect(page.state('room')).toBe('Sending what you did to It')
    await move.accept()
    expect(page.state('room')).toBe('It has it. Waiting for Claude Code 1 s')
    await page.set({ room: { request: move.data.request, armchair: move.data.free[1], lamp: true, say: 'Moved it off the table, by the rug.' } })
    expect(corner(page)).toEqual([move.data.free[1][0] + 40, move.data.free[1][1] + 40])
    expect([lit(page, 'lamp'), lit(page, 'dim'), lit(page, 'ghost')]).toEqual([true, true, true])
    expect(page.said('room')).toBe('Moved it off the table, by the rug.')
    expect(page.state('room')).toMatch(/^Claude Code answered in \d+\.\d s$/)
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
    expect(page.state('room')).toContain('No answer after 40 s')
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
    expect(page.state('room')).toBe('It did not take that. Do it again.')
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
