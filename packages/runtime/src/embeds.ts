// Players and maps from the providers on It's list, shown where the page puts them.
//
// A page is a sandboxed document with no origin, and every frame inside it is held to the same:
// it has no storage, and it sends no `Referer`. YouTube's player stops at its first line there,
// and the other players never start. So a page does not frame them itself. It keeps an element
// in its own layout as the place for one, and the site that shows the page frames the player
// from its own origin, in a layer laid over the page, exactly over that element. This script
// tells the site where the element is on each frame that it moves, how much of it is cut off by
// what holds it and by the window, and when it is hidden or gone.
//
// A page asks for that in either of two ways. An `<iframe>` whose address is the embed of a
// provider on the list is taken up as it appears, and again when its address changes: it keeps
// its place and its size, and is given an empty document of its own instead, so that the player
// does not load inside the page. And `It.embed(element, url)` asks for it outright, over any
// element, and gives back a way to talk to the player.
import { cutOff, type Edges, EMBED, EMBEDS, embedFor, jsonText, type PageToSite, type SiteToPage } from '@it/protocol'

/** What a page holds of one embed: what `It.embed` gives back. */
export interface EmbedHandle {
  /** The provider's name, such as `YouTube`. */
  readonly provider: string
  /** The embed's address, as It reads it. */
  readonly url: string
  /** Sends the player a message, which the site passes on to it at its own origin. It is plain data, as JSON has it, of at most 64 KB. */
  post(message: unknown): void
  /** Told of each message the player sends, as `{ data }`. */
  onmessage: ((event: { data: unknown }) => void) | null
  /** Told each time the player's frame has loaded. What is posted before then waits for it. */
  onload: (() => void) | null
  /** Takes the player away. Taking its element out of the page does too. */
  remove(): void
}

type Placed = Omit<Extract<PageToSite, { type: 'it:embed-at' }>, 'type' | 'id'>

interface Hosted {
  id: string
  el: Element
  provider: string
  url: string
  /** Asked for with `It.embed`, and not taken up from the page's own markup. */
  asked: boolean
  ended: boolean
  /** Where it was last said to be, as text, so that only a change is sent. */
  last: string
  /** What the page posted before the site said whether it hosts embeds. */
  held: unknown[]
  handle: EmbedHandle
}

/** The providers' names, as a sentence says them. */
const NAMES = (() => {
  const names = EMBEDS.map((p) => p.name)
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
})()

/** Whether a function the page gave threw: said as any error in the page's script is, after this has done its own part. */
function told(fn: () => void): void {
  try {
    fn()
  } catch (err) {
    setTimeout(() => {
      throw err
    })
  }
}

/** The box of an element's inside, within its border, as it is on the screen now. */
function inside(el: Element): { box: Edges; round: number } {
  const r = el.getBoundingClientRect()
  if (!(el instanceof HTMLElement) || el.offsetWidth <= 0 || el.offsetHeight <= 0 || el.clientWidth <= 0 || el.clientHeight <= 0)
    return { box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, round: 0 }
  // How much the element is drawn larger or smaller than it is laid out, as a transform makes it
  const sx = r.width / el.offsetWidth
  const sy = r.height / el.offsetHeight
  const left = r.left + el.clientLeft * sx
  const top = r.top + el.clientTop * sy
  // Its corners, where all four are rounded alike, as they are inside its border
  const style = getComputedStyle(el)
  const corners = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
  const outer = corners.every((c) => c === corners[0]) && /^\d+(\.\d+)?px$/.test(corners[0] ?? '') ? Number.parseFloat(corners[0]!) : 0
  const round = Math.max(0, outer - Math.max(el.clientLeft, el.clientTop)) * Math.min(sx, sy)
  return { box: { left, top, right: left + el.clientWidth * sx, bottom: top + el.clientHeight * sy }, round }
}

/**
 * Where an element is, as the site is told it: its inside in the page's own pixels, what cuts it
 * off, and whether any of it is to be seen. What cuts it off is the window, and each element
 * that holds it and clips what it holds, up to the first that stays where it is on the screen.
 */
