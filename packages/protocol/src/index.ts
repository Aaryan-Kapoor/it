// What every part of It agrees on: names, limits, and the shapes that cross between
// the page, the site, the backend, the connector and the add-ons. Nothing here imports
// anything, so every part can use it.

export const PROTOCOL_VERSION = 1

/** The word the interface uses for a thing shown on a display. It is said in one place so that it can be changed in one. */
export const NOUN = { one: 'page', many: 'pages', One: 'Page', Many: 'Pages' } as const

/** Token audiences. A token made for one is refused everywhere else. */
export const AUDIENCE = {
  machine: 'it-machine',
  ticket: 'it-content',
  /** Lets a browser sign one display out even when it cannot prove who it is. */
  signOut: 'it-signout',
  upload: 'it-upload',
  control: 'it-control',
  /** A paired browser: the person at the machine itself, or a screen they paired. */
  browser: 'it-browser',
  /** The backend asking the service on its own machine to send a notification. */
  push: 'it-push',
} as const

/**
 * Whether an address is this machine's own: the addresses that never leave it, in either
 * family, and the first of them as it is written when it arrives over the other. What only the
 * backend may ask is taken from these and from nowhere else, by every part that is asked.
 */
export const onThisMachine = (address: string): boolean => address === '::1' || /^(::ffff:)?127(\.[0-9]{1,3}){3}$/.test(address)

/**
 * Where everything listens, counted from one base port. The door is what a browser opens: the
 * site, pairing, the live connection and uploads. Every page is shown from the port after
 * it. The backend's two ports are for this machine only.
 */
export const PORTS = { base: 4700, content: 1, backendApi: 40, backendSite: 41 } as const
/** The port pages are shown from. */
export const contentPort = (base: number): number => base + PORTS.content

/**
 * A host's name as a policy can say it. A policy names a host only in letters, digits, dots and
 * hyphens, and a browser passes over any other name written there: an IPv6 address, or a
 * machine's name with an underscore in it. For such a name the nearest a policy comes is every
 * host under the longest ending of the name that it can say, `*.kitchen.local` for
 * `my_tv.kitchen.local`, and where it can say no ending of it, every host. The site's policy
 * and the pages' are both written from this, so that each names the other as narrowly as a
 * browser takes.
 */
export function policyHost(name: string): string {
  const said = name.toLowerCase()
  const parts = said.split('.')
  const sayable = (part: string) => /^[a-z0-9-]+$/.test(part)
  if (parts.every(sayable)) return said
  let from = parts.length
  while (from > 1 && sayable(parts[from - 1]!)) from--
  return from < parts.length ? `*.${parts.slice(from).join('.')}` : '*'
}

/**
 * What a page may do in a browser, as the words of a sandbox. The server says them in a header
 * on everything it sends from the port pages are shown from, and the site says them again on
 * the frame it shows a page in. A page runs scripts, sends forms, opens dialogs and windows,
 * starts downloads and takes the pointer. It is never given the origin of the address it came
 * from, so it shares nothing with the site, with another page, or with an earlier document of
 * itself; it cannot move the tab it is shown in; and a window it opens is held to the same.
 */
export const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock'

/** Hard limits. The backend enforces them; the CLI checks first so that errors are clear. */
export const LIMITS = {
  slug: 64,
  title: 200,
  filesPerVersion: 500,
  /** All of a version's file paths together, in bytes: what a version's record has to hold. */
  pathBytesPerVersion: 64 * 1024,
  fileBytes: 25 * 1024 * 1024,
  versionBytes: 100 * 1024 * 1024,
  pathLength: 300,
  stateBytes: 512 * 1024,
  /** One value a page keeps for itself with It.store. */
  storeValueBytes: 32 * 1024,
  actionPayloadBytes: 32 * 1024,
  actionName: 64,
  notificationText: 1000,
  notificationButtons: 4,
  displayName: 60,
  machineName: 80,
  versionsKept: 10,
} as const

