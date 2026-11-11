// The cube of the tour’s first page: how it turns and is held, how it starts, what asking the agent how sends, and how the agent’s turns are shown, made and played.
import { describe, expect, test } from 'vitest'
import { opened, type Page, pointer, SLOW } from '../start-page'

type Turn = { a: number; l: number; q: number }
type Square = [number[], number[]]

/** A browser whose dice fall as given, over and over, so that a mix is the one the test means. */
const dice =
  (...rolls: number[]) =>
  (w: any) => {
    let i = 0
    w.Math.random = () => rolls[i++ % rolls.length]!
  }
/** The dice for a turn: which axis, which of its two outer layers, and which way. */
const roll = (a: number, l: number, q: number) => [a / 3 + 0.1, l > 0 ? 0.9 : 0.1, q > 0 ? 0.9 : 0.1]
/** The top row to the left and then the right column up, which is the mix most of these tests start from. */
const TWO = [...roll(1, 1, -1), ...roll(0, 1, -1)]
const cube = async (before: (w: any) => void = dice(...TWO)) => {
  const page = await opened({}, before)
  page.to('cube')
  return page
}
const now = (page: Page) => page.w.__cube.now() as { faces: string; way: Turn[]; frame: number }
/** The turns since the cube was solved, by their names as the cube is held. */
const way = (page: Page) => now(page).way.map((t) => page.w.__cube.nameOf(t, now(page).frame).turn as string)
/** A drag over the drawing, from one square of the cube to another, or between two points of the page. */
const drag = (page: Page, from: Square | number[], to: Square | number[], letGo = true) => {
  const canvas = page.$('#cube-canvas')
  const point = (at: Square | number[]) => (Array.isArray(at[0]) ? page.w.__cube.spot(at[0], at[1]) : at) as number[]
  const [a, b] = [point(from), point(to)]
  pointer(page, canvas, 'pointerdown', a[0]!, a[1]!)
  for (const part of [0.25, 0.5, 0.75, 1]) pointer(page, canvas, 'pointermove', a[0]! + (b[0]! - a[0]!) * part, a[1]! + (b[1]! - a[1]!) * part)
  if (letGo) pointer(page, canvas, 'pointerup', b[0]!, b[1]!)
}
const FRONT = [0, 0, 1]
const SIDE = [1, 0, 0]
/** The drag that makes a turn, by its name as the cube first stands: a row across the front, a column down it, and a face down the side. */
const turn = (page: Page, name: string) => {
  const [, layer, kind, to] = /^(\w+)-(row|column|face|layer)-(\w+)$/.exec(name)!
  const where = { top: 1, right: 1, front: 1, middle: 0, bottom: -1, left: -1, back: -1 }[layer!]!
  const ends: Square[] =
    kind === 'row'
      ? [
          [[-1, where, 1], FRONT],
          [[1, where, 1], FRONT],
        ]
      : kind === 'column'
        ? [
            [[where, 1, 1], FRONT],
            [[where, -1, 1], FRONT],
          ]
        : [
            [[1, 1, where], SIDE],
            [[1, -1, where], SIDE],
          ]
  if (to === 'left' || to === 'up' || to === 'anticlockwise') ends.reverse()
  drag(page, ends[0]!, ends[1]!)
}
const key = (page: Page, name: string, shiftKey = false) =>
  page.$('#cube-canvas').dispatchEvent(new page.w.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true }))
/** Asks the agent how, and gives what was sent. */
const ask = (page: Page) => {
  page.$('#cube-ask').click()
  return page.sentOf('turned').at(-1)!
}
const count = (page: Page) => page.$('#cube-count-of').textContent
const words = (page: Page) => (page.$('#cube-words').hidden ? null : page.$('#cube-words').textContent)
const step = (page: Page) => (page.$('#cube-count').hidden ? null : page.$('#cube-step').textContent)

