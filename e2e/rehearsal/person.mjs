// The person on the tour's first page: what a new person does in each of its seven parts, with
// the real pointer in the real browser, and a short pause after each thing so that a viewer can
// follow. After each thing that asks the agent, the person waits for the agent's answer on the
// page, as the agent's dock shows it: You, It, Your agent, Working, Answer.
import { sleep } from './lib.mjs'

export const PAUSE = 1500

/** The tour's own frame inside It's page. */
export async function tourFrame(page, ms = 120_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    for (const fr of page.frames()) {
      try {
        if (await fr.evaluate(() => typeof window.Shell === 'object' && !!document.querySelector('section.part[data-part="room"]'))) return fr
      } catch {}
    }
    await sleep(500)
  }
  return null
}

/** Starts writing down every stage the dock goes through, with the time, in the page. */
async function watchDock(fr) {
  await fr.evaluate(() => {
    if (window.__dock) return
    window.__dock = []
    const dock = document.querySelector('.dock')
    const note = () => window.__dock.push({ t: Date.now(), stage: dock.dataset.stage })
    note()
    new MutationObserver(note).observe(dock, { attributes: true, attributeFilter: ['data-stage'] })
  })
}

/**
 * Waits for the agent's answer to what the person did just now: the dock at "answered" after
 * `since`. Resolves with the stages seen, the seconds from the person's action to the answer,
 * and what the dock says.
 */
export async function waitAnswer(fr, since, ms = 240_000) {
  const end = Date.now() + ms
  let stages = []
  while (Date.now() < end) {
    try {
      stages = await fr.evaluate((s) => window.__dock.filter((d) => d.t >= s), since)
    } catch {}
    const answered = stages.find((d) => d.stage === 'answered')
    if (answered) {
      await sleep(400)
      return { ok: true, seconds: (answered.t - since) / 1000, stages: stages.map((d) => `${d.stage}@${((d.t - since) / 1000).toFixed(1)}`), said: await dockSays(fr) }
    }
    await sleep(500)
  }
  return { ok: false, seconds: null, stages: stages.map((d) => `${d.stage}@${((d.t - since) / 1000).toFixed(1)}`), said: await dockSays(fr) }
}

export async function dockSays(fr) {
  try {
    return await fr.evaluate(() => document.querySelector('.dock')?.innerText.replace(/\s+/g, ' ').trim().slice(0, 400))
  } catch {
    return ''
  }
}

async function center(locator) {
  const b = await locator.boundingBox()
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, b } : null
}

async function drag(page, from, to, steps = 30) {
  await page.mouse.move(from.x, from.y, { steps: 8 })
  await page.mouse.down()
  await sleep(150)
  await page.mouse.move(to.x, to.y, { steps })
  await sleep(200)
  await page.mouse.up()
}

async function next(fr) {
  await fr.getByRole('button', { name: /^Next/ }).first().click()
  await sleep(PAUSE)
}

// Digits as strokes in a box one wide and one and a half high, as a hand writes them
const DIGITS = {
  0: [[[0.5, 0], [0.15, 0.2], [0.05, 0.75], [0.25, 1.4], [0.75, 1.4], [0.95, 0.75], [0.85, 0.2], [0.5, 0]]],
  1: [[[0.25, 0.3], [0.55, 0]], [[0.55, 0], [0.55, 1.5]]],
  2: [[[0.05, 0.35], [0.3, 0.02], [0.75, 0.05], [0.9, 0.4], [0.6, 0.85], [0.05, 1.45], [0.95, 1.45]]],
  3: [[[0.05, 0.1], [0.5, 0], [0.9, 0.25], [0.8, 0.6], [0.35, 0.72]], [[0.35, 0.72], [0.85, 0.85], [0.95, 1.2], [0.6, 1.48], [0.05, 1.4]]],
  4: [[[0.65, 0], [0.05, 1.0], [1.0, 1.0]], [[0.7, 0.45], [0.7, 1.5]]],
  5: [[[0.9, 0.02], [0.15, 0.02], [0.1, 0.65], [0.55, 0.55], [0.92, 0.85], [0.85, 1.3], [0.45, 1.48], [0.05, 1.35]]],
  6: [[[0.85, 0.05], [0.4, 0.2], [0.1, 0.8], [0.25, 1.4], [0.7, 1.45], [0.9, 1.05], [0.55, 0.75], [0.15, 0.95]]],
  7: [[[0.05, 0.02], [0.95, 0.02], [0.4, 1.5]]],
  8: [[[0.5, 0.7], [0.15, 0.4], [0.5, 0.02], [0.85, 0.4], [0.5, 0.7], [0.1, 1.05], [0.5, 1.48], [0.9, 1.05], [0.5, 0.7]]],
  9: [[[0.85, 0.45], [0.5, 0.75], [0.12, 0.45], [0.45, 0.02], [0.85, 0.3], [0.8, 1.5]]],
}

