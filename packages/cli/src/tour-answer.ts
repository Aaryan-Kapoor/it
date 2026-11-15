// What an agent that gives the tour answers the tour's first page with, in one command, and the
// picture an action of that page carried, which It writes to a file for the agent before the
// agent hears of the action.
//
// An agent on a slow model pays for every command it runs and for everything it has to work
// out. So `it tour answer` takes the action's id and the answer alone: which part of the page
// the action came from and which request it waits on are read from the action itself, the
// answer is put under that part in the page's state in place of the answer before it, the
// action is acknowledged, the picture It saved for it is taken away, and, where what the person
// does next does not arrive in the conversation by itself, the command waits for it and prints
// it. `it tour next` is that wait alone.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'
import { parseJson, TOUR } from '@it/protocol'
import { saveAttached } from './files'
import { claimLock } from './legacy-lock'
import { api, call, inHome, Problem, writePrivate } from './lib'
import { keepToOwnerAsync } from './owner'

/** The page these answer: the tour's first. */
export const START_SLUG = `${TOUR.prefix}${TOUR.start}`
/** The id a part of the page gives each thing it asks, as the page makes it. */
const REQUEST = /^[0-9a-f]{32}$/
/** The name of a part of the page. */
const PART = /^[a-z][a-z0-9]*$/
/** The name of the file a picture is kept in: the tour's own, with the request it belongs to. */
const PICTURE = /^\.it-tour-[0-9a-f]{32}\.png$/
export const pictureName = (request: string): string => `.it-tour-${request}.png`

/** An action as far as this needs it: which page it is from, what it carried as JSON text, and the files beside that. */
export interface Carried {
  id: string
  artifact: string
  payload: string
  files?: readonly { name: string; type: string; bytes: number }[]
}

/** The part of the first page an action came from and the request it waits on, as the action itself says. Nothing of either where it does not say. */
export function askedBy(c: Pick<Carried, 'artifact' | 'payload'>): { part?: string; request?: string } {
  if (c.artifact !== START_SLUG) return {}
  const data = parseJson(c.payload)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
  const { part, request } = data as { part?: unknown; request?: unknown }
  return {
    ...(typeof part === 'string' && PART.test(part) ? { part } : {}),
    ...(typeof request === 'string' && REQUEST.test(request) ? { request } : {}),
  }
}

/**
 * The most a picture kept for the agent may be. The whiteboard draws its picture at most 1280
 * pixels on its longer side, in dark ink on white, which comes to a few tens of kilobytes.
 */
export const MOST_BYTES = 4 * 1024 * 1024
/** What every PNG begins with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32 = (bytes: Buffer): number => {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
/**
 * Whether these bytes are a whole PNG, as far as its chunks go: the signature, then a header of
 * a picture no more than 8192 pixels either way, chunks each whole and with the checksum it
 * says, at least one of image data, and the end chunk, with nothing after it. The image data
 * itself is not decoded.
 */
export function isPng(bytes: Buffer): boolean {
  if (bytes.length < SIGNATURE.length + 25 + 12 + 12 || !bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) return false
  let at = SIGNATURE.length
  let data = false
  for (let first = true; at + 12 <= bytes.length; first = false) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    if (length > bytes.length - at - 12 || !/^[A-Za-z]{4}$/.test(type)) return false
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length)) return false
    if (first) {
      if (type !== 'IHDR' || length !== 13) return false
      const [width, height] = [bytes.readUInt32BE(at + 8), bytes.readUInt32BE(at + 12)]
      if (!width || !height || width > 8192 || height > 8192) return false
    } else if (type === 'IHDR') return false
    if (type === 'IDAT') data = true
    at += 12 + length
    if (type === 'IEND') return data && length === 0 && at === bytes.length
  }
  return false
}

/**
 * The bytes of an open file, from its start, where it is an ordinary file of at most `most`
 * bytes. Undefined where it is anything else.
 */