describe('the cube', () => {
  test('turns as a cube turns', async () => {
    const page = await cube()
    const { turned, home, SOLVED } = page.w.__cube
    const after = (turns: Turn[], from = SOLVED) => turns.reduce((f: string, t) => turned(f, t), from)
    const every: Turn[] = [0, 1, 2].flatMap((a) => [-1, 0, 1].flatMap((l) => [1, -1].map((q) => ({ a, l, q }))))
    expect(home(SOLVED)).toBe(true)
    for (const t of every) {
      expect(home(after([t])), JSON.stringify(t)).toBe(false)
      expect(after([t, t, t, t])).toBe(SOLVED)
      expect(after([t, { ...t, q: -t.q }])).toBe(SOLVED)
      expect([...after([t])].sort().join('')).toBe(SOLVED)
    }
    // The right column up and the top row to the left, up to six times over, is no turn at all
    const sexy: Turn[] = [
      { a: 0, l: 1, q: -1 },
      { a: 1, l: 1, q: -1 },
      { a: 0, l: 1, q: 1 },
      { a: 1, l: 1, q: 1 },
    ]
    expect(after(Array.from({ length: 5 }, () => sexy).flat())).not.toBe(SOLVED)
    expect(after(Array.from({ length: 6 }, () => sexy).flat())).toBe(SOLVED)
    // The top row to the right takes the front face's top row onto the right face, whose squares are kept from its bottom row up
    expect(after([{ a: 1, l: 1, q: 1 }]).slice(9, 18)).toBe('111111222')
    // All three rows turned one way is the whole cube turned, which is solved still
    const whole = after([-1, 0, 1].map((l) => ({ a: 1, l, q: 1 })))
    expect([whole === SOLVED, home(whole)]).toEqual([false, true])
    page.close()
  })

  test('starts two turns from solved, a different two each time, and says so', async () => {
    const seen = new Set<string>()
    for (const rolls of [TWO, [...roll(2, 1, 1), ...roll(1, -1, 1)], [...roll(0, -1, 1), ...roll(2, 1, -1)]]) {
      const page = await cube(dice(...rolls))
      expect(now(page).way).toHaveLength(2)
      expect(page.w.__cube.home(now(page).faces)).toBe(false)
      expect(count(page)).toBe('2 turns back to solved')
      expect(page.$('#cube-ask').hidden).toBe(false)
      expect(page.$('#cube-ask').textContent).toBe('Ask Claude Code how')
      seen.add(way(page).join())
      page.close()
    }
    expect(seen.size).toBe(3)
    expect([...seen][0]).toBe('top-row-left,right-column-up')
    // The dice as they really fall give two turns each of which has a plain name as the cube stands, and no two the same axis
    for (let i = 0; i < 12; i++) {
      const page = await cube(() => {})
      const mix = now(page).way
      expect(mix).toHaveLength(2)
      expect(mix[0]!.a).not.toBe(mix[1]!.a)
      for (const name of way(page)) expect(name).toMatch(/^(top|bottom)-row-(left|right)$|^(left|right)-column-(up|down)$|^front-face-(anti)?clockwise$/)
      page.close()
    }
  })

  test('shows no letters for its turns anywhere: no button for a face, and nothing a person reads names a turn as cubers do', async () => {
    const page = await cube()
    const section = page.section('cube')
    expect([...section.querySelectorAll('button')].map((b: any) => b.textContent.trim())).toEqual(['Mix it again', 'Ask Claude Code how', 'Do it for me'])
    const read = [section.textContent, section.getAttribute('data-line'), page.$('#cube-canvas').getAttribute('aria-label'), page.read('cube').hint].join(' ')
    expect(read).not.toMatch(/\b[URFDLB](['’2i])?\b(?!ubik)/)
    expect(read).not.toMatch(/clockwise|prime/)
    expect(section.querySelectorAll('svg.cube, .keys, .key')).toHaveLength(0)
    page.close()
  })

  test('a drag across its squares turns the layer under it the way the finger goes, and a drag beside it looks round it and turns nothing', async () => {
    const page = await cube()
    const before = now(page).faces
    turn(page, 'middle-row-right')
    expect(way(page)).toEqual(['top-row-left', 'right-column-up', 'middle-row-right'])
    expect(now(page).faces).toBe(page.w.__cube.turned(before, { a: 1, l: 0, q: 1 }))
    turn(page, 'left-column-down')
    turn(page, 'front-face-clockwise')
    expect(way(page).slice(3)).toEqual(['left-column-down', 'front-face-clockwise'])
    expect(count(page)).toBe('5 turns back to solved')
    // A turn and its undoing are no turn
    turn(page, 'front-face-anticlockwise')
    turn(page, 'left-column-up')
    turn(page, 'middle-row-left')
    expect(way(page)).toEqual(['top-row-left', 'right-column-up'])
    expect(now(page).faces).toBe(before)
    // A short pull is let go of, and the layer falls back
    drag(page, [[-1, 1, 1], FRONT], [[-0.6, 1, 1], FRONT])
    expect(now(page).faces).toBe(before)
    // Beside the cube there is nothing to turn: the cube is looked at from another side
    drag(page, [20, 60], [200, 60])
    expect(now(page).faces).toBe(before)
    expect(now(page).frame).not.toBe(0)
    expect(page.sent).toEqual([])
    expect(page.errors).toEqual([])
    page.close()
  })

  test('a person may simply solve it, and it says that it is solved', async () => {
    const page = await cube()
    turn(page, 'right-column-down')
    expect(count(page)).toBe('1 turn back to solved')
    expect(page.$('#cube-done').hidden).toBe(true)
    turn(page, 'top-row-right')
    expect(count(page)).toBe('Solved')
    expect(page.$('#cube-done').hidden).toBe(false)
    expect(page.$('#cube-done').textContent).toBe('Solved')
    expect(page.$('#line').textContent).toBe('Solved. Mix it again for another go.')
    expect([page.$('#cube-ask').hidden, page.$('#cube-mix').disabled]).toEqual([true, false])
    expect(page.sent).toEqual([])
    page.close()
  })

  test('is turned with the keys: the arrows go over the face in front and past its edge to the next, and Shift turns the row or the column', async () => {
    const page = await cube()
    const before = now(page).faces
    // From the middle square: its row to the right, and its column up
    key(page, 'ArrowRight', true)
    key(page, 'ArrowUp', true)
    expect(way(page).slice(2)).toEqual(['middle-row-right', 'middle-column-up'])
    key(page, 'ArrowDown', true)
    key(page, 'ArrowLeft', true)
    expect(now(page).faces).toBe(before)
    // Up and to the right, to the top right square: the top row, and the right column
    key(page, 'ArrowUp')
    key(page, 'ArrowRight')
    key(page, 'ArrowDown', true)
    key(page, 'ArrowRight', true)
    expect(way(page)).toEqual([])
    expect(count(page)).toBe('Solved')
    // The face in front, with the comma and the full stop
    key(page, '.')
    expect(way(page)).toEqual(['front-face-clockwise'])
    key(page, ',')
    expect(way(page)).toEqual([])
    // Past the right edge is the face to the right, and the keys are on that face from then on
    key(page, 'ArrowRight')
    expect(now(page).frame).toBe(1)
    key(page, '.')
    expect(now(page).way).toEqual([{ a: 0, l: 1, q: -1 }])
    expect(way(page)).toEqual(['front-face-clockwise'])
    expect(page.sent).toEqual([])
    page.close()
  })

  test('asking sends the way back first, each turn by a plain name, and little enough for the agent to be shown all of it', async () => {
    const page = await cube()
    const asked = ask(page)
    expect(Object.keys(asked.data)).toEqual(['part', 'request', 'back', 'more', 'cube'])
    expect(asked.data).toMatchObject({
      part: 'cube',
      back: [
        { turn: 'right-column-down', plain: 'the right column, down' },
        { turn: 'top-row-right', plain: 'the top row, to the right' },
      ],
      more: 0,
    })
    expect(asked.data.request).toMatch(/^[0-9a-f]{32}$/)
    // The cube as it is seen, each face read from outside row by row. The top row went to the left, which brought red to the front, and then
    // the right column went up, which brought the front's right column onto the top and the bottom's onto the front
    expect(asked.data.cube).toEqual({ top: 'wwrwwgwwg', front: 'rryggyggy', right: 'rrbrrbrrb', back: 'woowbbwbb', left: 'gggoooooo', bottom: 'yybyybyyo' })
    expect(JSON.stringify(asked.data).length).toBeLessThan(700)
    expect(page.you('cube')).toBe('asked the way')
    page.close()
    // However far the cube has been turned, three turns of the way back go, with how many come after them
    const far = await cube()
    for (let i = 0; i < 30; i++) turn(far, i % 2 ? 'left-column-down' : 'bottom-row-right')
    expect(count(far)).toBe('32 turns back to solved')
    expect(far.$('#line').textContent).toBe('Drag a row to turn it, or ask Claude Code for the way back.')
    const long = ask(far)
    expect(long.data.back.map((b: any) => b.turn)).toEqual(['left-column-up', 'bottom-row-left', 'left-column-up'])
    expect(long.data.more).toBe(29)
    expect(JSON.stringify(long.data).length).toBeLessThan(2000)
    // Every turn since it was solved is kept: undone from the last, they solve it
    const { turned, home } = far.w.__cube
    expect(home(now(far).way.reduceRight((f: string, t) => turned(f, { ...t, q: -t.q }), now(far).faces))).toBe(true)
    far.close()
  })

  test('names the turns as the cube is held when it is asked, from a side where none of them is hard to say', async () => {
    // The back face turned, as the cube first stands
    const page = await cube(dice(...TWO))
    turn(page, 'back-face-clockwise')
    expect(page.w.__cube.nameOf(now(page).way[2], 0)).toMatchObject({ turn: 'back-face-clockwise', plain: 'the back face, clockwise as seen from the front', hard: true })
    const asked = ask(page)
    // Held with the right face in front, that face is the right column, and the right column is the front face
    expect(asked.data.back.map((b: any) => b.turn)).toEqual(['right-column-up', 'front-face-anticlockwise', 'top-row-right'])
    await asked.accept()
    await page.set({ cube: { request: asked.data.request, moves: [{ turn: 'right-column-up', say: 'Up it goes' }], say: 'One at a time.' } })
    // The cube is brought round to be held that way, and the turn is the one the name meant from there
    expect(now(page).frame).toBe(1)
    page.$('#cube-auto').click()
    expect(way(page)).toEqual(['top-row-left', 'front-face-clockwise'])
    expect(now(page).way).toEqual([
      { a: 1, l: 1, q: -1 },
      { a: 0, l: 1, q: -1 },
    ])
    page.close()
  })
})

describe('the agent’s turns on the cube', () => {
  const answered = async (moves: unknown, say = 'Two turns and it is home.', before?: (w: any) => void) => {
    const page = await cube(before)
    const asked = ask(page)
    await asked.accept()
    await page.set({ cube: { request: asked.data.request, moves, say } })
    return page
  }
  const BACK = [
    { turn: 'right-column-down', say: 'Pull the right column down' },
    { turn: 'top-row-right', say: 'Now slide the top row to the right' },
  ]

  test('are shown one at a time with the agent’s own words, and each is the person’s to make', async () => {
    const page = await answered(BACK)
    expect(page.said('cube')).toBe('Two turns and it is home.')
    expect([step(page), words(page)]).toEqual(['Claude Code · turn 1 of 2', 'Pull the right column down'])
    expect(page.$('#line').textContent).toBe('Make the turn the arrow shows, or have it done for you.')
    expect([page.$('#cube-ask').hidden, page.$('#cube-auto').hidden]).toEqual([true, false])
    // Nothing has turned: the turn is shown, and not made
    expect(way(page)).toEqual(['top-row-left', 'right-column-up'])
    turn(page, 'right-column-down')
    expect([step(page), words(page)]).toEqual(['Claude Code · turn 2 of 2', 'Now slide the top row to the right'])
    expect([...page.$('#cube-dots').children].map((d: any) => d.className)).toEqual(['made', 'now'])
    turn(page, 'top-row-right')
    expect(count(page)).toBe('Solved')
    expect([step(page), words(page), page.$('#cube-done').hidden, page.$('#cube-auto').hidden]).toEqual([null, null, false, true])
    page.close()
  })

  test('a turn that is not the one shown is put back, with the arrow and the words still there', async () => {
    const page = await answered(BACK)
    const before = now(page).faces
    // Another layer, and the right layer the wrong way
    turn(page, 'bottom-row-left')
    expect(page.$('#cube-said').textContent).toBe('That was another turn, so it is put back.')
    turn(page, 'right-column-up')
    key(page, 'ArrowLeft', true)
    expect(now(page).faces).toBe(before)
    expect([step(page), words(page)]).toEqual(['Claude Code · turn 1 of 2', 'Pull the right column down'])
    turn(page, 'right-column-down')
    expect(page.$('#cube-said').textContent).toBe('')
    expect(step(page)).toBe('Claude Code · turn 2 of 2')
    page.close()
  })

  test('“Do it for me” plays them one after another, and the cube is held while they are played', async () => {
    const page = await answered(BACK)
    page.$('#cube-auto').click()
    expect(way(page)).toEqual(['top-row-left'])
    expect([page.$('#cube-auto').disabled, page.$('#cube-mix').disabled]).toEqual([true, true])
    // A pull at a layer and a press that got through change nothing
    const held = now(page).faces
    turn(page, 'middle-row-right')
    key(page, 'ArrowRight', true)
    page.$('#cube-mix').click()
    expect(now(page).faces).toBe(held)
    await page.advance(2000)
    expect(count(page)).toBe('Solved')
    expect([page.$('#cube-done').hidden, page.$('#cube-mix').disabled]).toEqual([false, false])
    page.close()
  })

  test('are only turns that are turns, three at a time, and their words are put in as words', async () => {
    const page = await answered(
      [
        { turn: 'right-column-down', say: '<b onclick="x()">Down</b> with the right' },
        'top-row-right',
        { turn: "R'", say: 'A letter' },
        7,
        null,
        { turn: 'Bottom-Row-Left ', say: 3 },
        { turn: 'front-face-clockwise', say: 'A fourth' },
        ['top-row-left'],
      ],
      '<i>Here</i> you are.',
    )
    expect(page.said('cube')).toBe('<i>Here</i> you are.')
    expect(words(page)).toBe('<b onclick="x()">Down</b> with the right')
    expect(page.$('#cube-words').children).toHaveLength(0)
    expect(step(page)).toBe('Claude Code · turn 1 of 3')
    turn(page, 'right-column-down')
    // A turn given by its name alone has no words of the agent’s, and the page writes none for it
    expect([step(page), words(page)]).toEqual(['Claude Code · turn 2 of 3', null])
    turn(page, 'top-row-right')
    // The two the agent sent first have solved it, and the third is not asked for
    expect([count(page), step(page)]).toEqual(['Solved', null])
    page.close()
  })

  test('where they do not lead home, the page says what was sent and where the cube stands, and nothing else', async () => {
    const page = await answered([{ turn: 'left-column-up', say: 'Try the left' }, { turn: 'nonsense' }, { turn: 'bottom-row-right', say: 'And the bottom' }], 'Trust me.')
    page.$('#cube-auto').click()
    await page.advance(3000)
    expect(way(page)).toEqual(['top-row-left', 'right-column-up', 'left-column-up', 'bottom-row-right'])
    expect(count(page)).toBe('4 turns back to solved')
    expect(page.$('#cube-said').textContent).toBe('Claude Code sent 3 turns. One was not a turn of the cube, and was left out.')
    expect([page.$('#cube-done').hidden, step(page), page.$('#cube-ask').hidden, page.$('#cube-ask').disabled]).toEqual([true, null, false, false])
    // More than three are shown three at a time
    const many = await answered(['top-row-left', 'top-row-left', 'bottom-row-left', 'bottom-row-left', 'bottom-row-left'])
    expect(step(many)).toBe('Claude Code · turn 1 of 3')
    many.$('#cube-auto').click()
    await many.advance(4000)
    expect(many.$('#cube-said').textContent).toBe('Claude Code sent 5 turns. Three are shown at a time.')
    // And an answer with no turn in it shows none
    const none = await answered('back')
    expect([step(none), none.$('#cube-said').textContent, way(none)]).toEqual([null, 'Claude Code sent no turns.', ['top-row-left', 'right-column-up']])
    const wrong = await answered(['U', { turn: 'F2' }])
    expect([step(wrong), wrong.$('#cube-said').textContent]).toEqual([null, 'Claude Code sent 2 turns. 2 were not turns of the cube, and were left out.'])
    for (const p of [page, many, none, wrong]) p.close()
  })

  test('an answer to an earlier request is not shown, and the cube is held as it is while the agent is asked', async () => {
    const page = await cube()
    const asked = ask(page)
    expect([page.$('#cube-ask').disabled, page.$('#cube-mix').disabled]).toEqual([true, true])
    await asked.accept()
    const held = now(page).faces
    turn(page, 'top-row-right')
    key(page, 'ArrowDown', true)
    expect(now(page).faces).toBe(held)
    await page.set({ cube: { request: 'earlier', moves: BACK, say: 'Stale.' } })
    expect([step(page), page.said('cube')]).toEqual([null, ''])
    await page.set({ cube: { request: asked.data.request, moves: BACK, say: 'Here.' } })
    expect(step(page)).toBe('Claude Code · turn 1 of 2')
    page.close()
  })

  test('after forty seconds the cube is the person’s again, a late answer is still shown, and one to a cube turned since is not', async () => {
    const page = await cube()
    const asked = ask(page)
    await asked.accept()
    await page.advance(SLOW)
    expect(page.read('cube').stage).toBe('slow')
    expect([page.$('#cube-ask').disabled, page.$('#cube-mix').disabled]).toEqual([false, false])
    await page.set({ cube: { request: asked.data.request, moves: BACK, say: 'Late.' } })
    expect([step(page), page.said('cube')]).toEqual(['Claude Code · turn 1 of 2', 'Late.'])
    // The late turns are played as any are, and the cube is held while they are
    page.$('#cube-auto').click()
    expect(page.$('#cube-mix').disabled).toBe(true)
    await page.advance(2000)
    expect(count(page)).toBe('Solved')
    page.close()

    const turnedSince = await cube()
    const first = ask(turnedSince)
    await first.accept()
    await turnedSince.advance(SLOW)
    turn(turnedSince, 'bottom-row-left')
    await turnedSince.set({ cube: { request: first.data.request, moves: BACK, say: 'Late.' } })
    expect([step(turnedSince), turnedSince.said('cube'), way(turnedSince)]).toEqual([null, '', ['top-row-left', 'right-column-up', 'bottom-row-left']])
    turnedSince.close()
  })

  test('mixing it again starts from solved with three turns, and ends what the agent was showing', async () => {
    const page = await answered(BACK, 'Two turns.', dice(...TWO, ...roll(2, 1, 1), ...roll(0, -1, 1), ...roll(1, -1, -1)))
    page.$('#cube-mix').click()
    expect(way(page)).toEqual(['front-face-anticlockwise', 'left-column-down', 'bottom-row-left'])
    expect([count(page), step(page), page.$('#cube-ask').hidden, page.said('cube')]).toEqual(['3 turns back to solved', null, false, ''])
    expect(page.read('cube').stage).toBe('idle')
    // The way back from a mix is as long as the mix, and is what is asked with
    expect(ask(page).data.back.map((b: any) => b.turn)).toEqual(['bottom-row-right', 'left-column-up', 'front-face-clockwise'])
    page.close()
  })
})

describe('the cube where things move', () => {
  const moving = (w: any) => {
    dice(...TWO)(w)
    w.matchMedia = () => ({ matches: false })
  }

  test('a layer let go of falls home in its own time, the agent’s turns take theirs, and leaving the part stops them', async () => {
    const page = await cube(moving)
    expect(way(page)).toEqual(['top-row-left', 'right-column-up'])
    turn(page, 'middle-row-right')
    // Not a turn until it has come home
    expect(way(page)).toHaveLength(2)
    await page.advance(400)
    expect(way(page)).toHaveLength(3)
    turn(page, 'middle-row-left')
    await page.advance(400)
    const asked = ask(page)
    await asked.accept()
    await page.set({ cube: { request: asked.data.request, moves: asked.data.back.map((b: any) => ({ turn: b.turn, say: 'This one' })), say: 'Watch.' } })
    // A wrong turn goes round and comes back
    turn(page, 'bottom-row-left')
    await page.advance(1200)
    expect(way(page)).toHaveLength(2)
    page.$('#cube-auto').click()
    await page.advance(600)
    expect(way(page)).toEqual(['top-row-left'])
    // Left while they play: the turn under way is finished, and no other is started
    page.$('#back').click()
    await page.advance(5000)
    expect(way(page)).toEqual(['top-row-left'])
    page.$('#next').click()
    expect([step(page), page.$('#cube-auto').disabled]).toEqual(['Claude Code · turn 2 of 2', false])
    page.$('#cube-auto').click()
    await page.advance(2000)
    expect(count(page)).toBe('Solved')
    expect(page.errors).toEqual([])
    page.close()
  })
})
