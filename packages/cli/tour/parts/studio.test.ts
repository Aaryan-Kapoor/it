// The studio of the tour’s first page: what a colour and a pointed finger tell the agent, how its design and its changes are drawn, and what of an answer is not used.
import { describe, expect, test } from 'vitest'
import { GUIDE, tourPage } from '../../src/tour'
import { opened, type Page, pointer, SLOW } from '../start-page'

const HEX = /^#[0-9a-f]{6}$/
/** How far two colours stand apart, as the contrast between them. */
const apart = (a: string, b: string) => {
  const light = (c: string) =>
    [1, 3, 5].reduce((sum, i, n) => {
      const v = Number.parseInt(c.slice(i, i + 2), 16) / 255
      return sum + [0.2126, 0.7152, 0.0722][n]! * (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    }, 0)
  const [x, y] = [light(a), light(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
/**
 * One drag on the colour wheel, let go so many degrees round from the top and so far out from the
 * middle. The stand-in lays the wheel out 720 by 520, so its middle is at 360, 260 and its rim 260 out.
 */
const dragged = (page: Page, degrees: number, out: number) => {
  const wheel = page.$('#studio-wheel')
  const a = (degrees * Math.PI) / 180
  const [x, y] = [360 + Math.sin(a) * 260 * out, 260 - Math.cos(a) * 260 * out]
  pointer(page, wheel, 'pointerdown', 360, 260)
  pointer(page, wheel, 'pointermove', x, y)
  pointer(page, wheel, 'pointerup', x, y)
  return page.sentOf('design').at(-1)!
}
const art = (page: Page) => page.$('#studio-art')
const piece = (page: Page, name: string) => page.$(`[data-piece="${name}"]`)
const words = (page: Page, name: string) => piece(page, name).querySelector('.studio-words').textContent as string
const colour = (page: Page, role: string) => art(page).style.getPropertyValue(`--s-${role}`) as string
/** The design as the page shows it: its typeface, shape and picture. */
const made = (page: Page) => ['data-type', 'data-shape', 'data-picture'].map((k) => art(page).getAttribute(k))
const waits = (page: Page) => page.section('studio').getAttribute('data-wait') === '1'
/** The words offered for the piece that was pointed at. */
const offered = (page: Page) => [...page.w.document.querySelectorAll('#studio-ask button')].map((b: any) => b.textContent as string)
/** Points at a piece and picks one of its words, and gives what went to the agent. */
const wished = (page: Page, name: string, word: string) => {
  piece(page, name).click()
  ;([...page.w.document.querySelectorAll('#studio-ask button')] as any[]).find((b) => b.textContent === word).click()
  return page.sentOf('point').at(-1)!
}
/** The studio with a design in it: a colour picked, and answered. */
const designed = async (page: Page, answer: Record<string, unknown> = {}) => {
  const asked = dragged(page, 30, 0.9)
  await asked.accept()
  await page.set({
    studio: {
      request: asked.data.request,
      ...asked.data.pick,
      headline: 'Three loud days by the sea',
      line: 'Brass, bonfires and cold swims.',
      say: 'Loud.',
      ...answer,
    },
  })
  return asked
}
const DRAFT = 'A small festival by the sea'

describe('the studio', () => {
  test('a drag on the colour wheel goes to the agent as the colour, the palettes it gives and a design already picked from what is listed, and nothing on the page changes until the answer', async () => {
    const page = await opened()
    page.to('studio')
    expect(page.$('#title').textContent).toBe('A studio')
    expect([art(page).getAttribute('data-skin'), words(page, 'headline')]).toEqual(['draft', DRAFT])
    const asked = dragged(page, 90, 0.9)
    expect(Object.keys(asked.data)).toEqual([
      'part',
      'request',
      'colour_is',
      'colour',
      'mood',
      'for',
      'pick',
      'most',
      'palettes',
      'palette_is',
      'type',
      'shape',
      'picture',
      'now',
    ])
    expect(asked.data).toMatchObject({ part: 'studio', colour_is: 'a vivid lime', mood: null, most: { headline: 40, line: 90 }, now: { headline: DRAFT } })
    expect(asked.data.request).toMatch(/^[0-9a-f]{32}$/)
    expect(asked.data.colour).toMatch(HEX)
    expect(asked.data.for).toContain('a small festival by the sea')
    // Five palettes, each a paper, an ink, an accent and a second colour, with a few words of what it looks like
    expect(Object.keys(asked.data.palettes)).toEqual(['paper', 'tint', 'flood', 'night', 'duo'])
    expect(Object.keys(asked.data.palette_is)).toEqual(Object.keys(asked.data.palettes))
    for (const colours of Object.values<string[]>(asked.data.palettes)) {
      expect(colours).toHaveLength(4)
      for (const c of colours) expect(c).toMatch(HEX)
    }
    // What the page picked is from what it lists, so an agent in a hurry has only the words to write
    const { pick } = asked.data
    expect(Object.keys(asked.data.palettes)).toContain(pick.palette)
    expect(Object.keys(asked.data.type)).toContain(pick.type)
    expect(asked.data.shape).toContain(pick.shape)
    expect(asked.data.picture).toContain(pick.picture)
    // All of it is in what an agent is shown of an action when it arrives
    expect(JSON.stringify(asked.data).length).toBeLessThan(2000)
    // The page is still the draft, with a dab of the colour on its edge, and the wheel is not the person's until the agent has answered
    expect(page.$('#studio-wash').style.background).not.toBe('')
    expect(page.$('#studio-wash').style.clipPath).toMatch(/^circle\(2\.1em at /)
    expect([art(page).getAttribute('data-skin'), words(page, 'headline'), waits(page)]).toEqual(['draft', DRAFT, true])
    expect(page.you('studio')).toBe('picked a colour')
    expect(page.state('studio')).toBe('Sending what you did to It')
    expect(page.said('studio')).toBe('')
    page.close()
  })

  test('a mood is a gesture of its own, sent with the colour that is on the wheel, and the design that is picked goes with it', async () => {
    const picks: Record<string, unknown> = {}
    for (const mood of ['calm', 'bold', 'playful', 'elegant']) {
      const page = await opened()
      page.to('studio')
      page.$(`[data-mood="${mood}"]`).click()
      const asked = page.sentOf('design').at(-1)!
      expect([asked.data.mood, page.you('studio')]).toEqual([mood, 'chose a mood'])
      expect(page.$(`[data-mood="${mood}"]`).getAttribute('aria-pressed')).toBe('true')
      expect(JSON.stringify(asked.data).length).toBeLessThan(2000)
      picks[mood] = asked.data.pick
      // The mood stays with the next colour
      await asked.accept()
      await page.answer('studio', { request: asked.data.request, say: 'There.' })
      expect(dragged(page, 200, 0.5).data).toMatchObject({ mood, colour_is: 'a soft sky blue' })
      page.close()
    }
    // No two moods are given the same design
    expect(new Set(Object.values(picks).map((p) => JSON.stringify(p))).size).toBe(4)
  })

  test('the agent’s design is drawn: the palette it named in the colours the page worked out, its typeface, shape and picture, and its own words', async () => {
    const page = await opened()
    page.to('studio')
    const asked = dragged(page, 240, 0.9)
    await asked.accept()
    expect(page.state('studio')).toBe('It has it. Waiting for Claude Code 1 s')
    await page.set({
      studio: {
        request: asked.data.request,
        palette: 'night',
        type: 'serif',
        shape: 'round',
        picture: 'boats',
        headline: 'The tide goes out. The music stays.',
        line: 'Three slow evenings of brass and oysters.',
        say: 'Your blue became the night sky.',
      },
    })
    const night = asked.data.palettes.night as string[]
    expect([art(page).getAttribute('data-skin'), ...made(page)]).toEqual(['made', 'serif', 'round', 'boats'])
    expect([colour(page, 'paper'), colour(page, 'ink'), colour(page, 'ground')]).toEqual([night[0], night[1], night[0]])
    expect([words(page, 'headline'), words(page, 'line')]).toEqual(['The tide goes out. The music stays.', 'Three slow evenings of brass and oysters.'])
    // The pieces the agent was not asked for keep the page's words
    expect([words(page, 'name'), words(page, 'button')]).toEqual(['Low Tide', 'Get tickets'])
    expect(page.said('studio')).toBe('Your blue became the night sky.')
    expect(page.state('studio')).toMatch(/^Claude Code answered in \d+\.\d s$/)
    // What the design is made of is listed on the bench, under the agent's name
    expect([page.$('#studio-palette').textContent, page.$('#studio-type').textContent, page.$('#studio-shape').textContent]).toEqual([
      'night',
      'serif',
      'round',
    ])
    expect([page.$('#studio-by').hidden, page.$('#studio-by-who').textContent]).toEqual([false, 'Claude Code'])
    // And the studio is the person's again, with the next thing to do said in the one line
    expect(waits(page)).toBe(false)
    expect(page.$('#line').textContent).toBe('Tap any piece of the page and say what is wrong with it. Claude Code changes just that.')
    page.close()
  })

  test('what an answer names is used only where it is one of what the page listed: the design the page picked stands in for anything else, and the words stay the page’s own where the answer has none', async () => {
    for (const wrong of [
      { palette: 'neon', type: 'comic', shape: 'blob', picture: 'cats' },
      { palette: 7, type: ['serif'], shape: { soft: true }, picture: null },
      { palette: 'constructor', type: 'toString', shape: 'length', picture: '__proto__' },
      {},
    ]) {
      const page = await opened()
      page.to('studio')
      const asked = dragged(page, 0, 0.9)
      await asked.accept()
      await page.answer('studio', { request: asked.data.request, ...wrong, headline: ['no'], line: { no: 1 }, say: 'There.' })
      const { pick } = asked.data
      expect(made(page), JSON.stringify(wrong)).toEqual([pick.type, pick.shape, pick.picture])
      expect(colour(page, 'paper')).toBe(asked.data.palettes[pick.palette][0])
      expect(page.$('#studio-palette').textContent).toBe(pick.palette)
      expect([words(page, 'headline'), page.said('studio')]).toEqual([DRAFT, 'There.'])
      expect(page.errors).toEqual([])
      page.close()
    }
  })

  test('the agent’s words go in as text and never as markup, on one line, and no longer than the piece has room for', async () => {
    const page = await opened()
    page.to('studio')
    await designed(page, { headline: '<img src=x onerror=alert(1)><b>Hi</b>', line: `One\n  line ${'and more '.repeat(20)}` })
    expect(words(page, 'headline')).toBe('<img src=x onerror=alert(1)><b>Hi</b>')
    expect(art(page).querySelector('img, b')).toBeNull()
    expect(words(page, 'line')).toHaveLength(90)
    expect(words(page, 'line').startsWith('One line and more')).toBe(true)
    await designed(page, { headline: 'A headline that goes on for a good deal longer than forty letters' })
    expect(words(page, 'headline')).toBe('A headline that goes on for a good deal ')
    page.close()
  })

  test('colours of the agent’s own are taken only where each is a colour and the ink can be read on the paper', async () => {
    const page = await opened()
    page.to('studio')
    await designed(page, { palette: ['#fdf6e3', '#073642', '#d33682'] })
    expect([colour(page, 'paper'), colour(page, 'ink'), page.$('#studio-palette').textContent]).toEqual(['#fdf6e3', '#073642', 'its own'])
    // The accent is the agent's, moved only as far as it takes for what is written on it to be read, and a second colour is found for a palette that has none
    expect(apart(colour(page, 'accent'), '#d33682')).toBeLessThan(1.1)
    expect(apart(colour(page, 'on'), colour(page, 'accent'))).toBeGreaterThanOrEqual(4.5)
    expect(colour(page, 'second')).toMatch(HEX)
    // One that needs nothing moved is taken as it is
    await designed(page, { palette: ['#101418', '#f2efe6', '#ffd84a', '#7fd1c7'] })
    expect([colour(page, 'paper'), colour(page, 'ink'), colour(page, 'accent'), colour(page, 'second')]).toEqual(['#101418', '#f2efe6', '#ffd84a', '#7fd1c7'])
    for (const palette of [
      // An ink that cannot be read on its paper, an accent that cannot be seen on it, colours that are not colours, too few and too many
      ['#fdf6e3', '#f0e9d6', '#d33682'],
      ['#ffffff', '#000000', '#fefefe'],
      ['red', '#000000', '#ffffff'],
      ['#fdf6e3', '#073642', 'url(https://example.com/x)'],
      ['#ffffff', '#000000'],
      ['#ffffff', '#000000', '#ff0000', '#00ff00', '#0000ff'],
      [1, 2, 3],
    ]) {
      const asked = await designed(page, { palette })
      expect(colour(page, 'paper'), JSON.stringify(palette)).toBe(asked.data.palettes[asked.data.pick.palette][0])
      expect(page.$('#studio-palette').textContent).toBe(asked.data.pick.palette)
    }
    expect(page.errors).toEqual([])
    page.close()
  })

  test('every palette the wheel can give has an ink that is read on its paper, and whatever is written on its accent and its second colour can be read', async () => {
    const page = await opened()
    page.to('studio')
    let n = 0
    for (let degrees = 0; degrees < 360; degrees += 15)
      for (const out of [0.05, 0.3, 0.6, 0.96]) {
        const asked = dragged(page, degrees, out)
        const names = Object.keys(asked.data.palettes)
        for (const name of names) {
          const [paper, ink, accent] = asked.data.palettes[name] as string[]
          expect(apart(ink!, paper!), `${name} at ${degrees}, ${out}`).toBeGreaterThanOrEqual(6)
          expect(apart(accent!, paper!), `${name} at ${degrees}, ${out}`).toBeGreaterThanOrEqual(2.5)
        }
        // Each is drawn in its turn, and the page's own colours for it are held to the same
        const name = names[n++ % names.length]!
        await asked.accept()
        await page.answer('studio', { request: asked.data.request, palette: name, say: 'x' })
        for (const role of ['paper', 'ink', 'accent', 'on', 'second', 'on2', 'tint', 'loud', 'shade', 'deep', 'dusk', 'pale'])
          expect(colour(page, role), role).toMatch(HEX)
        expect(apart(colour(page, 'on'), colour(page, 'accent')), `${name} at ${degrees}, ${out}`).toBeGreaterThanOrEqual(4.5)
        expect(apart(colour(page, 'on2'), colour(page, 'second')), `${name} at ${degrees}, ${out}`).toBeGreaterThanOrEqual(4.5)
        expect(apart(colour(page, 'loud'), colour(page, 'paper')), `${name} at ${degrees}, ${out}`).toBeGreaterThanOrEqual(3)
      }
    expect(page.errors).toEqual([])
    page.close()
  })

  test('a tap on a piece offers four words for what is wrong with it, and the one chosen goes to the agent with the piece, the change already worked out and the rest of the page', async () => {
    const page = await opened()
    page.to('studio')
    await designed(page)
    piece(page, 'headline').click()
    expect(page.$('#studio-ask').hidden).toBe(false)
    expect(offered(page)).toEqual(['Bigger', 'Calmer', 'Say it differently', 'Lose it'])
    expect([piece(page, 'headline').classList.contains('studio-on'), piece(page, 'headline').getAttribute('data-tag')]).toEqual([true, 'headline'])
    // Pointing sends nothing by itself, and pointing at the same piece again puts the words away
    expect(page.sentOf('point')).toEqual([])
    piece(page, 'headline').click()
    expect([page.$('#studio-ask').hidden, piece(page, 'headline').classList.contains('studio-on')]).toEqual([true, false])
    piece(page, 'picture').click()
    expect(offered(page)).toEqual(['Bigger', 'Calmer', 'Draw it differently', 'Lose it'])
    const asked = wished(page, 'headline', 'Bigger')
    expect(Object.keys(asked.data).slice(0, 5)).toEqual(['part', 'request', 'piece', 'wish', 'try'])
    expect(asked.data).toMatchObject({ part: 'studio', piece: 'headline', wish: 'bigger', try: { size: 3 }, size: 2, sizes: [1, 2, 3, 4], mood: null })
    expect(asked.data.page).toEqual({
      name: 'Low Tide',
      headline: 'Three loud days by the sea',
      line: 'Brass, bonfires and cold swims.',
      button: 'Get tickets',
      date: '14–16 August, Saltwick Bay',
      acts: 'Brass bands · Oysters at dusk · Dawn swims',
    })
    expect(JSON.stringify(asked.data).length).toBeLessThan(2000)
    // The words are put away, the piece keeps its line with what was asked of it, and nothing has changed yet
    expect([page.$('#studio-ask').hidden, waits(page), page.you('studio')]).toEqual([true, true, 'wanted it bigger'])
    expect([
      piece(page, 'headline').classList.contains('studio-asked'),
      piece(page, 'headline').getAttribute('data-tag'),
      piece(page, 'headline').getAttribute('data-size'),
    ]).toEqual([true, 'headline · bigger', '2'])
    await asked.accept()
    await page.answer('studio', { request: asked.data.request, size: 4, say: 'As big as it goes.' })
    expect([piece(page, 'headline').getAttribute('data-size'), page.said('studio'), waits(page)]).toEqual(['4', 'As big as it goes.', false])
    // It is that piece alone, and it says who changed it
    for (const other of ['name', 'line', 'button', 'date', 'acts', 'picture']) expect(piece(page, other).getAttribute('data-size'), other).toBe('2')
    expect([piece(page, 'headline').classList.contains('studio-by'), piece(page, 'headline').getAttribute('data-tag')]).toEqual([true, 'claude code'])
    // A piece that is as big as it goes is offered the way back
    piece(page, 'headline').click()
    expect(offered(page)[0]).toBe('Smaller')
    page.close()
  })

  test('each word asks for one kind of change, worked out from where the piece stands, and the answer changes that and nothing else', async () => {
    const page = await opened()
    page.to('studio')
    await designed(page, { picture: 'sun' })
    const answer = async (name: string, word: string, given: Record<string, unknown>) => {
      const asked = wished(page, name, word)
      await asked.accept()
      await page.answer('studio', { request: asked.data.request, say: 'Done.', ...given })
      return asked
    }
    // Calmer, and then louder once it is as calm as it goes
    expect((await answer('button', 'Calmer', { tone: 'quiet' })).data).toMatchObject({
      wish: 'calmer',
      try: { tone: 'quiet' },
      tone: 'plain',
      tones: ['quiet', 'plain', 'loud'],
    })
    expect(piece(page, 'button').getAttribute('data-tone')).toBe('quiet')
    piece(page, 'button').click()
    expect(offered(page)[1]).toBe('Louder')
    piece(page, 'button').click()
    // Another picture, from the pictures the page has
    expect((await answer('picture', 'Draw it differently', { picture: 'night' })).data).toMatchObject({
      try: { picture: 'boats' },
      picture: 'sun',
      pictures: ['sun', 'boats', 'night', 'flags'],
    })
    expect(art(page).getAttribute('data-picture')).toBe('night')
    // Other words, which are the agent's, with how many letters there is room for
    const reword = await answer('date', 'Say it differently', { text: 'Mid-August, on the bay' })
    expect(reword.data).toMatchObject({ wish: 'say it differently', text: '14–16 August, Saltwick Bay', most: 28 })
    expect(reword.data.try.text).toContain('28')
    expect(words(page, 'date')).toBe('Mid-August, on the bay')
    // Gone, and the page says which pieces it is without
    expect((await answer('acts', 'Lose it', { show: false })).data.try).toEqual({ show: false })
    expect([piece(page, 'acts').hidden, art(page).getAttribute('data-lost')]).toEqual([true, 'acts'])
    // A piece that is gone is not in what the agent is told of the page
    expect(Object.keys((await answer('line', 'Bigger', { size: 3 })).data.page)).toEqual(['name', 'headline', 'line', 'button', 'date'])
    // Each change was to its own piece: the typeface, the shape and every other piece are as the design left them
    expect(made(page)).toEqual(['poster', 'sharp', 'night'])
    expect(
      ['name', 'headline', 'line', 'button', 'date', 'picture'].map(
        (n) => `${piece(page, n).getAttribute('data-size')} ${piece(page, n).getAttribute('data-tone')}`,
      ),
    ).toEqual(['2 plain', '2 plain', '3 plain', '2 quiet', '2 plain', '2 plain'])
    // A new design is the whole page again
    await designed(page)
    expect([piece(page, 'acts').hidden, art(page).getAttribute('data-lost'), piece(page, 'button').getAttribute('data-tone'), words(page, 'date')]).toEqual([
      false,
      '',
      'plain',
      'Mid-August, on the bay',
    ])
    expect(page.errors).toEqual([])
    page.close()
  })

  test('a change the answer does not give, or gives as something the page does not have, is made as the page worked it out, and a piece is given no words but the agent’s', async () => {
    const page = await opened()
    page.to('studio')
    await designed(page, { picture: 'flags' })
    const answer = async (name: string, word: string, given: Record<string, unknown>) => {
      const asked = wished(page, name, word)
      await asked.accept()
      await page.answer('studio', { request: asked.data.request, say: 'Done.', ...given })
    }
    // A size that is none of the page's steps, or the size the piece has already, is the next step up
    for (const [name, size] of Object.entries({ name: 9, headline: 2.5, line: '4', acts: null, date: 2 })) {
      await answer(name, 'Bigger', { size })
      expect(piece(page, name).getAttribute('data-size'), name).toBe('3')
    }
    await answer('line', 'Calmer', { tone: 'whisper' })
    expect(piece(page, 'line').getAttribute('data-tone')).toBe('quiet')
    // The picture it shows already is no other picture
    await answer('picture', 'Draw it differently', { picture: 'flags' })
    expect(art(page).getAttribute('data-picture')).toBe('sun')
    // The agent may say that a piece stays, and it stays
    await answer('date', 'Lose it', { show: true })
    expect(piece(page, 'date').hidden).toBe(false)
    await answer('date', 'Lose it', { show: 'no' })
    expect(piece(page, 'date').hidden).toBe(true)
    // Words as markup are text, and words that are no words leave the piece as it was
    await answer('button', 'Say it differently', { text: '<i>Come</i>' })
    expect([words(page, 'button'), piece(page, 'button').querySelector('i')]).toEqual(['<i>Come</i>', null])
    await answer('button', 'Say it differently', { text: { no: 1 } })
    expect(words(page, 'button')).toBe('<i>Come</i>')
    // An answer is merged into the one before it. Words left there from an earlier answer are not this answer's words, and are written on nothing
    await answer('headline', 'Say it differently', { text: 'Come loud. Leave salty.' })
    expect(words(page, 'headline')).toBe('Come loud. Leave salty.')
    await answer('line', 'Bigger', { size: 3 })
    expect(words(page, 'line')).toBe('Brass, bonfires and cold swims.')
    await answer('line', 'Say it differently', {})
    expect(words(page, 'line')).toBe('Brass, bonfires and cold swims.')
    expect(page.errors).toEqual([])
    page.close()
  })

  test('an answer is held to what it was asked: one to an earlier request is left alone, one heard before It took the request is drawn once it has, and each is drawn once', async () => {
    const page = await opened()
    page.to('studio')
    const first = dragged(page, 30, 0.9)
    await first.accept()
    // Nothing came for a while: the studio is the person's again, with nothing of the agent's drawn
    await page.advance(SLOW)
    expect(page.state('studio')).toContain('No answer after 40 s')
    expect([waits(page), art(page).getAttribute('data-skin')]).toEqual([false, 'draft'])
    expect(page.$('#studio-wash').style.clipPath).toMatch(/^circle\(0% at /)
    const second = dragged(page, 210, 0.9)
    await page.answer('studio', { request: first.data.request, palette: 'night', headline: 'Late.', say: 'Late.' })
    expect([art(page).getAttribute('data-skin'), words(page, 'headline'), page.said('studio')]).toEqual(['draft', DRAFT, ''])
    // The answer to this one comes before the page hears that It took it
    await page.answer('studio', { request: second.data.request, palette: 'tint', headline: 'In time.', say: 'In time.' })
    expect(art(page).getAttribute('data-skin')).toBe('draft')
    await second.accept()
    expect([words(page, 'headline'), page.said('studio'), colour(page, 'paper')]).toEqual(['In time.', 'In time.', second.data.palettes.tint[0]])
    // And it is drawn once only
    await page.answer('studio', { request: second.data.request, palette: 'night', headline: 'Again.', say: 'Again.' })
    expect([words(page, 'headline'), colour(page, 'paper')]).toEqual(['In time.', second.data.palettes.tint[0]])
    page.close()
  })

  test('a late answer is still drawn where the person has done nothing since, and is not once they have taken hold of the wheel again', async () => {
    const page = await opened()
    page.to('studio')
    await designed(page)
    const asked = wished(page, 'headline', 'Bigger')
    await asked.accept()
    await page.advance(SLOW)
    expect([waits(page), piece(page, 'headline').classList.contains('studio-asked')]).toEqual([false, false])
    await page.advance(5000)
    await page.answer('studio', { request: asked.data.request, size: 4, say: 'Late, and here.' })
    expect([piece(page, 'headline').getAttribute('data-size'), page.said('studio')]).toEqual(['4', 'Late, and here.'])
    expect(page.state('studio')).toBe('Claude Code answered in 45.0 s')
    // The same, but the person is choosing another colour when it comes
    const slow = wished(page, 'line', 'Bigger')
    await slow.accept()
    await page.advance(SLOW)
    pointer(page, page.$('#studio-wheel'), 'pointerdown', 400, 100)
    await page.answer('studio', { request: slow.data.request, size: 4, say: 'Too late.' })
    expect([piece(page, 'line').getAttribute('data-size'), page.said('studio')]).toEqual(['2', 'Late, and here.'])
    page.close()
  })

  test('what It refused is the person’s to do again at once, and an answer to it is never drawn', async () => {
    const page = await opened()
    page.to('studio')
    const asked = dragged(page, 30, 0.9)
    await asked.refuse()
    expect(page.state('studio')).toBe('It did not take that. Do it again.')
    expect(waits(page)).toBe(false)
    await page.answer('studio', { request: asked.data.request, palette: 'night', headline: 'No.', say: 'No.' })
    expect([art(page).getAttribute('data-skin'), words(page, 'headline'), page.said('studio')]).toEqual(['draft', DRAFT, ''])
    expect(dragged(page, 40, 0.9).data.request).not.toBe(asked.data.request)
    page.close()
  })

  test('while the agent has what was asked, the wheel, the moods and the pieces do nothing more', async () => {
    const page = await opened()
    page.to('studio')
    const asked = dragged(page, 30, 0.9)
    dragged(page, 200, 0.5)
    page.$('[data-mood="bold"]').click()
    piece(page, 'headline').click()
    expect(page.sent).toHaveLength(1)
    expect([page.$('#studio-ask').hidden, page.$('[data-mood="bold"]').disabled]).toEqual([true, true])
    await asked.accept()
    await page.answer('studio', { request: asked.data.request, say: 'There.' })
    expect(page.$('[data-mood="bold"]').disabled).toBe(false)
    page.close()
  })

  test('the design dresses the frame of the tour in its colour, on every part, and the tour’s own colours are one press away', async () => {
    const page = await opened()
    page.to('studio')
    const root = page.w.document.documentElement
    const worn = () => ['--green', '--on-green', '--green-soft', '--paper', '--card', '--line'].map((k) => root.style.getPropertyValue(k) as string)
    expect(worn().join('')).toBe('')
    expect(page.$('#studio-own').hidden).toBe(true)
    await designed(page)
    for (const c of worn()) expect(c).toMatch(HEX)
    // What the frame writes on its accent and on its paper can still be read
    const [green, onGreen, , paper, card] = worn()
    expect(apart(onGreen!, green!)).toBeGreaterThanOrEqual(4.5)
    expect(apart('#1c1a16', paper!)).toBeGreaterThanOrEqual(7)
    expect(apart(green!, card!)).toBeGreaterThanOrEqual(3)
    expect([page.$('#studio-own').hidden, page.$('#studio-own').textContent]).toEqual([false, 'Tour’s own colours'])
    // It is worn on the other parts too
    page.to('chess')
    expect(worn()[0]).toBe(green)
    page.w.Shell.go('studio')
    page.$('#studio-own').click()
    expect([worn().join(''), page.$('#studio-own').textContent]).toEqual(['', 'Wear the design'])
    page.$('#studio-own').click()
    expect(worn()[0]).toBe(green)
    // Starting again gives the tour its own colours back with everything else, and sends nothing
    const sent = page.sent.length
    page.$('#studio-again').click()
    expect([worn().join(''), page.$('#studio-own').hidden, art(page).getAttribute('data-skin'), words(page, 'headline'), colour(page, 'paper')]).toEqual([
      '',
      true,
      'draft',
      DRAFT,
      '',
    ])
    expect([page.read('studio').stage, page.said('studio'), page.sent.length]).toEqual(['idle', '', sent])
    expect(page.$('#line').textContent).toBe(page.section('studio').getAttribute('data-line').replace('{agent}', 'Claude Code'))
    page.close()
  })

  test('starting again in the middle of a wait leaves nothing waiting, and the answer that comes after is not drawn', async () => {
    const page = await opened()
    page.to('studio')
    const asked = dragged(page, 30, 0.9)
    await asked.accept()
    page.$('#studio-again').click()
    expect([waits(page), page.read('studio').stage]).toEqual([false, 'idle'])
    await page.answer('studio', { request: asked.data.request, palette: 'night', headline: 'After.', say: 'After.' })
    await page.advance(SLOW * 2)
    expect([art(page).getAttribute('data-skin'), words(page, 'headline'), page.said('studio'), page.read('studio').stage]).toEqual(['draft', DRAFT, '', 'idle'])
    page.close()
  })

  test('leaving the studio in the middle of a wait throws nothing, and the design is there to come back to', async () => {
    const page = await opened()
    page.to('studio')
    const asked = dragged(page, 30, 0.9)
    await asked.accept()
    page.to('chess')
    await page.set({
      studio: { request: asked.data.request, palette: 'duo', type: 'hand', headline: 'Done while you were away.', say: 'Done while you were away.' },
    })
    await page.advance(SLOW * 2)
    expect(page.errors).toEqual([])
    page.w.Shell.go('studio')
    expect([words(page, 'headline'), art(page).getAttribute('data-type'), page.said('studio')]).toEqual([
      'Done while you were away.',
      'hand',
      'Done while you were away.',
    ])
    // However long it is left, nothing goes to the agent that the person did not do
    await page.advance(5 * 60_000)
    expect(page.sent).toHaveLength(1)
    page.close()
  })

  test('the wheel and the pieces can be worked from the keyboard', async () => {
    const page = await opened()
    page.to('studio')
    const key = (el: any, k: string) => el.dispatchEvent(new page.w.KeyboardEvent('keydown', { key: k, bubbles: true }))
    const wheel = page.$('#studio-wheel')
    const before = page.$('#studio-knob').style.left
    key(wheel, 'ArrowRight')
    key(wheel, 'ArrowDown')
    expect(page.$('#studio-knob').style.left).not.toBe(before)
    expect(page.sent).toEqual([])
    key(wheel, 'Enter')
    const asked = page.sentOf('design').at(-1)!
    await asked.accept()
    await page.answer('studio', { request: asked.data.request, say: 'There.' })
    // Every piece is a button, and Escape puts the words away
    for (const name of ['name', 'headline', 'line', 'button', 'date', 'acts', 'picture'])
      expect([piece(page, name).tagName, piece(page, name).getAttribute('aria-label')]).toEqual([
        'BUTTON',
        expect.stringContaining('Press to say what is wrong with it'),
      ])
    piece(page, 'line').click()
    expect(page.$('#studio-ask').hidden).toBe(false)
    key(page.$('#studio-ask'), 'Escape')
    expect(page.$('#studio-ask').hidden).toBe(true)
    page.close()
  })
})

describe('the guide for the studio', () => {
  const first = GUIDE.slice(GUIDE.indexOf('\n## The first page'), GUIDE.indexOf('\n## If they ask to see more'))
  const section = first.split(/^### /m).find((text) => text.startsWith('The studio'))!
  const examples = [...section.matchAll(/^it tour answer <the action's id> - <<'EOF'\n(\{.*\})\nEOF$/gm)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>)

  test('names both actions the studio sends, and answers each with one command in a shape the studio reads', () => {
    expect(section.split('\n')[0]).toBe('The studio: `design`, `point`')
    const html = tourPage('start').html
    const reads = html.slice(html.indexOf('Shell.part("studio"'), html.indexOf('Shell.part("chess"'))
    expect(examples.length).toBeGreaterThanOrEqual(3)
    const read = ['palette', 'type', 'shape', 'picture', 'headline', 'line', 'size', 'tone', 'text', 'show', 'say']
    for (const example of examples)
      for (const k of Object.keys(example)) {
        expect(read, k).toContain(k)
        expect(reads, k).toMatch(new RegExp(`got\\.${k}\\b`))
      }
    // And the studio reads nothing of an answer that the guide does not say
    for (const m of reads.matchAll(/\bgot\.([a-z]+)\b/g)) expect(read, m[1]).toContain(m[1])
    expect(examples.some((example) => 'request' in example || 'part' in example)).toBe(false)
  })

  test('the design it gives as an example is one the page can draw, and it says what the page does with colours of the agent’s own', async () => {
    const page = await opened()
    page.to('studio')
    const asked = dragged(page, 30, 0.9)
    const design = examples.find((example) => 'palette' in example)!
    expect(Object.keys(asked.data.palettes)).toContain(design.palette)
    expect(Object.keys(asked.data.type)).toContain(design.type)
    expect(asked.data.shape).toContain(design.shape)
    expect(asked.data.picture).toContain(design.picture)
    expect(section).toContain('`pick`')
    expect(section).toContain('`try`')
    expect(section).toContain('the page takes them only where the ink can be read on the paper')
    page.close()
  })
})
