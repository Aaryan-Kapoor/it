import { createHash } from 'node:crypto'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { inHome, Problem, VERSION, writePrivate } from '../lib'
import { RELEASE } from './config'

/**
 * Failed starts wait longer each time, up to ten minutes so a machine that stays offline
 * does not keep fetching or filling its log. That last wait repeats until it can start.
 */
export const STARTUP_WAITS = [30_000, 120_000, 600_000] as const
const file = () => inHome('startup.json')
const recovery = 'Run `it serve` in a terminal to read why. After fixing it, run `it service install` to retry in the background.'
interface Attempt {
  key: string
  failures: number
  code: string
  retryAt: number | null
}

function read(): Attempt | 'unreadable' | null {
  let bytes: string
  try {
    bytes = readFileSync(file(), 'utf8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null
    return 'unreadable'
  }
  let a: unknown
  try {
    a = JSON.parse(bytes)
  } catch {
    return 'unreadable'
  }
  if (
    a &&
    typeof a === 'object' &&
    'key' in a &&
    typeof a.key === 'string' &&
    /^[a-f0-9]{64}$/.test(a.key) &&
    'failures' in a &&
    typeof a.failures === 'number' &&
    Number.isSafeInteger(a.failures) &&
    a.failures >= 1 &&
    'code' in a &&
    typeof a.code === 'string' &&
    /^[a-zA-Z_0-9]{1,40}$/.test(a.code) &&
    'retryAt' in a &&
    (a.retryAt === null || (typeof a.retryAt === 'number' && Number.isSafeInteger(a.retryAt) && a.retryAt > 0))
  )
    return { key: a.key, failures: a.failures, code: a.code, retryAt: a.retryAt }
  return 'unreadable'
}

/** This is only a retry counter. Losing it must not keep an otherwise working service stopped. */
async function forgetUnread(say: (line: string) => void): Promise<null> {
  try {
    await rename(file(), `${file()}.unreadable`)
    say('startup.json could not be read; kept as startup.json.unreadable and its retry count forgotten')
  } catch (err) {
    say(`startup.json could not be read or moved aside (${codeOf(err)}); its retry count was ignored`)
  }
  return null
}
export const resetStartup = () => rmSync(file(), { force: true })

/** Only a digest is kept: settings and proxy addresses can contain credentials. */
export function startupKey(): string {
  const digest = createHash('sha256').update(JSON.stringify([VERSION, RELEASE, process.platform, process.arch]))
  for (const name of ['service.json', 'machine.json']) {
    try {
      digest.update(readFileSync(inHome(name)))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      digest.update('missing')
    }
  }
  for (const name of [
    'IT_PORT',
    'IT_BACKEND_BIN',
    'IT_BACKEND_RELEASES',
    'IT_BACKEND_FETCH_MINUTES',
    'IT_URL',
    'IT_SITE_URL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ])
    digest.update(JSON.stringify([name, process.env[name] ?? null]))
  if (process.env.IT_BACKEND_BIN) {
    try {
      const s = statSync(process.env.IT_BACKEND_BIN)
      digest.update(JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      digest.update('missing program')
    }
  }
  return digest.digest('hex')
}

export function startupStatus() {
  const a = read()
  if (!a || a === 'unreadable') return undefined
  return { failures: a.failures, code: a.code, retryAt: a.retryAt, paused: a.retryAt === null, hint: recovery }
}

// These failures already say that a person must change something before another attempt.
const needsChange = new Set([
  'settings',
  'not_set_up',
  'backend_releases',
  'backend_program',
  'checksum',
  'unsupported',
  'backend_older',
  'database_unfinished',
  'database_unopened',
  'record_unread',
  'home_unfit',
])
const codeOf = (err: unknown) => {
  const code = (err as { code?: unknown })?.code
  if (err instanceof Problem && /^[a-z_]{1,40}$/.test(err.code)) return err.code
  return typeof code === 'string' && /^E[A-Z0-9_]{2,30}$/.test(code) ? code : 'error'
}

/** A successful start clears the failure count. Only failures that need a person stop automatic attempts. */
export async function recoverStartup(
  run: (ready: () => void) => Promise<boolean>,
  { supervised, signal, say }: { supervised: boolean; signal: AbortSignal; say: (line: string) => void },
): Promise<boolean> {
  if (!supervised) {
    if (read() === 'unreadable') await forgetUnread(say)
    resetStartup()
    return run(() => {})
  }
  let key: string
  let before: Attempt | null
  try {
    key = startupKey()
    const attempt = read()
    before = attempt === 'unreadable' ? await forgetUnread(say) : attempt
    if (before?.key !== key) before = null
  } catch (err) {
    say(`could not start: ${codeOf(err)}`)
    say(`automatic startup stopped; ${recovery}`)
    return false
  }
  if (before?.retryAt === null) {
    say(`automatic startup stopped (${before.code}); ${recovery}`)
    return false
  }
  const wait = before ? Math.min(STARTUP_WAITS.at(-1)!, Math.max(0, before.retryAt! - Date.now())) : 0
  if (before && wait) {
    say(`startup retry waits ${Math.ceil(wait / 1000)} seconds (${before.code})`)
    await sleep(wait, undefined, { signal }).catch((err) => {
      if (!signal.aborted) throw err
    })
    if (signal.aborted) return false
    // A manual start or another retry can replace this attempt while it sleeps.
    // Leave that invocation's record alone and let this supervisor stop cleanly.
    try {
      const current = read()
      if (
        startupKey() !== key ||
        (current !== 'unreadable' &&
          (current?.key !== before.key || current.failures !== before.failures || current.code !== before.code || current.retryAt !== before.retryAt))
      ) {
        say('startup retry cancelled because its record or settings changed')
        return false
      }
      if (current === 'unreadable') before = await forgetUnread(say)
    } catch (err) {
      say(`could not start: ${codeOf(err)}`)
      say(`automatic startup stopped; ${recovery}`)
      return false
    }
  }
  if (signal.aborted) return false
  let ready = false
  let endedBeforeReady = false
  try {
    const failed = await run(() => {
      resetStartup()
      ready = true
    })
    if (failed && !ready) {
      endedBeforeReady = true
      throw new Problem('The service ended before it was ready.', 'backend_exited')
    }
    return failed
  } catch (err) {
    if (ready || (signal.aborted && !endedBeforeReady) || (err instanceof Problem && err.code === 'stopped')) throw err
    const code = codeOf(err)
    const failures = (before?.failures ?? 0) + 1
    const delay = needsChange.has(code) ? undefined : STARTUP_WAITS[Math.min(failures, STARTUP_WAITS.length) - 1]
    try {
      writePrivate(file(), { key, failures, code, retryAt: delay === undefined ? null : Date.now() + delay } satisfies Attempt)
    } catch {
      say(`could not start: ${code}`)
      say(`automatic startup stopped because its retry record could not be written; ${recovery}`)
      return false
    }
    if (delay === undefined) {
      say(`could not start: ${code}`)
      say(`automatic startup stopped after ${failures} failed starts; ${recovery}`)
      return false
    }
    say(`startup failed ${failures} times; next attempt in ${delay / 1000} seconds`)
    throw err
  }
}