function placement(el: Element): Placed {
  const { box, round } = inside(el)
  const root = document.documentElement
  // The window, without its scroll bars. In a document with no doctype the root is as tall as what it holds
  const standards = document.compatMode !== 'BackCompat'
  const within: Edges[] = [{ left: 0, top: 0, right: standards ? root.clientWidth : innerWidth, bottom: standards ? root.clientHeight : innerHeight }]
  for (let p = el.parentElement; p && p !== document.body && p !== root; p = p.parentElement) {
    const style = getComputedStyle(p)
    const acrossClips = style.overflowX !== 'visible'
    const downClips = style.overflowY !== 'visible'
    if (acrossClips || downClips) {
      // Its inside on the screen: its size as laid out, drawn larger or smaller as a transform draws it
      const r = p.getBoundingClientRect()
      const laidOut = p instanceof HTMLElement && p.offsetWidth > 0 && p.offsetHeight > 0
      const sx = laidOut ? r.width / p.offsetWidth : 1
      const sy = laidOut ? r.height / p.offsetHeight : 1
      const left = r.left + p.clientLeft * sx
      const top = r.top + p.clientTop * sy
      within.push({
        left: acrossClips ? left : Number.NEGATIVE_INFINITY,
        top: downClips ? top : Number.NEGATIVE_INFINITY,
        right: acrossClips ? left + p.clientWidth * sx : Number.POSITIVE_INFINITY,
        bottom: downClips ? top + p.clientHeight * sy : Number.POSITIVE_INFINITY,
      })
    }
    if (style.position === 'fixed') break
  }
  const cut = cutOff(box, within)
  const visible =
    typeof el.checkVisibility === 'function'
      ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      : getComputedStyle(el).visibility !== 'hidden'
  const near = (n: number) => Math.round(n * 100) / 100
  return {
    x: near(box.left),
    y: near(box.top),
    width: near(box.right - box.left),
    height: near(box.bottom - box.top),
    cut: cut ? [near(cut[0]), near(cut[1]), near(cut[2]), near(cut[3])] : [0, 0, 0, 0],
    round: near(round),
    shown: cut !== null && visible,
  }
}

/**
 * The embeds of this document. `send` hands a message to the site, and is called only once the
 * site has said that it hosts embeds, which is once there is a channel to it.
 */
