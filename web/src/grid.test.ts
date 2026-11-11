// A card's actions on the grid, in a stand-in browser with a stand-in backend: the button that
// opens them where a screen cannot hover, what it tells a screen reader, how the keyboard gets
// to them and away again, and that each action is what the tray does on a desktop.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const NOW = Date.UTC(2026, 10, 11, 12)
const card = (id: string, title: string, pinned = false) => ({
  id,
  slug: id,
  title,
  version: 1,
  updatedAt: NOW - 3_600_000,
  agent: 'claude-code',
  machine: 'the laptop',
  pending: 0,
  pinned,
})
const asked: { name: string; args: unknown }[] = []
vi.mock('convex/react', () => ({
  useAction: () => async () => null,
  useConvex: () => ({}),
  useMutation: (fn: unknown) => async (args: unknown) => void asked.push({ name: getFunctionName(fn as never), args }),
  useQuery: () => undefined,
}))
vi.mock('./session', () => ({ useSession: () => ({ service: undefined }) }))
vi.mock('./mount', () => ({ Mount: () => null }))
// The picture on a card has tests of its own
vi.mock('./preview', () => ({ Preview: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
async function grid(pages = [card('plan', 'Plan'), card('list', 'List', true)], owner = true) {
  const { Grid } = await import('./pages')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root.render(createElement(Grid, { pages, owner, query: '', onQuery: () => {} })))
}
const cardOf = (title: string) =>
  [...host.querySelectorAll<HTMLElement>('.page-card')].find((c) => c.querySelector('.card-title')?.textContent === title) as HTMLElement
const more = (title: string) => cardOf(title).querySelector<HTMLButtonElement>('.card-more') as HTMLButtonElement
const action = (title: string, name: string) => cardOf(title).querySelector<HTMLButtonElement>(`.card-action[aria-label="${name}"]`) as HTMLButtonElement
/** A press as a finger or a mouse makes it, which says it was a press. */
const press = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
  })
const open = (title: string) => cardOf(title).classList.contains('is-menu-open')
/** Opens a card's actions as Enter or Space on its button does, which takes the focus to the first of them. */
const openFromKeyboard = (title: string) =>
  act(async () => {
    more(title).focus()
    more(title).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    await new Promise((r) => requestAnimationFrame(r))
  })
