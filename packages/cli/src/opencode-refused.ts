import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Whether OpenCode has refused to load It's add-on, as OpenCode's own log says.
 *
 * An add-on that OpenCode refuses never runs, so it cannot say so itself, and without this the
 * app would look the same as one that is closed: It would call OpenCode connected, and Auto-wake
 * would reopen a conversation that may be open in it, in a second copy the person does not see.
 * OpenCode writes a line to its log each time it fails to load a plugin, naming the file: in 1.x
 * `message="failed to load plugin" path=file:///…/it-bridge.js`, and in 2.x
 * `message="failed to load plugin" target=/…/it-bridge.js`, with the time first on the line.
 * Neither writes a line when a plugin loads, so only refusals are read, and a refusal is over
 * once the add-on has been heard from after it (see `AddonRuntimes.refused`).
 *
 * A refusal is counted only where it came after the file was put there, by its time on the
 * disk: a file that `it setup` has put there since is another file, and OpenCode 2.x reads it
 * again as soon as it changes, and writes another line should it refuse that one too.
 */

/** How much of the end of each log is read: OpenCode writes a refusal as it starts, so it is near the end. */
const TAIL = 1024 * 1024
/** How many of the most recently written logs in the folder are read. */
const LOGS = 3

/** The file OpenCode loads as It's add-on, under each folder It put the add-on into, from It's note of those installations. */
export function opencodePlugins(note: unknown): string[] {
  const installs = (note as { installs?: unknown } | null)?.installs
  if (!Array.isArray(installs)) return []
  const files = new Set<string>()
  for (const i of installs) {
    if (!i || typeof i !== 'object' || (i as { version?: unknown }).version === 'installing') continue
    const dir = (i as { dir?: unknown }).dir
    if (typeof dir === 'string' && path.isAbsolute(dir)) files.add(path.join(dir, 'plugins', 'it-bridge.js'))
  }
  return [...files]
}

/** The end of a file, read from where it would have to begin to be no longer than `most`. */
function tail(file: string, size: number, most = TAIL): string {
  const fd = openSync(file, 'r')
  try {
    const length = Math.min(size, most)
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8', 0, read)
  } finally {
    closeSync(fd)
  }
}

/** Paths are told apart without regard to case where the system does so too. */
const fold = (text: string, platform: NodeJS.Platform) => (platform === 'win32' ? text.toLowerCase() : text)

/** How a file is named in the field of OpenCode's log that says which plugin it is: by its path, or by its address. */
function namesOf(file: string, platform: NodeJS.Platform): string[] {
  return [...new Set([file, pathToFileURL(file).href].map((name) => fold(name, platform)))]
}

/**
 * The fields of a line of OpenCode's log, which is written as `key=value` pairs with a value
 * that has spaces or quotes in it put in double quotes. A quoted value is read whole, so that
 * nothing inside it, such as an error's own words, is taken for a field of the line.
 */
export function fieldsOf(line: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const [, key, value] of line.matchAll(/(?:^|\s)([A-Za-z_][\w.]*)=("(?:[^"\\]|\\.)*"|[^\s"]*)/g)) {
    if (fields.has(key!)) continue
    let read = value!
    if (read.startsWith('"')) {
      try {
        read = JSON.parse(read)
      } catch {
        // An escape JSON does not have, as a Windows path written with single backslashes does
        read = read.slice(1, -1)
      }
    }
    fields.set(key!, read)
  }
  return fields
}

/**
 * The last time this text of OpenCode's log says that OpenCode refused to load one of these
 * files after it was put there (`since`, by the clock of this machine in milliseconds). A line
 * counts only where its message is that a plugin failed to load and the field that names the
 * plugin (`path` in 1.x, `target` in 2.x) is one of these files, whole.
 */
export function refusedIn(text: string, files: readonly { file: string; since: number }[], platform: NodeJS.Platform = process.platform): number | undefined {
  const named = files.map((f) => ({ names: namesOf(f.file, platform), since: f.since }))
  let last: number | undefined
  for (const line of text.split('\n')) {
    if (!line.includes('failed to load plugin')) continue
    const fields = fieldsOf(line)
    if ((fields.get('message') ?? fields.get('msg')) !== 'failed to load plugin') continue
    const plugin = fields.get('target') ?? fields.get('path')
    if (plugin === undefined) continue
    const file = named.find((f) => f.names.includes(fold(plugin, platform)))
    if (!file) continue
    const at = Date.parse(fields.get('timestamp') ?? '')
    if (Number.isFinite(at) && at >= file.since && (last === undefined || at > last)) last = at
  }
  return last
}

/**
 * Whether a refusal seen at `at` still stands where the log no longer shows it, as once
 * OpenCode has written so much since that the line is past the part of the log that is read:
 * It's file is there and none of them has been put there again since. Only the add-on being
 * heard from, or a file put there anew, shows that the refusal is over.
 */
export function unchangedSince(plugins: readonly string[], at: number): boolean {
  const times = plugins.flatMap((file) => {
    try {
      return [statSync(file).mtimeMs]
    } catch {
      return []
    }
  })
  return times.length > 0 && times.every((t) => t <= at)
}

/**
 * When OpenCode last refused to load one of these files since it was put there, by the clock
 * of this machine in milliseconds, as the logs in these folders say. Undefined where none says
 * so, or where neither the files nor the logs can be read.
 */
export function opencodeRefusedAt(plugins: readonly string[], logFolders: readonly string[], platform: NodeJS.Platform = process.platform): number | undefined {
  const files = plugins.flatMap((file) => {
    try {
      return [{ file, since: statSync(file).mtimeMs }]
    } catch {
      // Not there: OpenCode has nothing of It's to refuse
      return []
    }
  })
  if (!files.length) return undefined
  const since = Math.min(...files.map((f) => f.since))
  let last: number | undefined
  for (const folder of new Set(logFolders)) {
    let logs: { file: string; size: number; at: number }[]
    try {
      logs = readdirSync(folder)
        .filter((name) => name.endsWith('.log'))
        .flatMap((name) => {
          try {
            const at = statSync(path.join(folder, name))
            return at.isFile() ? [{ file: path.join(folder, name), size: at.size, at: at.mtimeMs }] : []
          } catch {
            return []
          }
        })
        // A log last written before any of the files was put there cannot hold a refusal of it
        .filter((log) => log.at >= since)
        .sort((x, y) => y.at - x.at)
        .slice(0, LOGS)
    } catch {
      continue
    }
    for (const log of logs) {
      let at: number | undefined
      try {
        at = refusedIn(tail(log.file, log.size), files, platform)
      } catch {
        continue
      }
      if (at !== undefined && (last === undefined || at > last)) last = at
    }
  }
  return last
}