/** Writes a number by hand with the pointer, in the box given. */
async function write(page, text, box) {
  const h = box.height * 0.62
  const w = h / 1.5
  const gap = w * 0.45
  const total = text.length * w + (text.length - 1) * gap
  let x = box.x + (box.width - total) / 2
  const y = box.y + (box.height - h) / 2
  for (const ch of text) {
    for (const stroke of DIGITS[ch] ?? []) {
      const pts = stroke.map(([px, py]) => ({ x: x + px * w, y: y + (py / 1.5) * h }))
      await page.mouse.move(pts[0].x, pts[0].y)
      await page.mouse.down()
      for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 6 })
      await page.mouse.up()
      await sleep(60)
    }
    x += w + gap
  }
}

/**
 * The seven parts, in order. Each takes the person through the part as a new person would and
 * reports each thing done and the agent's answer to it through `log`.
 */
const PARTS = ['room', 'board', 'studio', 'chess', 'cube', 'drums', 'end']
export async function tour({ page, fr, log, wait = 240_000, from = null, until = null }) {
  await watchDock(fr)
  const asked = async (what, ms = wait) => {
    const since = Date.now() - 300
    return { since, done: () => waitAnswer(fr, since, ms), what }
  }
  const answered = async (name, a) => {
    const r = await a.done()
    log(`${name}: answered on the page`, r.ok ? `${r.seconds.toFixed(1)} s; ${r.stages.join(' ')}; dock: ${r.said}` : `no answer within ${wait / 1000} s; ${r.stages.join(' ')}; dock: ${r.said}`, r.ok)
    await sleep(PAUSE)
    return r
  }
  const results = {}
  const skip = (part) => from && PARTS.indexOf(part) < PARTS.indexOf(from)

  // 1. The room: the armchair is dragged onto the sofa, where it does not fit
  if (!skip('room') && !(until && PARTS.indexOf('room') > PARTS.indexOf(until))) {
    const chair = await center(fr.locator('#room-chair'))
    const sofa = await center(fr.locator('#room-sofa'))
    const a = await asked('moved')
    await drag(page, chair, { x: sofa.x - 10, y: sofa.y + 20 })
    log('room: dragged the armchair onto the sofa')
    results.room = await answered('room', a)
    await next(fr)
  }
  // 2. The whiteboard: a marker is picked, the answer written by hand, and Check it pressed
  if (!skip('board') && !(until && PARTS.indexOf('board') > PARTS.indexOf(until))) {
    const sum = await fr.evaluate(() => document.getElementById('board-ask').textContent)
    const m = /(\d+)\s*[×x*]\s*(\d+)\s*=/.exec(sum) ?? /(\d+)\s*\+\s*(\d+)\s*=/.exec(sum)
    const answer = m ? String(sum.includes('+') && !sum.includes('×') ? Number(m[1]) + Number(m[2]) : Number(m[1]) * Number(m[2])) : '144'
    const markers = fr.locator('#board-tray button')
    if ((await markers.count()) > 0) {
      await markers.nth(1).click()
      await sleep(600)
    }
    const slot = await fr.locator('#board-slot').boundingBox()
    await write(page, answer, slot)
    log('board: wrote the answer by hand', `${(m && m[0]) || sum.slice(0, 40)} ${answer}`)
    await sleep(800)
    const a = await asked('checked')
    await fr.locator('#board-check').click()
    log('board: pressed Check it')
    results.board = await answered('board', a)
    await next(fr)
  }
  // 3. The studio: a mood, a colour dragged on the wheel; then a piece pointed at, and a word for what is wrong
  if (!skip('studio') && !(until && PARTS.indexOf('studio') > PARTS.indexOf(until))) {
    const knob = await center(fr.locator('#studio-knob'))
    const wheel = await center(fr.locator('#studio-wheel'))
    const a = await asked('design')
    await drag(page, knob, { x: wheel.x - wheel.b.width * 0.28, y: wheel.y + wheel.b.height * 0.22 }, 25)
    log('studio: dragged the colour wheel to a blue and let go')
    results.design = await answered('studio design', a)
    const piece = fr.locator('#studio-easel .studio-piece:visible').first()
    const ask = fr.locator('#studio-ask button')
    if ((await piece.count()) > 0) {
      await piece.click()
      await sleep(900)
    }
    if (await ask.first().isVisible().catch(() => false)) {
      const word = (await ask.first().textContent())?.trim()
      const b = await asked('point')
      await ask.first().click()
      log('studio: pointed at a piece of the page and chose a word for it', word)
      results.point = await answered('studio point', b)
    } else log('studio: found no piece to point at', '', false)
    await next(fr)
  }
  // 4. Chess: two moves as White
  if (!skip('chess') && !(until && PARTS.indexOf('chess') > PARTS.indexOf(until))) {
    for (const [from, to] of [
      ['e2', 'e4'],
      ['g1', 'f3'],
    ]) {
      const a = await asked('move')
      await fr.locator(`#chess-board [data-sq="${from}"]`).click()
      await sleep(500)
      await fr.locator(`#chess-board [data-sq="${to}"]`).click()
      log(`chess: played ${from}${to}`)
      results[`chess ${from}${to}`] = await answered(`chess ${from}${to}`, a)
    }
    await next(fr)
  }
  // 5. The cube: mixed where it is solved, the agent asked how, and the turns played
  if (!skip('cube') && !(until && PARTS.indexOf('cube') > PARTS.indexOf(until))) {
    const solved = await fr.evaluate(() => /solved/i.test(document.getElementById('cube-count')?.textContent ?? '') && !document.getElementById('cube-mix').disabled)
    if (solved) {
      await fr.locator('#cube-mix').click()
      await sleep(2500)
    }
    const a = await asked('turned')
    await fr.locator('#cube-ask').click()
    log('cube: pressed Ask your agent how')
    results.cube = await answered('cube', a)
    const auto = fr.locator('#cube-auto')
    if (await auto.isVisible().catch(() => false)) {
      await auto.click()
      log('cube: pressed Do it for me')
      await sleep(6000)
    }
    await next(fr)
  }
  // 6. The drum machine: four pads, then a bassline asked for
  if (!skip('drums') && !(until && PARTS.indexOf('drums') > PARTS.indexOf(until))) {
    for (const [r, c] of [
      [3, 0],
      [3, 4],
      [2, 2],
      [2, 6],
    ]) {
      await fr.locator(`#drums-bars button.pad[data-r="${r}"][data-c="${c}"]`).first().click()
      await sleep(350)
    }
    const a = await asked('beat')
    log('drums: tapped kick on 1 and 5, snare on 3 and 7')
    results.beat = await answered('drums', a)
    const bass = fr.locator('#drums-asks button[data-ask="bass"]')
    if (await bass.isEnabled().catch(() => false)) {
      const b = await asked('beat')
      await bass.click()
      log('drums: asked for a bassline')
      results.bass = await answered('drums bassline', b)
    }
    await next(fr)
  }
  // 7. The ending: the ideas are waited for, and the first is made
  if (!skip('end') && !(until && PARTS.indexOf('end') > PARTS.indexOf(until))) {
    const end = Date.now() + wait
    let names = []
    while (Date.now() < end) {
      names = await fr.evaluate(() => [...document.querySelectorAll('#end-cards button')].filter((b) => /Make this/.test(b.textContent)).map((b) => b.closest('[class]')?.innerText.split('\n')[0] ?? ''))
      const filled = await fr.evaluate(() => (document.getElementById('end-cards')?.innerText ?? '').replace(/Make this/g, '').trim().length > 20)
      if (filled) break
      await sleep(1000)
    }
    const ideas = await fr.evaluate(() => (document.getElementById('end-cards')?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 500))
    log('end: ideas on the page', ideas || '(none came)', Boolean(ideas.replace(/Make this/g, '').trim()))
    results.ideas = { ok: Boolean(ideas.replace(/Make this/g, '').trim()), ideas }
    const tourUrl = page.url()
    const make = fr.getByRole('button', { name: /Make this/ }).first()
    if (await make.isEnabled().catch(() => false)) {
      await make.click()
      const t0 = Date.now()
      log('end: pressed Make this on the first idea')
      let made = false
      while (Date.now() - t0 < 420_000) {
        if (!page.url().includes('/p/tour-') && page.url() !== tourUrl) {
          made = true
          break
        }
        await sleep(1000)
      }
      await sleep(4000)
      log('end: the agent built the page and it opened in place of the tour', made ? `${((Date.now() - t0) / 1000).toFixed(0)} s; ${page.url()}` : `still on ${page.url()} after 7 minutes`, made)
      results.make = { ok: made, url: page.url() }
    }
  }
  return results
}
