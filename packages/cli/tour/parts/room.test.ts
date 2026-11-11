// The room of the tour’s first page: how it is laid out for the stage it has, what a move of the armchair tells the agent, and how its answer is drawn.
import { describe, expect, test } from 'vitest'
import { opened, type Page, pointer, SLOW } from '../start-page'

describe('the room', () => {
  /** The drawing's size, and where the room's inside begins in it: places go to the agent in centimetres from there. */
  const plan = (page: Page) => {
    const [, , vw, vh] = page.$('#room-plan').getAttribute('viewBox').split(' ').map(Number)
    return { vw, vh, x: Number(page.$('#room-floor').getAttribute('x')), y: Number(page.$('#room-floor').getAttribute('y')) }
  }
  /** Where the armchair's corner is, in centimetres from the room's corner. */
  const corner = (page: Page) => {
    const at = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(page.$('#chair').style.transform)!.slice(1).map(Number)
    const p = plan(page)
    return [at[0]! - p.x, at[1]! - p.y]
  }
  /** The armchair taken by its middle and put down with its corner at the place given, in centimetres. The stand-in browser draws the plan 720 by 520. */
  const dragged = (page: Page, to: [number, number]) => {
    const p = plan(page)
    const from = corner(page)
    const point = (cm: number[]) => [((cm[0]! + p.x + 39) / p.vw) * 720, ((cm[1]! + p.y + 39) / p.vh) * 520] as const
    const chair = page.$('#chair')
    pointer(page, chair, 'pointerdown', ...point(from))
    pointer(page, chair, 'pointermove', ...point(to))
    pointer(page, chair, 'pointerup', ...point(to))
    return page.sentOf('moved').at(-1)!
  }
  const lit = (page: Page, id: string) => page.$(`#room-${id}`).classList.contains('on')
  /** The page with a stage of the size given, which the stand-in browser does not lay out by itself. */
  const staged = (width: number, height: number) =>
    opened({}, (w) => {
      for (const [side, size] of [
        ['clientWidth', width],
        ['clientHeight', height],
      ] as const)
        Object.defineProperty(w.Element.prototype, side, {
          configurable: true,
          get(this: { id?: string }) {
            return this.id === 'room-fill' ? size : 0
          },
        })
    })

  test('a move goes to the agent in centimetres, with what is in the way and the free places first, each in a few words, and the answer is drawn from the state', async () => {
    const page = await opened()
    expect(page.$('#room-reset').hidden).toBe(true)
    const move = dragged(page, [390, 190])
    expect(Object.keys(move.data)).toEqual([
      'part',
      'request',
      'in_the_way',
      'free',
      'free_is',
      'armchair',
      'size',
      'room',
      'door_clears_by',
      'from_sofa',
      'by_window',
    ])
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
    expect(move.data.free_is).toHaveLength(3)
    for (const words of move.data.free_is) expect(words).toMatch(/^(by the (sofa|coffee table|shelves|plant|window|door)|in the open)(, on the rug)?$/)
    expect(JSON.stringify(move.data).length).toBeLessThan(600)
    // The armchair is the person's again only once the agent has answered
    expect(page.$('#chair').classList.contains('still')).toBe(true)
    expect(page.$('#chair').classList.contains('sent')).toBe(true)
    expect(page.state('room')).toBe('Sending what you did to It')
    await move.accept()
    expect(page.state('room')).toBe('It has it. Waiting for Claude Code 1 s')
    await page.set({ room: { request: move.data.request, armchair: move.data.free[1], lamp: true, say: 'Moved it off the table, by the rug.' } })
    expect(corner(page)).toEqual(move.data.free[1])
    // Where it was left, the way it was carried, the lamp, the measure, and the agent's hand on it
    expect(['ghost', 'trail', 'lamp', 'dim', 'hand'].map((id) => lit(page, id))).toEqual([true, true, true, true, true])
    expect(page.$('#room-tag-text').textContent).toBe('claude code')
    expect(page.$('#room-dim-text').textContent).toMatch(/^\d+ cm$/)
    expect(page.said('room')).toBe('Moved it off the table, by the rug.')
    expect(page.state('room')).toMatch(/^Claude Code answered in \d+\.\d s$/)
    expect(page.$('#chair').classList.contains('still')).toBe(false)
    expect(page.$('#chair').classList.contains('sent')).toBe(false)
    page.close()
  })

  test('a place where the armchair cannot stand is not used: the nearest free one is, and the sentence is still shown', async () => {
    for (const armchair of [[0, 0], [530, 130], [5000, 100], 'by the window', [Number.NaN, 2], [200]]) {
      const page = await opened()
      const move = dragged(page, [390, 190])
      await move.accept()
      await page.set({ room: { request: move.data.request, armchair, lamp: 'yes', say: 'There.' } })
      expect(corner(page), String(armchair)).toEqual(move.data.free[0])
      expect([page.said('room'), lit(page, 'lamp')]).toEqual(['There.', false])
      page.close()
    }
  })

  test('where the agent leaves the armchair where the person put it, nothing is drawn of a move, and its hand and the measure are', async () => {
    const page = await opened()
    const move = dragged(page, [200, 150])
    expect(move.data).toMatchObject({ in_the_way: null, armchair: [200, 150] })
    // A free place is the first of the free places itself
    expect(move.data.free[0]).toEqual([200, 150])
    await move.accept()
    await page.set({ room: { request: move.data.request, armchair: [200, 150], lamp: false, say: 'It is fine there.' } })
    expect(corner(page)).toEqual([200, 150])
    expect(['ghost', 'trail', 'lamp', 'dim', 'hand'].map((id) => lit(page, id))).toEqual([false, false, false, true, true])
    page.close()
  })

  test('the agent’s sentence is set as text, whatever is in it', async () => {
    const page = await opened()
    const move = dragged(page, [390, 190])
    await move.accept()
    await page.set({ room: { request: move.data.request, armchair: move.data.free[0], say: '<img src=x onerror=alert(1)> There.' } })
    expect(page.said('room')).toBe('<img src=x onerror=alert(1)> There.')
    expect(page.$('#dock-line img')).toBeNull()
    expect(page.$('[data-part="room"] img')).toBeNull()
    page.close()
  })

  test('an answer is held to the move it names: one to an earlier move is left alone, and one heard before It took the move is drawn once it has', async () => {
    const page = await opened()
    const first = dragged(page, [390, 190])
    await first.accept()
    // Nothing came for a while: the armchair is the person's again, and they move it on
    await page.advance(SLOW)
    expect(page.state('room')).toContain('No answer after 40 s')
    expect(page.$('#chair').classList.contains('still')).toBe(false)
    expect(page.$('#chair').classList.contains('sent')).toBe(false)
    const second = dragged(page, [260, 80])
    await page.set({ room: { request: first.data.request, armchair: first.data.free[0], lamp: true, say: 'Late.' } })
    expect([corner(page), page.said('room'), lit(page, 'lamp')]).toEqual([[260, 80], '', false])
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
    const move = dragged(page, [160, 160])
    await move.refuse()
    expect(page.state('room')).toBe('It did not take that. Do it again.')
    expect(page.$('#chair').classList.contains('still')).toBe(false)
    await page.set({ room: { request: move.data.request, armchair: [10, 10], say: 'No.' } })
    expect(page.said('room')).toBe('')
    expect(dragged(page, [170, 160]).data.request).not.toBe(move.data.request)
    page.close()
  })

  test('“Put it back” is there once the armchair has been moved, and puts the room back as it was: an answer that comes after it is not drawn', async () => {
    const page = await opened()
    const start = corner(page)
    const move = dragged(page, [390, 190])
    expect(page.$('#room-reset').hidden).toBe(false)
    // While the move is with the agent the armchair is not anyone's to put back
    page.$('#room-reset').click()
    expect(corner(page)).toEqual([390, 190])
    await move.accept()
    await page.advance(SLOW)
    page.$('#room-reset').click()
    expect(corner(page)).toEqual(start)
    expect(page.$('#room-reset').hidden).toBe(true)
    expect(page.read('room').stage).toBe('idle')
    await page.set({ room: { request: move.data.request, armchair: move.data.free[0], lamp: true, say: 'Too late.' } })
    expect([corner(page), page.said('room'), lit(page, 'lamp'), lit(page, 'hand')]).toEqual([start, '', false, false])
    page.close()
  })

  test('leaving the room in the middle of a wait throws nothing, and the answer is there to come back to', async () => {
    const page = await opened()
    const move = dragged(page, [390, 190])
    await move.accept()
    page.to('chess')
    await page.set({ room: { request: move.data.request, armchair: move.data.free[0], lamp: true, say: 'Done while you were away.' } })
    await page.advance(SLOW * 2)
    expect(page.errors).toEqual([])
    page.w.Shell.go('room')
    expect(page.said('room')).toBe('Done while you were away.')
    expect([corner(page), lit(page, 'lamp')]).toEqual([move.data.free[0], true])
    page.close()
  })

  test('on a wide stage the room is as wide as the stage, with a dining table and a sideboard in it, and what is sent is measured in that room', async () => {
    const page = await staged(1334, 553)
    expect(page.$('#room-plan').getAttribute('viewBox')).toBe('0 0 1242 514')
    expect(page.$('#room-size').textContent).toBe('LIVING ROOM · 12.1 × 4.4 M')
    expect(page.$('#room-windows').querySelectorAll('rect')).toHaveLength(2)
    expect(page.$('#room-dining').style.display).toBe('')
    // The dining table stands half-way between the shelves and the window over the rug
    const table = dragged(page, [440, 120])
    expect(table.data).toMatchObject({ room: [1210, 440], in_the_way: 'dining table', armchair: [440, 120] })
    for (const [x, y] of table.data.free) expect(x >= 9 && x <= 1210 - 78 - 9 && y >= 9 && y <= 440 - 78 - 9).toBe(true)
    await table.accept()
    await page.set({ room: { request: table.data.request, armchair: table.data.free[0], say: 'Off the table.' } })
    expect(dragged(page, [460, 360]).data.in_the_way).toBe('sideboard')
    page.close()
  })

  test('on a tall stage the room is laid out tall, with the sofa still on its wall and the door at the lower left, and what is sent is measured in that room', async () => {
    const page = await staged(366, 497)
    const [, , vw, vh] = page.$('#room-plan').getAttribute('viewBox').split(' ').map(Number)
    expect(vw).toBe(452)
    // The drawing has the stage's shape, to within the ten centimetres a wall is rounded to
    expect(Math.abs(vw / vh - 366 / 497)).toBeLessThan(0.02)
    expect(page.$('#room-size').textContent).toBe('4.2 × 5.4 M')
    expect(page.$('#room-dining').style.display).toBe('none')
    expect(page.$('#room-shelves').getAttribute('transform')).toContain('rotate(90)')
    const sofa = dragged(page, [320, 200])
    expect(sofa.data).toMatchObject({ room: [420, 540], in_the_way: 'sofa' })
    for (const [x, y] of sofa.data.free) expect(x >= 9 && x <= 420 - 78 - 9 && y >= 9 && y <= 540 - 78 - 9).toBe(true)
    await sofa.accept()
    await page.set({ room: { request: sofa.data.request, armchair: sofa.data.free[0], say: 'Off the sofa.' } })
    // Put in the door's swing, at the lower left
    const door = dragged(page, [20, 440])
    expect(door.data.in_the_way).toBe('door')
    expect(door.data.door_clears_by).toBeLessThan(6)
    page.close()
  })

  test('the room keeps its shape once the armchair has been moved, so that an answer is drawn in the room it was asked about', async () => {
    let width = 1334
    let height = 553
    const page = await opened({}, (w) => {
      for (const side of ['clientWidth', 'clientHeight'] as const)
        Object.defineProperty(w.Element.prototype, side, {
          configurable: true,
          get(this: { id?: string }) {
            return this.id !== 'room-fill' ? 0 : side === 'clientWidth' ? width : height
          },
        })
    })
    // Untouched, the room takes the stage's shape as the part is come to again
    width = 366
    height = 497
    page.w.Shell.go('board')
    page.w.Shell.go('room')
    expect(page.$('#room-size').textContent).toBe('4.2 × 5.4 M')
    const move = dragged(page, [320, 200])
    width = 1334
    height = 553
    page.w.Shell.go('board')
    page.w.Shell.go('room')
    expect(page.$('#room-size').textContent).toBe('4.2 × 5.4 M')
    await move.accept()
    await page.set({ room: { request: move.data.request, armchair: move.data.free[0], say: 'There.' } })
    expect(corner(page)).toEqual(move.data.free[0])
    // Put back, it is laid out for the stage as it is now
    page.$('#room-reset').click()
    expect(page.$('#room-size').textContent).toBe('LIVING ROOM · 12.1 × 4.4 M')
    page.close()
  })
})
