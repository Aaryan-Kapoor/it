// The frame around a page, run in a stand-in browser with a stand-in backend. What it must get
// right: a showing is framed at the pages' port with its one ticket and in a sandbox, a message
// is the page's only if it came from that frame's window, each document in the frame gets one
// channel and no more, and what the site says about whether the person was at the page is the
// site's own judgement, never the page's.

import { CHANNEL_VERSION, LIMITS, WHO_MS } from '@it/protocol'
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
    if (name === 'actions:submit') {
      if (submitHeld) await submitHeld
      if (submitLost) {
        submitLost = false
        throw new Error('[CONVEX M(actions:submit)] Connection lost while the action was on its way')
      }
      if (submitLostAlways) throw new Error('[CONVEX M(actions:submit)] Connection lost while the action was on its way')
      if (submitBusy) {
        submitBusy = false
        throw new ConvexError({ code: 'unavailable', message: 'It is busy. Try again in a moment.' })
      }
      return { actionId: 'action-1' }
    }
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
/** What the stand-in backend's answer to an action waits on, where it is held back. */
let submitHeld: Promise<void> | null = null
/** Whether the next action's answer is lost on the way, with no word from It of what became of it. */
let submitLost = false
/** Whether every action's answer is lost on the way, until the test says otherwise. */
let submitLostAlways = false
/** Whether the next action is refused for now, as It refuses one when it is busy, to be sent again later. */
let submitBusy = false
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
/** A wait of the machine's own, whatever clock a test holds: the asking of which document a frame shows takes seconds by the held one. */
const machineTimeout = setTimeout
const pause = (ms = 20) => new Promise((r) => machineTimeout(r, ms))
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
/**
 * The frame the site is showing now, with what the site posts into it written down. The document
 * in it answers the site's asking which document it is, as It's script in a page does, with the
 * name it last said hello with, until the test says it is a document that answers nothing.
 */
function framed() {
  const frame = host.querySelector('iframe') as HTMLIFrameElement
  /** What the site posted into the frame, with the ports it handed over. */
  const posted: { data: any; to: string; ports: MessagePort[] }[] = []
  const inside = frame.contentWindow as Window
  const document = { name: '', answers: true }
  inside.postMessage = ((data: any, to: string, ports: MessagePort[] = []) => {
    posted.push({ data, to, ports })
    if (data?.type === 'it:who' && document.answers && document.name)
      queueMicrotask(() =>
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'it:here', nonce: data.nonce, doc: document.name }, origin: 'null', source: inside })),
      )
  }) as never
  // A sandboxed page has no origin of its own to name: a browser gives "null" for it
  const fromFrame = (data: unknown, origin = 'null', source: Window = inside) =>
    act(async () => {
      const said = data as { type?: unknown; doc?: unknown } | null
      if (said?.type === 'it:hello' && typeof said.doc === 'string' && source === inside) document.name = said.doc
      window.dispatchEvent(new MessageEvent('message', { data, origin, source }))
      await pause()
    })
  const ports = () => posted.filter((p) => p.data.type === 'it:port').map((p) => p.ports[0]!)
  /** Sends something on a channel as the page would, and gives back what the site answered. */
  const send = async (port: MessagePort, message: unknown, waitMs = 60) => {
    const heard: any[] = []
    port.onmessage = (m) => heard.push(m.data)
    port.postMessage(message)
    await act(() => pause(waitMs))
    return heard
  }
  /** A document of the page's loads in the frame: one of It's, which answers, or one that answers nothing, as `about:blank` does. */
  const loads = (answers = true) =>
    act(async () => {
      document.answers = answers
      frame.dispatchEvent(new Event('load'))
      await pause()
    })
  return { frame, fromFrame, ports, send, posted, loads }
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
  // When the site was last touched is kept by the module for the whole file. A test that moved
  // the clock ahead and touched the site would leave it in the future, where every page's click
  // would be taken for the site's: it is put back to long ago, with a touch at time zero
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(0)
  window.dispatchEvent(new Event('click'))
  vi.useRealTimers()
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

  test('the frame is a sandbox: a page is given no origin and cannot move the tab, and a window it opens is an ordinary tab', async () => {
    const page = await show()
    // Word for word what the content service says on everything it sends
    expect(page.frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock',
    )
    for (const word of ['allow-same-origin', 'allow-top-navigation']) expect(page.frame.getAttribute('sandbox')).not.toContain(word)
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

  for (const order of ['refused, then loaded', 'loaded, then refused'])
    test(`a page whose frame was taken to another site, which the browser refused and left its error page in place of, is shown again: ${order}`, async () => {
      const page = await show()
      /** The browser saying that the site's policy refused something, as it says it to the site's document. */
      const refuses = (directive: string) =>
        act(async () => {
          document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), { effectiveDirective: directive }))
          await tick()
        })
      const loads = () =>
        act(async () => {
          page.frame.dispatchEvent(new Event('load'))
          await tick()
        })
      // Before the page's own script has said hello, the frame is still loading the page
      await refuses('frame-src')
      await loads()
      await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
      // Another of the page's own documents loading, and something else of the site's refused, are neither
      await act(() => tick(2100))
      await loads()
      await refuses('img-src')
      await act(() => tick(2100))
      await loads()
      expect(asked('mounts:create').length).toBe(1)
      // The frame refused another site, and loads the error page in its place: the page is shown again
      if (order === 'refused, then loaded') {
        await refuses('frame-src')
        await loads()
      } else {
        await loads()
        await refuses('frame-src')
      }
      await act(() => tick(50))
      expect(asked('mounts:create').length).toBe(2)
      expect(host.querySelector('iframe')?.getAttribute('src')).toBe(`${PAGES}/open/ticket-for-mount-2`)
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
      // And whether It is fullscreen, in a browser that has no fullscreen
      { type: 'it:fullscreen', on: false, enabled: false },
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

  test('an address the page asks to have opened is opened in a tab of its own, with no hold either way, only from the page’s own frame, only for the web or the person’s mail, phone or messages, and only from the person’s own click or key in the page', async () => {
    // The clock is the test's, and is set well past any click on the site an earlier test made
    await renderHeld()
    vi.setSystemTime(Date.now() + 3_600_000)
    const page = framed()
    // The page's own script has said hello, so the site does not give up on it while the test's clock runs on
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'it:hello', doc: 'doc-1' }, origin: 'null', source: page.frame.contentWindow }))
      await vi.advanceTimersByTimeAsync(20)
    })
    const opened: unknown[][] = []
    vi.spyOn(window, 'open').mockImplementation((...given: unknown[]) => {
      opened.push(given)
      return null
    })
    const asks = async (url: unknown, source: Window = page.frame.contentWindow as Window) => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'it:open', url }, origin: 'null', source }))
      await act(() => vi.advanceTimersByTimeAsync(1))
    }
    // Nobody has done anything in the page: the frame does not have the keyboard, and the browser says nobody has just acted
    await asks('https://elsewhere.test/a')
    page.frame.setAttribute('tabindex', '0')
    page.frame.focus()
    await asks('https://elsewhere.test/b')
    active = true
    await asks('https://elsewhere.test/c')
    await asks('mailto:someone@example.com?subject=Hi')
    await asks('tel:+15551234567')
    await asks('sms:+15551234567')
    await asks('HTTP://Elsewhere.test/d')
    expect(opened).toEqual([
      ['https://elsewhere.test/c', '_blank', 'noopener,noreferrer'],
      ['mailto:someone@example.com?subject=Hi', '_blank', 'noopener,noreferrer'],
      ['tel:+15551234567', '_blank', 'noopener,noreferrer'],
      ['sms:+15551234567', '_blank', 'noopener,noreferrer'],
      ['http://elsewhere.test/d', '_blank', 'noopener,noreferrer'],
    ])
    // Another window asking, whatever it asks: the site itself, or a frame that is not the page's
    const other = document.body.appendChild(document.createElement('iframe'))
    await asks('https://elsewhere.test/e', window)
    await asks('https://elsewhere.test/e', other.contentWindow as Window)
    other.remove()
    // An address of any other kind, one that is not whole, or one that is no address
    for (const refused of [
      'javascript:alert(1)',
      'data:text/html,<p>hi',
      'blob:http://localhost/0f0',
      'file:///etc/hosts',
      'ftp://elsewhere.test/',
      '/p/another-page',
      'elsewhere.test',
      `https://elsewhere.test/${'x'.repeat(16 * 1024)}`,
      7,
      { toString: () => 'https://elsewhere.test/' },
      undefined,
    ])
      await asks(refused)
    expect(opened.length).toBe(5)
    // A click on the site itself (the card that opened the page, say), which the browser reports
    // for a few seconds as it reports one in the page. Nothing is opened while it cannot be told
    // whose click it was, and the browser is asked again once the site's has worn off
    const passes = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
    window.dispatchEvent(new Event('pointerdown'))
    await asks('https://elsewhere.test/f')
    await passes(4000)
    expect(opened.length).toBe(5)
    // Nobody clicked in the page: once the site's click has worn off the browser says nobody has just acted, and nothing is opened
    active = false
    await passes(1100)
    expect(opened.length).toBe(5)
    // The person really does click in the page a moment after a click on the site: the browser is
    // still reporting that once the site's has worn off, and the address is opened then
    window.dispatchEvent(new Event('pointerdown'))
    active = true
    await asks('https://elsewhere.test/g')
    await passes(4000)
    expect(opened.length).toBe(5)
    await passes(1100)
    expect(opened.at(-1)).toEqual(['https://elsewhere.test/g', '_blank', 'noopener,noreferrer'])
    // Another click on the site meanwhile makes it impossible to tell, and nothing is opened
    await passes(6000)
    window.dispatchEvent(new Event('pointerdown'))
    await asks('https://elsewhere.test/h')
    await passes(2000)
    window.dispatchEvent(new Event('pointerdown'))
    await passes(3100)
    expect(opened.length).toBe(6)
    // Long after any click on the site, a click in the page opens the address at once
    await passes(6000)
    await asks('https://elsewhere.test/i')
    expect(opened.at(-1)).toEqual(['https://elsewhere.test/i', '_blank', 'noopener,noreferrer'])
    // Nor while the frame does not have the keyboard, however the browser says the person has just acted
    const elsewhere = document.body.appendChild(document.createElement('button'))
    elsewhere.focus()
    expect(document.activeElement).toBe(elsewhere)
    await asks('https://elsewhere.test/j')
    expect(opened.length).toBe(7)
    elsewhere.remove()
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

  test('a page’s channel says that it takes several stored values at once and that the site hosts embeds, and what the page keeps goes to the backend as one write', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    expect(page.posted.find((p) => p.data.type === 'it:port')?.data).toEqual({ type: 'it:port', v: CHANNEL_VERSION, embeds: true })
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
      { type: 'it:fullscreen', on: false, enabled: false },
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
    expect(fresh).toEqual([
      { type: 'it:state', state: { n: 2 }, revision: 6 },
      { type: 'it:fullscreen', on: false, enabled: false },
    ])
  })

  test('a page that asks for too much at once is told to slow down before the backend hears of it, and its bar is told too', async () => {
    const { refusedLately } = await import('./outbox')
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const port = page.ports()[0]!
    const heard: any[] = []
    port.onmessage = (m) => heard.push(m.data)
    for (let i = 0; i < 100; i++) port.postMessage(action(`click-1${String(i).padStart(3, '0')}`))
    await act(() => tick(200))
    const results = heard.filter((m) => m.type === 'it:result')
    expect(results.length).toBe(100)
    expect(results.filter((m) => m.ok).length).toBeLessThan(70)
    expect(results.filter((m) => !m.ok).every((m) => /too much at once/.test(m.error))).toBe(true)
    expect(submitted().length).toBe(results.filter((m) => m.ok).length)
    expect(refusedLately('alice', 'page1')?.fast).toBe(results.filter((m) => !m.ok).length)
  })

  test('sixty clicks made as fast as a person clicks are all taken by the frame', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const port = page.ports()[0]!
    const heard: any[] = []
    port.onmessage = (m) => heard.push(m.data)
    // Ten a second for six seconds, as a person plays a pad
    for (let i = 0; i < 60; i++) {
      port.postMessage(action(`click-2${String(i).padStart(3, '0')}`))
      await act(() => tick(100))
    }
    await act(() => tick(200))
    const results = heard.filter((m) => m.type === 'it:result')
    expect([results.length, results.filter((m) => m.ok).length]).toEqual([60, 60])
  }, 20_000)
})

