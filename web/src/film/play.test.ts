// What plays the film on the first screen, with a stand-in for the film's drawing and for the
// canvas it draws on. What it must get right here: asked to stand still, as it is for someone
// who has asked their system for less motion, it shows a thing whole and moves nothing.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

/** What was drawn, as the time of the film each drawing was of. */
const drawn: { key: string; t: number }[] = []
const card = (key: string, a: number) => ({
  key,
  noun: `a ${key}`,
  by: 'Claude',
  field: '#f4f1ea',
  dark: false,
  rate: 1,
  a,
  end: a + 4,
  out: a + 5,
  cx: 0,
  cy: 0,
  vw: 800,
  vh: 600,
  you: [a + 1, `used the ${key}`] as [number, string],
  did: [a + 2, `answered on the ${key}`] as [number, string],
  draw: (_ctx: unknown, t: number) => void drawn.push({ key, t }),
})
vi.mock('./film.js', () => ({
  film: { cards: [card('whiteboard', 0), card('map', 10)], paper: '#f4f1ea', ready: async () => {}, scaled: (ctx: unknown) => ctx },
}))

/** What the player says as it goes, in the order it says it. */
let said: string[]
const told = {
  headline: (text: string) => void said.push(`headline ${JSON.stringify(text)}`),
  thing: (index: number) => void said.push(`thing ${index}`),
  you: (text: string | null) => void (text !== null && said.push(`you ${text}`)),
  did: (text: string | null) => void (text !== null && said.push(`did ${text}`)),
}
let panel: HTMLElement
let stage: HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  said = []
  drawn.length = 0
  // A canvas that takes every drawing and keeps none of it, and a panel with a size
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    new Proxy(
      {},
      {
        get: (kept: Record<string | symbol, unknown>, name) => (name in kept ? kept[name] : () => {}),
        set: (kept, name, value) => Reflect.set(kept, name, value),
      },
    ) as never,
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  panel = document.body.appendChild(document.createElement('div'))
  stage = panel.appendChild(document.createElement('div'))
  for (const [of, size] of [
    [panel, 600],
    [stage, 400],
  ] as const) {
    Object.defineProperty(of, 'clientWidth', { configurable: true, value: size })
    Object.defineProperty(of, 'clientHeight', { configurable: true, value: size })
  }
})
afterEach(() => {
  panel.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('asked to stand still, it shows the first thing whole at once, with its headline written out and what was done on it, and nothing moves as time passes', async () => {
  const { play } = await import('./play')
  const playing = await play(panel, stage, told, true)
  await vi.advanceTimersByTimeAsync(50)
  expect(said).toEqual(['thing 0', 'headline "It can be\\na whiteboard"', 'you used the whiteboard', 'did answered on the whiteboard'])
  // Drawn as it is when its exchange is over, and at no other moment of it
  expect([...new Set(drawn.map((d) => `${d.key} at ${d.t}`))]).toEqual(['whiteboard at 4'])
  const [words, drawings] = [said.length, drawn.length]
  await vi.advanceTimersByTimeAsync(30_000)
  expect([said.length, drawn.length]).toEqual([words, drawings])
  // Another thing, chosen by its button, is shown whole in the same way
  said = []
  playing.show(1)
  await vi.advanceTimersByTimeAsync(50)
  expect(said).toEqual(['thing 1', 'headline "It can be\\na map"', 'you used the map', 'did answered on the map'])
  expect(drawn.at(-1)).toEqual({ key: 'map', t: 14 })
  playing.stop()
})

test('told to play again, it plays what is up from its beginning, and told to stand still while it plays, it shows that thing whole', async () => {
  const { play } = await import('./play')
  const playing = await play(panel, stage, told, true)
  await vi.advanceTimersByTimeAsync(50)
  said = []
  drawn.length = 0
  playing.still(false)
  await vi.advanceTimersByTimeAsync(1500)
  // Its headline is already written, and the thing is drawn from where it begins, a frame at a time
  expect(said[0]).toBe('thing 0')
  expect(drawn[0]!.t).toBeLessThan(0.2)
  expect(drawn.length).toBeGreaterThan(10)
  expect(drawn.at(-1)!.t).toBeLessThan(4)
  playing.still(true)
  await vi.advanceTimersByTimeAsync(50)
  expect(drawn.at(-1)).toEqual({ key: 'whiteboard', t: 4 })
  const drawings = drawn.length
  await vi.advanceTimersByTimeAsync(10_000)
  expect(drawn.length).toBe(drawings)
  playing.stop()
})
