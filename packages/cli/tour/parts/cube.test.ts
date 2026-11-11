// The cube of the tour’s first page: how it turns, what asking for the next turns sends, and how the agent’s turns are played.
import { LIMITS } from '@it/protocol'
import { describe, expect, test } from 'vitest'
import { opened, type Page, SLOW } from '../start-page'

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

  test('asking for the next turns sends the way back first: the turns since it was solved, undone from the last, as far as one answer is played', async () => {
    const page = await cube()
    for (const name of ['R', 'U', "F'"]) [...page.$('#keys').children].find((k: any) => k.textContent === name).click()
    page.$('#cube-front').dispatchEvent(new page.w.KeyboardEvent('keydown', { key: 'd', bubbles: true }))
    page.$('#cube-front').dispatchEvent(new page.w.KeyboardEvent('keydown', { key: 'd', bubbles: true }))
    page.$('#cube-ask').click()
    const asked = page.sentOf('turned')[0]!
    expect(Object.keys(asked.data).slice(0, 4)).toEqual(['part', 'request', 'back', 'more'])
    expect(asked.data).toMatchObject({ part: 'cube', turns: ['R', 'U', "F'", 'D2'], back: ['D2', 'F', "U'", "R'"], more: 0, solved: false })
    // Played as it is given, it solves the cube
    await asked.accept()
    await page.set({ cube: { request: asked.data.request, moves: asked.data.back, say: 'Back the way you came.' } })
    await page.advance(5000)
    expect(page.$('#cube-turns').textContent).toBe('solved')
    page.close()
  })
})

describe('the cube’s late answers and long histories', () => {
  const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB'
  const cube = async () => {
    const page = await opened({}, (w) => {
      // Something moves here, so that the agent’s turns take their time
      w.matchMedia = () => ({ matches: false })
    })
    page.to('cube')
    return page
  }
  const press = (page: Page, name: string) => page.$(`[aria-label="Turn ${name}"]`).click()

  test('the cube is the agent’s while its turns are played, where the answer came after the person had it back too', async () => {
    const page = await cube()
    press(page, 'R')
    page.$('#cube-ask').click()
    const turned = page.sentOf('turned')[0]!
    await turned.accept()
    await page.advance(SLOW)
    expect(page.$('#cube-solve').disabled).toBe(false)
    await page.set({ cube: { request: turned.data.request, moves: ["R'", 'U'], say: 'Late.' } })
    expect([page.$('#cube-solve').disabled, page.$('#cube-mix').disabled, page.$('[aria-label="Turn R"]').disabled]).toEqual([true, true, true])
    // A press that got through all the same changes nothing
    page.$('#cube-solve').click()
    await page.advance(2000)
    expect(page.$('#cube-turns').textContent).toBe('1 turn since it was solved')
    expect(page.$('#cube-said').textContent).toBe('Played 2 turns.')
    expect(page.$('#cube-solve').disabled).toBe(false)
    page.close()
  })

  test('a late answer to a cube the person has turned since is not played', async () => {
    const page = await cube()
    press(page, 'R')
    page.$('#cube-ask').click()
    const turned = page.sentOf('turned')[0]!
    await turned.accept()
    await page.advance(SLOW)
    press(page, 'U')
    await page.set({ cube: { request: turned.data.request, moves: ["R'"], say: 'Late.' } })
    await page.advance(2000)
    expect(page.$('#cube-turns').textContent).toBe('2 turns since it was solved')
    page.close()
  })

  test('every turn since the cube was solved is told, so that undoing them from the last solves it, and the person’s turns stop while an action still carries them', async () => {
    const page = await cube()
    for (let i = 0; i < 61; i++) press(page, i % 2 ? 'U' : 'R')
    page.$('#cube-ask').click()
    const turned = page.sentOf('turned')[0]!
    expect(turned.data.turns).toHaveLength(61)
    const { turn } = page.w.__cube
    const undone = [...turned.data.turns].reverse().map((t: string) => (t.endsWith("'") ? t.slice(0, -1) : t.endsWith('2') ? t : `${t}'`))
    expect(undone.reduce((f: string, m: string) => turn(f, m), turned.data.faces)).toBe(SOLVED)
    await turned.refuse()
    for (let i = 61; i < 260; i++) press(page, i % 2 ? 'U' : 'R')
    expect(page.$('#cube-turns').textContent).toBe('200 turns since it was solved')
    expect(page.$('#cube-said').textContent).toBe('The cube keeps 200 turns of yours at most. Ask for the next turns, or start solved.')
    page.$('#cube-mix').click()
    expect(page.$('#cube-turns').textContent).toBe('200 turns since it was solved')
    page.$('#cube-ask').click()
    const all = page.sentOf('turned')[1]!
    expect(all.data.turns).toHaveLength(200)
    expect(new TextEncoder().encode(JSON.stringify(all.data)).length).toBeLessThan(LIMITS.actionPayloadBytes / 8)
    page.close()
  })
})
