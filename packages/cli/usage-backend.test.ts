/// <reference types="vite/client" />
// The backend's actual notes, service collector and sender together. The backend is in
// memory, settings have a temporary home, and sends are captured without using the network.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { internal } from '../../convex/_generated/api'
import { counted } from '../../convex/lib/counted'
import schema from '../../convex/schema'
import { taker } from './src/serve/index'

const modules = import.meta.glob('../../convex/**/*.ts')
type Usage = typeof import('./src/usage')
let usage: Usage
let home: string
let sender: ReturnType<Usage['startSender']> | undefined

beforeEach(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'it-usage-backend-'))
  vi.stubEnv('IT_HOME', home)
  vi.stubEnv('IT_TELEMETRY_ENABLED', '')
  vi.stubEnv('DO_NOT_TRACK', '')
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.resetModules()
  usage = await import('./src/usage')
  usage.begin()
})

afterEach(() => {
  sender?.stop()
  sender = undefined
  vi.useRealTimers()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

test.each([0, -300_000].flatMap((clockChange) => ['stopped', 'between collections', 'during a reply'].map((when) => ({ clockChange, when }))))(
  'a reporting reset $when discards backend notes with a clock change of $clockChange milliseconds',
  async ({ clockChange, when }) => {
    const t = convexTest(schema, modules)
    const report = (usage: boolean) => t.mutation(internal.network.report, { on: false, wanted: false, addresses: [], usage })
    const identity = () => (usage.counting() ? JSON.parse(readFileSync(path.join(home, 'telemetry.json'), 'utf8')).installation : undefined)
    const note = (by: 'person' | 'agent') => t.run((ctx) => counted(ctx, 'page.shown', { screen: 'computer', by }))
    const posts: string[] = []
    let now = 0
    sender = usage.startSender({ everyMs: 0, now: () => now, post: async (_url, body) => posts.push(body) > 0 })
    let pauseReply = false
    let reached!: () => void
    let release!: () => void
    const waiting = new Promise<void>((resolve) => (reached = resolve))
    const released = new Promise<void>((resolve) => (release = resolve))
    const collect = () =>
      taker(
        async (keep) => {
          const reply = await t.mutation(internal.counted.take, { keep })
          if (pauseReply) {
            pauseReply = false
            reached()
            await released
          }
          return reply
        },
        identity,
        (note) => usage.recordNoted(note.name, note.properties),
      )
    let take = collect()
    await report(true)
    await take(true)
    const firstId = identity()
    await note('person')
    let pending: Promise<void> | undefined
    if (when === 'during a reply') {
      pauseReply = true
      pending = take(true)
      await waiting
    }
    // More than one collection and one purge step can remove. The purge stays pending
    // until the assertions below, so collector results cannot rely on background deletion.
    await t.run(async (ctx) => {
      for (let i = 0; i < 2400; i++) await counted(ctx, 'page.shown', { screen: 'computer', by: 'person' })
    })
    usage.set(false)
    vi.setSystemTime(Date.now() + clockChange)
    // While stopped or between collections the backend can miss the whole off/on change.
    if (when === 'during a reply') await report(false)
    usage.set(true)
    await report(true)
    expect(identity()).not.toBe(firstId)
    if (when === 'stopped') take = collect()
    await sender.tick()
    release()
    await pending
    for (let i = 0; i < 4; i++) await take(true)
    expect(await t.run((ctx) => ctx.db.query('counted').collect())).toEqual([])
    await sender.tick()
    now += 31_000
    await sender.tick()
    expect(posts).toEqual([])

    await note('agent')
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    await take(true)
    await sender.tick()
    now += 31_000
    await sender.tick()
    expect(posts).toHaveLength(1)
    const sent = JSON.parse(posts[0]!)
    expect(sent.installation).toBe(createHash('sha256').update(`it-usage:${identity()}`).digest('hex'))
    expect(sent.events).toEqual([{ id: expect.any(String), name: 'page.shown', at: expect.any(String), properties: { screen: 'computer', by: 'agent' } }])
    expect(Object.keys(sent).sort()).toEqual(['events', 'installation', 'v'])
    expect(sent.v).toBe(1)
  },
)
