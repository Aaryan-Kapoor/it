/// <reference types="vite/client" />
// Project agents, an experiment: an agent the person starts from the site in a folder that one of
// their machines offers. What it must get right: nothing is offered until the machine itself
// says so, an agent runs only in a folder the machine named and with an app connected there,
// only the owner's browser may start, message, stop or start one again, a machine runs no more
// than it said it would, and revoking a machine or erasing everything leaves nothing of them.
import { AGENTS } from '@it/protocol'
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
process.env.CONVEX_SITE_URL = SITE
process.env.IT_PORT = '39000'

afterEach(() => {
  vi.useRealTimers()
})

let keys = 0
/** A backend with one person, their browser as the owner's and as a screen, and a machine of theirs with Claude Code connected and Codex found but not connected. */
async function withMachine(system = 'linux') {
  const t = convexTest(schema, modules)
  const made = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'laptop', publicKey: { kty: 'EC', crv: 'P-256', x: `x${++keys}`, y: 'y' } })
  if ('error' in made) throw new Error(made.error)
  const { user, owner, screen } = await t.run(async (ctx) => {
    const user = (await ctx.db.query('users').first())!
    const now = Date.now()
    const session = (role: 'owner' | 'screen') =>
      ctx.db.insert('sessions', { userId: user._id, secretHash: `no-secret-${role}`, role, createdAt: now, lastSeenAt: now, cookieAt: now })
    await ctx.db.patch(made.machineId, {
      system,
      wanted: ['claude-code'],
      harnesses: [
        { id: 'claude-code', version: '2.1.310', addon: 'connected' },
        { id: 'codex', version: '0.164.0', addon: 'off' },
      ],
    })
    return { user: user._id as string, owner: await session('owner'), screen: await session('screen') }
  })
  const browser = t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: owner, role: 'owner' })
  const tv = t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: screen, role: 'screen' })
  const machine = t.withIdentity({ issuer: SITE, subject: made.machineId, kind: 'machine' })
  return { t, user, browser, tv, machine, machineId: made.machineId as Id<'machines'> }
}

const FOLDERS = [
  { id: 'p-one', name: 'garden', where: '~/code/garden' },
  { id: 'p-two', name: 'shed', where: '~/code/shed' },
]

