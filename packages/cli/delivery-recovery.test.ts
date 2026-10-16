import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WAKE_BACK_MS } from '@it/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DeliveryRecovery, eraseDeliveryRecovery, WAITERS_MOST, type WaitCopy } from './src/delivery-recovery'
import * as files from './src/lib'
import { erasing } from './src/serve'

let folder: string
let stores: DeliveryRecovery[] = []
const previous = process.env.IT_HOME
const copy: WaitCopy = {
  key: 'codex:thread',
  click: {
    id: 'action',
    artifact: 'page',
    title: 'Private title',
    name: 'yes',
    payload: '{"private":true}',
    at: 1,
    attended: true,
    session: { harness: 'codex', id: 'thread' },
  },
}
beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), 'it-recovery-'))
  process.env.IT_HOME = folder
})
afterEach(async () => {
  for (const s of stores) await s.close()
  stores = []
  rmSync(folder, { recursive: true, force: true })
  if (previous === undefined) delete process.env.IT_HOME
  else process.env.IT_HOME = previous
})
const open = (say = vi.fn()) => {
  const store = new DeliveryRecovery(say)
  stores.push(store)
  return store
}

test('a failed durable receipt leaves the previous waiter and mark records readable', async () => {
  const store = open()
  await store.keepWaiters([copy.click], copy.key)
  await store.addMark(copy.key, { id: 'mark', texts: ['Private text'], at: 1 })
  await store.accept(['action'], { id: 'action' })
  const file = path.join(folder, 'delivery-recovery.json')
  const before = readFileSync(file, 'utf8')
  mkdirSync(`${file}.${process.pid}.tmp`)
  await expect(store.session(copy.key, undefined, true)).rejects.toThrow()
  expect(store.waiters.get('action')).toEqual(copy)
  expect(store.marks.get('codex:thread')?.[0]?.texts).toEqual(['Private text'])
  expect(readFileSync(file, 'utf8')).toBe(before)
  const again = open()
  expect(again.waiters.get('action')).toEqual(copy)
  expect(again.accepted.has('action')).toBe(true)
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
})

test.each(['{"version":1,', '{"version":9}', '{"version":1,"waiters":null}'])(
  'an unreadable recovery record is kept aside and delivery can start afresh: %s',
  async (text) => {
    const file = path.join(folder, 'delivery-recovery.json')
    writeFileSync(file, text)
    const say = vi.fn()
    const store = open(say)
    expect(store.waiters.size).toBe(0)
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe(text)
    expect(say).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Delivery continues'))
    await store.claim(['new'], copy.key)
    expect([...open(say).returning]).toEqual(['new'])
    expect(say).toHaveBeenCalledTimes(1)
    eraseDeliveryRecovery()
    expect(existsSync(`${file}.unreadable`)).toBe(false)
  },
)

test('the global waiter bound applies across conversations and restored copies make room for new ones', async () => {
  const store = open()
  for (let i = 0; i < WAITERS_MOST; i++) await store.keepWaiters([{ ...copy.click, id: `action-${i}` }], `codex:thread-${i}`)
  expect(store.waiterRoom('codex:other', new Map(), (key) => key)).toBe(0)
  await expect(store.keepWaiters([{ ...copy.click, id: 'too-many' }], 'codex:other')).rejects.toThrow('full')
  await store.close()
  const restored = open()
  expect(restored.waiterRoom('codex:other', new Map(), (key) => key)).toBe(200)
  await restored.keepWaiters([{ ...copy.click, id: 'new' }], 'codex:other')
  expect(restored.waiters.size).toBe(WAITERS_MOST)
  expect(restored.waiters.has('action-0')).toBe(false)
  expect(open().waiters.has('new')).toBe(true)
})

