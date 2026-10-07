// `it login`: how a second machine joins an It that runs on another. The person makes an
// invite on the site, and this machine trades it, once, for a place among their machines. It
// makes a key, and from then on the key is all it needs, so revoking the machine on the site
// ends everything it can do.
import { existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import { PORTS } from '@it/protocol'
import { exportJWK, generateKeyPair, type JWK } from 'jose'
import { direct, doorRefusal, enrolledHere, inHome, keepMachine, Problem, readJson, settingsFile, unreachable, wasAt } from './lib'
import { alone } from './serve/backend'
import { unread, writeWhole } from './serve/config'

/** The address of the It to join, as it is kept: where its site is opened, with nothing after the port. Null for anything else. */
export function doorAddress(value: string): string | null {
  try {
    const url = new URL(value)
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && /^\/?$/.test(url.pathname) && !url.search && !url.hash ? url.origin : null
  } catch {
    return null
  }
}

/**
 * Where a key is kept from the moment it is made until the answer to it has been kept: the
 * key a machine asked to be enrolled with, on the machine It runs on and on one that joins.
 * The file holds every such key that is still waiting, each for the It it was made for.
 */
export const pendingFile = () => inHome('machine.pending.json')
/**
 * A key this machine has made and asked to be enrolled with: the name it asked under, and the
 * It it asked. One for joining an It on another machine says where that It is. One for
 * enrolling on the machine It runs on says no address, and names the identity this machine was
 * to take the place of, if any.
 */
export interface Pending {
  name: string
  key: JWK
  at?: string
  replaces?: string
}
const isPending = (kept: unknown): kept is Pending => {
  const p = kept as Partial<Pending> | null
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.name === 'string' &&
    typeof p.key?.d === 'string' &&
    (p.at === undefined || typeof p.at === 'string') &&
    (p.replaces === undefined || typeof p.replaces === 'string')
  )
}
/**
 * Every key that is kept. Each may be the only key to a machine that was made and never heard
 * of, so a file that is not as It wrote it is not read as holding none, and is never written
 * over: that is said, and the person decides.
 */
function pendings(): Pending[] {
  if (!existsSync(pendingFile())) return []
  const all = readJson<unknown>(pendingFile())
  if (!Array.isArray(all) || !all.every(isPending))
    throw unread(
      `The keys this machine has asked to be enrolled with, in ${pendingFile()}, are not as It wrote them.`,
      'Each may be the only key to a machine that was made, so It does not write over them. Put the file back as it was, or move it away if none of them is needed.',
    )
  return all
}
const sameAsking = (kept: Pending, at: string | undefined, replaces: string | undefined) => kept.at === at && kept.replaces === replaces
/** The key that is kept for an It: the one at `at`, or with no address the one on this machine, asked to take the place of `replaces`. */
export const pendingFor = (at?: string, replaces?: string): Pending | undefined => pendings().find((kept) => sameAsking(kept, at, replaces))
/** Keeps a key for the It it was made for, before that It is asked, and beside every key kept for another. */
export function keepPending(pending: Pending): void {
  writeWhole(pendingFile(), [...pendings().filter((kept) => !sameAsking(kept, pending.at, pending.replaces)), pending])
}
/**
 * Lets go of the keys whose asking is settled, and of no others: the keys `settled` picks out
 * go, and every other key stays for the It it was made for, however long ago it was kept.
 */
function settle(settled: (kept: Pending) => boolean): void {
  const all = pendings()
  const waiting = all.filter((kept) => !settled(kept))
  if (waiting.length === all.length) return
  if (waiting.length) writeWhole(pendingFile(), waiting)
  else rmSync(pendingFile(), { force: true })
}
/** The asking of one It is settled: this machine has kept the identity that It answered with. */
export const settlePending = (at?: string, replaces?: string): void => settle((kept) => sameAsking(kept, at, replaces))
/** A key that this machine holds as its own waits for nothing more, wherever it was asked with. */
export const settleKept = (key: JWK): void => settle((kept) => kept.key.d === key.d)

