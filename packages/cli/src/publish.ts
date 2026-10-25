// Publishing: gather the files, say what they are, upload them, and ask for the switch.

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { type FileEntry, isSafePath, LIMITS, NOUN, PUBLICATION, uploadBudgetMs } from '@it/protocol'
import { claimLock } from './legacy-lock'
import { api, call, direct, doorRefusal, inHome, machine, Problem, readJson, sessionAsked, sessionNote, throughDoor, writePrivate } from './lib'
import { type Profile, profileOf } from './profiles'
import { aloneAt } from './serve/backend'
import { makeOnce } from './serve/config'
import { agentOf, filesBand, record, sizeBand } from './usage'

interface Gathered {
  entry: FileEntry
  data: Buffer
}

/**
 * What is in an open file, and never more than `most` bytes of it, however much the file has
 * grown since it was looked at. `size` is what it held then, which is read in one piece.
 */
function upTo(fd: number, most: number, size: number): Buffer {
  const pieces: Buffer[] = []
  let got = 0
  while (got < most) {
    const piece = Buffer.allocUnsafe(Math.min(most - got, got === 0 ? size + 1 : 64 * 1024))
    const n = readSync(fd, piece, 0, piece.length, null)
    if (n === 0) break
    pieces.push(piece.subarray(0, n))
    got += n
  }
  return pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces, got)
}

/**
 * Reads one file, having checked first that it is small enough to be worth reading. `size` is
 * what the listing said it held, which is only a first look: a build that is still writing can
 * have made it larger by the time it is opened, and larger again while it is read. So it is
 * read no further than a file may be large and than is left of what a page may hold, with one
 * byte more to tell that it went past, and what is counted against the page is what was read.
 */
export function read(full: string, as: string, size: number, total: { bytes: number }, inside?: string): Gathered {
  if (!isSafePath(as)) throw new Problem(`Not a usable file path: ${as}`, 'invalid')
  const tooLarge = () => new Problem(`${as} is larger than ${LIMITS.fileBytes / 1024 / 1024} MB.`, 'limit')
  const tooMuch = () => new Problem(`A ${NOUN.one} is at most ${LIMITS.versionBytes / 1024 / 1024} MB.`, 'limit')
  if (size > LIMITS.fileBytes) throw tooLarge()
  if (total.bytes + size > LIMITS.versionBytes) throw tooMuch()
  // Opened so that a link is refused by the system itself, in case one was put there after the
  // check above; and what was opened is checked again before it is read. And opened so that it
  // is never waited for: a pipe put there in the same moment would otherwise hold this command
  // until something wrote to it, with nothing said and no way for a time limit to end it
  let fd: number
  try {
    fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    throw new Problem(`${as} could not be read, or is a link.`, 'invalid')
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Problem(`${as} is not an ordinary file.`, 'invalid')
    if (stat.size > LIMITS.fileBytes) throw tooLarge()
    // A folder on the way to the file may have been swapped for a link after it was listed,
    // which the check on the file itself cannot see. So where the opened file really is gets
    // looked up, and it must be this very file, inside the folder being published.
    if (inside !== undefined) {
      const real = realpathSync(full)
      const there = statSync(real)
      if (!real.startsWith(inside + path.sep) || there.ino !== stat.ino || there.dev !== stat.dev)
        throw new Problem(`${as} is outside the folder being published.`, 'invalid')
    }
    const data = upTo(fd, Math.min(LIMITS.fileBytes, LIMITS.versionBytes - total.bytes) + 1, stat.size)
    if (data.length > LIMITS.fileBytes) throw tooLarge()
    total.bytes += data.length
    if (total.bytes > LIMITS.versionBytes) throw tooMuch()
    return one(as, data)
  } finally {
    closeSync(fd)
  }
}

