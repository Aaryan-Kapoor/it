// Players and maps from the providers on It's list, which the site frames over a page.
//
// A page is a sandboxed document with no origin, and so is every frame inside it: there a player
// has no storage and sends no `Referer`, and YouTube's, Vimeo's, SoundCloud's and Twitch's never
// start. So the page keeps an element in its own layout as the place for one, and the site frames
// the player itself, from its own origin, in a layer over the page's frame. The script in the page
// says where that element is on each frame it moves, and how much of it what holds it and the
// window cut off. The site lays the player there, cut the same way, hides it while the element
// is hidden or out of sight, and takes it away with the element, or when the page's document or
// its showing ends.
//
// Nothing the page says is believed beyond that. The address is held to the list here as well,
// and only what the site alone knows is put into it. A frame that has just appeared or moved
// lies under a shield for a moment, which takes any click, so that a page cannot slide a player
// under a click that was about to land on the page. Messages pass between the page and the
// player only to and from the player's own origin.
import { EMBED, type Embed, embedAddress, embedFor, jsonText, type PageToSite, type SiteToPage } from '@it/protocol'

/** What a hosted frame may do: everything a player needs, its own origin and storage among it, and not take the site's own tab elsewhere. */
export const EMBED_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation'
/** What a hosted frame is let use of what the site may. */
export const EMBED_ALLOW = 'autoplay; encrypted-media; fullscreen; picture-in-picture'
/** How many messages a page may send its players: so many at once, and then so many a second. */
const POSTS_BURST = 100
const POSTS_PER_SECOND = 50
/** How many of them wait for a player's frame to load. */
const POSTS_HELD = 100
/**
 * How many embeds a page may have framed: so many at once, and then so many a second. A page that
 * makes them and takes them away in a loop would otherwise have the site load frame after frame.
 */
const BEGUN_BURST = 2 * EMBED.most
const BEGUN_PER_SECOND = 2
/**
 * How many times a page may say where its players are: so many at once, and then so many a
 * second, which is twice what the script in a page sends at most, once for each player on each
 * frame the browser draws. Past that what it says is not taken. What is taken is only noted, and
 * laid out once on the site's next frame, however much of it there was.
 */
const PLACED_BURST = EMBED.most * 120
const PLACED_PER_SECOND = EMBED.most * 120

interface Frame {
  id: string
  embed: Embed
  origin: string
  box: HTMLDivElement
  frame: HTMLIFrameElement
  shield: HTMLDivElement
  loaded: boolean
  held: unknown[]
  /** Where it was last laid, in the layer's own pixels, with its cut and its corners, while it was to be seen. */
  at: Laid | null
  /** Where the page last said it is, in the page's own pixels, to be laid on the site's next frame. */
  wanted?: Laid
  /** That the page last said it is hidden, which is done on the site's next frame. */
  hide?: boolean
  lowering?: ReturnType<typeof setTimeout>
}

/** Where a frame lies, how it is cut, and how round its corners are. */
interface Laid {
  x: number
  y: number
  width: number
  height: number
  cut: [number, number, number, number]
  round: number
}

/** Whether something is a number that a place on the screen can be. */
const sane = (n: unknown, low = -1_000_000, high = 1_000_000): n is number => typeof n === 'number' && Number.isFinite(n) && n >= low && n <= high

/**
 * The embeds of one document of a page, in a layer over its frame. `toPage` speaks to that
 * document, and `pageFrame` is the frame it is in, which is what the page's pixels are counted
 * from. `site` is where the site itself is, which only it knows: Twitch is told its host name,
 * and YouTube's player API its origin.
 */
export class EmbedLayer {
  private readonly frames = new Map<string, Frame>()
  private tokens = POSTS_BURST
  private filled = Date.now()
  private begun = BEGUN_BURST
  private begunFilled = Date.now()
  private placed = PLACED_BURST
  private placedFilled = Date.now()
  /** The site's next frame, asked for once there is something to lay. */
  private drawing: number | null = null
  /** Whether every shield stays up until it is let go, while the site is not yet sure which document the frame shows. */
  private holding = false
  private readonly layer: HTMLElement
  private readonly pageFrame: () => HTMLIFrameElement | null
  private readonly toPage: (message: SiteToPage) => void
  private readonly site: { origin: string; hostname: string }
  private readonly nextFrame: (fn: () => void) => number
  private readonly cancelFrame: (handle: number) => void
  private readonly fromPlayers = (e: MessageEvent) => this.heard(e)

  constructor(
    layer: HTMLElement,
    pageFrame: () => HTMLIFrameElement | null,
    toPage: (message: SiteToPage) => void,
    site: { origin: string; hostname: string } = { origin: location.origin, hostname: location.hostname },
    frames: { next: (fn: () => void) => number; cancel: (handle: number) => void } = {
      next: (fn) => requestAnimationFrame(fn),
      cancel: (handle) => cancelAnimationFrame(handle),
    },
  ) {
    this.layer = layer
    this.pageFrame = pageFrame
    this.toPage = toPage
    this.site = site
    this.nextFrame = frames.next
    this.cancelFrame = frames.cancel
    window.addEventListener('message', this.fromPlayers)
  }

