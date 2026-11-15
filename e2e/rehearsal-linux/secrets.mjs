// The one place the rehearsal touches a real credential. It signs a throwaway agent app inside a
// rehearsal container in with a copy of the owner's access token, and nothing more:
//
// - Codex: an auth.json built in memory from ~/.codex/auth.json with its refresh token blanked,
//   piped into the container's `ana` as ~/.codex/auth.json, mode 600. Never a file on the host.
// - Claude Code: the access token and its expiry, read in memory from ~/.claude/.credentials.json,
//   handed to the tmux server that runs the agent's terminal through CLAUDE_CODE_OAUTH_TOKEN,
//   by way of the standard input of `docker exec`, so that it is on no command line. No file.
//
// No refresh token is copied anywhere. Nothing here prints, logs or returns a token to a caller
// outside this module except as the opaque object `held`, which a caller hands back to `wipe`,
// `inject*` and `redact`. `wipe` overwrites and deletes the token's file in the container and ends
// what holds the variable, and is called when a run ends, also when it fails.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()

/** Runs `sudo docker <args>`, with `input` on its standard input, and resolves with its exit code. Its output is dropped. */
function docker(args, input) {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-n', 'docker', ...args], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => resolve(-1))
    child.on('close', (code) => resolve(code ?? -1))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/** Runs `sudo docker <args>` and resolves with its standard output, which must not be a secret. */
function dockerOut(args, input) {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn('sudo', ['-n', 'docker', ...args], { stdio: ['pipe', 'pipe', 'ignore'] })
    child.stdout.on('data', (d) => {
      out += d
    })
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(out))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
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

/**
 * A fresh copy of the token for one run of `app` ('codex' or 'claude'), held in memory, provided
 * it lives at least `minutes` more. Resolves with `{ held, expiresAt, minutesLeft }`, or throws an
 * error whose message names no part of a token.
 */
export function take(app, minutes) {
  const now = Date.now()
  if (app === 'codex') {
    const auth = JSON.parse(readFileSync(join(HOME, '.codex', 'auth.json'), 'utf8'))
    const tokens = auth?.tokens
    if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) throw new Error('Codex has no access token on this machine.')
    const expiresAt = jwtExpiry(tokens.access_token)
    if (!expiresAt) throw new Error('The expiry of the Codex access token could not be read.')
    if (expiresAt - now < minutes * 60_000) throw new Error(`The Codex access token lives ${Math.floor((expiresAt - now) / 60_000)} more minutes, fewer than ${minutes}.`)
    // The copy: everything Codex needs to make requests, with the refresh token blanked
    const copy = { ...auth, tokens: { ...tokens, refresh_token: '' } }
    const values = [tokens.access_token, tokens.id_token].filter((v) => typeof v === 'string' && v.length >= 16)
    return { held: { app, json: `${JSON.stringify(copy, null, 2)}\n`, values }, expiresAt, minutesLeft: Math.floor((expiresAt - now) / 60_000) }
  }
  if (app === 'claude') {
    const creds = JSON.parse(readFileSync(join(HOME, '.claude', '.credentials.json'), 'utf8'))
    const oauth = creds?.claudeAiOauth
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) throw new Error('Claude Code has no access token on this machine.')
    const expiresAt = Number(oauth.expiresAt)
    if (!Number.isFinite(expiresAt)) throw new Error('The expiry of the Claude Code access token could not be read.')
    if (expiresAt - now < minutes * 60_000) throw new Error(`The Claude Code access token lives ${Math.floor((expiresAt - now) / 60_000)} more minutes, fewer than ${minutes}.`)
    if (/[\r\n\0]/.test(oauth.accessToken)) throw new Error('The Claude Code access token is not one line.')
    return { held: { app, token: oauth.accessToken, values: [oauth.accessToken] }, expiresAt, minutesLeft: Math.floor((expiresAt - now) / 60_000) }
  }
  throw new Error(`No token is taken for ${app}.`)
}

const CONTAINER = /^it-rehearsal-[a-z0-9-]+$/

/** Writes the Codex copy into the container as ana's ~/.codex/auth.json, readable by her alone. */
export async function injectCodex(container, held) {
  if (!CONTAINER.test(container) || held?.app !== 'codex') throw new Error('injectCodex: not a rehearsal container or not a Codex token.')
  const script = 'set -e; umask 077; mkdir -p "$HOME/.codex"; chmod 700 "$HOME/.codex"; cat > "$HOME/.codex/auth.json.new"; mv -f "$HOME/.codex/auth.json.new" "$HOME/.codex/auth.json"'
  const code = await docker(['exec', '-i', '-u', 'ana', '-e', 'HOME=/home/ana', container, 'sh', '-c', script], held.json)
  if (code !== 0) throw new Error(`The Codex sign-in could not be written into the container (exit ${code}).`)
}

