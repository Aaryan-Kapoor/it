// Players and maps from the providers on It's list: the list itself, which the script in a page,
// the site and the site's content policy are all written from, and the layer the site hosts
// them in over a page, run in a stand-in browser. What it must get right: nothing that is not
// the embed of a provider on the list is ever framed, whatever is written to make it look like
// one; only what the site alone knows is put into an address; a frame lies where the page says
// and is cut as the page says; a frame that has just appeared or moved takes no click for a
// moment; and messages pass between a page and its player only to and from the player's origin.

import { cutOff, EMBED, EMBED_HOSTS, EMBEDS, embedAddress, embedFor, type PageToSite, type SiteToPage } from '@it/protocol'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { EMBED_ALLOW, EMBED_SANDBOX, EmbedLayer } from './embeds'

const SITE = { origin: 'https://studio.tail1234.ts.net', hostname: 'studio.tail1234.ts.net' }

describe('the list of providers', () => {
  test('takes the address each provider gives for embedding, in the one spelling it has', () => {
    const taken = {
      'https://www.youtube.com/embed/aqz-KE-bpKQ?start=30': 'YouTube',
      'https://www.youtube.com/embed/videoseries?list=PL123': 'YouTube',
      'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ': 'YouTube',
      'https://player.vimeo.com/video/76979871?h=8272103f6e': 'Vimeo',
      'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=generator': 'Spotify',
      'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M': 'Spotify',
      'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293&color=%23ff5500': 'SoundCloud',
      'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3022': 'Google Maps',
      'https://www.google.com/maps/embed/v1/place?key=k&q=Paris': 'Google Maps',
      'https://maps.google.com/maps?q=Eiffel+Tower&t=&z=13&ie=UTF8&iwloc=&output=embed': 'Google Maps',
      'https://www.google.com/maps?q=Kyoto&output=embed': 'Google Maps',
      'https://www.openstreetmap.org/export/embed.html?bbox=-0.1,51.5,-0.09,51.51&layer=mapnik': 'OpenStreetMap',
      'https://player.twitch.tv/?channel=twitchdev&muted=true': 'Twitch',
    }
    for (const [address, provider] of Object.entries(taken)) expect([address, embedFor(address)]).toEqual([address, { provider, url: address }])
    // On http it is the same address on https, a host is spelled in lower case, and the usual port is no port
    expect(embedFor('http://WWW.YouTube.com:443/embed/abc')?.url).toBe('https://www.youtube.com/embed/abc')
    expect(embedFor('https://www.youtube.com:443/embed/abc')?.url).toBe('https://www.youtube.com/embed/abc')
    expect(embedFor('  https://player.vimeo.com/video/1\n')?.url).toBe('https://player.vimeo.com/video/1')
  })

  test('takes nothing else, however it is written to look like an embed on the list', () => {
    const refused = [
      // Other hosts, and hosts that only look like one on the list
      'https://www.youtube.com.evil.example/embed/abc',
      'https://evil.example/www.youtube.com/embed/abc',
      'https://youtube.com/embed/abc',
      'https://m.youtube.com/embed/abc',
      'https://evil.www.youtube.com/embed/abc',
      'https://www.youtube.com./embed/abc',
      'https://www.yоutube.com/embed/abc',
      'https://vimeo.com/76979871',
      'https://spotify.com/embed/track/1',
      // A name or a password before the host, which a browser reads as another host
      'https://www.youtube.com@evil.example/embed/abc',
      'https://www.youtube.com:x@evil.example/embed/abc',
      'https://user@www.youtube.com/embed/abc',
      'https://evil.example\\@www.youtube.com/embed/abc',
      // Another port, or another kind of address
      'https://www.youtube.com:8443/embed/abc',
      'http://www.youtube.com:80/embed/abc:8080',
      'ftp://www.youtube.com/embed/abc',
      'javascript:alert(1)//https://www.youtube.com/embed/abc',
      'data:text/html,<iframe src=https://www.youtube.com/embed/abc>',
      'blob:https://www.youtube.com/0b1c',
      '//www.youtube.com/embed/abc',
      'www.youtube.com/embed/abc',
      // A host on the list at a path that is not its embeds, or that only becomes one when it is tidied
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      'https://www.youtube.com/embed/abc/../../redirect?q=https://evil.example',
      'https://www.youtube.com/embed/%2e%2e/redirect',
      'https://www.youtube.com/embed/%2F%2Fevil.example',
      'https://www.youtube.com/embed/abc/extra',
      'https://www.google.com/search?q=embed',
      'https://www.google.com/url?q=https://evil.example&output=embed',
      'https://www.google.com/maps/embed/../../url?q=https://evil.example',
      'https://maps.google.com/maps?q=Paris',
      'https://maps.google.com/maps?q=Paris&output=embedded',
      'https://www.google.com/maps/place/Paris?output=embed',
      'https://player.vimeo.com/video/abc',
      'https://player.twitch.tv/embed/evil',
      'https://www.openstreetmap.org/export/embed.htm',
      'https://w.soundcloud.com/player/../evil',
      // Not an address at all, or far too long to be one
      '',
      'embed',
      `https://www.youtube.com/embed/abc?x=${'a'.repeat(EMBED.addressLength)}`,
    ]
    for (const address of refused) expect([address, embedFor(address)]).toEqual([address, null])
    for (const nothing of [undefined, null, 4, {}, ['https://www.youtube.com/embed/abc'], { toString: () => 'https://www.youtube.com/embed/abc' }])
      expect(embedFor(nothing)).toBeNull()
  })

  test('the hosts the site may frame are exactly those of the list, each named once', () => {
    expect(EMBED_HOSTS).toEqual([
      'www.youtube.com',
      'www.youtube-nocookie.com',
      'player.vimeo.com',
      'open.spotify.com',
      'w.soundcloud.com',
      'www.google.com',
      'maps.google.com',
      'www.openstreetmap.org',
      'player.twitch.tv',
    ])
    expect(EMBEDS.map((p) => p.name)).toEqual(['YouTube', 'Vimeo', 'Spotify', 'SoundCloud', 'Google Maps', 'OpenStreetMap', 'Twitch'])
  })

  test('the site puts in what only it knows: its host name for Twitch, in place of any the page gave, and its origin for YouTube’s player API', () => {
    const framed = (address: string) => embedAddress(embedFor(address)!, SITE)
    expect(framed('https://player.twitch.tv/?channel=twitchdev')).toBe('https://player.twitch.tv/?channel=twitchdev&parent=studio.tail1234.ts.net')
    expect(framed('https://player.twitch.tv/?channel=twitchdev&parent=evil.example&parent=localhost&muted=true')).toBe(
      'https://player.twitch.tv/?channel=twitchdev&muted=true&parent=studio.tail1234.ts.net',
    )
    expect(framed('https://www.youtube.com/embed/abc?enablejsapi=1')).toBe(
      'https://www.youtube.com/embed/abc?enablejsapi=1&origin=https%3A%2F%2Fstudio.tail1234.ts.net',
    )
    expect(framed('https://www.youtube-nocookie.com/embed/abc?origin=https://evil.example&autoplay=1')).toBe(
      'https://www.youtube-nocookie.com/embed/abc?origin=https%3A%2F%2Fstudio.tail1234.ts.net&autoplay=1',
    )
    // A YouTube embed that does not use the player API, and every other provider's, is framed as the page gave it
    expect(framed('https://www.youtube.com/embed/abc?start=30')).toBe('https://www.youtube.com/embed/abc?start=30')
    expect(framed('https://player.vimeo.com/video/1?parent=x')).toBe('https://player.vimeo.com/video/1?parent=x')
  })

  test('what is cut off a box, at each side, by the window and by what holds it; and nothing where none of it is to be seen', () => {
    const window = { left: 0, top: 0, right: 800, bottom: 600 }
    const box = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height })
    expect(cutOff(box(10, 10, 100, 100), [window])).toEqual([0, 0, 0, 0])
    expect(cutOff(box(0, -102, 400, 300), [window])).toEqual([102, 0, 0, 0])
    expect(cutOff(box(10, 10, 100, 100), [window, box(0, 0, 800, 74)])).toEqual([0, 0, 36, 0])
    expect(cutOff(box(-50, 550, 900, 100), [window])).toEqual([0, 50, 50, 50])
    expect(cutOff(box(0, 600, 100, 100), [window])).toBeNull()
    expect(cutOff(box(0, -300, 100, 100), [window])).toBeNull()
    expect(cutOff(box(10, 10, 0, 100), [window])).toBeNull()
  })
})

