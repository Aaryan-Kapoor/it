/// <reference types="vite/client" />
// The files sent with an action, as the backend takes them: what is recorded and declared before
// the click is sent, what is accepted with it, who may read one, and when they go. The content
// service is stood in for by a stub that records what the backend asked of it.
import { describeClick, LIMITS, QUOTA } from '@it/protocol'
import { ConvexError } from 'convex/values'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const SITE = 'https://backend.test'
const DOOR = 'http://127.0.0.1:39000'
const DAY = 86_400_000
const PHOTO = { name: 'IMG_2041.jpg', type: 'image/jpeg', size: 402_311, sha256: 'a'.repeat(64) }
const SHEET = { name: 'totals.csv', type: 'text/csv', size: 120, sha256: 'b'.repeat(64) }

/** Stands in for the content service. */
let content: { calls: { op: string; body: any; token: string }[]; holds: boolean; down: boolean; missing?: string[] }
beforeEach(() => {
  process.env.CONVEX_SITE_URL = SITE
  process.env.IT_PORT = '39000'
  vi.useFakeTimers()
  vi.setSystemTime(Date.UTC(2026, 9, 24, 12))
  content = { calls: [], holds: false, down: false }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const op = String(url).split('/control/')[1] ?? ''
      content.calls.push({ op, body: JSON.parse(String(init.body)), token: String((init.headers as Record<string, string>).authorization).slice(7) })
      if (content.down) return new Response(null, { status: 503 })
      if (op === 'verify') return new Response(JSON.stringify({ ok: content.holds, missing: content.holds ? [] : (content.missing ?? ['1']) }))
      if (op === 'delete') return new Response(JSON.stringify({ removed: 1, more: false }))
      return new Response(JSON.stringify({ ok: true }))
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, any>
function refusal(e: unknown): string {
  let data: unknown = e instanceof ConvexError ? e.data : undefined
  for (let i = 0; i < 3 && typeof data === 'string'; i++) data = JSON.parse(data)
  if (data && typeof data === 'object' && 'code' in data) return String((data as { code: unknown }).code)
  return /"code":"([a-z_]+)"/.exec(String((e as Error)?.message ?? e))?.[1] ?? `threw: ${String(e).slice(0, 120)}`
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => refusal(e),
  )

/** A person with a page, a browser paired as theirs and a machine of theirs; and another person with a machine. */
async function fixture() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const now = Date.now()
    const key = { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' }
    const user = await ctx.db.insert('users', { subject: 'owner', createdAt: now })
    const other = await ctx.db.insert('users', { subject: 'someone-else', createdAt: now })
    const session = await ctx.db.insert('sessions', { userId: user, secretHash: 'test-only', role: 'owner', createdAt: now, lastSeenAt: now, cookieAt: now })
    const page = { title: 'Bills', currentVersion: 1, lastVersion: 1, bytes: 1, createdAt: now, updatedAt: now }
    const artifact = await ctx.db.insert('artifacts', { userId: user, slug: 'bills', ...page })
    const another = await ctx.db.insert('artifacts', { userId: user, slug: 'floor', ...page })
    const laptop = await ctx.db.insert('machines', { userId: user, name: 'laptop', publicKey: key, revoked: false, createdAt: now, lastSeenAt: now })
    const theirs = await ctx.db.insert('machines', { userId: other, name: 'theirs', publicKey: key, revoked: false, createdAt: now, lastSeenAt: now })
    return { user, session, artifact, another, laptop, theirs }
  })
  const browser = t.withIdentity({ issuer: SITE, subject: ids.user, kind: 'browser', sid: ids.session })
  const machine = t.withIdentity({ issuer: SITE, subject: ids.laptop, kind: 'machine' })
  const stranger = t.withIdentity({ issuer: SITE, subject: ids.theirs, kind: 'machine' })
  /** What the site does for a click with files: a deadline, then the files taken, as often as it is asked. */
  const prepare = async (clientActionId: string, files = [PHOTO], over: Record<string, unknown> = {}) => {
    const { until } = await browser.mutation(api.actions.replayGrant, {})
    return browser.action(api.files.prepare, { artifactId: ids.artifact, clientActionId, files, replayUntil: until, ...over })
  }
  const submit = async (clientActionId: string, attachment?: Id<'attachments'>, payload = '{"photo":{"file":1}}') => {
    const { until } = await browser.mutation(api.actions.replayGrant, {})
    return browser.mutation(api.actions.submit, {
      artifactId: ids.artifact,
      displayKey: 'test-display-key-00001',
      replayUntil: until,
      ...(attachment ? { attachment } : {}),
      envelope: { v: 1, clientActionId, name: 'receipt', payload, contentVersion: 1 },
    })
  }
  /** Takes a click's files, has them arrive, and sends the click: what the site does from start to end. */
  const sent = async (clientActionId: string, files = [PHOTO]) => {
    const first = await prepare(clientActionId, files)
    content.holds = true
    await prepare(clientActionId, files)
    content.holds = false
    return { ...(await submit(clientActionId, first.id)), attachment: first.id }
  }
  return { t, browser, machine, stranger, prepare, submit, sent, ...ids }
}
const bytesHeld = async (t: ReturnType<typeof convexTest>) => (await t.run((ctx) => ctx.db.query('tallies').collect()))[0]?.fileBytes ?? 0

