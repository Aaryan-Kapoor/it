// What the service remembers between requests, in a small database of its own: which tickets
// have been spent, each display's sign-out number, and what was lately deleted.
//
// The database is SQLite, through the module the program it runs under provides: `node:sqlite`
// under Node and `bun:sqlite` under Bun. Both are asked for the same three things, which is
// all that is used of either. Every change is written to disk before it is answered, so a
// ticket that was spent stays spent across a restart, a sign-out holds across one, and what
// was deleted stays deleted.
//
// Nothing is kept for ever. Each of the three is remembered for as long as something it must
// refuse could still be good, and is then cleared away.
import { mkdirSync } from 'node:fs'
import path from 'node:path'

type Value = string | number
interface Statement {
  run(...values: Value[]): { changes: number | bigint }
  get(...values: Value[]): Record<string, unknown> | null | undefined
  /** Lets go of the statement, where the module has such a thing: `bun:sqlite` keeps a database open for as long as a statement of it is held. */
  finalize?(): void
}
interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

/** Opens the database with whichever of the two modules this program has. */
function open(file: string): Database {
  const builtin = (name: string) => process.getBuiltinModule(name) as unknown as Record<string, new (file: string) => Database>
  return 'Bun' in globalThis ? new (builtin('bun:sqlite').Database!)(file) : new (builtin('node:sqlite').DatabaseSync!)(file)
}

const seconds = () => Math.floor(Date.now() / 1000)
/** How long after its expiry a spent ticket is still remembered, and how often the ones past that are cleared away. */
const KEPT_AFTER_S = 300
const SWEEP_EVERY_S = 120
/**
 * How long a deletion is remembered. Longer than anything the backend signed before the deletion
 * stays good: a message to declare a version's files is good for a minute, and a grant to upload
 * them for a quarter of an hour.
 */
const DELETED_KEPT_S = 3600

export interface Records {
  /** 'ok' if this ticket has not been spent and is still within its life; it is now spent. Otherwise which of the two it was. */
  spend(jti: string, exp: number): 'ok' | 'spent' | 'expired'
  /** A display's sign-out number: showings and tickets from before it are refused. Zero when none is remembered. */
  signedOut(person: string, display: string): number
  /** Raises a display's sign-out number, which never goes down while it is remembered, and answers what it is now. */
  raise(person: string, display: string, epoch: number): number
  /** Notes that everything under a prefix was deleted: a person's pages, a page's versions, or one version. */
  deleted(prefix: string): void
  /** Whether a version, its page or its person was lately deleted. */
  wasDeleted(version: string): boolean
  /** Does several of these as one: all of them happen, or none does. */
  together<T>(work: () => T): T
  close(): void
}

/**
 * `olderGoodFor` is how many seconds a ticket made before a sign-out, or the showing such a
 * ticket opened, could still be good for after it. A sign-out is remembered that long, and a
 * while more: past it there is nothing from before the sign-out left to refuse.
 */
export function createRecords(folder: string, olderGoodFor: number): Records {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const db = open(path.join(folder, 'content.sqlite'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS spent (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS signed_out (person TEXT NOT NULL, display TEXT NOT NULL, epoch INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (person, display)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS deleted (prefix TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
  `)
  /** Every statement that was prepared, to be let go of when the records are closed. */
  const prepared: Statement[] = []
  const prepare = (sql: string): Statement => {
    const statement = db.prepare(sql)
    prepared.push(statement)
    return statement
  }
  const spend = prepare('INSERT INTO spent (jti, exp) VALUES (?, ?) ON CONFLICT (jti) DO NOTHING')
  const sweep = prepare('DELETE FROM spent WHERE exp < ?')
  const epochOf = prepare('SELECT epoch FROM signed_out WHERE person = ? AND display = ? AND at > ?')
  const raise = prepare(
    'INSERT INTO signed_out (person, display, epoch, at) VALUES (?, ?, ?, ?) ON CONFLICT (person, display) DO UPDATE SET epoch = excluded.epoch, at = excluded.at',
  )
  const signedOutLongAgo = prepare('DELETE FROM signed_out WHERE at <= ?')
  /** A sign-out from before this moment is remembered no more. */
  const remembered = () => seconds() - olderGoodFor - KEPT_AFTER_S
  const deleted = prepare('INSERT INTO deleted (prefix, at) VALUES (?, ?) ON CONFLICT (prefix) DO UPDATE SET at = excluded.at')
  const wasDeleted = prepare('SELECT count(*) AS n FROM deleted WHERE prefix IN (?, ?, ?) AND at > ?')
  const forgotten = prepare('DELETE FROM deleted WHERE at <= ?')
  let swept = seconds()
  let within = false
  let closed = false
  /** Nothing is answered from records that have been closed: not knowing must refuse. */
  const stillOpen = () => {
    if (closed) throw Object.assign(new Error('the records are closed'), { code: 'RECORDS_CLOSED' })
  }

  const records: Records = {
    spend(jti, exp) {
      stillOpen()
      // Expiry is judged here, at the moment of spending. Judged earlier, a request that stalled
      // after the check could spend a ticket whose record had already been cleared away.
      if (!(exp > seconds())) return 'expired'
      if (seconds() - swept >= SWEEP_EVERY_S) {
        sweep.run(seconds() - KEPT_AFTER_S)
        signedOutLongAgo.run(remembered())
        swept = seconds()
      }
      // One statement, which the database does whole: of several attempts exactly one adds the row
      return Number(spend.run(jti, exp).changes) === 1 ? 'ok' : 'spent'
    },
    signedOut(person, display) {
      stillOpen()
      const row = epochOf.get(person, display, remembered())
      const epoch = row ? Number(row.epoch) : 0
      // If it cannot be read, the request fails: not knowing must refuse
      if (!Number.isInteger(epoch) || epoch < 0) throw new Error('a sign-out number could not be read')
      return epoch
    },
    raise(person, display, epoch) {
      return records.together(() => {
        const known = records.signedOut(person, display)
        if (!(epoch > known)) return known
        raise.run(person, display, epoch, seconds())
        return epoch
      })
    },
    deleted(prefix) {
      stillOpen()
      forgotten.run(seconds() - DELETED_KEPT_S)
      deleted.run(prefix, seconds())
    },
    wasDeleted(version) {
      stillOpen()
      // u/<person>/<page>/<version>/, and the two it is under
      const parts = version.split('/')
      const under = [3, 2, 1].map((n) => `${parts.slice(0, n + 1).join('/')}/`)
      return Number(wasDeleted.get(...under, seconds() - DELETED_KEPT_S)?.n) > 0
    },
    together(work) {
      // One inside another is part of the one around it
      if (within) return work()
      stillOpen()
      db.exec('BEGIN IMMEDIATE')
      within = true
      try {
        const done = work()
        db.exec('COMMIT')
        return done
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      } finally {
        within = false
      }
    },
    close() {
      if (closed) return
      closed = true
      // Its statements first: with one of them still held, `bun:sqlite` only notes that the
      // database is to be closed, and goes on holding its files open until the statement goes
      for (const statement of prepared) statement.finalize?.()
      db.close()
    },
  }
  return records
}