/** What one person may hold. */
export const QUOTA = {
  artifacts: 500,
  bytes: 2 * 1024 * 1024 * 1024,
  displays: 25,
  machines: 25,
  projects: 200,
  pendingActions: 5000,
  /** Clicks waiting on one page. Past this the page is told its agent is not keeping up. */
  pendingActionsPerPage: 500,
  /** Publishes begun and not yet finished. */
  staging: 50,
} as const

/** How long things are kept. */
export const RETENTION = {
  handledActionDays: 7,
  pendingActionDays: 30,
  notificationDays: 30,
  stagingHours: 1,
  mountHours: 24,
} as const

/** How long a claimed click may sit with a connector before it goes back in the queue. */
export const LEASE_MS = 30_000

/**
 * How many conversations a connector may say are listening at once. The connector never names
 * more, and the backend looks at every one it is given, so none is passed over in silence.
 */
export const LISTENING_MOST = 40

/**
 * How a machine is known to be there. Its connector says that it is alive this often, and a
 * machine not heard from for `onlineMs` is taken to be off: long enough that three of those in
 * a row can be lost on the way, and short enough that a laptop whose lid was closed is not
 * called online, and its pages not said to be listened to, for minutes afterwards. A connector
 * that is asked to stop says so, and its machine is off from that moment.
 */
export const ALIVE = { everyMs: 30_000, onlineMs: 100_000 } as const

/** How It is installed: the two commands a person runs, and where the programs they download are published. */
export const INSTALL = {
  sh: 'curl -fsSL https://itcan.do/install.sh | sh',
  ps: 'irm https://itcan.do/install.ps1 | iex',
  releases: 'https://itcan.do/releases',
} as const

