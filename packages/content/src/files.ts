// A page's files, kept as plain files in one folder.
//
// Each version has a folder of its own, u/<person>/<page>/<version>/. A file is kept there
// under a name made from its path, the path's SHA-256 in hex, and never under the path itself.
// A path is whatever an agent called a file, and may hold anything: two names that one
// filesystem takes for the same, a name another keeps for a device, one too long to be a
// name at all. Sixty-four hex digits mean one thing everywhere, and spell no way out of the
// folder. What was declared for a version says which path each name stands for, and is kept
// beside the pages, never among them: manifest/u/<person>/<page>/<version>/files.json.
//
// A file is read and written a piece at a time, and is never held whole.
//
// Everything under the folder is the folder's own: a folder there is a folder, and a file a
// file. Where one of them is a link to somewhere else, which nothing here ever makes, it is
// not followed. A link where a folder should be refuses whatever was asked, reading, writing
// and deleting alike, so that nothing outside the folder is ever read as a page's, written
// to, or removed; and a link where a file should be is no file.
import { createHash, type Hash, randomUUID } from 'node:crypto'
import {
  type BigIntStats,
  closeSync,
  constants,
  type Dirent,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { type FileHandle, lstat, mkdir, open, readdir, readFile, rename, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'

export interface Declared {
  size: number
  sha256: string
}
export interface Range {
  offset: number
  length: number
}
/** A stored file that has been opened. It is closed when its bytes have been read to the end, or by `close`. */
export interface Opened {
  size: number
  etag: string
  bytes(range?: Range): ReadableStream<Uint8Array>
  close(): Promise<void>
}
export interface Files {
  open(prefix: string, file: string): Promise<Opened | null>
  /**
   * Stores what arrives as one of a version's files, if it is exactly what was declared. The bytes
   * are checked as they arrive, and only a file that is whole and right is ever put in place.
   * Trouble with the disk is thrown; what the sender got wrong is answered.
   */
  write(
    prefix: string,
    file: string,
    body: ReadableStream<Uint8Array> | null,
    declared: Declared,
    /** Moves the file synchronously while deletion is excluded, or returns false without moving it. */
    allowed: (move: () => void) => boolean,
  ): Promise<'ok' | 'bytes_differ' | 'size_differs' | 'cut_short' | 'no_folder'>
  /**
   * Stores one part of a file that is sent in parts, which arrive one after another, beginning at
   * the start. A part is taken whole or not at all, and the file is checked against its size and
   * checksum as the parts arrive and put in place only once the last has, as `write` puts one.
   * Answers `more` while parts are still to come, and `out_of_order` for a part that does not
   * begin where the next is to, or that arrives while another of the same file is arriving.
   */
  writePart(
    prefix: string,
    file: string,
    body: ReadableStream<Uint8Array> | null,
    declared: Declared,
    part: { offset: number; length: number },
    allowed: (move: () => void) => boolean,
  ): Promise<'ok' | 'more' | 'out_of_order' | 'bytes_differ' | 'size_differs' | 'cut_short' | 'no_folder'>
  /** Where the next part of a file that is arriving in parts begins: 0 where none of it is here. */
  nextPart(prefix: string, file: string): number
  remove(prefix: string, file: string): Promise<void>
  declare(prefix: string, files: ({ path: string } & Declared)[], allowed?: (move: () => void) => boolean): Promise<void>
  /** The files declared for a version, or null if none were. */
  declared(prefix: string): Promise<Map<string, Declared> | null>
  /** What is stored under a version, by the name each file is kept under, with its size. */
  stored(prefix: string): Promise<Map<string, number>>
  /** The SHA-256 of a stored file as it is on disk now, by the name it is kept under. */
  checksum(prefix: string, name: string): Promise<string | null>
  /** Removes every file stored under a version but the ones kept under these names, and says how many it removed. */
  only(prefix: string, names: Set<string>, allowed?: (remove: () => void) => boolean): Promise<number>
  /** Removes what was declared under a prefix and then what was stored, at most `most` files of them. `more` says whether any are left. */
  clear(prefix: string, most: number): Promise<{ removed: number; more: boolean }>
  /** Lets go of the folder: what was still arriving here is cleared away. */
  close(): void
}

const PIECE = 64 * 1024
/** The name a file is kept under: made from its path, and from nothing else. */
export const nameOf = (file: string) => createHash('sha256').update(file).digest('hex')
const gone = (err: unknown) => ['ENOENT', 'ENOTDIR'].includes((err as { code?: string }).code ?? '')
/** Opens a file to read it, and never what a link in its place points to. */
const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
/** What is thrown when something under the folder is a link where a folder should be. It says which kind of trouble, and never where. */
const linked = () => Object.assign(new Error('a folder under the content folder is a link'), { code: 'LINKED' })

/** A file's bytes from an open handle, a piece at a time. The handle is closed as soon as the last of them is read, or when the reader stops wanting them. */
function pieces(handle: FileHandle, offset: number, length: number): ReadableStream<Uint8Array> {
  let at = offset
  const end = offset + length
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (at < end) {
          const piece = new Uint8Array(Math.min(PIECE, end - at))
          const { bytesRead } = await handle.read(piece, 0, piece.length, at)
          // A file that ends before it said it would is not passed off as the whole of itself
          if (bytesRead === 0) throw new Error('a stored file is shorter than it was')
          at += bytesRead
          controller.enqueue(piece.subarray(0, bytesRead))
        }
        if (at >= end) {
          await handle.close()
          controller.close()
        }
      } catch (err) {
        await handle.close().catch(() => {})
        controller.error(err)
      }
    },
    async cancel() {
      await handle.close().catch(() => {})
    },
  })
}

