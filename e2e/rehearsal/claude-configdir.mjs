// Whether Claude Code, started with CLAUDE_CONFIG_DIR set to the folder it uses by default
// (<home>\.claude), as It's Auto-wake starts it, still finds its configuration, which by default
// is <home>\.claude.json: one `claude -p` as a person's would run (making <home>\.claude.json),
// then the same with CLAUDE_CONFIG_DIR=<home>\.claude. A throwaway profile and the harness's own
// Claude Code, lent the owner's access token in its environment only; what is kept is scrubbed.
//   node e2e/rehearsal/claude-configdir.mjs [--version 2.1.322]
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { claudeAccess, scrub, shredOnExit } from './credentials.mjs'
import { profileEnv, run, runFolders, WORK } from './lib.mjs'

const i = process.argv.indexOf('--version')
const version = i === -1 ? '2.1.322' : process.argv[i + 1]
shredOnExit()
const f = runFolders('claude-configdir')
const exe = path.join(WORK, 'apps', `claude-${version}`, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
const env = { ...profileEnv(f, { port: 5650, appBin: path.dirname(exe), guard: true }), ...claudeAccess().env }
const lines = []
const ask = async (label, extra) => {
  const r = await run(exe, ['-p', 'Reply with the single word OK and nothing else.'], { env: { ...env, ...extra }, cwd: f.work, ms: 180_000, input: '' })
  lines.push(`${label}: exit ${r.code}; ${scrub(`${r.out}\n${r.err}`).text.trim().replace(/\s+/g, ' ').slice(0, 400)}`)
}
await ask('plain (no CLAUDE_CONFIG_DIR)', {})
lines.push(`<home>\\.claude.json exists: ${existsSync(path.join(f.home, '.claude.json'))}; <home>\\.claude\\.claude.json exists: ${existsSync(path.join(f.home, '.claude', '.claude.json'))}`)
await ask('CLAUDE_CONFIG_DIR=<home>\\.claude (as Auto-wake sets it)', { CLAUDE_CONFIG_DIR: path.join(f.home, '.claude') })
const text = scrub(lines.join('\n')).text
writeFileSync(path.join(f.results, '..', 'claude-configdir.txt'), `${new Date().toISOString()} Claude Code ${version}\n${text}\n`, { flag: 'a' })
console.log(text)
rmSync(f.top, { recursive: true, force: true })
rmSync(f.results, { recursive: true, force: true })
process.exit(0)