/** A version of It as its three numbers, or nothing where it is not written as one. */
const numbers = (version: string | null | undefined): [number, number, number] | null => {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec((version ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
/**
 * Whether one version of It is newer than another. Neither is, where either is not written as
 * three numbers: a version that cannot be read is no reason to tell anyone to update, or to
 * replace a program.
 */
export function newer(version: string | null | undefined, than: string | null | undefined): boolean {
  const a = numbers(version)
  const b = numbers(than)
  if (!a || !b) return false
  for (let n = 0; n < 3; n++) if (a[n] !== b[n]) return a[n]! > b[n]!
  return false
}

export const HARNESSES = ['claude-code', 'codex', 'openclaw', 'hermes', 'opencode', 'pi'] as const
export type Harness = (typeof HARNESSES)[number]
/**
 * The agent apps a closed conversation of which It can reopen for a click: the ones with a
 * command of their own for carrying a conversation on without a window. Each is reopened only
 * on a machine where the person has switched that on for it.
 */
export const WAKES: readonly Harness[] = ['claude-code', 'codex', 'pi', 'opencode', 'hermes']
/**
 * Whether It reopens a closed conversation on a machine of this system, as the machine names
 * its system (`process.platform`). Not on Windows yet: a conversation reopened there cannot be
 * found again and ended after the service has died, which is what makes running an agent with
 * nobody watching safe to offer. A machine that has not said what it runs on is not taken to
 * be one of the systems this holds on: it says so in its first report, a moment after its
 * connector starts, and an It from before any machine said is to be updated first.
 */
export const wakesOn = (system: string | null | undefined): boolean => system === 'linux' || system === 'darwin'
/**
 * How long an upgrade that a person asked for on the site is taken to be at work. One that has
 * said nothing more by then was cut short (its machine went off, or the program that was to
 * start It again failed without a word), and may be asked for again.
 */
export const UPGRADE_MS = 15 * 60_000
/** What a person is told where they would switch reopening on for a machine It does not reopen conversations on. */
export const noWakeHere = (system: string | null | undefined): string =>
  system === 'win32'
    ? 'It does not reopen closed conversations on a Windows machine yet. What is done on a page waits until its conversation is open again.'
    : 'This machine has not said which system it runs, so It reopens no closed conversation on it. It says so when its connector starts: update It on that machine if it does not.'
/**
 * The agent apps with a queue of their own, which takes a click whether or not its conversation
 * is open. A click for one of these goes to that queue first, and its conversation is reopened
 * only so that it takes what is waiting there.
 */
export const QUEUES: readonly Harness[] = ['codex']
/**
 * How far back from the moment the person switched reopening on a click may have been made and
 * still have its conversation reopened: a day, which takes in what they did before they found
 * the switch, and leaves out an answer given so long ago that acting on it unasked would surprise.
 */
export const WAKE_BACK_MS = 24 * 60 * 60_000
/** How many clicks one reopening carries at most: everything waiting for the conversation goes in one message, up to this many. */
export const WAKE_MOST = 8

/** The conversation that made a page and should hear about clicks on it. */
export interface AgentSession {
  harness: Harness | 'unknown'
  id: string
}

export type DeliveryState = 'pending' | 'leased' | 'handed_off'
export type Outcome = 'running' | 'succeeded' | 'failed' | 'unknown'
/** How a click reached the agent. */
export type Route = 'addon' | 'queue' | 'waiter' | 'manual'

/** What the page sends when someone acts on it. The backend adds who and when. */
export interface ActionEnvelope {
  v: typeof PROTOCOL_VERSION
  /** Chosen by the page, so a retry after a dropped connection is not a second click. */
  clientActionId: string
  name: string
  payload: unknown
  /** The version of the page the person was looking at. */
  contentVersion: number
  /** The state revision the page had when the person acted, if it was tracking state. */
  baseStateRevision?: number
  /**
   * Set by the site, never by the page: whether the person was at the page (it had the
   * keyboard, the tab was showing, and they had lately done something in it) when the action
   * was sent. A page can send actions by itself, and an agent should be able to tell those
   * apart. It says where the person was, and not that they chose this action: a page can wait
   * for any touch at all and then send whatever it likes.
   */
  attended?: boolean
}

/** A click as the connector hands it to an add-on. */
export interface Click {
  id: string
  artifact: string
  title: string
  name: string
  payload: unknown
  at: number
  /** True when the site saw a sign that someone had just used the page, which is not the same as their having chosen this action, and false when it saw none, which is not the same as nobody having chosen it. Absent means it was not recorded. */
  attended?: boolean
  /** The version of the page the person was looking at when they acted, and the revision of its state they could see. */
  version?: number
  stateRevision?: number
  /** The page's version now, when that is another one: what they acted on has since been replaced. */
  nowVersion?: number
  /** The revision the page's state is at now, when that is another one: what they could see has since changed. */
  nowStateRevision?: number
}

/** How much of a click's data is put in front of an agent before it is told where the rest is. */
export const CLICK_TEXT_BYTES = 2000

/** A file written out as text, as a page sends a picture: a `data:` address in base64. */
const FILE_AS_TEXT = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[a-z0-9=._-]+)*;base64,/i
/** The first file a value carries as text, however deep, with the kind of file it says it is. */
export function firstFile(value: unknown, depth = 0): { type: string; base64: string } | undefined {
  if (typeof value === 'string') {
    const found = value.length > 64 ? FILE_AS_TEXT.exec(value.slice(0, 200)) : null
    return found ? { type: found[1]!.toLowerCase(), base64: value.slice(found[0].length) } : undefined
  }
  if (depth > 12 || typeof value !== 'object' || value === null) return undefined
  for (const inner of Array.isArray(value) ? value : Object.values(value)) {
    const found = firstFile(inner, depth + 1)
    if (found) return found
  }
  return undefined
}
/**
 * A value with every file it carries as text replaced by a few words that say what stood there,
 * and how many there were. Everything else is as it was.
 */
export function withoutFiles(value: unknown): { payload: unknown; left: number } {
  let left = 0
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      const found = firstFile(v)
      if (!found) return v
      left++
      const kb = Math.max(1, Math.round((found.base64.length * 3) / 4 / 1024))
      return `(${found.type.startsWith('image/') ? 'a picture' : 'a file'}, ${found.type}, ${kb} KB, left out of this message)`
    }
    if (depth > 12 || typeof v !== 'object' || v === null) return v
    return Array.isArray(v) ? v.map((x) => walk(x, depth + 1)) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]))
  }
  return { payload: walk(value, 0), left }
}
/**
 * The text an agent reads for a click. One wording, used by every add-on. It names the action,
 * so that a click delivered twice can be told from two clicks, and it says what is known about
 * who was there, and no more: that the site saw someone use the page just before it sent the
 * action, or saw no sign of that. It never says that the person chose the action, and never
 * that the page acted alone. The page is what sends it; a page can wait for any touch and then
 * send an approval nobody gave, and a person can press a button whose action is sent a while
 * later, after they have looked away. What the site saw is all it can vouch for. What the
 * person meant is for the agent to judge from the page it wrote.
 *
 * `max` is how much of what the click carried is shown. With 0 none of it is: the agent is told
 * where to read it. That is for routes where the text passes somewhere other people on the
 * machine might see it, such as a command line.
 */
