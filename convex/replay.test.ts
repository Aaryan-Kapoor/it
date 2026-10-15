/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
const DAY = 86_400_000
beforeEach(() => {
  process.env.CONVEX_SITE_URL = SITE
  vi.useFakeTimers()
  vi.setSystemTime(Date.UTC(2026, 9, 15, 12))
})
afterEach(() => vi.useRealTimers())

async function fixture() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const now = Date.now()
    const user = await ctx.db.insert('users', { subject: 'owner', createdAt: now })
    const session = await ctx.db.insert('sessions', { userId: user, secretHash: 'test-only', role: 'owner', createdAt: now, lastSeenAt: now, cookieAt: now })
    const artifact = await ctx.db.insert('artifacts', {
      userId: user,
      slug: 'plan',
      title: 'Plan',
      currentVersion: 1,
      lastVersion: 1,
      bytes: 1,
      createdAt: now,
      updatedAt: now,
    })
    return { user, session, artifact }
  })
  const browser = t.withIdentity({ issuer: SITE, subject: ids.user, kind: 'browser', sid: ids.session })
  const input = {
    artifactId: ids.artifact,
    displayKey: 'test-display-key-00001',
    envelope: { v: 1, clientActionId: 'click-original', name: 'approve', payload: '{}', contentVersion: 1 },
  }
  return { t, browser, input, ...ids }
}

test('an expired server deadline cannot recreate a handled click after its receipt is removed', async () => {
  const { t, browser, input } = await fixture()
  const { until } = await browser.mutation(api.actions.replayGrant, {})
  const sent = { ...input, replayUntil: until }
  const first = await browser.mutation(api.actions.submit, sent)
  // A lost success response leaves the browser with exactly this request, whatever its clock says.
  expect(await browser.mutation(api.actions.submit, sent)).toEqual(first)
  await t.run((ctx) => ctx.db.patch(first.actionId, { delivery: 'handed_off', handedAt: Date.now() }))
  vi.setSystemTime(Date.now() + 8 * DAY)
  await t.mutation(internal.retention.sweepActions, {})
  expect(await t.run((ctx) => ctx.db.query('actions').collect())).toEqual([])
  await expect(browser.mutation(api.actions.submit, sent)).rejects.toThrow(/too old to retry safely/)
  // Old saved outboxes have no deadline. They cannot silently acquire a new replay horizon.
  await expect(browser.mutation(api.actions.submit, input)).rejects.toThrow(/Reload It before sending new requests/)
  expect(await t.run((ctx) => ctx.db.query('actions').collect())).toEqual([])
})

test('a legacy outbox can confirm an existing receipt without creating new work', async () => {
  const { t, browser, input } = await fixture()
  const { until } = await browser.mutation(api.actions.replayGrant, {})
  const first = await browser.mutation(api.actions.submit, { ...input, replayUntil: until })
  expect(await browser.mutation(api.actions.submit, input)).toEqual(first)
  expect(await t.run((ctx) => ctx.db.query('actions').collect())).toHaveLength(1)
})

test('replay deadlines are bounded, issued by the server and scoped to the current session', async () => {
  const { t, browser, session, input } = await fixture()
  for (let day = 0; day < 20; day++) {
    const first = await browser.mutation(api.actions.replayGrant, {})
    expect(await browser.mutation(api.actions.replayGrant, {})).toEqual(first)
    expect(first.until).toBeGreaterThan(Date.now())
    expect(first.until).toBeLessThanOrEqual(Date.now() + 7 * DAY)
    expect((await t.run((ctx) => ctx.db.get(session)))!.replayUntil!.length).toBeLessThanOrEqual(7)
    vi.setSystemTime(Date.now() + DAY)
  }
  await expect(browser.mutation(api.actions.submit, { ...input, replayUntil: Date.now() + 100 * DAY })).rejects.toThrow(/too old/)
  const { until } = await browser.mutation(api.actions.replayGrant, {})
  await t.run((ctx) => ctx.db.patch(session, { endedAt: Date.now() }))
  await expect(browser.mutation(api.actions.submit, { ...input, replayUntil: until })).rejects.toThrow(/not paired/)
})