describe('fullscreen, which a page asks the site for', () => {
  /** The browser's fullscreen, stood in for, since the stand-in browser has none: what it was asked, and what it has fullscreen. */
  const browser = { element: null as Element | null, enabled: true, refuses: false, asked: [] as string[] }
  const changed = () => document.dispatchEvent(new Event('fullscreenchange'))
  beforeEach(() => {
    Object.assign(browser, { element: null, enabled: true, refuses: false, asked: [] })
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => browser.enabled })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => browser.element })
    document.documentElement.requestFullscreen = async () => {
      browser.asked.push('enter')
      if (browser.refuses) throw new TypeError('Permissions check failed')
      browser.element = document.documentElement
      changed()
    }
    document.exitFullscreen = async () => {
      browser.asked.push('leave')
      browser.element = null
      changed()
    }
  })
  afterEach(() => {
    // What the site knows of fullscreen is put back to none, and the browser to one with no fullscreen, for the next test
    browser.element = null
    changed()
    for (const name of ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen']) delete (document as unknown as Record<string, unknown>)[name]
    delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen
  })
  /**
   * How far both clocks are put on past the machine's own, a minute more for each test, so that
   * neither a click on the site nor the end of fullscreen in an earlier test is recent.
   */
  let later = 0
  let round = 0
  const machinesNow = Date.now.bind(Date)
  const machinesMoment = performance.now.bind(performance)
  /**
   * A page whose own script has said hello, and the channel it was given, with what came down it
   * written down. The person has just clicked in the page: its frame has the keyboard, and the
   * browser says that the person has just acted.
   */
  async function connected() {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const heard: any[] = []
    page.ports()[0]!.onmessage = (m) => heard.push(m.data)
    await act(() => tick())
    round += 1
    later = round * 60_000
    vi.spyOn(Date, 'now').mockImplementation(() => machinesNow() + later)
    vi.spyOn(performance, 'now').mockImplementation(() => machinesMoment() + later)
    page.frame.focus()
    active = true
    /** Posts on the window as the page does, and gives back what the browser was asked before the site's handler returned. */
    const ask = (data: unknown, source: unknown = page.frame.contentWindow) => {
      window.dispatchEvent(new MessageEvent('message', { data, origin: 'null', source: source as Window }))
      return [...browser.asked]
    }
    return { ...page, heard, ask }
  }
  const NOT_THE_PAGES =
    'It goes fullscreen for a page only on a click or a key in the page itself, and not just after a click on It or just after fullscreen was left. Ask again on the next click in the page.'

  test('the page is told whether It is fullscreen as soon as it has a channel, which also tells it that the site takes its asking', async () => {
    const page = await connected()
    expect(page.heard).toEqual([
      { type: 'it:state', state: { n: 1 }, revision: 3 },
      { type: 'it:fullscreen', on: false, enabled: true },
    ])
  })

  test('the page’s asking is put to the browser in the same turn as its message, and answered on its channel', async () => {
    const page = await connected()
    // Asked of the browser before the handler returned: a moment later the click that asked would no longer count
    expect(page.ask({ type: 'it:fullscreen', requestId: 'f-1', on: true })).toEqual(['enter'])
    await act(() => tick())
    expect(page.heard.slice(2)).toEqual([
      { type: 'it:fullscreen', on: true, enabled: true },
      { type: 'it:result', requestId: 'f-1', ok: true },
    ])
    expect(page.ask({ type: 'it:fullscreen', requestId: 'f-2', on: false })).toEqual(['enter', 'leave'])
    await act(() => tick())
    expect(page.heard.slice(4)).toEqual([
      { type: 'it:fullscreen', on: false, enabled: true },
      { type: 'it:result', requestId: 'f-2', ok: true },
    ])
  })

  test('only the frame’s own window may ask, and only in the words the page’s script uses', async () => {
    const page = await connected()
    const elsewhere = window.open() ?? {}
    for (const source of [window, elsewhere, null]) expect(page.ask({ type: 'it:fullscreen', requestId: 'f-1', on: true }, source)).toEqual([])
    for (const on of [undefined, 'true', 1]) expect(page.ask({ type: 'it:fullscreen', requestId: 'f-1', on })).toEqual([])
    await act(() => tick())
    expect(page.heard).toHaveLength(2)
  })

  test('a page that asks again and again is told to slow down, and the browser is not asked', async () => {
    const page = await connected()
    for (let i = 0; i < 40; i++) page.ask({ type: 'it:fullscreen', requestId: `f-${i}`, on: true })
    await act(() => tick(100))
    const results = page.heard.filter((m) => m.type === 'it:result')
    const tooMuch = results.filter((m) => m.error === 'This page is asking too much at once. Try again in a moment.')
    expect(results).toHaveLength(40)
    expect(tooMuch.length).toBeGreaterThan(15)
    // The rest were answered, and the browser was asked once: It was fullscreen after the first
    expect(results.filter((m) => m.ok)).toHaveLength(40 - tooMuch.length)
    expect(browser.asked).toEqual(['enter'])
  })

  test('leaving is never refused for coming too fast: a page that has used up what it may ask can still give the person their screen back', async () => {
    const page = await connected()
    for (let i = 0; i < 40; i++) page.ask({ type: 'it:fullscreen', requestId: `f-${i}`, on: true })
    await act(() => tick())
    expect(page.heard.some((m) => m.error === 'This page is asking too much at once. Try again in a moment.')).toBe(true)
    expect(page.ask({ type: 'it:fullscreen', requestId: 'f-leave', on: false })).toEqual(['enter', 'leave'])
    await act(() => tick())
    expect(page.heard.filter((m) => m.requestId === 'f-leave')).toEqual([{ type: 'it:result', requestId: 'f-leave', ok: true }])
  })

  test('a page may have It go fullscreen only while its frame has the keyboard, which a click in it gives it', async () => {
    const page = await connected()
    // The keyboard is on something of the site's, as it is after a click on the bar
    document.body.appendChild(document.createElement('button')).focus()
    expect(document.activeElement).not.toBe(page.frame)
    expect(page.ask({ type: 'it:fullscreen', requestId: 'f-1', on: true })).toEqual([])
    await act(() => tick())
    expect(page.heard.slice(-2)).toEqual([
      { type: 'it:result', requestId: 'f-1', ok: false, error: NOT_THE_PAGES },
      // And what It is, which the page goes by
      { type: 'it:fullscreen', on: false, enabled: true },
    ])
  })

  test('a page may have It go fullscreen only while the browser says that the person has just acted', async () => {
    const page = await connected()
    active = false
    expect(page.ask({ type: 'it:fullscreen', requestId: 'f-1', on: true })).toEqual([])
    await act(() => tick())
    expect(page.heard.at(-2)).toMatchObject({ requestId: 'f-1', ok: false, error: NOT_THE_PAGES })
  })

  test('a click on the site, such as on the bar, is not taken for the page’s own, and a click in the page after its moment is', async () => {
    const page = await connected()
    window.dispatchEvent(new Event('pointerdown'))
    expect(page.ask({ type: 'it:fullscreen', requestId: 'f-1', on: true })).toEqual([])
    // The browser stops saying so of the site's click within a few seconds, and goes on saying it of a later click in the page
    later += 5100
    expect(page.ask({ type: 'it:fullscreen', requestId: 'f-2', on: true })).toEqual(['enter'])
    await act(() => tick())
    expect(page.heard.filter((m) => m.type === 'it:result')).toEqual([
      { type: 'it:result', requestId: 'f-1', ok: false, error: NOT_THE_PAGES },
      { type: 'it:result', requestId: 'f-2', ok: true },
    ])
  })

  test('the moment after the click that opened a page is timed from that click, and not from when the page was framed seconds later', async () => {
    round += 1
    later = round * 60_000
    vi.spyOn(Date, 'now').mockImplementation(() => machinesNow() + later)
    vi.spyOn(performance, 'now').mockImplementation(() => machinesMoment() + later)
    // The click on the page's card
    window.dispatchEvent(new Event('pointerdown'))
    // The page is framed four seconds later, while the browser still reports that click
    later += 4000
    active = true
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    // Two seconds after that, past the card's click, the person clicks in the page
    later += 2000
    page.frame.focus()
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'it:fullscreen', requestId: 'f-1', on: true }, origin: 'null', source: page.frame.contentWindow }),
    )
    expect(browser.asked).toEqual(['enter'])
  })

  test('a page that asks again as soon as the person leaves fullscreen does not come back, and may leave whenever it likes', async () => {
    const page = await connected()
    page.ask({ type: 'it:fullscreen', requestId: 'f-1', on: true })
    await act(() => tick())
    // The person leaves, by the bar's button or by Escape, and the page asks again at once
    browser.element = null
    changed()
    expect(page.ask({ type: 'it:fullscreen', requestId: 'f-2', on: true })).toEqual(['enter'])
    await act(() => tick())
    expect(page.heard.slice(-2)).toEqual([
      { type: 'it:result', requestId: 'f-2', ok: false, error: NOT_THE_PAGES },
      { type: 'it:fullscreen', on: false, enabled: true },
    ])
    // Leaving asks nothing of the person: once It is fullscreen again, by the bar, a page that does not have the keyboard may leave
    browser.element = document.documentElement
    changed()
    document.body.appendChild(document.createElement('button')).focus()
    active = false
    expect(page.ask({ type: 'it:fullscreen', requestId: 'f-3', on: false })).toEqual(['enter', 'leave'])
  })

  test('a browser’s refusal is answered with why, in the site’s own words', async () => {
    const page = await connected()
    browser.refuses = true
    page.ask({ type: 'it:fullscreen', requestId: 'f-1', on: true })
    await act(() => tick())
    expect(page.heard.slice(2)).toEqual([
      {
        type: 'it:result',
        requestId: 'f-1',
        ok: false,
        error: 'The browser did not go fullscreen. It goes fullscreen only just after a click or a key in the page.',
      },
      { type: 'it:fullscreen', on: false, enabled: true },
    ])
  })

  test('the page is told when It goes fullscreen or leaves it another way, from the bar or by Escape', async () => {
    const page = await connected()
    browser.element = document.documentElement
    await act(async () => changed())
    browser.element = null
    await act(async () => changed())
    await act(() => tick())
    expect(page.heard.slice(2)).toEqual([
      { type: 'it:fullscreen', on: true, enabled: true },
      { type: 'it:fullscreen', on: false, enabled: true },
    ])
  })

  test('where the browser has no fullscreen, as on an iPhone, the page is told so', async () => {
    browser.enabled = false
    const page = await connected()
    expect(page.heard.at(-1)).toEqual({ type: 'it:fullscreen', on: false, enabled: false })
  })
})

