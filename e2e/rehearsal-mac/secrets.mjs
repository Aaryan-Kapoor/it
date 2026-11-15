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
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
export const NSC = '/tmp/claude-1000/-home-cbak-programming-it/51f6f360-74f1-48c2-9f53-3ca473781de1/scratchpad/nsc/bin/nsc'
const ENV_FILE = '/home/cbak/programming/it/.env'
export const HAIKU = 'anthropic/claude-haiku-5.5'
const INSTANCE = /^[a-z0-9]{6,40}$/
/** The environment every program this harness starts is given: enough to run, and no credential. */
export const SAFE_ENV = Object.fromEntries(['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TMPDIR', 'XDG_RUNTIME_DIR'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))

/**
 * Runs `command` on the Mac `id` as its user, with `input` on its standard input, and resolves
 * with { code, out }. `out` is the command's standard output, which must never be a secret; its
 * standard error is dropped.
 */
export function onMac(id, command, { input = '', timeout = 300_000, binary = false } = {}) {
  if (!INSTANCE.test(id)) return Promise.resolve({ code: -1, out: binary ? Buffer.alloc(0) : '' })
  return new Promise((resolve) => {
    const chunks = []
    const child = spawn(NSC, ['ssh', '-T', id, command], { stdio: ['pipe', 'pipe', 'ignore'], env: SAFE_ENV })
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

/** SHA-256 of each held value, which says whether two reads were of the same values and nothing more. */
export function fingerprint(held) {
  return (held?.values ?? []).map((v) => createHash('sha256').update(v).digest('hex')).sort().join(',')
}

// Overwrites a file with zeros in fixed blocks, every step checked, then deletes it, and says
// FAILED <path> where it could not. A symlink is removed and never followed: a target that holds a
// value is found by the look and overwritten on its own. macOS has no shred, and on APFS an
// overwrite cannot reach earlier copy-on-write blocks or snapshots; the rented Mac is destroyed
// after each run, which is what ends those.
const OVERWRITE = [
  'ow() {',
  '[ -L "$1" ] && { rm -f "$1" || echo "FAILED $1"; return 0; };',
  '[ -f "$1" ] || return 0;',
  'n=$(stat -f%z "$1") || { echo "FAILED $1"; return 0; };',
  'if [ "$n" -gt 0 ]; then dd if=/dev/zero of="$1" bs=65536 count=$(( (n + 65535) / 65536 )) conv=notrunc 2>/dev/null || { echo "FAILED $1"; return 0; }; sync; fi;',
  'rm -f "$1" || echo "FAILED $1";',
  '}',
].join(' ')
const FILES = '"$HOME/.codex/auth.json" "$HOME/.codex/auth.json.new" "$HOME/.claude/settings.json" "$HOME/.claude/settings.json.new"'

/**
 * Writes the held file into the Mac user's home, readable by that user alone, and leaves a watch
 * on the Mac that overwrites and deletes it at `until` (seconds since 1970) whatever happens here,
 * so that a crash of this machine or a lost connection cannot leave it there past the run.
 */
export async function inject(id, held, until) {
  if (!INSTANCE.test(id) || !held?.file) throw new Error('inject: not a Mac instance or nothing held.')
  if (!Number.isInteger(until)) throw new Error('inject: give the time the watch wipes the file.')
  const dir = held.file.split('/')[0]
  const script = [
    'set -eu; umask 077',
    // The folder is a real folder of runner's, not a link, and the staging file is made new
    `d="$HOME/${dir}"; [ -L "$d" ] && exit 3; mkdir -p "$d"; chmod 700 "$d"`,
    `f="$HOME/${held.file}"; [ -L "$f" ] && rm -f "$f"; rm -f "$f.new"`,
    'set -C; cat > "$f.new"; set +C; mv -f "$f.new" "$f"',
    // The watch, detached from this connection
    `bash -c 'trap "" HUP; ${OVERWRITE.replace(/'/g, '')}; while [ $(date +%s) -lt ${until} ]; do sleep 20; done; for f in ${FILES}; do ow "$f"; done' </dev/null >/dev/null 2>&1 &`,
    'echo WROTE',
  ].join('\n')
  const { code, out } = await onMac(id, `bash -c "$(cat <<'SCRIPT'\n${script}\nSCRIPT\n)"`, { input: held.json, timeout: 120_000 })
  if (code !== 0 || !out.includes('WROTE')) throw new Error(`The sign-in could not be written on the Mac (exit ${code}).`)
}

// Where on the Mac a copy could land: the user's home (Library too), the harness's own folder,
// root's home, the temporary folders, and logs
// Folders by name that hold only toolchains, caches and the build under test, gigabytes that no
// agent app writes a sign-in into, and that would take the look many minutes
const SKIP = ['.rustup', '.cargo', '.npm', 'go', 'Developer', 'Caches', 'stand-in', 'rehearsal-upload']
const LOOK_IN = ['/Users', '/private/var/root', '/tmp', '/private/tmp', '/private/var/folders', '/private/var/log', '/Library/Logs']

/**
 * Short pieces of each value to look for. macOS's grep is slow with patterns as long as a token
 * (two of them took minutes over the home folder), and a file that holds any 32 characters of a
 * value holds a copy of it, whole or in part. The pieces are taken from the second half, so that
 * the header every token of its kind shares is not among them.
 */
function slices(held) {
  const out = []
  for (const v of held.values) {
    if (v.length < 64) {
      out.push(v)
      continue
    }
    const half = Math.floor(v.length / 2)
    for (const at of [half, Math.floor((half + v.length - 32) / 2), v.length - 32]) out.push(v.slice(at, at + 32))
  }
  return out
}

/**
 * Lists the files on the Mac that hold any of the held values, by name only. The values go in on
 * standard input, and grep is told to print names and no line. A look that does not finish is
 * never taken for "nothing there".
 */
export async function filesHolding(id, held) {
  if (!INSTANCE.test(id) || !held?.values?.length) return []
  const script = `sudo grep -rlsF -D skip ${SKIP.map((d) => `--exclude-dir=${d}`).join(' ')} -f /dev/stdin -- ${LOOK_IN.map((d) => `"${d}"`).join(' ')} 2>/dev/null; c=$?; [ $c -le 1 ] && echo LOOKED-ALL`
  const { out } = await onMac(id, `sh -c '${script}'`, { input: `${slices(held).join('\n')}\n`, timeout: 600_000 })
  const lines = out.split('\n').filter(Boolean)
  if (lines.at(-1) !== 'LOOKED-ALL') return ['(the look for the credential did not finish)']
  return lines.slice(0, -1)
}

/**
 * Takes every trace of the credential off the Mac: first the terminal that ran the agent app is
 * ended with every agent process, so that nothing writes the file again; then both apps' files are
 * overwritten and deleted, and any other file that took a copy. Resolves with what is left: the
 * files that still hold a value, and "(...)" lines for anything that could not be done or checked.
 * With `held` null the files are wiped all the same, and the result says that no look was made.
 */
export async function wipe(id, held) {
  if (!INSTANCE.test(id)) return ['(not a Mac instance)']
  const script = [
    OVERWRITE,
    '/opt/homebrew/bin/tmux kill-server >/dev/null 2>&1 || true',
    'pkill -TERM -u runner -x codex >/dev/null 2>&1; pkill -TERM -u runner -x claude >/dev/null 2>&1; pkill -TERM -u runner -f "node.*(@openai/codex|claude-code)" >/dev/null 2>&1; sleep 2',
    `for f in ${FILES}; do ow "$f"; done`,
    `left=0; for f in ${FILES}; do [ -e "$f" ] || [ -L "$f" ] && left=1; done; [ $left = 0 ] && echo WIPED`,
  ].join('; ')
  const first = await onMac(id, `bash -c '${script}'`, { timeout: 120_000 })
  const problems = []
  if (!first.out.includes('WIPED')) problems.push('(the credential files could not be shown to be gone)')
  for (const l of first.out.split('\n')) if (l.startsWith('FAILED ')) problems.push(`(could not overwrite ${l.slice(7)})`)
  if (!held) return [...problems, '(no look for copies was made: the values were not held)']
  const found = (await filesHolding(id, held)).filter((f) => f.startsWith('/'))
  if (found.length) {
    const r = await onMac(id, `sudo bash -c '${OVERWRITE}; while IFS= read -r f; do ow "$f"; done'`, { input: `${found.join('\n')}\n`, timeout: 300_000 })
    for (const l of r.out.split('\n')) if (l.startsWith('FAILED ')) problems.push(`(could not overwrite ${l.slice(7)})`)
  }
  return [...problems, ...(await filesHolding(id, held))]
}

const SHAPES = [
  /sk-or-v1-[A-Za-z0-9_-]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:sk|rt|at)-[A-Za-z0-9_-]{24,}/g,
]

/** `text` with every held value, and anything shaped like a credential, put out of sight. */
export function redact(text, held) {
  let out = String(text)
  for (const v of held?.values ?? []) out = out.split(v).join('[credential removed]')
  for (const re of SHAPES) out = out.replace(re, '[credential removed]')
  return out
}

/**
 * Whether `text` holds a held value or anything shaped like a credential, also where a value was
 * broken by line ends, spaces or a terminal's control sequences, which redaction cannot find.
 */
export function holdsSecret(text, held) {
  const raw = String(text)
  if (redact(raw, held) !== raw) return true
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the terminal's escape sequences are what is taken out
  const flat = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\s─-╿│]+/g, '')
  if ((held?.values ?? []).some((v) => flat.includes(v.replace(/\s+/g, '')))) return true
  return SHAPES.some((re) => new RegExp(re.source).test(flat))
}