/**
 * Lists the folder this program is standing in, and goes down into its folders by standing in
 * each in turn. Standing in a folder holds on to the folder itself, not to its name: the system
 * says where that really is, and it must be where the listing said. From there each file is
 * opened by its bare name, with links refused. So whatever is done to the names on the way
 * while this runs (a folder swapped for a link to somewhere else, and swapped back), nothing
 * outside the folder being published can be read.
 */
function walk(as: string, out: Gathered[], total: { bytes: number }, inside?: string): Gathered[] {
  const here = process.cwd()
  for (const name of readdirSync('.').sort()) {
    if (name === '.git' || name === 'node_modules' || name === '.DS_Store') continue
    // Links are never followed: a link in a folder could point at any file on the machine,
    // and what is published is shown in a browser
    const stat = lstatSync(name)
    const path_ = as ? `${as}/${name}` : name
    if (stat.isSymbolicLink()) throw new Problem(`${path_} is a link, and links are not published. Copy the file in, or remove the link.`, 'invalid')
    if (stat.isDirectory()) {
      process.chdir(name)
      if (process.cwd() !== path.join(here, name)) throw new Problem(`${path_} is outside the folder being published.`, 'invalid')
      walk(path_, out, total, inside)
      process.chdir(here)
      if (process.cwd() !== here) throw new Problem(`${as || 'The folder'} was moved while it was being read.`, 'invalid')
    } else if (stat.isFile()) out.push(read(name, path_, stat.size, total, inside))
    if (out.length > LIMITS.filesPerVersion) throw new Problem(`A ${NOUN.one} has at most ${LIMITS.filesPerVersion} files.`, 'limit')
  }
  return out
}
function one(p: string, data: Buffer): Gathered {
  if (!isSafePath(p)) throw new Problem(`Not a usable file path: ${p}`, 'invalid')
  if (data.length > LIMITS.fileBytes) throw new Problem(`${p} is larger than ${LIMITS.fileBytes / 1024 / 1024} MB.`, 'limit')
  return { entry: { path: p, size: data.length, sha256: createHash('sha256').update(data).digest('hex') }, data }
}

/** A page from a folder, one file, or HTML text. A lone file becomes the page's index.html. */
export function gather(source: { dir?: string; file?: string; html?: string }): Gathered[] {
  if (source.html !== undefined) return [one('index.html', Buffer.from(source.html))]
  if (source.dir) {
    // The folder named may itself be a link to a folder (a linked `dist`, say), which is the
    // person's own choice. What matters is that the folder then entered is this very one.
    const root = existsSync(source.dir) ? statSync(source.dir) : null
    if (!root?.isDirectory()) throw new Problem(`No such folder: ${source.dir}`, 'invalid')
    // Read from inside the folder, and put back where this program was whatever happens
    const from = process.cwd()
    let files: Gathered[]
    try {
      process.chdir(source.dir)
      // The folder now stood in must be the very one that was looked at a moment ago, and not
      // something its name was pointed at in between
      const entered = statSync('.')
      if (entered.ino !== root.ino || entered.dev !== root.dev) throw new Problem(`${source.dir} changed while it was being read.`, 'invalid')
      // Windows says where a program stands by the name it came in under, links and all, so
      // there each opened file is also looked up afresh and must lie inside the folder
      files = walk('', [], { bytes: 0 }, process.platform === 'win32' ? realpathSync('.') : undefined)
    } finally {
      process.chdir(from)
    }
    if (!files.some((f) => f.entry.path === 'index.html')) throw new Problem('The folder needs an index.html.', 'invalid')
    return files
  }
  if (source.file) {
    const stat = existsSync(source.file) ? statSync(source.file) : null
    if (!stat?.isFile()) throw new Problem(`No such file: ${source.file}`, 'invalid')
    return [read(source.file, 'index.html', stat.size, { bytes: 0 })]
  }
  throw new Problem('Nothing to publish.', 'invalid', 'Pass --file, --dir, --html, or pipe HTML in.')
}

/**
 * "owner/repository" from a git remote's address, or nothing if it does not look like one. Only
 * those two names are ever taken: a remote can carry a password, and that must never be sent.
 */