/**
 * The name under which the site tells a page's agent that the page's own script failed. It is
 * no action of the person's: the site sends it itself, once for a showing of the page, with
 * what the script failed with. A page may send an action of that name too, which does no harm:
 * its agent is told that its page has an error, and looks.
 */
export const FAULT = 'it:fault'
/** What a script failed with, as it was carried: a line of text, or nothing that can be read. */
const faultOf = (payload: unknown): string => {
  const said = (payload as { message?: unknown } | null)?.message
  return typeof said === 'string' && said.trim() ? said.replace(/\s+/g, ' ').slice(0, 300) : 'an error it gave no words for'
}
export function describeClick(c: Click, max = CLICK_TEXT_BYTES): string {
  // Not something anyone did: the page's own script failed where it was being shown. Said as
  // that, with what to do, since an agent that reads it as a press would answer a press.
  if (c.name === FAULT) {
    const named = c.title ? `"${c.title}" (${c.artifact})` : `(${c.artifact})`
    return `[It] The ${NOUN.one} ${named} has an error in its own script, which failed on a display with: ${faultOf(c.payload)}. Nobody did this: it is your ${NOUN.one} that is broken, and what is done on it may not be reaching you. Mend it and publish it again. [action ${c.id}]`
  }
  // A picture written out as text is no use to read, and a drawing is hundreds of lines of it
  const { payload, left } = withoutFiles(c.payload)
  const full = payload === undefined || payload === null ? '' : JSON.stringify(payload)
  const empty = full === '' || full === '{}'
  const files = left === 0 ? '' : ` (\`it action ${c.id} --save <file>\` writes ${left === 1 ? 'it' : 'the first of them'} to a file you can open)`
  const data = empty
    ? ''
    : max <= 0
      ? ` (run \`it action ${c.id}\` to read what it carried)`
      : full.length > max
        ? ` ${full.slice(0, max)}… (cut short: run \`it action ${c.id}\` to read all of it)${files}`
        : ` ${full}${files}`
  // A title that is not known (an earlier version's, which is not kept) is left out, never guessed
  const named = c.title ? `"${c.title}" (${c.artifact})` : `(${c.artifact})`
  const who = `The ${NOUN.one} ${named} sent this${c.attended === false ? ' with no sign that anyone had just used it' : c.attended === true ? ' just after someone used it' : ''}`
  // Said only when it matters: what the page showed when it sent this is not what it shows now
  const replaced =
    c.version !== undefined && c.nowVersion !== undefined && c.nowVersion !== c.version
      ? `, as it was at version ${c.version} (the ${NOUN.one} is now at version ${c.nowVersion})`
      : ''
  const changed =
    c.stateRevision !== undefined && c.nowStateRevision !== undefined && c.nowStateRevision !== c.stateRevision
      ? `, when its state was at revision ${c.stateRevision} (it is now at revision ${c.nowStateRevision})`
      : ''
  const stale = replaced + changed
  return `[It] ${who}${stale}: ${c.name}${data} [action ${c.id}]`
}
/**
 * A click in a few words: which page, what was done, and the id by which the rest is read. It
 * is what stands in a person's conversation where an agent app shows a click as their own
 * message. It carries nothing the page chose but its title and the action's name: what the
 * action carried is never put into words that stand as the person's, and the agent reads it
 * with `it action`, where it arrives as data. It says only that there is something to read,
 * that nobody was at the page, or that the page has changed since, each in a word or two.
 */
