import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DeliveryReceipts, RECEIPTS_MOST, type ReceiptRecord } from './src/delivery-receipts'

let folder: string
let file: string
const receipt = { token: 'private-claim', session: { harness: 'pi', id: 'private-conversation-identity' } }
const accepted: ReceiptRecord = { id: 'click-1', receipt, route: 'addon' }
beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), 'it-receipts-'))
  file = path.join(folder, 'delivery-receipts.json')
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

test('only accepted receipts survive startup, with their route and exact attempt identity', () => {
  const records = new DeliveryReceipts(file)
  records.reserve([accepted, { ...accepted, id: 'not-sent' }])
  records.accept([accepted])
  const restarted = new DeliveryReceipts(file)
  restarted.discardReservations()
  expect(restarted.confirmations()).toEqual([accepted])
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([accepted])
  expect(readdirSync(folder)).toEqual(['delivery-receipts.json'])
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  restarted.forget(accepted.id, { ...receipt, token: 'older-claim' })
  expect(restarted.confirmations()).toEqual([accepted])
  restarted.forget(accepted.id, receipt)
  expect(new DeliveryReceipts(file).confirmations()).toEqual([])
})

test('full records refuse another delivery without evicting unresolved receipts', () => {
  const rows = Array.from({ length: RECEIPTS_MOST }, (_, i) => ({ ...accepted, id: `click-${i}` }))
  const records = new DeliveryReceipts(file)
  records.accept(rows)
  const before = readFileSync(file, 'utf8')
  expect(() => records.reserve([{ ...accepted, id: 'one-too-many' }])).toThrow(/full/)
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(statSync(file).size).toBeLessThan(1_000_000)
  records.forget('click-0', receipt)
  records.reserve([{ ...accepted, id: 'one-too-many' }])
  expect(new DeliveryReceipts(file).confirmations()).toHaveLength(RECEIPTS_MOST - 1)
})

test('a failed atomic write preserves both the previous disk record and the in-memory record', () => {
  const records = new DeliveryReceipts(file)
  records.accept([accepted])
  const before = readFileSync(file, 'utf8')
  const temporary = `${file}.${process.pid}.tmp`
  mkdirSync(temporary)
  expect(() => records.forget(accepted.id, receipt)).toThrow()
  expect(records.confirmations()).toEqual([accepted])
  expect(readFileSync(file, 'utf8')).toBe(before)
  rmSync(temporary, { recursive: true })
  records.forget(accepted.id, receipt)
  expect(new DeliveryReceipts(file).confirmations()).toEqual([])
})

test('a journal upgrade saves pending receipts privately and leaves only diagnostic fields', () => {
  const journal = path.join(folder, 'journal.jsonl')
  writeFileSync(
    journal,
    [
      JSON.stringify({ t: 1, event: 'queued', id: 'click-1', receipt }),
      '{"event":"queued","receipt":',
      JSON.stringify({ t: 2, event: 'acked', id: 'click-2', receipt }),
      JSON.stringify({ t: 3, event: 'confirmed', id: 'click-1' }),
    ].join('\n'),
  )
  const records = new DeliveryReceipts(file)
  records.importJournal(journal)
  expect(records.confirmations()).toEqual([{ ...accepted, id: 'click-2' }])
  const cleaned = readFileSync(journal, 'utf8')
  expect(cleaned).not.toContain(receipt.token)
  expect(cleaned).not.toContain(receipt.session.id)
  expect(
    cleaned
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual([
    { t: 1, event: 'queued', id: 'click-1' },
    { t: 2, event: 'acked', id: 'click-2' },
    { t: 3, event: 'confirmed', id: 'click-1' },
  ])
})

test('a journal upgrade does not discard the old recovery data if the private write fails', () => {
  const journal = path.join(folder, 'journal.jsonl')
  const original = JSON.stringify({ event: 'queued', id: accepted.id, receipt })
  writeFileSync(journal, original)
  mkdirSync(`${file}.${process.pid}.tmp`)
  expect(() => new DeliveryReceipts(file).importJournal(journal)).toThrow()
  expect(readFileSync(journal, 'utf8')).toBe(original)
})

test('unreadable or oversized records stop recovery without exposing or overwriting their contents', () => {
  for (const contents of ['{"token":"private', JSON.stringify([{ ...accepted, receipt: null }]), ' '.repeat(1_000_001)]) {
    writeFileSync(file, contents)
    expect(() => new DeliveryReceipts(file)).toThrow('The private delivery receipts could not be read safely.')
    expect(readFileSync(file, 'utf8')).toBe(contents)
  }
})
