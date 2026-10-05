// What is written down.
//
// One line of JSON for each thing someone running this would need to find later: its name, and
// beside it ids, counts and reasons. Never a ticket, a grant, a token, a caller's address, the
// path of a file in a page, or an error's own words. The lines go wherever whoever runs the
// service says, which is where a person can read them, and there is not one for every request:
// bytes are asked for thousands of times a minute, and the address of each names a file in
// someone's page.
//
// A line says how much it matters only when it is more than something that happened: `warn` is
// for something refused that someone may ask about, and `error` for something that needs a
// person to look.
type Field = string | number | boolean | null | undefined
type Level = 'info' | 'warn' | 'error'

export interface Log {
  log(event: string, fields?: Record<string, Field>, level?: Level): void
  /** For anything a caller can make happen as often as they like: said once in a while for each thing it is said about. */
  seldom(event: string, about: string, fields: Record<string, Field>, level?: Level): void
  /** Lets go of what is remembered of having said something about this id, as when everything of a person's is deleted. */
  forget(id: string): void
}

// Anything a caller can make happen as often as they like (a refusal, a limit reached) is said
// once every ten seconds for each thing it is said about, with how many times it happened in
// between. What it is said about is never something a stranger chooses, so a stranger cannot
// make new things to say; and should there be more things than there is room to remember, the
// rest are said together, as "others", until what is remembered has gone quiet.
const QUIET_MS = 10_000
const REMEMBERED = 500

export function createLog(say: (line: string) => void): Log {
  const lastSaid = new Map<string, { at: number; held: number }>()
  const log = (event: string, fields: Record<string, Field> = {}, level: Level = 'info'): void => {
    // Whatever is done with a line, nothing that was being answered fails because of it
    try {
      say(JSON.stringify({ event, ...(level === 'info' ? {} : { level }), ...fields }))
    } catch {}
  }
  const seldom = (event: string, about: string, fields: Record<string, Field>, level: Level = 'warn'): void => {
    const now = Date.now()
    let key = `${event}:${about}`
    if (!lastSaid.has(key) && lastSaid.size >= REMEMBERED) {
      // Room is made only from what has gone quiet: what is still within its ten seconds stays remembered
      for (const [k, v] of lastSaid) if (now - v.at >= QUIET_MS) lastSaid.delete(k)
      if (lastSaid.size >= REMEMBERED) {
        key = `${event}:(others)`
        fields = { others: true }
      }
    }
    const before = lastSaid.get(key)
    if (before && now - before.at < QUIET_MS) {
      before.held += 1
      return
    }
    lastSaid.set(key, { at: now, held: 0 })
    log(event, { ...fields, ...(before?.held ? { alsoSince: before.held } : {}) }, level)
  }
  // What a thing was said about is remembered by its ids, each a part of the name it is kept under
  const forget = (id: string): void => {
    for (const key of [...lastSaid.keys()]) if (key.split(/[:/]/).includes(id)) lastSaid.delete(key)
  }
  return { log, seldom, forget }
}

/** What kind of error this was, for a log line: its code or its class, never its message. */
export function kind(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown }
  if (typeof e?.code === 'string') return e.code.slice(0, 60)
  return typeof e?.name === 'string' ? e.name.slice(0, 60) : 'unknown'
}
