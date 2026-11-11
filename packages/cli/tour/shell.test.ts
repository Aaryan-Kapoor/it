// The shell of the tour's first page: its frame, the going from one part to the next, the
// agent's dock and what it says at each stage, and how the page is put together from its parts.
// Each part's own tests are beside it, in parts/<name>.test.ts.
import { readFileSync } from 'node:fs'
import { LIMITS } from '@it/protocol'
import { describe, expect, test } from 'vitest'
import { GUIDE, tourPage } from '../src/tour'
import { opened, type Page, pointer, SLOW, STEPS } from './start-page'

// The module that puts the page together is plain JavaScript, with no types of its own
const { assembled, partOf } = (await import('../tour-parts.mjs' as string)) as {
  assembled: (shell: string, names: unknown, read: (name: string) => string) => string
  partOf: (name: string, read: (name: string) => string) => { style: string; section: string; script: string }
}

/** The armchair of the room put down on the coffee table, which is the page's first way to ask the agent something. */
const moved = (page: Page) => {
  const chair = page.$('#chair')
  const at = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(chair.style.transform)!.slice(1).map(Number)
  pointer(page, chair, 'pointerdown', at[0]! + 39, at[1]! + 39)
  pointer(page, chair, 'pointermove', 430 + 39, 230 + 39)
  pointer(page, chair, 'pointerup', 430 + 39, 230 + 39)
  return page.sentOf('moved').at(-1)!
}
/** The page with the ending's ideas set already, as the agent sets them at the start: without them, coming to the ending asks for them. */
const withIdeas = (w: any) => (w.It.state.end = { ideas: [{ name: 'A board', line: 'Drag things on it.', kind: 'board' }] })
/** How the five stages of the dock stand for a part, as the classes they are drawn with. */
const stages = (page: Page, step = 'room') => Object.fromEntries(Object.entries(page.read(step).stages).map(([k, v]) => [k, v.cls]))