describe('the files of a click', () => {
  test('are recorded and declared before the click is sent, under a grant to upload exactly those bytes into a folder of their own', async () => {
    const { t, prepare, user, artifact } = await fixture()
    const r = await prepare('click-with-files', [PHOTO, SHEET])
    expect(r.stored).toBe(false)
    const prefix = `u/${user}/${artifact}/f${r.id}/`
    const staged = content.calls.filter((c) => c.op === 'stage')
    expect(staged.map((c) => c.body)).toEqual([
      {
        prefix,
        files: [
          { path: '1', size: PHOTO.size, sha256: PHOTO.sha256 },
          { path: '2', size: SHEET.size, sha256: SHEET.sha256 },
        ],
      },
    ])
    const grant = claimsOf(r.grant!)
    expect([grant.aud, grant.sub, grant.p]).toEqual(['it-upload', prefix, prefix])
    // Nothing is looked for yet: nothing can have arrived
    expect(content.calls.some((c) => c.op === 'verify')).toBe(false)
    const [kept] = await t.run((ctx) => ctx.db.query('attachments').collect())
    expect(kept).toMatchObject({ clientActionId: 'click-with-files', files: [PHOTO, SHEET], bytes: PHOTO.size + SHEET.size, stored: false })
    expect(kept!.actionId).toBeUndefined()
    // And they count against what the person may hold from the moment they are recorded
    expect(await bytesHeld(t)).toBe(PHOTO.size + SHEET.size)
  })

  test('make the click wait until every one of them has arrived whole, and go with it once it is accepted, once', async () => {
    const { t, prepare, submit } = await fixture()
    const first = await prepare('click-one')
    // Sent before its files are there: refused in a way that says to send it again, and nothing is kept
    expect(await code(submit('click-one', first.id))).toBe('unavailable')
    expect(await t.run((ctx) => ctx.db.query('actions').collect())).toEqual([])
    // Asked again, the files are looked for, and are not there yet: a fresh grant, and the same record
    const again = await prepare('click-one')
    expect([again.id, again.stored, typeof again.grant]).toEqual([first.id, false, 'string'])
    expect(content.calls.filter((c) => c.op === 'verify')).toHaveLength(1)
    // They arrive, and the next asking finds them
    content.holds = true
    expect(await prepare('click-one')).toEqual({ id: first.id, stored: true })
    content.holds = false
    const { actionId } = await submit('click-one', first.id)
    const action = await t.run((ctx) => ctx.db.get(actionId))
    expect(action).toMatchObject({ attachment: first.id, files: [PHOTO] })
    expect((await t.run((ctx) => ctx.db.get(first.id)))!.actionId).toBe(actionId)
    // The same click sent again, as after a lost answer, is the same click, with the same files
    expect((await submit('click-one', first.id)).actionId).toBe(actionId)
    expect(await prepare('click-one')).toEqual({ id: first.id, stored: true })
    expect(await t.run((ctx) => ctx.db.query('actions').collect())).toHaveLength(1)
    expect(await t.run((ctx) => ctx.db.query('attachments').collect())).toHaveLength(1)
  })

  test('are each asked for again only where they have not arrived, so that a file that came before a connection dropped is not sent twice', async () => {
    const { prepare } = await fixture()
    expect((await prepare('click-partly', [PHOTO, SHEET])).missing).toEqual([1, 2])
    content.missing = ['2']
    expect(await prepare('click-partly', [PHOTO, SHEET])).toMatchObject({ stored: false, missing: [2] })
    // What the content service says is there and was never declared is no file of these: every one is asked for again
    content.missing = ['(not declared) a file declared earlier']
    expect(await prepare('click-partly', [PHOTO, SHEET])).toMatchObject({ stored: false, missing: [1, 2] })
  })

  test('are listed with the action, and the list is counted in what one action may carry', async () => {
    const { t, prepare, submit } = await fixture()
    const r = await prepare('click-full-data')
    content.holds = true
    await prepare('click-full-data')
    const almost = JSON.stringify({ note: 'x'.repeat(LIMITS.actionPayloadBytes - 20) })
    expect(await code(submit('click-full-data', r.id, almost))).toBe('limit')
    expect(await t.run((ctx) => ctx.db.query('actions').collect())).toEqual([])
    // With room for the list beside it, the same click is taken
    expect(await code(submit('click-full-data', r.id, JSON.stringify({ note: 'x'.repeat(LIMITS.actionPayloadBytes - 400) })))).toBe('ok')
  })

  test('are one set for one click: other files under the same click, or files after it was sent without them, are refused', async () => {
    const { prepare, submit } = await fixture()
    await prepare('click-two')
    expect(await code(prepare('click-two', [SHEET]))).toBe('conflict')
    expect(await code(prepare('click-two', [PHOTO, SHEET]))).toBe('conflict')
    await submit('click-plain', undefined, '{}')
    expect(await code(prepare('click-plain'))).toBe('conflict')
  })

  test('are held to what one action may carry, before anything is asked of the content service', async () => {
    const { prepare } = await fixture()
    const many = Array.from({ length: LIMITS.actionFiles + 1 }, () => SHEET)
    const large = { ...PHOTO, size: LIMITS.actionFileBytes + 1 }
    const together = Array.from({ length: 3 }, () => ({ ...PHOTO, size: LIMITS.actionFileBytes }))
    expect({
      many: await code(prepare('click-many', many)),
      large: await code(prepare('click-large', [large])),
      together: await code(prepare('click-together', together)),
      none: await code(prepare('click-none', [])),
      notAChecksum: await code(prepare('click-sum', [{ ...PHOTO, sha256: 'nope' }])),
      notASize: await code(prepare('click-size', [{ ...PHOTO, size: 1.5 }])),
    }).toEqual({ many: 'limit', large: 'limit', together: 'limit', none: 'invalid', notAChecksum: 'invalid', notASize: 'invalid' })
    expect(content.calls).toEqual([])
  })

  test('keep the name the page gave as a name and nothing more, and a kind as a kind', async () => {
    const { t, prepare } = await fixture()
    await prepare('click-names', [
      { ...PHOTO, name: '../../etc/pass\nwd .jpg', type: 'Image/JPEG' },
      { ...SHEET, name: '', type: 'not a type' },
    ])
    const [kept] = await t.run((ctx) => ctx.db.query('attachments').collect())
    expect(kept!.files.map((f) => [f.name, f.type])).toEqual([
      ['passwd.jpg', 'image/jpeg'],
      ['file', 'application/octet-stream'],
    ])
  })

  test('are not taken by another click, another page, or a click sent with files of its own that are not all there', async () => {
    const { t, browser, prepare, submit, another } = await fixture()
    const theirs = await prepare('click-ours')
    content.holds = true
    await prepare('click-ours')
    expect(await code(submit('click-other', theirs.id))).toBe('invalid')
    const { until } = await browser.mutation(api.actions.replayGrant, {})
    const onAnotherPage = browser.mutation(api.actions.submit, {
      artifactId: another,
      displayKey: 'test-display-key-00001',
      replayUntil: until,
      attachment: theirs.id,
      envelope: { v: 1, clientActionId: 'click-ours', name: 'receipt', payload: '{}', contentVersion: 1 },
    })
    expect(await code(onAnotherPage)).toBe('invalid')
    expect(await t.run((ctx) => ctx.db.query('actions').collect())).toEqual([])
  })

  test('need a saved click’s deadline, as its action does, and a browser of the person’s', async () => {
    const { browser, machine, artifact } = await fixture()
    expect(await code(browser.action(api.files.prepare, { artifactId: artifact, clientActionId: 'click-old', files: [PHOTO] }))).toBe('conflict')
    expect(
      await code(machine.action(api.files.prepare, { artifactId: artifact, clientActionId: 'click-m', files: [PHOTO], replayUntil: Date.now() + DAY })),
    ).toBe('forbidden')
  })

  test('are refused past what It holds for the person, which says so, and writes it down', async () => {
    const { t, prepare, user } = await fixture()
    await t.run((ctx) => ctx.db.insert('tallies', { userId: user, waiting: 0, stagingCount: 0, stagingBytes: 0, fileBytes: QUOTA.actionFileBytes - 1000 }))
    const refused = await prepare('click-full').then(
      () => '',
      (e) => String(e),
    )
    expect(refused).toMatch(/already holds 1 GB of files sent from pages/)
    expect(await t.run((ctx) => ctx.db.query('attachments').collect())).toEqual([])
  })

  test('are tried again later where the content service cannot be reached, and nothing is lost meanwhile', async () => {
    const { t, prepare } = await fixture()
    content.down = true
    expect(await code(prepare('click-down'))).toBe('unavailable')
    content.down = false
    const r = await prepare('click-down')
    expect(r.stored).toBe(false)
    expect(await t.run((ctx) => ctx.db.query('attachments').collect())).toHaveLength(1)
  })
})

