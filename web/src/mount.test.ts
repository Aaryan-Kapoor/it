// The frame around a page, run in a stand-in browser with a stand-in backend. What it must get
// right: a showing is framed at the pages' port with its one ticket and in a sandbox, a message
// is the page's only if it came from that frame's window, each document in the frame gets one
// channel and no more, and what the site says about whether the person was at the page is the
// site's own judgement, never the page's.

import { CHANNEL_VERSION, LIMITS } from '@it/protocol'
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const calls: { fn: string; args: any }[] = []
/** What the stand-in backend says when it is asked for a ticket: one, or a refusal. */
let refuseTicket = false
/** How many more times the stand-in backend fails, with no word of why, when it is asked for a ticket. */
let troubled = 0
const client = {
  connectionState: () => ({ isWebSocketConnected: true }),
  mutation: vi.fn(async (fn: unknown, args: unknown) => {
    const name = getFunctionName(fn as never)
    if (name === 'actions:replayGrant') return { until: Date.now() + 6 * 86400_000 }
    calls.push({ fn: name, args })
    if (name === 'mounts:create') return { mountId: `mount-${calls.filter((c) => c.fn === name).length}`, version: 7 }
    if (name === 'actions:submit') return { actionId: 'action-1' }
    if (name === 'state:store') {
      if (storeRefusal) throw new ConvexError(storeRefusal)
      return { revision: 4 }
    }
    return null
  }),
  action: vi.fn(async (fn: unknown, args: { mountId: string }) => {
    calls.push({ fn: getFunctionName(fn as never), args })
    if (refuseTicket) throw new ConvexError({ code: 'conflict', message: 'No ticket is available for that.' })
    if (troubled-- > 0) throw new Error('[CONVEX A(mounts:ticket)] [Request ID: 0123456789abcdef] Server Error\n  Called by client')
    return { ticket: `ticket-for-${args.mountId}` }
  }),
}
/** What the stand-in backend refuses a page's write of what it keeps with, where it refuses it. */
let storeRefusal: Record<string, string | number> | null = null
// The page's state, which is the same thing each time it is asked for until it changes: whole
// to a display that has none, and nothing new to one that has this revision. `changed` is what
// the backend answers next to a display that has it, where something has changed
const state = { revision: 3, whole: true, state: '{"n":1}', kept: [] as [string, string | null][] }
let changed: Record<string, unknown> | null = null
vi.mock('convex/react', () => ({
  useConvex: () => client,
  useQuery: (_fn: unknown, args: { since?: number }) =>
    args.since === undefined ? state : changed && args.since < (changed.revision as number) ? changed : { revision: args.since },
}))

// Where pages are shown from: the name the site itself was reached by, on the port after its own
const PAGES = `http://${location.hostname}:${Number(location.port) + 1}`
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
let root: Root
let host: HTMLElement
let active = false
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Puts a page on the screen, as far as the frame the site makes for it. */
async function render() {
  const { Mount } = await import('./mount')
  const { outboxBelongsTo } = await import('./outbox')
  outboxBelongsTo('alice')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => {
    root.render(createElement(Mount, { artifactId: 'page1' as never, title: 'Plan', user: 'alice' }))
    await tick()
  })
}
/** Draws the page again, as the site does when what it shows changes: here, when the backend has something new to say. */
async function rerender() {
  const { Mount } = await import('./mount')
  await act(async () => {
    root.render(createElement(Mount, { artifactId: 'page1' as never, title: 'Plan', user: 'alice' }))
    await tick()
  })
}
/** Puts a page on the screen with the clock held, so that a test says how much time passes. */
async function renderHeld() {
  vi.useFakeTimers()
  const { Mount } = await import('./mount')
  const { outboxBelongsTo } = await import('./outbox')
  outboxBelongsTo('alice')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => {
    root.render(createElement(Mount, { artifactId: 'page1' as never, title: 'Plan', user: 'alice' }))
    await vi.advanceTimersByTimeAsync(20)
  })
}
/** A turn of the machine's own, whatever the clock a test holds says: what was posted between a page and the site arrives in such turns. */
const realTimeout = setTimeout
const turn = () => new Promise<void>((r) => realTimeout(r, 1))
/** Waits, in turns of the machine's own, for something that is on its way and takes no time by the clock. */
async function arrived(what: () => boolean): Promise<void> {
  for (let turns = 0; !what(); turns++) {
    if (turns > 2000) throw new Error('what the test waited for did not arrive')
    await act(turn)
  }
}
/** The frame the site is showing now, with what the site posts into it written down. */
function framed() {
  const frame = host.querySelector('iframe') as HTMLIFrameElement
  /** What the site posted into the frame, with the ports it handed over. */
  const posted: { data: any; to: string; ports: MessagePort[] }[] = []
  const inside = frame.contentWindow as Window
  inside.postMessage = ((data: unknown, to: string, ports: MessagePort[] = []) => void posted.push({ data, to, ports })) as never
  // A sandboxed page has no origin of its own to name: a browser gives "null" for it
  const fromFrame = (data: unknown, origin = 'null', source: Window = inside) =>
    act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data, origin, source }))
      await tick()
    })
  const ports = () => posted.filter((p) => p.data.type === 'it:port').map((p) => p.ports[0]!)
  /** Sends something on a channel as the page would, and gives back what the site answered. */
  const send = async (port: MessagePort, message: unknown, waitMs = 60) => {
    const heard: any[] = []
    port.onmessage = (m) => heard.push(m.data)
    port.postMessage(message)
    await act(() => tick(waitMs))
    return heard
  }
  return { frame, fromFrame, ports, send, posted }
}
/** Shows a page, up to the point where the page's own script can say hello. */
async function show() {
  await render()
  return framed()
}
const action = (id: string) => ({
  type: 'it:action',
  requestId: `r-${id}`,
  envelope: { clientActionId: id, name: 'approve', payload: { plan: 'B' }, contentVersion: 1 },
})
const submitted = () => calls.filter((c) => c.fn === 'actions:submit').map((c) => c.args.envelope)
const asked = (fn: string) => calls.filter((c) => c.fn === fn)

