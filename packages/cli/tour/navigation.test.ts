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

/** The decision rules shipped in the guide, applied before navigation and immediately before its command. */
function guide(version: number, from = 'menu') {
  const rule = /```js\n(function takeTourAttempt[\s\S]*?)\n```/.exec(GUIDE)?.[1]
  expect(rule, 'The guide carries its navigation decision rules.').toBeDefined()
  const { take, commit } = runInNewContext(`${rule}\n({ take: takeTourAttempt, commit: commitTourAttempt })`)
  const record = (from: string, version: number) => ({ from, version, attempt: 0, choice: null, wanted: null })
  const tour: { current: object | null; previous: object | null } = { current: record(from, version), previous: null }
  const shown: string[] = []
  let nextVersion = version
  function complete(action: { name: string; data: unknown }) {
    const data = action.data as Navigation
    if (!commit(tour, action.name, data)) return
    const destination = action.name === 'pick' ? data.choice! : action.name
    shown.push(destination)
    if (action.name === 'finish') tour.current = tour.previous = null
    else tour.current = record(destination, ++nextVersion)
  }
  return {
    shown,
    begin: (action: { name: string; data: unknown }) => take(tour, action.name, action.data),
    complete,
    receive(action: { name: string; data: unknown }) {
      if (take(tour, action.name, action.data)) complete(action)
    },
    showing: () => tour.current as { from: string; version: number },
  }
}

