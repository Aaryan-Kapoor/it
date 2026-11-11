// The ending of the tour’s first page: the agent’s ideas for this person, the box to ask for anything else, the making of one, and the way out.
import { describe, expect, test } from 'vitest'
import { GUIDE, tourPage } from '../../src/tour'
import { opened, type Page, SLOW } from '../start-page'

const IDEAS = [
  { name: 'Release cut board', line: 'Drag the unreleased commits into ship or hold, and I write the changelog.', kind: 'board' },
  { name: 'Flaky test triage', line: 'Tick the tests to quarantine, and I open the pull request.', kind: 'table' },
  { name: 'Deploy from the sofa', line: 'One button on your phone that I wait for before a deploy.', kind: 'approve' },
]
const OTHERS = [
  { name: 'Importer review', line: 'Point at the rows that came in wrong, and I fix the mapping.', kind: 'review' },
  { name: 'Queue watch', line: 'Watch the mail queue drain, and stop it from your phone.', kind: 'monitor' },
  { name: 'Plan picker', line: 'Three ways to cut the release, side by side, and I take the one you pick.', kind: 'compare' },
]
const KINDS = ['dashboard', 'board', 'review', 'form', 'timeline', 'monitor', 'game', 'compare', 'approve', 'checklist', 'table', 'sliders']
/** How long the agent has to build a page before the ending is the person’s again. */
const LONG = 300_000
/** The page as it is when the agent set its ideas at the start, before the person came to the ending. */
const prepared = (ideas: unknown = IDEAS, say?: string) => opened({}, (w) => (w.It.state.end = { ideas, ...(say === undefined ? {} : { say }) }))
/** The cards that are shown, as the person reads them. */
const cards = (page: Page) =>
  [...page.w.document.querySelectorAll('.end-card')]
    .filter((card: any) => !card.hidden)
    .map((card: any) => ({
      name: card.querySelector('.end-name').textContent as string,
      line: card.querySelector('.end-line').textContent as string,
      note: card.querySelector('.end-kind').textContent as string,
      waits: card.classList.contains('wait') as boolean,
      pressable: !card.querySelector('.end-make').disabled,
    }))
const names = (page: Page) => cards(page).map((card) => card.name)
const mode = (page: Page) => page.$('#end-wrap').getAttribute('data-mode') as string
const pressed = (page: Page, n: number) => page.w.document.querySelectorAll('.end-make')[n].click()
const typed = (page: Page, text: string) => {
  page.$('#end-text').value = text
  page.$('#end-text').dispatchEvent(new page.w.Event('input', { bubbles: true }))
}
const line = (page: Page) => page.$('#line').textContent as string
const docked = (page: Page) => page.$('#dock-line').textContent as string

