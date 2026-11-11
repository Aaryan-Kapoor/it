// Making the site fullscreen, in a stand-in browser. The stand-in has no fullscreen of its own,
// so each test gives it the names a real browser has: the standard ones, or only the older ones
// an older Safari has. What it must get right: the site asks by whichever name the browser has,
// hears the answer by whichever way the browser gives it, and is never told it is fullscreen
// when it is not.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type Loose = Record<string, unknown>
const doc = document as unknown as Loose
const root = document.documentElement as unknown as Loose
/** What the browser has fullscreen now, and what it was asked, in order. */
const browser = { element: null as Element | null, asked: [] as string[] }
const said = (kind: string) => document.dispatchEvent(new Event(kind))

/**
 * What each test's own copy of the module listens to on the document. Each test imports the
 * module afresh, and a copy from an earlier test that still listened would act on what this test
 * makes fullscreen as well, with what it knew then: so each copy stops listening with its test.
 */
const listening: [string, EventListenerOrEventListenerObject][] = []
const listen = document.addEventListener.bind(document)
beforeEach(() => {
  vi.resetModules()
  Object.assign(browser, { element: null, asked: [] })
  document.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    listening.push([type, fn])
    listen(type, fn, options)
  }) as typeof document.addEventListener
})
afterEach(() => {
  browser.element = null
  said('fullscreenchange')
  said('webkitfullscreenchange')
  for (const name of ['fullscreenEnabled', 'webkitFullscreenEnabled', 'fullscreenElement', 'webkitFullscreenElement', 'exitFullscreen', 'webkitExitFullscreen'])
    delete doc[name]
  for (const name of ['requestFullscreen', 'webkitRequestFullscreen']) delete root[name]
  for (const [type, fn] of listening.splice(0)) document.removeEventListener(type, fn)
  delete (document as unknown as Loose).addEventListener
})

/** A browser with only the older names, as an older Safari has. `answer` is how it answers a request, by an event or not at all. */
function olderSafari(answer: 'webkitfullscreenchange' | 'webkitfullscreenerror' | null) {
  Object.defineProperty(document, 'webkitFullscreenEnabled', { configurable: true, value: true })
  Object.defineProperty(document, 'webkitFullscreenElement', { configurable: true, get: () => browser.element })
  root.webkitRequestFullscreen = () => {
    browser.asked.push('webkitRequestFullscreen')
    if (answer === 'webkitfullscreenchange') browser.element = document.documentElement
    if (answer) queueMicrotask(() => said(answer))
  }
  doc.webkitExitFullscreen = () => {
    browser.asked.push('webkitExitFullscreen')
    browser.element = null
    queueMicrotask(() => said('webkitfullscreenchange'))
  }
}

