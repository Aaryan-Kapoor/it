import { runInNewContext } from 'node:vm'
import { describe, expect, test } from 'vitest'
import { GUIDE, tourPage } from '../src/tour'

const { JSDOM } = (await import('jsdom' as string)) as any
const SLOW = 40_000

interface Navigation {
  from: string
  from_version: number
  attempt: number
  choice?: string
  text?: string
}

/** The decision rule shipped in the guide, which the agent applies before showing a choice. */
function guide(version: number) {
  const rule = /```js\n(function takeMenuAttempt[\s\S]*?)\n```/.exec(GUIDE)?.[1]
  expect(rule, 'The guide carries its menu decision rule.').toBeDefined()
  const take = runInNewContext(`${rule}\ntakeMenuAttempt`) as (menu: object, name: string, data: Navigation) => boolean
  const menu = { version, attempt: 0, choice: null }
  const shown: string[] = []
  return {
    shown,
    receive(action: { name: string; data: unknown }) {
      const data = action.data as Navigation
      if (take(menu, action.name, data)) shown.push(action.name === 'done' ? 'done' : data.choice!)
    },
  }
}

/** A showing of a tour page, with its version fixed and the clock moved by the test. */
async function opened(name: string, version: number) {
  const page = tourPage(name)
  const sent: { name: string; data: unknown; accept: () => Promise<void>; refuse: () => Promise<void> }[] = []
  const listeners: (() => void)[] = []
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
        onState: (fn: () => void) => {
          listeners.push(fn)
          return () => {}
        },
        action: (name: string, data: unknown) =>
          new Promise((resolve, reject) => {
            sent.push({
              name,
              data,
              accept: () => {
                resolve({ ok: true })
                return settled()
              },
              refuse: () => {
                reject(new Error('refused'))
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
    reopen: () => {
      for (const fn of listeners) fn()
    },
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
        { name: 'pick', data: { choice: 'chess', from: 'menu', from_version: 3, attempt: 1 } },
        { name: 'pick', data: { choice: 'chess', from: 'menu', from_version: 3, attempt: 2 } },
      ])
      later.$('.thing[data-choice="chess"]').click()
      expect(later.sent[0]!.data).toEqual({ choice: 'chess', from: 'menu', from_version: 4, attempt: 1 })
    } finally {
      menu.close()
      later.close()
    }
  })

  test('the request to end from the menu names the menu showing', async () => {
    const menu = await opened('menu', 3)
    try {
      menu.$('#enough').click()
      expect(menu.sent[0]).toMatchObject({ name: 'done', data: { from: 'menu', from_version: 3, attempt: 1 } })
    } finally {
      menu.close()
    }
  })

  test.each(['oldest first', 'newest first'])('chess followed by drums after the timeout ends on drums when processed %s', async (order) => {
    const menu = await opened('menu', 3)
    try {
      menu.$('.thing[data-choice="chess"]').click()
      await menu.sent[0]!.accept()
      await menu.advance(SLOW)
      menu.$('.thing[data-choice="drums"]').click()
      expect(menu.sent).toHaveLength(2)
      const agent = guide(3)
      for (const action of order === 'oldest first' ? menu.sent : [...menu.sent].reverse()) agent.receive(action)
      expect(agent.shown.at(-1)).toBe('drums')
      expect(agent.shown).toEqual(order === 'oldest first' ? ['chess', 'drums'] : ['drums'])
    } finally {
      menu.close()
    }
  })

  test('a single pick works and neither redelivery nor picking it again restarts it', async () => {
    const menu = await opened('menu', 3)
    try {
      const agent = guide(3)
      menu.$('.thing[data-choice="chess"]').click()
      agent.receive(menu.sent[0]!)
      expect(agent.shown).toEqual(['chess'])
      agent.receive(menu.sent[0]!)
      await menu.sent[0]!.accept()
      await menu.advance(SLOW)
      menu.$('.thing[data-choice="chess"]').click()
      agent.receive(menu.sent[1]!)
      expect(agent.shown).toEqual(['chess'])
    } finally {
      menu.close()
    }
  })

  test.each(['pick', 'done'])('a later %s supersedes the other menu action', async (latest) => {
    const menu = await opened('menu', 3)
    try {
      const pick = '.thing[data-choice="chess"]'
      menu.$(latest === 'pick' ? '#enough' : pick).click()
      await menu.sent[0]!.accept()
      await menu.advance(SLOW)
      menu.$(latest === 'pick' ? pick : '#enough').click()
      const agent = guide(3)
      for (const action of [...menu.sent].reverse()) agent.receive(action)
      expect(agent.shown).toEqual([latest === 'pick' ? 'chess' : 'done'])
    } finally {
      menu.close()
    }
  })

  test('a new menu showing rejects old attempts and starts its own count', async () => {
    const old = await opened('menu', 3)
    const menu = await opened('menu', 4)
    try {
      old.$('.thing[data-choice="chess"]').click()
      menu.$('.thing[data-choice="drums"]').click()
      const agent = guide(4)
      agent.receive(menu.sent[0]!)
      agent.receive(old.sent[0]!)
      expect(agent.shown).toEqual(['drums'])
    } finally {
      old.close()
      menu.close()
    }
  })

  test.each(['accept', 'refuse'] as const)('an older sending result cannot change the current attempt when it is %s', async (result) => {
    const menu = await opened('menu', 3)
    try {
      menu.$('.thing[data-choice="chess"]').click()
      menu.reopen()
      const drums = menu.$('.thing[data-choice="drums"]')
      drums.click()
      await menu.sent[1]!.accept()
      await menu.advance(SLOW - 1)
      await menu.sent[0]![result]()
      expect(drums.disabled).toBe(true)
      await menu.advance(1)
      expect(drums.disabled).toBe(false)
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

  test('the guide acknowledges superseded menu attempts and keeps the showing guard for other navigation', () => {
    expect(GUIDE).toContain('Keep the `id` and `version` printed by each `it tour show`')
    expect(GUIDE).toContain('`pick`, `next`, `menu`, `done` or `finish`')
    expect(GUIDE).toContain('compare `tour-<from>` and `from_version` with that `id` and `version`')
    expect(GUIDE).toContain('except for a newer attempt from the menu showing kept below')
    expect(GUIDE).toContain('even if you later return to the same page')
    expect(GUIDE).toContain("`it action <the action's id>`")
    expect(GUIDE).toContain('its `page` and `version` identify the showing')
    expect(GUIDE).toContain('Keep this record after showing a choice')
    expect(GUIDE).toContain('process only the highest `attempt`')
    expect(GUIDE).toContain("`it ack <the action's id>`")
    expect(GUIDE).toContain('Forget the record when another menu is shown, navigation from a destination is accepted, or the tour is cleared')
  })
})