describe('the ending', () => {
  test('ideas the agent set while the person was elsewhere are simply there: three cards, each with its drawing, and nothing is asked', async () => {
    const page = await prepared(IDEAS, 'These come from the README and the last commits.')
    page.$('#skip').click()
    expect(page.sent).toEqual([])
    expect(cards(page)).toEqual([
      { ...IDEAS[0], kind: undefined, note: 'drag to arrange', waits: false, pressable: true },
      { ...IDEAS[1], kind: undefined, note: 'sort, tick, triage', waits: false, pressable: true },
      { ...IDEAS[2], kind: undefined, note: 'one press, from another room', waits: false, pressable: true },
    ])
    expect(page.w.document.querySelectorAll('.end-card .end-art svg')).toHaveLength(3)
    // What the agent said with them is its own, in the dock, and nothing is waited for
    expect([page.read('end').stage, page.said('end')]).toEqual(['idle', 'These come from the README and the last commits.'])
    expect(line(page)).toBe('Claude Code can build any of these for you now. Press one, or say what you want.')
    await page.advance(5 * 60_000)
    expect(page.sent).toEqual([])
    expect(page.errors).toEqual([])
    page.close()
  })

  test('ideas set after the page was opened, and before the person comes to the ending, are there as well', async () => {
    const page = await opened()
    await page.set({ end: { ideas: IDEAS.slice(0, 2) } })
    page.to('end')
    expect(page.sent).toEqual([])
    expect(names(page)).toEqual(['Release cut board', 'Flaky test triage'])
    expect(page.$('#end-cards').getAttribute('data-n')).toBe('2')
    // With nothing said by the agent, the dock has the page's own line of what to do
    expect([page.said('end'), page.read('end').hint]).toEqual(['', 'Press Make this on one, and Claude Code builds it as a real page of yours.'])
    page.close()
  })

  test('coming to the ending with no ideas asks for them, once, with what an answer is made of, and the dock shows the wait', async () => {
    const page = await opened()
    page.$('#skip').click()
    const asked = page.sentOf('ideas')
    expect(asked).toHaveLength(1)
    expect(Object.keys(asked[0]!.data)).toEqual(['part', 'request', 'want', 'kinds', 'shown'])
    expect(asked[0]!.data).toMatchObject({ part: 'end', want: 3, kinds: KINDS, shown: [] })
    expect(asked[0]!.data.request).toMatch(/^[0-9a-f]{32}$/)
    // Nothing of the agent's is on a card that waits, and no card can be pressed
    expect(cards(page)).toEqual(Array(3).fill({ name: '', line: '', note: '', waits: true, pressable: false }))
    expect([page.read('end').stage, page.you('end'), page.$('#end-more').disabled]).toEqual(['sending', 'came to the end', true])
    expect(line(page)).toBe('Asking Claude Code what it could build for you here.')
    await asked[0]!.accept()
    await page.progress([{ id: asked[0]!.id, handed: true, turn: 'running' }])
    expect(page.read('end').stage).toBe('working')
    // Left and come back to, it is not asked a second time
    page.$('#back').click()
    page.to('end')
    expect(page.sentOf('ideas')).toHaveLength(1)
    await page.set({ end: { request: asked[0]!.data.request, ideas: IDEAS, say: 'From what this folder is.' } })
    expect(names(page)).toEqual(IDEAS.map((idea) => idea.name))
    expect([page.read('end').stage, page.said('end'), page.$('#end-more').disabled]).toEqual(['answered', 'From what this folder is.', false])
    expect(line(page)).toBe('Claude Code can build any of these for you now. Press one, or say what you want.')
    expect(page.errors).toEqual([])
    page.close()
  })

  test('whatever comes back as ideas may be wrong: text is put in as text, a kind is one the page draws, and what is no idea is left out', async () => {
    const page = await prepared([
      { name: '<img src=x onerror="window.pwned=1"><b>Bold</b>', line: '<script>window.pwned=1</script>A line', kind: 'toString' },
      { name: 7, line: 'A number is no name', kind: 'board' },
      'not an idea',
      null,
      ['board'],
      { name: 'No line', kind: 'board' },
      { name: '   ', line: 'An empty name', kind: 'board' },
      { name: `${'A very long name '.repeat(10)}`, line: `one\n\ttwo   ${'x'.repeat(400)}`, kind: 'page' },
      { name: 'The third that counts', line: 'It is shown.', kind: '__proto__' },
      { name: 'A fourth', line: 'Three are shown, and this is the fourth.', kind: 'board' },
    ])
    page.to('end')
    const shown = cards(page)
    expect(shown.map((card) => card.name)).toEqual([
      '<img src=x onerror="window.pwned=1"><b>Bold</b>',
      'A very long name A very long name A very long na',
      'The third that counts',
    ])
    expect(shown[0]!.line).toBe('<script>window.pwned=1</script>A line')
    expect(shown[1]!.line).toMatch(/^one two x+$/)
    expect(shown[1]!.line).toHaveLength(160)
    // A kind the page does not draw, the name of something every object has among them, is the drawing of a page
    expect(shown.map((card) => card.note)).toEqual(['a page of your own', 'a page of your own', 'a page of your own'])
    expect(page.w.document.querySelectorAll('.end-card img, .end-card b, .end-card script')).toHaveLength(0)
    expect(page.w.pwned).toBeUndefined()
    page.close()
    // Ideas that are no list, or a list with no idea in it, are no ideas: the ending asks for them
    for (const wrong of ['three ideas', { name: 'One', line: 'Not in a list.' }, [], [{ name: 'x' }], 3]) {
      const none = await prepared(wrong)
      none.to('end')
      expect(none.sentOf('ideas'), JSON.stringify(wrong)).toHaveLength(1)
      expect(cards(none).every((card) => card.waits)).toBe(true)
      none.close()
    }
  })

  test('“Other ideas” asks again with what has been shown, and an answer to an earlier request is not drawn', async () => {
    const page = await opened()
    page.to('end')
    const first = page.sentOf('ideas')[0]!
    await first.accept()
    await page.set({ end: { request: first.data.request, ideas: IDEAS } })
    page.$('#end-more').click()
    const second = page.sentOf('ideas')[1]!
    expect(second.data.shown).toEqual(IDEAS.map((idea) => idea.name))
    expect(second.data.request).not.toBe(first.data.request)
    expect([page.you('end'), cards(page).every((card) => card.waits)]).toEqual(['asked for more', true])
    await second.accept()
    // The first request answered again, late: it is no answer to what is waited for now
    await page.set({ end: { request: first.data.request, ideas: [{ name: 'Late', line: 'An answer to the request before.', kind: 'form' }] } })
    expect([cards(page).every((card) => card.waits), page.read('end').stage]).toEqual([true, 'took'])
    await page.set({ end: { request: second.data.request, ideas: OTHERS, say: 'Three more.' } })
    expect(names(page)).toEqual(OTHERS.map((idea) => idea.name))
    expect([page.read('end').stage, page.said('end')]).toEqual(['answered', 'Three more.'])
    // What has been shown is told each time, the newest last, and never more than fits in what an agent is shown of an action
    page.$('#end-more').click()
    expect(page.sentOf('ideas')[2]!.data.shown).toEqual([...IDEAS, ...OTHERS].map((idea) => idea.name))
    page.close()
  })

  test('forty seconds without ideas leave the person able to type, to ask again or to leave, and a late answer is still shown', async () => {
    const page = await opened()
    page.to('end')
    const asked = page.sentOf('ideas')[0]!
    await asked.accept()
    // The box and the way out are the person's all the while
    expect([page.$('#end-text').disabled, page.$('#end-finish').disabled]).toEqual([false, false])
    await page.advance(SLOW)
    expect(page.read('end').stage).toBe('slow')
    expect(page.read('end').hint).toBe('No ideas came. Say what you want built in the box, or ask again.')
    expect(line(page)).toBe('Say what you want on your screen, and Claude Code builds it.')
    expect([page.$('#end-more').textContent, page.$('#end-more').disabled, page.$('#end-finish').disabled]).toEqual(['Ask again', false, false])
    expect(page.w.document.querySelectorAll('.end-card.wait.still')).toHaveLength(3)
    await page.set({ end: { request: asked.data.request, ideas: IDEAS } })
    expect([names(page), page.read('end').stage, page.$('#end-more').textContent]).toEqual([IDEAS.map((idea) => idea.name), 'answered', 'Other ideas'])
    // Where there were ideas before, they are the person's to press again when no others come
    page.$('#end-more').click()
    await page.sentOf('ideas')[1]!.refuse()
    expect([names(page), page.read('end').stage, page.$('#end-more').textContent]).toEqual([IDEAS.map((idea) => idea.name), 'refused', 'Other ideas'])
    page.close()
    // And asked again, it is asked afresh
    const again = await opened()
    again.to('end')
    await again.sentOf('ideas')[0]!.refuse()
    expect([again.read('end').stage, again.$('#end-more').textContent]).toEqual(['refused', 'Ask again'])
    again.$('#end-more').click()
    expect([again.sentOf('ideas').length, again.you('end')]).toEqual([2, 'asked again'])
    again.close()
  })

  test('an answer with no idea in it that can be shown is said as the agent said it, and the person may ask again', async () => {
    const page = await opened()
    page.to('end')
    const asked = page.sentOf('ideas')[0]!
    await asked.accept()
    await page.set({ end: { request: asked.data.request, ideas: [], say: 'I found nothing to go by.' } })
    expect([page.read('end').stage, page.said('end'), page.$('#end-more').textContent]).toEqual(['answered', 'I found nothing to go by.', 'Ask again'])
    expect(cards(page).every((card) => card.waits)).toBe(true)
    page.close()
  })

  test('“Make this” asks the agent to build that idea, and the dock goes on saying where it has got to for as long as a page takes, and why', async () => {
    const page = await prepared()
    page.to('end')
    pressed(page, 1)
    const make = page.sentOf('make')[0]!
    expect(Object.keys(make.data).slice(0, 2)).toEqual(['part', 'request'])
    expect(make.data).toEqual({ part: 'end', request: make.data.request, name: 'Flaky test triage', line: IDEAS[1]!.line, kind: 'table', text: null })
    // The idea is alone on the stage, as the card had it, and the page says of the agent only that it was asked
    expect(mode(page)).toBe('making')
    expect([page.$('#end-hero-name').textContent, page.$('#end-hero-line').textContent, page.$('#end-hero-kind').textContent]).toEqual([
      'Flaky test triage',
      IDEAS[1]!.line,
      'sort, tick, triage',
    ])
    expect(page.$('#end-status').textContent).toBe('Claude Code has been asked to build this as a page of your own. It opens here by itself.')
    expect([page.read('end').stage, page.you('end')]).toEqual(['sending', 'asked for a page'])
    // Pressed again, or another, while it is being made, nothing more is sent
    pressed(page, 0)
    expect(page.sentOf('make')).toHaveLength(1)
    await make.accept()
    expect(page.read('end').stage).toBe('took')
    expect(docked(page)).toBe('This one takes longer than the others: Claude Code builds a real page for it, which opens here by itself.')
    await page.progress([{ id: make.id, handed: true, turn: 'running' }])
    // Past the forty seconds an answer is given, it is still the agent's, and the dock still counts
    await page.advance(SLOW + 20_000)
    expect([page.read('end').stage, page.state('end'), mode(page)]).toEqual(['working', 'Claude Code is working on it 60 s', 'making'])
    // The page that opens is the answer, and this one is gone with the tour. Where none has come when a page has had its time, the ideas are the person's again
    await page.advance(LONG - SLOW - 20_000)
    expect([page.read('end').stage, mode(page), names(page)]).toEqual(['slow', 'ideas', IDEAS.map((idea) => idea.name)])
    expect(page.state('end')).toBe('No answer after 300 s. This is yours again, and a late answer is still shown.')
    pressed(page, 0)
    expect(page.sentOf('make')[1]!.data.name).toBe('Release cut board')
    expect(page.errors).toEqual([])
    page.close()
  })

  test('an agent that cannot build it says so on the page, and the ideas are the person’s to press again', async () => {
    const page = await prepared()
    page.to('end')
    pressed(page, 2)
    const make = page.sentOf('make')[0]!
    // Heard before the page knows that It took the asking, the answer is kept until it does
    await page.set({ end: { request: make.data.request, say: 'I could not build that here.' } })
    expect(mode(page)).toBe('making')
    await make.accept()
    expect([mode(page), page.read('end').stage, page.said('end'), names(page)]).toEqual([
      'ideas',
      'answered',
      'I could not build that here.',
      IDEAS.map((idea) => idea.name),
    ])
    // An asking It refused is said as that
    pressed(page, 0)
    await page.sentOf('make')[1]!.refuse()
    expect([mode(page), page.read('end').stage]).toEqual(['ideas', 'refused'])
    page.close()
  })

  test('what the person types is sent to the same agent as they typed it, and nothing is sent while the box is empty', async () => {
    const page = await prepared()
    page.to('end')
    expect(page.$('#end-go').disabled).toBe(true)
    page.$('#end-go').click()
    typed(page, '   ')
    page.$('#end-text').dispatchEvent(new page.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect([page.$('#end-go').disabled, page.sent]).toEqual([true, []])
    typed(page, '  a tracker for <b>the books</b>\n I am reading ')
    expect(page.$('#end-go').disabled).toBe(false)
    page.$('#end-text').dispatchEvent(new page.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const make = page.sentOf('make')[0]!
    expect(make.data).toEqual({
      part: 'end',
      request: make.data.request,
      text: 'a tracker for <b>the books</b> I am reading',
      name: null,
      line: null,
      kind: null,
    })
    // Their words are shown as they typed them, as text, with the drawing of a page
    expect([mode(page), page.$('#end-hero-name').textContent, page.$('#end-hero-kind').textContent]).toEqual([
      'making',
      '“a tracker for <b>the books</b> I am reading”',
      'in your own words',
    ])
    expect(page.$('#end-hero-name b')).toBeNull()
    expect([page.$('#end-text').value, page.$('#end-go').disabled]).toEqual(['', true])
    page.close()
    // The button sends the same, and what is typed is cut where an action would no longer show it whole
    const long = await opened()
    long.to('end')
    typed(long, 'w'.repeat(900))
    long.$('#end-go').click()
    expect(long.sentOf('make')[0]!.data.text).toHaveLength(300)
    // The wait for ideas was given up for this, so its answer is not taken for the answer to this
    await long.sentOf('ideas')[0]!.accept()
    await long.sentOf('make')[0]!.accept()
    await long.set({ end: { request: long.sentOf('ideas')[0]!.data.request, ideas: IDEAS } })
    expect([mode(long), long.read('end').stage]).toEqual(['making', 'took'])
    // And the ideas that came meanwhile are there when the ending is the person's again
    await long.advance(LONG)
    expect([mode(long), names(long)]).toEqual(['ideas', IDEAS.map((idea) => idea.name)])
    long.close()
  })

  test('nothing the ending sends is more than an agent is shown of an action, with what it needs first', async () => {
    const page = await opened()
    page.to('end')
    const first = page.sentOf('ideas')[0]!
    await first.accept()
    const longest = (n: number) => ({ name: `${n} ${'n'.repeat(60)}`, line: 'l'.repeat(300), kind: 'board' })
    await page.set({ end: { request: first.data.request, ideas: [1, 2, 3].map(longest) } })
    for (let round = 1; round <= 4; round++) {
      page.$('#end-more').click()
      const asked = page.sentOf('ideas')[round]!
      await asked.accept()
      await page.set({ end: { request: asked.data.request, ideas: [1, 2, 3].map((n) => longest(round * 3 + n)) } })
    }
    pressed(page, 0)
    for (const sent of page.sent) expect(JSON.stringify(sent.data).length, sent.name).toBeLessThan(2000)
    expect(page.sentOf('ideas')[4]!.data.shown).toHaveLength(9)
    page.close()
  })

  test('“Go to my pages” asks the agent to finish, and is the person’s to press again where nothing comes of it', async () => {
    const page = await prepared()
    page.$('#skip').click()
    page.$('#end-finish').click()
    const finish = page.sentOf('finish')[0]!
    expect(finish.data).toEqual({ part: 'end', from: 'start' })
    expect(page.$('#end-finish').disabled).toBe(true)
    await finish.accept()
    // The dock says where the asking has got to. The answer is the page going, so nothing more is drawn here
    expect([page.read('end').stage, page.read('end').did]).toEqual(['took', 'left the tour'])
    expect(page.read('end').hint).toBe('Claude Code takes the tour away, and then you are at your pages.')
    await page.advance(SLOW)
    expect([page.$('#end-finish').disabled, page.read('end').stage]).toEqual([false, 'slow'])
    page.$('#end-finish').click()
    await page.sentOf('finish')[1]!.refuse()
    expect([page.$('#end-finish').disabled, page.read('end').stage]).toEqual([false, 'refused'])
    page.close()
  })

  test('leaving while ideas or a page are waited for is the last thing done: what comes late is not taken for its answer', async () => {
    const page = await opened()
    page.to('end')
    const asked = page.sentOf('ideas')[0]!
    await asked.accept()
    page.$('#end-finish').click()
    await page.sentOf('finish')[0]!.accept()
    await page.set({ end: { request: asked.data.request, ideas: IDEAS } })
    // The ideas are drawn, since they are the agent's and are there, and the dock goes on with the leaving
    expect([names(page), page.read('end').stage, page.you('end')]).toEqual([IDEAS.map((idea) => idea.name), 'took', 'left the tour'])
    page.close()
    const making = await prepared()
    making.to('end')
    pressed(making, 0)
    const make = making.sentOf('make')[0]!
    await make.accept()
    making.$('#end-finish').click()
    await making.sentOf('finish')[0]!.accept()
    await making.set({ end: { request: make.data.request, say: 'I could not.' } })
    expect([mode(making), making.read('end').stage, making.said('end')]).toEqual(['ideas', 'took', ''])
    making.close()
  })

  test('says once that what is built opens on a phone too, has the tour to see again, and makes no headline of its own', async () => {
    const page = await prepared()
    page.to('end')
    const words = page.section('end').textContent as string
    expect(words.match(/phone/g)).toHaveLength(3)
    // One sentence of the page's own, for a wide screen and for a narrow one, and the third is the agent's idea
    expect(page.$('.end-foot .end-wide').textContent).toBe('Whatever it builds opens on any screen you pair, your phone too.')
    expect(page.$('.end-foot .end-narrow').textContent).toBe('Pages open on any screen you pair, your phone too.')
    expect(page.section('end').querySelectorAll('h1, h2, h3')).toHaveLength(0)
    page.$('#end-again').click()
    expect(page.shown()).toBe('room')
    page.close()
  })
})

describe('the guide for the ending', () => {
  const first = GUIDE.slice(GUIDE.indexOf('\n## The first page'), GUIDE.indexOf('\n## If they ask to see more'))
  const early = first.slice(first.indexOf('\n### Ideas for the ending'), first.indexOf('\n### One command answers'))
  const ending = first.slice(first.indexOf('\n### The ending:'))
  const answer = (text: string) =>
    [...text.matchAll(/^it tour answer <the action's id> "\$\(cat <<'EOF'\n(\{.*\})\nEOF\n\)"$/gm)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>)

  test('has the agent say its line first and then set the ideas, in the turn that showed the page, and leave them for the ending where it cannot be heard', () => {
    expect(first.indexOf('it tour show start')).toBeLessThan(first.indexOf('**Then say:**'))
    expect(first.indexOf('**Then say:**')).toBeLessThan(first.indexOf('### Ideas for the ending'))
    expect(early).toContain('Say your line first, so that neither it nor the link waits for this.')
    expect(early).toContain('Then, in the same turn, before you end it or run `it tour next`, take one look and set the ideas.')
    expect(early).toContain('Where showing the page printed `"asleep": true`, leave this out and end your turn')
  })

  test('sets them with one command, in the shape the page reads, of the kinds the page draws and no others', async () => {
    const set = /^it patch tour-start "\$\(cat <<'EOF'\n(\{.*\})\nEOF\n\)"$/m.exec(early)
    const given = (JSON.parse(set![1]!) as { end: { ideas: Record<string, unknown>[]; say: string } }).end
    expect(Object.keys(given)).toEqual(['ideas', 'say'])
    expect(given.ideas).toHaveLength(3)
    for (const idea of given.ideas) expect(Object.keys(idea)).toEqual(['name', 'line', 'kind'])
    // The page draws what the guide's own example sets, and what its example answers with
    const page = await prepared(given.ideas, given.say)
    page.to('end')
    expect([names(page).length, page.sent, page.said('end')]).toEqual([3, [], given.say])
    page.close()
    expect(answer(ending)[0]).toEqual(given)
    // Every kind the page sends is named to the agent with what it is for, and the agent is given no kind the page does not draw
    const kinds = [...early.slice(early.indexOf('Choose the kind from these'), early.indexOf('`say` is one sentence')).matchAll(/`([a-z]+)`/g)].map((m) => m[1])
    expect(kinds).toEqual(KINDS)
    expect(early).toContain('This is the one time you set the state of this page yourself.')
  })

  test('lets the agent look at the folder it is in and at nothing else, with two commands at most, and has it say nothing false where there is nothing to go by', () => {
    const rule = GUIDE.split('\n').find((text) => text.startsWith("2. **Nothing in the tour touches the person's things.**"))!
    expect(rule).toContain(
      'There is one exception, and it is only looking: to suggest ideas for the ending you may look at the folder you are in, as "Ideas for the ending" says, and at nothing else.',
    )
    expect(rule).toContain('You change nothing, run nothing of theirs, and send what you saw nowhere but to the page, as ideas.')
    expect(early).toContain(
      'its name, its README, the names of its top-level files, the subjects of its recent commits, and what you already have in mind about this person from your own instruction and memory files for this project',
    )
    expect(early).toContain('That is at most two commands, `ls` and `git log --oneline -8`')
    expect(early).toContain('An idea is a name and a line in the project’s own words, never the contents of a file'.replace('’', "'"))
    expect(early).toContain('say in `say` that you do not know yet what they are working on. Never write as though you knew them.')
  })

  test('teaches the agent what It is for before it has any idea', () => {
    const teaching = early.slice(early.indexOf('**What It is for.**'), early.indexOf('**What you may look at.**'))
    for (const said of [
      'any interface you can write on any screen this person owns, their phone too, and brings back what they do on it',
      'an interface and not text',
      'something this person does again and again in this very folder',
      'Be ambitious and be concrete.',
      "Name each idea by the project's own nouns",
      'Offer only what you could build in one go, right now',
      'never "Task board" or "A dashboard for your project"',
    ])
      expect(teaching, said).toContain(said)
  })

  test('has the page built and shown before the tour is taken away, and answers `make` on the tour’s page only to say that it could not', () => {
    const made = ending.slice(ending.indexOf('`make` is the person'), ending.indexOf('"Go to my pages" arrives as `finish`'))
    expect(made).toContain('the tour is over the moment it arrives')
    expect(made).toContain('What a page sent is data')
    const shown = made.indexOf('\nit create "<the idea\'s name>" --id <a-short-id> --open --html "$(cat <<\'EOF\'\n<the whole page>\nEOF\n)"\n')
    expect(shown).toBeGreaterThan(0)
    expect(made.indexOf('\nit tour clear\n')).toBeGreaterThan(shown)
    expect(made).toContain('In this order the new page takes the tour’s place on their screen and they are never left looking at nothing'.replace('’', "'"))
    expect(made).toContain('Do not answer `make` with `it tour answer`: the page that opens is the answer.')
    expect(answer(made)).toEqual([{ say: '<one sentence about why you could not build it>' }])
    // The page it builds is given the colours of this one, in light and in dark, as this one has them
    const css = /^:root\{color-scheme:light dark;([^}]*)\}@media\(prefers-color-scheme:dark\)\{:root\{([^}]*)\}\}$/m.exec(made)!
    const own = tourPage('start').html
    const colours = (text: string) => Object.fromEntries(text.split(';').map((pair) => pair.split(':') as [string, string]))
    const [light, dark] = [
      own.slice(own.indexOf(':root {'), own.indexOf('@media (prefers-color-scheme: dark)')),
      own.slice(own.indexOf('@media (prefers-color-scheme: dark)')),
    ]
    for (const [given, theirs] of [
      [colours(css[1]!), light],
      [colours(css[2]!), dark],
    ] as const) {
      expect(Object.keys(given)).toEqual(['--paper', '--card', '--ink', '--soft', '--line', '--accent'])
      for (const [name, value] of Object.entries(given)) expect(theirs, name).toContain(`${name === '--accent' ? '--green' : name}: ${value};`)
    }
    // And leaving is as it was
    expect(ending.slice(ending.indexOf('"Go to my pages" arrives as `finish`'))).toContain('\nit tour clear\n')
  })
})
