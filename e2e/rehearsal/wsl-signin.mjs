// The harness's Claude Code sign-in for a Linux home inside a WSL distribution of the rehearsal's
// own: the owner's current access token alone (credentials.mjs), handed over stdin (never in a
// command line or a file on Windows) into `~/.claude/.credentials.json`, made owner-only (0600)
// before anything is in it. `shred` overwrites it and removes it. Prints only the expiry.
//   node e2e/rehearsal/wsl-signin.mjs <distribution> <user> write|shred
import { spawnSync } from 'node:child_process'
import { claudeCredentialsContent } from './credentials.mjs'

const [distro, user, what] = process.argv.slice(2)
if (!/^it-rehearsal/.test(distro ?? '')) throw new Error('only a distribution of the rehearsal\'s own')
const run = (script, input) =>
  spawnSync('wsl.exe', ['-d', distro, '-u', user, '--exec', 'sh', '-c', script], { input, encoding: 'utf8', windowsHide: true })
if (what === 'write') {
  const { content, expiresAt } = claudeCredentialsContent()
  const r = run('umask 077; mkdir -p ~/.claude; f=~/.claude/.credentials.json; [ -f "$f" ] && shred -u "$f"; : > "$f"; chmod 600 "$f"; cat > "$f"; stat -c %a "$f"', content)
  console.log(`mode ${r.stdout.trim()}, valid until ${new Date(expiresAt).toISOString()}`)
} else if (what === 'shred') {
  const r = run('f=~/.claude/.credentials.json; [ -f "$f" ] && shred -u "$f"; [ -e "$f" ] && echo left || echo gone')
  console.log(r.stdout.trim())
}
