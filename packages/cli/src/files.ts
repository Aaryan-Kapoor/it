// Writing a file that an action carried to the disk, for an agent to open with whatever it reads
// files with. The backend gives this machine a grant to read it, and it is read from the door at
// the address this machine reaches It by: the machine It runs on, or one that joined from
// another computer, alike.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { uploadBudgetMs } from '@it/protocol'
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
 */
export async function saveAttached(id: string, number: number, to: string): Promise<Saved> {
  const at = path.resolve(to)
  for (let attempt = 0; ; attempt++) {
    const file = await call<Readable>('action', api.files.read, { id, number })
    // Sent to the door itself, whatever proxy the environment names: a grant and what a page sent go with it
    const where = throughDoor(file.url)
    const r = await direct(where, {
      headers: { authorization: `Bearer ${file.grant}` },
      signal: AbortSignal.timeout(uploadBudgetMs(file.bytes)),
    }).catch((err: Error) => err)
    let trouble: string
    if (r instanceof Response && r.ok) {
      const bytes = new Uint8Array(await r.arrayBuffer())
      if (bytes.length === file.bytes && createHash('sha256').update(bytes).digest('hex') === file.sha256) {
        write(at, bytes)
        return { file: at, number: file.number, name: file.name, type: file.type, bytes: bytes.length }
      }
      trouble = 'it did not arrive whole'
    } else if (r instanceof Response) {
      // Refused for good: the action or its page is gone, or the files with them
      if (r.status === 404) throw new Problem('That file is not kept any more: it went with its action, or with its page.', 'not_found')
      if (r.status !== 429 && r.status < 500)
        throw doorRefusal(await r.text().catch(() => ''), new URL(where).origin) ?? new Problem(`Reading that file was refused (${r.status}).`, 'error')
      trouble = r.status === 429 ? 'It was asked for too much at once' : 'It had trouble reading it'
    } else trouble = r.name === 'TimeoutError' ? 'it did not arrive in time' : 'It could not be reached'
    if (attempt >= 2)
      throw new Problem(
        `That file could not be read, because ${trouble}.`,
        'unavailable',
        'Check that this machine reaches It, and run the same command again.',
      )
    await sleep(1000 * 2 ** attempt)
  }
}

function write(at: string, bytes: Uint8Array): void {
  try {
    // Made anew or not at all, and for this user alone: what a page sent may be private
    writeFileSync(at, bytes, { flag: 'wx', mode: 0o600 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Problem(
        `${at} is there already, and It does not write over a file.`,
        'invalid',
        'Give a name that no file has, and delete the file you made when you have read it.',
      )
    throw new Problem(
      `${at} could not be written (${(err as NodeJS.ErrnoException).code ?? 'an error'}).`,
      'invalid',
      'Give a file in a folder you may write to, such as the one you are in.',
    )
  }
}