test('a delayed Stop cannot stop a later run, even when both runs report the same start time', async () => {
  const { t, browser, artifact, user } = await fixture()
  const machine = await t.run(async (ctx) => {
    const id = await ctx.db.insert('machines', {
      userId: user,
      name: 'Test machine',
      revoked: false,
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      runs: [{ harness: 'codex', sessionId: 'conversation', since: Date.now(), run: 'original-run' }],
    })
    await ctx.db.patch(artifact, { machineId: id, session: { harness: 'codex', id: 'conversation' } })
    return id
  })
  await expect(browser.mutation(api.artifacts.stop, { artifactId: artifact })).rejects.toThrow(/Reload It before stopping/)
  const shown = await browser.query(api.artifacts.get, { artifactId: artifact })
  await t.run((ctx) => ctx.db.patch(machine, { runs: [{ harness: 'codex', sessionId: 'conversation', since: shown.run!.since, run: 'later-run' }] }))
  expect(await browser.mutation(api.artifacts.stop, { artifactId: artifact, expectedRun: shown.run!.identity })).toEqual({ stopping: false })
  const later = await browser.query(api.artifacts.get, { artifactId: artifact })
  expect(later.run?.stopping).toBe(false)
  expect(await browser.mutation(api.artifacts.stop, { artifactId: artifact, expectedRun: later.run!.identity })).toEqual({ stopping: true })
  const stoppedThrough = (await t.run((ctx) => ctx.db.get(artifact)))!.stoppedThrough
  vi.setSystemTime(Date.now() + 1000)
  expect(await browser.mutation(api.artifacts.stop, { artifactId: artifact, expectedRun: later.run!.identity })).toEqual({ stopping: true })
  expect((await t.run((ctx) => ctx.db.get(artifact)))!.stoppedThrough).toBe(stoppedThrough)
  await t.finishInProgressScheduledFunctions()
})

test('a fresh request from an older open site asks the person to reload without claiming it was accepted', async () => {
  const { browser, input, t } = await fixture()
  await expect(browser.mutation(api.actions.submit, input)).rejects.toThrow(/Reload It before sending new requests/)
  await expect(
    browser.mutation(api.actions.message, {
      artifactId: input.artifactId,
      displayKey: input.displayKey,
      clientActionId: 'typed-fresh-legacy',
      text: 'Please continue',
    }),
  ).rejects.toThrow(/Reload It before sending new requests/)
  expect(await t.run((ctx) => ctx.db.query('actions').collect())).toEqual([])
})

test('queued requests cannot run under a replacement pairing, even with the same owner and deadline', async () => {
  const { t, browser, input, session, user, artifact } = await fixture()
  const { until } = await browser.mutation(api.actions.replayGrant, {})
  const replacement = await t.run((ctx) =>
    ctx.db.insert('sessions', { userId: user, secretHash: 'replacement', role: 'owner', createdAt: Date.now(), lastSeenAt: Date.now(), cookieAt: Date.now() }),
  )
  const next = t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: replacement })
  expect(await next.mutation(api.actions.replayGrant, {})).toEqual({ until })
  const notification = await t.run((ctx) =>
    ctx.db.insert('notifications', { userId: user, artifactId: artifact, text: 'Approve?', sticky: true, createdAt: Date.now() }),
  )
  await expect(next.mutation(api.actions.submit, { ...input, replayUntil: until, expectedSession: session })).rejects.toThrow(/pairing that has ended/)
  await expect(
    next.mutation(api.actions.message, {
      artifactId: artifact,
      displayKey: input.displayKey,
      clientActionId: 'old-typed',
      text: 'Old request',
      replayUntil: until,
      expectedSession: session,
    }),
  ).rejects.toThrow(/pairing that has ended/)
  await expect(
    next.mutation(api.notifications.answer, { id: notification, action: 'approve', displayKey: input.displayKey, expectedSession: session }),
  ).rejects.toThrow(/pairing that has ended/)
  await expect(next.mutation(api.artifacts.stop, { artifactId: artifact, expectedRun: 'old-run', expectedSession: session })).rejects.toThrow(
    /pairing that has ended/,
  )
  expect(await t.run((ctx) => ctx.db.query('actions').collect())).toEqual([])
  expect((await t.run((ctx) => ctx.db.get(notification)))?.answeredAt).toBeUndefined()
})

test('an old site must reload before a new notification answer, but may confirm an accepted one', async () => {
  const { t, browser, user, artifact, session, input } = await fixture()
  await browser.mutation(api.displays.register, { key: input.displayKey, userAgent: 'Test browser' })
  const id = await t.run((ctx) =>
    ctx.db.insert('notifications', {
      userId: user,
      artifactId: artifact,
      text: 'Approve?',
      sticky: true,
      buttons: [{ label: 'Approve', action: 'approve' }],
      contentVersion: 1,
      stateRevision: 0,
      createdAt: Date.now(),
    }),
  )
  const answer = { id, action: 'approve', displayKey: input.displayKey }
  await expect(browser.mutation(api.notifications.answer, answer)).rejects.toThrow(/Reload It before answering/)
  expect(await t.run((ctx) => ctx.db.query('actions').collect())).toEqual([])
  expect((await browser.mutation(api.notifications.answer, { ...answer, expectedSession: session })).actionId).not.toBeNull()
  expect(await browser.mutation(api.notifications.answer, answer)).toEqual({ actionId: null })
  expect(await t.run((ctx) => ctx.db.query('actions').collect())).toHaveLength(1)
})
