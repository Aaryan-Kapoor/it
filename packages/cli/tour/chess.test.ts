import { expect, test } from 'vitest'
import { tourPage } from '../src/tour'

const { JSDOM } = (await import('jsdom' as string)) as any

/** The board waits for the test to accept its move, and hears each state writing separately. */
async function opened() {
  const page = tourPage('chess')
  const sent: { name: string; data: any; accept: () => void }[] = []
  const listeners: (() => void)[] = []
  const It = {
    state: JSON.parse(page.state),
    revision: 1,
    onState: (fn: () => void) => listeners.push(fn),
    action: (name: string, data: any) => new Promise<void>((accept) => sent.push({ name, data, accept })),
  }
  const dom = new JSDOM(page.html, {
    runScripts: 'dangerously',
    beforeParse(w: any) {
      w.It = It
      w.matchMedia = () => ({ matches: true })
    },
  })
  await new Promise((done) => dom.window.addEventListener('load', done))
  return {
    sent,
    $: (selector: string) => dom.window.document.querySelector(selector),
    set(reply: string) {
      It.state = { ...It.state, reply }
      It.revision++
      for (const fn of listeners) fn()
    },
    close: () => dom.window.close(),
  }
}

test('an illegal answer written twice before the move is accepted still asks the agent for a correction once', async () => {
  const page = await opened()
  try {
    page.$('[data-sq="e2"]').click()
    page.$('[data-sq="e4"]').click()
    page.set('e7e4')
    page.set('e7e4')
    expect(page.sent.map((s) => s.name)).toEqual(['move'])
    page.sent[0]!.accept()
    await new Promise((done) => setImmediate(done))
    expect(page.sent.map((s) => s.name)).toEqual(['move', 'illegal'])
    expect(page.sent[1]!.data).toMatchObject({ move: 'e7e4', legal: expect.arrayContaining(['e7e5']) })
    page.set('e7e4')
    expect(page.sent.map((s) => s.name)).toEqual(['move', 'illegal'])
    page.set('e7e5')
    expect(page.$('[data-sq="e7"] .pc')).toBeNull()
    expect(page.$('[data-sq="e5"] .pc')).not.toBeNull()
    expect(page.$('.t-card').getAttribute('data-wait')).toBe('0')
  } finally {
    page.close()
  }
})

test('a different early answer replaces the illegal one before the move is accepted', async () => {
  const page = await opened()
  try {
    page.$('[data-sq="e2"]').click()
    page.$('[data-sq="e4"]').click()
    page.set('e7e4')
    page.set('e7e5')
    page.sent[0]!.accept()
    await new Promise((done) => setImmediate(done))
    expect(page.sent.map((s) => s.name)).toEqual(['move'])
    expect(page.$('[data-sq="e5"] .pc')).not.toBeNull()
    expect(page.$('.t-card').getAttribute('data-wait')).toBe('0')
  } finally {
    page.close()
  }
})