/**
 * Joins the It at an address, with an invite made on its site.
 *
 * One machine joins at a time for a folder, and whether this one has joined already is looked
 * at only once the folder is this command's alone: of two that are run at the same moment, one
 * joins, and the other finds that it has and spends no invite.
 *
 * The key is kept before the It is asked. Should the answer be lost on its way back, or the
 * command be ended before it has kept it, the machine was made there and nothing here would
 * know of it. So the next `it login` at the same address asks with the same key, and that It
 * answers with the machine it made for the key the first time, under the same invite or under
 * a new one. So no machine is ever made that nobody holds the key of.
 *
 * A key is kept for the It it was made for, and goes only when the joining of that It is
 * settled. Joining another It, or enrolling on this machine, makes and keeps a key of its own
 * and leaves that one where it is.
 */
export async function login(opts: { url: string; code: string; name?: string }): Promise<{ machine: string; name: string }> {
  const at = doorAddress(opts.url)
  if (!at) throw new Problem(`The address to join is where It’s site is opened, such as http://192.168.1.20:${PORTS.base}.`, 'invalid')
  // It answers over plain http and nothing else, and this machine asks it on a connection of its own, which speaks nothing else either
  if (!at.startsWith('http://'))
    throw new Problem(`It answers over plain http, so the address to join begins with http://, such as http://192.168.1.20:${PORTS.base}.`, 'invalid')
  return alone('enrol', async () => {
    if (existsSync(settingsFile()))
      throw new Problem('This machine is the one It runs on, so it has nothing to join.', 'invalid', 'Run `it setup` to connect its agent harnesses.')
    if (enrolledHere()) throw new Problem('This machine has already joined an It.', 'invalid', 'Run `it logout` to leave it first.')
    // Every request here has a time limit: none may leave the command waiting for ever
    const soon = () => AbortSignal.timeout(20_000)
    // The backend signs under an address of its own, which is whom this machine's proofs are made out to
    const asked = await direct(`${at}/cli/config`, { signal: soon() }).catch(() => null)
    const said = (await asked?.text().catch(() => '')) ?? ''
    let config: { issuer?: unknown } | null = null
    try {
      config = asked?.ok ? (JSON.parse(said) as { issuer?: unknown } | null) : null
    } catch {}
    // An It that is there and will not answer by this address says so, which is not the same as nothing being there
    if (typeof config?.issuer !== 'string') throw doorRefusal(said, at) ?? unreachable(at)
    // The key is made here and its private half never leaves this machine. One that was kept
    // for this same It, and never heard its answer, is the key to ask with again.
    // A machine that had joined this It before and left names the identity it had then, so
    // that the pages its conversations made come along to the new one
    const replaces = wasAt(at)
    let pending = pendingFor(at, replaces) ?? pendingFor(at)
    if (!pending) {
      const { privateKey } = await generateKeyPair('ES256', { extractable: true })
      pending = { name: opts.name ?? os.hostname(), key: await exportJWK(privateKey), at, ...(replaces ? { replaces } : {}) }
      keepPending(pending)
    }
    const { kty, crv, x, y } = pending.key
    const r = await direct(`${at}/bridge/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: opts.code, publicKey: { kty, crv, x, y }, name: pending.name, ...(replaces ? { replaces } : {}) }),
      signal: soon(),
    }).catch(() => {
      throw unreachable(at)
    })
    const answered = await r.text().catch(() => '')
    let body: { machine?: unknown } = {}
    try {
      body = (JSON.parse(answered) as { machine?: unknown } | null) ?? {}
    } catch {}
    // Whatever is refused here, the key stays where it is kept: an earlier asking with it may have gone through
    if (r.status === 401)
      throw new Problem('That invite is wrong, used or out of date.', 'unauthenticated', 'Make a new one on the site, and use it within ten minutes.')
    if (!r.ok || typeof body.machine !== 'string')
      throw doorRefusal(answered, at) ?? new Problem(`This machine could not join (${r.status}).`, r.status === 429 ? 'limit' : 'error')
    keepMachine({ id: body.machine, name: pending.name, key: pending.key, at, issuer: config.issuer })
    settlePending(at, pending.replaces)
    return { machine: body.machine, name: pending.name }
  })
}