function bytesOf(fd: number, most: number): Buffer | undefined {
  const seen = fstatSync(fd)
  if (!seen.isFile() || seen.size > most) return undefined
  const bytes = Buffer.alloc(seen.size)
  let got = 0
  while (got < seen.size) {
    const n = readSync(fd, bytes, got, seen.size - got, got)
    if (!n) break
    got += n
  }
  return got === seen.size ? bytes : undefined
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
/** The bytes of the file named, opened without following a link, where it is an ordinary file of at most `most` bytes. */
function readOwn(file: string, most: number): { bytes: Buffer; dev: string; ino: string } | undefined {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return undefined
  }
  try {
    const opened = fstatSync(fd, { bigint: true })
    const bytes = bytesOf(fd, most)
    return bytes && { bytes, dev: String(opened.dev), ino: String(opened.ino) }
  } finally {
    closeSync(fd)
  }
}

// ── The record of the pictures It wrote ──
//
// Each picture the tour writes into a folder of the person's is noted in It's own folder, with
// where it is, how long it is, its checksum and which file of the disk it is, as it is given its
// name there. A file is removed only where it is still the one noted: the same file of the
// disk, not a link, of that length and with that checksum. Anything else in a folder, under
// whatever name, is the person's.

/** Where the record of the pictures the tour wrote is kept. */
export const picturesFile = (): string => inHome('tour-pictures.json')
/** Where a picture is first written and looked at, in It's own folder, before anything of it goes into a folder of the person's. */
const stagingFolder = (): string => inHome('tour-pictures')
/** One picture the tour wrote: where, how long, its checksum, which file of the disk it is, and when. */
export interface Kept {
  file: string
  bytes: number
  sha256: string
  dev: string
  ino: string
  at: number
}
/** How many pictures are remembered: the ones written last. One the record has let go of is left where it is. */
const MOST_KEPT = 100
const isKept = (k: unknown): k is Kept =>
  typeof k === 'object' &&
  k !== null &&
  typeof (k as Kept).file === 'string' &&
  path.isAbsolute((k as Kept).file) &&
  PICTURE.test(path.basename((k as Kept).file)) &&
  Number.isInteger((k as Kept).bytes) &&
  typeof (k as Kept).sha256 === 'string' &&
  /^[0-9a-f]{64}$/.test((k as Kept).sha256) &&
  typeof (k as Kept).dev === 'string' &&
  /^\d+$/.test((k as Kept).dev) &&
  typeof (k as Kept).ino === 'string' &&
  /^\d+$/.test((k as Kept).ino) &&
  typeof (k as Kept).at === 'number'

/**
 * The pictures the record names. An empty list where there is no record yet, and null where
 * there is one that is not as It writes it: that is never taken for an empty one, so nothing
 * is removed by it and nothing is written beside it.
 */
