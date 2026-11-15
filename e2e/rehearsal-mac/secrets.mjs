// The one place the Mac rehearsal touches a real credential. It gives a throwaway agent app on a
// rented Mac what it needs to reach its model, and nothing more:
//
// - Codex: an auth.json built in memory from ~/.codex/auth.json on this machine with its refresh
//   token blanked and no API key, piped over `nsc ssh` into the Mac user's ~/.codex/auth.json,
//   mode 600. Never a file on this machine.
// - Claude Code: not the owner's Claude account but OpenRouter. The key is read in memory from
//   the line OPENROUTER_API_KEY= of /home/cbak/programming/it/.env, put into a settings.json built
//   in memory ({"env": {ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ...}}), and piped over `nsc ssh`
//   into the Mac user's ~/.claude/settings.json, mode 600. Never a file on this machine.
//
// A value is never on a command line, here or on the Mac: it goes only through standard input.
// Nothing here prints, logs or returns a value to a caller outside this module except inside the
// opaque object `held`, which a caller hands back to `inject`, `wipe`, `filesHolding` and `redact`.
// `wipe` overwrites and deletes both files on the Mac, ends the terminal that runs the agent app,
// and overwrites and deletes any other file that took a copy; it is called when a run ends, also
// when it fails, and again before the Mac is destroyed.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
export const NSC = '/tmp/claude-1000/-home-cbak-programming-it/51f6f360-74f1-48c2-9f53-3ca473781de1/scratchpad/nsc/bin/nsc'
const ENV_FILE = '/home/cbak/programming/it/.env'
export const HAIKU = 'anthropic/claude-haiku-5.5'
const INSTANCE = /^[a-z0-9]{6,40}$/

/**
 * Runs `command` on the Mac `id` as its user, with `input` on its standard input, and resolves
 * with { code, out }. `out` is the command's standard output, which must never be a secret; its
 * standard error is dropped.
 */
