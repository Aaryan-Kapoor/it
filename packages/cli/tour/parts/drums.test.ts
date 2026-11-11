// The drum machine of the tour’s first page, held to what the drum machine’s own page is held to in tour.test.ts.
import { describe, expect, test } from 'vitest'
import { opened, type Page, SLOW } from '../start-page'

describe('the drum machine on the first page', () => {
  /** One pad tapped: the drum, from the top, and the step. */
  const tapped = (page: Page, drum: number, step: number) => page.$(`.pad[data-r="${drum}"][data-c="${step}"]`).click()
  /** What was sent: each action's name, and the person's four drums in it. The bass is the row after them. */
  const told = (page: Page) => page.sent.map((s) => [s.name, s.data.pattern?.slice(0, 4).join('/')])
  const drums = async () => {
    const page = await opened({}, (w) => {
      w.requestAnimationFrame = () => 0
      w.cancelAnimationFrame = () => {}
    })
    page.to('drums')
    return page
  }
  const theirs = (page: Page, value: unknown, note?: string) => page.set({ drums: { theirs: value, ...(note === undefined ? {} : { note }) } })
  const playing = (page: Page) => page.$('#drums-play').getAttribute('data-on')
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

  test('a beat the person takes hits off goes again as it is left, and nothing is sent when the last hit is off, since nothing is asked', async () => {
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
    ])
    expect(page.read('drums').stage).toBe('idle')
    await page.advance(5000)
    expect(page.sent.length).toBe(2)
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
        if (edit === 'removing the last hit') {
          expect(page.sent).toHaveLength(1)
          await theirs(page, stale)
          expect(page.$('.pad.theirs')).toBeNull()
          expect(playing(page)).toBe('0')
          return
        }
        expect(page.sent).toHaveLength(2)
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
    } else page.$('#drums-clear').click()
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
    } else page.$('#drums-clear').click()
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
    expect(page.sent).toHaveLength(1)
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
    page.$('#drums-play').click()
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
    // What is asked and an answer that fits come first, then the person's bar, the agent's own part as it stands, and what the rows and the numbers are
    expect(Object.keys(beat.data)).toEqual(['part', 'request', 'ask', 'fits', 'pattern', 'yours', 'rows', 'steps', 'bpm', 'swing', 'scale'])
    expect(beat.data.ask).toBe('play between my hits')
    expect(beat.data.pattern).toEqual(['.x......', '........', '........', 'x...x...', '........'])
    expect(beat.data.yours).toEqual(['........', '........', '........', '........', '........'])
    expect([beat.data.rows, beat.data.steps, beat.data.bpm, beat.data.swing]).toEqual([['hat', 'clap', 'snare', 'kick', 'bass'], 8, 118, 0])
    // Hats between the beats where there is none, a clap on the second beat of each pair, and a kick into the next beat where theirs leaves room
    expect(beat.data.fits).toEqual({ pattern: ['...x.x.x', '..x...x.', '........', '.......'.padEnd(8, '.'), '........'] })
    expect(JSON.stringify(beat.data).length).toBeLessThan(2000)
    for (const [r, row] of (beat.data.fits.pattern as string[]).entries())
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
    // The agent sent no words, so none are said as its own: the page says in its own what came
    expect(plain.state('drums')).toContain('answered')
    expect(plain.said('drums')).toBe('')
    expect(plain.read('drums').hint).toBe('Claude Code added no hits.')
    plain.close()
  })
})

