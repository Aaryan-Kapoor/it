// When the site asks for a star on GitHub: once five pages have been published, on the owner's grid
// of pages alone, and never again once it was answered, by a click or by being put away.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { STAR_AFTER, STAR_URL, StarAsk, type Where } from './star'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
beforeEach(() => {
  localStorage.clear()
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** The owner's browser on its grid of pages, connected, with five pages. */
const grid: Where = { pages: STAR_AFTER, owner: true, locked: false, path: '/', pairing: false, live: true }
const show = (where: Partial<Where> = {}) => act(async () => root.render(createElement(StarAsk, { ...grid, ...where })))
/** As the site is opened again: whatever this browser remembers is read afresh. */
async function reopen(where: Partial<Where> = {}) {
  await act(async () => root.unmount())
  root = createRoot(host)
  await show(where)
}
const link = () => host.querySelector<HTMLAnchorElement>('a')
const putAway = () => host.querySelector<HTMLButtonElement>('button')

describe('the ask for a star', () => {
  test('is five pages, and not four', async () => {
    expect(STAR_AFTER).toBe(5)
    await show({ pages: 4 })
    expect(host.innerHTML).toBe('')
    await show({ pages: undefined })
    expect(host.innerHTML).toBe('')
    await show({ pages: 5 })
    expect(link()).not.toBeNull()
    await show({ pages: 12 })
    expect(link()).not.toBeNull()
  })

  test('is a real link to the repository that tells GitHub nothing of this It, and a named button', async () => {
    await show()
    const a = link()!
    expect(a.getAttribute('href')).toBe('https://github.com/Aaryan-Kapoor/it')
    expect(STAR_URL).toBe('https://github.com/Aaryan-Kapoor/it')
    expect(a.target).toBe('_blank')
    expect(a.rel.split(' ').sort()).toEqual(['noopener', 'noreferrer'])
    expect(a.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(a.textContent).toMatch(/GitHub/)
    const b = putAway()!
    expect(b.type).toBe('button')
    expect(b.getAttribute('aria-label')).toBeTruthy()
    // Nothing is fetched for it: no image, no script, no frame
    expect(host.querySelector('img, script, iframe, link')).toBeNull()
  })

  test('once put away, is gone, and stays gone when the site is opened again', async () => {
    vi.useFakeTimers()
    await show()
    await act(async () => {
      putAway()!.click()
      vi.runAllTimers()
    })
    expect(host.innerHTML).toBe('')
    await reopen({ pages: 9 })
    expect(host.innerHTML).toBe('')
  })

  test('once its link is followed, is gone, and stays gone when the site is opened again', async () => {
    vi.useFakeTimers()
    await show()
    const a = link()!
    // A stand-in browser cannot open another tab: the real browser is where the link is followed
    a.addEventListener('click', (e) => e.preventDefault())
    await act(async () => {
      a.click()
      vi.runAllTimers()
    })
    expect(host.innerHTML).toBe('')
    await reopen()
    expect(host.innerHTML).toBe('')
  })

  test.each<[string, Partial<Where>]>([
    ['on a page being shown', { path: '/p/board' }],
    ['in the settings, beside the warnings there', { path: '/settings' }],
    ['on Machines or Displays', { path: '/machines' }],
    ['on a display locked to a page', { locked: true }],
    ['on a browser paired as a screen, such as a television', { owner: false }],
    ['while a code is being paired or offered', { pairing: true }],
    ['while It cannot be reached and the bar says so', { live: false }],
  ])('is not shown %s', async (_, where) => {
    await show(where)
    expect(host.innerHTML).toBe('')
  })

  test('opened in a tab of its own with the middle button, is answered all the same', async () => {
    vi.useFakeTimers()
    await show()
    await act(async () => {
      link()!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
      vi.runAllTimers()
    })
    expect(host.innerHTML).toBe('')
    await reopen()
    expect(host.innerHTML).toBe('')
  })

  test('answered in another tab of this browser, goes from this one too', async () => {
    await show()
    expect(link()).not.toBeNull()
    await act(async () => {
      localStorage.setItem('it.starAsked', '1')
      window.dispatchEvent(new StorageEvent('storage', { key: 'it.starAsked', newValue: '1' }))
    })
    expect(host.innerHTML).toBe('')
  })

  describe('in a bar with no room to spare for it', () => {
    let observers: (() => void)[]
    beforeEach(() => {
      observers = []
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(private fn: () => void) {
            observers.push(() => this.fn())
          }
          observe() {}
          disconnect() {}
        },
      )
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(220)
    })
    afterEach(() => vi.unstubAllGlobals())
    const visibility = () => host.querySelector<HTMLElement>('.star-ask')!.style.visibility

    test('is hidden from sight, the keyboard and a screen reader, and is shown again once there is room', async () => {
      const room = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(120)
      await show()
      expect(visibility()).toBe('hidden')
      room.mockReturnValue(400)
      await act(async () => {
        for (const fn of observers) fn()
      })
      expect(visibility()).toBe('')
    })
  })

  test('in a browser that keeps nothing, is not shown, and the site goes on', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    await show()
    expect(host.innerHTML).toBe('')
  })

  test('where the browser keeps nothing after it was shown, is still put away', async () => {
    vi.useFakeTimers()
    await show()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    await act(async () => {
      putAway()!.click()
      vi.runAllTimers()
    })
    expect(host.innerHTML).toBe('')
  })
})