/** Presses a button as Enter or Space does, where the focus is. */
const enter = (el: HTMLElement) =>
  act(async () => {
    el.focus()
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
  })

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.resetModules()
  asked.length = 0
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('the button that opens a card’s actions', () => {
  test('is on every card the owner sees, named for its page, and says which actions it opens and whether they are open', async () => {
    await grid()
    const button = more('Plan')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('aria-label')).toBe('Actions for Plan')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    const tray = host.querySelector(`#${button.getAttribute('aria-controls')}`)
    expect(tray?.classList.contains('card-actions')).toBe(true)
    expect(cardOf('Plan').contains(tray)).toBe(true)
    // It is not inside the link that opens the page, so a press on it opens nothing
    expect(button.closest('a')).toBeNull()
  })

  test('is not on a paired screen’s cards, which are offered no actions', async () => {
    await grid(undefined, false)
    expect(host.querySelectorAll('.card-more')).toHaveLength(0)
    expect(host.querySelectorAll('.card-actions')).toHaveLength(0)
  })

  test('opens its card’s actions and closes them again, and opening another card’s closes the first', async () => {
    await grid()
    await press(more('Plan'))
    expect(open('Plan')).toBe(true)
    expect(more('Plan').getAttribute('aria-expanded')).toBe('true')
    await press(more('List'))
    expect(open('Plan')).toBe(false)
    expect(open('List')).toBe(true)
    await press(more('List'))
    expect(open('List')).toBe(false)
    expect(more('List').getAttribute('aria-expanded')).toBe('false')
  })

  test('closes them when something else is pressed, and not when the card’s own actions are', async () => {
    await grid()
    await press(more('Plan'))
    await act(async () => void action('Plan', 'Pin').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(open('Plan')).toBe(true)
    await act(async () => void document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(open('Plan')).toBe(false)
  })

  test('opened from the keyboard takes the focus to the first action, and Escape closes them and gives the focus back', async () => {
    await grid()
    more('Plan').focus()
    // A button pressed with Enter or Space is clicked with no count of presses
    await act(async () => {
      more('Plan').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
      await new Promise((r) => requestAnimationFrame(r))
    })
    expect(document.activeElement).toBe(action('Plan', 'Copy link'))
    await act(async () => void document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(open('Plan')).toBe(false)
    expect(document.activeElement).toBe(more('Plan'))
  })

  test('opened with a press leaves the focus where it is', async () => {
    await grid()
    await press(more('Plan'))
    expect(document.activeElement).not.toBe(action('Plan', 'Copy link'))
  })
})

describe('the actions it opens', () => {
  test.each(['Copy link', 'Pin', 'Delete'])(
    'pressed from the keyboard, %s gives the focus back to the button that opened them, which they hide on closing',
    async (name) => {
      vi.spyOn(window, 'confirm').mockReturnValue(false)
      await grid()
      await openFromKeyboard('Plan')
      await enter(action('Plan', name))
      expect(open('Plan')).toBe(false)
      expect(document.activeElement).toBe(more('Plan'))
    },
  )

  test('on a screen that hovers, where no card’s actions are opened by the button, an action keeps the focus where it is', async () => {
    await grid()
    await enter(action('Plan', 'Pin'))
    expect(asked).toEqual([{ name: 'artifacts:organize', args: { artifactId: 'plan', pinned: true } }])
    expect(document.activeElement).toBe(action('Plan', 'Pin'))
  })

  test('pin a page and unpin one, as the desktop’s tray does, and close once pressed', async () => {
    await grid()
    await press(more('Plan'))
    await press(action('Plan', 'Pin'))
    expect(asked).toEqual([{ name: 'artifacts:organize', args: { artifactId: 'plan', pinned: true } }])
    expect(open('Plan')).toBe(false)
    await press(more('List'))
    expect(action('List', 'Unpin').getAttribute('aria-pressed')).toBe('true')
    await press(action('List', 'Unpin'))
    expect(asked[1]).toEqual({ name: 'artifacts:organize', args: { artifactId: 'list', pinned: false } })
    expect(open('List')).toBe(false)
  })

  test('delete a page only once the person has said yes to the same question the desktop asks, and close either way', async () => {
    await grid()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await press(more('Plan'))
    await press(action('Plan', 'Delete'))
    expect(confirm).toHaveBeenCalledWith('Delete “Plan”? It will leave every display.')
    expect(asked).toEqual([])
    expect(open('Plan')).toBe(false)
    confirm.mockReturnValue(true)
    await press(more('Plan'))
    await press(action('Plan', 'Delete'))
    expect(asked).toEqual([{ name: 'artifacts:remove', args: { artifactId: 'plan' } }])
    expect(open('Plan')).toBe(false)
  })
})

describe('the stylesheet', () => {
  const sheet = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8')
  const touch = sheet.slice(sheet.indexOf('@media (hover: none) {'))
  const block = touch.slice(0, touch.indexOf('\n}\n'))
  const rule = (selector: string) => {
    const at = block.indexOf(`  ${selector} {`)
    return at === -1 ? '' : block.slice(at, block.indexOf('}', at))
  }

  test('hides the button where a screen hovers, and shows it where it cannot', () => {
    expect(sheet).toMatch(/\n\.card-more \{\n {2}display: none;/)
    expect(rule('.card-more')).toContain('display: flex;')
  })

  test('keeps a closed tray from a press, the keyboard and a screen reader where a screen cannot hover, and shows an open one', () => {
    expect(rule('.card-actions')).toContain('visibility: hidden;')
    const opened = rule('.page-card.is-menu-open .card-actions')
    for (const said of ['opacity: 1;', 'pointer-events: auto;', 'visibility: visible;']) expect(opened).toContain(said)
  })
})
