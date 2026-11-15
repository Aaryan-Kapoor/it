// The person following the tour's first page, `tour-start`, through its seven parts, doing the
// real thing in each with the mouse, and waiting each time for the agent's answer on the page.
import { sleep, step } from './lib.mjs'

const ANSWER_WAIT = 150_000

/** The frame that holds the tour's first page, once it is there. */
export async function tourFrame(page, ms = 60_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    for (const f of page.frames()) {
      try {
        if (await f.$('section.part[data-part="room"]')) return f
      } catch {}
    }
    await sleep(1000)
  }
  return null
}

async function dock(frame) {
  return frame.evaluate(() => ({
    stage: document.getElementById('dock')?.getAttribute('data-stage') ?? null,
    state: document.getElementById('dock-state')?.textContent ?? '',
    secs: document.getElementById('dock-secs')?.textContent ?? '',
    line: document.getElementById('dock-line')?.textContent ?? '',
    part: [...document.querySelectorAll('section.part')].find((s) => !s.hidden)?.getAttribute('data-part') ?? null,
  }))
}

/**
 * Waits for the agent's answer to what was just done in the part shown: the dock says
 * "answered", or the page gives the part back ("slow") or It refused it.
 */
async function answered(frame, what, ms = ANSWER_WAIT) {
  const start = Date.now()
  let last = null
  // The dock first has to leave what it said before
  await sleep(800)
  while (Date.now() - start < ms) {
    try {
      last = await dock(frame)
    } catch {
      await sleep(1000)
      continue
    }
    if (last.stage === 'answered') {
      // Let the agent's words finish being written out
      await sleep(2500)
      const now = await dock(frame).catch(() => last)
      return step(`answered: ${what}`, { waited: Math.round((Date.now() - start) / 1000), dock: now })
    }
    if (last.stage === 'refused') return step(`refused: ${what}`, { dock: last }, false)
    if (last.stage === 'slow' && Date.now() - start > 45_000) {
      // The page gave the part back after forty seconds. A late answer is still drawn: wait on
    }
    await sleep(1000)
  }
  return step(`no answer: ${what}`, { waited: Math.round(ms / 1000), dock: last }, false)
}

async function box(frame, selector) {
  const el = await frame.waitForSelector(selector, { state: 'visible', timeout: 20_000 })
  await el.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
  return { el, b: await el.boundingBox() }
}

async function drag(page, from, to, steps = 25) {
  await page.mouse.move(from.x, from.y)
  await sleep(300)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    await sleep(25)
  }
  await sleep(250)
  await page.mouse.up()
}

async function stroke(page, points) {
  await page.mouse.move(points[0].x, points[0].y)
  await page.mouse.down()
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]]
    for (let k = 1; k <= 8; k++) {
      await page.mouse.move(a.x + ((b.x - a.x) * k) / 8, a.y + ((b.y - a.y) * k) / 8)
      await sleep(12)
    }
  }
  await page.mouse.up()
  await sleep(250)
}

async function shownPart(frame) {
  return (await dock(frame)).part
}

async function next(frame, from) {
  await sleep(2500)
  await frame.click('#next')
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    const p = await shownPart(frame).catch(() => null)
    if (p && p !== from) return p
    await sleep(400)
  }
  return shownPart(frame)
}