beforeEach(() => {
  calls.length = 0
  storeRefusal = null
  changed = null
  refuseTicket = false
  troubled = 0
  client.action.mockClear()
  localStorage.clear()
  localStorage.setItem('it.display', 'a-display-key-000001')
  active = false
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: {
      get isActive() {
        return active
      },
    },
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('where a page is shown', () => {
  test('a showing is framed at the port after the site’s, on the name the site itself was reached by, with its one ticket as the last part of the address', async () => {
    const page = await show()
    expect(location.port).not.toBe('')
    expect(page.frame.src).toBe(`${PAGES}/open/ticket-for-mount-1`)
    // The mount is made, then its ticket is asked for, once each
    expect(calls.map((c) => [c.fn, c.args.mountId])).toEqual([
      ['mounts:create', undefined],
      ['mounts:ticket', 'mount-1'],
    ])
    expect(page.frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  test('the frame is a sandbox: a page is given no origin, cannot move the tab, and what it opens is held to the same', async () => {
    const page = await show()
    // Word for word what the content service says on everything it sends
    expect(page.frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock')
    for (const word of ['allow-same-origin', 'allow-top-navigation', 'allow-popups-to-escape-sandbox'])
      expect(page.frame.getAttribute('sandbox')).not.toContain(word)
  })

  test('a message is the page’s only if it came from the frame’s own window, whatever origin it names', async () => {
    const page = await show()
    const other = document.body.appendChild(document.createElement('iframe'))
    // Another window saying what a page would say, under any origin: the pages' port, the site's own, none
    for (const origin of [PAGES, location.origin, 'null', 'https://elsewhere.test']) {
      await page.fromFrame({ type: 'it:hello', doc: 'doc-1' }, origin, window)
      await page.fromFrame({ type: 'it:hello', doc: 'doc-1' }, origin, other.contentWindow as Window)
    }
    expect(page.ports().length).toBe(0)
    other.remove()
    // The frame's own window is believed, under whatever origin the browser gives for it
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    await page.fromFrame({ type: 'it:hello', doc: 'doc-2' }, PAGES)
    expect(page.ports().length).toBe(2)
    // The channel is handed to whatever document is in the frame: there is no origin to hand it to
    expect(page.posted.map((p) => [p.data.type, p.to])).toEqual([
      ['it:port', '*'],
      ['it:port', '*'],
    ])
  })

  test('the frame is kept out of sight until the page’s own script says hello', async () => {
    const page = await show()
    expect([page.frame.dataset.shown, host.textContent]).toEqual(['false', 'Opening…'])
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    expect([page.frame.dataset.shown, host.textContent]).toEqual(['true', ''])
  })

  test('with no ticket given there is nothing to frame, and the person is told the page could not be opened', async () => {
    refuseTicket = true
    await render()
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.textContent).toContain('No ticket is available for that.')
    expect(host.textContent).toContain('It will try again by itself.')
    expect(asked('mounts:create').length).toBe(1)
    expect(asked('mounts:ticket').length).toBe(1)
  })

  test('a showing that met trouble on its way is begun afresh by itself, once, and one the second asking got through is framed with nothing said or written', async () => {
    const written = vi.spyOn(console, 'error').mockImplementation(() => {})
    troubled = 1
    await renderHeld()
    expect([host.querySelector('iframe'), host.textContent]).toEqual([null, 'Opening…'])
    await act(() => vi.advanceTimersByTimeAsync(2000))
    // A mount of its own for the second asking: the first got no ticket, and is left behind
    expect(asked('mounts:ticket').map((c) => c.args.mountId)).toEqual(['mount-1', 'mount-2'])
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe(`${PAGES}/open/ticket-for-mount-2`)
    expect(host.textContent).toBe('Opening…')
    expect(written).not.toHaveBeenCalled()
  })

  test('a showing that met trouble both times is said to have failed, and the trouble is written as an error once', async () => {
    const written = vi.spyOn(console, 'error').mockImplementation(() => {})
    troubled = 2
    await renderHeld()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.textContent).toContain('Something went wrong. Try again.')
    expect(host.textContent).toContain('It will try again by itself.')
    expect(asked('mounts:ticket').length).toBe(2)
    expect(written.mock.calls).toEqual([['[CONVEX A(mounts:ticket)] [Request ID: 0123456789abcdef] Server Error']])
  })

  test('a showing that met trouble and is on the screen no more by the time of the second asking is not begun afresh', async () => {
    const written = vi.spyOn(console, 'error').mockImplementation(() => {})
    troubled = 1
    await renderHeld()
    await act(async () => root.unmount())
    await vi.advanceTimersByTimeAsync(2000)
    expect(asked('mounts:create').length).toBe(1)
    expect(written).not.toHaveBeenCalled()
    root = createRoot(host)
  })

  test('when the page says its showing is over, the site asks for a new mount and a new ticket and frames the page again, and not in a loop', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    // What the script in the page says when the content service refuses its token: the showing
    // ran out, the display was signed out, or the service started again
    await page.send(page.ports()[0]!, { type: 'it:lapsed' })
    expect(asked('mounts:create').length).toBe(2)
    expect(asked('mounts:ticket').map((c) => c.args.mountId)).toEqual(['mount-1', 'mount-2'])
    const again = framed()
    expect(again.frame).not.toBe(page.frame)
    expect(again.frame.src).toBe(`${PAGES}/open/ticket-for-mount-2`)
    expect(again.frame.dataset.shown).toBe('false')
    // The frame before it is gone, and with it the document that was in it
    expect(host.querySelectorAll('iframe').length).toBe(1)
    await again.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    expect(again.frame.dataset.shown).toBe('true')
    // A page that says so again at once is not shown a third time
    await again.send(again.ports()[0]!, { type: 'it:lapsed' })
    expect(asked('mounts:create').length).toBe(2)
  })

  test('a showing that is over again soon after the page was framed again is not left as it is: the page is framed once more when that while has passed', async () => {
    await renderHeld()
    /** The frame the site is showing now, once the page in it has said hello and has its channel. */
    const greeted = async () => {
      const page = framed()
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'it:hello', doc: 'doc-1' }, origin: 'null', source: page.frame.contentWindow }))
        await vi.advanceTimersByTimeAsync(20)
      })
      return page
    }
    const page = await greeted()
    page.ports()[0]!.postMessage({ type: 'it:lapsed' })
    await arrived(() => host.querySelector('iframe')?.src === `${PAGES}/open/ticket-for-mount-2`)
    // The content service is started again a second later, and the page framed just now finds its showing over as well
    await act(() => vi.advanceTimersByTimeAsync(1000))
    const again = await greeted()
    const waiting = vi.getTimerCount()
    again.ports()[0]!.postMessage({ type: 'it:lapsed' })
    await arrived(() => vi.getTimerCount() > waiting)
    // Not at once, which is what keeps a page that cannot be shown from being asked for in a loop
    expect(asked('mounts:create').length).toBe(2)
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    await arrived(() => host.querySelector('iframe')?.src === `${PAGES}/open/ticket-for-mount-3`)
    // And once: nothing more is asked for while the page that is framed now says nothing
    await act(() => vi.advanceTimersByTimeAsync(15_000))
    expect(asked('mounts:create').length).toBe(3)
  })

  test('a frame whose page never says hello is given up on, and the site tries again by itself with a new mount', async () => {
    vi.useFakeTimers()
    const { Mount } = await import('./mount')
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => {
      root.render(createElement(Mount, { artifactId: 'page1' as never, title: 'Plan', user: 'alice' }))
      await vi.advanceTimersByTimeAsync(20)
    })
    // The address was refused, or nothing answered at it: either way no page is there to say hello
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe(`${PAGES}/open/ticket-for-mount-1`)
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.textContent).toContain('The page did not load.')
    expect(asked('mounts:create').length).toBe(1)
    await act(() => vi.advanceTimersByTimeAsync(5_000))
    expect(asked('mounts:create').length).toBe(2)
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe(`${PAGES}/open/ticket-for-mount-2`)
  })
})

