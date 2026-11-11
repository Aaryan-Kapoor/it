// The tour's first page as its tests open it: as it is published, in a stand-in for a browser.
// What the page sends is kept until the test accepts or refuses it, the state is what the test
// sets as the agent would, the site's word of where an action has got to is the test's to give,
// and the clock is moved by the test. The shell's tests are in shell.test.ts, and each part's
// are beside the part, in parts/<name>.test.ts.
import { tourPage } from '../src/tour'

// The stand-in for a browser comes with no types of its own, so it is asked for by a name the type check does not follow
const { JSDOM } = (await import('jsdom' as string)) as any

/** The parts of the page, in the order it goes through them. */
export const STEPS = ['room', 'board', 'studio', 'chess', 'cube', 'drums', 'end']
/** How long an agent has to answer before a part is the person's again. */
export const SLOW = 40_000

/** Something the page sent, which the test accepts or refuses as It would. */
export interface Sent {
  /** The id It gives the action once it has taken it. */
  id: string
  name: string
  data: any
  accept: () => Promise<void>
  refuse: () => Promise<void>
}
export const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
/** What `it patch` does to the state: objects are merged into what is there, and anything else takes its place. */
const merged = (into: unknown, patch: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = isObject(into) ? { ...into } : {}
  for (const [k, v] of Object.entries(patch)) out[k] = isObject(v) && isObject(out[k]) ? merged(out[k], v) : v
  return out
}

/**
 * The page in a stand-in browser. `before` is done to the window first, for what a part needs of
 * a browser that the stand-in has not got. The sheet and the room are laid out at the size of
 * their drawings, so that a point on them is a point in the drawing.
 */
export async function opened(given: Record<string, unknown> = {}, before: (w: any) => void = () => {}) {
  const page = tourPage('start', given, 'Claude Code')
  const sent: Sent[] = []
  const listeners: (() => void)[] = []
  const hearers: ((said: unknown) => void)[] = []
  const errors: string[] = []
  const settled = () => new Promise<void>((done) => setImmediate(done))
  let now = 0
  let timers: { id: number; at: number; fn: () => void }[] = []
  let next = 0
  const It = {
    state: JSON.parse(page.state) as Record<string, unknown>,
    revision: 1,
    onState: (fn: () => void) => {
      listeners.push(fn)
      return () => {}
    },
    onProgress: (fn: (said: unknown) => void) => {
      hearers.push(fn)
      return () => {}
    },
    action: (name: string, data: unknown) =>
      new Promise((resolve, reject) => {
        const id = `action-${sent.length + 1}`
        sent.push({
          id,
          name,
          data,
          accept: () => {
            resolve({ ok: true, id })
            return settled()
          },
          refuse: () => {
            reject(new Error('refused'))
            return settled()
          },
        })
      }),
  }
  const dom = new JSDOM(page.html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w: any) {
      w.It = It
      // Nothing moves on the page, so nothing is asked of the stand-in that it cannot draw
      w.matchMedia = () => ({ matches: true })
      w.setTimeout = (fn: () => void, ms = 0) => {
        timers.push({ id: ++next, at: now + ms, fn })
        return next
      }
      w.clearTimeout = (id: number) => {
        timers = timers.filter((t) => t.id !== id)
      }
      w.setInterval = () => 0
      w.clearInterval = () => {}
      // The seconds the page counts are the test's
      w.Date.now = () => now
      w.Element.prototype.getBoundingClientRect = function (this: any) {
        return this.id === 'pen' ? { left: 0, top: 0, width: 720, height: 420 } : { left: 0, top: 0, width: 720, height: 520 }
      }
      w.Element.prototype.setPointerCapture = () => {}
      w.addEventListener('error', (e: any) => errors.push(String(e.message)))
      before(w)
    },
  })
  const w = dom.window
  if (w.document.readyState !== 'complete') await new Promise((done) => w.addEventListener('load', done))
  const $ = (selector: string) => w.document.querySelector(selector)
  const section = (step: string) => $(`[data-part="${step}"]`)
  const read = (step: string) =>
    w.Shell.read(step) as {
      stage: string
      state: string
      did: string
      said: string
      hint: string
      stages: Record<string, { cls: string; text: string; short?: string }>
    }
  return {
    w,
    sent,
    errors,
    $,
    section,
    /** The part of the page that is shown. */
    shown: () => STEPS.find((step) => !section(step).hidden),
    /** Goes on with Next until the part is shown. */
    to(step: string) {
      while (this.shown() !== step) $('#next').click()
    },
    /** What the dock says of a part, whether or not it is the one shown: its stage, its sentence, and how each of the five stages stands. */
    read,
    /** The dock's sentence for a part, with the seconds it counts. */
    state: (step: string) => read(step).state,
    /** What the agent said in a part. What the page says there of its own, before the agent has said anything, is not that. */
    said: (step: string) => read(step).said,
    you: (step: string) => read(step).did,
    /** The site says where the actions it has handed on have got to, as `It.onProgress` hears it. */
    async progress(actions: { id: string; handed: boolean; turn: 'running' | 'ended' | null }[]) {
      for (const fn of hearers) fn({ actions })
      await settled()
    },
    sentOf: (name: string) => sent.filter((s) => s.name === name),
    /** The agent sets something in the page's state, as `it patch` does. */
    async set(patch: Record<string, unknown>) {
      It.state = merged(It.state, patch)
      It.revision++
      for (const fn of listeners) fn()
      await settled()
    },
    /** Moves the clock on, running whatever comes due, and what that sets in turn. */
    async advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        timers = timers.filter((t) => t !== due)
        due.fn()
      }
      now = until
      await settled()
    },
    settled,
    close: () => w.close(),
  }
}
export type Page = Awaited<ReturnType<typeof opened>>
export const pointer = (page: Page, el: any, kind: string, x: number, y: number) =>
  el.dispatchEvent(new page.w.PointerEvent(kind, { clientX: x, clientY: y, pointerId: 1, bubbles: true }))
