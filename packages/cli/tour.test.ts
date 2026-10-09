// The tour: the guide an agent follows, and the pages it shows. What the guide tells an agent to
// run is held to the pages there are, what it tells the agent to expect of a page is held to
// what the page sends, and what a page is filled in with is held to its place in the page,
// since some of it is the agent's own words.
import { describe, expect, test } from 'vitest'
import { END, GUIDE, MENU, NAMES, STEPS, TOUR_PREFIX, tourPage } from './src/tour'

const params = (html: string) => JSON.parse(/window\.__PARAMS = (\{.*\})<\/script>/.exec(html)![1]!)

describe('the pages of the tour', () => {
  test('are a menu, the things it offers in the order the tour goes on through them, and an ending', () => {
    expect(NAMES).toEqual(['menu', 'whiteboard', 'chess', 'checklist', 'drums', 'button', 'done'])
    expect(STEPS).toEqual(['whiteboard', 'chess', 'checklist', 'drums', 'button'])
    expect([MENU, END]).toEqual(['menu', 'done'])
  })

  test('each is a whole page with an id of its own, what it is to say filled in, and the state it starts with', () => {
    for (const name of NAMES) {
      const page = tourPage(name)
      expect(page.slug).toBe(`${TOUR_PREFIX}${name}`)
      expect(page.title.length).toBeGreaterThan(0)
      expect(page.html.startsWith('<!doctype html>')).toBe(true)
      // Nothing is left for the page to say that was not said, and nothing of what the pages share is left to be set in
      expect(page.html, name).not.toMatch(/\{\{[a-z_]+\}\}/)
      expect(page.html, name).not.toMatch(/\/\*kit\.(css|js)\*\/|<!--rail-->/)
      expect(page.html).toContain('<script>window.__PARAMS = {')
      expect(params(page.html).tour_id).toBe(name)
      expect(typeof JSON.parse(page.state)).toBe('object')
      // It speaks to It through the script every page is given, and to nothing else
      expect(page.html).toMatch(/It\.(action|onState)\(/)
      expect(page.html, name).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|localStorage/)
    }
  })

  test('every thing carries the agent’s plate, the two lines of what each did, and the two buttons that go on', () => {
    for (const step of STEPS) {
      const { html } = tourPage(step)
      for (const id of ['t-plate', 't-you', 't-did', 't-more', 't-next']) expect(html, `${step} #${id}`).toContain(`id="${id}"`)
      // Each button is an ordinary action: the agent is what moves the tour on
      expect(html).toContain("go(more, 'menu'")
      expect(html).toContain("go(next, 'next'")
    }
    // The menu and the ending are ways on themselves
    expect(tourPage(MENU).html).not.toContain('id="t-next"')
    expect(tourPage(END).html).not.toContain('id="t-next"')
  })

  test('the name of the agent app that gives the tour is given to the page, for the plate, where it is known', () => {
    expect(params(tourPage('button', {}, 'Claude Code').html).agent).toBe('Claude Code')
    expect(params(tourPage('button').html).agent).toBeUndefined()
    // Unknown, the plate says whose agent it is
    expect(tourPage('button').html).toContain("'Your agent'")
  })

  test('what a page is told to say is set over what it says by default, and nothing it has no place for is taken', () => {
    const page = tourPage('whiteboard', { prompt: 'Draw the bug.' })
    expect(page.html).toContain('<h1 class="t-h">Draw the bug.</h1>')
    expect(() => tourPage('whiteboard', { colour: 'red' })).toThrow('The page "whiteboard" has nothing called "colour".')
    expect(() => tourPage('nothing')).toThrow('The tour has no page called "nothing".')
    // A name every object has is not a page
    expect(() => tourPage('constructor')).toThrow('The tour has no page called "constructor".')
  })

  test('words given to a page stay words, in its markup and in its script', () => {
    const page = tourPage('whiteboard', { prompt: '</script><script>alert(2)</script><img src=x onerror=alert(1)>' })
    expect(page.html).not.toContain('<img src=x')
    expect(page.html).not.toContain('</script><script>alert(2)')
    // And they arrive in the page's script as they were given
    expect(params(page.html).prompt).toBe('</script><script>alert(2)</script><img src=x onerror=alert(1)>')
    // The agent's name is words too
    expect(tourPage('button', {}, '</script><script>alert(3)</script>').html).not.toContain('</script><script>alert(3)')
  })
})

describe('the guide', () => {
  test('every page it tells the agent to show is one the tour has, or the next one, and every id it names is such a page’s', () => {
    const shown = [...GUIDE.matchAll(/^it tour show ([a-z]+)/gm)].map((m) => m[1]!)
    expect([...new Set(shown)].sort()).toEqual([...NAMES, 'next'].sort())
    const ids = [...GUIDE.matchAll(/\btour-([a-z]+)\b/g)].map((m) => m[1]!)
    expect(ids.length).toBeGreaterThan(8)
    for (const id of ids) expect(NAMES, `tour-${id}`).toContain(id)
  })

  test('every action it tells the agent to expect is one its page sends', () => {
    for (const [name, action] of [
      ['menu', 'pick'],
      ['menu', 'done'],
      ['whiteboard', 'snapshot'],
      ['chess', 'move'],
      ['chess', 'illegal'],
      ['chess', 'reset'],
      ['checklist', 'list'],
      ['drums', 'beat'],
      ['drums', 'cleared'],
      ['button', 'press'],
      ['done', 'finish'],
      ['done', 'menu'],
    ] as const) {
      expect(GUIDE, action).toContain(`\`${action}\``)
      expect(tourPage(name).html, `${name} sends ${action}`).toContain(`"${action}"`)
    }
    // And the two ways on that every thing has
    expect(GUIDE).toContain('**`next`**')
    expect(GUIDE).toContain('**`menu`**')
  })

  test('what it tells the agent to set in a page’s state is what the page reads', () => {
    for (const [name, key] of [
      ['whiteboard', 'agent_strokes'],
      ['whiteboard', 'note'],
      ['chess', 'reply'],
      ['checklist', 'added'],
      ['drums', 'theirs'],
      ['button', 'status'],
      ['button', 'note'],
    ] as const) {
      expect(GUIDE, `tour-${name} ${key}`).toMatch(new RegExp(`it (set tour-${name} ${key}\\b|patch tour-${name} '\\{[^']*"${key}")`))
      expect(tourPage(name).html, `${name} reads ${key}`).toMatch(new RegExp(`\\.${key}\\b|["']${key}["']`))
      // And the page starts with a place for it
      expect(Object.keys(JSON.parse(tourPage(name).state)), `${name} starts with ${key}`).toContain(key)
    }
  })

  test('a drawing is sent small enough for an action to hold', () => {
    // An action holds 32 KB. The picture is left out where it alone is larger than this, and the strokes are thinned to what is left
    expect(tourPage('whiteboard').html).toContain('png.length > 14000')
    expect(tourPage('whiteboard').html).toContain('budget = 30000 - (png ? png.length : 0)')
  })
})