describe('more to make music with than four drums', () => {
  const drums = async () => {
    const page = await opened({}, (w) => {
      w.requestAnimationFrame = () => 0
      w.cancelAnimationFrame = () => {}
    })
    page.to('drums')
    return page
  }
  const tapped = (page: Page, drum: number, step: number) => page.$(`.pad[data-r="${drum}"][data-c="${step}"]`).click()
  const keyed = (page: Page, note: number, step: number) => page.$(`.drums-key[data-n="${note}"][data-c="${step}"]`).click()
  /** The pads and keys that match, each as its drum or its note and its step, in the order of the lanes. */
  const lit = (page: Page, selector: string) =>
    [...page.w.document.querySelectorAll(`[data-part="drums"] ${selector}`)]
      .map((b: any) => [b.getAttribute('data-r') ?? `n${b.getAttribute('data-n')}`, Number(b.getAttribute('data-c'))] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]))
      .map(([lane, step]) => `${lane}:${step}`)
  /** The agent answers the last thing sent, as `it tour answer` does: its answer beside the request. */
  const answered = (page: Page, answer: Record<string, unknown>) => page.set({ drums: { ...answer, request: page.sent.at(-1)!.data.request } })
  /** A beat of one kick, sent, taken by It and answered with a hat. */
  const begun = async () => {
    const page = await drums()
    tapped(page, 3, 0)
    await page.advance(1500)
    await page.sent[0]!.accept()
    await answered(page, { pattern: ['.x......', '........', '........', '........', '........'], note: 'A hat.' })
    return page
  }
  const asks = (page: Page) => [...page.w.document.querySelectorAll('.drums-ask')] as any[]
  const slid = (page: Page, id: string, to: number) => {
    const input = page.$(id)
    input.value = String(to)
    input.dispatchEvent(new page.w.Event('input', { bubbles: true }))
  }
  const shown = (page: Page) => [page.$('#drums-bpm').textContent, page.$('#drums-lilt').textContent]

  test('the bass is a lane of five notes: a tap puts the person’s note on a step, another key moves it, and it goes to the agent in the row after the drums', async () => {
    const page = await drums()
    keyed(page, 1, 0)
    keyed(page, 3, 4)
    keyed(page, 5, 4)
    keyed(page, 2, 6)
    keyed(page, 2, 6)
    await page.advance(1500)
    const beat = page.sentOf('beat')[0]!
    expect(beat.data.pattern).toEqual(['........', '........', '........', '........', '1...5...'])
    expect(lit(page, '.drums-key.mine')).toEqual(['n1:0', 'n5:4'])
    expect(page.you('drums')).toBe('put down 2 hits')
    expect(beat.data.scale).toBe('bass notes 1 to 5 are A C D E G, low to high')
    page.close()
  })

  test('the agent’s part may have a bassline in a fifth row, in notes of the scale: anything else in that row is a rest, and the person’s own notes stay theirs', async () => {
    const page = await drums()
    tapped(page, 3, 0)
    keyed(page, 3, 0)
    await page.advance(1500)
    await page.sent[0]!.accept()
    await answered(page, { pattern: ['........', '........', '........', '........', '319.x5-0'], note: 'A line.' })
    expect(lit(page, '.drums-key.theirs')).toEqual(['n1:1', 'n5:5'])
    expect(lit(page, '.drums-key.mine')).toEqual(['n3:0'])
    expect(page.$('#drums-play').getAttribute('data-on')).toBe('1')
    page.close()
  })

  test('a part whose rows are not as long as the loop, or that has too few or too many rows, is not taken, and the answer is an answer all the same', async () => {
    const wrong = [
      ['.x.....', '........', '........', '........'],
      ['.x......', '........', '........'],
      ['.x......', '........', '........', '........', '........', '........'],
      ['.x......', '........', '........', 7],
      'x',
      7,
      { 0: '.x......' },
    ]
    for (const pattern of wrong) {
      const page = await drums()
      tapped(page, 3, 0)
      await page.advance(1500)
      await page.sent[0]!.accept()
      await answered(page, { pattern, note: 'Wrong.' })
      expect(page.$('[data-part="drums"] .theirs'), JSON.stringify(pattern)).toBeNull()
      expect([page.read('drums').stage, page.said('drums')]).toEqual(['answered', 'Wrong.'])
      page.close()
    }
  })

  test('the agent never takes off a hit of the person’s: where both play a step it is the person’s, and it is still there after any answer', async () => {
    const page = await drums()
    tapped(page, 3, 0)
    tapped(page, 0, 2)
    await page.advance(1500)
    await page.sent[0]!.accept()
    await answered(page, { pattern: ['..x.x...', '........', '........', '........', '........'] })
    expect(lit(page, '.pad.mine')).toEqual(['0:2', '3:0'])
    expect(lit(page, '.pad.theirs')).toEqual(['0:4'])
    await answered(page, { pattern: [] })
    expect(lit(page, '.pad.mine')).toEqual(['0:2', '3:0'])
    expect(lit(page, '.pad.theirs')).toEqual([])
    page.close()
  })

  test('nothing can be asked until the person has put something down, and then every ask is one tap', async () => {
    const page = await drums()
    expect(asks(page).map((b) => [b.textContent, b.disabled])).toEqual([
      ['Bassline', true],
      ['Busier', true],
      ['Sparser', true],
      ['Swing it', true],
      ['Half time', true],
      ['Trade bars', true],
      ['Surprise me', true],
    ])
    tapped(page, 3, 0)
    expect(asks(page).every((b) => !b.disabled)).toBe(true)
    tapped(page, 3, 0)
    expect(asks(page).every((b) => b.disabled)).toBe(true)
    page.close()
  })

  test('an ask goes at once, as the same action, with the beat as it stands, the agent’s own part, and an answer that fits it', async () => {
    const page = await begun()
    page.$('[data-ask="bass"]').click()
    expect(page.sent).toHaveLength(2)
    const ask = page.sent[1]!
    expect([ask.name, ask.data.ask, page.you('drums')]).toEqual(['beat', 'add a bassline', 'asked for bass'])
    expect(ask.data.pattern).toEqual(['........', '........', '........', 'x.......', '........'])
    expect(ask.data.yours).toEqual(['.x......', '........', '........', '........', '........'])
    // The agent's drums as they are, and a line under the kick and on two steps more
    expect(ask.data.fits).toEqual({ pattern: ['.x......', '........', '........', '........', '1..1..5.'] })
    expect(page.$('[data-ask="bass"]').classList.contains('asked')).toBe(true)
    await ask.accept()
    await answered(page, { ...ask.data.fits, note: 'Under your kick.' })
    expect(lit(page, '.drums-key.theirs')).toEqual(['n1:0', 'n1:3', 'n5:6'])
    expect(page.$('[data-ask="bass"]').classList.contains('asked')).toBe(false)
    expect(page.said('drums')).toBe('Under your kick.')
    // The pause after a tap is not waited out as well: an ask that follows a tap takes the beat with it
    tapped(page, 2, 4)
    page.$('[data-ask="more"]').click()
    expect(page.sent).toHaveLength(3)
    await page.advance(5000)
    expect(page.sent).toHaveLength(3)
    expect(page.sent[2]!.data.pattern[2]).toBe('....x...')
    page.close()
  })

  test.each(['bass', 'more', 'less', 'swing', 'time', 'trade', 'wild'])(
    'what is offered for the ask "%s" is an answer the page takes: rows as long as the loop, notes of the scale, a tempo and a swing within bounds, and no hit on a step of the person’s',
    async (k) => {
      const page = await begun()
      tapped(page, 2, 2)
      keyed(page, 4, 6)
      await page.advance(1500)
      await page.sent.at(-1)!.accept()
      await answered(page, { pattern: ['.x.x.x.x', '......x.', '........', '...x....', '1..1....'] })
      const before = lit(page, '.theirs').length
      page.$(`[data-ask="${k}"]`).click()
      const ask = page.sent.at(-1)!
      const { fits, steps, pattern } = ask.data
      expect(steps).toBe(k === 'trade' ? 16 : 8)
      expect(fits.pattern).toHaveLength(5)
      for (const [r, row] of (fits.pattern as string[]).entries()) {
        expect(row, `${k} row ${r}`).toMatch(r < 4 ? new RegExp(`^[x.]{${steps}}$`) : new RegExp(`^[1-5.]{${steps}}$`))
        for (const [c, ch] of [...row].entries()) expect(ch !== '.' && ch === pattern[r][c], `${k} ${r}:${c}`).toBe(false)
      }
      if ('bpm' in fits) expect(fits.bpm >= 50 && fits.bpm <= 180 && Number.isInteger(fits.bpm)).toBe(true)
      if ('swing' in fits) expect(fits.swing >= 0 && fits.swing <= 60 && Number.isInteger(fits.swing)).toBe(true)
      const also: Record<string, string[]> = { swing: ['pattern', 'swing'], time: ['bpm', 'pattern'], wild: ['bpm', 'pattern', 'swing'] }
      expect(Object.keys(fits).sort()).toEqual(also[k] ?? ['pattern'])
      expect(JSON.stringify(ask.data).length).toBeLessThan(2000)
      // Taken as it is, it is drawn
      await ask.accept()
      await answered(page, fits)
      expect(page.read('drums').stage).toBe('answered')
      if (k === 'more' || k === 'trade') expect(lit(page, '.theirs').length).toBeGreaterThan(before)
      if (k === 'less') expect(lit(page, '.theirs').length).toBeLessThan(before)
      if (k === 'bass') expect(lit(page, '.drums-key.theirs')).toEqual(['n1:0', 'n1:3'])
      if (k === 'swing') expect(shown(page)).toEqual(['118', '33'])
      if (k === 'time') expect(shown(page)).toEqual(['59', '0'])
      if (k === 'wild') expect(shown(page)).toEqual([String(fits.bpm), String(fits.swing)])
      page.close()
    },
  )

  test('the agent sets the tempo and the swing in its answer, within what the faders reach, and anything else is left where it was', async () => {
    const page = await begun()
    expect(shown(page)).toEqual(['118', '0'])
    page.$('[data-ask="swing"]').click()
    await page.sent.at(-1)!.accept()
    await answered(page, { bpm: 96, swing: 30, note: 'Slower, and swung.' })
    expect(shown(page)).toEqual(['96', '30'])
    expect([page.$('#drums-tempo').value, page.$('#drums-swing').value]).toEqual(['96', '30'])
    // The fader shows whose hand set it
    expect([page.$('#drums-tempo-box').classList.contains('theirs'), page.$('#drums-swing-box').classList.contains('theirs')]).toEqual([true, true])
    // The part is as it was, since the answer is merged into what the state held
    expect(lit(page, '.pad.theirs')).toEqual(['0:1'])
    // The asks say what they would do now
    expect(
      asks(page)
        .map((b) => b.textContent)
        .slice(3, 5),
    ).toEqual(['Straighten', 'Half time'])
    const wrong = [
      { bpm: 49, swing: 61 },
      { bpm: 181, swing: -1 },
      { bpm: '120', swing: '10' },
      { bpm: null, swing: [20] },
      { bpm: true, swing: {} },
    ]
    for (const given of wrong) {
      page.$('[data-ask="more"]').click()
      await page.sent.at(-1)!.accept()
      await answered(page, given)
      expect(shown(page), JSON.stringify(given)).toEqual(['96', '30'])
      expect(page.read('drums').stage).toBe('answered')
    }
    page.close()
  })

  test('the person’s own hand on a fader is heard at once and sends nothing: the agent hears of it with the next thing asked, and an answer that leaves the tempo out does not put its earlier one back', async () => {
    const page = await begun()
    page.$('[data-ask="time"]').click()
    const half = page.sent.at(-1)!
    expect(half.data.fits.bpm).toBe(59)
    await half.accept()
    await answered(page, { ...half.data.fits, note: 'Half.' })
    expect(shown(page)[0]).toBe('59')
    expect(page.$('[data-ask="time"]').textContent).toBe('Double time')
    const sent = page.sent.length
    slid(page, '#drums-tempo', 124)
    slid(page, '#drums-swing', 20)
    await page.advance(5000)
    expect(page.sent).toHaveLength(sent)
    expect(shown(page)).toEqual(['124', '20'])
    expect(page.$('#drums-tempo-box').classList.contains('theirs')).toBe(false)
    // The state still holds the tempo of the earlier answer, since an answer is merged into what is there. It is not taken for one given now
    page.$('[data-ask="more"]').click()
    const more = page.sent.at(-1)!
    expect([more.data.bpm, more.data.swing]).toEqual([124, 20])
    await more.accept()
    await answered(page, { pattern: more.data.fits.pattern, note: 'More.' })
    expect(shown(page)).toEqual(['124', '20'])
    // Asked for half time again from where the first was asked, the agent answers with the tempo it gave before, which is the one it was offered: that one is given
    slid(page, '#drums-tempo', 118)
    page.$('[data-ask="time"]').click()
    const again = page.sent.at(-1)!
    expect(again.data.fits.bpm).toBe(59)
    await again.accept()
    await answered(page, again.data.fits)
    expect(shown(page)[0]).toBe('59')
    expect(page.$('#drums-tempo-box').classList.contains('theirs')).toBe(true)
    page.close()
  })

  test('trading bars: the loop goes to two bars only when the agent’s answer comes, with rows of sixteen steps, and the second bar is then the person’s to tap in as the first is', async () => {
    const page = await begun()
    const bars = () => page.$('#drums-box').getAttribute('data-bars')
    page.$('[data-ask="trade"]').click()
    const trade = page.sent.at(-1)!
    expect([trade.data.ask, trade.data.steps, bars()]).toEqual(['answer my bar with the next bar', 16, '1'])
    expect(trade.data.pattern).toEqual(['................', '................', '................', 'x...............', '................'])
    expect(trade.data.yours[0]).toBe('.x..............')
    // The agent's first bar as it is, and a second bar of what the two play in the first, with a fill at its end
    expect(trade.data.fits.pattern).toEqual(['.x.......x......', '................', '..............xx', '........x....x..', '................'])
    await trade.accept()
    // An answer of one bar is not an answer to a loop of two
    await answered(page, { pattern: ['.x......', '........', '........', '........', '........'] })
    expect(bars()).toBe('1')
    await answered(page, { ...trade.data.fits, note: 'Your bar, turned round.' })
    expect(bars()).toBe('2')
    expect(lit(page, '.pad.theirs')).toEqual(['0:1', '0:9', '2:14', '2:15', '3:8', '3:13'])
    expect(page.$('.pad[data-r="3"][data-c="8"]').getAttribute('aria-label')).toBe('Kick, step 1 of bar 2, Claude Code plays here')
    tapped(page, 1, 12)
    await page.advance(1500)
    const next = page.sent.at(-1)!
    expect([next.data.ask, next.data.steps, next.data.pattern[1]]).toEqual(['play between my hits', 16, '............x...'])
    for (const row of next.data.fits.pattern) expect(row).toHaveLength(16)
    // Clear is one bar again, at the tempo the machine begins with, and tells the agent nothing
    const sent = page.sent.length
    slid(page, '#drums-tempo', 90)
    page.$('#drums-clear').click()
    await page.advance(5000)
    expect([bars(), page.sent.length, shown(page).join(), page.$('[data-part="drums"] .on')]).toEqual(['1', sent, '118,0', null])
    page.close()
  })

  test('where one bar is shown at a time, a tab keeps its bar in view until it is tapped again, and a tap on a pad keeps the bar it is in until the beat has gone', async () => {
    const page = await begun()
    const viewed = () => [...page.w.document.querySelectorAll('.drums-bar')].map((b: any) => b.classList.contains('view'))
    const tabs = () => [...page.w.document.querySelectorAll('.drums-tab')].map((t: any) => [t.classList.contains('view'), t.classList.contains('held')])
    page.$('[data-ask="trade"]').click()
    const trade = page.sent.at(-1)!
    await trade.accept()
    await answered(page, trade.data.fits)
    expect(viewed()).toEqual([true, false])
    page.$('.drums-tab[data-bar="1"]').click()
    expect([viewed(), tabs()]).toEqual([
      [false, true],
      [
        [false, false],
        [true, true],
      ],
    ])
    // A tap in the bar that a tab keeps leaves it kept, through the sending of the beat
    tapped(page, 1, 12)
    await page.advance(1500)
    expect(tabs()[1]).toEqual([true, true])
    page.$('.drums-tab[data-bar="1"]').click()
    expect(tabs()[1]).toEqual([true, false])
    // A tap on a pad keeps its bar by itself, and lets it go as the beat is sent
    tapped(page, 1, 13)
    expect(tabs()[1]).toEqual([true, true])
    await page.advance(1500)
    expect(tabs()[1]).toEqual([true, false])
    page.close()
  })

  test('a second bar that was asked for does not come once the person has changed the beat', async () => {
    const page = await begun()
    page.$('[data-ask="trade"]').click()
    const trade = page.sent.at(-1)!
    await trade.accept()
    tapped(page, 2, 4)
    await page.set({ drums: { ...trade.data.fits, request: trade.data.request } })
    expect(page.$('#drums-box').getAttribute('data-bars')).toBe('1')
    expect(lit(page, '.pad.theirs')).toEqual(['0:1'])
    page.close()
  })

  test('an ask that is not answered in forty seconds is no longer shown as waiting, and its answer is drawn all the same when it comes', async () => {
    const page = await begun()
    page.$('[data-ask="bass"]').click()
    const ask = page.sent.at(-1)!
    await ask.accept()
    await page.advance(SLOW - 1)
    expect(page.$('[data-ask="bass"]').classList.contains('asked')).toBe(true)
    await page.advance(1)
    expect(page.state('drums')).toContain('No answer after 40 s')
    expect(page.$('[data-ask="bass"]').classList.contains('asked')).toBe(false)
    await answered(page, { ...ask.data.fits, note: 'Late.' })
    expect(lit(page, '.drums-key.theirs')).toEqual(['n1:0', 'n1:3', 'n5:6'])
    expect([page.read('drums').stage, page.said('drums')]).toEqual(['answered', 'Late.'])
    // One that It refused is not waited for at all
    page.$('[data-ask="more"]').click()
    await page.sent.at(-1)!.refuse()
    expect(page.$('[data-ask="more"]').classList.contains('asked')).toBe(false)
    expect(page.read('drums').stage).toBe('refused')
    page.close()
  })

  test('the agent’s words are put in as words, and where it sent none the page says in its own what came', async () => {
    const page = await begun()
    page.$('[data-ask="swing"]').click()
    await page.sent.at(-1)!.accept()
    await answered(page, { swing: 33, note: '<img src=x onerror=alert(1)><b>Swung.</b>' })
    expect(page.said('drums')).toBe('<img src=x onerror=alert(1)><b>Swung.</b>')
    expect(page.w.document.querySelector('.dock img, .dock .line b')).toBeNull()
    page.$('[data-ask="time"]').click()
    await page.sent.at(-1)!.accept()
    await answered(page, { pattern: ['.x.x....', '........', '........', '........', '........'], bpm: 59, note: '' })
    expect(page.said('drums')).toBe('')
    expect(page.read('drums').hint).toBe('Claude Code plays 2 hits between yours, and set the tempo to 59.')
    page.close()
  })

  test('the page sends one action and no other, so that nothing reaches the agent that it has nothing to answer', async () => {
    const page = await begun()
    keyed(page, 2, 3)
    await page.advance(1500)
    for (const k of ['bass', 'more', 'less', 'swing', 'time', 'trade', 'wild']) page.$(`[data-ask="${k}"]`).click()
    slid(page, '#drums-swing', 40)
    page.$('#drums-play').click()
    page.$('#drums-play').click()
    page.$('#drums-clear').click()
    tapped(page, 0, 0)
    tapped(page, 0, 0)
    await page.advance(5000)
    expect([...new Set(page.sent.map((s) => s.name))]).toEqual(['beat'])
    for (const s of page.sent) expect([s.data.part, typeof s.data.request, typeof s.data.ask]).toEqual(['drums', 'string', 'string'])
    page.close()
  })
})