export function embeds(send: (message: PageToSite) => void, newId: () => string) {
  /** Whether the site hosts embeds: not known until it hands over its channel. */
  let hosting: boolean | undefined
  const byId = new Map<string, Hosted>()
  const byElement = new WeakMap<Element, Hosted>()
  /** The frames given an empty document of their own by this script, in place of what they named. */
  const blanked = new WeakSet<HTMLIFrameElement>()

  /** Keeps a frame from loading what it names, inside the page: what it shows then is an empty document of its own. */
  function blank(frame: HTMLIFrameElement): void {
    blanked.add(frame)
    if (frame.getAttribute('srcdoc') !== '') frame.setAttribute('srcdoc', '')
  }
  /** Lets a frame load what it names after all. */
  function release(frame: HTMLIFrameElement): void {
    if (!blanked.has(frame)) return
    blanked.delete(frame)
    frame.removeAttribute('srcdoc')
  }

  function handleOf(h: Hosted): EmbedHandle {
    return {
      provider: h.provider,
      url: h.url,
      onmessage: null,
      onload: null,
      post(message: unknown) {
        if (h.ended) throw new Error('This embed has been taken away.')
        const text = jsonText(message, EMBED.messageBytes)
        if (new TextEncoder().encode(text).length > EMBED.messageBytes) throw new Error(`A message to a player is at most ${EMBED.messageBytes / 1024} KB.`)
        const data = JSON.parse(text)
        if (hosting === true) send({ type: 'it:embed-post', id: h.id, data })
        else if (hosting === undefined && h.held.length < 100) h.held.push(data)
      },
      remove() {
        if (!h.ended) end(h)
      },
    }
  }

  function begin(el: Element, found: { provider: string; url: string }, asked: boolean): Hosted {
    const h: Hosted = {
      id: newId(),
      el,
      provider: found.provider,
      url: found.url,
      asked,
      ended: false,
      last: '',
      held: [],
      handle: null as unknown as EmbedHandle,
    }
    h.handle = handleOf(h)
    byId.set(h.id, h)
    byElement.set(el, h)
    if (hosting === true) {
      send({ type: 'it:embed', id: h.id, url: h.url })
      watch()
    }
    return h
  }

  function end(h: Hosted): void {
    h.ended = true
    byId.delete(h.id)
    if (byElement.get(h.el) === h) byElement.delete(h.el)
    if (hosting === true) send({ type: 'it:embed-end', id: h.id })
  }

  /**
   * Takes up a frame of the page's whose address is an embed on the list, and lets go of one whose
   * address no longer is. Such a frame never loads its player inside the page, where it would not
   * start: where the site does not host it, as a card's small picture of the page does not, or not
   * one more of them, its place is left empty.
   */
  function consider(node: Node): void {
    if (!(node instanceof HTMLIFrameElement)) return
    const now = byElement.get(node)
    if (now?.asked) return
    // A frame whose own document is written into it shows that, and loads nothing from its address
    if (node.hasAttribute('srcdoc') && !blanked.has(node)) return
    const named = node.getAttribute('src')
    let found: ReturnType<typeof embedFor> = null
    try {
      found = named ? embedFor(new URL(named, document.baseURI).href) : null
    } catch {}
    if (now && found && now.url === found.url) return
    if (now) end(now)
    if (!found) {
      release(node)
      return
    }
    blank(node)
    if (hosting !== false && byId.size < EMBED.most) begin(node, found, false)
  }
  function considerWithin(node: Node): void {
    consider(node)
    if (node instanceof Element || node instanceof Document) for (const frame of node.querySelectorAll('iframe')) consider(frame)
  }
  new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === 'attributes') consider(change.target)
      else for (const added of change.addedNodes) considerWithin(added)
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
  considerWithin(document)

  // Where each one is, looked at on every frame the browser draws while there are any, and sent
  // when it has changed. An element that has left the page takes its embed with it.
  let watching = false
  function watch(): void {
    if (watching || hosting !== true || byId.size === 0) return
    watching = true
    requestAnimationFrame(look)
  }
  function look(): void {
    watching = false
    for (const h of [...byId.values()]) {
      if (!h.el.isConnected) {
        end(h)
        continue
      }
      const at = placement(h.el)
      const said = JSON.stringify(at)
      if (said === h.last) continue
      h.last = said
      send({ type: 'it:embed-at', id: h.id, ...at })
    }
    watch()
  }
  // A document that is going takes its embeds with it, before the next one is shown
  addEventListener('pagehide', () => {
    for (const h of [...byId.values()]) end(h)
  })

  return {
    /**
     * The channel to the site was lost, and the site took every embed away with it. Each is kept
     * here, and asked for again, with where it is, once a new channel says the site hosts embeds.
     */
    lost(): void {
      if (hosting !== true) return
      hosting = undefined
      for (const h of byId.values()) h.last = ''
    },
    /** The site has handed over its channel, and said whether it hosts embeds. */
    hosted(yes: boolean): void {
      if (hosting !== undefined) return
      hosting = yes
      if (!yes) {
        // A site that does not, such as a card's small picture of the page: each place is left empty
        for (const h of byId.values()) h.ended = true
        byId.clear()
        return
      }
      for (const h of byId.values()) {
        send({ type: 'it:embed', id: h.id, url: h.url })
        for (const data of h.held.splice(0)) send({ type: 'it:embed-post', id: h.id, data })
      }
      watch()
    },
    /** A message from the site, where it is about an embed. Says whether it was. */
    received(message: SiteToPage): boolean {
      if (message.type !== 'it:embed-loaded' && message.type !== 'it:embed-message' && message.type !== 'it:embed-refused') return false
      const h = byId.get(message.id)
      if (!h) return true
      if (message.type === 'it:embed-loaded') {
        const fn = h.handle.onload
        if (typeof fn === 'function') told(() => fn.call(h.handle))
      } else if (message.type === 'it:embed-message') {
        const fn = h.handle.onmessage
        if (typeof fn === 'function') told(() => fn.call(h.handle, { data: message.data }))
      } else {
        // Refused, as when a page asks for too many too fast: its place is left empty, and the page's console says why
        end(h)
        console.warn(`[It] ${typeof message.error === 'string' ? message.error.slice(0, 200) : 'The embed was refused.'}`)
      }
      return true
    },
    /**
     * `It.embed(element, url)`: hosts the embed at that address over that element, and gives back
     * a way to talk to it. Given a frame of the page's own and no address, it is the embed that
     * frame names, which is already being hosted where the frame was taken up.
     */
    embed(element: Element, address?: string): EmbedHandle {
      if (!(element instanceof Element))
        throw new TypeError('It.embed(element, url): the first argument is an element of the page, which the player is put over.')
      const given = address ?? (element instanceof HTMLIFrameElement ? (element.getAttribute('src') ?? undefined) : undefined)
      let found: ReturnType<typeof embedFor> = null
      try {
        found = typeof given === 'string' ? embedFor(new URL(given, document.baseURI).href) : null
      } catch {}
      if (!found) throw new Error(`It.embed hosts players and maps from ${NAMES} only, at the address each gives for embedding.`)
      const now = byElement.get(element)
      if (now && now.url === found.url) {
        now.asked = true
        return now.handle
      }
      if (now) end(now)
      if (byId.size >= EMBED.most) throw new Error(`A page may host at most ${EMBED.most} players and maps at once.`)
      if (element instanceof HTMLIFrameElement) blank(element)
      return begin(element, found, true).handle
    },
  }
}