describe('the layer the site hosts embeds in', () => {
  let layer: EmbedLayer | null = null
  afterEach(() => {
    layer?.dispose()
    layer = null
    document.body.replaceChildren()
    vi.useRealTimers()
  })
  /**
   * A layer over a page's frame, with what it said to the page written down. The site's frames are
   * drawn when the test says, and, unless it is told to hold them, at once after each message.
   */
  function host({ held = false } = {}) {
    const mount = document.body.appendChild(document.createElement('div'))
    const pageFrame = mount.appendChild(document.createElement('iframe'))
    const box = mount.appendChild(document.createElement('div'))
    const told: SiteToPage[] = []
    let frames: (() => void)[] = []
    layer = new EmbedLayer(
      box,
      () => pageFrame,
      (m) => told.push(m),
      SITE,
      { next: (fn) => frames.push(fn), cancel: () => {} },
    )
    /** Draws the site's next frame, if one was asked for. */
    const draw = () => {
      const now = frames
      frames = []
      for (const fn of now) fn()
    }
    const take = (m: unknown) => {
      const taken = layer!.take(m as PageToSite)
      if (!held) draw()
      return taken
    }
    const framed = () => [...box.querySelectorAll('iframe')]
    return { layer, box, told, take, framed, draw, pageFrame, waiting: () => frames.length }
  }
  const at = (id: string, over: Partial<Extract<PageToSite, { type: 'it:embed-at' }>> = {}) => ({
    type: 'it:embed-at',
    id,
    x: 40,
    y: 100,
    width: 560,
    height: 315,
    cut: [0, 0, 0, 0],
    round: 0,
    shown: true,
    ...over,
  })

  test('frames an embed on the list from the site itself: the site’s origin and no more as its referrer, a player’s permissions, its own origin, and not the site’s tab to move', () => {
    const { take, framed, box } = host()
    expect(take({ type: 'it:embed', id: 'e1', url: 'https://player.twitch.tv/?channel=twitchdev&parent=evil.example' })).toBe(true)
    const [frame] = framed()
    expect(frame).toBeDefined()
    expect(frame!.src).toBe('https://player.twitch.tv/?channel=twitchdev&parent=studio.tail1234.ts.net')
    expect(frame!.getAttribute('referrerpolicy')).toBe('strict-origin')
    expect(frame!.getAttribute('allow')).toBe('autoplay; encrypted-media; fullscreen; picture-in-picture')
    expect(EMBED_ALLOW).toBe('autoplay; encrypted-media; fullscreen; picture-in-picture')
    expect(frame!.hasAttribute('allowfullscreen')).toBe(true)
    expect(frame!.getAttribute('sandbox')).toBe(EMBED_SANDBOX)
    expect(EMBED_SANDBOX.split(' ')).toContain('allow-same-origin')
    expect(EMBED_SANDBOX).not.toMatch(/allow-top-navigation/)
    expect(frame!.title).toBe('Twitch')
    // Not seen until the page has said where it goes
    expect((box.firstElementChild as HTMLElement).style.visibility).toBe('hidden')
  })

  test('frames nothing that is not on the list, nor a second of one name, nor more than a page may have, and tells the page why', () => {
    const { take, framed, told } = host()
    take({ type: 'it:embed', id: 'bad', url: 'https://evil.example/embed/abc' })
    take({ type: 'it:embed', id: 'bad2', url: 'https://www.youtube.com@evil.example/embed/abc' })
    take({ type: 'it:embed', id: 'bad3', url: { href: 'https://www.youtube.com/embed/abc' } })
    expect(framed()).toEqual([])
    expect(told).toEqual([
      { type: 'it:embed-refused', id: 'bad', error: 'That address is not the embed of a provider It hosts.' },
      { type: 'it:embed-refused', id: 'bad2', error: 'That address is not the embed of a provider It hosts.' },
      { type: 'it:embed-refused', id: 'bad3', error: 'That address is not the embed of a provider It hosts.' },
    ])
    told.length = 0
    take({ type: 'it:embed', id: 'one', url: 'https://www.youtube.com/embed/a' })
    take({ type: 'it:embed', id: 'one', url: 'https://www.youtube.com/embed/b' })
    expect(told).toEqual([{ type: 'it:embed-refused', id: 'one', error: 'An embed of that name is already hosted.' }])
    for (let n = 1; n < EMBED.most; n++) take({ type: 'it:embed', id: `e${n}`, url: 'https://www.youtube.com/embed/a' })
    expect(framed().length).toBe(EMBED.most)
    take({ type: 'it:embed', id: 'past', url: 'https://www.youtube.com/embed/a' })
    expect(framed().length).toBe(EMBED.most)
    expect(told.at(-1)).toEqual({ type: 'it:embed-refused', id: 'past', error: `A page may host at most ${EMBED.most} players and maps at once.` })
    // A name that is no name is not answered at all, and what is not about embeds is not taken
    told.length = 0
    expect(take({ type: 'it:embed', id: 'x'.repeat(65), url: 'https://www.youtube.com/embed/a' })).toBe(true)
    expect(take({ type: 'it:embed', id: '<b>', url: 'https://www.youtube.com/embed/a' })).toBe(true)
    expect(told).toEqual([])
    expect(take({ type: 'it:action', requestId: 'r' })).toBe(false)
    expect(take(null)).toBe(false)
  })

  test('a page that makes embeds and takes them away in a loop is held to so many a second', () => {
    vi.useFakeTimers()
    const { take, told } = host()
    for (let n = 0; n < 2 * EMBED.most; n++) {
      take({ type: 'it:embed', id: `e${n}`, url: 'https://www.youtube.com/embed/a' })
      take({ type: 'it:embed-end', id: `e${n}` })
    }
    expect(told).toEqual([])
    take({ type: 'it:embed', id: 'more', url: 'https://www.youtube.com/embed/a' })
    expect(told).toEqual([{ type: 'it:embed-refused', id: 'more', error: 'This page is asking for players and maps too fast. Try again in a moment.' }])
    vi.advanceTimersByTime(500)
    take({ type: 'it:embed', id: 'later', url: 'https://www.youtube.com/embed/a' })
    expect(told.length).toBe(1)
  })

  test('lays a frame where the page says, cut as the page says and rounded as its place is, and hides it while the page says it is not to be seen', () => {
    const { take, box } = host()
    take({ type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    take(at('e1', { cut: [102, 0, 0, 0], round: 12 }))
    const placed = box.firstElementChild as HTMLElement
    expect(placed.style.transform).toBe('translate(40px, 100px)')
    expect([placed.style.width, placed.style.height]).toEqual(['560px', '315px'])
    expect(placed.style.clipPath).toBe('inset(102px 0px 0px 0px)')
    expect(placed.style.visibility).toBe('')
    expect((placed.querySelector('iframe') as HTMLElement).style.borderRadius).toBe('12px')
    take(at('e1', { shown: false }))
    expect(placed.style.visibility).toBe('hidden')
    // What is no place on the screen hides it too
    take(at('e1'))
    expect(placed.style.visibility).toBe('')
    for (const odd of [
      { x: Number.NaN },
      { width: 0 },
      { height: -5 },
      { y: 1e12 },
      { cut: [0, 0, 0] },
      { cut: [-1, 0, 0, 0] },
      { cut: 'none' },
      { shown: 'yes' },
    ]) {
      take(at('e1'))
      take(at('e1', odd as never))
      expect([odd, placed.style.visibility]).toEqual([odd, 'hidden'])
    }
    // A rounding larger than the frame is held to half of it
    take(at('e1', { round: 9999 }))
    expect((placed.querySelector('iframe') as HTMLElement).style.borderRadius).toBe('157.5px')
  })

  test('a frame that has just appeared or moved lies under a shield that takes any click, until it has been still for a moment', () => {
    vi.useFakeTimers()
    const { take, box } = host()
    take({ type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    const shield = box.querySelector('.embed-shield') as HTMLElement
    expect(shield.hidden).toBe(true)
    take(at('e1'))
    expect(shield.hidden).toBe(false)
    vi.advanceTimersByTime(EMBED.shieldMs - 1)
    expect(shield.hidden).toBe(false)
    vi.advanceTimersByTime(1)
    expect(shield.hidden).toBe(true)
    // Laid again where it is already, it stays as it is
    take(at('e1'))
    expect(shield.hidden).toBe(true)
    // Moved, the shield is back, and stays while it goes on moving
    take(at('e1', { y: 80 }))
    expect(shield.hidden).toBe(false)
    vi.advanceTimersByTime(400)
    take(at('e1', { y: 60 }))
    vi.advanceTimersByTime(400)
    expect(shield.hidden).toBe(false)
    vi.advanceTimersByTime(200)
    expect(shield.hidden).toBe(true)
    // Shown again after being hidden, it has just appeared
    take(at('e1', { y: 60, shown: false }))
    take(at('e1', { y: 60 }))
    expect(shield.hidden).toBe(false)
  })

  test('a player uncovered by a change of its cut alone lies under the shield, as one that moved does', () => {
    vi.useFakeTimers()
    const { take, box } = host()
    take({ type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    const shield = box.querySelector('.embed-shield') as HTMLElement
    // Cut to a pixel's width of the 560 it is, and left still until the shield is down
    take(at('e1', { cut: [0, 559, 0, 0] }))
    vi.advanceTimersByTime(EMBED.shieldMs)
    expect(shield.hidden).toBe(true)
    // Then all of it uncovered at once, with nothing else changed, just before a click
    take(at('e1', { cut: [0, 0, 0, 0] }))
    expect((box.firstElementChild as HTMLElement).style.clipPath).toBe('inset(0px 0px 0px 0px)')
    expect(shield.hidden).toBe(false)
    // And its corners rounded otherwise, which shows the player's own corners
    vi.advanceTimersByTime(EMBED.shieldMs)
    take(at('e1', { round: 20 }))
    expect(shield.hidden).toBe(false)
  })

  test('while the site is not yet sure which document the frame shows, every shield stays up, those of players laid meanwhile too, and goes down a moment after it is let go', () => {
    vi.useFakeTimers()
    const { take, box, layer } = host()
    take({ type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    take(at('e1'))
    vi.advanceTimersByTime(EMBED.shieldMs)
    const shields = () => [...box.querySelectorAll<HTMLElement>('.embed-shield')].map((s) => s.hidden)
    expect(shields()).toEqual([true])
    layer.hold()
    expect(shields()).toEqual([false])
    take({ type: 'it:embed', id: 'e2', url: 'https://www.youtube.com/embed/b' })
    take(at('e2', { y: 500 }))
    vi.advanceTimersByTime(10 * EMBED.shieldMs)
    expect(shields()).toEqual([false, false])
    layer.release()
    vi.advanceTimersByTime(EMBED.shieldMs - 1)
    expect(shields()).toEqual([false, false])
    vi.advanceTimersByTime(1)
    expect(shields()).toEqual([true, true])
  })

  test('a player walked a quarter of a pixel at a time stays under the shield all the way, and is still for a moment before a click reaches it', () => {
    vi.useFakeTimers()
    const { take, box } = host()
    take({ type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    const shield = box.querySelector('.embed-shield') as HTMLElement
    take(at('e1', { x: 0 }))
    vi.advanceTimersByTime(EMBED.shieldMs)
    expect(shield.hidden).toBe(true)
    let uncovered = 0
    for (let step = 1; step <= 2000; step++) {
      take(at('e1', { x: step / 4 }))
      vi.advanceTimersByTime(16)
      if (shield.hidden) uncovered++
    }
    expect((box.firstElementChild as HTMLElement).style.transform).toBe('translate(500px, 100px)')
    expect(uncovered).toBe(0)
    vi.advanceTimersByTime(EMBED.shieldMs)
    expect(shield.hidden).toBe(true)
  })

  test('where a page says many times where a player is before the site draws again, the frame is laid once, where it last said, with one look at the page’s frame', () => {
    const { take, box, draw, pageFrame, waiting } = host({ held: true })
    take({ type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    const looked = vi.spyOn(pageFrame, 'getBoundingClientRect')
    for (let n = 1; n <= 1000; n++) take(at('e1', { y: n }))
    expect(looked).not.toHaveBeenCalled()
    expect(waiting()).toBe(1)
    draw()
    expect(looked).toHaveBeenCalledTimes(1)
    expect((box.firstElementChild as HTMLElement).style.transform).toBe('translate(40px, 1000px)')
    // Hidden after being laid, before the next frame, it is hidden then
    take(at('e1', { y: 5 }))
    take(at('e1', { shown: false }))
    draw()
    expect((box.firstElementChild as HTMLElement).style.visibility).toBe('hidden')
  })

  test('a page that says where its players are far oftener than they can be drawn is not heard past so many a second', () => {
    vi.useFakeTimers()
    const { take, box, draw } = host({ held: true })
    take({ type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    const most = EMBED.most * 120
    for (let n = 1; n <= most + 50; n++) take(at('e1', { y: n }))
    draw()
    expect((box.firstElementChild as HTMLElement).style.transform).toBe(`translate(40px, ${most}px)`)
    // A moment later it is heard again
    vi.advanceTimersByTime(100)
    take(at('e1', { y: 7 }))
    draw()
    expect((box.firstElementChild as HTMLElement).style.transform).toBe('translate(40px, 7px)')
  })

  test('a message from the page goes to its player once the player’s frame has loaded, at the player’s own origin, and what is not plain data goes nowhere', () => {
    const { take, framed, told } = host()
    take({ type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a?enablejsapi=1' })
    const frame = framed()[0]!
    const posted: [unknown, string][] = []
    ;(frame.contentWindow as Window).postMessage = ((data: unknown, to: string) => void posted.push([data, to])) as never
    take({ type: 'it:embed-post', id: 'e1', data: '{"event":"listening"}' })
    expect(posted).toEqual([])
    frame.dispatchEvent(new Event('load'))
    expect(posted).toEqual([['{"event":"listening"}', 'https://www.youtube.com']])
    expect(told).toEqual([{ type: 'it:embed-loaded', id: 'e1' }])
    take({ type: 'it:embed-post', id: 'e1', data: { event: 'command', func: 'pauseVideo', args: [] } })
    expect(posted.at(-1)).toEqual([{ event: 'command', func: 'pauseVideo', args: [] }, 'https://www.youtube.com'])
    const before = posted.length
    take({ type: 'it:embed-post', id: 'e1', data: { when: new Date() } })
    take({ type: 'it:embed-post', id: 'e1', data: 'x'.repeat(EMBED.messageBytes + 1) })
    take({ type: 'it:embed-post', id: 'nobody', data: 'hello' })
    expect(posted.length).toBe(before)
  })

  test('a page that posts to its players without end is held to so many a second', () => {
    const { take, framed } = host()
    take({ type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    const frame = framed()[0]!
    let posted = 0
    ;(frame.contentWindow as Window).postMessage = (() => void posted++) as never
    frame.dispatchEvent(new Event('load'))
    for (let n = 0; n < 500; n++) take({ type: 'it:embed-post', id: 'e1', data: n })
    expect(posted).toBeGreaterThanOrEqual(100)
    expect(posted).toBeLessThan(120)
  })

  test('a message from a player reaches the page only where it came from that player’s frame at that player’s own origin', () => {
    const { take, framed, told } = host()
    take({ type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    take({ type: 'it:embed', id: 'e2', url: 'https://player.vimeo.com/video/1' })
    const [youtube, vimeo] = framed()
    const from = (source: Window | null, origin: string, data: unknown) => window.dispatchEvent(new MessageEvent('message', { source, origin, data }))
    from(youtube!.contentWindow, 'https://www.youtube.com', '{"event":"onReady"}')
    from(vimeo!.contentWindow, 'https://player.vimeo.com', { event: 'ready' })
    // From the right frame at another origin, as after it went elsewhere; from another frame; and from the site itself
    from(youtube!.contentWindow, 'https://evil.example', 'not this')
    from(vimeo!.contentWindow, 'https://www.youtube.com', 'nor this')
    from(window, 'https://www.youtube.com', 'nor this')
    // And what is not plain data
    from(youtube!.contentWindow, 'https://www.youtube.com', new ArrayBuffer(8))
    expect(told).toEqual([
      { type: 'it:embed-message', id: 'e1', data: '{"event":"onReady"}' },
      { type: 'it:embed-message', id: 'e2', data: { event: 'ready' } },
    ])
  })

  test('an embed goes when the page says so, and every one goes when the page’s document or showing ends', () => {
    const { take, framed, layer, told } = host()
    take({ type: 'it:embed', id: 'e1', url: 'https://www.youtube.com/embed/a' })
    take({ type: 'it:embed', id: 'e2', url: 'https://www.youtube.com/embed/b' })
    take({ type: 'it:embed', id: 'e3', url: 'https://www.youtube.com/embed/c' })
    take({ type: 'it:embed-end', id: 'e2' })
    expect(framed().map((f) => f.src)).toEqual(['https://www.youtube.com/embed/a', 'https://www.youtube.com/embed/c'])
    layer.clear()
    expect(framed()).toEqual([])
    expect(layer.size).toBe(0)
    // A frame that loads after it went says nothing to the page
    take({ type: 'it:embed', id: 'e4', url: 'https://www.youtube.com/embed/d' })
    const late = framed()[0]!
    layer.dispose()
    late.dispatchEvent(new Event('load'))
    expect(told.filter((m) => m.type === 'it:embed-loaded')).toEqual([])
  })
})