describe('reading a file an action carried', () => {
  test('is for a machine of the person’s, with a grant for that action’s folder, and what the file is', async () => {
    const { machine, sent, user, artifact } = await fixture()
    const { actionId, attachment } = await sent('click-read', [PHOTO, SHEET])
    const prefix = `u/${user}/${artifact}/f${attachment}/`
    const first = await machine.action(api.files.read, { id: actionId })
    expect(first).toMatchObject({ url: `${DOOR}/download/1`, number: 1, name: PHOTO.name, type: PHOTO.type, bytes: PHOTO.size, sha256: PHOTO.sha256 })
    const grant = claimsOf(first.grant)
    expect([grant.aud, grant.sub, grant.p]).toEqual(['it-download', prefix, prefix])
    expect(grant.exp - grant.iat).toBeLessThanOrEqual(120)
    expect(await machine.action(api.files.read, { id: actionId, number: 2 })).toMatchObject({ url: `${DOOR}/download/2`, name: SHEET.name })
    expect(await code(machine.action(api.files.read, { id: actionId, number: 3 }))).toBe('not_found')
    expect(await code(machine.action(api.files.read, { id: actionId, number: 0 }))).toBe('not_found')
  })

  test('is not for a browser, another person’s machine, or an action that carried none', async () => {
    const { browser, machine, stranger, sent, submit } = await fixture()
    const { actionId } = await sent('click-guarded')
    const { actionId: plain } = await submit('click-plain', undefined, '{}')
    expect({
      browser: await code(browser.action(api.files.read, { id: actionId })),
      stranger: await code(stranger.action(api.files.read, { id: actionId })),
      plain: await code(machine.action(api.files.read, { id: plain })),
      nonsense: await code(machine.action(api.files.read, { id: 'not-an-action' })),
    }).toEqual({ browser: 'forbidden', stranger: 'not_found', plain: 'not_found', nonsense: 'not_found' })
  })

  test('is told to the agent with the action, by name, kind and size, and how to save it', async () => {
    const { machine, sent } = await fixture()
    const { actionId } = await sent('click-told', [PHOTO, SHEET])
    const got = await machine.query(api.delivery.get, { id: actionId })
    expect(got.files).toEqual([
      { name: PHOTO.name, type: PHOTO.type, bytes: PHOTO.size },
      { name: SHEET.name, type: SHEET.type, bytes: SHEET.size },
    ])
    const text = describeClick({ ...got, payload: JSON.parse(got.payload), attended: true })
    expect(text).toContain(
      `It carries 2 files beside that: 1. "IMG_2041.jpg" (image/jpeg, 393 KB); 2. "totals.csv" (text/csv, 120 bytes). \`it action ${actionId} --save <file> --number <n>\` writes one of them to a file you can open.`,
    )
  })
})