test('a failed expiry write preserves copies until a retry, without removing delivery receipts', async () => {
  const store = open()
  await store.keepWaiters([copy.click], copy.key)
  await store.claim(['action'], copy.key)
  await store.accept(['action'], { id: 'action' })
  await store.addMark(copy.key, { id: 'mark', texts: ['Private text'], at: 1 })
  await store.close()
  const restored = open()
  const temporary = `${restored.file}.${process.pid}.tmp`
  mkdirSync(temporary)
  await expect(restored.pruneWaiters(WAKE_BACK_MS + 1)).rejects.toThrow()
  expect(restored.waiters.get('action')).toEqual(copy)
  expect(open().waiters.get('action')).toEqual(copy)
  rmSync(temporary, { recursive: true })
  await restored.pruneWaiters(WAKE_BACK_MS + 1)
  const again = open()
  expect(again.waiters.size).toBe(0)
  expect([...again.accepted]).toEqual(['action'])
  expect([...again.returning]).toEqual(['action'])
  expect([...again.targets]).toEqual([['action', copy.key]])
  expect(again.marks.get(copy.key)).toEqual([{ id: 'mark', texts: ['Private text'], at: 1 }])
})

test('expiry uses the original click age across restarts and leaves copies made in this process alone', async () => {
  const store = open()
  await store.keepWaiters([copy.click], copy.key)
  await store.close()
  const restored = open()
  await restored.pruneWaiters(WAKE_BACK_MS)
  expect(restored.waiters.get('action')).toEqual(copy)
  await restored.close()
  const again = open()
  await again.keepWaiters([{ ...copy.click, id: 'live' }], copy.key)
  await again.pruneWaiters(WAKE_BACK_MS + 1)
  expect([...again.waiters.keys()]).toEqual(['live'])
  expect([...open().waiters.keys()]).toEqual(['live'])
})

test('the byte bound evicts the oldest restored copy without dropping acceptance, claims or marks', async () => {
  const store = open()
  // Insert the newer copy first, so insertion order cannot stand in for age.
  await store.keepWaiters(
    [
      { ...copy.click, id: 'newer', at: 2, payload: 'x'.repeat(4_000_000) },
      { ...copy.click, payload: 'x'.repeat(4_000_000) },
    ],
    copy.key,
  )
  await store.claim(['action'], copy.key)
  await store.accept(['action'], { id: 'action' })
  await store.addMark(copy.key, { id: 'mark', texts: ['Private text'], at: 1 })
  await store.close()
  const restored = open()
  await restored.keepWaiters([{ ...copy.click, id: 'live', payload: 'x'.repeat(8_000_000) }], 'codex:other')
  const again = open()
  expect([...again.waiters.keys()]).toEqual(['newer', 'live'])
  expect([...again.accepted]).toEqual(['action'])
  expect([...again.returning]).toEqual(['action'])
  expect([...again.targets]).toEqual([['action', copy.key]])
  expect(again.marks.get(copy.key)).toEqual([{ id: 'mark', texts: ['Private text'], at: 1 }])
  expect(statSync(again.file).size).toBeLessThanOrEqual(16_000_000)
})

test('service erasure clears the active copies and prevents any late write from recreating them', async () => {
  const store = open()
  await store.recover([], [], 'person')
  await store.keepWaiters([copy.click], copy.key)
  let stopped = false
  store.onErase = () => {
    stopped = true
  }
  const file = path.join(folder, 'delivery-recovery.json')
  writeFileSync(`${file}.12345.tmp`, readFileSync(file))
  erasing(() => {})('person')
  expect(stopped).toBe(true)
  expect(store.waiters.size).toBe(0)
  expect(existsSync(file)).toBe(false)
  expect(existsSync(`${file}.12345.tmp`)).toBe(false)
  await expect(store.keepWaiters([copy.click], copy.key)).rejects.toThrow()
  expect(existsSync(file)).toBe(false)
})

