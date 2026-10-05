// What the owner is told of what It does on the computer it runs on. Each sentence is held to
// what the code does: where a number is the program's own, it is read from where the program
// reads it, and what only that computer can know is said as the service there said it.
import { LIMITS, PORTS, RETENTION } from '@it/protocol'
import { getFunctionName } from 'convex/server'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_URL } from '../../packages/cli/src/usage'

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
async function shown(at = 'http://localhost:4700/settings'): Promise<string[]> {
  browser.reconfigure({ url: at })
  const { WhatItDoes } = await import('./about')
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root.render(createElement(WhatItDoes)))
  return [...host.querySelectorAll('p')].map((p) => p.textContent ?? '')
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

describe('what It does on the computer it runs on', () => {
  test('the owner is told where everything is kept and for how long, in the program’s own numbers', async () => {
    const said = await shown()
    expect(host.querySelector('h3')!.textContent).toBe('What It does on the computer it runs on')
    expect(said[0]).toBe(
      'Everything It holds is kept on the computer It runs on, in the folder ~/.it (or the one IT_HOME names, if you set that): your pages, their files, and every record of them. Beside its database in that folder It keeps a copy of the database as it was before each of the last two updates that changed it. Nothing It holds is kept on any other computer.',
    )
    expect(said[2]).toContain(`with its ${LIMITS.versionsKept} newest versions, until you delete it`)
    expect(said[2]).toContain(
      `kept for ${RETENTION.handledActionDays} days after an agent has received it, and for ${RETENTION.pendingActionDays} days if none has`,
    )
    expect(said[2]).toContain(`A notification is kept for ${RETENTION.notificationDays} days`)
    expect(said[4]).toBe('A browser you pair stays paired while it is used, and for a year after it was last used.')
    expect(watched).toContain('network:service')
  })

  test('they are told of the copies that are not the one database: the ones kept before an update, what a browser keeps, and what the backend program keeps of what was removed', async () => {
    const said = await shown()
    // Nothing says that there is only one copy
    expect(said.join('\n')).not.toMatch(/no other copy|nowhere else/)
    expect(said[1]).toBe(
      'A browser that is paired keeps a little of its own: the cookie that is its pairing and that cookie’s name, which display it is, what you did on a page until that has reached It, and, where you turned notifications on, the script that shows them. What it could not send within 7 days it gives up. When its pairing ends, it keeps the cookie’s name for a day more, to ask for the cookie to be cleared again should an answer that was on its way put it back.',
    )
    expect(said[3]).toBe(
      'What is removed from the database, by you or by its age, stays inside the database’s file for about an hour more, where nothing of It reads it: the backend program keeps the earlier versions of what it holds for that long. Traces of it can stay in the file’s unused space after that, until the program writes over them. For about an hour the program also keeps a note of each task it ran in the background, by the id of the machine, the page, the notification or the conversation the task was about, with nothing that was on a page.',
    )
  })

  test('nothing in it speaks of the computer it is read on, which need not be the one It runs on', async () => {
    for (const background of [true, false, null])
      for (const usage of [true, false, null]) {
        itself = { port: 4700, background, usage }
        expect((await shown('http://192.168.1.20:4700/settings')).join('\n')).not.toMatch(/this computer|this machine/i)
        await again()
      }
    itself = undefined
    expect((await shown()).join('\n')).not.toMatch(/this computer|this machine/i)
  })

  test('that It starts by itself is said where the service says it is registered to, and is not said where it says it is not', async () => {
    const STARTS = 'It starts when that computer starts, or when you log in to it, and keeps running in the background.'
    expect(await shown()).toContain(STARTS)
    await again()
    itself = { port: 4700, background: false, usage: true }
    const byHand = await shown()
    expect(byHand).toContain(
      'It is not registered to start by itself on that computer: it runs for as long as it serve is kept running there. To have it start by itself, run it service install there.',
    )
    expect(byHand.join('\n')).not.toContain('keeps running in the background')
  })

  test('while the service has not said, both ways It can run are said, and neither as a fact', async () => {
    const BOTH =
      'Where it is registered as a background service, which it setup does unless it is told not to, It starts when that computer starts, or when you log in to it, and keeps running in the background. Otherwise it runs for as long as it serve is kept running there.'
    itself = { port: 4700, background: null, usage: null }
    expect(await shown()).toContain(BOTH)
    await again()
    // Nor before the backend has answered at all
    itself = undefined
    expect(await shown()).toContain(BOTH)
  })

  test('the ports are counted from the one the service counts from, whatever address the site was reached at, and none is named until that is known', async () => {
    itself = { port: 39500, background: true, usage: true }
    // The site as it is worked on, served from another port than It's own
    const said = (await shown('http://localhost:5173/settings')).join('\n')
    expect(said).toContain(
      `It uses four ports: 39500 for this site, 39501 for pages, and ${39500 + PORTS.backendApi} and ${39500 + PORTS.backendSite} for its backend program.`,
    )
    expect(said).toContain('The backend program’s two answer the computer It runs on and no other.')
    await again()
    itself = undefined
    expect((await shown('http://localhost:4700/settings')).join('\n')).toContain(
      'It uses four ports: one for this site, one for pages, and two for its backend program.',
    )
  })

  test('they are told what is fetched to that computer, and the two things that leave it', async () => {
    const said = (await shown()).join('\n')
    expect(said).toContain('fetched from Convex’s releases on GitHub the first time It runs, and again when a newer It needs a newer one')
    expect(said).toContain('travels through the push service of that browser’s maker, sealed so that only that browser can read it')
    // Where usage counts go is where the program sends them, and how to stop it is the command that does
    expect(said).toContain(`It sends counts of how it is used to ${new URL(DEFAULT_URL).hostname}`)
    expect(said).toContain('To turn that off, run it telemetry off on the computer It runs on.')
  })

  test('that counts of its use are sent is said where the service says they are, and that none are where it says they are not', async () => {
    const host = new URL(DEFAULT_URL).hostname
    itself = { port: 4700, background: true, usage: false }
    const off = (await shown()).join('\n')
    expect(off).toContain(
      `It is sending no counts of how it is used. When usage reporting is on, it sends them to ${host}, under a random id for this installation: that it started, that a page was published, that an answer reached an agent, and never anything that is on a page. On the computer It runs on, it telemetry says whether it is on.`,
    )
    expect(off).not.toContain('It sends counts of how it is used')
    await again()
    // Not said either way while the service has not said: only on what it depends
    itself = { port: 4700, background: true, usage: null }
    const unsaid = (await shown()).join('\n')
    expect(unsaid).toContain(`Unless usage reporting has been turned off, It sends counts of how it is used to ${host}`)
    expect(unsaid).not.toContain('It is sending no counts')
  })
})