export function keptPictures(): Kept[] | null {
  const file = picturesFile()
  const seen = lstatSync(file, { throwIfNoEntry: false })
  if (!seen) return []
  if (!seen.isFile()) return null
  const read = readOwn(file, 1024 * 1024)
  const json = read && parseJson(read.bytes.toString('utf8'))
  const pictures = json && typeof json === 'object' && !Array.isArray(json) ? (json as { pictures?: unknown }).pictures : undefined
  return Array.isArray(pictures) && pictures.every(isKept) ? pictures : null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/**
 * Changes the record under its lock, which the connector and the agent's own commands share.
 * False where it could not be changed: the record is not as It writes it, or the lock was not
 * had within a few seconds.
 */
async function changeKept(change: (kept: Kept[]) => Kept[]): Promise<boolean> {
  const until = performance.now() + 3000
  while (performance.now() < until) {
    const release = claimLock(`${picturesFile()}.lock`, 10_000, randomBytes(8).toString('hex'))
    if (release) {
      try {
        const kept = keptPictures()
        if (kept === null) return false
        writePrivate(picturesFile(), { pictures: change(kept).slice(-MOST_KEPT) })
        return true
      } catch {
        return false
      } finally {
        release()
      }
    }
    await sleep(5 + Math.random() * 20)
  }
  return false
}

/** Whether the file a note names is still the picture It wrote there: the same file of the disk, not a link, of the length and checksum noted. */
function isOurs(k: Kept): 'ours' | 'gone' | 'another' {
  const seen = lstatSync(k.file, { throwIfNoEntry: false, bigint: true })
  if (!seen) return 'gone'
  if (!seen.isFile() || seen.size !== BigInt(k.bytes) || String(seen.dev) !== k.dev || String(seen.ino) !== k.ino) return 'another'
  const read = readOwn(k.file, MOST_BYTES)
  return read && read.dev === k.dev && read.ino === k.ino && sha256(read.bytes) === k.sha256 ? 'ours' : 'another'
}
/** Removes a picture a note names, where the file there is still that picture. */
function removeIfOurs(k: Kept): 'removed' | 'gone' | 'another' {
  const was = isOurs(k)
  if (was !== 'ours') return was
  rmSync(k.file, { force: true })
  return 'removed'
}

/**
 * Whether the backend says that the action was done on the tour's first page as this machine
 * itself published it, with `it tour show start`: a page that an agent published under the
 * tour's id, or that another machine published, gets no picture written. Anything but a plain
 * yes is a no, as from a backend too old to say.
 */
async function itsOwnTour(id: string): Promise<boolean> {
  try {
    return (await call<boolean>('query', api.tour.picture, { id })) === true
  } catch {
    return false
  }
}

/**
 * Writes the picture an action of the tour's first page carried into `folder`, under the name
 * its request gives it, and says where it is. Nothing where the action is not one done on the
 * tour's first page as this machine published it, with a request and one PNG beside it of at
 * most `MOST_BYTES`.
 *
 * The file is read into It's own folder first, and looked at there: only bytes that are a whole
 * PNG go into `folder`, written for the person's account alone, beside where the picture is to be
 * and under a name of their own, and given the picture's name once they are whole and noted.
 * Nothing is ever written over: a file of that name that is there already is the picture only
 * where the record says It wrote it, written by whichever of the connector and the agent's own
 * command came first, and otherwise it is left as it is and no picture is said. The name is
 * never followed where it is a link.
 */
export async function keepPicture(c: Carried, folder: string | undefined, ownTour: (id: string) => Promise<boolean> = itsOwnTour): Promise<string | undefined> {
  const { request } = askedBy(c)
  const first = c.files?.[0]
  if (!folder || !path.isAbsolute(folder) || !request || c.files?.length !== 1 || !first || first.type !== 'image/png' || first.bytes > MOST_BYTES)
    return undefined
  const at = path.join(folder, pictureName(request))
  const written = () => (keptPictures() ?? []).some((k) => k.file === at && isOurs(k) === 'ours')
  if (lstatSync(at, { throwIfNoEntry: false })) return written() ? at : undefined
  if (!(await ownTour(c.id))) return undefined
  // Read into It's own folder, and looked at there. It's folder is open to the person's account
  // alone, and a file made in it is too, on Windows as well
  const made = mkdirSync(stagingFolder(), { recursive: true, mode: 0o700 })
  if (made) await keepToOwnerAsync(made, true)
  const staged = path.join(stagingFolder(), `${randomUUID()}.png`)
  try {
    await saveAttached(c.id, 1, staged)
    const read = readOwn(staged, MOST_BYTES)
    if (!read || !isPng(read.bytes)) return undefined
    return await placed(at, staged, read, written)
  } catch {
    return undefined
  } finally {
    rmSync(staged, { force: true })
  }
}

/** The codes with which a system says that it cannot give a file a second name there. */
const NO_SECOND_NAME = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']

/**
 * Gives a picture that was looked at its name in the person's folder, as `keepPicture` says, and
 * notes it, under the record's lock, so that nothing that takes pictures away comes between the
 * two. The name is a second name of the file in It's own folder, which keeps the permissions it
 * was made with there: a file made in the person's folder would take that folder's on Windows,
 * which another account may have, and could be opened by it before It made it private. Where the
 * system cannot give the file a second name there, as on another disk, Linux and macOS write the
 * picture beside where it goes, for the person's account alone from the moment it is made, and
 * Windows writes none.
 */
async function placed(at: string, staged: string, read: { bytes: Buffer; dev: string; ino: string }, written: () => boolean): Promise<string | undefined> {
  const sum = sha256(read.bytes)
  const temp = `${at}.${randomBytes(4).toString('hex')}.part`
  let named: Kept | undefined
  let there = false
  try {
    const noted = await changeKept((kept) => {
      let identity = { dev: read.dev, ino: read.ino }
      try {
        linkSync(staged, at)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? ''
        if (!NO_SECOND_NAME.includes(code) || process.platform === 'win32') {
          there = code === 'EEXIST'
          return kept
        }
        const fd = openSync(temp, 'wx', 0o600)
        try {
          for (let done = 0; done < read.bytes.length; ) done += writeSync(fd, read.bytes, done)
          fsyncSync(fd)
          const own = fstatSync(fd, { bigint: true })
          identity = { dev: String(own.dev), ino: String(own.ino) }
        } finally {
          closeSync(fd)
        }
        try {
          linkSync(temp, at)
        } catch (again) {
          there = (again as NodeJS.ErrnoException).code === 'EEXIST'
          return kept
        }
      }
      named = { file: at, bytes: read.bytes.length, sha256: sum, ...identity, at: Date.now() }
      return [...kept, named]
    })
    // Written meanwhile by the other of the two that write it, or there is a file there that It did not write
    if (there) return written() ? at : undefined
    if (named && noted) return at
    // Named and not noted, as where the record could not be written: It takes away what it has just made, which nothing else could tell for its own
    if (named && isOurs(named) === 'ours') rmSync(at, { force: true })
    return undefined
  } finally {
    rmSync(temp, { force: true })
  }
}

/** What was left of the pictures It was to take away: files the record names that have changed since It wrote them, and whether the record could not be read. */
export interface Left {
  left: string[]
  unread?: true
}

/**
 * Takes away the picture kept for a request, wherever the record says It wrote it, where the
 * file there is still that picture, and says what it left.
 */
export async function dropPicture(request: string | undefined): Promise<Left> {
  if (!request || !REQUEST.test(request)) return { left: [] }
  const name = pictureName(request)
  const left: string[] = []
  const changed = await changeKept((kept) =>
    kept.filter((k) => {
      if (path.basename(k.file) !== name) return true
      const done = removeIfOurs(k)
      if (done === 'another') left.push(k.file)
      return false
    }),
  )
  return { left, ...(changed ? {} : { unread: true as const }) }
}

/**
 * Takes away every picture the record says the tour wrote, as when the tour is cleared, where
 * each is still the picture It wrote. And says what it left: a file that the record names and
 * that has changed since, and in `folders` any file named as the tour names its pictures that
 * It did not write. Where the record cannot be read nothing is removed, and that is said.
 */
export async function dropPictures(folders: readonly (string | undefined)[]): Promise<{ removed: number } & Left> {
  let removed = 0
  const left = new Set<string>()
  const changed = await changeKept((kept) =>
    kept.filter((k) => {
      const done = removeIfOurs(k)
      if (done === 'removed') removed++
      else if (done === 'another') left.add(k.file)
      return false
    }),
  )
  for (const folder of new Set(folders)) {
    if (!folder) continue
    let names: string[]
    try {
      names = readdirSync(folder)
    } catch {
      continue
    }
    for (const name of names) if (PICTURE.test(name)) left.add(path.join(folder, name))
  }
  return { removed, left: [...left].sort(), ...(changed ? {} : { unread: true as const }) }
}

/** The pictures the connector has begun to keep, by the action each is of, so that each is asked for once. */
const begun = new Set<string>()
/**
 * The connector's part: as it hears of an action waiting for a conversation on this machine, it
 * has the action's picture written into the folder that conversation works in, so that the file
 * is there by the time the agent is told of the action. It waits for nothing and holds nothing
 * up. Where it cannot be written, the agent's own command writes it, or the agent saves it.
 */
export function keepPictureFor(
  c: Carried & { session: { harness: string; id: string } | null },
  folderOf: (session: { harness: string; id: string }) => string | undefined,
  ownTour?: (id: string) => Promise<boolean>,
): void {
  if (c.artifact !== START_SLUG || !c.files?.length || !c.session || begun.has(c.id)) return
  begun.add(c.id)
  if (begun.size > 200) begun.delete(begun.values().next().value!)
  const folder = folderOf(c.session)
  if (!folder) return
  void keepPicture(c, folder, ownTour).catch(() => {})
}

const plain = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
/**
 * What, merged into `was` as the state merges a patch, leaves `now` and nothing else: each name
 * `was` has and `now` has not is taken away, at every depth. `now` comes from JSON, so a `null`
 * in it is a value taken away, as it is in any patch.
 */
export function replacing(was: unknown, now: unknown): unknown {
  if (!plain(now) || !plain(was)) return now
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(was)) if (!Object.hasOwn(now, key)) out[key] = null
  for (const [key, value] of Object.entries(now)) out[key] = replacing(was[key], value)
  return out
}