  /** How many embeds are hosted now. */
  get size(): number {
    return this.frames.size
  }

  /** A message from the page. Says whether it was about an embed, and so taken here. */
  take(message: PageToSite): boolean {
    const said = message as { type?: unknown; id?: unknown; url?: unknown; data?: unknown } | null
    const type = said?.type
    if (!said || (type !== 'it:embed' && type !== 'it:embed-at' && type !== 'it:embed-post' && type !== 'it:embed-end')) return false
    const id = typeof said.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(said.id) ? said.id : null
    if (!id) return true
    if (type === 'it:embed') this.begin(id, said.url)
    else if (type === 'it:embed-at') this.lay(id, said as Extract<PageToSite, { type: 'it:embed-at' }>)
    else if (type === 'it:embed-post') this.post(id, said.data)
    else this.end(id)
    return true
  }

  /** Keeps the shield over every player, those laid from now on too, until `release`: no click reaches one meanwhile. */
  hold(): void {
    this.holding = true
    for (const hosted of this.frames.values()) {
      hosted.shield.hidden = false
      clearTimeout(hosted.lowering)
    }
  }

  /** Lets the shields go down again, each once its player has been still for a moment. */
  release(): void {
    if (!this.holding) return
    this.holding = false
    for (const hosted of this.frames.values()) if (!hosted.shield.hidden) this.shield(hosted)
  }

  /** Takes every embed away: the page's document or its showing has ended. */
  clear(): void {
    for (const id of [...this.frames.keys()]) this.end(id)
  }

  /** Takes every embed away, and listens to no player again. */
  dispose(): void {
    this.clear()
    if (this.drawing !== null) this.cancelFrame(this.drawing)
    this.drawing = null
    window.removeEventListener('message', this.fromPlayers)
  }

  private refuse(id: string, error: string): void {
    this.toPage({ type: 'it:embed-refused', id, error })
  }

  private begin(id: string, url: unknown): void {
    const embed = embedFor(url)
    const refused = !embed
      ? 'That address is not the embed of a provider It hosts.'
      : this.frames.has(id)
        ? 'An embed of that name is already hosted.'
        : this.frames.size >= EMBED.most
          ? `A page may host at most ${EMBED.most} players and maps at once.`
          : !this.mayBegin()
            ? 'This page is asking for players and maps too fast. Try again in a moment.'
            : null
    if (!embed || refused) {
      this.refuse(id, refused ?? '')
      return
    }
    const address = embedAddress(embed, this.site)
    const box = document.createElement('div')
    box.className = 'embed'
    // Not seen until the page has said where it goes
    box.style.visibility = 'hidden'
    const frame = document.createElement('iframe')
    frame.title = embed.provider
    // The site's origin and no more: YouTube plays only for an embedder that names itself, and the address of the page is never sent
    frame.setAttribute('referrerpolicy', 'strict-origin')
    frame.setAttribute('allow', EMBED_ALLOW)
    frame.setAttribute('allowfullscreen', '')
    frame.setAttribute('sandbox', EMBED_SANDBOX)
    frame.src = address
    const shield = document.createElement('div')
    shield.className = 'embed-shield'
    shield.hidden = true
    box.append(frame, shield)
    const hosted: Frame = { id, embed, origin: new URL(address).origin, box, frame, shield, loaded: false, held: [], at: null }
    frame.addEventListener('load', () => {
      if (this.frames.get(id) !== hosted) return
      hosted.loaded = true
      for (const data of hosted.held.splice(0)) frame.contentWindow?.postMessage(data, hosted.origin)
      this.toPage({ type: 'it:embed-loaded', id })
    })
    this.frames.set(id, hosted)
    this.layer.append(box)
  }

  /** Whether the page may have one more embed framed now. */
  private mayBegin(): boolean {
    const now = Date.now()
    this.begun = Math.min(BEGUN_BURST, this.begun + (Math.max(0, now - this.begunFilled) / 1000) * BEGUN_PER_SECOND)
    this.begunFilled = now
    if (this.begun < 1) return false
    this.begun -= 1
    return true
  }

  /**
   * Notes where the page says an embed's element is, cut as the page says, or that it is hidden,
   * to be laid on the site's next frame. Only the last of what it says before then is laid.
   */
  private lay(id: string, at: Extract<PageToSite, { type: 'it:embed-at' }>): void {
    const hosted = this.frames.get(id)
    if (!hosted || !this.mayPlace()) return
    const cut = Array.isArray(at.cut) && at.cut.length === 4 && at.cut.every((n) => sane(n, 0)) ? at.cut : null
    const shown = at.shown === true && sane(at.x) && sane(at.y) && sane(at.width, 1) && sane(at.height, 1) && cut !== null
    if (shown) {
      hosted.wanted = { x: at.x, y: at.y, width: at.width, height: at.height, cut: [cut[0], cut[1], cut[2], cut[3]], round: sane(at.round, 0) ? at.round : 0 }
      hosted.hide = false
    } else {
      hosted.wanted = undefined
      hosted.hide = true
    }
    if (this.drawing === null) this.drawing = this.nextFrame(() => this.draw())
  }

