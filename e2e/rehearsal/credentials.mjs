// The owner's sign-ins, lent to a throwaway agent app for one run, under the owner's limits:
//
// - Only an access token is lent. No refresh token is ever copied anywhere.
// - Claude Code is given its access token in its environment (CLAUDE_CODE_OAUTH_TOKEN), and no
//   file is written for it.
// - Codex is given an auth.json in the run's own CODEX_HOME, with the refresh token blank and,
//   unless IT_REHEARSAL_LEND_ID_TOKEN=1, an id token made here in place of the owner's (unsigned,
//   holding only the account id and the plan's name): the access token alone. The
//   file is made empty, closed to every user but the one named, and only then written.
// - Every file written here is overwritten and deleted when the run ends, also when it fails,
//   and `scrub` takes anything shaped like a token out of what a run keeps.
// - Nothing of a token is printed. Errors name only what is missing or expired.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The owner's profile, where the agent apps the owner signed in to keep their sign-ins. Read only. */
const OWNER = process.env.IT_REHEARSAL_OWNER_PROFILE || os.userInfo().homedir

/** Every secret value lent in this process, so that `scrub` can take them out of what is kept. */
const lent = new Set()
/** Every file written here that holds a secret, so that it is shredded at the end, whatever happens. */
const written = new Set()

/**
 * Whether Codex is also lent the owner's id token. Off unless asked for: the owner lends the
 * access token alone, and the id token is lent only where Codex is shown not to sign in without it.
 */
const LEND_ID_TOKEN = process.env.IT_REHEARSAL_LEND_ID_TOKEN === '1'

/**
 * Codex will not read an auth.json whose id token is not a JWT. In place of the owner's, it is
 * given one made here: unsigned, holding only the account id (lent already) and the plan's name,
 * read from the owner's id token's claims, and expiring with the access token. Nothing of the
 * owner's id token itself, its signature, email or name, goes into it.
 */
function standInIdToken(ownerIdToken, accountId, expiresAt) {
  let plan = ''
  try {
    const claims = JSON.parse(Buffer.from(String(ownerIdToken).split('.')[1], 'base64url').toString('utf8'))
    const p = claims?.['https://api.openai.com/auth']?.chatgpt_plan_type
    if (typeof p === 'string' && /^[a-z_]{1,32}$/.test(p)) plan = p
  } catch {}
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const auth = { chatgpt_account_id: accountId, ...(plan ? { chatgpt_plan_type: plan } : {}) }
  // A signature of no meaning (Codex reads the claims and does not check it), and no real email
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ email: 'rehearsal@example.invalid', exp: Math.floor(expiresAt / 1000), 'https://api.openai.com/auth': auth })}.${part('rehearsal')}`
}

/** The id token Codex is given: the owner's only where asked for, else the stand-in. */
function idTokenFor(t, expiresAt) {
  if (LEND_ID_TOKEN) return typeof t.id_token === 'string' ? t.id_token : ''
  return standInIdToken(t.id_token, typeof t.account_id === 'string' ? t.account_id : '', expiresAt)
}

/** How long a lent token must still have before it expires, for a run to be started with it. */
const MARGIN_MS = 20 * 60_000

const why = (what) => {
  const err = new Error(what)
  err.secretFree = true
  return err
}

/**
 * Claude Code's access token and its expiry, read in memory from the owner's
 * `.claude/.credentials.json`. The refresh token in the same file is never kept: only the two
 * fields asked for are taken out of the parsed object, and the rest is dropped with it.
 */
export function claudeAccess() {
  let token
  let expiresAt
  try {
    const parsed = JSON.parse(readFileSync(path.join(OWNER, '.claude', '.credentials.json'), 'utf8'))
    token = parsed?.claudeAiOauth?.accessToken
    expiresAt = parsed?.claudeAiOauth?.expiresAt
  } catch {
    throw why("the owner's Claude Code sign-in could not be read")
  }
  if (typeof token !== 'string' || !token) throw why("the owner's Claude Code sign-in has no access token")
  if (typeof expiresAt !== 'number' || expiresAt - Date.now() < MARGIN_MS)
    throw why(`the owner's Claude Code access token expires too soon (${typeof expiresAt === 'number' ? new Date(expiresAt).toISOString() : 'no expiry'})`)
  lent.add(token)
  return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, expiresAt }
}

/**
 * What a throwaway Claude Code's own sign-in file (`<config folder>\.credentials.json`, where
 * Claude Code on Windows keeps a `/login` sign-in) holds, for a file that another account writes
 * itself (agent-host.py), closed to all but that account before anything is in it: the access
 * token, its expiry, its scopes and the subscription's name, and the refresh token blank. Read
 * in memory from the owner's file like `claudeAccess`; nothing else of it is kept. For a run in
 * which Claude Code is reopened by It's Auto-wake, which (rightly) does not pass a sign-in given
 * in an environment variable on to the conversation it reopens.
 */