export function onMac(id, command, { input = '', timeout = 300_000, binary = false } = {}) {
  if (!INSTANCE.test(id)) return Promise.resolve({ code: -1, out: binary ? Buffer.alloc(0) : '' })
  return new Promise((resolve) => {
    const chunks = []
    const child = spawn(NSC, ['ssh', '-T', id, command], { stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
    child.stdout.on('data', (d) => chunks.push(d))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, out: binary ? Buffer.alloc(0) : '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const buf = Buffer.concat(chunks)
      resolve({ code: code ?? -1, out: binary ? buf : buf.toString('utf8') })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/** A credential file read as JSON, with an error that carries nothing of what is in it. */
function readJson(path, what) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`The ${what} credential file could not be read.`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`The ${what} credential file is not JSON as expected.`)
  } finally {
    text = null
  }
}

function jwtExpiry(jwt) {
  try {
    const part = String(jwt).split('.')[1]
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

/** The OpenRouter key from the .env file, read in memory, or an error that names no part of it. */
function openRouterKey() {
  let text
  try {
    text = readFileSync(ENV_FILE, 'utf8')
  } catch {
    throw new Error('The .env file with the OpenRouter key could not be read.')
  }
  try {
    const line = text.split(/\r?\n/).find((l) => /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=/.test(l))
    if (!line) throw new Error('The .env file has no OPENROUTER_API_KEY line.')
    let value = line.slice(line.indexOf('=') + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!/^[A-Za-z0-9_\-]{20,200}$/.test(value)) throw new Error('The OpenRouter key is not shaped as a key.')
    return value
  } finally {
    text = null
  }
}

/**
 * What one run of `app` ('codex' or 'claude') is given, held in memory. For Codex the copy must
 * live at least `minutes` more. Resolves with `{ held, minutesLeft }`, or throws an error whose
 * message names no part of a credential.
 */
export function take(app, minutes) {
  const now = Date.now()
  if (app === 'codex') {
    const auth = readJson(join(HOME, '.codex', 'auth.json'), 'Codex')
    const tokens = auth?.tokens
    if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) throw new Error('Codex has no access token on this machine.')
    const expiresAt = jwtExpiry(tokens.access_token)
    if (!expiresAt) throw new Error('The expiry of the Codex access token could not be read.')
    if (expiresAt - now < minutes * 60_000) throw new Error(`The Codex access token lives ${Math.floor((expiresAt - now) / 60_000)} more minutes, fewer than ${minutes}.`)
    // Only the fields Codex needs to make requests, named one by one, with the refresh token blank
    // and no API key. The id token says who is signed in; it cannot get a new token.
    const copy = {
      auth_mode: typeof auth.auth_mode === 'string' ? auth.auth_mode : 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: typeof tokens.id_token === 'string' ? tokens.id_token : '',
        access_token: tokens.access_token,
        refresh_token: '',
        account_id: typeof tokens.account_id === 'string' ? tokens.account_id : '',
      },
      last_refresh: typeof auth.last_refresh === 'string' ? auth.last_refresh : new Date().toISOString(),
    }
    const values = [tokens.access_token, tokens.id_token].filter((v) => typeof v === 'string' && v.length >= 16)
    return { held: { app, file: '.codex/auth.json', json: `${JSON.stringify(copy, null, 2)}\n`, values }, minutesLeft: Math.floor((expiresAt - now) / 60_000) }
  }
  if (app === 'claude') {
    const key = openRouterKey()
    const settings = {
      env: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_AUTH_TOKEN: key,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: HAIKU,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: HAIKU,
        ANTHROPIC_SMALL_FAST_MODEL: HAIKU,
      },
    }
    return { held: { app, file: '.claude/settings.json', json: `${JSON.stringify(settings, null, 2)}\n`, values: [key] }, minutesLeft: null }
  }
  throw new Error(`Nothing is taken for ${app}.`)
}

/** Writes the held file into the Mac user's home, readable by that user alone. */
export async function inject(id, held) {
  if (!INSTANCE.test(id) || !held?.file) throw new Error('inject: not a Mac instance or nothing held.')
  const dir = held.file.split('/')[0]
  const script = `set -e; umask 077; mkdir -p "$HOME/${dir}"; chmod 700 "$HOME/${dir}"; cat > "$HOME/${held.file}.new"; chmod 600 "$HOME/${held.file}.new"; mv -f "$HOME/${held.file}.new" "$HOME/${held.file}"; echo WROTE`
  const { code, out } = await onMac(id, `sh -c '${script}'`, { input: held.json, timeout: 120_000 })
  if (code !== 0 || !out.includes('WROTE')) throw new Error(`The sign-in could not be written on the Mac (exit ${code}).`)
}

// Where on the Mac a copy could land: the user's home (Library too), the temporary folders, and logs
const LOOK_IN = ['/Users/runner', '/tmp', '/private/tmp', '/private/var/folders', '/private/var/log', '/Library/Logs']

/**
 * Lists the files on the Mac that hold any of the held values, by name only. The values go in on
 * standard input, and grep is told to print names and no line. A look that does not finish is
 * never taken for "nothing there".
 */
export async function filesHolding(id, held) {
  if (!INSTANCE.test(id) || !held?.values?.length) return []
  const script = `sudo grep -rlsF -f /dev/stdin -- ${LOOK_IN.map((d) => `"${d}"`).join(' ')} 2>/dev/null; c=$?; [ $c -le 1 ] && echo LOOKED-ALL`
  const { out } = await onMac(id, `sh -c '${script}'`, { input: `${held.values.join('\n')}\n`, timeout: 600_000 })
  const lines = out.split('\n').filter(Boolean)
  if (lines.at(-1) !== 'LOOKED-ALL') return ['(the look for the credential did not finish)']
  return lines.slice(0, -1)
}

// Overwrites a file with zeros as long as itself, then deletes it. macOS has no shred.
const OVERWRITE = 'ow() { [ -e "$1" ] || return 0; n=$(stat -f%z "$1" 2>/dev/null || echo 0); if [ "$n" -gt 0 ]; then dd if=/dev/zero of="$1" bs="$n" count=1 conv=notrunc 2>/dev/null; sync; fi; rm -f "$1"; }'

/**
 * Takes every trace of the credential off the Mac: both files overwritten and deleted (whichever
 * app this run used), the terminal that ran the agent app ended with every process in it, and any
 * other file that took a copy overwritten and deleted. Resolves with the files that still hold a
 * value afterwards, which should be none. Safe to call with `held` null: the files are wiped all
 * the same, only the look for copies elsewhere needs the values.
 */
export async function wipe(id, held) {
  if (!INSTANCE.test(id)) return []
  const script = [
    OVERWRITE,
    'for f in "$HOME/.codex/auth.json" "$HOME/.codex/auth.json.new" "$HOME/.claude/settings.json" "$HOME/.claude/settings.json.new"; do ow "$f"; done',
    // The agent app and everything it started run inside the tmux server, which takes them with it
    '/opt/homebrew/bin/tmux kill-server >/dev/null 2>&1 || true',
    'echo WIPED',
  ].join('; ')
  await onMac(id, `bash -c '${script}'`, { timeout: 120_000 })
  if (!held) return []
  const found = (await filesHolding(id, held)).filter((f) => f.startsWith('/'))
  if (found.length) await onMac(id, `sudo bash -c '${OVERWRITE}; while IFS= read -r f; do ow "$f"; done'`, { input: `${found.join('\n')}\n`, timeout: 300_000 })
  return filesHolding(id, held)
}

/** `text` with every held value, and anything shaped like a credential, put out of sight. */
export function redact(text, held) {
  let out = String(text)
  for (const v of held?.values ?? []) out = out.split(v).join('[credential removed]')
  return out
    .replace(/sk-or-v1-[A-Za-z0-9]{16,}/g, '[credential removed]')
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[credential removed]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[credential removed]')
    .replace(/\b(?:sk|rt|at)-[A-Za-z0-9_-]{24,}/g, '[credential removed]')
}

/** Whether `text` holds a held value or anything shaped like a credential. */
export function holdsSecret(text, held) {
  return redact(text, held) !== String(text)
}
