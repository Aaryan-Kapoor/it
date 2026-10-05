// The tour: the guide an agent follows to show a new person what It is for, and the pages it
// shows as it goes. The pages are carried in the program, and each is filled in here with what
// it is to say before it is published like any other page.
import { Problem } from './lib'
import { GUIDE, PAGES } from './tour.generated'

export { GUIDE }
/** What the id of every page of the tour begins with, which is how they are found again to be removed. */
export const TOUR_PREFIX = 'tour-'
/** The pages a person is led through, in order. The menu is the way in and is not counted among them. */
export const STEPS = Object.keys(PAGES).filter((name) => name !== 'menu')

const escaped = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * One page of the tour, ready to publish: its id, its title, its HTML and the state it starts
 * with. `given` is set over what the page says by default. `step` is the page's place in the
 * running order, which puts the bar with "Next" on it.
 */
export function tourPage(name: string, given: Record<string, unknown> = {}, step?: number): { slug: string; title: string; html: string; state: string } {
  const page = Object.hasOwn(PAGES, name) ? PAGES[name]! : null
  if (!page) throw new Problem(`The tour has no page called "${name}".`, 'invalid', `Its pages are: ${Object.keys(PAGES).join(', ')}.`)
  if (step !== undefined && (!Number.isInteger(step) || step < 1 || step > STEPS.length))
    throw new Problem(`--step is the page’s place in the tour, from 1 to ${STEPS.length}.`, 'invalid')
  for (const key of Object.keys(given))
    if (!Object.hasOwn(page.params, key))
      throw new Problem(`The page "${name}" has nothing called "${key}".`, 'invalid', `It has: ${Object.keys(page.params).join(', ')}.`)
  const params: Record<string, unknown> = {
    ...page.params,
    ...given,
    ...(step === undefined ? {} : { tour_step: `${step} of ${STEPS.length}`, tour_next: 'Next', tour_id: name }),
  }
  // What the page's markup says in words, and then everything, for its script. Written into a
  // script, the data must not be able to end the script it is in
  const said = page.html.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => {
    const value = params[key]
    return typeof value === 'string' || typeof value === 'number' ? escaped(String(value)) : ''
  })
  const data = JSON.stringify(params)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  const html = said.replace('<head>', () => `<head>\n<script>window.__PARAMS = ${data}</script>`)
  return {
    slug: `${TOUR_PREFIX}${name}`,
    title: typeof params.title === 'string' && params.title ? params.title : page.title,
    html,
    state: JSON.stringify(page.state),
  }
}
