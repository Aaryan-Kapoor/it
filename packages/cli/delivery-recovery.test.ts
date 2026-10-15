import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

test('the record refuses more copies than it can retain and preserves the previous copy', () => {
  const store = open()
  store.change(() => store.waiters.set('action', copy))
  expect(() =>
    store.change(() => {
      for (let i = 0; i < 201; i++) store.waiters.set(`action-${i}`, { ...copy, click: { ...copy.click, id: `action-${i}` } })
    }),
  ).toThrow()
  expect([...store.waiters.keys()]).toEqual(['action'])
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
