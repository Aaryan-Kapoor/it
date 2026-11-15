// The rehearsal's guard, put first on the PATH of a run under the owner's own Windows account as
// `it.exe`. It passes every command on to the real It program unchanged, with the same
// arguments, standard input and output, and exit status, except the few that would register a
// background service for the owner's account, ask the owner's own It to stop, or write the
// owner's registry: `setup` or `login` without `--no-service` (but `setup --refresh`),
// `service install`, `upgrade`, and `uninstall`. Those are refused, and written down in the
// file IT_REHEARSAL_GUARD_LOG names, so that the run says a real agent tried one.
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const real = process.env.IT_REHEARSAL_REAL_IT
const args = process.argv.slice(2)
const words = args.filter((a) => !a.startsWith('-'))
const flags = new Set(args.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]))
const cmd = words[0]
let refused: string | null = null
if (process.env.IT_REHEARSAL_GUARD === 'owner') {
  if ((cmd === 'setup' || cmd === 'login') && !flags.has('--no-service') && !flags.has('--refresh') && !flags.has('--help'))
    refused = `${cmd} without --no-service`
  else if (cmd === 'service' && words[1] === 'install') refused = 'service install'
  else if (cmd === 'upgrade' && !flags.has('--check')) refused = 'upgrade'
  else if (cmd === 'uninstall') refused = 'uninstall'
}
if (refused) {
  try {
    if (process.env.IT_REHEARSAL_GUARD_LOG) appendFileSync(process.env.IT_REHEARSAL_GUARD_LOG, `${new Date().toISOString()} refused: it ${args.join(' ').slice(0, 300)}\n`)
  } catch {}
  process.stderr.write(
    `${JSON.stringify({ error: { code: 'rehearsal_guard', message: `This rehearsal does not let \`it ${refused}\` run under the owner's Windows account, since it would touch the owner's own It.` } })}\n`,
  )
  process.exit(64)
}
if (!real) {
  process.stderr.write('IT_REHEARSAL_REAL_IT is not set\n')
  process.exit(70)
}
const r = spawnSync(real, args, { stdio: 'inherit', windowsHide: false })
process.exit(r.status ?? 1)