test('an old erasure cannot remove records for the person who enrolled afterwards', async () => {
  const store = open()
  await store.recover([], [], 'new-person')
  await store.keepWaiters([copy.click], copy.key)
  eraseDeliveryRecovery('old-person')
  expect(store.erased).toBe(false)
  expect(open().waiters.has('action')).toBe(true)
})

test('a newly enrolled machine never receives copies kept for a different identity', async () => {
  writeFileSync(path.join(folder, 'machine.json'), JSON.stringify({ id: 'old' }))
  const store = open()
  await store.keepWaiters([copy.click], copy.key)
  await store.close()
  writeFileSync(path.join(folder, 'machine.json'), JSON.stringify({ id: 'new' }))
  expect(open().waiters.size).toBe(0)
})

test('mark fallback routing survives a restart beside older marks without it', async () => {
  const store = open()
  const entries = [
    { id: 'old', texts: ['Old private text'], at: 1 },
    { id: 'codex', texts: ['Typed private text'], at: 2, fallback: { via: 'codex' as const, text: 'Read it with it action action' } },
    { id: 't3', texts: ['Typed private text'], at: 3, fallback: { via: 't3' as const, thread: 'thread', text: 'Typed private text' } },
  ]
  for (const entry of entries) await store.addMark('codex:thread', entry)
  await store.close()
  expect(open().marks.get('codex:thread')).toEqual(entries)
})

test('a malformed mark fallback is refused without changing the previous record', async () => {
  const store = open()
  await store.addMark('codex:thread', { id: 'old', texts: ['Private text'], at: 1 })
  const kept = readFileSync(store.file, 'utf8')
  const changed = JSON.parse(kept)
  changed.marks[0][1][0].fallback = { via: 't3', text: 'Private text' }
  writeFileSync(store.file, JSON.stringify(changed))
  expect(open().marks.size).toBe(0)
  expect(existsSync(`${store.file}.unreadable`)).toBe(true)
  expect(store.marks.get('codex:thread')?.[0]).toEqual({ id: 'old', texts: ['Private text'], at: 1 })
})

test('mark retry progress survives alongside records written before retries were persisted', async () => {
  const store = open()
  const entries = [
    { id: 'old', texts: ['Private text'], at: 1, fallback: { via: 'codex' as const, text: 'Short line' } },
    ...[1, 2, 3, 4].map((attempts) => ({
      id: `retry-${attempts}`,
      texts: ['Private text'],
      at: 1,
      fallback: { via: 'codex' as const, text: 'Short line' },
      retry: { attempts, nextAt: attempts === 4 ? null : 123_456 },
    })),
  ]
  for (const entry of entries) await store.addMark('codex:thread', entry)
  await store.close()
  expect(open().marks.get('codex:thread')).toEqual(entries)
})

test.each([
  null,
  { attempts: 0, nextAt: 123 },
  { attempts: -1, nextAt: 123 },
  { attempts: 1.5, nextAt: 123 },
  { attempts: 5, nextAt: null },
  { attempts: 1, nextAt: null },
  { attempts: 1, nextAt: '123' },
  { attempts: 1 },
  { attempts: 4, nextAt: 123 },
])('invalid mark retry progress is refused instead of starting a fresh retry sequence: %j', async (retry) => {
  const store = open()
  await store.addMark('codex:thread', { id: 'mark', texts: ['Private text'], at: 1, fallback: { via: 'codex', text: 'Short line' } })
  const changed = JSON.parse(readFileSync(store.file, 'utf8'))
  changed.marks[0][1][0].retry = retry
  writeFileSync(store.file, JSON.stringify(changed))
  expect(open().marks.size).toBe(0)
  expect(existsSync(`${store.file}.unreadable`)).toBe(true)
})

