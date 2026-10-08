// The few facts the owner is shown of how It stands on the computer it runs on. What only that
// computer can know is said as the service there said it, and not at all until it has.
import { PORTS } from '@it/protocol'
import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/** What the service has told the backend of itself, as the owner's browser is given it. Nothing, until the backend has answered. */
let itself: { port: number; background: boolean | null; usage: boolean | null } | undefined
const watched: string[] = []
vi.mock('convex/react', () => ({
  useQuery: (fn: unknown) => {
    watched.push(getFunctionName(fn as never))
    return itself
  },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const browser = (globalThis as unknown as { jsdom: { reconfigure(to: { url: string }): void } }).jsdom
const HOME = location.href
let root: Root
let host: HTMLElement
/** Each fact as it is shown: its name, how it stands, and the command under it where there is one. */
async function shown(at = 'http://localhost:4700/settings'): Promise<Record<string, { value: string; change: string | null }>> {
  browser.reconfigure({ url: at })
  const { About } = await import('./about')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root.render(createElement(About)))
  return Object.fromEntries(
    [...host.querySelectorAll('.row')].map((row) => [
      row.querySelector('.row-name')!.textContent ?? '',
      { value: row.querySelector('.row-value')!.textContent ?? '', change: row.querySelector('.row-sub code')?.textContent ?? null },
    ]),
  )
}
const again = async () => {
  await act(async () => root.unmount())
  host.remove()
}
beforeEach(() => {
  itself = { port: 4700, background: true, usage: true }
  watched.length = 0
})
afterEach(async () => {
  await again()
  browser.reconfigure({ url: HOME })
})

describe('how It stands on the computer it runs on', () => {
  test('the owner is shown four facts, as the service said them, each with the command that changes it', async () => {
    const said = await shown()
    expect(host.querySelector('h3')!.textContent).toBe('Where It runs')
    expect(said).toEqual({
      'Starts by itself': { value: 'On', change: 'it service uninstall' },
      'Usage counts': { value: 'Sent', change: 'it telemetry off' },
      Ports: { value: `4700 · 4701 · ${4700 + PORTS.backendApi} · ${4700 + PORTS.backendSite}`, change: null },
      'Kept in': { value: '~/.it on the machine It runs on, unless it was set up in another folder', change: null },
    })
    expect(watched).toContain('network:service')
  })

  test('what is off is said to be off, with the command that turns it on', async () => {
    itself = { port: 4700, background: false, usage: false }
    const said = await shown()
    expect(said['Starts by itself']).toEqual({ value: 'Off', change: 'it service install' })
    expect(said['Usage counts']).toEqual({ value: 'Not sent', change: 'it telemetry on' })
  })

  test('nothing is said as a fact while the service has not said it, or before the backend has answered at all', async () => {
    itself = { port: 4700, background: null, usage: null }
    const unsaid = await shown()
    expect(unsaid['Starts by itself']).toEqual({ value: '…', change: null })
    expect(unsaid['Usage counts']).toEqual({ value: '…', change: null })
    await again()
    itself = undefined
    const unanswered = await shown()
    expect(unanswered['Starts by itself']!.value).toBe('…')
    expect(unanswered.Ports!.value).toBe('…')
  })

  test('the ports are counted from the one the service counts from, whatever address the site was reached at', async () => {
    itself = { port: 39500, background: true, usage: true }
    // The site as it is worked on, served from another port than It's own
    const said = await shown('http://localhost:5173/settings')
    expect(said.Ports!.value).toBe(`39500 · 39501 · ${39500 + PORTS.backendApi} · ${39500 + PORTS.backendSite}`)
  })

  test('nothing in it speaks of the computer it is read on, which need not be the one It runs on', async () => {
    for (const background of [true, false, null])
      for (const usage of [true, false, null]) {
        itself = { port: 4700, background, usage }
        await shown('http://192.168.1.20:4700/settings')
        expect(host.textContent).not.toMatch(/this computer|this machine/i)
        await again()
      }
    itself = undefined
    await shown()
    expect(host.textContent).not.toMatch(/this computer|this machine/i)
  })
})
