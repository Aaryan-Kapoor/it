// Limits on how often something may be asked, counted in memory.
//
// Each limit allows so many in a minute for each key it is asked about, the minute beginning
// with the first one counted. No count is kept longer than its minute. Only so many keys are
// counted apart at once: past that, new ones are counted together until the earlier ones have
// run out, which keeps what is remembered small whatever is sent. A key names whose count it
// is, by an id, and is let go of with them when everything of theirs is deleted.
const MINUTE_MS = 60_000
const COUNTED_APART = 5000
const OTHERS = '(others)'

/** Whether something is kept under a name that has this id as one of its parts: the parts of a name are set apart by colons and slashes. */
const names = (key: string, id: string): boolean => key.split(/[:/]/).includes(id)

/** One limit. Counts one against `key`, and answers whether that was one too many. */
export interface Limit {
  (key: string): boolean
  /** Lets go of every count kept under a key that names this id. */
  forget(id: string): void
}

export function limit(most: number): Limit {
  const counts = new Map<string, { since: number; count: number }>()
  const forget = (id: string) => {
    for (const key of [...counts.keys()]) if (names(key, id)) counts.delete(key)
  }
  const count = (key: string): boolean => {
    const now = Date.now()
    let counted = counts.get(key)
    if (counted && now - counted.since >= MINUTE_MS) counted = undefined
    if (!counted) {
      if (!counts.has(key) && counts.size >= COUNTED_APART) {
        for (const [k, v] of counts) if (now - v.since >= MINUTE_MS) counts.delete(k)
        if (counts.size >= COUNTED_APART && key !== OTHERS) key = OTHERS
        counted = counts.get(key)
        if (counted && now - counted.since >= MINUTE_MS) counted = undefined
      }
      if (!counted) {
        counted = { since: now, count: 0 }
        counts.set(key, counted)
      }
    }
    counted.count += 1
    return counted.count > most
  }
  return Object.assign(count, { forget })
}

/** The limits the service keeps, each for a minute. */
export const createLimits = () => ({
  /** Requests for a page's bytes, by person, display and showing. A page of 500 files loads at once. */
  READS: limit(3000),
  /** The same requests, by person alone, however many showings they have open. */
  READS_PERSON: limit(30_000),
  /** Uploads, by the version being uploaded. A version has at most 500 files. */
  UPLOADS: limit(1500),
  /** Uploads, by person, however many versions they are uploading at once. */
  UPLOADS_PERSON: limit(6000),
})
export type Limits = ReturnType<typeof createLimits>
