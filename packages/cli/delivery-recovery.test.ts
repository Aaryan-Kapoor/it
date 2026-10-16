import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WAKE_BACK_MS } from '@it/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DeliveryRecovery, eraseDeliveryRecovery, type WaitCopy } from './src/delivery-recovery'
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
afterEach(() => {
  for (const s of stores) s.close()
  stores = []
  rmSync(folder, { recursive: true, force: true })
  if (previous === undefined) delete process.env.IT_HOME
  else process.env.IT_HOME = previous
})
const open = () => {
  const store = new DeliveryRecovery()
  stores.push(store)
  return store
}

test('a failed durable receipt leaves the previous waiter and mark records readable', () => {
  const store = open()
  store.change(() => {
    store.waiters.set('action', copy)
    store.marks.set('codex:thread', [{ id: 'mark', texts: ['Private text'], at: 1 }])
    store.accepted.add('action')
  })
  const file = path.join(folder, 'delivery-recovery.json')
  const before = readFileSync(file, 'utf8')
  mkdirSync(`${file}.${process.pid}.tmp`)
  expect(() =>
    store.change(() => {
      store.waiters.delete('action')
      store.marks.clear()
    }),
  ).toThrow()
  expect(store.waiters.get('action')).toEqual(copy)
  expect(store.marks.get('codex:thread')?.[0]?.texts).toEqual(['Private text'])
  expect(readFileSync(file, 'utf8')).toBe(before)
  const again = open()
  expect(again.waiters.get('action')).toEqual(copy)
  expect(again.accepted.has('action')).toBe(true)
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('a corrupt recovery record stops delivery instead of becoming an empty record', () => {
  writeFileSync(path.join(folder, 'delivery-recovery.json'), '{"version":1,')
  expect(open).toThrow(expect.objectContaining({ code: 'record_unread' }))
})

test('the record keeps copies for different conversations beyond the per-conversation limit', () => {
  const store = open()
  store.change(() => {
    for (let i = 0; i < 201; i++) store.waiters.set(`action-${i}`, { ...copy, key: `codex:thread-${i}`, click: { ...copy.click, id: `action-${i}` } })
  })
  expect(open().waiters.size).toBe(201)
})

test('a failed expiry write preserves copies until a retry, without removing delivery receipts', () => {
  const store = open()
  store.change(() => {
    store.waiters.set('action', copy)
    store.accepted.add('action')
    store.returning.add('action')
    store.targets.set('action', copy.key)
    store.marks.set(copy.key, [{ id: 'mark', texts: ['Private text'], at: 1 }])
  })
  store.close()
  const restored = open()
  const temporary = `${restored.file}.${process.pid}.tmp`
  mkdirSync(temporary)
  expect(() => restored.pruneWaiters(WAKE_BACK_MS + 1)).toThrow()
  expect(restored.waiters.get('action')).toEqual(copy)
  expect(open().waiters.get('action')).toEqual(copy)
  rmSync(temporary, { recursive: true })
  restored.pruneWaiters(WAKE_BACK_MS + 1)
  const again = open()
  expect(again.waiters.size).toBe(0)
  expect([...again.accepted]).toEqual(['action'])
  expect([...again.returning]).toEqual(['action'])
  expect([...again.targets]).toEqual([['action', copy.key]])
  expect(again.marks.get(copy.key)).toEqual([{ id: 'mark', texts: ['Private text'], at: 1 }])
})

test('expiry uses the original click age across restarts and leaves copies made in this process alone', () => {
  const store = open()
  store.change(() => store.waiters.set('action', copy))
  store.close()
  const restored = open()
  restored.pruneWaiters(WAKE_BACK_MS)
  expect(restored.waiters.get('action')).toEqual(copy)
  restored.close()
  const again = open()
  again.change(() => again.waiters.set('live', { ...copy, click: { ...copy.click, id: 'live' } }))
  again.pruneWaiters(WAKE_BACK_MS + 1)
  expect([...again.waiters.keys()]).toEqual(['live'])
  expect([...open().waiters.keys()]).toEqual(['live'])
})

test('the byte bound evicts the oldest restored copy without dropping acceptance, claims or marks', () => {
  const store = open()
  // Insert the newer copy first, so insertion order cannot stand in for age.
  store.change(() => {
    store.waiters.set('newer', { ...copy, click: { ...copy.click, id: 'newer', at: 2, payload: 'x'.repeat(4_000_000) } })
    store.waiters.set('action', { ...copy, click: { ...copy.click, payload: 'x'.repeat(4_000_000) } })
    store.accepted.add('action')
    store.returning.add('action')
    store.targets.set('action', copy.key)
    store.marks.set(copy.key, [{ id: 'mark', texts: ['Private text'], at: 1 }])
  })
  store.close()
  const restored = open()
  restored.change(() => restored.waiters.set('live', { ...copy, key: 'codex:other', click: { ...copy.click, id: 'live', payload: 'x'.repeat(8_000_000) } }))
  const again = open()
  expect([...again.waiters.keys()]).toEqual(['newer', 'live'])
  expect([...again.accepted]).toEqual(['action'])
  expect([...again.returning]).toEqual(['action'])
  expect([...again.targets]).toEqual([['action', copy.key]])
  expect(again.marks.get(copy.key)).toEqual([{ id: 'mark', texts: ['Private text'], at: 1 }])
  expect(statSync(again.file).size).toBeLessThanOrEqual(16_000_000)
})

test('service erasure clears the active copies and prevents any late write from recreating them', () => {
  const store = open()
  store.change(() => {
    store.person = 'person'
    store.waiters.set('action', copy)
  })
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
  expect(() => store.change(() => store.waiters.set('action', copy))).toThrow()
  expect(existsSync(file)).toBe(false)
})

test('an old erasure cannot remove records for the person who enrolled afterwards', () => {
  const store = open()
  store.change(() => {
    store.person = 'new-person'
    store.waiters.set('action', copy)
  })
  eraseDeliveryRecovery('old-person')
  expect(store.erased).toBe(false)
  expect(open().waiters.has('action')).toBe(true)
})

test('a newly enrolled machine never receives copies kept for a different identity', () => {
  writeFileSync(path.join(folder, 'machine.json'), JSON.stringify({ id: 'old' }))
  const store = open()
  store.change(() => store.waiters.set('action', copy))
  store.close()
  writeFileSync(path.join(folder, 'machine.json'), JSON.stringify({ id: 'new' }))
  expect(open().waiters.size).toBe(0)
})

test('mark fallback routing survives a restart beside older marks without it', () => {
  const store = open()
  const entries = [
    { id: 'old', texts: ['Old private text'], at: 1 },
    { id: 'codex', texts: ['Typed private text'], at: 2, fallback: { via: 'codex' as const, text: 'Read it with it action action' } },
    { id: 't3', texts: ['Typed private text'], at: 3, fallback: { via: 't3' as const, thread: 'thread', text: 'Typed private text' } },
  ]
  store.change(() => store.marks.set('codex:thread', entries))
  store.close()
  expect(open().marks.get('codex:thread')).toEqual(entries)
})

test('a malformed mark fallback is refused without changing the previous record', () => {
  const store = open()
  store.change(() => store.marks.set('codex:thread', [{ id: 'old', texts: ['Private text'], at: 1 }]))
  const kept = readFileSync(store.file, 'utf8')
  const changed = JSON.parse(kept)
  changed.marks[0][1][0].fallback = { via: 't3', text: 'Private text' }
  writeFileSync(store.file, JSON.stringify(changed))
  expect(open).toThrow(expect.objectContaining({ code: 'record_unread' }))
  expect(store.marks.get('codex:thread')?.[0]).toEqual({ id: 'old', texts: ['Private text'], at: 1 })
})

test('mark retry progress survives alongside records written before retries were persisted', () => {
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
  store.change(() => store.marks.set('codex:thread', entries))
  store.close()
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
])('invalid mark retry progress is refused instead of starting a fresh retry sequence: %j', (retry) => {
  const store = open()
  store.change(() => store.marks.set('codex:thread', [{ id: 'mark', texts: ['Private text'], at: 1, fallback: { via: 'codex', text: 'Short line' } }]))
  const changed = JSON.parse(readFileSync(store.file, 'utf8'))
  changed.marks[0][1][0].retry = retry
  writeFileSync(store.file, JSON.stringify(changed))
  expect(open).toThrow(expect.objectContaining({ code: 'record_unread' }))
})
