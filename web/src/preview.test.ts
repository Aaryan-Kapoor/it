// A card's picture of its page, run in a stand-in browser with a stand-in backend. What it must
// get right here: every card on the screen is shown, a card that leaves the screen and comes back
// asks for no new showing, a picture that came too fast is asked for again, and a picture whose
// showing has run out is shown afresh, no oftener than now and then, and one that runs out again
// inside that while is not left as it is.
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const calls: string[] = []
/** What each showing was asked for with. */
const asked: Record<string, unknown>[] = []
/** What the backend answers the next showings asked for with, in place of a showing. */
const refusals: unknown[] = []
const client = {
  connectionState: () => ({ isWebSocketConnected: true }),
  mutation: vi.fn(async (fn: unknown, args: Record<string, unknown>) => {
    const name = getFunctionName(fn as never)
    calls.push(name)
    asked.push(args)
    if (refusals.length) throw refusals.shift()
    return { mountId: `mount-${calls.filter((c) => c === name).length}`, version: 7 }
  }),
  action: vi.fn(async (fn: unknown, args: { mountId: string }) => {
    calls.push(getFunctionName(fn as never))
    return { ticket: `ticket-for-${args.mountId}` }
  }),
}
const state = { json: '{"n":1}', revision: 3 }
vi.mock('convex/react', () => ({ useConvex: () => client, useQuery: () => state }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PAGES = `http://${location.hostname}:${Number(location.port) + 1}`
let root: Root
let host: HTMLElement
/** A turn of the machine's own, whatever the clock the test holds says: what is posted between a page and the site arrives in such turns. */
const realTimeout = setTimeout
const turn = () => new Promise<void>((r) => realTimeout(r, 1))
/** Waits, in turns of the machine's own, for something that is on its way and takes no time by the clock. */
async function arrived(what: () => boolean): Promise<void> {
  for (let turns = 0; !what(); turns++) {
    if (turns > 2000) throw new Error('what the test waited for did not arrive')
    await act(turn)
  }
}
const made = () => calls.filter((c) => c === 'mounts:create').length
const framedAt = (mount: number) => host.querySelector('iframe')?.src === `${PAGES}/open/ticket-for-mount-${mount}`
/** The picture's frame as it is now, once the page in it has said hello: the channel the site gave that page. */
async function greeted(): Promise<MessagePort> {
  const frame = host.querySelector('iframe') as HTMLIFrameElement
  const given: MessagePort[] = []
  const inside = frame.contentWindow as Window
  inside.postMessage = ((_data: unknown, _to: string, ports: MessagePort[] = []) => void given.push(...ports)) as never
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'it:hello', doc: 'doc-1' }, origin: 'null', source: inside }))
    await vi.advanceTimersByTimeAsync(20)
  })
  return given[0]!
}

/** What the browser says is on the screen, as the test says it: the watcher with no margin is the screen's, the other what is near it. */
const watchers: { near: boolean; callback: IntersectionObserverCallback; watched: Set<Element> }[] = []
class Watcher {
  watched = new Set<Element>()
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    watchers.push({ near: Boolean(options?.rootMargin), callback, watched: this.watched })
  }
  observe(el: Element) {
    this.watched.add(el)
  }
  unobserve(el: Element) {
    this.watched.delete(el)
  }
  disconnect() {
    this.watched.clear()
  }
}
/** The cards that are on the screen now, by their place on the grid. Nothing else is near it. */
async function scroll(inView: number[]) {
  const boxes = [...host.querySelectorAll('.card-shot')]
  await act(async () => {
    for (const w of watchers) {
      const entries = boxes
        .filter((b) => w.watched.has(b))
        .map((b) => ({ target: b, isIntersecting: inView.includes(boxes.indexOf(b)) }) as unknown as IntersectionObserverEntry)
      if (entries.length) w.callback(entries, w as never)
    }
    await vi.advanceTimersByTimeAsync(20)
  })
}

