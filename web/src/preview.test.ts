// A card's picture of its page, run in a stand-in browser with a stand-in backend. What it must
// get right here: a picture whose showing has run out is shown afresh, no oftener than now and
// then, and one that runs out again inside that while is not left as it is.
import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const calls: string[] = []
const client = {
  connectionState: () => ({ isWebSocketConnected: true }),
  mutation: vi.fn(async (fn: unknown) => {
    const name = getFunctionName(fn as never)
    calls.push(name)
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

beforeEach(() => {
  calls.length = 0
  localStorage.clear()
  localStorage.setItem('it.display', 'a-display-key-000001')
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
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
