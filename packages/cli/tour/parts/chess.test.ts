// The chessboard of the tour’s first page, held to what the chessboard’s own page is held to in tour.test.ts.
import { describe, expect, test } from 'vitest'
import { opened, type Page } from '../start-page'

describe('the chessboard on the first page', () => {
  /** The board with the person's move made on it: one square tapped, then the other. */
  const moved = (page: Page, from: string, to: string) => {
    page.$(`[data-sq="${from}"]`).click()
    page.$(`[data-sq="${to}"]`).click()
    return page.sent.at(-1)!
  }
  /** The piece on a square, as FEN writes it, or nothing. */
  const piece = (page: Page, at: string) => page.$(`[data-sq="${at}"] .pc`)?.getAttribute('data-piece') ?? ''
  const waits = (page: Page) => page.$('[data-part="chess"]').getAttribute('data-wait') === '1'
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
    // The page says nothing in the agent's place: with no word of the agent's, what the dock has is the page's own hint
    expect(after.said('chess')).toBe('')
    expect(after.read('chess').hint).toContain('What Claude Code says of its move is written here')
    expect(after.read('chess').did).toBe('played e4')
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
    page.$('#chess-new').click()
    const again = moved(page, 'd2', 'd4')
    await again.accept()
    expect([piece(page, 'e7') !== '', piece(page, 'e5'), waits(page)]).toEqual([true, '', true])
    page.close()
    const other = await chess()
    const lost = moved(other, 'e2', 'e4')
    await reply(other, `${lost.data.request}:e7e5`)
    await lost.refuse()
    expect([piece(other, 'e2') !== '', waits(other)]).toEqual([true, false])
    expect(other.state('chess')).toBe('It did not take that. Do it again.')
    await moved(other, 'd2', 'd4').accept()
    expect([piece(other, 'e7') !== '', piece(other, 'e5'), waits(other)]).toEqual([true, '', true])
    other.close()
  })

  test('where no answer has come in forty seconds the person has their move back, as the dock says, and a late answer to it is not played', async () => {
    const page = await chess()
    const slow = moved(page, 'e2', 'e4')
    await slow.accept()
    await page.advance(39_000)
    expect([piece(page, 'e4') !== '', waits(page)]).toEqual([true, true])
    await page.advance(1_500)
    // The pawn is back where it was, the board is the person's, and the dock says so without promising the late answer
    expect([piece(page, 'e2') !== '', piece(page, 'e4'), waits(page)]).toEqual([true, '', false])
    expect(page.read('chess').stage).toBe('slow')
    expect(page.state('chess')).toBe('No answer after 40 s. This is yours again.')
    await reply(page, `${slow.data.request}:e7e5`, 'Late.')
    expect([piece(page, 'e7') !== '', piece(page, 'e5')]).toEqual([true, ''])
    expect(page.said('chess')).toBe('')
    // And they play on, with a move of their own that waits on an answer of its own
    const next = moved(page, 'd2', 'd4')
    expect(next.data.request).not.toBe(slow.data.request)
    expect(next.data.new_game).toBe(true)
    await next.accept()
    await reply(page, `${next.data.request}:d7d5`)
    expect([piece(page, 'd5') !== '', waits(page)]).toEqual([true, false])
    expect(page.errors).toEqual([])
    page.close()
  })

  test('a reply names the pending move, so an old answer cannot play after a new game or another turn', async () => {
    const page = await chess()
    const old = moved(page, 'e2', 'e4')
    await old.accept()
    page.$('#chess-new').click()
    // A new game sends nothing by itself
    expect(page.sent.map((s) => s.name)).toEqual(['move'])
    const current = moved(page, 'd2', 'd4')
    await current.accept()
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

  test('a new game sends nothing, and its first move tells the agent that it is one and how the game before it ended', async () => {
    const page = await chess()
    const first = moved(page, 'e2', 'e4')
    expect(first.data).toMatchObject({ new_game: true })
    expect('last_game' in first.data).toBe(false)
    await first.accept()
    await reply(page, `${first.data.request}:e7e5`)
    const second = moved(page, 'g1', 'f3')
    expect('new_game' in second.data).toBe(false)
    await second.accept()
    page.$('#chess-new').click()
    expect(page.sent).toHaveLength(2)
    expect([page.read('chess').stage, piece(page, 'e2'), piece(page, 'e7'), page.$('#chess-moves').textContent]).toEqual(['idle', 'P', 'p', '1.'])
    const again = moved(page, 'd2', 'd4')
    expect(again.data).toMatchObject({ new_game: true, last_game: 'left unfinished', move: 'd2d4' })
    expect(again.data.fen).toMatch(/ b KQkq d3 0 1$/)
    page.close()
  })

  test('a move of the person’s that ends the game is not sent, since there is nothing to answer: the next game’s first move says how it ended', async () => {
    const page = await chess()
    // Scholar's mate: 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#
    for (const [from, to, answer] of [
      ['e2', 'e4', 'e7e5'],
      ['f1', 'c4', 'b8c6'],
      ['d1', 'h5', 'g8f6'],
    ] as const) {
      const move = moved(page, from, to)
      await move.accept()
      await reply(page, `${move.data.request}:${answer}`, 'A word about it.')
    }
    page.$('[data-sq="h5"]').click()
    page.$('[data-sq="f7"]').click()
    expect(page.sent).toHaveLength(3)
    expect([piece(page, 'f7'), waits(page), page.read('chess').stage]).toEqual(['Q', false, 'idle'])
    expect(page.$('#line').textContent).toBe('Checkmate. You won.')
    expect([page.$('#chess-white-turn').textContent, page.$('#chess-black-turn').textContent]).toEqual(['won', ''])
    expect(page.$('#chess-moves').textContent).toContain('Qxf7#')
    // What the agent said of the move before is about a game that is over, and is not left beside its name
    expect(page.$('#chess-note').textContent).toBe('')
    page.$('#chess-new').click()
    expect(page.sent).toHaveLength(3)
    expect(moved(page, 'e2', 'e4').data).toMatchObject({ new_game: true, last_game: 'White won by checkmate' })
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

  test('the agent’s note beside its move is said', async () => {
    const page = await chess()
    const move = moved(page, 'e2', 'e4')
    await move.accept()
    await reply(page, `${move.data.request}:e7e5`, 'The open game.')
    expect(page.said('chess')).toBe('The open game.')
    page.close()
  })

  test('the agent’s move is also taken as `move` beside the `request` it answers, which is what `it tour answer` writes', async () => {
    const page = await chess()
    const move = moved(page, 'e2', 'e4')
    await move.accept()
    await page.set({ chess: { request: move.data.request, move: 'g8f6', note: 'Knight out.' } })
    expect([piece(page, 'g8'), piece(page, 'f6') !== '', waits(page)]).toEqual(['', true, false])
    expect(page.said('chess')).toBe('Knight out.')
    // One for an earlier request is left alone
    const second = moved(page, 'd2', 'd4')
    await second.accept()
    await page.set({ chess: { request: move.data.request, move: 'e7e5' } })
    expect([piece(page, 'e7') !== '', waits(page)]).toEqual([true, true])
    page.close()
  })

  test('each move goes with a few sound answers, best first, before the whole list of what the agent may play', async () => {
    const page = await chess()
    const first = moved(page, 'e2', 'e4')
    expect(Object.keys(first.data)).toEqual(['part', 'request', 'move', 'said', 'good', 'new_game', 'fen', 'legal'])
    expect(first.data.good).toHaveLength(4)
    for (const move of first.data.good) expect(first.data.legal).toContain(move)
    // In the opening they are the moves a sound opening makes: the centre, or a knight brought out
    for (const move of first.data.good) expect(move).toMatch(/^(e7e5|d7d5|e7e6|d7d6|g8f6|b8c6)$/)
    await first.accept()
    await reply(page, `${first.data.request}:e7e5`)
    // A queen put where a pawn takes it for nothing: taking her is the first of the sound answers
    moved(page, 'd1', 'h5')
    await page.sent.at(-1)!.accept()
    await reply(page, `${page.sent.at(-1)!.data.request}:g7g6`)
    const hung = moved(page, 'h5', 'g6')
    expect(Object.keys(hung.data)).toEqual(['part', 'request', 'move', 'said', 'good', 'fen', 'legal'])
    expect(hung.data.good[0]).toMatch(/^[fh]7g6$/)
    // What it carries stays well inside what the agent is shown of an action without asking for more
    expect(JSON.stringify(hung.data).length).toBeLessThan(1500)
    page.close()
  })

  test('a move that leaves a piece to be taken for nothing, or walks into mate, is not among the sound answers', async () => {
    const page = await chess()
    // Scholar's mate is threatened: 1. e4 e5 2. Bc4 Nc6 3. Qh5
    for (const [from, to, answer] of [
      ['e2', 'e4', 'e7e5'],
      ['f1', 'c4', 'b8c6'],
    ] as const) {
      const move = moved(page, from, to)
      await move.accept()
      await reply(page, `${move.data.request}:${answer}`)
    }
    const threat = moved(page, 'd1', 'h5')
    // g8f6 lets the queen mate on f7, and is a move Black may make all the same
    expect(threat.data.legal).toContain('g8f6')
    expect(threat.data.good).not.toContain('g8f6')
    // Nor is one that leaves the queen to be taken
    expect(threat.data.good).not.toContain('d8h4')
    for (const move of threat.data.good) expect(threat.data.legal).toContain(move)
    page.close()
  })
})

describe('what is around the chessboard on the first page', () => {
  const moved = (page: Page, from: string, to: string) => {
    page.$(`[data-sq="${from}"]`).click()
    page.$(`[data-sq="${to}"]`).click()
    return page.sent.at(-1)!
  }
  const game = async (moves: readonly (readonly [string, string, string])[]) => {
    const page = await opened()
    page.to('chess')
    for (const [from, to, answer] of moves) {
      const move = moved(page, from, to)
      await move.accept()
      await page.set({ chess: { request: move.data.request, move: answer } })
    }
    return page
  }
  const taken = (page: Page, side: string) =>
    [...page.$(`#chess-${side}-taken`).querySelectorAll('[data-piece]')].map((el: any) => el.getAttribute('data-piece')).join('')

  test('the moves are written on a sheet as a player writes them, what was taken stands beside who took it, and whose move it is is said', async () => {
    const page = await game([
      ['e2', 'e4', 'e7e5'],
      ['g1', 'f3', 'b8c6'],
      ['f1', 'c4', 'g8f6'],
      ['f3', 'e5', 'c6e5'],
      ['c4', 'f7', 'e8f7'],
    ])
    const lines = [...page.$('#chess-moves').querySelectorAll('li')].map((li: any) => [...li.children].map((el: any) => el.textContent).join(' '))
    expect(lines).toEqual(['1. e4 e5', '2. Nf3 Nc6', '3. Bc4 Nf6', '4. Nxe5 Nxe5', '5. Bxf7+ Kxf7'])
    expect(page.$('#chess-moves .now').textContent).toBe('Kxf7')
    // White took two pawns, and Black a knight and a bishop, which leaves Black four ahead
    expect([taken(page, 'white'), taken(page, 'black')]).toEqual(['pp', 'NB'])
    expect([page.$('#chess-white-taken b'), page.$('#chess-black-taken b').textContent]).toEqual([null, '+4'])
    expect([page.$('#chess-white-turn').textContent, page.$('#chess-black-turn').textContent]).toEqual(['to move', ''])
    expect(page.read('chess').did).toBe('played Bxf7+')
    const next = moved(page, 'd2', 'd4')
    expect([page.$('#chess-white-turn').textContent, page.$('#chess-black-turn').textContent, page.$('#chess-white').classList.contains('said')]).toEqual([
      '',
      'to move',
      false,
    ])
    // A move that It refuses is taken off the sheet with the board
    await next.refuse()
    expect(page.$('#chess-moves').textContent).not.toContain('d4')
    expect(page.$('#chess-white-turn').textContent).toBe('to move')
    page.close()
  })

  test('two pieces of a kind that could go to one square are told apart on the sheet, and castling is written as it is', async () => {
    const page = await game([
      ['g1', 'f3', 'g8f6'],
      ['b1', 'c3', 'b8c6'],
      ['e2', 'e4', 'e7e5'],
      ['f1', 'e2', 'f8e7'],
      ['e1', 'g1', 'e8g8'],
      ['c3', 'd5', 'f6d5'],
      ['e4', 'd5', 'c6b4'],
      ['d2', 'd4', 'b4d5'],
    ])
    const text = page.$('#chess-moves').textContent
    expect(text).toContain('O-O')
    expect(text).toContain('exd5')
    // Either knight could go to d5: the one from b4 is told from the one that was on f6 before it was taken there
    expect(
      [...page.$('#chess-moves').querySelectorAll('span')]
        .map((el: any) => el.textContent)
        .filter(Boolean)
        .at(-1),
    ).toBe('Nxd5')
    moved(page, 'f3', 'd2')
    expect(page.$('#chess-moves .now').textContent).toBe('Nd2')
    page.close()
  })

  test('the squares the agent’s move left and reached are marked as its own, and the person’s as theirs', async () => {
    const page = await opened()
    page.to('chess')
    const move = moved(page, 'e2', 'e4')
    const marked = (at: string) =>
      page
        .$(`[data-sq="${at}"]`)
        .className.split(' ')
        .filter((c: string) => c === 'last' || c === 'theirs')
        .join(' ')
    expect([marked('e2'), marked('e4'), marked('e7')]).toEqual(['last', 'last', ''])
    await move.accept()
    await page.set({ chess: { request: move.data.request, move: 'e7e5', note: 'Meeting you.' } })
    expect([marked('e2'), marked('e4'), marked('e7'), marked('e5')]).toEqual(['', '', 'last theirs', 'last theirs'])
    page.close()
  })

  test('the agent’s words about its move are its own, set as text in the dock and beside its name, and are gone when the person moves on', async () => {
    const page = await opened()
    page.to('chess')
    const move = moved(page, 'e2', 'e4')
    await move.accept()
    await page.set({ chess: { request: move.data.request, move: 'e7e5', note: '<b>Bold</b> in the centre.' } })
    expect(page.said('chess')).toBe('<b>Bold</b> in the centre.')
    expect(page.$('#chess-note').textContent).toBe('<b>Bold</b> in the centre.')
    expect(page.$('#chess-note').children).toHaveLength(0)
    expect(page.$('#chess-black-name').textContent).toBe('Claude Code')
    const next = moved(page, 'g1', 'f3')
    expect([page.said('chess'), page.$('#chess-note').textContent]).toEqual(['', ''])
    // The same words about the next move are said again
    await next.accept()
    await page.set({ chess: { request: next.data.request, move: 'b8c6', note: '<b>Bold</b> in the centre.' } })
    expect(page.said('chess')).toBe('<b>Bold</b> in the centre.')
    // A note that is not words is not said
    const third = moved(page, 'f1', 'c4')
    await third.accept()
    await page.set({ chess: { request: third.data.request, move: 'g8f6', note: { say: 'x' } } })
    expect([page.said('chess'), page.$('#chess-note').textContent]).toEqual(['', ''])
    page.close()
  })

  test('every piece is drawn with the middle of what it paints on the middle of its square, and well inside it', async () => {
    const page = await opened()
    page.to('chess')
    /** The corners of an outline: the points it passes through, which for these figures are its furthest. */
    const corners = (d: string) => {
      let x = 0
      let y = 0
      const box = [Infinity, Infinity, -Infinity, -Infinity]
      for (const [, command, rest] of d.matchAll(/([MLQHVZ])([^MLQHVZ]*)/g)) {
        const n = (rest!.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
        if (command === 'H') x = n.at(-1)!
        else if (command === 'V') y = n.at(-1)!
        else if (command !== 'Z') [x, y] = n.slice(-2) as [number, number]
        if (command !== 'Z') {
          box[0] = Math.min(box[0]!, x)
          box[1] = Math.min(box[1]!, y)
          box[2] = Math.max(box[2]!, x)
          box[3] = Math.max(box[3]!, y)
        }
      }
      return box as [number, number, number, number]
    }
    const pieces = [...page.$('#chess-board').querySelectorAll('.sq .pc')]
    expect(pieces).toHaveLength(32)
    const kinds = new Set<string>()
    for (const el of pieces as any[]) {
      const shape = el.querySelector('path')
      const [, tx, ty, sx, sy] = /^translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+) ([-\d.]+)\)$/.exec(shape.getAttribute('transform'))!.map(Number)
      const [x0, y0, x1, y1] = corners(shape.getAttribute('d'))
      // The square is a hundred units a side, and an outline's heights go up where a square's go down
      const left = tx! + sx! * x0
      const right = tx! + sx! * x1
      const top = ty! + sy! * y1
      const bottom = ty! + sy! * y0
      expect(el.getAttribute('viewBox')).toBe('0 0 100 100')
      expect((left + right) / 2).toBeCloseTo(50, 5)
      expect((top + bottom) / 2).toBeCloseTo(50, 5)
      for (const gap of [left, top, 100 - right, 100 - bottom]) expect(gap).toBeGreaterThan(12)
      // And the pieces are of a size with one another
      expect(bottom - top).toBeGreaterThan(55)
      kinds.add(el.getAttribute('data-piece'))
    }
    expect([...kinds].sort().join('')).toBe('BKNPQRbknpqr')
    page.close()
  })
})

describe('the chessboard’s notes on the first page', () => {
  const moved = (page: Page, from: string, to: string) => {
    page.$(`[data-sq="${from}"]`).click()
    page.$(`[data-sq="${to}"]`).click()
    return page.sent.at(-1)!
  }

  test('a note that was in the state when the page opened is of an earlier game, and is not said', async () => {
    const page = await opened({}, (w) => {
      w.It.state = { ...w.It.state, chess: { reply: 'earlier:e7e5', note: 'From the game before.' } }
    })
    page.to('chess')
    expect(page.said('chess')).toBe('')
    const move = moved(page, 'e2', 'e4')
    await move.accept()
    expect(page.said('chess')).toBe('')
    page.close()
  })

  test('a note beside a reply to a game that was started again is not said over the new game, and one beside a move that may not be made is not said', async () => {
    const page = await opened()
    page.to('chess')
    const first = moved(page, 'e2', 'e4')
    await first.accept()
    page.$('#chess-new').click()
    await page.set({ chess: { reply: `${first.data.request}:e7e5`, note: 'Stale chess note.' } })
    expect(page.said('chess')).toBe('')
    const second = moved(page, 'd2', 'd4')
    await second.accept()
    await page.set({ chess: { reply: `${second.data.request}:d7d1`, note: 'About a move that is not one.' } })
    expect(page.said('chess')).not.toContain('About a move')
    await page.set({ chess: { reply: `${second.data.request}:d7d5`, note: 'Meeting you in the centre.' } })
    expect(page.said('chess')).toBe('Meeting you in the centre.')
    // A word more about the same move is said too
    await page.set({ chess: { note: 'The queen’s pawn game.' } })
    expect(page.said('chess')).toBe('The queen’s pawn game.')
    page.close()
  })

  test('a note that came with an answer heard before the move was known to have gone is said when the answer is played', async () => {
    const page = await opened()
    page.to('chess')
    const move = moved(page, 'e2', 'e4')
    await page.set({ chess: { reply: `${move.data.request}:e7e5`, note: 'The open game.' } })
    expect(page.said('chess')).toBe('')
    await move.accept()
    expect(page.said('chess')).toBe('The open game.')
    page.close()
  })
})
