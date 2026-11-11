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
  const piece = (page: Page, at: string) => page.$(`[data-sq="${at}"] .pc`)?.textContent ?? ''
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
    expect(other.state('chess')).toBe('It did not take that. Do it again.')
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
    expect(Object.keys(first.data)).toEqual(['part', 'request', 'move', 'said', 'good', 'check', 'over', 'fen', 'legal'])
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
    page.$('#new-game').click()
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
