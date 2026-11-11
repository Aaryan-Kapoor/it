// The drum machine of the tour’s first page, held to what the drum machine’s own page is held to in tour.test.ts.
import { describe, expect, test } from 'vitest'
import { opened, type Page, SLOW } from '../start-page'

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
    expect(page.read('drums').stage).toBe('idle')
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
    page.$('#next').click()
    await theirs(page, { request: page.sent[0]!.data.request, pattern: ['x.......', '........', '........', '........'] })
    expect(playing(page)).toBe('0')
    expect(page.$('.pad[data-r="0"][data-c="0"]').classList.contains('theirs')).toBe(true)
    page.$('#back').click()
    page.$('#play').click()
    expect(playing(page)).toBe('1')
    page.$('#back').click()
    expect(playing(page)).toBe('0')
    page.close()
  })

  test('a beat goes with hits that fit it, on steps the person left empty, for the agent to take or to change', async () => {
    const page = await drums()
    tapped(page, 3, 0)
    tapped(page, 3, 4)
    tapped(page, 0, 1)
    await page.advance(1500)
    const beat = page.sentOf('beat')[0]!
    expect(Object.keys(beat.data)).toEqual(['part', 'request', 'pattern', 'fits', 'rows', 'bpm'])
    expect(beat.data.pattern).toEqual(['.x......', '........', '........', 'x...x...'])
    // Hats between the beats where there is none, a clap on the second beat of each pair, and a kick into the next beat where theirs leaves room
    expect(beat.data.fits).toEqual(['...x.x.x', '..x...x.', '........', '.......'.padEnd(8, '.')])
    for (const [r, row] of (beat.data.fits as string[]).entries())
      for (const [c, ch] of [...row].entries()) expect(ch === 'x' && beat.data.pattern[r][c] === 'x', `${r}:${c}`).toBe(false)
    page.close()
  })

  test('the agent’s hits are also taken as `pattern` beside the `request` they answer, which is what `it tour answer` writes', async () => {
    const page = await drums()
    tapped(page, 3, 0)
    await page.advance(1500)
    const beat = page.sentOf('beat')[0]!
    await beat.accept()
    await page.set({ drums: { request: beat.data.request, pattern: ['.x.x.x.x', '........', '........', '........'], note: 'Hats between.' } })
    expect(page.$('.pad[data-r="0"][data-c="1"]').classList.contains('theirs')).toBe(true)
    expect([page.read('drums').stage, noted(page)]).toEqual(['answered', 'Hats between.'])
    // One for an earlier beat is left alone
    tapped(page, 3, 4)
    await page.advance(1500)
    await page.sentOf('beat')[1]!.accept()
    await page.set({ drums: { request: beat.data.request, pattern: ['x.......', '........', '........', '........'], note: 'Old.' } })
    expect(page.read('drums').stage).toBe('took')
    page.close()
  })
})

describe('a drum answer with no hits in it', () => {
  test('is an answer: the wait is over, and its note is said', async () => {
    const page = await opened({}, (w) => {
      w.requestAnimationFrame = () => 0
      w.cancelAnimationFrame = () => {}
    })
    page.to('drums')
    page.$('.pad[data-r="3"][data-c="0"]').click()
    await page.advance(1500)
    const beat = page.sentOf('beat')[0]!
    await beat.accept()
    expect(page.state('drums')).toContain('It has it. Waiting for Claude Code')
    await page.set({
      drums: { theirs: { request: beat.data.request, pattern: ['........', '........', '........', '........'], note: 'Yours stands on its own.' } },
    })
    expect(page.state('drums')).toContain('answered')
    expect(page.state('drums')).not.toContain('No answer after')
    expect(page.said('drums')).toBe('Yours stands on its own.')
    await page.advance(SLOW)
    expect(page.state('drums')).not.toContain('No answer after')
    page.close()
    const plain = await opened({}, (w) => {
      w.requestAnimationFrame = () => 0
      w.cancelAnimationFrame = () => {}
    })
    plain.to('drums')
    plain.$('.pad[data-r="3"][data-c="0"]').click()
    await plain.advance(1500)
    const sent = plain.sentOf('beat')[0]!
    await sent.accept()
    await plain.set({ drums: { theirs: { request: sent.data.request, pattern: [] } } })
    expect(plain.said('drums')).toBe('added no hits')
    plain.close()
  })
})
