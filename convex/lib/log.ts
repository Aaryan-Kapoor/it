// What the backend writes down, for whoever runs it. One line of JSON for each thing that
// happened: its name, and beside it ids, counts, codes and reasons. Never a name a person typed,
// a title, what a page sent or stores, a file's path, a key, a token, an address that carries
// one, or the text of an error that might quote any of those.
//
// Convex adds the time and the function to each line. `warn` is for something refused that
// someone may ask about; `error` is for something that needs a person to look.
type Value = string | number | boolean | null | undefined

export function log(event: string, fields: Record<string, Value> = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
  const line = JSON.stringify({ event, ...fields })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/** What kind of error this was, for a log line: its code or its class, never its message. */
export function kind(err: unknown): string {
  const e = err as { code?: unknown; data?: { code?: unknown }; name?: unknown }
  if (typeof e?.data?.code === 'string') return e.data.code
  if (typeof e?.code === 'string') return e.code
  return typeof e?.name === 'string' ? e.name : 'unknown'
}
