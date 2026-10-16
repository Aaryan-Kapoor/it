import { existsSync, readFileSync, statSync } from 'node:fs'
import { Problem, writePrivate } from './lib'

export interface Receipt {
  token: string
  session: { harness: string; id: string } | null
}

export interface ReceiptRecord {
  id: string
  receipt: Receipt
  /** Absent until the app has accepted the click. */
  route?: 'queue' | 'addon'
}

export const RECEIPTS_MOST = 500
const BYTES_MOST = 1_000_000
const unreadable = () => new Problem('The private delivery receipts could not be read safely.', 'receipts_unreadable')
const word = (value: unknown, most: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= most

function checked(value: unknown): ReceiptRecord {
  const r = value as ReceiptRecord | null
  if (
    !r ||
    !word(r.id, 200) ||
    !word(r.receipt?.token, 128) ||
    (r.receipt.session !== null && (!word(r.receipt.session?.harness, 40) || !word(r.receipt.session?.id, 200))) ||
    (r.route !== undefined && r.route !== 'queue' && r.route !== 'addon')
  )
    throw unreadable()
  // Keep only these fields. Page text and other caller data never belong in this record.
  return {
    id: r.id,
    receipt: { token: r.receipt.token, session: r.receipt.session === null ? null : { harness: r.receipt.session.harness, id: r.receipt.session.id } },
    ...(r.route === undefined ? {} : { route: r.route }),
  }
}

/** Private recovery state, separate from the diagnostic journal. No unresolved receipt is evicted. */
export class DeliveryReceipts {
  private records = new Map<string, ReceiptRecord>()

  constructor(private readonly file: string) {
    if (!existsSync(file)) return
    try {
      if (statSync(file).size > BYTES_MOST) throw unreadable()
      const rows: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(rows) || rows.length > RECEIPTS_MOST) throw unreadable()
      for (const value of rows) {
        const row = checked(value)
        if (this.records.has(row.id)) throw unreadable()
        this.records.set(row.id, row)
      }
    } catch {
      throw unreadable()
    }
  }

  private save(next: Map<string, ReceiptRecord>): void {
    const data = JSON.stringify([...next.values()])
    if (next.size > RECEIPTS_MOST || Buffer.byteLength(data) > BYTES_MOST)
      throw new Problem('The private delivery receipts are full. Delivery will try again after confirmations finish.', 'receipts_full')
    if (data === JSON.stringify([...this.records.values()])) return
    writePrivate(this.file, data)
    this.records = next
  }

  confirmations(): ReceiptRecord[] {
    return [...this.records.values()].filter((r) => r.route !== undefined).map(checked)
  }

  /** Reserve space before claiming or sending. A full disk or record stops the attempt here. */
  reserve(rows: ReceiptRecord[]): void {
    const next = new Map(this.records)
    for (const value of rows) {
      const row = checked(value)
      if (next.get(row.id)?.route) throw new Problem('This click still has a delivery to confirm.', 'receipt_pending')
      next.set(row.id, { id: row.id, receipt: row.receipt })
    }
    this.save(next)
  }

  accept(rows: ReceiptRecord[]): void {
    const next = new Map(this.records)
    for (const value of rows) {
      const row = checked(value)
      if (!row.route) throw unreadable()
      next.set(row.id, row)
    }
    this.save(next)
  }

  forget(id: string, receipt?: Receipt): void {
    const row = this.records.get(id)
    if (
      !row ||
      (receipt &&
        (row.receipt.token !== receipt.token || row.receipt.session?.harness !== receipt.session?.harness || row.receipt.session?.id !== receipt.session?.id))
    )
      return
    const next = new Map(this.records)
    next.delete(id)
    this.save(next)
  }

  forgetReservation(id: string): void {
    if (!this.records.get(id)?.route) this.forget(id)
  }

  /** Unaccepted claims are returned by startup recovery. They cannot confirm a delivery. */
  discardReservations(): void {
    const next = new Map(this.records)
    for (const [id, row] of next) if (!row.route) next.delete(id)
    if (next.size !== this.records.size) this.save(next)
  }

  /** Upgrade the unreleased journal format, saving receipts before removing its private fields. */
  importJournal(file: string): void {
    if (!existsSync(file)) return
    const text = readFileSync(file, 'utf8')
    const pending = new Map<string, ReceiptRecord>()
    const clean: string[] = []
    let privateFields = false
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const row = JSON.parse(line)
        if (typeof row?.event !== 'string' || typeof row.id !== 'string') continue
        clean.push(JSON.stringify({ t: row.t, event: row.event, id: row.id }))
        if ('receipt' in row) privateFields = true
        if ((row.event === 'queued' || row.event === 'acked') && row.receipt)
          pending.set(row.id, checked({ id: row.id, receipt: row.receipt, route: row.event === 'queued' ? 'queue' : 'addon' }))
        if (['confirmed', 'released', 'lost', 'parked', 'stopped'].includes(row.event)) pending.delete(row.id)
      } catch {
        // A torn journal line is diagnostic only, never proof of a handover.
        privateFields = true
      }
    }
    if (!privateFields) return
    this.accept([...pending.values()].filter((r) => !this.records.has(r.id)))
    writePrivate(file, `${clean.join('\n')}\n`)
  }
}
