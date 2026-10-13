import { describe, expect, test } from 'vitest'
import { GUIDE, tourPage } from '../src/tour'

const { JSDOM } = (await import('jsdom' as string)) as any
const SLOW = 40_000

/** A showing of a tour page, with its version fixed and the clock moved by the test. */
async function opened(name: string, version: number) {
  const page = tourPage(name)
  const sent: { name: string; data: unknown; accept: () => Promise<void> }[] = []
  const settled = () => new Promise<void>((done) => setImmediate(done))
  let now = 0
  let nextTimer = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const dom = new JSDOM(page.html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w: any) {
      w.It = {
        state: JSON.parse(page.state),
        version,
        onState: () => () => {},
        action: (name: string, data: unknown) =>
          new Promise((resolve) => {
            sent.push({
              name,
              data,
              accept: () => {
                resolve({ ok: true })
                return settled()
              },
            })
          }),
      }
      w.setTimeout = (fn: () => void, ms = 0) => {
        const id = ++nextTimer
        timers.set(id, { at: now + ms, fn })
        return id
      }
      w.clearTimeout = (id: number) => timers.delete(id)
    },
  })
  const w = dom.window
  if (w.document.readyState !== 'complete') await new Promise((done) => w.addEventListener('load', done))
  return {
    sent,
    $: (selector: string) => w.document.querySelector(selector),
    async advance(ms: number) {
      now += ms
      for (const [id, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.fn()
      }
      await settled()
    },
    close: () => w.close(),
  }
}

describe('the tour navigation requests', () => {
  test('a retried chess pick names the same menu showing, and a later menu showing names another version', async () => {
    const menu = await opened('menu', 3)
    const later = await opened('menu', 4)
    try {
      const chess = menu.$('.thing[data-choice="chess"]')
      chess.click()
      await menu.sent[0]!.accept()
      await menu.advance(SLOW - 1)
      expect(chess.disabled).toBe(true)
      await menu.advance(1)
      expect(chess.disabled).toBe(false)
      chess.click()
      expect(menu.sent.map(({ name, data }) => ({ name, data }))).toEqual([
        { name: 'pick', data: { choice: 'chess', from: 'menu', from_version: 3 } },
        { name: 'pick', data: { choice: 'chess', from: 'menu', from_version: 3 } },
      ])
      later.$('.thing[data-choice="chess"]').click()
      expect(later.sent[0]!.data).toEqual({ choice: 'chess', from: 'menu', from_version: 4 })
    } finally {
      menu.close()
      later.close()
    }
  })

  test('the request to end from the menu names the menu showing', async () => {
    const menu = await opened('menu', 3)
    try {
      menu.$('#enough').click()
      expect(menu.sent[0]).toMatchObject({ name: 'done', data: { from: 'menu', from_version: 3 } })
    } finally {
      menu.close()
    }
  })

  test('the ending names its showing when either button is retried after the agent has not answered', async () => {
    for (const [selector, action] of [
      ['#more', 'menu'],
      ['#finish', 'finish'],
    ]) {
      const ending = await opened('done', 7)
      try {
        const button = ending.$(selector!)
        button.click()
        await ending.sent[0]!.accept()
        await ending.advance(SLOW)
        expect(button.disabled).toBe(false)
        button.click()
        expect(ending.sent.map(({ name, data }) => ({ name, data }))).toEqual([
          { name: action, data: { from: 'done', from_version: 7 } },
          { name: action, data: { from: 'done', from_version: 7 } },
        ])
      } finally {
        ending.close()
      }
    }
  })

  test('the shared buttons name the showing they leave', async () => {
    const page = await opened('button', 5)
    try {
      page.$('#t-next').click()
      await page.sent[0]!.accept()
      await page.advance(SLOW)
      page.$('#t-more').click()
      expect(page.sent.map(({ name, data }) => ({ name, data }))).toEqual([
        { name: 'next', data: { from: 'button', from_version: 5 } },
        { name: 'menu', data: { from: 'button', from_version: 5 } },
      ])
    } finally {
      page.close()
    }
  })

  test('the agent is told to discard every navigation request from a showing it has left, even after returning to the same page', () => {
    expect(GUIDE).toContain('Keep the `id` and `version` printed by each `it tour show`')
    expect(GUIDE).toContain('`pick`, `next`, `menu`, `done` or `finish`')
    expect(GUIDE).toContain('compare `tour-<from>` and `from_version` with that `id` and `version`')
    expect(GUIDE).toContain('discard every queued request from the showing you left')
    expect(GUIDE).toContain('even if you later return to the same page')
    expect(GUIDE).toContain("`it action <the action's id>`")
    expect(GUIDE).toContain('its `page` and `version` identify the showing')
  })
})