const PARTS = {
  async room(page, frame) {
    const chair = await box(frame, '#room-chair')
    const sofa = await box(frame, '#room-sofa')
    const c = { x: chair.b.x + chair.b.width / 2, y: chair.b.y + chair.b.height / 2 }
    const s = { x: sofa.b.x + sofa.b.width / 2, y: sofa.b.y + sofa.b.height / 2 }
    step('drags the armchair onto the sofa')
    await drag(page, c, s, 35)
    return [await answered(frame, 'room, the armchair')]
  },
  async board(page, frame) {
    const pen = await box(frame, '#board-pen')
    const { x, y, width: w, height: h } = pen.b
    // "144", written by hand in the lower middle of the board
    const P = (fx, fy) => ({ x: x + w * fx, y: y + h * fy })
    const H = 0.22
    const top = 0.5
    step('writes 144 on the whiteboard with the pen')
    await stroke(page, [P(0.38, top), P(0.38, top + H)])
    await stroke(page, [P(0.48, top), P(0.44, top + H * 0.62), P(0.52, top + H * 0.62)])
    await stroke(page, [P(0.5, top + H * 0.35), P(0.5, top + H)])
    await stroke(page, [P(0.6, top), P(0.56, top + H * 0.62), P(0.64, top + H * 0.62)])
    await stroke(page, [P(0.62, top + H * 0.35), P(0.62, top + H)])
    await sleep(1200)
    step('presses Check it')
    await frame.click('#board-check')
    return [await answered(frame, 'whiteboard, 144 checked')]
  },
  async studio(page, frame) {
    const wheel = await box(frame, '#studio-wheel')
    const { x, y, width: w, height: h } = wheel.b
    const cx = x + w / 2
    const cy = y + h / 2
    const r = Math.min(w, h) * 0.38
    step('drags on the colour wheel to a deep blue')
    const pts = [0, 20, 40, 60, 80, 100].map((deg) => ({ x: cx + r * Math.cos(((200 + deg) * Math.PI) / 180), y: cy + r * Math.sin(((200 + deg) * Math.PI) / 180) }))
    await stroke(page, pts)
    const out = [await answered(frame, 'studio, the colour')]
    await sleep(2500)
    step('taps the headline of the poster')
    await frame.click('.studio-piece[data-piece="headline"]')
    await sleep(1500)
    const words = await frame.$$('#studio-ask button')
    let chosen = null
    for (const b of words) {
      const t = ((await b.textContent()) ?? '').trim()
      if (t && !chosen) chosen = { b, t }
      if (/word|say|text|dull|boring|long/i.test(t)) {
        chosen = { b, t }
        break
      }
    }
    if (!chosen) return [...out, step('no word to choose for the headline', {}, false)]
    step(`chooses "${chosen.t}" for the headline`)
    await chosen.b.click()
    out.push(await answered(frame, `studio, the headline: ${chosen.t}`))
    return out
  },
  async chess(page, frame) {
    const out = []
    for (const [from, to] of [
      ['e2', 'e4'],
      ['g1', 'f3'],
    ]) {
      step(`plays ${from} to ${to}`)
      await frame.click(`button[data-sq="${from}"]`)
      await sleep(700)
      await frame.click(`button[data-sq="${to}"]`)
      out.push(await answered(frame, `chess, ${from}${to}`))
      await sleep(2500)
    }
    return out
  },
  async cube(page, frame) {
    step('asks how to solve the cube')
    await frame.click('#cube-ask')
    const out = [await answered(frame, 'cube, how to solve it')]
    const auto = await frame.$('#cube-auto:not([hidden])')
    if (auto) {
      await sleep(2000)
      step('presses Do it for me')
      await auto.click().catch(() => {})
      await sleep(6000)
    }
    return out
  },
  async drums(page, frame) {
    step('taps four pads')
    for (const [r, c] of [
      [3, 0],
      [3, 4],
      [2, 2],
      [2, 6],
    ]) {
      const pad = (await frame.$(`button.pad[data-r="${r}"][data-c="${c}"]`)) ?? (await frame.$$('button.pad'))[r * 8 + c]
      if (pad) await pad.click()
      await sleep(500)
    }
    const out = [await answered(frame, 'drums, between my hits')]
    await sleep(3000)
    const wild = await frame.$('button.drums-ask[data-ask="wild"]')
    if (wild) {
      step('asks for "Surprise me"')
      await wild.click()
      out.push(await answered(frame, 'drums, surprise me'))
    }
    await sleep(2000)
    const play = await frame.$('#drums-play[data-on="1"]')
    if (play) await play.click().catch(() => {})
    return out
  },
  async end(page, frame) {
    const out = []
    // The agent's three ideas, set after its first answer or asked for now by the page
    const made = await frame
      .waitForSelector('.end-card .end-make', { state: 'visible', timeout: ANSWER_WAIT })
      .then(() => true)
      .catch(() => false)
    const names = await frame.$$eval('.end-card .end-name', (els) => els.map((e) => e.textContent?.trim()).filter(Boolean)).catch(() => [])
    out.push(step(made ? 'sees the three ideas' : 'no ideas came', { ideas: names }, made))
    if (!made) return out
    await sleep(5000)
    step(`presses Make this on "${names[0] ?? 'the first idea'}"`)
    await frame.click('.end-card .end-make')
    // The agent builds that page and opens it in the tour's place
    const start = Date.now()
    while (Date.now() - start < 300_000) {
      const stillTour = await frame.$('section.part[data-part="end"]').then(Boolean).catch(() => false)
      if (!stillTour) {
        out.push(step('the tour gave way to the page the agent built', { waited: Math.round((Date.now() - start) / 1000) }))
        return out
      }
      await sleep(2000)
    }
    out.push(step('the page that was asked for did not come', { waited: 300 }, false))
    return out
  },
}

/** Follows the tour from whichever part is shown to its end. Resolves with each part's steps. */
export async function followTour(page, frame) {
  const parts = {}
  let part = await shownPart(frame)
  const order = ['room', 'board', 'studio', 'chess', 'cube', 'drums', 'end']
  for (let guard = 0; guard < 9 && part; guard++) {
    step(`comes to the part: ${part}`)
    try {
      parts[part] = await PARTS[part](page, frame)
    } catch (err) {
      parts[part] = [step(`could not do the part ${part}`, { error: String(err?.message ?? err).slice(0, 300) }, false)]
    }
    if (part === 'end') break
    const was = part
    part = await next(frame, was).catch(() => null)
    if (part === was) {
      step(`Next did not leave ${was}`, {}, false)
      part = order[order.indexOf(was) + 1]
    }
  }
  return parts
}