/** Writes all of some bytes at a place in an open file: one write may take fewer than it is given. */
async function writeAll(handle: FileHandle, bytes: Uint8Array, at: number): Promise<void> {
  let written = 0
  while (written < bytes.byteLength) written += (await handle.write(bytes, written, bytes.byteLength - written, at + written)).bytesWritten
}

/**
 * The whole of a body that is to be so many bytes long, held in memory: one part of a file, which
 * is never larger than a request carries. More bytes than that, or fewer once it has ended, is
 * the sender's mistake; a body that stops arriving part of the way is cut short.
 */
async function allOf(body: ReadableStream<Uint8Array> | null, length: number): Promise<Uint8Array | 'size_differs' | 'cut_short'> {
  const all = new Uint8Array(length)
  let size = 0
  const reader = body?.getReader()
  for (;;) {
    let piece: Uint8Array | undefined
    try {
      piece = (await reader?.read())?.value
    } catch {
      return 'cut_short'
    }
    if (!piece) break
    if (size + piece.byteLength > length) {
      await reader?.cancel().catch(() => {})
      return 'size_differs'
    }
    all.set(piece, size)
    size += piece.byteLength
  }
  return size === length ? all : 'size_differs'
}

/** How many files may be arriving in parts at once, and how long one may wait for its next part before what had arrived of it goes. */
const PARTS_AT_ONCE = 64
const PART_IDLE_MS = 10 * 60_000
/** How many stored files this service remembers having checked as they arrived. */
const VOUCHED_MOST = 20_000

