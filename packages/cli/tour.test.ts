// The tour: the guide an agent follows, and the pages it shows. What the guide tells an agent to
// run is held to the pages there are, and what a page is filled in with is held to its place in
// the page, since some of it is the agent's own words.
import { describe, expect, test } from 'vitest'
import { GUIDE, STEPS, TOUR_PREFIX, tourPage } from './src/tour'

const NAMES = ['menu', ...STEPS]

describe('the pages of the tour', () => {
  test('each is a whole page with an id of its own, what it is to say filled in, and the state it starts with', () => {
    expect(STEPS).toEqual(['whiteboard', 'tictactoe', 'triage', 'mockup', 'gauge'])
    for (const name of NAMES) {
      const page = tourPage(name)
      expect(page.slug).toBe(`${TOUR_PREFIX}${name}`)
      expect(page.title.length).toBeGreaterThan(0)
      expect(page.html.startsWith('<!doctype html>')).toBe(true)
      // Nothing is left for the page to say that was not said
      expect(page.html).not.toMatch(/\{\{[a-z_]+\}\}/)
      expect(page.html).toContain('<script>window.__PARAMS = {')
      expect(typeof JSON.parse(page.state)).toBe('object')
      // It speaks to It through the script every page is given, and to nothing else
      expect(page.html).toMatch(/It\.(action|onState)\(/)
      expect(page.html).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|localStorage/)
    }
  })

  test('a page shown as a step of the tour carries the bar that goes on, and one shown by itself does not', () => {
    const params = (html: string) => JSON.parse(/window\.__PARAMS = (\{.*\})<\/script>/.exec(html)![1]!)
    expect(params(tourPage('gauge', {}, 5).html)).toMatchObject({ tour_step: '5 of 5', tour_next: 'Next', tour_id: 'gauge' })
    expect(params(tourPage('gauge').html).tour_step).toBeUndefined()
    for (const step of [0, 6, 1.5, Number.NaN]) expect(() => tourPage('gauge', {}, step)).toThrow('--step is the page’s place in the tour, from 1 to 5.')
  })

  test('what a page is told to say is set over what it says by default, and nothing it has no place for is taken', () => {
    const page = tourPage('whiteboard', { prompt: 'Draw the bug.' })
    expect(page.html).toContain('<span class="prompt">Draw the bug.</span>')
    expect(() => tourPage('whiteboard', { colour: 'red' })).toThrow('The page "whiteboard" has nothing called "colour".')
    expect(() => tourPage('nothing')).toThrow('The tour has no page called "nothing".')
    // A name every object has is not a page
    expect(() => tourPage('constructor')).toThrow('The tour has no page called "constructor".')
  })

  test('words given to a page stay words, in its markup and in its script', () => {
    const page = tourPage('whiteboard', { title: '<img src=x onerror=alert(1)>', prompt: '</script><script>alert(2)</script>' })
    expect(page.html).not.toContain('<img src=x')
    expect(page.html).not.toContain('</script><script>alert(2)')
    // And they arrive in the page's script as they were given
    const data = /window\.__PARAMS = (\{.*\})<\/script>/.exec(page.html)![1]!
    expect(JSON.parse(data).prompt).toBe('</script><script>alert(2)</script>')
  })
})

describe('the guide', () => {
  test('every page it tells the agent to show is one the tour has, and every id it names is such a page’s', () => {
    const shown = [...GUIDE.matchAll(/^it tour show ([a-z]+)/gm)].map((m) => m[1]!)
    expect([...new Set(shown)].sort()).toEqual([...NAMES].sort())
    const ids = [...GUIDE.matchAll(/\btour-([a-z]+)\b/g)].map((m) => m[1]!)
    expect(ids.length).toBeGreaterThan(10)
    for (const id of ids) expect(NAMES, `tour-${id}`).toContain(id)
  })

  test('every action it tells the agent to expect is one its page sends', () => {
    for (const [name, action] of [
      ['menu', 'pick'],
      ['whiteboard', 'snapshot'],
      ['tictactoe', 'move'],
      ['triage', 'ranked'],
      ['mockup', 'vote'],
    ] as const) {
      expect(GUIDE).toContain(`\`${action}\` action`)
      expect(tourPage(name).html).toContain(`It.action("${action}"`)
    }
    // Every step has the same way on
    for (const step of STEPS) expect(tourPage(step, {}, 1).html).toContain('It.action("next"')
  })

  test('a drawing is sent small enough for an action to hold', () => {
    // An action holds 32 KB. The picture is left out where it alone is larger than this, and the strokes are thinned to what is left
    expect(tourPage('whiteboard').html).toContain('png.length > 14000')
    expect(tourPage('whiteboard').html).toContain('var budget = 30000 - (png ? png.length : 0);')
  })
})
