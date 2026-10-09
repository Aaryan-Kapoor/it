// The tour: the guide an agent follows to show a new person what It is for, and the pages it
// shows as it goes. The pages are carried in the program, and each is filled in here with what
// it is to say before it is published like any other page.
import { Problem } from './lib'
import { GUIDE, PAGES } from './tour.generated'

export { GUIDE }
/** What the id of every page of the tour begins with, which is how they are found again to be removed. */
export const TOUR_PREFIX = 'tour-'
/** The page a person picks from, and the page the tour ends on. Neither is one of the things It is shown being. */
export const MENU = 'menu'
export const END = 'done'
/** The things a person is shown, in the order the tour goes on through them. */
export const STEPS = Object.keys(PAGES).filter((name) => name !== MENU && name !== END)
/** Every page of the tour, by name. */
export const NAMES = Object.keys(PAGES)

const escaped = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * One page of the tour, ready to publish: its id, its title, its HTML and the state it starts
 * with. `given` is set over what the page says by default. `agent` is the name of the agent
 * app that is giving the tour, which the page puts on the agent's plate.
 */
export function tourPage(name: string, given: Record<string, unknown> = {}, agent?: string): { slug: string; title: string; html: string; state: string } {
  const page = Object.hasOwn(PAGES, name) ? PAGES[name]! : null
  if (!page) throw new Problem(`The tour has no page called "${name}".`, 'invalid', `Its pages are: ${NAMES.join(', ')}.`)
  for (const key of Object.keys(given))
    if (!Object.hasOwn(page.params, key))
      throw new Problem(`The page "${name}" has nothing called "${key}".`, 'invalid', `It has: ${Object.keys(page.params).join(', ')}.`)
  const params: Record<string, unknown> = { ...page.params, ...given, tour_id: name, ...(agent ? { agent } : {}) }
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