describe('a project agent', () => {
  test('cannot be started on a machine that offers none, and is offered once the machine says so', async () => {
    const { browser, machine, machineId } = await withMachine()
    expect((await browser.query(api.agents.list, {})).machines).toEqual([])
    await expect(browser.mutation(api.agents.start, { machineId, project: 'p-one', app: 'claude-code' })).rejects.toThrow(/does not offer project agents/)
    await machine.mutation(api.agents.offer, { offer: { most: 2, projects: FOLDERS } })
    const { machines } = await browser.query(api.agents.list, {})
    // Only the app that is connected there is offered: Codex is found and not connected
    expect(machines).toMatchObject([{ id: machineId, name: 'laptop', most: 2, projects: FOLDERS, apps: ['claude-code'] }])
  })

  test('runs only in a folder the machine named, with an app connected there, on a system It runs agents on', async () => {
    const { browser, machine, machineId } = await withMachine()
    await machine.mutation(api.agents.offer, { offer: { most: 2, projects: FOLDERS } })
    await expect(browser.mutation(api.agents.start, { machineId, project: '/home/someone/elsewhere', app: 'claude-code' })).rejects.toThrow(
      /does not offer that folder/,
    )
    await expect(browser.mutation(api.agents.start, { machineId, project: 'p-one', app: 'codex' })).rejects.toThrow(/Connect that agent app/)
    await expect(browser.mutation(api.agents.start, { machineId, project: 'p-one', app: 'pi' })).rejects.toThrow(/cannot start an agent with that/)
    const windows = await withMachine('win32')
    await windows.machine.mutation(api.agents.offer, { offer: { most: 2, projects: FOLDERS } })
    await expect(windows.browser.mutation(api.agents.start, { machineId: windows.machineId, project: 'p-one', app: 'claude-code' })).rejects.toThrow(
      /only on Linux and macOS/,
    )
    // What a machine offers is kept within bounds, whatever it says
    await machine.mutation(api.agents.offer, {
      offer: {
        most: 500,
        projects: [...FOLDERS, { id: '../not an id', name: 'x', where: 'y' }, { id: 'p-long', name: 'n'.repeat(500), where: 'w'.repeat(900) }],
      },
    })
    const [offered] = (await browser.query(api.agents.list, {})).machines
    expect(offered!.most).toBe(AGENTS.mostAllowed)
    expect(offered!.projects.map((p) => [p.id, p.name.length, p.where.length])).toEqual([
      ['p-one', 6, 13],
      ['p-two', 4, 11],
      ['p-long', 120, 300],
    ])
  })

  test('is the owner’s browser’s alone to start, message, stop and start again, and the machine’s to run', async () => {
    const { browser, tv, machine, machineId } = await withMachine()
    await machine.mutation(api.agents.offer, { offer: { most: 2, projects: FOLDERS } })
    await expect(tv.mutation(api.agents.start, { machineId, project: 'p-one', app: 'claude-code' })).rejects.toThrow(/Only a browser paired with `it site`/)
    await expect(tv.query(api.agents.list, {})).rejects.toThrow(/Only a browser paired with `it site`/)
    const { id } = await browser.mutation(api.agents.start, { machineId, project: 'p-one', app: 'claude-code', text: '  tidy the beds  ' })
    for (const call of [
      tv.mutation(api.agents.send, { agentId: id, text: 'hi' }),
      tv.mutation(api.agents.stop, { agentId: id }),
      tv.mutation(api.agents.restart, { agentId: id }),
      // A machine is no browser, and says how an agent stands without saying what is wanted of it
      machine.mutation(api.agents.send, { agentId: id, text: 'hi' }),
    ])
      await expect(call).rejects.toThrow(/Only a/)
    // The machine is told what to run, with what was sent first
    const { agents } = await machine.query(api.agents.mine, {})
    expect(agents).toMatchObject([{ id, project: 'p-one', app: 'claude-code', want: 'run', round: 1, state: 'starting', session: null }])
    expect(agents[0]!.messages.map((m) => m.text)).toEqual(['tidy the beds'])
  })

  test('says how it stands as its machine says, and what it was sent goes once the machine has handed it over', async () => {
    const { browser, machine, machineId } = await withMachine()
    await machine.mutation(api.agents.offer, { offer: { most: 2, projects: FOLDERS } })
    const { id } = await browser.mutation(api.agents.start, { machineId, project: 'p-one', app: 'claude-code', text: 'first' })
    await browser.mutation(api.agents.send, { agentId: id, text: 'second' })
    const session = '3f0c3c55-1d4b-4a8e-9b1a-2a8a1c1c0b11'
    expect(await machine.mutation(api.agents.report, { agentId: id, round: 1, state: 'working', session })).toEqual({ gone: false, want: 'run' })
    const [{ messages }] = (await machine.query(api.agents.mine, {})).agents as unknown as [{ messages: { id: Id<'agentMessages'>; text: string }[] }]
    await machine.mutation(api.agents.taken, { agentId: id, ids: messages.map((m) => m.id) })
    await machine.mutation(api.agents.report, { agentId: id, round: 1, state: 'ready', said: `Done. ${'x'.repeat(AGENTS.saidText)}` })
    const [shown] = (await browser.query(api.agents.list, {})).agents
    expect(shown).toMatchObject({ id, state: 'ready', session, waiting: 0, name: 'garden', where: '~/code/garden' })
    expect(shown!.said!.text.length).toBe(AGENTS.saidText)
    // What is not a state, or not a conversation's id, is refused
    await expect(machine.mutation(api.agents.report, { agentId: id, round: 1, state: 'dancing' })).rejects.toThrow(/not a state/)
    await expect(machine.mutation(api.agents.report, { agentId: id, round: 1, state: 'ready', session: '--resume' })).rejects.toThrow(/not a conversation/)
    // And a message too long, or empty, or one more than may wait
    await expect(browser.mutation(api.agents.send, { agentId: id, text: 'x'.repeat(AGENTS.messageText + 1) })).rejects.toThrow(/at most/)
    await expect(browser.mutation(api.agents.send, { agentId: id, text: '   ' })).rejects.toThrow(/Write something/)
  })

  test('stopped, drops what waited for it, takes nothing more, and when started again is a new round that earlier word does not touch', async () => {
    const { browser, machine, machineId } = await withMachine()
    await machine.mutation(api.agents.offer, { offer: { most: 2, projects: FOLDERS } })
    const { id } = await browser.mutation(api.agents.start, { machineId, project: 'p-one', app: 'claude-code', text: 'first' })
    await machine.mutation(api.agents.report, { agentId: id, round: 1, state: 'ready' })
    await browser.mutation(api.agents.stop, { agentId: id })
    expect((await machine.query(api.agents.mine, {})).agents).toMatchObject([{ want: 'stop', state: 'stopping', messages: [] }])
    await expect(browser.mutation(api.agents.send, { agentId: id, text: 'more' })).rejects.toThrow(/stopped/)
    await machine.mutation(api.agents.report, { agentId: id, round: 1, state: 'stopped' })
    await browser.mutation(api.agents.restart, { agentId: id })
    // What the machine says late of the round before is not about the agent as it is now
    expect(await machine.mutation(api.agents.report, { agentId: id, round: 1, state: 'failed', why: 'late' })).toMatchObject({ stale: true })
    expect((await machine.query(api.agents.mine, {})).agents).toMatchObject([{ want: 'run', round: 2, state: 'starting' }])
    // Removed only once it is stopped
    await expect(browser.mutation(api.agents.forget, { agentId: id })).rejects.toThrow(/Stop this agent/)
    await browser.mutation(api.agents.stop, { agentId: id })
    await browser.mutation(api.agents.forget, { agentId: id })
    expect((await browser.query(api.agents.list, {})).agents).toEqual([])
    expect(await machine.mutation(api.agents.report, { agentId: id, round: 2, state: 'stopped' })).toEqual({ gone: true })
  })

  test('runs no more on a machine than the machine said it would, and starting one again counts it once', async () => {
    const { browser, machine, machineId } = await withMachine()
    await machine.mutation(api.agents.offer, { offer: { most: 2, projects: FOLDERS } })
    const one = await browser.mutation(api.agents.start, { machineId, project: 'p-one', app: 'claude-code' })
    await browser.mutation(api.agents.start, { machineId, project: 'p-two', app: 'claude-code' })
    await expect(browser.mutation(api.agents.start, { machineId, project: 'p-one', app: 'claude-code' })).rejects.toThrow(/at most 2 agents/)
    // One that runs is started again in its own place
    await browser.mutation(api.agents.restart, { agentId: one.id })
    await browser.mutation(api.agents.stop, { agentId: one.id })
    await browser.mutation(api.agents.start, { machineId, project: 'p-one', app: 'claude-code' })
    await expect(browser.mutation(api.agents.restart, { agentId: one.id })).rejects.toThrow(/at most 2 agents/)
  })

  test('is stopped, with why, when its machine stops offering its folder or turns the experiment off', async () => {
    const { browser, machine, machineId } = await withMachine()
    await machine.mutation(api.agents.offer, { offer: { most: 2, projects: FOLDERS } })
    const one = await browser.mutation(api.agents.start, { machineId, project: 'p-one', app: 'claude-code', text: 'go' })
    const two = await browser.mutation(api.agents.start, { machineId, project: 'p-two', app: 'claude-code' })
    await machine.mutation(api.agents.offer, { offer: { most: 2, projects: [FOLDERS[1]!] } })
    const shown = async () => Object.fromEntries((await browser.query(api.agents.list, {})).agents.map((a) => [a.id, [a.want, a.state, a.why, a.waiting]]))
    expect(await shown()).toEqual({
      [one.id]: ['stop', 'stopped', 'laptop does not offer this folder any more.', 0],
      [two.id]: ['run', 'starting', null, 0],
    })
    await expect(browser.mutation(api.agents.restart, { agentId: one.id })).rejects.toThrow(/does not offer that folder/)
    await machine.mutation(api.agents.offer, { offer: null })
    expect((await shown())[two.id]).toEqual(['stop', 'stopped', 'Project agents were turned off on laptop.', 0])
    expect((await browser.query(api.agents.list, {})).machines).toEqual([])
  })

  test('is another person’s to see and touch not at all', async () => {
    const { t, browser, machine, machineId } = await withMachine()
    await machine.mutation(api.agents.offer, { offer: { most: 2, projects: FOLDERS } })
    const { id } = await browser.mutation(api.agents.start, { machineId, project: 'p-one', app: 'claude-code' })
    const other = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', { subject: 'someone-else', createdAt: Date.now() })
      const now = Date.now()
      const sid = await ctx.db.insert('sessions', { userId, secretHash: 'other', role: 'owner', createdAt: now, lastSeenAt: now, cookieAt: now })
      return { userId: userId as string, sid: sid as string }
    })
    const stranger = t.withIdentity({ issuer: SITE, subject: other.userId, kind: 'browser', sid: other.sid, role: 'owner' })
    expect(await stranger.query(api.agents.list, {})).toEqual({ machines: [], agents: [] })
    for (const call of [
      stranger.mutation(api.agents.send, { agentId: id, text: 'hi' }),
      stranger.mutation(api.agents.stop, { agentId: id }),
      stranger.mutation(api.agents.restart, { agentId: id }),
      stranger.mutation(api.agents.forget, { agentId: id }),
      stranger.mutation(api.agents.start, { machineId, project: 'p-one', app: 'claude-code' }),
    ])
      await expect(call).rejects.toThrow(/No such/)
  })

  test('goes with its machine when the machine is revoked, and with everything when everything is erased', async () => {
    vi.useFakeTimers()
    const { t, user, browser, machine, machineId } = await withMachine()
    await machine.mutation(api.agents.offer, { offer: { most: 2, projects: FOLDERS } })
    await browser.mutation(api.agents.start, { machineId, project: 'p-one', app: 'claude-code', text: 'go' })
    await browser.mutation(api.machines.revoke, { machineId })
    const left = () => t.run(async (ctx) => [(await ctx.db.query('agents').collect()).length, (await ctx.db.query('agentMessages').collect()).length])
    expect(await left()).toEqual([0, 0])
    // Erasing everything: a second machine with an agent of its own, and the person's record marked as erased
    const second = await t.mutation(internal.bridge.enroll, { subject: 'owner', name: 'desk', publicKey: { kty: 'EC', crv: 'P-256', x: `x${++keys}`, y: 'y' } })
    if ('error' in second) throw new Error(second.error)
    await t.run((ctx) => ctx.db.patch(second.machineId, { system: 'linux', wanted: ['claude-code'], harnesses: [{ id: 'claude-code', addon: 'connected' }] }))
    const desk = t.withIdentity({ issuer: SITE, subject: second.machineId, kind: 'machine' })
    await desk.mutation(api.agents.offer, { offer: { most: 2, projects: FOLDERS } })
    await browser.mutation(api.agents.start, { machineId: second.machineId, project: 'p-two', app: 'claude-code', text: 'go' })
    expect(await left()).toEqual([1, 1])
    await t.run((ctx) => ctx.db.patch(user as Id<'users'>, { deletedAt: Date.now() }))
    for (let i = 0; i < 20; i++) await t.mutation(internal.retention.purgeErased, {})
    expect(await left()).toEqual([0, 0])
  })
})
