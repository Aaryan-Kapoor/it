import { describe, expect, it } from 'vitest'
import { type Click, shortId, stepsOf } from './activity'

const click = (over: Partial<Click> = {}): Click => ({
  id: 'a1',
  at: 1_000_000,
  madeAt: 1_000_000,
  delivery: 'pending',
  route: null,
  outcome: null,
  attended: true,
  handedAt: null,
  parked: false,
  heldBack: null,
  seq: 1,
  harness: 'claude-code',
  conversation: '0123456789abcdef',
  ...over,
})
const codes = (c: Click) => stepsOf(c).map((s) => s.code)

describe('what the activity panel says became of a click', () => {
  it('says a click nobody has taken is waiting, after saying it was made, received and whom it is for', () => {
    expect(codes(click())).toEqual(['made', 'received', 'addressed', 'waiting'])
    expect(stepsOf(click())[2]!.text).toContain(shortId('0123456789abcdef'))
  })

  it('says a click that reached It late waited in its browser', () => {
    expect(codes(click({ madeAt: 1_000_000 - 60_000 }))[1]).toBe('received_late')
  })

  it('says a click was handed over, by which way, and what became of the work', () => {
    const steps = stepsOf(click({ delivery: 'handed_off', route: 'addon', handedAt: 1_000_500, outcome: 'succeeded' }))
    expect(steps.map((s) => s.code)).toEqual(['made', 'received', 'addressed', 'handed', 'succeeded'])
    expect(steps[3]).toMatchObject({ at: 1_000_500, text: 'Handed to the agent (addon)' })
    expect(codes(click({ delivery: 'handed_off', route: 'addon', outcome: 'failed' })).at(-1)).toBe('failed')
    expect(codes(click({ delivery: 'handed_off', route: 'addon', outcome: 'running' })).at(-1)).toBe('running')
    expect(codes(click({ delivery: 'handed_off', route: 'addon', outcome: null })).at(-1)).toBe('unknown')
  })

  it('says a click a stop dropped was dropped, and never that an agent was given it', () => {
    const got = codes(click({ delivery: 'handed_off', route: 'stopped', handedAt: 1_000_500, outcome: 'unknown' }))
    expect(got).toEqual(['made', 'received', 'addressed', 'stopped'])
  })

  it('says why a click is held back before it says it was set aside, and says a click being delivered is', () => {
    expect(stepsOf(click({ heldBack: 'its app is open without the add-on', parked: true })).at(-1)).toMatchObject({ code: 'held', tone: 'bad' })
    expect(stepsOf(click({ heldBack: 'its app is open without the add-on' })).at(-1)!.text).toBe('Held back: its app is open without the add-on')
    expect(codes(click({ parked: true })).at(-1)).toBe('set_aside')
    expect(codes(click({ delivery: 'leased' })).at(-1)).toBe('delivering')
  })

  it('says a click with no conversation has none, and says nothing of one where older functions do not tell', () => {
    expect(codes(click({ harness: null, conversation: null }))).toContain('unaddressed')
    expect(codes(click({ harness: undefined, conversation: undefined }))).toEqual(['made', 'received', 'waiting'])
  })

  it('does not say who was at the page where that was not kept', () => {
    expect(stepsOf(click({ attended: null }))[0]!.text).toBe('Made on the page')
    expect(stepsOf(click({ attended: false }))[0]!.text).toBe('Made on the page, with nobody at the page')
  })
})