describe('the site’s fullscreen', () => {
  test('is offered only where the browser has fullscreen and a way to ask for it', async () => {
    const { fullscreenAvailable } = await import('./fullscreen')
    expect(fullscreenAvailable()).toBe(false)
    // An iPhone says that it has none, though it knows the names
    Object.defineProperty(document, 'webkitFullscreenEnabled', { configurable: true, value: false })
    root.webkitRequestFullscreen = () => {}
    expect(fullscreenAvailable()).toBe(false)
    Object.defineProperty(document, 'webkitFullscreenEnabled', { configurable: true, value: true })
    expect(fullscreenAvailable()).toBe(true)
    delete root.webkitRequestFullscreen
    expect(fullscreenAvailable()).toBe(false)
  })

  test('in an older Safari it is asked for by the older name, and is entered once the browser says so', async () => {
    olderSafari('webkitfullscreenchange')
    const { enterFullscreen, fullscreenOn, leaveFullscreen } = await import('./fullscreen')
    await enterFullscreen()
    expect(browser.asked).toEqual(['webkitRequestFullscreen'])
    expect(fullscreenOn()).toBe(true)
    await leaveFullscreen()
    await new Promise((r) => setTimeout(r, 0))
    expect(browser.asked).toEqual(['webkitRequestFullscreen', 'webkitExitFullscreen'])
    expect(fullscreenOn()).toBe(false)
  })

  test('in an older Safari a refusal is said as one, and so is saying nothing at all', async () => {
    olderSafari('webkitfullscreenerror')
    const { enterFullscreen, fullscreenOn, NOT_FULLSCREEN } = await import('./fullscreen')
    await expect(enterFullscreen()).rejects.toThrow(NOT_FULLSCREEN)
    expect(fullscreenOn()).toBe(false)
    delete root.webkitRequestFullscreen
    olderSafari(null)
    vi.useFakeTimers()
    try {
      const asked = enterFullscreen()
      vi.advanceTimersByTime(3000)
      await expect(asked).rejects.toThrow(NOT_FULLSCREEN)
    } finally {
      vi.useRealTimers()
    }
  })

  test('leaving where It is not fullscreen asks the browser nothing, and does not fail', async () => {
    olderSafari('webkitfullscreenchange')
    const { leaveFullscreen } = await import('./fullscreen')
    await expect(leaveFullscreen()).resolves.toBeUndefined()
    expect(browser.asked).toEqual([])
  })

  test('leaving goes on through a film made fullscreen above It, and is done only once nothing is fullscreen', async () => {
    // The browser's fullscreen as a stack, of which leaving takes off the top alone
    const stack: Element[] = []
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => stack.at(-1) ?? null })
    root.requestFullscreen = async () => {
      stack.push(document.documentElement)
      said('fullscreenchange')
    }
    doc.exitFullscreen = async () => {
      browser.asked.push('exitFullscreen')
      stack.pop()
      said('fullscreenchange')
    }
    const { enterFullscreen, fullscreenOn, leaveFullscreen } = await import('./fullscreen')
    await enterFullscreen()
    // The page's frame makes a film fullscreen above It, and It is fullscreen beneath it still
    stack.push(document.createElement('iframe'))
    said('fullscreenchange')
    expect(fullscreenOn()).toBe(true)
    await leaveFullscreen()
    expect(browser.asked).toEqual(['exitFullscreen', 'exitFullscreen'])
    expect(stack).toEqual([])
    expect(fullscreenOn()).toBe(false)
  })

  test('where the browser leaves nothing however often it is asked, leaving fails and says so', async () => {
    const film = document.createElement('iframe')
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => browser.element })
    root.requestFullscreen = async () => {
      browser.element = document.documentElement
      said('fullscreenchange')
    }
    doc.exitFullscreen = async () => void browser.asked.push('exitFullscreen')
    const { enterFullscreen, leaveFullscreen, STILL_FULLSCREEN } = await import('./fullscreen')
    await enterFullscreen()
    // A film above It, which this browser never lets go of
    browser.element = film
    said('fullscreenchange')
    // It tried to leave the film as soon as it was made fullscreen, as it does anything but the site: counted from here
    browser.asked.length = 0
    await expect(leaveFullscreen()).rejects.toThrow(STILL_FULLSCREEN)
    expect(browser.asked).toHaveLength(4)
  })

  test('where the browser refuses to leave the site’s own fullscreen, leaving fails and says so, rather than saying It left', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => browser.element })
    root.requestFullscreen = async () => {
      browser.element = document.documentElement
      said('fullscreenchange')
    }
    let refuses = true
    doc.exitFullscreen = async () => {
      browser.asked.push('exitFullscreen')
      if (!refuses) browser.element = null
      throw new TypeError('Not allowed')
    }
    const { enterFullscreen, fullscreenOn, leaveFullscreen, STILL_FULLSCREEN } = await import('./fullscreen')
    await enterFullscreen()
    await expect(leaveFullscreen()).rejects.toThrow(STILL_FULLSCREEN)
    expect(browser.asked).toHaveLength(4)
    expect(fullscreenOn()).toBe(true)
    // A refusal that comes once the site has left all the same is a leaving
    refuses = false
    browser.asked.length = 0
    await expect(leaveFullscreen()).resolves.toBeUndefined()
    expect(browser.asked).toEqual(['exitFullscreen'])
  })

  test('an older Safari that refuses to leave, by an error or by saying nothing, has leaving fail and say so, rather than say It left', async () => {
    olderSafari('webkitfullscreenchange')
    // This one leaves nothing: it says so by an error the first time, and then says nothing at all
    let answer: 'webkitfullscreenerror' | null = 'webkitfullscreenerror'
    doc.webkitExitFullscreen = () => {
      browser.asked.push('webkitExitFullscreen')
      const next = answer
      answer = null
      if (next) queueMicrotask(() => said(next))
    }
    const { enterFullscreen, fullscreenOn, leaveFullscreen, STILL_FULLSCREEN } = await import('./fullscreen')
    await enterFullscreen()
    vi.useFakeTimers()
    try {
      const outcome = leaveFullscreen().then(
        () => 'left',
        (err: Error) => err.message,
      )
      await vi.advanceTimersByTimeAsync(5000)
      expect(await outcome).toBe(STILL_FULLSCREEN)
    } finally {
      vi.useRealTimers()
    }
    expect(browser.asked.filter((a) => a === 'webkitExitFullscreen')).toHaveLength(4)
    expect(fullscreenOn()).toBe(true)
  })

  test('what is made fullscreen after It’s own was left is not left as well', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => browser.element })
    root.requestFullscreen = async () => {
      browser.asked.push('requestFullscreen')
      browser.element = document.documentElement
      said('fullscreenchange')
    }
    doc.exitFullscreen = async () => {
      browser.asked.push('exitFullscreen')
      browser.element = null
      said('fullscreenchange')
    }
    const { enterFullscreen, fullscreenOn, leaveFullscreen } = await import('./fullscreen')
    await enterFullscreen()
    // Asked to leave, and then at once to go fullscreen again, before the leaving was answered
    const left = leaveFullscreen()
    const entered = enterFullscreen()
    await Promise.all([left, entered])
    expect(browser.asked).toEqual(['requestFullscreen', 'exitFullscreen', 'requestFullscreen'])
    expect(fullscreenOn()).toBe(true)
  })

  test('a page’s frame that the browser makes fullscreen by itself is left at once, whether It was fullscreen or not, so it never covers the bar', async () => {
    const stack: Element[] = []
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => stack.at(-1) ?? null })
    root.requestFullscreen = async () => {
      stack.push(document.documentElement)
      said('fullscreenchange')
    }
    doc.exitFullscreen = async () => {
      browser.asked.push('exitFullscreen')
      stack.pop()
      said('fullscreenchange')
    }
    const { enterFullscreen, fullscreenOn } = await import('./fullscreen')
    const frame = document.createElement('iframe')
    stack.push(frame)
    said('fullscreenchange')
    expect(browser.asked).toEqual(['exitFullscreen'])
    expect(stack).toEqual([])
    await enterFullscreen()
    stack.push(frame)
    said('fullscreenchange')
    expect(browser.asked).toEqual(['exitFullscreen', 'exitFullscreen'])
    expect(stack).toEqual([document.documentElement])
    expect(fullscreenOn()).toBe(true)
  })

  /** A browser whose fullscreen is a stack, as a real one's is: leaving takes off the top alone. */
  function stacked(refuses = false) {
    const stack: Element[] = []
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => stack.at(-1) ?? null })
    root.requestFullscreen = async () => {
      browser.asked.push('requestFullscreen')
      if (refuses) throw new TypeError('Permissions check failed')
      stack.push(document.documentElement)
      said('fullscreenchange')
    }
    doc.exitFullscreen = async () => {
      browser.asked.push('exitFullscreen')
      stack.pop()
      said('fullscreenchange')
    }
    return stack
  }
  /** Who hosts players, with what it was told written down. */
  function players(player: Element) {
    const told: string[] = []
    return {
      told,
      host: {
        owns: (frame: Element) => frame === player,
        fill: (frame: Element) => void told.push(frame === player ? 'fill' : 'fill another'),
        unfill: () => void told.push('unfill'),
      },
    }
  }
  const settle = () => new Promise((r) => setTimeout(r, 0))

  test('a player that the browser makes fullscreen by its own button is given It’s fullscreen instead: its own is left, the site’s is asked for, and the player is laid over the page under the bar', async () => {
    const stack = stacked()
    const { fullscreenOn, hostPlayers } = await import('./fullscreen')
    const player = document.createElement('iframe')
    const { told, host } = players(player)
    hostPlayers(host)
    stack.push(player)
    said('fullscreenchange')
    await settle()
    expect(browser.asked).toEqual(['exitFullscreen', 'requestFullscreen'])
    expect(stack).toEqual([document.documentElement])
    expect(fullscreenOn()).toBe(true)
    expect(told).toEqual(['fill'])
  })

  test('where It is fullscreen already, a player that goes fullscreen by its own button is laid over the page under the bar, and It stays fullscreen', async () => {
    const stack = stacked()
    const { enterFullscreen, fullscreenOn, hostPlayers } = await import('./fullscreen')
    const player = document.createElement('iframe')
    const { told, host } = players(player)
    hostPlayers(host)
    await enterFullscreen()
    stack.push(player)
    said('fullscreenchange')
    await settle()
    expect(browser.asked).toEqual(['requestFullscreen', 'exitFullscreen'])
    expect(stack).toEqual([document.documentElement])
    expect(fullscreenOn()).toBe(true)
    expect(told).toEqual(['fill'])
  })

  test('a player laid over the page goes back where the page keeps it once It leaves fullscreen, however It left', async () => {
    const stack = stacked()
    const { fullscreenOn, hostPlayers, leaveFullscreen } = await import('./fullscreen')
    const player = document.createElement('iframe')
    const { told, host } = players(player)
    hostPlayers(host)
    stack.push(player)
    said('fullscreenchange')
    await settle()
    await leaveFullscreen()
    expect(fullscreenOn()).toBe(false)
    expect(told).toEqual(['fill', 'unfill'])
    // And by Escape, which the browser does by itself
    stack.push(player)
    said('fullscreenchange')
    await settle()
    stack.pop()
    said('fullscreenchange')
    expect(told).toEqual(['fill', 'unfill', 'fill', 'unfill'])
  })

  test('where the browser will not make the site fullscreen in a player’s place, the player is left where the page keeps it, and nothing covers the bar', async () => {
    const stack = stacked(true)
    const { fullscreenOn, hostPlayers } = await import('./fullscreen')
    const player = document.createElement('iframe')
    const { told, host } = players(player)
    hostPlayers(host)
    stack.push(player)
    said('fullscreenchange')
    await settle()
    expect(browser.asked).toEqual(['exitFullscreen', 'requestFullscreen'])
    expect(stack).toEqual([])
    expect(fullscreenOn()).toBe(false)
    expect(told).toEqual([])
  })

  test('a frame that no host of players owns, the page’s own among them, is only left, and nothing is laid over the page', async () => {
    const stack = stacked()
    const { fullscreenOn, hostPlayers } = await import('./fullscreen')
    const player = document.createElement('iframe')
    const { told, host } = players(player)
    const stop = hostPlayers(host)
    stack.push(document.createElement('iframe'))
    said('fullscreenchange')
    await settle()
    expect(browser.asked).toEqual(['exitFullscreen'])
    expect(stack).toEqual([])
    // Nor is a player whose host has stopped hosting it, as when the page's document went
    stop()
    stack.push(player)
    said('fullscreenchange')
    await settle()
    expect(browser.asked).toEqual(['exitFullscreen', 'exitFullscreen'])
    expect(stack).toEqual([])
    expect(fullscreenOn()).toBe(false)
    expect(told).toEqual([])
  })

  test('a browser that refuses by the standard name is said to have refused in the site’s own words', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
    root.requestFullscreen = () => Promise.reject(new TypeError('Permissions check failed'))
    const { enterFullscreen, NOT_FULLSCREEN } = await import('./fullscreen')
    await expect(enterFullscreen()).rejects.toThrow(NOT_FULLSCREEN)
  })
})