export function projectKey(remote: string): string | undefined {
  const rest = remote
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // the scheme
    .replace(/^[^@/]*@/, '') // who to sign in as, and with what: never kept
  // What is left is host/owner/repository, host:owner/repository, or host:port/owner/repository
  const m = /^[^/:]+[:/](?:\d+\/)?(.+)$/.exec(rest)
  const parts = (m?.[1] ?? '')
    .replace(/\.git\/?$/, '')
    .replace(/\/$/, '')
    .split('/')
  if (parts.length < 2) return undefined
  const [owner, repo] = parts.slice(-2) as [string, string]
  const plain = (x: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(x)
  return plain(owner) && plain(repo) ? `${owner}/${repo}` : undefined
}

/** Where the note of each conversation's folder is kept: in It's folder on this machine, and nowhere else. */
export const conversationsFile = () => inHome('conversations.json')
/** How many conversations' folders are remembered: the ones whose notes were written last. */
const CONVERSATIONS = 300
/**
 * How old a conversation's note may grow before using it again in the same folder writes it
 * again with the time now. Hooks report the folder on every event, so most of them write
 * nothing, and a conversation in use is forgotten only if three hundred others are noted
 * within an hour of its own note.
 */
const NOTED_FOR_MS = 60 * 60_000
/**
 * Notes the folder a conversation is working in: once It has accepted a page it published or
 * brought up, and whenever its add-on says which folder it is in. A conversation that has been
 * closed is reopened from the folder it was held in, and only this machine knows which that
 * was. The note is kept here and sent nowhere.
 */
export async function noteConversation(
  session: { harness: string; id: string },
  cwd = process.cwd(),
  profile: Profile | null | undefined = profileOf(session.harness),
): Promise<void> {
  try {
    const key = `${session.harness}:${session.id}`
    type Note = { cwd: string; at: number; profile?: Profile }
    const read = () => readJson<Record<string, Note>>(conversationsFile()) ?? {}
    // A note an hour or more from the clock, either way, is written again with the time now
    const unchanged = (noted: Note | undefined) =>
      noted?.cwd === cwd && JSON.stringify(noted.profile) === JSON.stringify(profile ?? noted.profile) && Math.abs(Date.now() - noted.at) < NOTED_FOR_MS
    // Hooks report the folder on every event. An unchanged note needs no lock or disk flush.
    if (unchanged(read()[key])) return
    // Preserve the command's three-second chance to keep its note under contention, but
    // yield between attempts so hooks never stop the connector from answering other work.
    const until = performance.now() + 3000
    while (performance.now() < until) {
      const release = claimLock(`${conversationsFile()}.lock`, 10_000, randomBytes(8).toString('hex'))
      if (release) {
        try {
          // Another writer may have changed the notes before this command took the lock.
          const kept = read()
          if (unchanged(kept[key])) return
          const selected = profile ?? kept[key]?.profile
          kept[key] = { cwd, at: Date.now(), ...(selected ? { profile: selected } : {}) }
          const newest = Object.entries(kept)
            .filter(([, noted]) => typeof noted?.cwd === 'string' && typeof noted.at === 'number')
            .sort((a, b) => b[1].at - a[1].at)
            .slice(0, CONVERSATIONS)
          writePrivate(conversationsFile(), Object.fromEntries(newest))
          return
        } finally {
          release()
        }
      }
      // A short jitter keeps commands that started together from retrying together.
      await sleep(5 + Math.random() * 20)
      if (unchanged(read()[key])) return
    }
  } catch {
    // A note that cannot be kept keeps nothing from being published
  }
}
/** The recorded profile stays local, alongside the working folder. */
export function conversationProfile(session: { harness: string; id: string }): unknown {
  return readJson<Record<string, { profile?: unknown }>>(conversationsFile())?.[`${session.harness}:${session.id}`]?.profile
}

/** The folder a conversation was last known to be working in, if it is still there. */
export function conversationFolder(session: { harness: string; id: string }): string | undefined {
  const cwd = readJson<Record<string, { cwd?: unknown }>>(conversationsFile())?.[`${session.harness}:${session.id}`]?.cwd
  return typeof cwd === 'string' && path.isAbsolute(cwd) && existsSync(cwd) ? cwd : undefined
}

/** A stable name for the project a command runs in: its git remote, or failing that its folder. */
export function project(): { key: string; name: string } | undefined {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    let remote = ''
    try {
      remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {}
    return { key: projectKey(remote) ?? path.basename(root), name: path.basename(root) }
  } catch {
    return undefined
  }
}

const sleep = (ms: number, ending?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      ending?.removeEventListener('abort', abort)
      resolve()
    }
    const abort = () => {
      clearTimeout(timer)
      ending?.removeEventListener('abort', abort)
      reject(ending?.reason)
    }
    const timer = setTimeout(done, ms)
    ending?.addEventListener('abort', abort, { once: true })
    if (ending?.aborted) abort()
  })