export function briefClick(c: Click): string {
  const full = c.payload === undefined || c.payload === null ? '' : JSON.stringify(c.payload)
  const named = c.title ? `"${c.title}" (${c.artifact})` : `(${c.artifact})`
  // The page's own script failed: said as that, in the few words this line has
  if (c.name === FAULT) return `[It] ${named}: its own script failed, with details [action ${c.id}]`
  const details = full === '' || full === '{}' ? '' : ', with details'
  const alone = c.attended === false ? ', sent by the page itself' : ''
  const since =
    (c.version !== undefined && c.nowVersion !== undefined && c.nowVersion !== c.version) ||
    (c.stateRevision !== undefined && c.nowStateRevision !== undefined && c.nowStateRevision !== c.stateRevision)
      ? ', on the page as it was before it last changed'
      : ''
  return `[It] ${named}: ${c.name}${details}${alone}${since} [action ${c.id}]`
}
export function describeClicks(clicks: readonly Click[], max = CLICK_TEXT_BYTES): string {
  return clicks.map((c) => describeClick(c, max)).join('\n')
}

// ---------- between the page's runtime and the site ----------

export type PageToSite =
  /** `doc` names the document that is asking, so that asking twice is answered once. */
  | { type: 'it:hello'; v: typeof PROTOCOL_VERSION; doc: string }
  | { type: 'it:action'; requestId: string; envelope: ActionEnvelope }
  | { type: 'it:store'; requestId: string; key: string; value: unknown }
  /** The page's showing is over. The site shows the page again. */
  | { type: 'it:lapsed' }
  /** The page's own script failed with this. The site says so above the page: left unsaid, a button that does nothing looks like an agent that does not answer. */
  | { type: 'it:fault'; message: string }

export type SiteToPage =
  | { type: 'it:state'; state: unknown; revision: number }
  | { type: 'it:result'; requestId: string; ok: true; actionId?: string }
  | { type: 'it:result'; requestId: string; ok: false; error: string }

/** The key in a page's state that belongs to the page itself (It.store). */
export const STORE_KEY = '_page'
/** A name a page may store something under. */
export const isStoreKey = (k: unknown): k is string =>
  typeof k === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k)

/** The hosts a browser's push subscription may point at. Anything else is not a push service. */
export function isPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false
  const h = url.hostname.toLowerCase()
  return (
    h === 'fcm.googleapis.com' ||
    h === 'android.googleapis.com' ||
    h === 'web.push.apple.com' ||
    h.endsWith('.push.apple.com') ||
    h.endsWith('.push.services.mozilla.com') ||
    h.endsWith('.notify.windows.com')
  )
}

/** JSON text as a plain value, or `undefined` when it is not JSON. State and click data cross the backend as text, so any key a page uses is allowed. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---------- validation shared by the CLI and the backend ----------

const SLUG = /^[a-z0-9][a-z0-9._-]*$/
export function isSlug(s: unknown): s is string {
  return typeof s === 'string' && s.length <= LIMITS.slug && SLUG.test(s)
}

/** A file path inside a page: relative, forward slashes, no way out of the folder. */
export function isSafePath(p: unknown): p is string {
  // Measured in bytes, not characters: a path in another alphabet is several bytes a character
  if (typeof p !== 'string' || p.length === 0 || p.length > LIMITS.pathLength || new TextEncoder().encode(p).length > LIMITS.pathLength) return false
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).length
}

/** Merges a patch into state the way `it patch` promises: objects merge, null deletes, anything else replaces. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === null) return undefined
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out: Record<string, unknown> = typeof base === 'object' && base !== null && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {}
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    const merged = deepMerge(out[k], v)
    if (merged === undefined) delete out[k]
    else out[k] = merged
  }
  return out
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
}
export function contentType(path: string): string {
  return TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

/** A file in a version, as the CLI declares it and the backend records it. */
export interface FileEntry {
  path: string
  size: number
  sha256: string
}