export function claudeCredentialsContent() {
  let o
  try {
    o = JSON.parse(readFileSync(path.join(OWNER, '.claude', '.credentials.json'), 'utf8'))?.claudeAiOauth
  } catch {
    throw why("the owner's Claude Code sign-in could not be read")
  }
  const token = o?.accessToken
  const expiresAt = o?.expiresAt
  if (typeof token !== 'string' || !token) throw why("the owner's Claude Code sign-in has no access token")
  if (typeof expiresAt !== 'number' || expiresAt - Date.now() < MARGIN_MS)
    throw why(`the owner's Claude Code access token expires too soon (${typeof expiresAt === 'number' ? new Date(expiresAt).toISOString() : 'no expiry'})`)
  const scopes = Array.isArray(o.scopes) ? o.scopes.filter((s) => typeof s === 'string' && /^[a-z:_.-]{1,64}$/i.test(s)) : []
  const subscriptionType = typeof o.subscriptionType === 'string' && /^[a-z_]{1,32}$/i.test(o.subscriptionType) ? o.subscriptionType : undefined
  o = null
  lent.add(token)
  return { content: `${JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: '', expiresAt, scopes, ...(subscriptionType ? { subscriptionType } : {}) } })}\n`, expiresAt }
}

/** The expiry of a JWT, in milliseconds, from its payload: null where it is not one. */
function jwtExpiry(token) {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp
    return typeof exp === 'number' ? exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * Closes a file to every user but `user`: inheritance taken off, and full control for that one
 * user alone. Done on the empty file, before anything is written into it.
 */
function onlyFor(file, user) {
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:(F)`], { stdio: 'ignore', windowsHide: true })
  const said = execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true })
  const granted = said
    .split(/\r?\n/)
    .slice(0, -1)
    .map((l) => l.replace(file, '').trim())
    .filter((l) => l && !/^Successfully processed/.test(l))
  const exact = `${(process.env.COMPUTERNAME ?? '').toLowerCase()}\\${user.toLowerCase()}:(f)`
  if (granted.length !== 1 || granted[0].toLowerCase() !== exact) throw why(`the file for the sign-in could not be closed to all but ${user}`)
}

/**
 * Closes a folder to every account but `user`, for what is in it now and what is made in it
 * later: a file for a sign-in is made only in such a folder, so that nobody else can open it in
 * the moment between its making and its own permissions being set.
 */
export function protectDir(dir, user = os.userInfo().username) {
  mkdirSync(dir, { recursive: true })
  execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)(F)`], { stdio: 'ignore', windowsHide: true })
}

/** The paths of every file a sign-in was written to, kept so that one left by a run that was killed is shredded by the next. */
const LEDGER = path.join(process.env.IT_REHEARSAL_WORK || 'D:\\it-rehearsal\\work', 'token-ledger.txt')
function ledger(file) {
  try {
    appendFileSync(LEDGER, `${file}\n`)
  } catch {}
}
/** Shreds every file in the ledger that is still there, and empties it. Run at the start and the end of every run. */
export function shredLedger() {
  let left = 0
  try {
    for (const file of readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter(Boolean)) if (existsSync(file) && !shred(file)) left++
    if (!left) writeFileSync(LEDGER, '')
  } catch {}
  return left
}

/**
 * What Codex's auth.json for a throwaway Codex holds, from the owner's `.codex/auth.json`, with
 * the refresh token blank: for a file that another account writes itself (agent-host.py), so
 * that it is closed to all but that account before anything is in it.
 */
export function codexAuthContent() {
  let source
  try {
    source = JSON.parse(readFileSync(path.join(OWNER, '.codex', 'auth.json'), 'utf8'))
  } catch {
    throw why("the owner's Codex sign-in could not be read")
  }
  const t = source?.tokens ?? {}
  const access = t.access_token
  if (source?.auth_mode !== 'chatgpt' || typeof access !== 'string' || !access) throw why("the owner's Codex sign-in is not a ChatGPT sign-in with an access token")
  const expiresAt = jwtExpiry(access)
  if (!expiresAt || expiresAt - Date.now() < MARGIN_MS)
    throw why(`the owner's Codex access token expires too soon (${expiresAt ? new Date(expiresAt).toISOString() : 'no expiry'})`)
  const lend = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: idTokenFor(t, expiresAt), access_token: access, refresh_token: '', account_id: typeof t.account_id === 'string' ? t.account_id : '' },
    last_refresh: new Date().toISOString(),
  }
  for (const v of [lend.tokens.id_token, access]) if (v) lent.add(v)
  source = null
  return { content: `${JSON.stringify(lend)}\n`, expiresAt }
}

/**
 * Writes Codex's auth.json into `codexHome`, from the owner's `.codex/auth.json`, with the
 * refresh token blank. `user` is the Windows account the throwaway Codex runs as, and the only
 * one that may read the file. Returns the file's path and the access token's expiry.
 */