/** Uploads one file, waiting and trying again when told to slow down or when the connection drops. */
async function put(where: string, grant: string, f: Gathered, ending: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    ending.throwIfAborted()
    // Sent to the door itself, whatever proxy the environment names: a grant and a person's page go with it
    const r = await direct(where, {
      method: 'PUT',
      headers: { authorization: `Bearer ${grant}`, 'x-it-sha256': f.entry.sha256 },
      body: f.data,
      // A minute, and longer for a large file on a slow line: never for ever
      signal: AbortSignal.any([ending, AbortSignal.timeout(uploadBudgetMs(f.entry.size))]),
    }).catch((err) => err as Error)
    if (r instanceof Response && r.ok) return
    // An address that nothing can be sent to stays one however often it is tried
    const retryable = r instanceof Response ? r.status === 429 || r.status >= 500 : !(r instanceof TypeError)
    if (ending.aborted) throw new Problem('The publication exceeded its thirty-minute budget.', 'timeout')
    if (!retryable || attempt >= 5) {
      if (!(r instanceof Response)) {
        // Uploads go to the service that keeps pages, which is neither the backend nor the site: said, so that it is known which was not there
        let host = 'the address the backend gave'
        try {
          host = new URL(where).host
        } catch {}
        throw new Problem(
          `${f.entry.path} could not be uploaded, because the service that keeps pages, at ${host}, ${r.name === 'TimeoutError' ? 'did not answer in time' : 'could not be reached'}.`,
          'offline',
          'Check that this machine is online and that the service is running, then publish again.',
        )
      }
      throw (
        doorRefusal(await r.text().catch(() => ''), new URL(where).origin) ??
        new Problem(`Uploading ${f.entry.path} was refused (${r.status}).`, r.status === 429 ? 'rate_limited' : 'error')
      )
    }
    await sleep(Math.min(1000 * 2 ** attempt, 15_000), ending)
  }
}

