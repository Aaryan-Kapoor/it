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
    return { heard, ask, handedTo }
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
})