/** A file that is arriving in parts: where what has arrived of it is written, and its checksum so far. */
interface Arriving {
  temp: string
  handle: FileHandle
  hash: Hash
  received: number
  declared: Declared
  /** A part of it is arriving at this moment. */
  busy: boolean
  touched: number
}
/** What a stored file is on the disk, by which a file that has been changed or put in its place since is told from it. */
const identity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`

/** The folders, by name, that hold what is arriving at the services this program has open. */
const OPEN_HERE = new Set<string>()
/** Whether a program with this number is running. One that may not be asked about is. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM'
  }
}

/** The name a service gives the folder for what is arriving at it: the number of the program that made it, and a word of its own. */
const HOLDER_NAMED = /^([0-9]+)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
/** The file in such a folder that says a service made it: it holds the folder's own name, and nothing else. */
const HOLDER_NOTE = 'holder'

/**
 * The number of the program that made something in the temporary folder, where a service made
 * it: a folder, and no link to one, whose name has exactly the shape a service gives its own,
 * with the file inside it that says it is the folder of that name.
 *
 * Whatever else is there is somebody's own, whatever it is called and whatever is in it: it is
 * never removed. A note that cannot be read, or that says anything else, is no note.
 */
function holderOf(tmp: string, name: string): number | undefined {
  const pid = Number(HOLDER_NAMED.exec(name)?.[1])
  if (!pid) return undefined
  try {
    const note = path.join(tmp, name, HOLDER_NOTE)
    if (!lstatSync(path.join(tmp, name)).isDirectory()) return undefined
    const info = lstatSync(note)
    return info.isFile() && info.size === name.length && readFileSync(note, 'utf8') === name ? pid : undefined
  } catch {
    return undefined
  }
}

/** Removes only upload staging folders recognised by their holder note. The caller checks the path to tmp. */
export function removeAbandonedUploads(tmp: string): void {
  // More than one service may have the folder open: one that is starting while the one before
  // it has not yet stopped. So each keeps what is arriving at it in a folder of its own, named
  // after the program that made it. What a service that has ended left there never became a
  // file, and is cleared away; what a running one has is left alone, and so is everything
  // that no service made.
  for (const name of readdirSync(tmp)) {
    const pid = holderOf(tmp, name)
    if (pid === undefined || (pid === process.pid ? OPEN_HERE.has(name) : running(pid))) continue
    rmSync(path.join(tmp, name), { recursive: true, force: true })
  }
}

export function createFiles(folder: string): Files {
  const root = path.resolve(folder)
  const tmp = path.join(root, 'tmp')
  mkdirSync(tmp, { recursive: true, mode: 0o700 })
  if (!lstatSync(tmp).isDirectory()) throw linked()
  removeAbandonedUploads(tmp)
  const own = `${process.pid}-${randomUUID()}`
  OPEN_HERE.add(own)
  const arriving = path.join(tmp, own)
  mkdirSync(arriving, { mode: 0o700 })
  // The note that says whose the folder is, written whole before it has its name. A folder
  // left without one, by a service that ended in this very moment, is left for good.
  const part = path.join(arriving, `${HOLDER_NOTE}.part`)
  const note = openSync(part, 'wx', 0o600)
  try {
    writeFileSync(note, own)
    fsyncSync(note)
  } finally {
    closeSync(note)
  }
  renameSync(part, path.join(arriving, HOLDER_NOTE))

  /** A place under the folder, and nowhere else: whatever the parts hold, what they name is inside it. */
  const inside = (...parts: string[]): string => {
    const full = path.resolve(root, ...parts)
    if (!full.startsWith(root + path.sep)) throw new Error('a path leads out of the folder')
    return full
  }
  const versionFolder = (prefix: string) => inside(...prefix.split('/').filter(Boolean))
  const manifestFolder = (prefix: string) => inside('manifest', ...prefix.split('/').filter(Boolean))
  const kept = (prefix: string, file: string) => path.join(versionFolder(prefix), nameOf(file))

  /**
   * Whether a folder under this one is there, looked at one part of its path at a time, each as
   * itself and never as what it may point to. A part that is a link, or anything else that is
   * not a folder, refuses whatever was being done.
   */
  async function there(dir: string): Promise<boolean> {
    let at = root
    for (const part of path.relative(root, dir).split(path.sep)) {
      at = path.join(at, part)
      const info = await lstat(at).catch((err) => {
        if (gone(err)) return null
        throw err
      })
      if (!info) return false
      if (!info.isDirectory()) throw linked()
    }
    return true
  }
  /** Whether a file is there and is a file: a link is not one, wherever it points. */
  const isFile = async (file: string): Promise<{ size: number } | null> => {
    const info = await lstat(file).catch((err) => {
      if (gone(err)) return null
      throw err
    })
    return info?.isFile() ? { size: info.size } : null
  }
  /** Opens one of the folder's own files to read it, or nothing if it is not there or is not a file. */
  async function opened(dir: string, name: string): Promise<FileHandle | null> {
    const file = path.join(dir, name)
    if (!(await there(dir)) || !(await isFile(file))) return null
    try {
      return await open(file, READ)
    } catch (err) {
      // Not there by the time it was opened, or a link by then
      if (gone(err) || (err as { code?: string }).code === 'ELOOP') return null
      throw err
    }
  }

  /** Reads the manifest while the caller holds the service's write lock, with no await before a file is moved or removed. */
  function declaredNow(prefix: string): ({ path: string } & Declared)[] | null {
    const dir = manifestFolder(prefix)
    let at = root
    let handle: number | undefined
    try {
      for (const part of path.relative(root, dir).split(path.sep)) {
        at = path.join(at, part)
        if (!lstatSync(at).isDirectory()) throw linked()
      }
      const file = path.join(dir, 'files.json')
      if (!lstatSync(file).isFile()) return null
      handle = openSync(file, READ)
      return JSON.parse(readFileSync(handle, 'utf8')) as ({ path: string } & Declared)[]
    } catch (err) {
      if (gone(err) || (err as { code?: string }).code === 'ELOOP') return null
      throw err
    } finally {
      if (handle !== undefined) closeSync(handle)
    }
  }

  /**
   * Writes a file whole or not at all: under another name first, and then moved into place.
   * Answers whether it was placed, was not written whole, or its version was no longer writable.
   */
  async function place(
    to: string,
    allowed: ((move: () => void) => boolean) | undefined,
    write: (handle: FileHandle) => Promise<boolean>,
  ): Promise<'placed' | 'not_whole' | 'no_folder'> {
    const temp = path.join(arriving, randomUUID())
    const handle = await open(temp, 'wx', 0o600)
    // Until the file is in its place, whatever becomes of it, what was written under the other
    // name is removed: when it was not whole, and when the disk failed while it was being
    // written, made safe, closed or moved
    let whole = false
    let safe = false
    try {
      try {
        whole = await write(handle)
        if (whole) await handle.sync()
      } finally {
        await handle.close()
      }
      safe = whole
    } finally {
      if (!safe) await unlink(temp).catch(() => {})
    }
    return safe ? settle(temp, to, allowed) : 'not_whole'
  }

  /**
   * Moves a file that was written whole under another name, and made safe on the disk, into its
   * place. Answers whether it was placed, or its version was no longer writable. Where it was
   * not placed, whatever became of it, what was written under the other name is removed.
   */
  async function settle(temp: string, to: string, allowed: ((move: () => void) => boolean) | undefined): Promise<'placed' | 'no_folder'> {
    let placed = false
    try {
      try {
        if (allowed) {
          if (!allowed(() => renameSync(temp, to))) return 'no_folder'
        } else await rename(temp, to)
      } catch (err) {
        if (gone(err)) return 'no_folder'
        throw err
      }
      placed = true
      // Its name is made to last as its bytes were: until the folder it is in has been flushed,
      // a loss of power can leave a file that was said to have arrived with no name on the disk.
      // A system that does not let a folder be opened or flushed (Windows, and some disks that
      // are shared over a network) keeps its names in its own way, and says so in one of a few
      // ways that mean exactly that. Anything else is the disk failing, and is not passed over:
      // a file whose name may not last has not arrived.
      try {
        const folder = await open(path.dirname(to), 'r')
        try {
          await folder.sync()
        } finally {
          await folder.close()
        }
      } catch (err) {
        if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF'].includes((err as NodeJS.ErrnoException)?.code ?? '')) throw err
      }
      return 'placed'
    } finally {
      if (!placed) await unlink(temp).catch(() => {})
    }
  }

  /** Removes every file under a folder, and each folder it empties, until `left` runs out. Answers whether the folder is gone. */
  async function empty(dir: string, left: { files: number }): Promise<boolean> {
    if (!(await there(dir))) return true
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (gone(err)) return true
      throw err
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!(await empty(full, left))) return false
        continue
      }
      // A file, or a link, which is removed as the link it is: what it points to is not touched
      if (left.files <= 0) return false
      await unlink(full).catch((err) => {
        if (!gone(err)) throw err
      })
      left.files -= 1
    }
    // An upload that is arriving at this moment may have put a file back: then the folder stays,
    // with that file in it, and there is more to remove. A folder that cannot be removed for any
    // other reason is the disk's trouble and is thrown, as a file's is: said to be more to
    // remove, it would be asked for again at once, and without end, with nothing ever removed.
    return rmdir(dir).then(
      () => true,
      (err) => {
        if (gone(err)) return true
        if (['ENOTEMPTY', 'EEXIST'].includes((err as { code?: string }).code ?? '')) return false
        throw err
      },
    )
  }

  /** Removes a version's folder and the folders it is in, as far up as they are empty. */
  async function emptied(from: string): Promise<void> {
    for (let dir = from; dir.startsWith(path.join(root, 'u') + path.sep); dir = path.dirname(dir)) {
      const went = await rmdir(dir).then(
        () => true,
        () => false,
      )
      if (!went) break
    }
  }

  /** Makes the folder a version's file is put in, and answers where the file goes: or null where what was declared for the version is not there, and nothing is left made. */
  async function folderFor(prefix: string, file: string): Promise<string | null> {
    const to = kept(prefix, file)
    // Looked at before the folder is made, so that none is made through a link, and after
    await there(path.dirname(to))
    await mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
    if (!(await there(path.dirname(to)))) return null
    // The folder may have been made just now for a version that is deleted already, with
    // everything of its person's: whoever sends the file read what was declared before that.
    // So what was declared is looked for once more, now that the folder is there. Without it
    // nothing is written, and the folders just made go again. Deletion is checked again
    // when the file is moved into place, since another upload can recreate this folder.
    if (!(await there(manifestFolder(prefix))) || !(await isFile(path.join(manifestFolder(prefix), 'files.json')))) {
      await emptied(path.dirname(to))
      return null
    }
    return to
  }
  /**
   * A restored database can reuse a version's prefix. The manifest may have changed while a
   * file's bytes arrived: its actual contents are checked under the same lock as declaration
   * replacement and cleanup, immediately before the rename. An old upload cannot restore a
   * removed file or overwrite a replacement with different bytes.
   */
  const stillDeclared =
    (prefix: string, file: string, declared: Declared, allowed: (move: () => void) => boolean) =>
    (move: () => void): boolean => {
      let placed = false
      allowed(() => {
        const current = declaredNow(prefix)?.find((f) => f.path === file)
        if (current?.size !== declared.size || current.sha256 !== declared.sha256) return
        move()
        placed = true
      })
      return placed
    }

  // What this service checked as it arrived: each file it put in place, as it is on the disk,
  // and the checksum of the bytes it was written with. A file that is the same on the disk now,
  // the same file with the same size, and neither written to nor changed in any way since, holds
  // those bytes, and is not read again to be checked. Anything else is read. Nothing of this is
  // kept anywhere but in memory, so a service that was started again reads what it finds.
  const vouched = new Map<string, { is: string; sha256: string }>()
  async function vouch(file: string, sha256: string): Promise<void> {
    const info = await lstat(file, { bigint: true }).catch(() => null)
    if (!info?.isFile()) return
    vouched.delete(file)
    vouched.set(file, { is: identity(info), sha256 })
    if (vouched.size > VOUCHED_MOST) vouched.delete(vouched.keys().next().value!)
  }

  // The files arriving in parts, by version and path
  const arrivingParts = new Map<string, Arriving>()
  const partOf = (prefix: string, file: string) => `${prefix}\u0000${file}`
  async function letGoOfPart(key: string): Promise<void> {
    const p = arrivingParts.get(key)
    if (!p) return
    arrivingParts.delete(key)
    await p.handle.close().catch(() => {})
    await unlink(p.temp).catch(() => {})
  }

  return {
    async open(prefix, file) {
      const handle = await opened(versionFolder(prefix), nameOf(file))
      if (!handle) return null
      const info = await handle.stat()
      if (!info.isFile()) {
        await handle.close()
        return null
      }
      return {
        size: info.size,
        etag: `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
        bytes: (range) => pieces(handle, range?.offset ?? 0, range?.length ?? info.size),
        close: () => handle.close(),
      }
    },

    async write(prefix, file, body, declared, allowed) {
      const to = await folderFor(prefix, file)
      if (!to) return 'no_folder'
      let fault: 'bytes_differ' | 'size_differs' | 'cut_short' = 'cut_short'
      const placed = await place(to, stillDeclared(prefix, file, declared, allowed), async (handle) => {
        const hash = createHash('sha256')
        let size = 0
        const reader = body?.getReader()
        for (;;) {
          let piece: Uint8Array | undefined
          try {
            piece = (await reader?.read())?.value
          } catch {
            // The sender stopped part of the way through
            return false
          }
          if (!piece) break
          size += piece.byteLength
          if (size > declared.size) {
            await reader?.cancel().catch(() => {})
            fault = 'size_differs'
            return false
          }
          hash.update(piece)
          await writeAll(handle, piece, size - piece.byteLength)
        }
        if (size !== declared.size) fault = 'size_differs'
        else if (hash.digest('hex') !== declared.sha256) fault = 'bytes_differ'
        else return true
        return false
      })
      if (placed === 'placed') await vouch(to, declared.sha256)
      // The folder or permission to put the file in it can go while its bytes are arriving.
      return placed === 'placed' ? 'ok' : placed === 'no_folder' ? 'no_folder' : fault
    },

    async writePart(prefix, file, body, declared, part, allowed) {
      const key = partOf(prefix, file)
      const now = Date.now()
      for (const [k, p] of arrivingParts) if (!p.busy && now - p.touched >= PART_IDLE_MS) await letGoOfPart(k)
      let p = arrivingParts.get(key)
      // One part of a file at a time, in order: another is arriving at this moment, or this one
      // is not the one that comes next. Whoever sends it is told where the next begins
      if (p?.busy) return 'out_of_order'
      if (part.offset === 0) {
        // A file that is begun again is begun afresh, and what had arrived of it goes
        if (p) await letGoOfPart(key)
        // So many files may be arriving in parts at once. Past that, the one that has waited
        // longest for its next part makes room, and is begun again when it comes
        if (arrivingParts.size >= PARTS_AT_ONCE) {
          const idlest = [...arrivingParts].filter(([, q]) => !q.busy).sort((a, b) => a[1].touched - b[1].touched)[0]
          if (!idlest) return 'out_of_order'
          await letGoOfPart(idlest[0])
        }
        const temp = path.join(arriving, randomUUID())
        p = { temp, handle: await open(temp, 'wx', 0o600), hash: createHash('sha256'), received: 0, declared, busy: false, touched: now }
        arrivingParts.set(key, p)
      } else if (!p || p.received !== part.offset || p.declared.size !== declared.size || p.declared.sha256 !== declared.sha256) return 'out_of_order'
      const taking = p
      taking.busy = true
      try {
        // A part is taken whole or not at all: one that is cut off leaves the file as it was
        // before it, and may be sent again
        const bytes = await allOf(body, part.length)
        if (typeof bytes === 'string') return bytes
        await writeAll(taking.handle, bytes, taking.received)
        taking.hash.update(bytes)
        taking.received += bytes.byteLength
        taking.touched = Date.now()
        if (taking.received < declared.size) return 'more'
        // The last part: the file is whole, and is put in place as one sent in one piece is
        arrivingParts.delete(key)
        await taking.handle.sync()
        await taking.handle.close()
        if (taking.hash.digest('hex') !== declared.sha256) {
          await unlink(taking.temp).catch(() => {})
          return 'bytes_differ'
        }
        const to = await folderFor(prefix, file)
        if (!to) {
          await unlink(taking.temp).catch(() => {})
          return 'no_folder'
        }
        const placed = await settle(taking.temp, to, stillDeclared(prefix, file, declared, allowed))
        if (placed === 'placed') await vouch(to, declared.sha256)
        return placed === 'placed' ? 'ok' : 'no_folder'
      } catch (err) {
        // The disk's trouble: what had arrived of the file goes, and it is begun again
        await letGoOfPart(key)
        throw err
      } finally {
        taking.busy = false
      }
    },

    nextPart(prefix, file) {
      return arrivingParts.get(partOf(prefix, file))?.received ?? 0
    },

    async remove(prefix, file) {
      const at = kept(prefix, file)
      vouched.delete(at)
      if (!(await there(path.dirname(at)))) return
      await unlink(at).catch((err) => {
        if (!gone(err)) throw err
      })
      await emptied(path.dirname(at))
    },

    async declare(prefix, files, allowed) {
      const to = path.join(manifestFolder(prefix), 'files.json')
      await there(path.dirname(to))
      await mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
      if (!(await there(path.dirname(to)))) throw new Error('what was declared could not be kept')
      const text = JSON.stringify(files)
      const placed = await place(to, allowed, async (handle) => {
        await handle.writeFile(text)
        return true
      })
      if (placed !== 'placed') throw new Error('what was declared could not be kept')
    },

    async declared(prefix) {
      const handle = await opened(manifestFolder(prefix), 'files.json')
      if (!handle) return null
      let text: string
      try {
        text = await readFile(handle, 'utf8')
      } finally {
        await handle.close()
      }
      const files = JSON.parse(text) as ({ path: string } & Declared)[]
      return new Map(files.map((f) => [f.path, { size: f.size, sha256: f.sha256 }]))
    },

    async stored(prefix) {
      const dir = versionFolder(prefix)
      const found = new Map<string, number>()
      if (!(await there(dir))) return found
      let names: string[]
      try {
        names = await readdir(dir)
      } catch (err) {
        if (gone(err)) return found
        throw err
      }
      for (const name of names) {
        const info = await isFile(path.join(dir, name)).catch(() => null)
        if (info) found.set(name, info.size)
      }
      return found
    },

    async checksum(prefix, name) {
      if (!/^[0-9a-f]{64}$/.test(name)) return null
      // A file this service checked as it arrived, and that is as it was then, is not read again
      const at = path.join(versionFolder(prefix), name)
      const known = vouched.get(at)
      if (known && (await there(path.dirname(at)))) {
        const info = await lstat(at, { bigint: true }).catch(() => null)
        if (info?.isFile() && identity(info) === known.is) return known.sha256
      }
      const handle = await opened(versionFolder(prefix), name)
      if (!handle) return null
      const hash = createHash('sha256')
      const reader = pieces(handle, 0, (await handle.stat()).size).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
      }
      return hash.digest('hex')
    },

    async only(prefix, names, allowed) {
      const dir = versionFolder(prefix)
      if (!(await there(dir))) return 0
      let found: string[]
      try {
        found = await readdir(dir)
      } catch (err) {
        if (gone(err)) return 0
        throw err
      }
      let removed = 0
      for (const name of found) {
        // What counts as stored is a file, as `stored` has it: nothing else there is looked for when a version is checked
        if (names.has(name) || !(await isFile(path.join(dir, name)))) continue
        let taken = false
        const remove = () => {
          // Another declaration can replace ours while the directory is being read. Its
          // newly declared files must survive our cleanup, including in another service.
          if (allowed) {
            const current = declaredNow(prefix)
            if (!current || current.some((f) => nameOf(f.path) === name)) return
          }
          try {
            unlinkSync(path.join(dir, name))
            taken = true
          } catch (err) {
            if (!gone(err)) throw err
          }
        }
        if (allowed) allowed(remove)
        else remove()
        if (taken) removed += 1
      }
      return removed
    },

    async clear(prefix, most) {
      // What was arriving in parts under it goes first, and is not put in place
      for (const key of [...arrivingParts.keys()]) if (key.startsWith(prefix)) await letGoOfPart(key)
      const left = { files: most }
      // What was declared goes first: from that moment no upload under the prefix is accepted,
      // and one that is arriving now removes what it wrote
      const all = (await empty(manifestFolder(prefix), left)) && (await empty(versionFolder(prefix), left))
      return { removed: most - left.files, more: !all }
    },

    close() {
      for (const p of arrivingParts.values()) void p.handle.close().catch(() => {})
      arrivingParts.clear()
      OPEN_HERE.delete(own)
      rmSync(arriving, { recursive: true, force: true })
    },
  }
}