describe('when the files of an action go', () => {
  test('with their action, a week after it was handed over: their record, what they counted, and their bytes', async () => {
    const { t, sent, user, artifact } = await fixture()
    const { actionId, attachment } = await sent('click-old')
    await t.run((ctx) => ctx.db.patch(actionId, { delivery: 'handed_off', handedAt: Date.now() }))
    vi.setSystemTime(Date.now() + 6 * DAY)
    await t.mutation(internal.retention.sweepActions, {})
    expect(await t.run((ctx) => ctx.db.query('attachments').collect())).toHaveLength(1)
    vi.setSystemTime(Date.now() + 2 * DAY)
    await t.mutation(internal.retention.sweepActions, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await t.run((ctx) => ctx.db.query('actions').collect())).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('attachments').collect())).toEqual([])
    expect(await bytesHeld(t)).toBe(0)
    expect(content.calls.filter((c) => c.op === 'delete').map((c) => c.body)).toEqual([{ prefix: `u/${user}/${artifact}/f${attachment}/` }])
  })

  test('with a click that was never sent, once no browser could still send it', async () => {
    const { t, prepare, user, artifact } = await fixture()
    const r = await prepare('click-abandoned')
    vi.setSystemTime(Date.now() + 7 * DAY)
    expect(await t.mutation(internal.files.sweepUnattached, {})).toBe(0)
    vi.setSystemTime(Date.now() + 2 * DAY)
    expect(await t.mutation(internal.files.sweepUnattached, {})).toBe(1)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await t.run((ctx) => ctx.db.query('attachments').collect())).toEqual([])
    expect(await bytesHeld(t)).toBe(0)
    expect(content.calls.filter((c) => c.op === 'delete').map((c) => c.body)).toEqual([{ prefix: `u/${user}/${artifact}/f${r.id}/` }])
  })

  test('with their page, whose folder takes their bytes with it', async () => {
    const { t, sent, prepare, user, artifact } = await fixture()
    await sent('click-on-page')
    await prepare('click-unsent')
    await t.mutation(internal.retention.purgeArtifact, { artifactId: artifact })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await t.run((ctx) => ctx.db.query('attachments').collect())).toEqual([])
    expect(await bytesHeld(t)).toBe(0)
    // No folder of a single action's is asked for: the page's is, by whatever deletes the page
    expect(content.calls.filter((c) => c.op === 'delete').map((c) => c.body.prefix)).not.toContainEqual(
      expect.stringMatching(new RegExp(`^u/${user}/${artifact}/f`)),
    )
  })

  test('are in the records the person downloads by their names and checksums, and the files themselves are not', async () => {
    const { t, sent, artifact, session, user } = await fixture()
    await sent('click-exported', [PHOTO])
    const owner = t.withIdentity({ issuer: SITE, subject: user, kind: 'browser', sid: session, role: 'owner' })
    const { actions } = await owner.query(api.account.exportActions, { artifactId: artifact, cursor: null })
    expect(actions[0].files).toEqual([{ name: PHOTO.name, type: PHOTO.type, size: PHOTO.size, sha256: PHOTO.sha256 }])
  })
})