/** Whether a page's own files call It to say what the person did: looked for in its markup and scripts, and nothing of them is kept. */
function sendsBack(files: Gathered[]): boolean {
  return files.some((f) => /\.(html?|m?js)$/i.test(f.entry.path) && f.data.length <= 2_000_000 && /\bIt\.action\s*\(/.test(f.data.toString('utf8')))
}

export async function publish(input: {
  slug?: string
  title: string
  files: Gathered[]
  agent?: string
  /** JSON text. */
  state?: string
  /** This conversation takes the page over: clicks on it come here from now on. */
  take?: boolean
  expectedOwner?: { machineId: string; session: { harness: string; id: string } }
  /** This conversation is making a page of its own: where the id is another conversation's page, nothing is published. */
  own?: boolean
  /** Whether the command that publishes it also brings it up on a display. Counted, and nothing else. */
  shown?: boolean
  /** One of It's own pages, which the tour's are: not counted as a page somebody made. */
  itsOwn?: boolean
  /** The built-in tour step, whose ownership and state are checked by the backend. */
  tour?: string
}): Promise<{ slug: string; version: number; url: string; note?: string }> {
  const bytes = input.files.reduce((n, f) => n + f.entry.size, 0)
  if (bytes > LIMITS.versionBytes) throw new Problem(`A ${NOUN.one} is at most ${LIMITS.versionBytes / 1024 / 1024} MB.`, 'limit')
  const asked = sessionAsked()
  const session = asked?.session
  const request = {
    slug: input.slug,
    title: input.title,
    files: input.files.map((f) => f.entry),
    project: project(),
    session,
    agent: input.agent ?? session?.harness,
    ...(input.agent !== undefined ? { agentExplicit: true } : {}),
    ...(input.expectedOwner ? { expectedOwner: input.expectedOwner } : {}),
    ...(input.tour === undefined ? {} : { tour: input.tour }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.take ? { take: true } : {}),
    // Only a conversation makes a page its own: from a plain terminal there is none to keep one for
    ...(input.own && !input.take && session ? { own: true } : {}),
  }
  // Only a digest of the request and its operation identity are kept. A command whose answer
  // was lost resumes that operation on the next identical invocation, even after a restart.
  const folder = inHome('publication-pending')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = path.join(
    folder,
    `${createHash('sha256')
      .update(
        JSON.stringify({
          machine: machine().id,
          command: process.argv.slice(2),
          slug: input.slug,
          files: request.files,
          session,
          agent: input.agent,
          state: input.state,
        }),
      )
      .digest('hex')}.json`,
  )
  // A receipt belongs to one active command. A concurrent command must not abandon its
  // staging version or erase its recovery identity. The service lock also recovers a holder
  // that exited without cleanup; an active holder is reported as busy before any remote work.
  return aloneAt(
    `${file}.lock`,
    async () => {
      let resuming = existsSync(file)
      if (!resuming) {
        const temp = `${file}.${randomUUID()}.tmp`
        writePrivate(temp, { operation: randomUUID(), at: Date.now() })
        resuming = !makeOnce(temp, file)
      }
      const pending = readJson<{ operation: string; at: number }>(file)
      if (!pending || !/^[a-f0-9-]{36}$/.test(pending.operation) || !Number.isFinite(pending.at))
        throw new Problem(
          `The publication record at ${file} cannot be read.`,
          'record_unread',
          'Keep the record and check the page before removing it and publishing again.',
        )
      if (Date.now() - pending.at >= PUBLICATION.receiptDays * 86_400_000)
        throw new Problem('The saved publication is too old to reconcile.', 'conflict', `Check the page, then remove ${file} before publishing again.`)
      const clear = () => {
        if (readJson<{ operation: string }>(file)?.operation === pending.operation) rmSync(file, { force: true })
      }
      const uncertain = (err: unknown): err is Problem =>
        err instanceof Problem && ['offline', 'timeout', 'unavailable', 'error', 'rate_limited'].includes(err.code)
      const unresolved = (): never => {
        throw new Problem(
          'The publication could not be confirmed.',
          'unavailable',
          `Run the same publishing command again to recover this publication. If recovery keeps failing, wait for other publishing commands to end and check the page before removing ${file}.`,
        )
      }
      const begin = async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await call<{ artifactId: string; slug: string; version: number; upload: { url: string; grant: string } }>(
              'action',
              resuming ? api.publish.resume : api.publish.begin,
              resuming ? { operation: pending.operation } : { ...request, operation: pending.operation },
            )
          } catch (err) {
            // Another command can have saved the shared receipt before begin reaches the backend.
            // A missing record is inconclusive, including after a begin whose answer was lost.
            const missing = err instanceof Problem && err.code === 'not_found'
            if (resuming && missing && attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 250))
              continue
            }
            if (missing) return unresolved()
            if (!uncertain(err)) clear()
            throw err
          }
        }
      }
      const begun = await begin()
      const remaining = Math.max(0, PUBLICATION.budgetMs - (Date.now() - pending.at))
      const canceled = new AbortController()
      const ending = AbortSignal.any([canceled.signal, AbortSignal.timeout(remaining)])
      // A few at a time. Each file is checked against its declared size and checksum as it arrives.
      // They go to the door, at the address this machine reaches it by.
      const queue = [...input.files]
      const to = throughDoor(begun.upload.url)
      const worker = async () => {
        for (let f = queue.shift(); f; f = queue.shift())
          await put(to + f.entry.path.split('/').map(encodeURIComponent).join('/'), begun.upload.grant, f, ending)
      }
      const workers = begun.upload.grant ? Array.from({ length: Math.min(4, queue.length) }, worker) : []
      try {
        await Promise.all(workers)
      } catch (err) {
        // Given up on: It is told, so that this attempt stops counting at once against how many may be under way
        queue.length = 0
        canceled.abort()
        await Promise.allSettled(workers)
        await call('mutation', api.publish.abandon, { artifactId: begun.artifactId, version: begun.version }).catch(() => {})
        clear()
        throw err
      }
      type Finished = { slug: string; version: number; url: string; elsewhere?: boolean; took?: boolean }
      const finish = async (): Promise<Finished> => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await call<Finished>(
              'action',
              api.publish.finish,
              { artifactId: begun.artifactId, version: begun.version },
              remaining > 0 ? ending : undefined,
            )
          } catch (err) {
            // Completing again returns the original outcome, even if a later version is live.
            // No upload or new version is needed after an answer was lost.
            if (uncertain(err) && err.code !== 'rate_limited' && attempt < 2 && !ending.aborted) continue
            if (uncertain(err)) return unresolved()
            await call('mutation', api.publish.abandon, { artifactId: begun.artifactId, version: begun.version }).catch(() => {})
            clear()
            throw err
          }
        }
      }
      const done = await finish()
      clear()
      // The conversation's folder is noted only now that It has the page, so that a publication
      // It refuses, after everything was erased say, leaves no note of a conversation behind.
      // None is needed sooner: a page becomes this conversation's, and its clicks come here,
      // only as it is finished.
      if (session) await noteConversation(session)
      // Counted: which agent app, new or not, how large and of how many files in a few bands, and
      // four things that are each so or not: whether it was given a state to start with, whether it
      // sends anything back, whether it carries a picture, and whether it was brought up at once.
      // Never its title or what is in it.
      if (!input.itsOwn)
        record('page.published', {
          agent: agentOf(session?.harness),
          change: done.version === 1 ? 'new' : 'update',
          kind: 'custom',
          size: sizeBand(bytes),
          files: filesBand(input.files.length),
          state: input.state !== undefined,
          actions: sendsBack(input.files),
          pictures: input.files.some((f) => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(f.entry.path)),
          shown: input.shown === true,
        })
      // Which conversation this was done as was a choice among the apps that had marked this
      // command: said, so that a click going to another conversation is not a surprise. A new page,
      // and one taken over, is that conversation's from now on; a later version of a page leaves
      // it with the conversation that has it.
      const note = sessionNote(
        asked,
        done.version === 1 || input.take ? `This ${NOUN.one} was given to` : `This ${NOUN.one} was published from`,
        'publish it again with --take, and with IT_HARNESS and IT_SESSION set to your own app and conversation.',
      )
      // The page stays another conversation's, the one that made it: said, with what to do about it,
      // or the agent tells its person to click and then never hears of it
      const stays = done.elsewhere
        ? `What is done on this ${NOUN.one} goes to another conversation, the one that made it, and not to this one. If the person is to be answered here, publish it again with --take.`
        : done.took
          ? `This ${NOUN.one} was another conversation’s, and is this one’s now: what is done on it comes here.`
          : undefined
      const said = [stays, note].filter(Boolean).join(' ')
      // The page's address is the site's as this machine reaches it
      return { slug: done.slug, version: done.version, url: throughDoor(done.url), ...(said ? { note: said } : {}) }
    },
    0,
  )
}