export function codexAuth(codexHome, user = os.userInfo().username) {
  let source
  try {
    source = JSON.parse(readFileSync(path.join(OWNER, '.codex', 'auth.json'), 'utf8'))
  } catch {
    throw why("the owner's Codex sign-in could not be read")
  }
  const t = source?.tokens ?? {}
  const access = t.access_token
  if (source?.auth_mode !== 'chatgpt' || typeof access !== 'string' || !access) throw why("the owner's Codex sign-in is not a ChatGPT sign-in with an access token")
  const expiresAt = jwtExpiry(access)
  if (!expiresAt || expiresAt - Date.now() < MARGIN_MS)
    throw why(`the owner's Codex access token expires too soon (${expiresAt ? new Date(expiresAt).toISOString() : 'no expiry'})`)
  const lend = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idTokenFor(t, expiresAt),
      access_token: access,
      refresh_token: '',
      account_id: typeof t.account_id === 'string' ? t.account_id : '',
    },
    // Now, so that Codex does not try to refresh a sign-in it has no refresh token for
    last_refresh: new Date().toISOString(),
  }
  for (const v of [lend.tokens.id_token, access]) if (v) lent.add(v)
  // The source object, refresh token and all, goes no further than this function
  source = null
  const file = path.join(codexHome, 'auth.json')
  protectDir(codexHome, user)
  if (existsSync(file)) shred(file)
  ledger(file)
  closeSync(openSync(file, 'wx', 0o600))
  written.add(file)
  try {
    onlyFor(file, user)
    writeFileSync(file, `${JSON.stringify(lend)}\n`)
  } catch (err) {
    shred(file)
    throw err
  }
  return { file, expiresAt }
}

/**
 * A throwaway Claude Code's sign-in kept as a participant's is, in a file (`<configDir>\.credentials.json`,
 * the access token only), so that a conversation It reopens, which is given no CLAUDE… variable,
 * is signed in. Owner-only, in the ledger, shredded at the end like Codex's.
 */
export function claudeFile(configDir, user = os.userInfo().username) {
  const { content, expiresAt } = claudeCredentialsContent()
  const file = path.join(configDir, '.credentials.json')
  protectDir(configDir, user)
  if (existsSync(file)) shred(file)
  ledger(file)
  closeSync(openSync(file, 'wx', 0o600))
  written.add(file)
  try {
    onlyFor(file, user)
    writeFileSync(file, content)
  } catch (err) {
    shred(file)
    throw err
  }
  return { file, expiresAt }
}

/** Overwrites a file with random bytes of its own length, flushes that to the disk, and deletes it. */
export function shred(file) {
  try {
    if (existsSync(file)) {
      const size = Math.max(statSync(file).size, 64)
      const fd = openSync(file, 'r+')
      try {
        writeSync(fd, randomBytes(size), 0, size, 0)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      rmSync(file, { force: true })
    }
  } catch {
    // Deleted all the same, where it could not be overwritten
    try {
      rmSync(file, { force: true })
    } catch {}
  }
  written.delete(file)
  return !existsSync(file)
}

/** Shreds every file this process wrote a secret into. Called at the end of every run, and on any way out. */
export function shredAll() {
  let ok = true
  for (const file of [...written]) ok = shred(file) && ok
  return ok
}

/** Forgets the secrets lent in this process, once nothing more is to be scrubbed with them. */
export function forget() {
  lent.clear()
}

// On every way out of this process, the files are shredded
let hooked = false
export function shredOnExit() {
  if (hooked) return
  hooked = true
  process.on('exit', shredAll)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'])
    process.on(signal, () => {
      shredAll()
      process.exit(130)
    })
  process.on('uncaughtException', (err) => {
    shredAll()
    console.error(err?.secretFree ? err.message : `uncaught: ${scrub(String(err?.stack ?? err)).text}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    shredAll()
    console.error(err?.secretFree ? err.message : `unhandled: ${scrub(String(err?.stack ?? err)).text}`)
    process.exit(1)
  })
}

// Shapes of tokens: a JWT, Anthropic's keys and OAuth tokens, OpenAI's keys, and a long bearer value
const SHAPES = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  // A JWT cut short, as an excerpt of one would be
  /eyJ[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:Bearer|bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  /\b(?:access|refresh|id)_token["']?\s*[:=]\s*["'][^"']{12,}["']/g,
]

/**
 * Takes out of `text` every value lent in this process and anything shaped like a token, and
 * says how many it took out. What a run keeps is passed through this before it is kept.
 */
export function scrub(text) {
  let found = 0
  let out = String(text)
  for (const value of lent)
    if (value && out.includes(value)) {
      found += out.split(value).length - 1
      out = out.split(value).join('[secret removed]')
    }
  for (const shape of SHAPES)
    out = out.replace(shape, () => {
      found++
      return '[token-shaped text removed]'
    })
  // An email address: a Claude Code signed in by a file writes its account's email into the
  // context it keeps in the transcript ("The user's email address is …")
  out = out.replace(/[A-Za-z0-9._%+-]+@(?!anthropic\.com|openai\.com|example\.)[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]/g, () => {
    found++
    return '[email removed]'
  })
  return { text: out, found }
}

/** Scrubs a file in place: returns how many things were taken out. */
export function scrubFile(file) {
  if (!existsSync(file)) return 0
  const { text, found } = scrub(readFileSync(file, 'utf8'))
  if (found) writeFileSync(file, text)
  return found
}