describe('the frame around a page', () => {
  test('a document is given one channel however often it says hello, and the next document gets its own', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    expect(page.ports().length).toBe(1)
    // The channel works, and carries the page's state to it at once
    const first = page.ports()[0]!
    const heard = await page.send(first, action('click-0001'))
    expect(heard).toEqual([
      { type: 'it:state', state: { n: 1 }, revision: 3 },
      { type: 'it:result', requestId: 'r-click-0001', ok: true, actionId: 'action-1' },
    ])
    // The frame goes to another of the page's documents: a new channel, and the old one is closed
    await page.fromFrame({ type: 'it:hello', doc: 'doc-2' })
    expect(page.ports().length).toBe(2)
    await page.send(first, action('click-0002'))
    expect(submitted().map((e) => e.clientActionId)).toEqual(['click-0001'])
    // Which version the person was looking at is what the site showed them, not what the page says of itself
    expect(submitted()[0]!.contentVersion).toBe(7)
    await page.send(page.ports()[1]!, action('click-0003'))
    expect(submitted().map((e) => e.clientActionId)).toEqual(['click-0001', 'click-0003'])
  })

  test('nothing a page says gets it a second ticket, or anything but a channel for itself', async () => {
    const page = await show()
    for (const type of ['ready', 'ticket', 'mounted', 'it:port', 'it:state', 'it:lapsed', 'it:action']) await page.fromFrame({ type, doc: 'doc-1' })
    expect(page.posted).toEqual([])
    expect(asked('mounts:ticket').length).toBe(1)
    expect(asked('mounts:create').length).toBe(1)
    // A hello that names no document is not from the script It put in the page
    for (const doc of [undefined, '', 7, { toString: () => 'doc-1' }]) await page.fromFrame({ type: 'it:hello', doc })
    expect(page.ports().length).toBe(0)
  })

  test('whether the person was at the page is said by the site, whatever the page claims', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const port = page.ports()[0]!
    // Nobody has done anything in the page: the frame does not even have the keyboard
    await page.send(port, { ...action('click-0010'), envelope: { ...action('click-0010').envelope, attended: true } })
    expect(submitted().at(-1)).toMatchObject({ clientActionId: 'click-0010', attended: false, payload: '{"plan":"B"}' })
    // The frame has the keyboard, and the browser says the person has just acted
    page.frame.setAttribute('tabindex', '0')
    page.frame.focus()
    expect(document.activeElement).toBe(page.frame)
    active = true
    await page.send(port, action('click-0011'))
    expect(submitted().at(-1)).toMatchObject({ clientActionId: 'click-0011', attended: true })
  })

  test('a click on the site itself is not taken for the person acting in the page', async () => {
    // The clock is the test's: a browser goes on saying that the person has just acted for some
    // seconds after a click, and the site waits those seconds out, so they are passed by hand
    await renderHeld()
    const page = framed()
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'it:hello', doc: 'doc-1' }, origin: 'null', source: page.frame.contentWindow }))
      await vi.advanceTimersByTimeAsync(20)
    })
    const port = page.ports()[0]!
    port.onmessage = () => {}
    page.frame.setAttribute('tabindex', '0')
    /** Sends an action as the page would, and waits until the site has it and has begun to wait out the click on itself. */
    const sends = async (id: string) => {
      const waiting = vi.getTimerCount()
      port.postMessage(action(id))
      await arrived(() => vi.getTimerCount() > waiting)
    }
    const passes = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
    const sent = (id: string) => arrived(() => submitted().some((envelope) => envelope.clientActionId === id))
    // The person clicks the site (the card that opened the page, say). The browser reports that
    // for a few seconds, and the page takes the keyboard for itself and sends at once.
    window.dispatchEvent(new Event('pointerdown'))
    page.frame.focus()
    active = true
    await sends('click-0020')
    // Nothing is sent on while it cannot be told whose click the browser means
    await passes(4000)
    expect(submitted()).toEqual([])
    active = false
    await passes(1600)
    await sent('click-0020')
    expect(submitted().at(-1)).toMatchObject({ clientActionId: 'click-0020', attended: false })
    // The same, but the person really does click in the page a moment later: the browser is
    // still reporting that once the site's own click has worn off
    window.dispatchEvent(new Event('pointerdown'))
    active = true
    await sends('click-0021')
    await passes(5600)
    await sent('click-0021')
    expect(submitted().at(-1)).toMatchObject({ clientActionId: 'click-0021', attended: true })
  })

  test('a small message that would write out as an enormous one is refused before it is written out', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const port = page.ports()[0]!
    // Each level names the one below it twice: thirty levels is a few hundred bytes to send,
    // and a thousand million objects written out
    let bomb: unknown = { x: 1 }
    for (let i = 0; i < 30; i++) bomb = { a: bomb, b: bomb }
    const started = Date.now()
    const asAction = await page.send(port, {
      type: 'it:action',
      requestId: 'r-bomb',
      envelope: { clientActionId: 'click-9000', name: 'approve', payload: bomb, contentVersion: 1 },
    })
    // What the page keeps comes as text, which the script in the page wrote out within its own bounds: anything else is refused unread
    const asStored = await page.send(port, { type: 'it:store', requestId: 'r-bomb-2', changes: [['k', bomb]] } as never)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(asAction.find((m) => m.requestId === 'r-bomb')).toMatchObject({ ok: false, error: 'That is too large to send.' })
    expect(asStored.find((m) => m.requestId === 'r-bomb-2')).toMatchObject({ ok: false, error: 'That cannot be sent.' })
    expect(calls.some((c) => c.fn === 'actions:submit' || c.fn === 'state:store')).toBe(false)
    // Nor is anything that is not plain data unpacked to see how big it is: a block of bytes,
    // a list that is mostly holes
    const bytes = await page.send(port, {
      type: 'it:action',
      requestId: 'r-bytes',
      envelope: { clientActionId: 'click-9001', name: 'approve', payload: new Uint8Array(5_000_000), contentVersion: 1 },
    })
    expect(bytes.find((m) => m.requestId === 'r-bytes')).toMatchObject({ ok: false, error: 'That cannot be sent.' })
    const holes = await page.send(port, { type: 'it:store', requestId: 'r-holes', changes: new Array(50_000_000) } as never)
    expect(holes.find((m) => m.requestId === 'r-holes')).toMatchObject({ ok: false, error: 'One write keeps 1 to 500 values.' })
    expect(Date.now() - started).toBeLessThan(4000)
    // The same goes for what should be a name or an id: a thing that is not text is never written out to see
    const nested = (levels: number) => {
      let v: unknown = ['x']
      for (let i = 0; i < levels; i++) v = [v, v]
      return v
    }
    const before = calls.length
    const odd = await page.send(port, {
      type: 'it:action',
      requestId: nested(28),
      envelope: { clientActionId: nested(28), name: nested(28), payload: {}, contentVersion: nested(28) },
    })
    expect(odd.filter((m) => m.type === 'it:result').length).toBe(1)
    expect(odd.find((m) => m.type === 'it:result')).toMatchObject({ requestId: '', ok: false })
    await page.fromFrame({ type: 'it:hello', doc: nested(28) })
    expect(calls.length).toBe(before)
    expect(Date.now() - started).toBeLessThan(5000)
    // A name for a stored value that is not one never reaches the backend either
    const badKey = await page.send(port, { type: 'it:store', requestId: 'r-key', changes: [['x'.repeat(100_000), '1']] } as never)
    expect(badKey.find((m) => m.requestId === 'r-key')).toMatchObject({ ok: false, error: /store key/ })
    expect(calls.some((c) => c.fn === 'state:store')).toBe(false)
  })

  test('a page’s channel says that it takes several stored values at once, and what the page keeps goes to the backend as one write', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    expect(page.posted.find((p) => p.data.type === 'it:port')?.data).toEqual({ type: 'it:port', v: CHANNEL_VERSION })
    const port = page.ports()[0]!
    const heard = await page.send(port, {
      type: 'it:store',
      requestId: 'r-keep',
      changes: [
        ['stroke-1', '{"x":1}'],
        ['stroke-2', 'null'],
      ],
    })
    expect(heard.find((m) => m.requestId === 'r-keep')).toEqual({ type: 'it:result', requestId: 'r-keep', ok: true, revision: 4 })
    expect(asked('state:store').map((c) => c.args)).toEqual([
      {
        artifactId: 'page1',
        changes: [
          { key: 'stroke-1', value: '{"x":1}' },
          { key: 'stroke-2', value: 'null' },
        ],
      },
    ])
    // Refused for coming too fast, the page is told how long to wait, as the backend said
    storeRefusal = { code: 'rate_limited', message: 'Too many requests. Try again shortly.', retryAfterMs: 1234 }
    const slow = await page.send(port, { type: 'it:store', requestId: 'r-slow', changes: [['a', '1']] })
    expect(slow.find((m) => m.requestId === 'r-slow')).toEqual({
      type: 'it:result',
      requestId: 'r-slow',
      ok: false,
      error: 'Too many requests. Try again shortly.',
      retryAfterMs: 1234,
    })
    // Refused for good, it is told why and no more
    storeRefusal = { code: 'limit', message: "A page's state is at most 512 KB." }
    const full = await page.send(port, { type: 'it:store', requestId: 'r-full', changes: [['a', '1']] })
    expect(full.find((m) => m.requestId === 'r-full')).toEqual({
      type: 'it:result',
      requestId: 'r-full',
      ok: false,
      error: "A page's state is at most 512 KB.",
    })
    // What the backend would refuse anyway is refused here, unsent
    storeRefusal = null
    const before = asked('state:store').length
    for (const [changes, error] of [
      [[], 'One write keeps 1 to 500 values.'],
      [[['a', 1]], 'That cannot be sent.'],
      [[['a.b', '1']], /store key/],
      [[['a', JSON.stringify('x'.repeat(LIMITS.storeValueBytes))]], 'A stored value is at most 32 KB.'],
      [Array.from({ length: 20 }, (_, i) => [`k${i}`, JSON.stringify('x'.repeat(30 * 1024))]), "A page's state is at most 512 KB."],
    ] as const) {
      const said = await page.send(port, { type: 'it:store', requestId: 'r-bad', changes })
      expect(said.find((m) => m.requestId === 'r-bad')).toMatchObject({ ok: false, error })
    }
    expect(asked('state:store').length).toBe(before)
  })

  test('one value sent by itself, as a page’s script sends it to a site that takes one at a time, is kept as one write', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const port = page.ports()[0]!
    const heard = await page.send(port, { type: 'it:store', requestId: 'r-one', key: 'draft', value: { text: 'hello' } })
    expect(heard.find((m) => m.requestId === 'r-one')).toEqual({ type: 'it:result', requestId: 'r-one', ok: true, revision: 4 })
    // Written out as JSON here, as the value it is, and not taken for JSON text already
    const said = await page.send(port, { type: 'it:store', requestId: 'r-text', key: 'note', value: 'plain words' })
    expect(said.find((m) => m.requestId === 'r-text')).toMatchObject({ ok: true })
    expect(asked('state:store').map((c) => c.args.changes)).toEqual([[{ key: 'draft', value: '{"text":"hello"}' }], [{ key: 'note', value: '"plain words"' }]])
    // And held to the same rules as several
    const before = asked('state:store').length
    for (const [key, value, error] of [
      ['a.b', 1, /store key/],
      ['k', new Date(), 'That cannot be sent.'],
      ['k', 'x'.repeat(LIMITS.storeValueBytes), 'A stored value is at most 32 KB.'],
    ] as const) {
      const refused = await page.send(port, { type: 'it:store', requestId: 'r-bad', key, value })
      expect(refused.find((m) => m.requestId === 'r-bad')).toMatchObject({ ok: false, error })
    }
    expect(asked('state:store').length).toBe(before)
  })

  test('what a page may keep at once is counted apart from its actions, and a page past it is told how long to wait', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const port = page.ports()[0]!
    const heard: any[] = []
    port.onmessage = (m) => heard.push(m.data)
    for (let i = 0; i < 60; i++) port.postMessage({ type: 'it:store', requestId: `r-s${i}`, changes: [[`k${i}`, '1']] })
    await act(() => tick(200))
    const results = heard.filter((m) => m.type === 'it:result')
    expect(results.length).toBe(60)
    const kept = results.filter((m) => m.ok).length
    expect(kept).toBeGreaterThanOrEqual(40)
    expect(kept).toBeLessThan(55)
    expect(results.filter((m) => !m.ok).every((m) => /storing too much at once/.test(m.error) && m.retryAfterMs > 0)).toBe(true)
    expect(asked('state:store').length).toBe(kept)
    // Actions have their own allowance still
    const acted = await page.send(port, action('click-2000'))
    expect(acted.find((m) => m.requestId === 'r-click-2000')).toMatchObject({ ok: true })
  })

  test('the page is sent its whole state once, and then only what changed', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const port = page.ports()[0]!
    const heard: any[] = []
    port.onmessage = (m) => heard.push(m.data)
    changed = { revision: 5, kept: [['stroke-1', '{"x":1}']] }
    await rerender()
    expect(heard).toEqual([
      { type: 'it:state', state: { n: 1 }, revision: 3 },
      { type: 'it:changed', revision: 5, kept: [['stroke-1', { x: 1 }]] },
    ])
    // The agent's part comes whole where it changed, and a value taken away comes as nothing
    changed = { revision: 6, state: '{"n":2}', kept: [['stroke-1', null]] }
    await rerender()
    expect(heard.at(-1)).toEqual({ type: 'it:changed', revision: 6, state: { n: 2 }, kept: [['stroke-1', null]] })
    // A document shown afresh is given the whole state as it now stands
    await page.fromFrame({ type: 'it:hello', doc: 'doc-2' })
    expect(page.posted.filter((p) => p.data.type === 'it:port').length).toBe(2)
    const fresh: any[] = []
    page.ports()[1]!.onmessage = (m) => fresh.push(m.data)
    await act(() => tick(20))
    expect(fresh).toEqual([{ type: 'it:state', state: { n: 2 }, revision: 6 }])
  })

  test('a page that asks for too much at once is told to slow down before the backend hears of it', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const port = page.ports()[0]!
    const heard: any[] = []
    port.onmessage = (m) => heard.push(m.data)
    for (let i = 0; i < 40; i++) port.postMessage(action(`click-1${String(i).padStart(3, '0')}`))
    await act(() => tick(200))
    const results = heard.filter((m) => m.type === 'it:result')
    expect(results.length).toBe(40)
    expect(results.filter((m) => m.ok).length).toBeLessThan(25)
    expect(results.filter((m) => !m.ok).every((m) => /too much at once/.test(m.error))).toBe(true)
    expect(submitted().length).toBe(results.filter((m) => m.ok).length)
  })
})