/** Cards on the grid, each a picture of a page of its own. */
async function grid(count: number) {
  const { Preview } = await import('./preview')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => {
    root.render(Array.from({ length: count }, (_, i) => createElement(Preview, { key: i, artifactId: `page${i}` as never, title: `Page ${i}`, cover: null })))
    await vi.advanceTimersByTimeAsync(20)
  })
}
const frames = () => [...host.querySelectorAll('iframe')]
const shown = (frame: HTMLIFrameElement) => frame.dataset.shown === 'true'
/** Every picture there is room for comes, as the pages in their frames say hello, a few at a time. */
async function allShown(count: number) {
  for (let round = 0; round < 40 && !(frames().length === count && frames().every(shown)); round++) {
    await act(turn)
    await act(async () => {
      for (const frame of frames().filter((f) => !shown(f))) {
        const inside = frame.contentWindow as Window
        inside.postMessage = (() => {}) as never
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'it:hello', doc: `doc-${frame.src}` }, origin: 'null', source: inside }))
      }
      await vi.advanceTimersByTimeAsync(20)
    })
  }
}

beforeEach(() => {
  calls.length = 0
  asked.length = 0
  refusals.length = 0
  watchers.length = 0
  localStorage.clear()
  localStorage.setItem('it.display', 'a-display-key-000001')
  // A computer of eight cores, which says nothing of its memory, as Firefox and Safari do not
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8, configurable: true })
  // Each test's grid is a grid of its own
  vi.resetModules()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('every card on the screen shows its page, fourteen of them at once, and each is asked for as a picture', async () => {
  vi.useFakeTimers()
  await grid(14)
  await allShown(14)
  expect([frames().length, frames().filter(shown).length, made()]).toEqual([14, 14, 14])
  expect(asked.every((a) => a.picture === true)).toBe(true)
})

test('a card that leaves the screen and comes back keeps its picture, and no new showing is asked for', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', Watcher)
  await grid(3)
  await scroll([0, 1, 2])
  await allShown(3)
  expect(made()).toBe(3)
  await scroll([])
  expect(frames().filter(shown).length).toBe(3)
  await scroll([0, 1, 2])
  await act(() => vi.advanceTimersByTimeAsync(10_000))
  expect([frames().filter(shown).length, made()]).toEqual([3, 3])
})

test('a picture the backend says came too fast is asked for again once the backend’s moment has passed, and not before', async () => {
  vi.useFakeTimers()
  refusals.push(new ConvexError({ code: 'rate_limited', message: 'Too many requests. Try again shortly.', retryAfterMs: 5000 }))
  await grid(1)
  await act(turn)
  expect([made(), frames().length]).toEqual([1, 0])
  await act(() => vi.advanceTimersByTimeAsync(4900))
  expect(made()).toBe(1)
  await act(() => vi.advanceTimersByTimeAsync(200))
  await allShown(1)
  expect([made(), frames().filter(shown).length]).toEqual([2, 1])
})

test('a picture the backend refuses for another reason keeps its cover, and is not asked for again', async () => {
  vi.useFakeTimers()
  refusals.push(new ConvexError({ code: 'not_found', message: 'That page has nothing published yet.' }))
  await grid(1)
  await act(() => vi.advanceTimersByTimeAsync(120_000))
  expect([made(), frames().length]).toEqual([1, 0])
})

test('a picture whose showing is over again soon after it was shown afresh is not left as it is: it is shown afresh once more when that while has passed', async () => {
  vi.useFakeTimers()
  const { Preview } = await import('./preview')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => {
    root.render(createElement(Preview, { artifactId: 'page1' as never, title: 'Plan', cover: null }))
    await vi.advanceTimersByTimeAsync(20)
  })
  await arrived(() => framedAt(1))
  const first = await greeted()
  // What the script in the page says when the content service refuses its token
  first.postMessage({ type: 'it:lapsed' })
  await arrived(() => framedAt(2))
  // The content service is started again a second later, and the picture shown just now finds its showing over as well
  await act(() => vi.advanceTimersByTimeAsync(1000))
  const second = await greeted()
  const waiting = vi.getTimerCount()
  second.postMessage({ type: 'it:lapsed' })
  await arrived(() => vi.getTimerCount() > waiting)
  // Not at once, which is what keeps a picture that cannot be shown from being asked for in a loop
  expect(made()).toBe(2)
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  await arrived(() => framedAt(3))
  // And once: nothing more is asked for while the picture that is shown now says nothing
  await act(() => vi.advanceTimersByTimeAsync(120_000))
  expect(made()).toBe(3)
})