describe('players and maps the site hosts over a page', () => {
  /** The frames the site hosts over the page, in the layer over its frame. */
  const hosted = () => [...host.querySelectorAll<HTMLIFrameElement>('.mount > .embeds iframe')]

  test('an embed a page asks for over its channel is framed in a layer over the page’s frame, inside the same box, and not one that is not on the list', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const port = page.ports()[0]!
    const heard = await page.send(port, { type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/aqz-KE-bpKQ' })
    expect(hosted().map((f) => f.src)).toEqual(['https://www.youtube.com/embed/aqz-KE-bpKQ'])
    // The layer comes after the page's frame in the same box, so that it lies over it, and goes into fullscreen with it
    expect(host.querySelector('.mount > iframe + .embeds')).not.toBeNull()
    expect(heard.filter((m) => m.type !== 'it:state' && m.type !== 'it:fullscreen')).toEqual([])
    const refused = await page.send(port, { type: 'it:embed', id: 'e2', url: 'https://evil.example/embed/abc' })
    expect(refused).toEqual([{ type: 'it:embed-refused', id: 'e2', error: 'That address is not the embed of a provider It hosts.' }])
    expect(hosted().length).toBe(1)
    // Nothing about an embed reaches the backend
    expect(calls.filter((c) => c.fn !== 'mounts:create' && c.fn !== 'mounts:ticket')).toEqual([])
  })

  test('the embeds of a document go when the frame shows another, and none of the old channel’s are taken after', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const first = page.ports()[0]!
    await page.send(first, { type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    expect(hosted().length).toBe(1)
    await page.fromFrame({ type: 'it:hello', doc: 'doc-2' })
    expect(hosted()).toEqual([])
    await page.send(first, { type: 'it:embed', id: 'e2', url: 'https://www.youtube.com/embed/b' })
    expect(hosted()).toEqual([])
    await page.send(page.ports()[1]!, { type: 'it:embed', id: 'e3', url: 'https://player.vimeo.com/video/1' })
    expect(hosted().map((f) => f.src)).toEqual(['https://player.vimeo.com/video/1'])
  })

  test('a page that says hello for a name of its own and then takes its frame to a document that answers nothing loses its players and its channel once the site has asked', async () => {
    const page = await show()
    // The asking takes seconds: the site's clock is held, and moved on by the test
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    await page.loads()
    await page.send(page.ports()[0]!, { type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    // A hello for a name the page chose: a channel of its own, over which it asks for a player directly
    await page.fromFrame({ type: 'it:hello', doc: 'chosen-by-the-page' })
    const forged = page.ports()[1]!
    await page.send(forged, { type: 'it:embed', id: 'e2', url: 'https://player.vimeo.com/video/1' })
    expect(hosted().map((f) => f.src)).toEqual(['https://player.vimeo.com/video/1'])
    // Then the frame goes to a document that answers nothing, as `about:blank` is
    await page.loads(false)
    expect(page.posted.filter((p) => p.data.type === 'it:who').length).toBe(2)
    // While the site waits for an answer, no click reaches the player
    expect((host.querySelector('.embed-shield') as HTMLElement).hidden).toBe(false)
    await act(async () => {
      vi.advanceTimersByTime(WHO_MS)
      await pause()
    })
    expect(hosted()).toEqual([])
    // Nothing that arrives on that channel is taken from now on: no player, and no action
    await page.send(forged, { type: 'it:embed', id: 'e3', url: 'https://www.youtube.com/embed/b' })
    await page.send(forged, action('after-it-went'))
    expect(hosted()).toEqual([])
    expect(submitted().map((e) => e.clientActionId)).not.toContain('after-it-went')
    // And the frame is told, so that a document of It's that was only slow asks for a channel again
    expect(page.posted.at(-1)?.data).toEqual({ type: 'it:gone' })
  }, 15_000)

  test('a page that hands its channel to another window and takes its frame to a document that answers nothing cannot use the channel to put players over that document', async () => {
    const page = await show()
    // The asking takes seconds: the site's clock is held, and moved on by the test
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    await page.loads()
    // The channel is now in the hands of a window the page opened; the frame goes to a document that answers nothing
    const handedOn = page.ports()[0]!
    await page.send(handedOn, { type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    await page.loads(false)
    await act(async () => {
      vi.advanceTimersByTime(WHO_MS)
      await pause()
    })
    expect(hosted()).toEqual([])
    const after = await page.send(handedOn, { type: 'it:embed', id: 'e2', url: 'https://www.youtube.com/embed/b' })
    await page.send(handedOn, { type: 'it:embed-at', id: 'e2', x: 0, y: 0, width: 300, height: 200, cut: [0, 0, 0, 0], round: 0, shown: true })
    expect(hosted()).toEqual([])
    expect(after).toEqual([])
    // The site asked the frame's own window, never the channel: what the other window holds was told nothing of the asking
    const asked = page.posted.filter((p) => p.data.type === 'it:who')
    expect(asked.length).toBe(2)
    expect(new Set(asked.map((p) => p.data.nonce)).size).toBe(2)
  }, 15_000)

  test('a document that answers with another value, or for another channel, is not taken as the one the channel was made for', async () => {
    const page = await show()
    // The asking takes seconds: the site's clock is held, and moved on by the test
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    await page.loads()
    await page.send(page.ports()[0]!, { type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    await page.loads(false)
    const nonce = page.posted.filter((p) => p.data.type === 'it:who').at(-1)!.data.nonce
    await page.fromFrame({ type: 'it:here', nonce: 'a-value-of-its-own', doc: 'doc-1' })
    await page.fromFrame({ type: 'it:here', nonce, doc: 'another-document' })
    // From another window than the frame's, even with the right value
    await page.fromFrame({ type: 'it:here', nonce, doc: 'doc-1' }, 'null', window)
    await act(async () => {
      vi.advanceTimersByTime(WHO_MS)
      await pause()
    })
    expect(hosted()).toEqual([])
  }, 15_000)

  test('an action on its way when the site took its document to be gone, sent again as it was over the next channel, is done once, and the page is told there what became of it', async () => {
    const page = await show()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    await page.loads()
    // The backend has the action and has not answered yet
    let answer = () => {}
    submitHeld = new Promise((resolve) => {
      answer = resolve
    })
    try {
      page.ports()[0]!.postMessage(action('slow-0001'))
      await act(() => pause(60))
      expect(submitted().map((e) => e.clientActionId)).toEqual(['slow-0001'])
      // Busy, the document misses the asking, and the site takes it to be gone
      await page.loads(false)
      await act(async () => {
        vi.advanceTimersByTime(WHO_MS)
        await pause()
      })
      expect(page.posted.at(-1)?.data).toEqual({ type: 'it:gone' })
      // It was only slow: it says hello under a new name, and sends the action again as it was, under the same id
      await page.fromFrame({ type: 'it:hello', doc: 'doc-1-again' })
      const next = page.ports()[1]!
      const heard: any[] = []
      next.onmessage = (m) => heard.push(m.data)
      next.postMessage(action('slow-0001'))
      await act(() => pause(60))
      answer()
      await act(() => pause(100))
      expect(submitted().map((e) => e.clientActionId)).toEqual(['slow-0001'])
      expect(heard.filter((m) => m.type === 'it:result')).toEqual([{ type: 'it:result', requestId: 'r-slow-0001', ok: true, actionId: 'action-1' }])
      // Sent once more after It accepted it, it is told the same, and the backend is not asked again
      const again = await page.send(next, action('slow-0001'))
      expect(again.find((m) => m.type === 'it:result')).toEqual({ type: 'it:result', requestId: 'r-slow-0001', ok: true, actionId: 'action-1' })
      expect(submitted().length).toBe(1)
    } finally {
      submitHeld = null
      answer()
    }
  }, 15_000)

  test('actions sent again after their channel was lost are none of them refused for coming too fast, however many were on their way', async () => {
    const page = await show()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    await page.loads()
    let answer = () => {}
    submitHeld = new Promise((resolve) => {
      answer = resolve
    })
    try {
      // Twenty-five actions, sent no faster than a page may send them, all of them with It and none answered yet
      const ids = Array.from({ length: 25 }, (_, n) => `many-${String(n).padStart(4, '0')}`)
      // The hello took one of the twenty a page may send at once
      for (const id of ids.slice(0, 19)) page.ports()[0]!.postMessage(action(id))
      await act(() => pause(200))
      vi.advanceTimersByTime(2000)
      for (const id of ids.slice(19)) page.ports()[0]!.postMessage(action(id))
      await act(() => pause(200))
      expect(submitted().length).toBe(25)
      await page.loads(false)
      await act(async () => {
        vi.advanceTimersByTime(WHO_MS)
        await pause()
      })
      // Back with a new channel, the document sends all of them again at once, as it was
      await page.fromFrame({ type: 'it:hello', doc: 'doc-1-again' })
      const next = page.ports()[1]!
      const heard: any[] = []
      next.onmessage = (m) => heard.push(m.data)
      for (const id of ids) next.postMessage({ ...action(id), again: true })
      await act(() => pause(100))
      answer()
      await act(() => pause(200))
      const results = heard.filter((m) => m.type === 'it:result')
      expect(results.length).toBe(25)
      expect(results.filter((m) => !m.ok)).toEqual([])
      expect(submitted().length).toBe(25)
    } finally {
      submitHeld = null
      answer()
    }
  }, 15_000)

  test('an action It accepted while its channel was gone is told as accepted when it is sent again, however long after, and the backend is not asked again', async () => {
    const page = await show()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    await page.loads()
    let answer = () => {}
    submitHeld = new Promise((resolve) => {
      answer = resolve
    })
    try {
      page.ports()[0]!.postMessage(action('late-0001'))
      await act(() => pause(60))
      await page.loads(false)
      await act(async () => {
        vi.advanceTimersByTime(WHO_MS)
        await pause()
      })
      // It accepts the action with nobody there to be told
      answer()
      submitHeld = null
      await act(() => pause(100))
      expect(submitted().map((e) => e.clientActionId)).toEqual(['late-0001'])
      // Days later the document is back, and sends it again
      await act(async () => {
        vi.advanceTimersByTime(8 * 86400_000)
        await pause()
      })
      await page.fromFrame({ type: 'it:hello', doc: 'doc-1-again' })
      const heard = await page.send(page.ports()[1]!, { ...action('late-0001'), again: true })
      expect(heard.find((m) => m.type === 'it:result')).toEqual({ type: 'it:result', requestId: 'r-late-0001', ok: true, actionId: 'action-1' })
      expect(submitted().length).toBe(1)
    } finally {
      submitHeld = null
      answer()
    }
  }, 15_000)

  /** Shows a page whose document says hello and answers, with the backend's answer to its next action held until `answer`. */
  async function heldAction(id: string) {
    const page = await show()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    await page.loads()
    let answer = () => {}
    submitHeld = new Promise((resolve) => {
      answer = resolve
    })
    page.ports()[0]!.postMessage(action(id))
    await act(() => pause(60))
    return {
      page,
      answer: () => {
        submitHeld = null
        answer()
      },
      /** The document misses the asking which document it is, and the site takes it to be gone. */
      gone: async () => {
        await page.loads(false)
        await act(async () => {
          vi.advanceTimersByTime(WHO_MS)
          await pause()
        })
      },
      /** The document is back, with a new channel, and sends the action again as it was. */
      sentAgain: async () => {
        await page.fromFrame({ type: 'it:hello', doc: 'doc-1-again' })
        return page.send(page.ports().at(-1)!, { ...action(id), again: true }, 200)
      },
    }
  }

  test('an action refused for now while its channel was gone, which the browser then sends again by itself and It accepts, is told as accepted when it is sent again, and never as refused', async () => {
    const held = await heldAction('busy-0001')
    try {
      await held.gone()
      // It refuses it for now, with nobody there to be told: the browser keeps it, sends it again by itself, and It takes it
      submitBusy = true
      held.answer()
      await act(() => pause(300))
      expect(submitted().map((e) => e.clientActionId)).toEqual(['busy-0001', 'busy-0001'])
      const heard = await held.sentAgain()
      expect(heard.find((m) => m.type === 'it:result')).toEqual({ type: 'it:result', requestId: 'r-busy-0001', ok: true, actionId: 'action-1' })
      expect(submitted().length).toBe(2)
    } finally {
      submitBusy = false
      held.answer()
    }
  }, 15_000)

  test('a refusal for now that the page was there to be told of, as it sent the action again, is never kept as a refusal for good', async () => {
    const held = await heldAction('trans-0001')
    try {
      await held.gone()
      // Sent again while It's answer is still on its way: it waits on it, so the page is there to be told
      const answered = held.sentAgain()
      await act(() => pause(50))
      submitBusy = true
      held.answer()
      const heard = await answered
      expect(heard.find((m) => m.type === 'it:result')).toMatchObject({ requestId: 'r-trans-0001', ok: false, error: 'It is busy. Try again in a moment.' })
      // Lost again, and sent again: what became of it is not known here, and it is not said to be refused
      await held.gone()
      await held.page.fromFrame({ type: 'it:hello', doc: 'doc-1-third' })
      const later = await held.page.send(held.page.ports().at(-1)!, { ...action('trans-0001'), again: true }, 200)
      expect(later.find((m) => m.type === 'it:result')).toMatchObject({
        requestId: 'r-trans-0001',
        ok: false,
        error: expect.stringMatching(/cannot tell whether this was done/),
      })
      expect(submitted().length).toBe(1)
    } finally {
      submitBusy = false
      held.answer()
    }
  }, 15_000)

  test('an action sent again that this showing never had is told that It cannot tell whether it was done, and nothing is sent for it', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const heard = await page.send(page.ports()[0]!, { ...action('never-0001'), again: true }, 200)
    expect(heard.find((m) => m.type === 'it:result')).toMatchObject({
      requestId: 'r-never-0001',
      ok: false,
      error: expect.stringMatching(/cannot tell whether this was done/),
    })
    expect(submitted()).toEqual([])
    expect(asked('actions:replayGrant')).toEqual([])
  })

  test('an action whose fate is not known here is told so when it is sent again, at once, and is never sent again from here, however long the browser would have waited for another tab first', async () => {
    // A stand-in for the browser's locks, under which a click is sent: another tab holds them until the test lets go
    const nav = navigator as unknown as { locks?: unknown }
    const before = nav.locks
    let letGo = () => {}
    const heldByAnother = new Promise<void>((resolve) => {
      letGo = resolve
    })
    let locked = false
    try {
      const held = await heldAction('fate-0001')
      // Its answer is lost while the document is there to be told, so the browser does not keep it: what became of it is not known
      submitLost = true
      held.answer()
      await act(() => pause(100))
      expect(submitted().map((e) => e.clientActionId)).toEqual(['fate-0001'])
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: {
          request: async (_key: string, options: unknown, work?: (lock: unknown) => unknown) => {
            const run = (typeof options === 'function' ? options : work) as (lock: unknown) => unknown
            locked = true
            await heldByAnother
            return run({})
          },
        },
      })
      const answered = held.sentAgain()
      await act(() => pause(100))
      // Eight days on, the other tab lets go
      await act(async () => {
        vi.advanceTimersByTime(8 * 86400_000)
        await pause()
      })
      letGo()
      const heard = await answered
      await act(() => pause(100))
      expect(heard.find((m) => m.type === 'it:result')).toMatchObject({
        requestId: 'r-fate-0001',
        ok: false,
        error: expect.stringMatching(/cannot tell whether this was done/),
      })
      expect(locked).toBe(false)
      expect(submitted().length).toBe(1)
      expect(asked('actions:replayGrant').length).toBe(0)
    } finally {
      letGo()
      submitLost = false
      Object.defineProperty(navigator, 'locks', { configurable: true, value: before })
    }
  }, 15_000)

  test('an action the browser sent from what it kept, while its channel was gone, is told as accepted when it is sent again eight days later, and nothing is sent for it from here', async () => {
    const held = await heldAction('kept-0001')
    try {
      await held.gone()
      submitLost = true
      held.answer()
      await act(() => pause(300))
      expect(submitted().map((e) => e.clientActionId)).toEqual(['kept-0001', 'kept-0001'])
      await act(async () => {
        vi.advanceTimersByTime(8 * 86400_000)
        await pause()
      })
      const heard = await held.sentAgain()
      expect(heard.find((m) => m.type === 'it:result')).toEqual({ type: 'it:result', requestId: 'r-kept-0001', ok: true, actionId: 'action-1' })
      expect(submitted().length).toBe(2)
    } finally {
      submitLost = false
      held.answer()
    }
  }, 15_000)

  test('an action another tab sent from what this browser kept is told that It cannot tell whether it was done, once the browser no longer holds it, and nothing is sent for it from here', async () => {
    const held = await heldAction('tabs-0001')
    try {
      await held.gone()
      // Its answer is lost, and the browser keeps it; every sending of it from here meets trouble too
      submitLostAlways = true
      held.answer()
      await act(() => pause(300))
      const sentSoFar = submitted().length
      const heard: any[] = []
      await held.page.fromFrame({ type: 'it:hello', doc: 'doc-1-again' })
      const next = held.page.ports().at(-1)!
      next.onmessage = (m) => heard.push(m.data)
      next.postMessage({ ...action('tabs-0001'), again: true })
      await act(() => pause(100))
      // It waits while the browser holds it; then another tab sends it, and it is gone from here with nothing said of how
      expect(heard.filter((m) => m.type === 'it:result')).toEqual([])
      submitLostAlways = false
      for (const key of Object.keys(localStorage)) if (key.startsWith('it.outbox.') && key.endsWith('.tabs-0001')) localStorage.removeItem(key)
      await act(async () => {
        vi.advanceTimersByTime(1500)
        await pause(100)
      })
      expect(heard.filter((m) => m.type === 'it:result')).toEqual([
        expect.objectContaining({ requestId: 'r-tabs-0001', ok: false, error: expect.stringMatching(/cannot tell whether this was done/) }),
      ])
      expect(submitted().length).toBe(sentSoFar)
    } finally {
      submitLostAlways = false
      held.answer()
    }
  }, 15_000)

  test('a document of It’s that answers keeps its players and its channel, and a click reaches its player once the answer has come and it has been still for a moment', async () => {
    const page = await show()
    // The asking takes seconds: the site's clock is held, and moved on by the test
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const port = page.ports()[0]!
    await page.send(port, { type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    await page.loads()
    await act(async () => {
      vi.advanceTimersByTime(WHO_MS + 700)
      await pause()
    })
    expect(hosted().length).toBe(1)
    expect((host.querySelector('.embed-shield') as HTMLElement).hidden).toBe(true)
    const heard = await page.send(port, action('still-heard'))
    expect(heard.find((m) => m.type === 'it:result')).toMatchObject({ ok: true })
    // A page that goes on to another of its own documents is asked again, and that document answers for its own channel
    await page.fromFrame({ type: 'it:hello', doc: 'doc-2' })
    await page.send(page.ports()[1]!, { type: 'it:embed', id: 'e2', url: 'https://player.vimeo.com/video/1' })
    await page.loads()
    await act(async () => {
      vi.advanceTimersByTime(WHO_MS + 700)
      await pause()
    })
    expect(hosted().map((f) => f.src)).toEqual(['https://player.vimeo.com/video/1'])
  }, 15_000)

  test('every embed goes when the page’s showing ends, and with the page when it leaves the screen', async () => {
    const page = await show()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    await page.send(page.ports()[0]!, { type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    // The showing is over: the site asks for a new one, and frames the page again, with nothing of the old one's laid over it
    await page.send(page.ports()[0]!, { type: 'it:lapsed' })
    await act(() => tick(50))
    expect(hosted()).toEqual([])
    const again = framed()
    await again.fromFrame({ type: 'it:hello', doc: 'doc-2' })
    await again.send(again.ports()[0]!, { type: 'it:embed', id: 'e2', url: 'https://www.youtube.com/embed/b' })
    expect(hosted().length).toBe(1)
    await act(async () => root.unmount())
    expect(host.querySelectorAll('iframe').length).toBe(0)
    // Torn down already: the test's own teardown has nothing left to do
    root = createRoot(host)
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

// What records for a page, or is open for its photo, belongs to the conversation the person
// allowed. The devices are stand-ins here, as far as the site goes with them: tracks that say
// whether they were stopped, and a recorder. The browsers' own fake devices are in the end-to-end run.
describe('what records or takes a photo for a page, when the page changes hands or is taken back', () => {
  const FIRST = 'machine-1|claude-code|conversation-1'
  const SECOND = 'machine-1|codex|conversation-2'
  const madeBy = (owner: string) => ({ agent: 'Claude Code', machine: 'studio', owner })
  let tracks: { stopped: boolean; ended: () => void }[] = []
  /** Holds the browser's answer to the site's asking for a device, until the test lets it through. */
  let letThrough: (() => void) | null = null
  /** Holds a recorder that was asked to stop before it gives its last piece and says it stopped, until the test lets it finish. */
  let holdStop = false
  let finishStop: (() => void) | null = null
  class Recorder {
    static isTypeSupported = () => true
    state = 'inactive'
    mimeType = 'audio/webm'
    ondataavailable: ((e: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null
    start() {
      this.state = 'recording'
    }
    stop() {
      const finish = () => {
        this.ondataavailable?.({ data: new Blob(['take'], { type: this.mimeType }) })
        this.state = 'inactive'
        queueMicrotask(() => this.onstop?.())
      }
      if (holdStop) finishStop = finish
      else finish()
    }
  }
  beforeEach(() => {
    // The window the person is using: It asks only from one in front
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    tracks = []
    letThrough = null
    holdStop = false
    finishStop = null
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    vi.stubGlobal('MediaRecorder', Recorder)
    const getUserMedia = async (asked: MediaStreamConstraints) => {
      const held = letThrough === null ? null : new Promise<void>((r) => (letThrough = r))
      if (held) await held
      const made = (['audio', 'video'] as const)
        .filter((kind) => asked[kind])
        .map(() => {
          const listeners: (() => void)[] = []
          const t = {
            enabled: true,
            stopped: false,
            stop: () => (t.stopped = true),
            addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
            /** The device goes away, as a camera unplugged does. */
            ended: () => {
              for (const fn of listeners) fn()
            },
          }
          tracks.push(t)
          return t
        })
      return { getTracks: () => made }
    }
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, 'isSecureContext')
  })
  /** The page shown under one conversation, its channel open, and what the person allowed that conversation. */
  async function shownFor(owner: string, kinds: ('mic' | 'camera')[]) {
    const { allow } = await import('./media')
    if (kinds.length) allow('alice', { page: 'page1', title: 'Plan', agent: 'Claude Code', machine: 'studio', owner, kinds })
    const { Mount } = await import('./mount')
    const { outboxBelongsTo } = await import('./outbox')
    outboxBelongsTo('alice')
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => {
      root.render(createElement(Mount, { artifactId: 'page1' as never, title: 'Plan', user: 'alice', madeBy: madeBy(owner) }))
      await tick()
    })
    const page = framed()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-1' })
    const port = page.ports()[0]!
    const heard: any[] = []
    port.onmessage = (m) => heard.push(m.data)
    const ask = async (message: unknown) => {
      port.postMessage(message)
      await act(() => tick(60))
    }
    /** The page is now another conversation's, as when it is opened from there. */
    const handedTo = async (next: string) => {
      const { Mount } = await import('./mount')
      await act(async () => {
        root.render(createElement(Mount, { artifactId: 'page1' as never, title: 'Plan', user: 'alice', madeBy: madeBy(next) }))
        await tick()
      })
    }
    return { heard, ask, handedTo, page }
  }
  const resultOf = (heard: any[], requestId: string) => heard.find((m) => m.type === 'it:result' && m.requestId === requestId)

  test('a recording under way ends when another conversation takes the page over, and what was recorded is thrown away', async () => {
    const { heard, ask, handedTo } = await shownFor(FIRST, ['mic'])
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    expect(resultOf(heard, 'r1')).toMatchObject({ ok: true, recording: { mimeType: 'audio/webm' } })
    expect(tracks.map((t) => t.stopped)).toEqual([false])
    await handedTo(SECOND)
    await arrived(() => heard.some((m) => m.type === 'it:recording'))
    const ended = heard.find((m) => m.type === 'it:recording')
    expect(ended).toMatchObject({ state: 'ended', why: 'taken_over' })
    expect(ended.file).toBeUndefined()
    expect(tracks.map((t) => t.stopped)).toEqual([true])
    const { liveFor } = await import('./media')
    expect(liveFor('page1')).toBeUndefined()
  })

  test('a recording goes on while the page stays with the conversation the person allowed', async () => {
    const { heard, ask, handedTo } = await shownFor(FIRST, ['mic'])
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    await handedTo(FIRST)
    expect(heard.some((m) => m.type === 'it:recording')).toBe(false)
    expect(tracks.map((t) => t.stopped)).toEqual([false])
    await ask({ type: 'it:record-stop', requestId: 'r2', recording: resultOf(heard, 'r1').recording.id, keep: true })
    // The take comes with the answer (jsdom's channel copies a file as a plain object, where a browser's gives a Blob)
    expect(resultOf(heard, 'r2')).toMatchObject({ ok: true })
    expect(resultOf(heard, 'r2').file).toBeDefined()
  })

  test('a recording the browser is still being asked for is not begun for a page that changed hands meanwhile', async () => {
    const { heard, ask, handedTo } = await shownFor(FIRST, ['mic'])
    letThrough = () => {}
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    await handedTo(SECOND)
    letThrough()
    await arrived(() => !!resultOf(heard, 'r1'))
    expect(resultOf(heard, 'r1')).toMatchObject({ ok: false, error: expect.stringMatching(/^Another conversation took this page over/) })
    expect(tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('a camera open for a photo closes when another conversation takes the page over, and no photo is given', async () => {
    const { heard, ask, handedTo } = await shownFor(FIRST, ['camera'])
    await ask({ type: 'it:photo', requestId: 'p1' })
    expect(resultOf(heard, 'p1')).toBeUndefined()
    expect(tracks.map((t) => t.stopped)).toEqual([false])
    await handedTo(SECOND)
    await arrived(() => !!resultOf(heard, 'p1'))
    expect(resultOf(heard, 'p1')).toMatchObject({ ok: false, error: expect.stringMatching(/^Another conversation took this page over/) })
    expect(tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('a camera open for a photo closes when the person takes back what the page was allowed, and no photo is given', async () => {
    const { heard, ask } = await shownFor(FIRST, ['camera'])
    await ask({ type: 'it:photo', requestId: 'p1' })
    const { takeBack } = await import('./media')
    await act(async () => takeBack('alice', 'page1'))
    await arrived(() => !!resultOf(heard, 'p1'))
    expect(resultOf(heard, 'p1')).toMatchObject({ ok: false, error: 'The person took back what they had allowed this page.' })
    expect(tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('a camera the browser gave after what the page was allowed was taken back is closed again at once', async () => {
    const { heard, ask } = await shownFor(FIRST, ['camera'])
    letThrough = () => {}
    await ask({ type: 'it:photo', requestId: 'p1' })
    const { takeBack } = await import('./media')
    await act(async () => takeBack('alice', 'page1'))
    letThrough()
    await arrived(() => !!resultOf(heard, 'p1'))
    expect(resultOf(heard, 'p1')).toMatchObject({ ok: false, error: 'The person took back what they had allowed this page.' })
    expect(tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('a camera the browser gave after the page changed hands is closed again at once', async () => {
    const { heard, ask, handedTo } = await shownFor(FIRST, ['camera'])
    letThrough = () => {}
    await ask({ type: 'it:photo', requestId: 'p1' })
    await handedTo(SECOND)
    letThrough()
    await arrived(() => !!resultOf(heard, 'p1'))
    expect(resultOf(heard, 'p1')).toMatchObject({ ok: false, error: expect.stringMatching(/^Another conversation took this page over/) })
    expect(tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('a take the page asked to stop is not given it when the page changes hands while the recorder finishes', async () => {
    const { heard, ask, handedTo } = await shownFor(FIRST, ['mic'])
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    holdStop = true
    await ask({ type: 'it:record-stop', requestId: 'r2', recording: resultOf(heard, 'r1').recording.id, keep: true })
    expect(resultOf(heard, 'r2')).toBeUndefined()
    await handedTo(SECOND)
    finishStop!()
    await arrived(() => !!resultOf(heard, 'r2'))
    expect(resultOf(heard, 'r2')).toMatchObject({ ok: false, error: expect.stringMatching(/^Another conversation took this page over/) })
    expect(resultOf(heard, 'r2').file).toBeUndefined()
  })

  test('a take the page asked to stop is not given it when what it was allowed is taken back while the recorder finishes', async () => {
    const { heard, ask } = await shownFor(FIRST, ['mic'])
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    holdStop = true
    await ask({ type: 'it:record-stop', requestId: 'r2', recording: resultOf(heard, 'r1').recording.id, keep: true })
    const { takeBack } = await import('./media')
    await act(async () => takeBack('alice', 'page1'))
    finishStop!()
    await arrived(() => !!resultOf(heard, 'r2'))
    expect(resultOf(heard, 'r2')).toMatchObject({ ok: false, error: 'The person took back what they had allowed this page.' })
  })

  test('a recording that ended by itself gives nothing to a page that changed hands while the recorder finished, and the page is told so', async () => {
    const { heard, ask, handedTo } = await shownFor(FIRST, ['mic'])
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    holdStop = true
    // The microphone goes away: what was recorded is the page's, once the recorder has finished
    await act(async () => tracks[0]!.ended())
    await handedTo(SECOND)
    finishStop!()
    await arrived(() => heard.some((m) => m.type === 'it:recording'))
    const ended = heard.find((m) => m.type === 'it:recording')
    expect(ended).toMatchObject({ state: 'ended', why: 'taken_over' })
    expect(ended.file).toBeUndefined()
  })

  test('the person asked about a page that changes hands meanwhile is not taken to have said no, and the page is told why', async () => {
    const { heard, ask, handedTo } = await shownFor(FIRST, [])
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    // The person is being asked: nothing is answered yet
    expect(resultOf(heard, 'r1')).toBeUndefined()
    await handedTo(SECOND)
    await arrived(() => !!resultOf(heard, 'r1'))
    expect(resultOf(heard, 'r1')).toMatchObject({ ok: false, error: expect.stringMatching(/^Another conversation took this page over/) })
    expect(tracks).toEqual([])
    // Asked again, for the conversation that has it now, the person is asked, not refused as having said no
    await ask({ type: 'it:record', requestId: 'r2', audio: true, video: false })
    expect(resultOf(heard, 'r2')).toBeUndefined()
  })

  test('a photo still being made when the page changes hands is not given to it', async () => {
    let made: (() => void) | null = null
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback) {
      made = () => callback(new Blob(['jpeg'], { type: 'image/jpeg' }))
    })
    const { heard, ask, handedTo } = await shownFor(FIRST, ['camera'])
    await ask({ type: 'it:photo', requestId: 'p1' })
    const { shootingNow } = await import('./media')
    // The person takes the photo, and it is being made into a JPEG
    shootingNow()!.take({ videoWidth: 640, videoHeight: 480 } as HTMLVideoElement)
    await handedTo(SECOND)
    made!()
    await arrived(() => !!resultOf(heard, 'p1'))
    expect(resultOf(heard, 'p1')).toMatchObject({ ok: false, error: expect.stringMatching(/^Another conversation took this page over/) })
    expect(resultOf(heard, 'p1').file).toBeUndefined()
    expect(tracks.map((t) => t.stopped)).toEqual([true])
  })

  test('a take still finishing for the conversation before is not given to the page because a recording begun since was allowed for the one that has it now', async () => {
    const { heard, ask, handedTo } = await shownFor(FIRST, ['mic'])
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    holdStop = true
    await ask({ type: 'it:record-stop', requestId: 'r2', recording: resultOf(heard, 'r1').recording.id, keep: true })
    await handedTo(SECOND)
    // The person allows the page for the conversation that has it now, and it records again while the first take finishes
    const { allow } = await import('./media')
    allow('alice', { page: 'page1', title: 'Plan', agent: 'Claude Code', machine: 'studio', owner: SECOND, kinds: ['mic'] })
    await ask({ type: 'it:record', requestId: 'r3', audio: true, video: false })
    expect(resultOf(heard, 'r3')).toMatchObject({ ok: true })
    finishStop!()
    await arrived(() => !!resultOf(heard, 'r2'))
    expect(resultOf(heard, 'r2')).toMatchObject({ ok: false, error: expect.stringMatching(/^Another conversation took this page over/) })
    expect(resultOf(heard, 'r2').file).toBeUndefined()
  })

  test('a page the person said no to is asked about again once another conversation has it', async () => {
    const { heard, ask, handedTo } = await shownFor(FIRST, [])
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    const { currentQuestion } = await import('./media')
    await act(async () => currentQuestion()!.answer(false))
    await arrived(() => !!resultOf(heard, 'r1'))
    expect(resultOf(heard, 'r1')).toMatchObject({ ok: false, error: expect.stringMatching(/did not allow this page/) })
    // Under the same conversation, a no stands for the showing: asked again, it is refused without asking
    await ask({ type: 'it:record', requestId: 'r2', audio: true, video: false })
    expect(resultOf(heard, 'r2')).toMatchObject({ ok: false, error: expect.stringMatching(/did not allow this page/) })
    // Under another, the person is asked
    await handedTo(SECOND)
    await ask({ type: 'it:record', requestId: 'r3', audio: true, video: false })
    expect(resultOf(heard, 'r3')).toBeUndefined()
    expect(currentQuestion()).not.toBeNull()
  })

  test('a take that was finishing when the person took back what the page was allowed stays discarded, whatever is allowed again', async () => {
    const { heard, ask } = await shownFor(FIRST, ['mic'])
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    holdStop = true
    await ask({ type: 'it:record-stop', requestId: 'r2', recording: resultOf(heard, 'r1').recording.id, keep: true })
    const { allow, takeBack } = await import('./media')
    await act(async () => takeBack('alice', 'page1'))
    // Allowed again, for the same conversation, before the recorder has finished
    allow('alice', { page: 'page1', title: 'Plan', agent: 'Claude Code', machine: 'studio', owner: FIRST, kinds: ['mic'] })
    finishStop!()
    await arrived(() => !!resultOf(heard, 'r2'))
    expect(resultOf(heard, 'r2')).toMatchObject({ ok: false, error: 'The person took back what they had allowed this page.' })
    expect(resultOf(heard, 'r2').file).toBeUndefined()
  })

  test('a recording that ended by itself as its leave was taken back and given again gives the page nothing', async () => {
    const { heard, ask } = await shownFor(FIRST, ['mic'])
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    holdStop = true
    await act(async () => tracks[0]!.ended())
    const { allow, takeBack } = await import('./media')
    await act(async () => takeBack('alice', 'page1'))
    allow('alice', { page: 'page1', title: 'Plan', agent: 'Claude Code', machine: 'studio', owner: FIRST, kinds: ['mic'] })
    finishStop!()
    await arrived(() => heard.some((m) => m.type === 'it:recording'))
    const ended = heard.find((m) => m.type === 'it:recording')
    expect(ended).toMatchObject({ state: 'ended', why: 'taken_back' })
    expect(ended.file).toBeUndefined()
  })

  test('more allowed beside what a take was begun under, as the camera beside the microphone, leaves the take the page’s', async () => {
    const { heard, ask } = await shownFor(FIRST, ['mic'])
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    holdStop = true
    await ask({ type: 'it:record-stop', requestId: 'r2', recording: resultOf(heard, 'r1').recording.id, keep: true })
    const { allow } = await import('./media')
    allow('alice', { page: 'page1', title: 'Plan', agent: 'Claude Code', machine: 'studio', owner: FIRST, kinds: ['camera'] })
    finishStop!()
    await arrived(() => !!resultOf(heard, 'r2'))
    expect(resultOf(heard, 'r2')).toMatchObject({ ok: true })
    expect(resultOf(heard, 'r2').file).toBeDefined()
  })

  /** The browser says it will ask about these itself, the first time, as the Permissions API says it. */
  function browserWillAskAbout(names: string[], held?: (s: { state: string }) => void) {
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: {
        query: ({ name }: { name: string }) => {
          const state = { state: names.includes(name) ? 'prompt' : 'granted' }
          return held ? new Promise((r) => held(Object.assign(state, { go: () => r(state) }))) : Promise.resolve(state)
        },
      },
    })
  }
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'permissions')
    Reflect.deleteProperty(document, 'visibilityState')
  })

  test('a page’s call is its asking: It asks in its bar first, and where the browser asks too, the bar then says which page the browser asks for', async () => {
    browserWillAskAbout(['microphone', 'camera'])
    const { heard, ask } = await shownFor(FIRST, [])
    const { browserAskingNow, currentQuestion, grantFor } = await import('./media')
    letThrough = () => {}
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    // It's own question comes first, for what the call wants, and the browser is not asked yet
    expect(currentQuestion()).toMatchObject({ page: 'page1', kinds: ['mic'] })
    expect(browserAskingNow()).toBeNull()
    expect(tracks).toEqual([])
    await act(async () => {
      currentQuestion()!.answer(true)
      await tick(60)
    })
    // Then the browser asks, and It's bar says which page that is for, with nothing of It's own to answer
    expect(currentQuestion()).toBeNull()
    expect(browserAskingNow()).toMatchObject({ page: 'page1', title: 'Plan', kinds: ['mic'] })
    await act(async () => {
      letThrough?.()
      await tick(60)
    })
    expect(resultOf(heard, 'r1')).toMatchObject({ ok: true })
    expect(browserAskingNow()).toBeNull()
    expect(grantFor('alice', 'page1', FIRST, ['mic'])).not.toBeNull()
    expect(grantFor('alice', 'page1', FIRST, ['camera'])).toBeNull()
  })

  test('a later call for something more asks for that alone, and what the page is allowed stays the same grant', async () => {
    const { heard, ask } = await shownFor(FIRST, [])
    const { currentQuestion, grantFor } = await import('./media')
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    expect(currentQuestion()!.kinds).toEqual(['mic'])
    await act(async () => currentQuestion()!.answer(true))
    await arrived(() => !!resultOf(heard, 'r1'))
    const first = grantFor('alice', 'page1', FIRST, ['mic'])
    await ask({ type: 'it:record-stop', requestId: 'r2', recording: resultOf(heard, 'r1').recording.id, keep: false })
    // The same page asks again, for the camera, and is asked about the camera only
    await ask({ type: 'it:photo', requestId: 'p1' })
    expect(currentQuestion()!.kinds).toEqual(['camera'])
    await act(async () => currentQuestion()!.answer(true))
    await arrived(() => tracks.length === 2)
    expect(grantFor('alice', 'page1', FIRST, ['mic', 'camera'])).toBe(first)
    // And a recording of both now asks nothing
    expect(currentQuestion()).toBeNull()
  })

  test('a page in a tab or a window that is not in front is not asked about, and the page is told why', async () => {
    const { heard, ask } = await shownFor(FIRST, [])
    const { currentQuestion } = await import('./media')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    expect(currentQuestion()).toBeNull()
    expect(resultOf(heard, 'r1')).toMatchObject({ ok: false, error: expect.stringMatching(/only while this screen shows it/) })
    expect(tracks).toEqual([])
  })

  test('a page allowed the camera is not given it while the screen does not show the page, where the bar could not be seen', async () => {
    const { heard, ask } = await shownFor(FIRST, ['mic', 'camera'])
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await ask({ type: 'it:photo', requestId: 'p1' })
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    expect(resultOf(heard, 'p1')).toMatchObject({ ok: false, error: expect.stringMatching(/only while this screen shows it/) })
    expect(resultOf(heard, 'r1')).toMatchObject({ ok: false, error: expect.stringMatching(/only while this screen shows it/) })
    expect(tracks).toEqual([])
  })

  test('a camera open for a photo closes when the screen stops showing the page, and the page is told why', async () => {
    const { heard, ask } = await shownFor(FIRST, ['camera'])
    const { shootingNow } = await import('./media')
    await ask({ type: 'it:photo', requestId: 'p1' })
    expect(shootingNow()).not.toBeNull()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await tick(60)
    })
    expect(shootingNow()).toBeNull()
    expect(tracks.every((t) => t.stopped)).toBe(true)
    expect(resultOf(heard, 'p1')).toMatchObject({ ok: false, error: expect.stringMatching(/^The screen stopped showing the page/) })
  })

  test('a window that is shown but not the one the person is using is not asked from, though a page allowed already goes on there', async () => {
    const { heard, ask } = await shownFor(FIRST, [])
    const { currentQuestion, allow } = await import('./media')
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    expect(currentQuestion()).toBeNull()
    expect(resultOf(heard, 'r1')).toMatchObject({ ok: false, error: expect.stringMatching(/only while the page is in front/) })
    // Allowed already, from before: what it does shows in the bar of a window that is shown
    allow('alice', { page: 'page1', title: 'Plan', agent: 'Claude Code', machine: 'studio', owner: FIRST, kinds: ['mic'] })
    await ask({ type: 'it:record', requestId: 'r2', audio: true, video: false })
    expect(resultOf(heard, 'r2')).toMatchObject({ ok: true })
  })

  test('a document the page has left does not begin what it asked for, however late the browser gives the device', async () => {
    const { heard, ask } = await shownFor(FIRST, ['mic', 'camera'])
    const { liveFor, shootingNow } = await import('./media')
    letThrough = () => {}
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    const page = framed()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-2' })
    await act(async () => {
      letThrough?.()
      await tick(60)
    })
    expect(liveFor('page1')).toBeUndefined()
    expect(tracks.every((t) => t.stopped)).toBe(true)
    expect(resultOf(heard, 'r1')).toBeUndefined()
    // And the same for a photo camera
    const port = page.ports().at(-1)!
    letThrough = () => {}
    port.postMessage({ type: 'it:photo', requestId: 'p1' })
    await act(() => tick(60))
    await page.fromFrame({ type: 'it:hello', doc: 'doc-3' })
    await act(async () => {
      letThrough?.()
      await tick(60)
    })
    expect(shootingNow()).toBeNull()
    expect(tracks.every((t) => t.stopped)).toBe(true)
  })

  test('a no lasts for the showing: a page that has its frame shown afresh is not asked about again', async () => {
    const { heard, ask } = await shownFor(FIRST, [])
    const { currentQuestion } = await import('./media')
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    await act(async () => currentQuestion()!.answer(false))
    await arrived(() => !!resultOf(heard, 'r1'))
    expect(resultOf(heard, 'r1')).toMatchObject({ ok: false, error: expect.stringMatching(/did not allow this page/) })
    // The page says its showing is over, and is framed afresh, with a channel of its own
    const before = host.querySelector('iframe')
    await ask({ type: 'it:lapsed' })
    await act(() => tick(60))
    const again = framed()
    expect(again.frame).not.toBe(before)
    await again.fromFrame({ type: 'it:hello', doc: 'doc-2' })
    const port = again.ports()[0]!
    const later: any[] = []
    port.onmessage = (m) => later.push(m.data)
    port.postMessage({ type: 'it:record', requestId: 'r2', audio: true, video: false })
    await act(() => tick(60))
    expect(currentQuestion()).toBeNull()
    expect(resultOf(later, 'r2')).toMatchObject({ ok: false, error: expect.stringMatching(/did not allow this page/) })
  })

  test('another document in the frame takes away the question the one before asked, which is not taken for a no, and asks for itself', async () => {
    const { heard, ask } = await shownFor(FIRST, [])
    const { currentQuestion } = await import('./media')
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    expect(currentQuestion()).not.toBeNull()
    const page = framed()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-2' })
    expect(currentQuestion()).toBeNull()
    expect(resultOf(heard, 'r1')).toBeUndefined()
    const port = page.ports().at(-1)!
    const later: any[] = []
    port.onmessage = (m) => later.push(m.data)
    port.postMessage({ type: 'it:record', requestId: 'r2', audio: true, video: false })
    await act(() => tick(60))
    // Asked, and not refused as having said no
    expect(currentQuestion()).toMatchObject({ kinds: ['mic'] })
    expect(resultOf(later, 'r2')).toBeUndefined()
  })

  test('another document in the frame ends what the one before was recording, and closes the camera it opened', async () => {
    const { heard, ask } = await shownFor(FIRST, ['mic', 'camera'])
    const { liveFor, shootingNow } = await import('./media')
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    expect(resultOf(heard, 'r1')).toMatchObject({ ok: true })
    const page = framed()
    await page.fromFrame({ type: 'it:hello', doc: 'doc-2' })
    await arrived(() => tracks[0]!.stopped)
    expect(liveFor('page1')).toBeUndefined()
    // And a photo camera the next document opens closes when a third takes its place
    const port = page.ports().at(-1)!
    port.postMessage({ type: 'it:photo', requestId: 'p1' })
    await arrived(() => shootingNow() !== null)
    await page.fromFrame({ type: 'it:hello', doc: 'doc-3' })
    await arrived(() => shootingNow() === null)
    expect(tracks.every((t) => t.stopped)).toBe(true)
  })

  test('a page that changes hands while the browser is asked what it will ask is given nothing of what the browser then gives', async () => {
    let held: { go: () => void } | null = null
    browserWillAskAbout(['microphone'], (s) => (held = s as never))
    const { heard, ask, handedTo } = await shownFor(FIRST, [])
    const { currentQuestion } = await import('./media')
    await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
    await act(async () => {
      currentQuestion()!.answer(true)
      await tick(60)
    })
    expect(held).not.toBeNull()
    await handedTo(SECOND)
    await act(async () => {
      held!.go()
      await tick(60)
    })
    expect(resultOf(heard, 'r1')).toMatchObject({ ok: false, error: expect.stringMatching(/^Another conversation took this page over/) })
    expect(tracks.every((t) => t.stopped)).toBe(true)
  })

  test('a frame that fills the screen is put back in its place when the page asks for the microphone, so that It’s bar, which asks, is seen', async () => {
    const { ask } = await shownFor(FIRST, [])
    const iframe = document.querySelector('.mount iframe')!
    const exit = vi.fn(async () => {})
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => iframe })
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
    try {
      await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
      expect(exit).toHaveBeenCalled()
      expect((await import('./media')).currentQuestion()).not.toBeNull()
    } finally {
      Reflect.deleteProperty(document, 'fullscreenElement')
      Reflect.deleteProperty(document, 'exitFullscreen')
    }
  })

  // The camera live to the page: the site opens it and sends the page each picture it gives
  describe('the camera, live to the page', () => {
    /** Whoever waits for the camera's next picture. */
    let waiting: (() => void) | null = null
    const kept: [object, string, PropertyDescriptor | undefined][] = []
    const standIn = (on: object, name: string, value: PropertyDescriptor) => {
      kept.push([on, name, Object.getOwnPropertyDescriptor(on, name)])
      Object.defineProperty(on, name, { configurable: true, ...value })
    }
    beforeEach(() => {
      waiting = null
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
      standIn(HTMLMediaElement.prototype, 'readyState', { get: () => 4 })
      standIn(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
        value(fn: () => void) {
          waiting = fn
          return 1
        },
      })
      // A picture is an ImageBitmap in a browser. Here it is something a channel hands over as it does one
      vi.stubGlobal('createImageBitmap', async () => Object.assign(new ArrayBuffer(8), { width: 640, height: 480, close() {} }))
    })
    afterEach(() => {
      for (const [on, name, was] of kept.splice(0).reverse())
        if (was) Object.defineProperty(on, name, was)
        else Reflect.deleteProperty(on, name)
    })
    /** The camera gives a picture, and what the site sends of it arrives. */
    const picture = async () => {
      const next = waiting
      waiting = null
      next?.()
      await act(() => tick(20))
    }
    const frames = (heard: any[]) => heard.filter((m) => m.type === 'it:camera-frame')
    const states = (heard: any[]) => heard.filter((m) => m.type === 'it:camera-state')
    const openLive = { type: 'it:camera', requestId: 'c1', camera: 'cam-a', video: { facingMode: 'user' } }
    /** Where the grants of this browser are kept, as media.ts keeps them. */
    const GRANTS = 'it.media.alice.a-display-key-000001'
    const day = 24 * 60 * 60_000

    test('a page that calls for the camera is shown it live once the person allows it in the bar, asked about the camera alone, and is given its pictures', async () => {
      const { heard, ask } = await shownFor(FIRST, [])
      const { currentQuestion } = await import('./media')
      await ask(openLive)
      expect(resultOf(heard, 'c1')).toBeUndefined()
      expect(currentQuestion()!.kinds).toEqual(['camera'])
      await act(async () => currentQuestion()!.answer(true))
      await arrived(() => !!resultOf(heard, 'c1'))
      expect(resultOf(heard, 'c1')).toMatchObject({ ok: true })
      await picture()
      expect(frames(heard)).toMatchObject([{ camera: 'cam-a', frame: 1 }])
      expect(frames(heard)[0].picture.byteLength).toBe(8)
      expect(tracks.map((t) => t.stopped)).toEqual([false])
    })

    test('a page allowed once on this screen is shown the camera live with nothing more asked, and what it was allowed runs on from now', async () => {
      const { heard, ask } = await shownFor(FIRST, ['mic', 'camera'])
      const { currentQuestion, grantsOf } = await import('./media')
      // Allowed ten days ago, and unused since
      const before = JSON.parse(localStorage.getItem(GRANTS)!)
      localStorage.setItem(GRANTS, JSON.stringify(before.map((g: any) => ({ ...g, at: g.at - 10 * day }))))
      expect(grantsOf('alice')[0]!.used).toBeUndefined()
      await ask(openLive)
      expect(currentQuestion()).toBeNull()
      expect(resultOf(heard, 'c1')).toMatchObject({ ok: true })
      const [now] = grantsOf('alice')
      expect(now!.id).toBe(before[0].id)
      expect(Date.now() - now!.used!).toBeLessThan(5000)
      // Noted beside the grants, which are left as they were
      expect(JSON.parse(localStorage.getItem(GRANTS)!)[0].used).toBeUndefined()
    })

    test('the page is sent a few pictures at a time, and the next once it says it drew one', async () => {
      const { heard, ask, page } = await shownFor(FIRST, ['camera'])
      await ask(openLive)
      for (let n = 0; n < 4; n++) await picture()
      expect(frames(heard).map((m) => m.frame)).toEqual([1, 2])
      const port = page.ports()[0]!
      // Said of another camera, or of a picture it was never sent, it makes no room
      port.postMessage({ type: 'it:camera-drawn', camera: 'cam-b', frame: 1 })
      port.postMessage({ type: 'it:camera-drawn', camera: 'cam-a', frame: 9 })
      await act(() => tick(20))
      await picture()
      expect(frames(heard).map((m) => m.frame)).toEqual([1, 2])
      port.postMessage({ type: 'it:camera-drawn', camera: 'cam-a', frame: 1 })
      await act(() => tick(20))
      await picture()
      expect(frames(heard).map((m) => m.frame)).toEqual([1, 2, 3])
    })

    test('the live camera ends when another conversation takes the page over, and the page is told why and sent nothing more', async () => {
      const { heard, ask, handedTo } = await shownFor(FIRST, ['camera'])
      await ask(openLive)
      await picture()
      await handedTo(SECOND)
      expect(states(heard)).toMatchObject([{ camera: 'cam-a', state: 'ended', why: 'taken_over' }])
      expect(tracks.map((t) => t.stopped)).toEqual([true])
      await picture()
      expect(frames(heard)).toHaveLength(1)
      const { cameraFor } = await import('./media')
      expect(cameraFor('page1')).toBeUndefined()
    })

    test('the live camera ends when the person takes back what the page was allowed', async () => {
      const { heard, ask } = await shownFor(FIRST, ['camera'])
      await ask(openLive)
      const { takeBack } = await import('./media')
      await act(async () => takeBack('alice', 'page1'))
      expect(states(heard)).toMatchObject([{ state: 'ended', why: 'taken_back' }])
      expect(tracks.map((t) => t.stopped)).toEqual([true])
    })

    test('the live camera ends when another tab takes back what the page was allowed and allows it again before this tab hears of either', async () => {
      const { heard, ask } = await shownFor(FIRST, ['camera'])
      await ask(openLive)
      const before = localStorage.getItem(GRANTS)
      const again = JSON.stringify(JSON.parse(before!).map((g: any) => ({ ...g, id: 'a-grant-made-in-another-tab', at: Date.now(), used: Date.now() })))
      Storage.prototype.setItem.call(localStorage, GRANTS, again)
      await act(async () => {
        window.dispatchEvent(new StorageEvent('storage', { key: GRANTS, oldValue: before, newValue: null }))
        window.dispatchEvent(new StorageEvent('storage', { key: GRANTS, oldValue: null, newValue: again }))
      })
      expect(states(heard)).toMatchObject([{ state: 'ended', why: 'taken_back' }])
      expect(tracks.map((t) => t.stopped)).toEqual([true])
    })

    test('the live camera ends at the next picture once what the page was allowed has gone 30 days unused, and that picture is not sent', async () => {
      const { heard, ask } = await shownFor(FIRST, ['camera'])
      await ask(openLive)
      await picture()
      // Thirty-one days pass, as far as what is kept goes, the grant's last use among it: nothing tells this tab of it
      const grants = JSON.parse(localStorage.getItem(GRANTS)!)
      Storage.prototype.setItem.call(localStorage, GRANTS, JSON.stringify(grants.map((g: any) => ({ ...g, at: g.at - 31 * day }))))
      const used = `${GRANTS}.used.${grants[0].id}`
      expect(Number(localStorage.getItem(used))).toBeGreaterThan(0)
      Storage.prototype.setItem.call(localStorage, used, String(Number(localStorage.getItem(used)) - 31 * day))
      await picture()
      expect(frames(heard)).toHaveLength(1)
      expect(states(heard)).toMatchObject([{ state: 'ended', why: 'taken_back' }])
      expect(tracks.map((t) => t.stopped)).toEqual([true])
    })

    test('a camera the browser gave after the page changed hands is closed again at once, and the page is told why', async () => {
      const { heard, ask, handedTo } = await shownFor(FIRST, ['camera'])
      letThrough = () => {}
      await ask(openLive)
      await handedTo(SECOND)
      letThrough()
      await arrived(() => !!resultOf(heard, 'c1'))
      expect(resultOf(heard, 'c1')).toMatchObject({ ok: false, error: expect.stringMatching(/^Another conversation took this page over/) })
      expect(tracks.map((t) => t.stopped)).toEqual([true])
      await picture()
      expect(frames(heard)).toEqual([])
    })

    test('a document the page has left does not have the camera opened live for it, however late the browser gives the camera', async () => {
      const { heard, ask, page } = await shownFor(FIRST, ['camera'])
      letThrough = () => {}
      await ask(openLive)
      await page.fromFrame({ type: 'it:hello', doc: 'doc-2' })
      await act(async () => {
        letThrough?.()
        await tick(60)
      })
      const { cameraFor } = await import('./media')
      expect(cameraFor('page1')).toBeUndefined()
      expect(tracks.every((t) => t.stopped)).toBe(true)
      // The document that asked is gone, and is answered nothing
      expect(resultOf(heard, 'c1')).toBeUndefined()
      await picture()
      expect(frames(heard)).toEqual([])
    })

    test('a camera the browser gave after what the page was allowed was taken back is closed again at once', async () => {
      const { heard, ask } = await shownFor(FIRST, ['camera'])
      letThrough = () => {}
      await ask(openLive)
      const { takeBack } = await import('./media')
      await act(async () => takeBack('alice', 'page1'))
      letThrough()
      await arrived(() => !!resultOf(heard, 'c1'))
      expect(resultOf(heard, 'c1')).toMatchObject({ ok: false, error: 'The person took back what they had allowed this page.' })
      expect(tracks.map((t) => t.stopped)).toEqual([true])
    })

    test('while the camera is live a photo and a recording with video are refused, saying the page can take its own picture, and once it is closed they are not', async () => {
      const { heard, ask } = await shownFor(FIRST, ['mic', 'camera'])
      await ask(openLive)
      await ask({ type: 'it:photo', requestId: 'p1' })
      await ask({ type: 'it:record', requestId: 'r1', audio: true, video: true })
      for (const id of ['p1', 'r1'])
        expect(resultOf(heard, id)).toMatchObject({
          ok: false,
          error: expect.stringMatching(/^The camera is live to this page just now.*cam\.onframe or cam\.stream/),
        })
      await ask({ type: 'it:camera-stop', requestId: 'c2', camera: 'cam-a' })
      expect(resultOf(heard, 'c2')).toMatchObject({ ok: true })
      expect(tracks.map((t) => t.stopped)).toEqual([true])
      // Closed as the page asked, and not told of it as of something it did not ask
      expect(states(heard)).toEqual([])
      await ask({ type: 'it:record', requestId: 'r2', audio: true, video: true })
      expect(resultOf(heard, 'r2')).toMatchObject({ ok: true })
    })

    test('sound is recorded beside the live camera, begun after it, each with its own grant check, and each stopped by itself', async () => {
      const { heard, ask } = await shownFor(FIRST, ['mic', 'camera'])
      await ask(openLive)
      await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
      expect(resultOf(heard, 'r1')).toMatchObject({ ok: true, recording: { mimeType: 'audio/webm' } })
      const { cameraFor, liveFor } = await import('./media')
      expect([!!cameraFor('page1'), !!liveFor('page1')]).toEqual([true, true])
      expect(tracks.map((t) => t.stopped)).toEqual([false, false])
      // The recording stopped, the camera goes on, and pictures still come
      await ask({ type: 'it:record-stop', requestId: 'r2', recording: resultOf(heard, 'r1').recording.id, keep: true })
      expect(resultOf(heard, 'r2')).toMatchObject({ ok: true })
      expect(tracks.map((t) => t.stopped)).toEqual([false, true])
      await picture()
      expect(frames(heard)).toHaveLength(1)
      expect(states(heard)).toEqual([])
    })

    test('the camera is shown live beside a recording of sound already under way, and the camera’s end leaves the recording going', async () => {
      const { heard, ask } = await shownFor(FIRST, ['mic', 'camera'])
      await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
      await ask(openLive)
      expect(resultOf(heard, 'c1')).toMatchObject({ ok: true })
      await ask({ type: 'it:camera-stop', requestId: 'c2', camera: 'cam-a' })
      const { liveFor } = await import('./media')
      expect(liveFor('page1')).toBeDefined()
      expect(tracks.map((t) => t.stopped)).toEqual([false, true])
      expect(heard.some((m) => m.type === 'it:recording')).toBe(false)
    })

    test('a recording of sound beside the live camera asks in the bar for the microphone where only the camera is allowed, and both go on under one grant', async () => {
      const { heard, ask } = await shownFor(FIRST, ['camera'])
      const { currentQuestion, grantFor } = await import('./media')
      await ask(openLive)
      const grant = grantFor('alice', 'page1', FIRST, ['camera'])
      await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
      expect(currentQuestion()!.kinds).toEqual(['mic'])
      await act(async () => currentQuestion()!.answer(true))
      await arrived(() => !!resultOf(heard, 'r1'))
      expect(resultOf(heard, 'r1')).toMatchObject({ ok: true })
      expect(grantFor('alice', 'page1', FIRST, ['mic', 'camera'])).toBe(grant)
      expect(tracks.map((t) => t.stopped)).toEqual([false, false])
      expect(states(heard)).toEqual([])
    })

    test('a takeover ends both the live camera and the recording of sound beside it', async () => {
      const first = await shownFor(FIRST, ['mic', 'camera'])
      await first.ask(openLive)
      await first.ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
      await first.handedTo(SECOND)
      await arrived(() => first.heard.some((m) => m.type === 'it:recording'))
      expect(states(first.heard)).toMatchObject([{ state: 'ended', why: 'taken_over' }])
      expect(first.heard.find((m) => m.type === 'it:recording')).toMatchObject({ state: 'ended', why: 'taken_over' })
      expect(tracks.map((t) => t.stopped)).toEqual([true, true])
    })

    test('a takeback ends both the live camera and the recording of sound beside it', async () => {
      const { heard, ask } = await shownFor(FIRST, ['mic', 'camera'])
      await ask(openLive)
      await ask({ type: 'it:record', requestId: 'r1', audio: true, video: false })
      const { takeBack } = await import('./media')
      await act(async () => takeBack('alice', 'page1'))
      await arrived(() => heard.some((m) => m.type === 'it:recording'))
      expect(states(heard)).toMatchObject([{ state: 'ended', why: 'taken_back' }])
      expect(heard.find((m) => m.type === 'it:recording')).toMatchObject({ state: 'ended', why: 'taken_back' })
      expect(tracks.map((t) => t.stopped)).toEqual([true, true])
    })

    test('the camera is not shown live while the page records video or has It’s view of the camera open for a photo, and the page is told which', async () => {
      const { heard, ask } = await shownFor(FIRST, ['mic', 'camera'])
      await ask({ type: 'it:record', requestId: 'r1', audio: true, video: true })
      await ask(openLive)
      expect(resultOf(heard, 'c1')).toMatchObject({ ok: false, error: expect.stringMatching(/^This page is recording from the camera just now/) })
      await ask({ type: 'it:record-stop', requestId: 'r2', recording: resultOf(heard, 'r1').recording.id, keep: false })
      await ask({ type: 'it:photo', requestId: 'p1' })
      await ask({ ...openLive, requestId: 'c2' })
      expect(resultOf(heard, 'c2')).toMatchObject({ ok: false, error: expect.stringMatching(/view of the camera is open for a photo/) })
      expect(frames(heard)).toEqual([])
    })

    test('a frame that fills the screen is put back in its place when the camera opens live, and again if it fills the screen while the camera is live', async () => {
      let full: Element | null = null
      // Leaving the screen whole, as a browser does when it is asked to
      const exit = vi.fn(async () => {
        full = null
      })
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full })
      Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
      try {
        const { ask } = await shownFor(FIRST, ['camera'])
        // Already filling the screen when the camera is opened
        full = host.querySelector('iframe')
        await ask(openLive)
        expect(exit).toHaveBeenCalledTimes(1)
        // And made to fill it again while the camera is live
        full = host.querySelector('iframe')
        await act(async () => document.dispatchEvent(new Event('fullscreenchange')))
        expect(exit).toHaveBeenCalledTimes(2)
        // Once the camera is closed, the site still leaves a fullscreen of the page's frame, which
        // would cover the bar, and gives the page It's own fullscreen instead
        await ask({ type: 'it:camera-stop', requestId: 'c2', camera: 'cam-a' })
        full = host.querySelector('iframe')
        await act(async () => document.dispatchEvent(new Event('fullscreenchange')))
        expect(exit).toHaveBeenCalledTimes(3)
      } finally {
        Reflect.deleteProperty(document, 'fullscreenElement')
        Reflect.deleteProperty(document, 'exitFullscreen')
      }
    })

    test('a page that loads another of its documents has the camera closed at once, though it had drawn none of what it was sent, and the new document can open it', async () => {
      const { heard, ask, page } = await shownFor(FIRST, ['camera'])
      await ask(openLive)
      await picture()
      await picture()
      // Two pictures sent and none drawn: nothing more is sent, so nothing a picture does would close it
      expect(frames(heard)).toHaveLength(2)
      await page.fromFrame({ type: 'it:hello', doc: 'doc-2' })
      expect(tracks.map((t) => t.stopped)).toEqual([true])
      const { cameraFor } = await import('./media')
      expect(cameraFor('page1')).toBeUndefined()
      // The new document is let open it
      const port = page.ports()[1]!
      const now: any[] = []
      port.onmessage = (m) => now.push(m.data)
      port.postMessage({ ...openLive, requestId: 'c2', camera: 'cam-b' })
      await act(() => tick(60))
      expect(resultOf(now, 'c2')).toMatchObject({ ok: true })
      expect(tracks.map((t) => t.stopped)).toEqual([true, false])
    })

    test('a live camera whose page drew none of what it was sent is ended when what it was allowed lapses, within a second and without another picture', async () => {
      const { heard, ask } = await shownFor(FIRST, ['camera'])
      await ask(openLive)
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      // Opened again under the held clock, so that what checks on it every second is the test's to move
      await ask({ type: 'it:camera-stop', requestId: 'c0', camera: 'cam-a' })
      await ask({ ...openLive, requestId: 'c1b' })
      await picture()
      await picture()
      expect(frames(heard)).toHaveLength(2)
      const grants = JSON.parse(localStorage.getItem(GRANTS)!)
      Storage.prototype.setItem.call(localStorage, GRANTS, JSON.stringify(grants.map((g: any) => ({ ...g, at: g.at - 31 * day }))))
      const used = `${GRANTS}.used.${grants[0].id}`
      Storage.prototype.setItem.call(localStorage, used, String(Number(localStorage.getItem(used)) - 31 * day))
      await act(async () => vi.advanceTimersByTime(1000))
      expect(states(heard)).toMatchObject([{ state: 'ended', why: 'taken_back' }])
      expect(tracks.map((t) => t.stopped)).toEqual([true, true])
    })

    test('the camera closes when the page is no longer shown', async () => {
      const { ask } = await shownFor(FIRST, ['camera'])
      await ask(openLive)
      await act(async () => root.render(createElement('p')))
      expect(tracks.map((t) => t.stopped)).toEqual([true])
    })
  })
})