describe('the frame of the tour’s first page', () => {
  test('is seven parts in their order with a count of them, and Next, Back and Skip go between them by themselves and send nothing', async () => {
    const page = await opened()
    expect(STEPS).toEqual(['room', 'board', 'studio', 'chess', 'cube', 'drums', 'end'])
    expect(page.w.Shell.names()).toEqual(STEPS)
    expect(page.shown()).toBe('room')
    expect(page.$('#count span').textContent).toBe('1 of 7')
    expect(page.$('#back').hidden).toBe(true)
    for (let i = 1; i < STEPS.length; i++) {
      page.$('#next').click()
      expect([page.shown(), page.$('#count span').textContent]).toEqual([STEPS[i], `${i + 1} of 7`])
      expect(page.w.document.querySelectorAll('#count i.on')).toHaveLength(i + 1)
    }
    // The ending has nowhere to go on to, and nothing to skip
    expect([page.$('#next').hidden, page.$('#skip').hidden, page.$('#back').hidden]).toEqual([true, true, false])
    page.$('#back').click()
    expect(page.shown()).toBe('drums')
    page.to('end')
    page.$('#again').click()
    expect(page.shown()).toBe('room')
    // A person may stop at any point and still reach the ending
    page.to('cube')
    page.$('#skip').click()
    expect(page.shown()).toBe('end')
    // However long it is left, nothing goes to the agent that the person did not do: coming to the ending asked for its ideas, once
    await page.advance(5 * 60_000)
    expect(page.sent.map((sent) => sent.name)).toEqual(['ideas'])
    expect(page.errors).toEqual([])
    page.close()
  })

  test('has no mark of It’s and no column of words: a title and one line for the part that is shown, and nothing that scrolls', async () => {
    const page = await opened({}, withIdeas)
    expect(page.$('.mark')).toBeNull()
    expect(page.$('.lede')).toBeNull()
    expect(page.w.document.querySelectorAll('h1')).toHaveLength(1)
    for (const step of STEPS) {
      page.w.Shell.go(step)
      const section = page.section(step)
      expect(page.$('#title').textContent).toBe(section.getAttribute('data-title'))
      // The line names the agent app where the part's own words leave a place for it
      expect(page.$('#line').textContent).toBe(section.getAttribute('data-line').replace(/\{agent\}/g, 'Claude Code'))
      expect(page.$('#line').textContent).not.toContain('{agent}')
      // One part is shown at a time, over the whole of the stage
      expect(STEPS.filter((s) => !page.section(s).hidden)).toEqual([step])
    }
    const css = page.w.document.querySelector('style').textContent as string
    expect(css).toMatch(/html, body \{ height: 100%; overflow: hidden; \}/)
    expect(css).toMatch(/\.part \{ position: absolute; inset: 0;/)
    page.close()
  })

  test('where the conversation that put it up cannot hear it yet, says so in amber with the line to type, until the first answer', async () => {
    const quiet = await opened()
    expect(quiet.$('#asleep').hidden).toBe(true)
    expect(quiet.state('room')).toBe('Claude Code hears what you do here')
    quiet.close()
    const page = await opened({ asleep: true })
    expect(page.$('#asleep').hidden).toBe(false)
    expect(page.$('#asleep').textContent).toContain('/reload-plugins')
    expect(page.$('#asleep').textContent).toContain('What you do here is kept')
    // The dock does not say that the agent hears a page it cannot hear
    expect(page.state('room')).toBe('Claude Code cannot hear this page yet')
    // What the person does is sent all the same, for It to keep
    const asked = moved(page)
    await asked.accept()
    expect(page.$('#asleep').hidden).toBe(false)
    await page.set({ room: { request: asked.data.request, armchair: asked.data.free[0], say: 'There.' } })
    expect(page.$('#asleep').hidden).toBe(true)
    page.to('board')
    expect(page.state('board')).toBe('Claude Code hears what you do here')
    page.close()
  })
})

describe('the agent’s dock', () => {
  test('names the agent app on every part, and before anything is done shows the five stages as what will happen, none of them reached', async () => {
    const page = await opened({}, withIdeas)
    expect(page.$('#dock-who').textContent).toBe('Claude Code')
    expect([...page.w.document.querySelectorAll('#track li b')].map((b: any) => b.textContent)).toEqual(['You', 'It', 'Claude Code', 'Working', 'Answer'])
    for (const step of STEPS) {
      page.w.Shell.go(step)
      expect(page.$('#dock').getAttribute('data-stage')).toBe('idle')
      expect(stages(page, step)).toEqual({ you: '', it: '', chat: '', work: '', page: '' })
      expect(page.$('#dock-state').textContent).toBe('Claude Code hears what you do here')
    }
    page.close()
  })

  test('says each stage only once it is known, with the time it was known at: done, taken by It, handed to the agent, the agent’s turn running, answered', async () => {
    const page = await opened()
    const move = moved(page)
    // The person did it, and It has not said that it took it
    expect(page.read('room').stage).toBe('sending')
    expect(stages(page)).toEqual({ you: 'done', it: 'next', chat: '', work: '', page: '' })
    expect(page.read('room').stages.you!.text).toBe('moved the chair')
    expect(page.$('#dock-line').textContent).toContain('on its way to It')
    await page.advance(300)
    await move.accept()
    // It took it: that much is known, and no more
    expect(page.read('room').stage).toBe('took')
    expect(stages(page)).toEqual({ you: 'done', it: 'done', chat: 'next', work: '', page: '' })
    expect(page.read('room').stages.it!.text).toBe('took it · 0.3 s')
    expect(page.state('room')).toBe('It has it. Waiting for Claude Code 1 s')
    await page.advance(2000)
    expect(page.state('room')).toBe('It has it. Waiting for Claude Code 2 s')
    // The site says of another action that it was handed on: that is nothing to this one
    await page.progress([{ id: 'action-99', handed: true, turn: 'running' }])
    expect(page.read('room').stage).toBe('took')
    // It was handed to the agent's conversation
    await page.progress([{ id: move.id, handed: true, turn: null }])
    expect(page.read('room').stage).toBe('reached')
    expect(stages(page)).toEqual({ you: 'done', it: 'done', chat: 'done', work: 'next', page: '' })
    expect(page.read('room').stages.chat!.text).toBe('got it · 2.3 s')
    expect(page.state('room')).toBe('Claude Code has it, in its own conversation 2 s')
    await page.advance(1000)
    // The agent's turn is running
    await page.progress([{ id: move.id, handed: true, turn: 'running' }])
    expect(page.read('room').stage).toBe('working')
    expect(stages(page)).toEqual({ you: 'done', it: 'done', chat: 'done', work: 'live', page: 'next' })
    expect(page.state('room')).toBe('Claude Code is working on it 3 s')
    expect(page.$('#dock-line').textContent).toBe('Claude Code’s turn is running there now. What it answers is drawn on this page.')
    await page.advance(3000)
    expect(page.read('room').stages.work!.text).toBe('for 3 s')
    // The agent answered, and what it wrote is its own words in the dock
    await page.set({ room: { request: move.data.request, armchair: move.data.free[0], lamp: true, say: 'Off the table, by the rug.' } })
    expect(page.read('room').stage).toBe('answered')
    expect(stages(page)).toEqual({ you: 'done', it: 'done', chat: 'done', work: 'done', page: 'done' })
    expect(page.read('room').stages.page!.text).toBe('in 6.3 s')
    expect(page.read('room').stages.work!.text).toBe('for 3.0 s')
    expect(page.state('room')).toBe('Claude Code answered in 6.3 s')
    expect([page.$('#dock-line').textContent, page.$('#dock-line').classList.contains('hint')]).toEqual(['Off the table, by the rug.', false])
    expect(page.$('#dock').getAttribute('data-stage')).toBe('answered')
    page.close()
  })

  test('a stage the page was never told of is not said to have been reached: it is waited for, and drawn as passed, with no time, once the answer has come', async () => {
    const page = await opened()
    const move = moved(page)
    await move.accept()
    await page.advance(5000)
    // Nothing says that it reached the agent, so the dock does not
    expect(stages(page)).toEqual({ you: 'done', it: 'done', chat: 'next', work: '', page: '' })
    expect(page.state('room')).toBe('It has it. Waiting for Claude Code 5 s')
    await page.set({ room: { request: move.data.request, armchair: move.data.free[0], say: 'There.' } })
    expect(stages(page)).toEqual({ you: 'done', it: 'done', chat: 'past', work: 'past', page: 'done' })
    expect([page.read('room').stages.chat!.text, page.read('room').stages.work!.text]).toEqual(['got it', 'worked on it'])
    expect(page.state('room')).toBe('Claude Code answered in 5.0 s')
    page.close()
  })

  test('a turn that is said to have stopped before any answer is not shown as going on', async () => {
    const page = await opened()
    const move = moved(page)
    await move.accept()
    await page.progress([{ id: move.id, handed: true, turn: 'running' }])
    expect(page.read('room').stage).toBe('working')
    await page.progress([{ id: move.id, handed: true, turn: 'ended' }])
    expect(page.read('room').stage).toBe('reached')
    expect(stages(page).work).toBe('next')
    expect(page.state('room')).toContain('Claude Code’s turn ended, and no answer has come here yet')
    // And one that is no longer known is said as it was before it was known
    await page.progress([{ id: move.id, handed: true, turn: 'running' }])
    await page.progress([{ id: move.id, handed: true, turn: null }])
    expect(page.state('room')).toContain('Claude Code has it, in its own conversation')
    page.close()
  })

  test('what the site said of an action before the page knew which action was its own is taken once it does', async () => {
    const page = await opened()
    const move = moved(page)
    await page.progress([{ id: move.id, handed: true, turn: 'running' }])
    expect(page.read('room').stage).toBe('sending')
    await move.accept()
    expect(page.read('room').stage).toBe('working')
    page.close()
  })

  test('after forty seconds without an answer the part is the person’s again, the dock says so, and a late answer is still shown with its time', async () => {
    const page = await opened()
    const move = moved(page)
    await move.accept()
    await page.progress([{ id: move.id, handed: true, turn: null }])
    await page.advance(SLOW)
    expect(page.read('room').stage).toBe('slow')
    expect(page.state('room')).toBe('No answer after 40 s. This is yours again, and a late answer is still shown.')
    // What was reached stays reached, and the stage that never came is where it stopped
    expect(stages(page)).toEqual({ you: 'done', it: 'done', chat: 'done', work: 'off', page: '' })
    expect(page.$('#chair').classList.contains('still')).toBe(false)
    await page.advance(7000)
    await page.set({ room: { request: move.data.request, armchair: move.data.free[0], say: 'Late, and here.' } })
    expect(page.state('room')).toBe('Claude Code answered in 47.0 s')
    expect(page.said('room')).toBe('Late, and here.')
    page.close()
  })

  test('an action It refused is said as that, at the stage where it stopped', async () => {
    const page = await opened()
    const move = moved(page)
    await move.refuse()
    expect(page.read('room').stage).toBe('refused')
    expect(page.state('room')).toBe('It did not take that. Do it again.')
    expect(stages(page)).toEqual({ you: 'done', it: 'off', chat: '', work: '', page: '' })
    expect(page.read('room').stages.it!.text).toBe('did not take it')
    page.close()
  })

  test('keeps each part’s own journey, and shows the one of the part that is shown', async () => {
    const page = await opened()
    const move = moved(page)
    await move.accept()
    page.to('chess')
    // Chess has had nothing done on it: the dock shows that, and the room's wait goes on unseen
    expect(page.$('#dock').getAttribute('data-stage')).toBe('idle')
    expect(page.read('room').stage).toBe('took')
    await page.set({ room: { request: move.data.request, armchair: move.data.free[0], say: 'Done while you were away.' } })
    expect(page.$('#dock').getAttribute('data-stage')).toBe('idle')
    page.w.Shell.go('room')
    expect(page.$('#dock').getAttribute('data-stage')).toBe('answered')
    expect(page.$('#dock-line').textContent).toBe('Done while you were away.')
    page.close()
  })

  test('every action a part sends says which part it is from, first, with the request it waits on', async () => {
    const page = await opened()
    const move = moved(page)
    expect(Object.keys(move.data).slice(0, 2)).toEqual(['part', 'request'])
    expect(move.data.part).toBe('room')
    page.close()
  })

  test('a browser whose It says nothing of where an action has got to is shown the same page, with those stages unknown', async () => {
    const page = await opened({}, (w) => {
      delete w.It.onProgress
    })
    const move = moved(page)
    await move.accept()
    expect(page.read('room').stage).toBe('took')
    expect(page.errors).toEqual([])
    page.close()
  })
})

describe('the frame in other colours', () => {
  const WORN = ['--green', '--on-green', '--green-soft', '--paper', '--card', '--line']
  const worn = (page: Page) => WORN.map((k) => page.w.document.documentElement.style.getPropertyValue(k) as string)
  const SOUND = { '--green': '#b4530c', '--on-green': '#ffffff', '--green-soft': '#f6e3d2', '--paper': '#f4ece0', '--card': '#fffaf2', '--line': '#e6d6c2' }

  test('a part may dress the frame in an accent and a tint of its own, and put the frame’s own colours back', async () => {
    const page = await opened()
    expect(worn(page).join('')).toBe('')
    expect(page.w.Shell.wear(SOUND)).toBe(true)
    expect(worn(page)).toEqual(Object.values(SOUND))
    // The accent alone, where it can be read against the frame's own paper
    expect(page.w.Shell.wear({ '--green': '#1d4ed8', '--on-green': '#ffffff' })).toBe(true)
    expect(worn(page)).toEqual(['#1d4ed8', '#ffffff', '', '', '', ''])
    expect(page.w.Shell.wear(null)).toBe(false)
    expect(worn(page).join('')).toBe('')
    expect(page.errors).toEqual([])
    page.close()
  })

  test('nothing is worn where a name is not one of the six, a value is not a colour, or what the frame writes could not be read', async () => {
    const page = await opened()
    for (const wrong of [
      { ...SOUND, '--ink': '#000000' },
      { ...SOUND, color: '#000000' },
      { ...SOUND, '--paper': 'url(https://example.com/x)' },
      { ...SOUND, '--green': 'red' },
      { ...SOUND, '--card': '#fff' },
      { ...SOUND, '--line': 7 },
      // White on a pale accent, an accent that is lost on the paper, and a paper the frame's ink is lost on
      { ...SOUND, '--green': '#f5d0a9' },
      { ...SOUND, '--green': '#efe6d8', '--on-green': '#1c1a16' },
      { ...SOUND, '--paper': '#2a2622' },
      { ...SOUND, '--card': '#55504a' },
      {},
      'green',
      ['#b4530c'],
    ]) {
      // Whatever was worn before is taken off, so that a refusal leaves the frame in its own colours
      page.w.Shell.wear(SOUND)
      expect(page.w.Shell.wear(wrong), JSON.stringify(wrong)).toBe(false)
      expect(worn(page).join(''), JSON.stringify(wrong)).toBe('')
    }
    expect(page.errors).toEqual([])
    page.close()
  })
})

describe('how the first page is put together', () => {
  const shell = readFileSync(new URL('./pages/start.html', import.meta.url), 'utf8')
  const part = (name: string, more: { section?: string; script?: string; style?: string; extra?: string } = {}) =>
    `${more.style ?? '<style>\n  [data-part="x"] { color: red; }\n</style>'}\n${
      more.section ?? `<section class="part" data-part="${name}" data-title="A ${name}" data-line="Do it." hidden><p id="${name}-p">x</p></section>`
    }\n${more.script ?? `<script>\nShell.part("${name}", (my) => {});\n</script>`}\n${more.extra ?? ''}`
  const reads = (files: Record<string, string>) => (name: string) => {
    if (!Object.hasOwn(files, name)) throw new Error('no such file')
    return files[name]!
  }

  test('each part named in pages.json is set into the shell where the shell marks the place for its styles, its section and its script, in that order', () => {
    const html = assembled(shell, ['one', 'two'], reads({ one: part('one'), two: part('two') }))
    expect(html.indexOf('data-part="one"')).toBeLessThan(html.indexOf('data-part="two"'))
    expect(html.indexOf('Shell.part("one"')).toBeLessThan(html.indexOf('Shell.part("two"'))
    expect(html.indexOf('Shell.part("two"')).toBeLessThan(html.indexOf('Shell.start()'))
    for (const mark of ['/*parts.css*/', '<!--parts.html-->', '<!--parts.js-->']) expect(html).not.toContain(mark)
    // And the page that is published is put together so, from the parts that are there
    const made = tourPage('start').html
    for (const step of STEPS) expect(made).toContain(`Shell.part("${step}"`)
    expect(Object.keys(JSON.parse(tourPage('start').state))).toEqual(STEPS)
  })

  test('a part that is named and not there, or that does not name itself, stops the build', () => {
    const good = { one: part('one') }
    expect(() => assembled(shell, ['one', 'gone'], reads(good))).toThrow('pages.json names the part "gone", and tour/parts/gone.html is not there')
    expect(() => assembled(shell, ['one'], reads({ one: part('other') }))).toThrow('tour/parts/one.html does not name itself')
    expect(() => assembled(shell, ['one'], reads({ one: part('one', { script: '<script>\nShell.part("other", () => {});\n</script>' }) }))).toThrow(
      'does not hand itself to the shell',
    )
    expect(() =>
      assembled(shell, ['one'], reads({ one: part('one', { section: '<section class="part" data-part="one" data-title="A" hidden></section>' }) })),
    ).toThrow('says its data-line')
    expect(() =>
      assembled(shell, ['one'], reads({ one: part('one', { section: '<section class="part" data-part="one" data-title="A" data-line="B"></section>' }) })),
    ).toThrow('is hidden until the shell shows it')
    expect(() => assembled(shell, ['one'], reads({ one: part('one', { script: '' }) }))).toThrow('holds 0 <script> elements')
    expect(() => assembled(shell, ['one'], reads({ one: part('one', { extra: '<p>loose</p>' }) }))).toThrow(
      'holds something outside its style, its section and its script',
    )
    expect(() => assembled(shell, ['One'], reads(good))).toThrow('is no name for a part')
    expect(() => assembled(shell, ['one', 'one'], reads(good))).toThrow('names a part of the first page twice')
    expect(() => assembled(shell, [], reads(good))).toThrow('gives the first page no parts')
  })

  test('two parts may not give an element the same id, since an element is found by its id from anywhere on the page', () => {
    const same = (name: string) =>
      part(name, { section: `<section class="part" data-part="${name}" data-title="A" data-line="B" hidden><p id="same">x</p></section>` })
    expect(() => assembled(shell, ['one', 'two'], reads({ one: same('one'), two: same('two') }))).toThrow('two elements with the id "same"')
  })

  test('a part is its styles, its one section and its one script', () => {
    const made = partOf('one', reads({ one: part('one') }))
    expect(made.section.startsWith('<section class="part" data-part="one"')).toBe(true)
    expect(made.script.startsWith('<script>')).toBe(true)
    expect(made.style).toBe('  [data-part="x"] { color: red; }')
  })
})

describe('the guide for the first page', () => {
  const part = GUIDE.slice(GUIDE.indexOf('\n## The first page'), GUIDE.indexOf('\n## If they ask to see more'))
  const page = tourPage('start').html
  /** The guide's section for one part of the page, by the name of an action the part sends. */
  const sectionFor = (action: string) => part.split(/^### /m).find((text) => text.split('\n')[0]!.includes(`\`${action}\``))!
  const examples = (text: string) =>
    [...text.matchAll(/^it tour answer <the action's id> '(\{[^']*)'$/gm)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>)

  test('shows the first page before anything else, and before the pairing link where no screen is paired', () => {
    expect([...GUIDE.matchAll(/^it tour show ([a-z]+)/gm)][0]![1]).toBe('start')
    expect(part).toContain('give them the link that `it site --no-open` prints')
    expect(part).toContain('`"asleep": true`')
  })

  test('names every action a part sends, in that part’s own section, and the page sends each it names', () => {
    const sends = [...page.matchAll(/(?:asker|my)\.send\("([a-z]+)"/g)].map((m) => m[1]!)
    expect([...new Set(sends)].sort()).toEqual(['beat', 'checked', 'design', 'finish', 'ideas', 'illegal', 'make', 'move', 'moved', 'point', 'turned'])
    for (const action of new Set(sends)) expect(sectionFor(action), action).toBeDefined()
    for (const heading of part.matchAll(/^### [^\n]*$/gm)) for (const named of heading[0].matchAll(/`([a-z]+)`/g)) expect(sends, named[1]).toContain(named[1])
  })

  test('answers each part with one `it tour answer`, in a shape the part reads, and never has the agent copy the request or patch the page', () => {
    const shapes = {
      moved: ['armchair', 'lamp', 'say'],
      checked: ['read', 'right', 'answer', 'hint', 'say', 'blind'],
      move: ['move', 'note'],
      turned: ['moves', 'say'],
      beat: ['pattern', 'bpm', 'swing', 'note'],
    }
    for (const [action, fields] of Object.entries(shapes)) {
      const given = examples(sectionFor(action))
      expect(given.length, action).toBeGreaterThan(0)
      // Every field an example gives is one the part reads from its answer, and none is the request, which the command sets itself
      const reads = page.slice(page.indexOf(`Shell.part("${{ moved: 'room', checked: 'board', move: 'chess', turned: 'cube', beat: 'drums' }[action]}"`))
      for (const example of given)
        for (const key of Object.keys(example)) {
          expect(fields, `${action} ${key}`).toContain(key)
          expect(reads, `${action} reads ${key}`).toMatch(new RegExp(`\\.${key}\\b`))
        }
      expect(given.some((example) => 'request' in example || 'part' in example)).toBe(false)
    }
    expect(part).not.toMatch(/^it patch tour-start/m)
    expect(part).not.toMatch(/^it (wait|ack|action|save) /m)
    expect(part).toContain('you never copy `part` or `request` into your answer')
    // Every example is small beside what a state may hold
    for (const example of examples(part)) expect(new TextEncoder().encode(JSON.stringify(example)).length).toBeLessThan(LIMITS.stateBytes / 100)
  })

  test('tells the agent to be quick, and what to do after each answer by what the command printed', () => {
    expect(GUIDE).toContain('a good answer now is worth more than a perfect one later')
    expect(part).toContain('Be quick. Do not deliberate')
    expect(part).toContain('`{"timedOut": true}`: nothing has happened yet. Run `it tour next`')
    expect(part).toContain('where `arrives.byItself` is `true`, end your turn, and anywhere else run `it tour next`')
    // The first rule, which every page of the tour goes by, sends the first page's waiting to those two commands
    const rule = GUIDE.split('\n').find((line) => line.startsWith('1. **Never block.**'))!
    expect(rule).toContain('On the first page that waiting is done for you by `it tour answer` and `it tour next`')
  })

  test('tells the agent that nothing in the tour touches the person’s things, and that the one file the tour makes is It’s to write and to delete', () => {
    expect(GUIDE).toContain("2. **Nothing in the tour touches the person's things.**")
    expect(GUIDE).toContain("Where a part's section asks you to look at something of theirs, you only read it.")
    const board = sectionFor('checked')
    expect(board).toContain('`saved` names a picture of the sheet, which It has already written for you in the folder you are in')
    expect(board).toContain('The command deletes the picture, so do not delete it yourself')
    expect(part).not.toContain('sheet.png')
  })

  test('has an agent that cannot view images say so with a flag, and neither mark the answer nor work it out from the lines', () => {
    const board = sectionFor('checked')
    expect(board).toContain('If you cannot view images, do not mark the answer, and do not work it out from `strokes` or from anything else: say so.')
    const blind = examples(board).find((example) => example.blind === true)!
    expect(Object.keys(blind)).toEqual(['blind', 'say'])
    // And the same where there is no picture to view
    expect(board).toContain('The same goes where `saved` is `null`')
  })
})