  /** Whether the page may say where a player is now. */
  private mayPlace(): boolean {
    const now = Date.now()
    this.placed = Math.min(PLACED_BURST, this.placed + (Math.max(0, now - this.placedFilled) / 1000) * PLACED_PER_SECOND)
    this.placedFilled = now
    if (this.placed < 1) return false
    this.placed -= 1
    return true
  }

  /**
   * Lays every embed the page said something of since the last frame, with one look at where the
   * page's frame is. Any change at all to where a frame lies, how it is cut or how round it is
   * puts the shield over it, since each of those can bring another part of the player under the
   * pointer, however little each one moves it.
   */
  private draw(): void {
    this.drawing = null
    let offset: { dx: number; dy: number } | null = null
    for (const hosted of this.frames.values()) {
      if (hosted.hide) {
        hosted.hide = false
        hosted.box.style.visibility = 'hidden'
        hosted.at = null
        continue
      }
      const wanted = hosted.wanted
      if (!wanted) continue
      hosted.wanted = undefined
      // The page's pixels are counted from the inside of its frame, and the layer's from its own corner
      if (!offset) {
        const page = this.pageFrame()
        offset = { dx: 0, dy: 0 }
        if (page) {
          const f = page.getBoundingClientRect()
          const l = this.layer.getBoundingClientRect()
          offset = { dx: f.left - l.left + page.clientLeft, dy: f.top - l.top + page.clientTop }
        }
      }
      const place: Laid = {
        ...wanted,
        x: wanted.x + offset.dx,
        y: wanted.y + offset.dy,
        round: Math.min(wanted.round, wanted.width / 2, wanted.height / 2),
      }
      const was = hosted.at
      const still =
        was !== null &&
        was.x === place.x &&
        was.y === place.y &&
        was.width === place.width &&
        was.height === place.height &&
        was.round === place.round &&
        was.cut.every((n, i) => n === place.cut[i])
      if (!still) this.shield(hosted)
      hosted.at = place
      const style = hosted.box.style
      style.transform = `translate(${place.x}px, ${place.y}px)`
      style.width = `${place.width}px`
      style.height = `${place.height}px`
      style.clipPath = `inset(${place.cut[0]}px ${place.cut[1]}px ${place.cut[2]}px ${place.cut[3]}px)`
      hosted.frame.style.borderRadius = place.round > 0 ? `${place.round}px` : ''
      style.visibility = ''
    }
  }

  /** Puts the shield over a frame that has just appeared, moved or been cut otherwise, until it has been still for a moment. */
  private shield(hosted: Frame): void {
    hosted.shield.hidden = false
    clearTimeout(hosted.lowering)
    if (this.holding) return
    hosted.lowering = setTimeout(() => {
      hosted.shield.hidden = true
    }, EMBED.shieldMs)
  }

  /** Passes a message from the page on to its player, at the player's own origin, once its frame has loaded. */
  private post(id: string, data: unknown): void {
    const hosted = this.frames.get(id)
    if (!hosted) return
    const now = Date.now()
    this.tokens = Math.min(POSTS_BURST, this.tokens + (Math.max(0, now - this.filled) / 1000) * POSTS_PER_SECOND)
    this.filled = now
    if (this.tokens < 1) return
    this.tokens -= 1
    let text: string
    try {
      text = jsonText(data, EMBED.messageBytes)
    } catch {
      return
    }
    if (text.length > EMBED.messageBytes) return
    const copy = JSON.parse(text) as unknown
    if (hosted.loaded) hosted.frame.contentWindow?.postMessage(copy, hosted.origin)
    else if (hosted.held.length < POSTS_HELD) hosted.held.push(copy)
  }

  /** A message from a player, which goes on to the page only where it came from that player's frame at that player's own origin. */
  private heard(e: MessageEvent): void {
    if (!e.source) return
    for (const hosted of this.frames.values()) {
      if (e.source !== hosted.frame.contentWindow) continue
      if (e.origin !== hosted.origin) return
      let text: string
      try {
        text = jsonText(e.data, EMBED.messageBytes)
      } catch {
        return
      }
      if (text.length > EMBED.messageBytes) return
      this.toPage({ type: 'it:embed-message', id: hosted.id, data: JSON.parse(text) })
      return
    }
  }

  private end(id: string): void {
    const hosted = this.frames.get(id)
    if (!hosted) return
    this.frames.delete(id)
    clearTimeout(hosted.lowering)
    hosted.box.remove()
  }
}