test('unchanged claims, releases, sessions, marks and waiter polls do not write the record again', async () => {
  const store = open()
  await store.keepWaiters([copy.click], copy.key)
  await store.claim(['action'], copy.key)
  await store.giveWaiters('waiter', 10, () => true)
  const before = readFileSync(store.file, 'utf8')
  // A real write now fails. Repeating known facts must still succeed, with the original
  // waiter receipt timestamp, rather than refreshing it on every poll.
  mkdirSync(`${store.file}.${process.pid}.tmp`)
  await store.claim(['action'], copy.key)
  await store.retire(['not-held'])
  await store.confirm('not-held', () => true)
  await store.removeMarks(copy.key, ['not-held'])
  await store.session(copy.key)
  await store.printed('someone-else', ['action'])
  await store.giveWaiters('waiter', 20, () => true)
  expect(store.waiters.get('action')?.given).toEqual({ who: 'waiter', at: 10 })
  expect(readFileSync(store.file, 'utf8')).toBe(before)
})

test('a known ended turn loses its live copies without removing its other receipts', async () => {
  const store = open()
  await store.keepWaiters([copy.click], copy.key)
  await store.claim(['action'], copy.key)
  await store.accept(['action'], { id: 'action' })
  await store.addMark(copy.key, { id: 'mark', texts: ['Private text'], at: 1 })
  await store.pruneWaiters(2, (key) => key === copy.key)
  const again = open()
  expect(again.waiters.size).toBe(0)
  expect([...again.returning]).toEqual(['action'])
  expect([...again.accepted]).toEqual(['action'])
  expect(again.marks.get(copy.key)).toHaveLength(1)
})

test('erasure during an asynchronous save cannot recreate the recovery record', async () => {
  const store = open()
  await store.recover([], [], 'person')
  const write = files.writePrivateAsync
  let resume = () => {}
  const blocked = new Promise<void>((resolve) => {
    resume = resolve
  })
  let began = () => {}
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  const saving = vi.spyOn(files, 'writePrivateAsync').mockImplementation(async (...args) => {
    began()
    await blocked
    await write(...args)
  })
  try {
    const pending = store.claim(['action'], copy.key)
    const rejected = expect(pending).rejects.toThrow()
    await started
    eraseDeliveryRecovery('person')
    resume()
    await rejected
    expect(existsSync(store.file)).toBe(false)
    expect(existsSync(`${store.file}.${process.pid}.tmp`)).toBe(false)
    expect(store.returning.size).toBe(0)
  } finally {
    resume()
    saving.mockRestore()
  }
})

test('a queued retirement cannot remove a newer claim saved while it was waiting', async () => {
  const store = open()
  await store.claim(['action'], 'codex:old')
  let attempt = 'old'
  const newer = store.claim(['action'], 'codex:new').then(() => {
    attempt = 'new'
  })
  const retire = store.retire(['action'], () => attempt === 'old')
  await Promise.all([newer, retire])
  expect(open().targets.get('action')).toBe('codex:new')
})

test('a mark that would exceed the byte bound falls back without replacing the existing record', async () => {
  const store = open()
  expect(await store.addMark(copy.key, { id: 'old', texts: ['x'.repeat(15_999_000)], at: 1 })).toBe(true)
  const before = readFileSync(store.file, 'utf8')
  expect(await store.addMark('codex:other', { id: 'new', texts: ['x'.repeat(2_000)], at: 2 })).toBe(false)
  expect(readFileSync(store.file, 'utf8')).toBe(before)
  expect(store.marks.has('codex:other')).toBe(false)
  await store.claim(['new'], 'codex:other')
  expect([...open().returning]).toEqual(['new'])
})

test('a recovered click that changes conversation replaces its earlier waiter copy', async () => {
  const store = open()
  await store.keepWaiters([copy.click], copy.key)
  await store.giveWaiters('earlier-waiter', 1, () => true)
  const moved = { ...copy.click, session: { harness: 'codex', id: 'new-thread' } }
  await store.keepWaiters([moved], 'codex:new-thread')
  expect(open().waiters.get('action')).toEqual({ click: moved, key: 'codex:new-thread' })
})