/**
 * Starts the tmux server that the agent's terminal shows, as ana in a login session (su -l, so
 * that PAM opens a logind session and sets XDG_RUNTIME_DIR), with `env` (plain settings such as
 * IT_INSTALL_BASE) and, for Claude Code, CLAUDE_CODE_OAUTH_TOKEN, all passed through standard input.
 */
export async function startAgentShell(container, held, env, { session = 'agent', cols = 104, rows = 56, dir = '/home/ana/work' } = {}) {
  if (!CONTAINER.test(container)) throw new Error('startAgentShell: not a rehearsal container.')
  const names = Object.keys(env)
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || /[\r\n\0]/.test(String(v))) throw new Error(`startAgentShell: ${k} is not a plain setting.`)
  }
  const lines = names.map((k) => String(env[k]))
  const keep = [...names]
  if (held?.app === 'claude') {
    lines.push(held.token)
    keep.push('CLAUDE_CODE_OAUTH_TOKEN')
  }
  const reads = names.map((k) => `IFS= read -r ${k}; export ${k};`).join(' ')
  const readToken = held?.app === 'claude' ? 'IFS= read -r CLAUDE_CODE_OAUTH_TOKEN; export CLAUDE_CODE_OAUTH_TOKEN;' : ''
  const inner = `mkdir -p ${dir} && tmux new-session -d -s ${session} -x ${cols} -y ${rows} -c ${dir}`
  const script = `${reads} ${readToken} exec su -l -w ${keep.join(',') || 'TERM'} ana -c '${inner}'`
  const code = await docker(['exec', '-i', container, 'bash', '-c', script], `${lines.join('\n')}\n`)
  if (code !== 0) throw new Error(`The agent's terminal could not be started (exit ${code}).`)
}

/**
 * Gives ana's systemd user manager CLAUDE_CODE_OAUTH_TOKEN, in memory, so that a conversation It
 * reopens by itself (Auto-wake) is signed in as the one the person started. Used only by the
 * flows that close the agent app and need it reopened. `wipe` takes it away again.
 */
export async function shareWithUserManager(container, held) {
  if (!CONTAINER.test(container) || held?.app !== 'claude') throw new Error('shareWithUserManager: not a rehearsal container or not a Claude token.')
  const script = "IFS= read -r CLAUDE_CODE_OAUTH_TOKEN; export CLAUDE_CODE_OAUTH_TOKEN; exec su -l -w CLAUDE_CODE_OAUTH_TOKEN ana -c 'systemctl --user import-environment CLAUDE_CODE_OAUTH_TOKEN'"
  const code = await docker(['exec', '-i', container, 'bash', '-c', script], `${held.token}\n`)
  if (code !== 0) throw new Error(`The user manager could not be given the token (exit ${code}).`)
}

/**
 * Lists the files under the container's folders `dirs` that hold any of the token's values, by
 * name only. The values go in on standard input, and grep is told to print names and no line.
 */
export async function filesHolding(container, held, dirs = ['/home/ana', '/tmp', '/opt/person-profile']) {
  if (!CONTAINER.test(container) || !held?.values?.length) return []
  const script = `grep -rlsF -f /dev/stdin -- ${dirs.map((d) => `'${d}'`).join(' ')} 2>/dev/null || true`
  const out = await dockerOut(['exec', '-i', container, 'sh', '-c', script], `${held.values.join('\n')}\n`)
  return out.split('\n').filter(Boolean)
}

/**
 * Takes every trace of the token out of the container: the Codex file overwritten and deleted,
 * the tmux server that holds the variable ended, and the variable taken from the user manager.
 * Resolves with the files that still hold a value afterwards, which should be none.
 */
export async function wipe(container, held) {
  if (!CONTAINER.test(container)) return []
  const script = [
    'f=/home/ana/.codex/auth.json; if [ -e "$f" ]; then shred -fzu -n 2 "$f" 2>/dev/null || rm -f "$f"; fi',
    'f=/home/ana/.codex/auth.json.new; if [ -e "$f" ]; then shred -fzu -n 2 "$f" 2>/dev/null || rm -f "$f"; fi',
    "su -l ana -c 'tmux kill-server' >/dev/null 2>&1 || true",
    "su -l ana -c 'systemctl --user unset-environment CLAUDE_CODE_OAUTH_TOKEN' >/dev/null 2>&1 || true",
  ].join('; ')
  await docker(['exec', container, 'bash', '-c', script])
  return held ? filesHolding(container, held) : []
}

/** `text` with every value of the token, and anything shaped like a credential, put out of sight. */
export function redact(text, held) {
  let out = String(text)
  for (const v of held?.values ?? []) out = out.split(v).join('[token removed]')
  return out
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[token removed]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[token removed]')
    .replace(/\b(?:sk|rt|at)-[A-Za-z0-9_-]{24,}/g, '[token removed]')
}

/** Whether `text` holds a value of the token or anything shaped like a credential. */
export function holdsToken(text, held) {
  return redact(text, held) !== String(text)
}