/** A showing of a tour page, with its version fixed and the clock moved by the test. */
async function opened(name: string, version: number, saved?: Record<string, unknown>, loading = false, persist: () => Promise<void> = async () => {}) {
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
        state: { ...JSON.parse(page.state), ...(saved && !loading ? { _page: { ...saved } } : {}) },
        version,
        revision: loading ? 0 : 1,
        ...(saved && {
          store: {
            get: (key: string) => (w.It.revision ? saved[key] : undefined),
            set: async (key: string, value: unknown) => {
              await persist()
              saved[key] = value
              w.It.state = { ...w.It.state, _page: { ...saved } }
              w.It.revision++
              for (const fn of listeners) fn()
            },
          },
        }),
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
    settled,
    loaded: () => {
      w.It.revision = 1
      w.It.state = { ...w.It.state, _page: { ...saved } }
      for (const fn of listeners) fn()
    },
    reopen: () => {
      w.It.state = { ...w.It.state, seen: ['chess'] }
      w.It.revision++
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

  test.each(['oldest first', 'newest first'])('a menu reload retains the attempt count when processed %s', async (order) => {
    const saved: Record<string, unknown> = {}
    const before = await opened('menu', 3, saved)
    let after: Awaited<ReturnType<typeof opened>> | undefined
    try {
      before.$('.thing[data-choice="chess"]').click()
      await before.settled()
      expect(before.$('.thing[data-choice="drums"]').disabled).toBe(true)
      await before.sent[0]!.accept()
      before.close()
      after = await opened('menu', 3, saved, true)
      expect(after.$('.thing[data-choice="drums"]').disabled).toBe(true)
      after.loaded()
      after.$('.thing[data-choice="drums"]').click()
      await after.settled()
      expect(after.sent[0]!.data).toMatchObject({ attempt: 2 })
      const actions = [before.sent[0]!, after.sent[0]!]
      const agent = guide(3)
      for (const action of order === 'oldest first' ? actions : actions.reverse()) agent.receive(action)
      expect(agent.shown.at(-1)).toBe('drums')
    } finally {
      before.close()
      after?.close()
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
          { name: action, data: { from: 'done', from_version: 7, attempt: 1 } },
          { name: action, data: { from: 'done', from_version: 7, attempt: 2 } },
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
        { name: 'next', data: { from: 'button', from_version: 5, attempt: 1 } },
        { name: 'menu', data: { from: 'button', from_version: 5, attempt: 2 } },
      ])
    } finally {
      page.close()
    }
  })

  test.each(['oldest first', 'newest first'])('the latest shared button wins when processed %s', async (order) => {
    const page = await opened('button', 5)
    try {
      page.$('#t-next').click()
      await page.sent[0]!.accept()
      await page.advance(SLOW)
      page.$('#t-more').click()
      const agent = guide(5, 'button')
      for (const action of order === 'oldest first' ? page.sent : [...page.sent].reverse()) agent.receive(action)
      expect(agent.shown).toEqual(order === 'oldest first' ? ['next', 'menu'] : ['menu'])
    } finally {
      page.close()
    }
  })

  test('a delayed Finish cannot clear the tour after See another one supersedes it', async () => {
    const page = await opened('done', 7)
    try {
      page.$('#finish').click()
      await page.sent[0]!.accept()
      await page.advance(SLOW)
      page.$('#more').click()
      const agent = guide(7, 'done')
      expect(agent.begin(page.sent[0]!)).toBe(true)
      agent.receive(page.sent[1]!)
      agent.complete(page.sent[0]!)
      agent.receive(page.sent[0]!)
      expect(agent.shown).toEqual(['menu'])
    } finally {
      page.close()
    }
  })

  test.each([
    ['menu', '.thing[data-choice="chess"]', '.thing[data-choice="drums"]'],
    ['button', '#t-next', '#t-more'],
    ['done', '#finish', '#more'],
  ])('%s keeps attempts over reloads and starts again for a new showing', async (name, first, second) => {
    const saved: Record<string, unknown> = {}
    const before = await opened(name!, 3, saved)
    let after: Awaited<ReturnType<typeof opened>> | undefined
    let later: Awaited<ReturnType<typeof opened>> | undefined
    try {
      before.$(first!).click()
      await before.settled()
      expect(before.$(second!).disabled).toBe(true)
      await before.sent[0]!.accept()
      before.close()
      after = await opened(name!, 3, saved, true)
      expect(after.$(second!).disabled).toBe(true)
      after.loaded()
      after.$(second!).click()
      await after.settled()
      expect(after.sent[0]!.data).toMatchObject({ attempt: 2 })
      expect(after.$(first!).disabled).toBe(true)
      after.close()
      later = await opened(name!, 4, saved)
      later.$(first!).click()
      await later.settled()
      expect(later.sent[0]!.data).toMatchObject({ from_version: 4, attempt: 1 })
    } finally {
      before.close()
      after?.close()
      later?.close()
    }
  })

  test.each(['accept', 'refuse'] as const)('the ending ignores an older sending result when it is %s', async (result) => {
    const page = await opened('done', 7, {})
    try {
      page.$('#finish').click()
      await page.settled()
      page.reopen()
      page.$('#more').click()
      await page.settled()
      await page.sent[1]!.accept()
      await page.advance(SLOW - 1)
      await page.sent[0]![result]()
      expect(page.$('#more').disabled).toBe(true)
      expect(page.$('#status').textContent).toBe('One moment')
      await page.advance(1)
      expect(page.$('#more').disabled).toBe(false)
    } finally {
      page.close()
    }
  })

  test('a newer Finish can clear the menu shown for an earlier ending action, only once', () => {
    const agent = guide(7, 'done')
    const menu = { name: 'menu', data: { from: 'done', from_version: 7, attempt: 1 } }
    const finish = { name: 'finish', data: { from: 'done', from_version: 7, attempt: 2 } }
    agent.receive(menu)
    agent.receive(finish)
    agent.receive(finish)
    agent.receive(menu)
    expect(agent.shown).toEqual(['menu', 'finish'])
  })

  test('an older Finish arriving after a newer menu action never clears the tour', () => {
    const agent = guide(7, 'done')
    agent.receive({ name: 'menu', data: { from: 'done', from_version: 7, attempt: 2 } })
    agent.receive({ name: 'finish', data: { from: 'done', from_version: 7, attempt: 1 } })
    expect(agent.shown).toEqual(['menu'])
  })

  test('a retry of Next does not restart its destination and retires earlier alternatives', () => {
    const agent = guide(5, 'button')
    const action = (name: string, attempt: number) => ({ name, data: { from: 'button', from_version: 5, attempt } })
    agent.receive(action('next', 1))
    agent.receive(action('next', 3))
    agent.receive(action('menu', 2))
    expect(agent.shown).toEqual(['next'])
  })

  test('navigation from a destination retires attempts from the showing that led to it', () => {
    const agent = guide(7, 'done')
    agent.receive({ name: 'menu', data: { from: 'done', from_version: 7, attempt: 1 } })
    const menu = agent.showing()
    agent.receive({ name: 'pick', data: { choice: 'chess', from: menu.from, from_version: menu.version, attempt: 1 } })
    agent.receive({ name: 'finish', data: { from: 'done', from_version: 7, attempt: 2 } })
    expect(agent.shown).toEqual(['menu', 'chess'])
  })

  test('a superseded destination cannot navigate after the source chooses another page', () => {
    const agent = guide(3)
    const pick = (choice: string, attempt: number) => ({ name: 'pick', data: { choice, from: 'menu', from_version: 3, attempt } })
    agent.receive(pick('chess', 1))
    const chess = agent.showing()
    agent.receive(pick('drums', 2))
    agent.receive({ name: 'next', data: { from: chess.from, from_version: chess.version, attempt: 1 } })
    expect(agent.shown).toEqual(['chess', 'drums'])
  })

  test('an identical Finish retry can complete while the older Finish is still being prepared', () => {
    const agent = guide(7, 'done')
    const action = (attempt: number) => ({ name: 'finish', data: { from: 'done', from_version: 7, attempt } })
    expect(agent.begin(action(1))).toBe(true)
    agent.receive(action(2))
    agent.complete(action(1))
    expect(agent.shown).toEqual(['finish'])
  })

  test.each([
    ['menu', '.thing[data-choice="chess"]'],
    ['button', '#t-next'],
    ['done', '#finish'],
  ])('%s sends nothing until its attempt is saved and recovers when saving fails', async (name, selector) => {
    const writes: { accept: () => void; refuse: () => void }[] = []
    const page = await opened(
      name!,
      3,
      {},
      false,
      () =>
        new Promise<void>((resolve, reject) => {
          writes.push({ accept: resolve, refuse: () => reject(new Error('not saved')) })
        }),
    )
    try {
      page.$(selector!).click()
      await page.settled()
      expect(page.sent).toHaveLength(0)
      expect(page.$(selector!).disabled).toBe(true)
      writes[0]!.refuse()
      await page.settled()
      expect(page.sent).toHaveLength(0)
      expect(page.$(selector!).disabled).toBe(false)
      page.$(selector!).click()
      writes[1]!.accept()
      await page.settled()
      expect(page.sent[0]!.data).toMatchObject({ attempt: 2 })
      expect(page.$(selector!).disabled).toBe(true)
    } finally {
      page.close()
    }
  })

  test('an older Finish cannot commit while a newer identical Finish is being prepared', () => {
    const agent = guide(7, 'done')
    const action = (attempt: number) => ({ name: 'finish', data: { from: 'done', from_version: 7, attempt } })
    expect(agent.begin(action(1))).toBe(true)
    expect(agent.begin(action(2))).toBe(true)
    agent.complete(action(1))
    expect(agent.shown).toEqual([])
    agent.complete(action(2))
    expect(agent.shown).toEqual(['finish'])
  })

  test('the guide guards every navigation command and checks queued actions before clearing', () => {
    expect(GUIDE).toContain('Keep the `id` and `version` printed by each `it tour show`')
    expect(GUIDE).toContain('`pick`, `next`, `menu`, `done` or `finish`')
    expect(GUIDE).toContain("`it action <the action's id>`")
    expect(GUIDE).toContain('its `page` and `version` identify the showing')
    expect(GUIDE).toContain('process only the highest `attempt`')
    expect(GUIDE).toContain("`it ack <the action's id>`")
    expect(GUIDE).toContain('it actions --id tour-done')
    expect(GUIDE).toContain('immediately before `it tour clear`')
  })
})
