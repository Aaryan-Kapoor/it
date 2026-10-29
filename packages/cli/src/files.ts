// Writing a file that an action carried to the disk, for an agent to open with whatever it reads
// files with. The backend gives this machine a grant to read it, and it is read from the door at
// the address this machine reaches It by: the machine It runs on, or one that joined from
// another computer, alike.
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, copyFileSync, fsyncSync, ftruncateSync, linkSync, lstatSync, openSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'
import { UPLOAD, uploadBudgetMs } from '@it/protocol'
import { api, call, direct, doorRefusal, Problem, throughDoor } from './lib'

interface Readable {
  url: string
  grant: string
  number: number
  name: string
  type: string
  bytes: number
  sha256: string
}

/** What was written, and where. */
export interface Saved {
  file: string
  number: number
  name: string
  type: string
  bytes: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reads file `number` of an action, counted from 1, and writes it to `to`, which is made anew or
 * not at all: a file that is there already is the person's, and is never written over. What
 * arrives is held to the size and the checksum It took the file with, and asked for again, a
 * few times, where it is not that or does not arrive.
 *
 * It is written beside where it is to be, under a name of its own, and given its name only once
 * it is whole and right. A file larger than one answer carries is read a part at a time, each
 * written as it comes: none of it is held in memory but the part that is arriving.
 */
export async function saveAttached(id: string, number: number, to: string): Promise<Saved> {
  const at = path.resolve(to)
  // Said before anything is read, and made sure of again as it is given its name
  if (lstatSync(at, { throwIfNoEntry: false })) throw thereAlready(at)
  const temp = `${at}.${randomUUID().slice(0, 8)}.part`
  let fd: number
  try {
    fd = openSync(temp, 'wx', 0o600)
  } catch (err) {
    throw cannotWrite(at, err)
  }
  let file: Readable
  try {
    for (let attempt = 0; ; attempt++) {
      file = await call<Readable>('action', api.files.read, { id, number })
      const trouble = await readInto(id, file, fd)
      if (trouble === null) break
      if (attempt >= 2)
        throw new Problem(
          `That file could not be read, because ${trouble}.`,
          'unavailable',
          'Check that this machine reaches It, and run the same command again.',
        )
      await sleep(1000 * 2 ** attempt)
    }
    fsyncSync(fd)
  } catch (err) {
    closeSync(fd)
    rmSync(temp, { force: true })
    throw err
  }
  closeSync(fd)
  try {
    named(temp, at)
  } finally {
    rmSync(temp, { force: true })
  }
  return { file: at, number: file.number, name: file.name, type: file.type, bytes: file.bytes }
}

/**
 * Reads the whole of a file into an open file, from its start: in one answer where one carries
 * it, and otherwise a part at a time. Answers null once it has arrived whole and right, and
 * otherwise what kept it from arriving, for it to be asked for again. What It refuses for good is thrown.
 */
async function readInto(id: string, file: Readable, fd: number): Promise<string | null> {
  // Sent to the door itself, whatever proxy the environment names: a grant and what a page sent go with it
  const where = throughDoor(file.url)
  ftruncateSync(fd, 0)
  const hash = createHash('sha256')
  let got = 0
  let grant = file.grant
  let renewed = 0
  do {
    const inParts = file.bytes > UPLOAD.partBytes
    const end = Math.min(got + UPLOAD.partBytes, file.bytes) - 1
    const r = await direct(where, {
      headers: { authorization: `Bearer ${grant}`, ...(inParts ? { range: `bytes=${got}-${end}` } : {}) },
      signal: AbortSignal.timeout(uploadBudgetMs(inParts ? end - got + 1 : file.bytes)),
    }).catch((err: Error) => err)
    if (!(r instanceof Response)) return r.name === 'TimeoutError' ? 'it did not arrive in time' : 'It could not be reached'
    // Refused for good: the action or its page is gone, or the files with them
    if (r.status === 404) throw new Problem('That file is not kept any more: it went with its action, or with its page.', 'not_found')
    // The grant ran out part of the way through a large file: another is asked for, and it goes on
    if (r.status === 401 && got > 0 && renewed++ < 3) {
      grant = (await call<Readable>('action', api.files.read, { id, number: file.number }).catch(() => null))?.grant ?? ''
      if (!grant) return 'its grant ran out'
      continue
    }
    if (r.status !== 200 && r.status !== 206) {
      if (r.status !== 429 && r.status < 500)
        throw doorRefusal(await r.text().catch(() => ''), new URL(where).origin) ?? new Problem(`Reading that file was refused (${r.status}).`, 'error')
      return r.status === 429 ? 'It was asked for too much at once' : 'It had trouble reading it'
    }
    // What arrives is read to its end here, and a connection that drops part of the way is
    // trouble like any other, asked for again
    const bytes = await r.arrayBuffer().then(
      (b) => new Uint8Array(b),
      () => null,
    )
    if (!bytes) return 'it did not arrive whole'
    if (r.status === 200) {
      // The whole file, as an It that gives no file in parts answers
      if (got > 0) ftruncateSync(fd, 0)
      if (bytes.length !== file.bytes) return 'it did not arrive whole'
      writeAll(fd, bytes, 0)
      return createHash('sha256').update(bytes).digest('hex') === file.sha256 ? null : 'it did not arrive whole'
    }
    if (r.headers.get('content-range') !== `bytes ${got}-${got + bytes.length - 1}/${file.bytes}` || bytes.length === 0) return 'it did not arrive whole'
    writeAll(fd, bytes, got)
    hash.update(bytes)
    got += bytes.length
  } while (got < file.bytes)
  return hash.digest('hex') === file.sha256 ? null : 'it did not arrive whole'
}

function writeAll(fd: number, bytes: Uint8Array, at: number): void {
  for (let written = 0; written < bytes.length; ) written += writeSync(fd, bytes, written, bytes.length - written, at + written)
}

/**
 * Gives a file that was written whole under a name of its own the name it is to have, where no
 * file has that name: a second name is given in one step and only where it is free. A disk that
 * gives no file a second name, as a memory stick does, is given a copy instead, made only where
 * no file has the name either.
 */
function named(temp: string, at: string): void {
  try {
    linkSync(temp, at)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? ''
    if (code === 'EEXIST') throw thereAlready(at)
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'].includes(code)) throw cannotWrite(at, err)
  }
  try {
    copyFileSync(temp, at, constants.COPYFILE_EXCL)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw thereAlready(at)
    throw cannotWrite(at, err)
  }
}

const thereAlready = (at: string) =>
  new Problem(
    `${at} is there already, and It does not write over a file.`,
    'invalid',
    'Give a name that no file has, and delete the file you made when you have read it.',
  )
const cannotWrite = (at: string, err: unknown) =>
  new Problem(
    `${at} could not be written (${(err as NodeJS.ErrnoException).code ?? 'an error'}).`,
    'invalid',
    'Give a file in a folder you may write to, such as the one you are in.',
  )
