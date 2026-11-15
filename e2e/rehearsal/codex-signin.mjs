// Whether a throwaway Codex signs in with what the harness lends it (the access token alone,
// unless IT_REHEARSAL_LEND_ID_TOKEN=1): `codex login status`, then one short `codex exec`, in a
// throwaway profile, on Codex's own default settings. What is kept is scrubbed; the lent file is
// shredded at the end, whatever happens.
//
//   node e2e/rehearsal/codex-signin.mjs [--version 0.169.0] [--out <file>]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { codexAuth, scrub, shredAll, shredLedger, shredOnExit } from './credentials.mjs'
import { profileEnv, run, runFolders, WORK } from './lib.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const version = arg('version', '0.169.0')
const out = arg('out', 'D:\\it-rehearsal\\2026-11-15\\codex-signin.txt')
shredOnExit()
shredLedger()
const id = `codex-signin-${process.env.IT_REHEARSAL_LEND_ID_TOKEN === '1' ? 'with-id' : 'access-only'}`
const f = runFolders(id)
const appBin = path.join(WORK, 'apps', `codex-${version}`, 'node_modules', '.bin')
const codexJs = path.join(WORK, 'apps', `codex-${version}`, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
const env = profileEnv(f, { port: 5640, appBin, guard: true })
mkdirSync(f.codexHome, { recursive: true })
writeFileSync(path.join(f.codexHome, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\ncli_auth_credentials_store = "file"\n')
const auth = codexAuth(f.codexHome)
const lines = [`${new Date().toISOString()} ${id}: Codex ${version}; lent token valid until ${new Date(auth.expiresAt).toISOString()}`]
const status = await run(process.execPath, [codexJs, 'login', 'status'], { env, cwd: f.work, ms: 60_000 })
// Scrubbed whole, before anything is cut short, so that no part of a token is left behind
lines.push(`codex login status: exit ${status.code}; ${scrub(`${status.out}${status.err}`).text.trim().replace(/\s+/g, ' ').slice(0, 400)}`)
const exec = await run(process.execPath, [codexJs, 'exec', '--skip-git-repo-check', 'Reply with the single word OK and nothing else.'], { env, cwd: f.work, ms: 240_000, input: '' })
lines.push(`codex exec: exit ${exec.code}; ${scrub(`${exec.out}\n${exec.err}`).text.trim().split(/\r?\n/).slice(-8).join(' / ').slice(0, 1200)}`)
const ok = shredAll()
lines.push(`the lent sign-in was overwritten and deleted: ${ok}`)
const text = scrub(lines.join('\n')).text
writeFileSync(out, `${text}\n`, { flag: 'a' })
console.log(text)
try {
  rmSync(f.top, { recursive: true, force: true })
  rmSync(f.results, { recursive: true, force: true })
} catch {}
process.exit(0)