/**
 * Answers an action of the tour's first page: puts `answer` under the part the action came from,
 * with the request the action waits on, in place of whatever an earlier answer left there, and
 * acknowledges the action. With no answer, as for an action that waits for none, it is
 * acknowledged alone.
 */
export async function answerAction(id: string, answer: Record<string, unknown> | undefined): Promise<{ part?: string; request?: string; revision?: number }> {
  const c = await call<Carried>('query', api.delivery.get, { id })
  if (c.artifact !== START_SLUG)
    throw new Problem(
      `That action is from the page ${c.artifact}, and \`it tour answer\` answers the tour’s first page, ${START_SLUG}.`,
      'invalid',
      `Answer it as that page’s section of the tour says, or with \`it patch ${c.artifact} '<json>'\`.`,
    )
  const { part, request } = askedBy(c)
  let revision: number | undefined
  if (answer !== undefined) {
    if (!part)
      throw new Problem(
        'That action does not say which part of the page it is from, so there is nowhere to put an answer to it.',
        'invalid',
        'It needs no answer. Run `it tour answer` with its id alone to acknowledge it.',
      )
    // The request is the action's own, whatever the answer says of one: the page draws only the answer to the request it waits on
    const whole = { ...answer, ...(request ? { request } : {}) }
    // The answer to a request is the whole answer: nothing an earlier answer said stays under it,
    // to be read as part of this one. So the part's object as it is now is read, and the patch
    // takes away what is not in this answer, held to the revision it was read at. Where the state
    // changed in between, it is read again
    for (let tries = 0; ; tries++) {
      const now = await call<{ json: string; revision: number }>('query', api.state.get, { slug: START_SLUG })
      const was = (parseJson(now?.json ?? '{}') as Record<string, unknown> | null)?.[part]
      try {
        revision = (
          await call<{ revision?: number }>('mutation', api.state.patch, {
            slug: START_SLUG,
            patch: JSON.stringify({ [part]: replacing(was, whole) }),
            ...(typeof now?.revision === 'number' ? { baseRevision: now.revision } : {}),
          })
        )?.revision
        break
      } catch (err) {
        if (tries >= 4 || (err as { code?: string })?.code !== 'conflict') throw err
      }
    }
  }
  // Acknowledged as `it ack` does it. The answer is on the page by now, and stands whatever becomes of this
  await call('mutation', api.delivery.handedOff, { id, route: 'manual' })
    .then(() => call('mutation', api.delivery.settle, { id, outcome: 'succeeded' }))
    .catch(() => {})
  return { ...(part ? { part } : {}), ...(request ? { request } : {}), ...(revision === undefined ? {} : { revision }) }
}
