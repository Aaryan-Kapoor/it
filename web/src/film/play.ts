// Plays the things It can be, one after another, on a canvas: each opens out of a full stop,
// the person does something on it, the agent answers, and it closes again. The drawing is the
// launch film's own (film.js), and this is what puts a stretch of it on the screen and says, as
// it goes, what is being shown. Nothing here is React's: the site's first screen gives it the
// elements to draw in and is told what to write beside them.
import type { FilmCard } from './film'

export interface Told {
  /** The headline as it stands, a letter more or a letter less than a moment ago. Two lines, the second after a line break. */
  headline(text: string): void
  /** A thing has come up, or none is up (`-1`). */
  thing(index: number): void
  /** What the person did on it, and what the agent did in answer. Null takes the line away. */
  you(text: string | null): void
  did(text: string | null, by: string): void
}
export interface Playing {
  /** The things, in the order they are played. */
  cards: FilmCard[]
  /** Goes to one of them now. */
  show(index: number): void
  /** Holds what is up for as long as it is pointed at. */
  hold(on: boolean): void
  stop(): void
}

type Scaled = CanvasRenderingContext2D & { _k: number }
const easeOut = (t: number) => 1 - (1 - t) ** 3
/** As many pixels as a canvas is given at most: the film's soft shadows cost by the pixel, and past this nobody sees the difference. */
const BUDGET = 2.2e6

/**
 * Starts playing in `panel`, which takes each thing's colour, with the card set in the middle
 * of `stage`, an element inside it. Resolves once the film's fonts are in and the first thing
 * is on its way. Rejects where the film cannot be drawn at all.
 */
export async function play(panel: HTMLElement, stage: HTMLElement, told: Told): Promise<Playing> {
  const { film } = await import('./film.js')
  await film.ready()
  const cards = film.cards
  const canvas = document.createElement('canvas')
  canvas.className = 'hello-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  const plain = canvas.getContext('2d')
  if (!plain) throw new Error('no canvas')
  const g = film.scaled(plain) as Scaled
  panel.prepend(canvas)

  let stopped = false
  let token = 0
  let holding = false
  const live = (tok: number) => !stopped && tok === token
  const running = () => !document.hidden

  // ---------- the canvas ----------
  const size = { w: 0, h: 0, dpr: 1 }
  /** What is on it: a thing, at a time of the film. */
  let cur: { card: FilmCard; t: number; said: number } | null = null
  /** The colour behind, which changes as a circle that grows out of the card. */
  const field = { was: film.paper, now: film.paper, t0: -1e9, ms: 1 }
  const setField = (color: string, dark: boolean, ms = 560) => {
    Object.assign(field, { was: field.now, now: color, t0: performance.now(), ms })
    panel.style.backgroundColor = color
    panel.classList.toggle('dark', dark)
  }
  const draw = () => {
    if (!size.w) return
    const p = Math.min(1, (performance.now() - field.t0) / field.ms)
    const bx = stage.offsetLeft + stage.clientWidth / 2
    const by = stage.offsetTop + stage.clientHeight / 2
    const v = cur?.card
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalAlpha = 1
    g.fillStyle = p < 1 ? field.was : field.now
    g.fillRect(0, 0, canvas.width, canvas.height)
    // The margin at the sides is only room for the fingertip to come in, and can run under the panel's edge
    const s = v ? Math.min(1, stage.clientWidth / (v.vw - 70), stage.clientHeight / v.vh) : 1
    const k = size.dpr * s
    g.setTransform(k, 0, 0, k, size.dpr * bx - k * (v ? v.cx : 0), size.dpr * by - k * (v ? v.cy : 0))
    g._k = k
    if (p < 1) {
      g.beginPath()
      g.arc(v ? v.cx : 0, v ? v.cy : 0, (easeOut(p) * Math.hypot(size.w, size.h)) / s, 0, Math.PI * 2)
      g.fillStyle = field.now
      g.fill()
    }
    if (v && cur) v.draw(g, cur.t)
  }
  const fit = () => {
    const w = panel.clientWidth
    const h = panel.clientHeight
    if (!w || !h) return
    const dpr = Math.min(2, window.devicePixelRatio || 1, Math.max(1, Math.sqrt(BUDGET / (w * h))))
    if (w === size.w && h === size.h && dpr === size.dpr) return
    Object.assign(size, { w, h, dpr })
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    draw()
  }
  const watching = new ResizeObserver(fit)
  watching.observe(panel)
  fit()

  // ---------- time, which passes only while the tab is looked at ----------
  const sleep = (ms: number, tok: number) =>
    new Promise<boolean>((done) => {
      let left = ms
      let last = performance.now()
      const tick = (now: number) => {
        if (!live(tok)) return done(false)
        if (running()) left -= Math.min(80, now - last)
        last = now
        if (left <= 0) done(true)
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  /** Calls `fn(t)` each frame as t goes from a to b, `rate` seconds of film to a second of the clock. */
  const roll = (a: number, b: number, rate: number, fn: (t: number) => void, tok: number) =>
    new Promise<boolean>((done) => {
      let t = a
      let last = performance.now()
      const step = (now: number) => {
        if (!live(tok)) return done(false)
        const dt = Math.min(80, now - last)
        last = now
        if (running()) {
          t = Math.min(b, t + (dt / 1000) * rate)
          fn(t)
        }
        if (t >= b) done(true)
        else requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })

  // ---------- the headline, typed ----------
  let text = ''
  const typeTo = async (target: string, tok: number) => {
    let i = 0
    while (i < text.length && i < target.length && text[i] === target[i]) i++
    while (text.length > i) {
      text = text.slice(0, -1)
      told.headline(text)
      if (!(await sleep(16, tok))) return false
    }
    while (text.length < target.length) {
      text = target.slice(0, text.length + 1)
      told.headline(text)
      if (!(await sleep(target[text.length - 1] === '\n' ? 60 : 46, tok))) return false
    }
    return live(tok)
  }

  // ---------- a thing: it opens, plays, waits to be looked at, and closes ----------
  const showThing = async (i: number, tok: number) => {
    const card = cards[i]!
    told.thing(i)
    told.you(null)
    told.did(null, card.by)
    if (!(await typeTo(`It can be\n${card.noun}`, tok))) return false
    cur = { card, t: card.a, said: 0 }
    setField(card.field, card.dark)
    const frame = (t: number) => {
      if (!cur) return
      cur.t = t
      if (cur.said < 1 && t >= card.you[0]) {
        cur.said = 1
        told.you(card.you[1])
      }
      if (cur.said < 2 && t >= card.did[0]) {
        cur.said = 2
        told.did(card.did[1], card.by)
      }
      draw()
    }
    if (!(await roll(card.a, card.end, card.rate, frame, tok))) return false
    if (!(await sleep(2400, tok))) return false
    while (holding) if (!(await sleep(400, tok))) return false
    return roll(card.end, card.out, 1, frame, tok)
  }
  const run = async (tok: number, from: number, intro: boolean) => {
    if (intro)
      for (const [said, held] of [
        ['It', 600],
        ['It can', 460],
        ['It can be', 380],
      ] as const) {
        if (!(await typeTo(said, tok))) return
        if (!(await sleep(held, tok))) return
      }
    for (let i = from; live(tok); i = (i + 1) % cards.length) if (!(await showThing(i, tok))) return
  }
  void run(++token, 0, true)

  return {
    cards,
    show: (index) => void run(++token, index, false),
    hold: (on) => {
      holding = on
    },
    stop: () => {
      stopped = true
      watching.disconnect()
      canvas.remove()
    },
  }
}