describe('what a page sends, as the site takes it', () => {
  test('a file anywhere in what an action carries is taken out, in order, and stands there as which of the files it is; the same file named twice is one', async () => {
    const { jsonText } = await import('@it/protocol')
    const photo = new File([new Uint8Array(3)], 'a.jpg', { type: 'image/jpeg' })
    const sheet = new Blob(['a,b'], { type: 'text/csv' })
    const files: Blob[] = []
    const text = jsonText({ photo, more: [{ sheet }, photo], n: 4 }, 32 * 1024, files)
    expect(JSON.parse(text)).toEqual({ photo: { file: 1 }, more: [{ sheet: { file: 2 } }, { file: 1 }], n: 4 })
    expect(files).toEqual([photo, sheet])
    // Data with no file in it is written as it always was
    expect(jsonText({ plan: 'B' }, 32 * 1024, [])).toBe('{"plan":"B"}')
  })

  test('a file is not kept with It.store, and the page is told where it goes instead', async () => {
    const { jsonText } = await import('@it/protocol')
    expect(() => jsonText({ photo: new Blob(['x']) }, 32 * 1024)).toThrow(
      'A file cannot be kept with It.store. Send it with It.action, which takes files beside what it carries.',
    )
    // Anything else that is not plain data is refused as before
    expect(() => jsonText({ when: new Date() }, 32 * 1024, [])).toThrow('That cannot be sent.')
  })
})
