// JSON given to the real standalone program through each shell on Windows, as an agent writes it:
// Windows PowerShell 5.1, PowerShell 7, cmd and Git Bash. Windows PowerShell 5.1 hands a program
// the JSON in a single-quoted argument without its double quotes kept, and It reads it whole from
// its own command line (packages/cli/src/windows-args.ts). A stand-in for It's service on this
// machine notes what each command sends, and the check is that `it patch` and `it set` send the
// very JSON that was written, and that `it create --state` and `it tour answer` take theirs.
//
// node e2e/windows-json.mjs <the program>. Run on Windows alone, by the main workflow's job that
// starts the Windows program.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const program = process.argv[2] && path.resolve(process.argv[2])
if (process.platform !== 'win32' || !program || !existsSync(program)) {
  console.error('Usage, on Windows: node e2e/windows-json.mjs <the standalone program>')
  process.exit(2)
}

// The stand-in: it answers what the command asks before a call, and notes each call
const calls = []
const server = http.createServer((req, res) => {
  const chunks = []
  req
    .on('data', (c) => chunks.push(c))
    .on('end', () => {
      const json = (body) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method === 'GET' && req.url === '/cli/config') return json({ protocol: 1, issuer: url })
      if (req.method === 'GET' && req.url === '/health') return json({ ok: true, it: true })
      if (req.method === 'POST' && req.url === '/bridge/token') return json({ token: 'a-token', expires_in: 300 })
      let call = {}
      try {
        call = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {}
      calls.push({ path: call.path, args: call.args?.[0] ?? {} })
      json({ status: 'success', value: call.path === 'state:patch' ? { revision: 2 } : null, logLines: [] })
    })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`
const home = mkdtempSync(path.join(os.tmpdir(), 'it-windows-json-'))
writeFileSync(path.join(home, 'token.json'), JSON.stringify({ token: 'a-token', exp: Math.floor(Date.now() / 1000) + 3600, machine: 'machine-1', site: url }))
const env = { ...process.env, IT_HOME: home, IT_URL: url, IT_SITE_URL: url, DO_NOT_TRACK: '1', IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage' }

const opts = { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 }
const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(existsSync)
const has = (shell) => spawnSync(shell, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0
/**
 * Each shell, and how a command is written in it: the words after the program, each as an agent
 * writes it there. In PowerShell a word is in single quotes, with an apostrophe written as two; in
 * Git Bash in single quotes too; in cmd, JSON is written bare, which cmd hands on as it is.
 */
const shells = [
  [
    'Windows PowerShell 5.1',
    has('powershell.exe') &&
      ((words) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& '${program}' ${words.map(ps).join(' ')}`], opts)),
  ],
  [
    'PowerShell 7',
    has('pwsh') && ((words) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `& '${program}' ${words.map(ps).join(' ')}`], opts)),
  ],
  ['cmd', (words) => spawnSync('cmd.exe', ['/d', '/s', '/c', `""${program}" ${words.map(bare).join(' ')}"`], { ...opts, windowsVerbatimArguments: true })],
  ['Git Bash', gitBash && ((words) => spawnSync(gitBash, ['-c', `'${program.replaceAll('\\', '/')}' ${words.map(sh).join(' ')}`], opts))],
]
const ps = (w) => `'${w.replaceAll("'", "''")}'`
const sh = (w) => `'${w.replaceAll("'", "'\\''")}'`
const bare = (w) => (/^[[{]/.test(w) ? w : /[\s"<>|&^]/.test(w) ? `"${w}"` : w)

// What is written, and what It must send for it
const JSONS = [
  { a: 1 },
  { note: 'two words', more: 'and three more' },
  { say: 'she said "hi" twice' },
  { path: 'C:\\Users\\ana\\', n: 'a\\b' },
  { say: 'Café 12×12 — ★ 支付' },
  { say: 'a } and a ] and a {' },
  { steps: { build: 'done' }, list: ['c1', 'c 2'] },
]
let failed = 0
const check = (what, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `\n     ${detail}`}`)
  if (!ok) failed++
}
for (const [name, run] of shells) {
  if (!run) {
    console.log(`--   ${name} is not on this machine`)
    continue
  }
  for (const value of JSONS) {
    // Written as JSON is in that shell: in cmd every letter outside ASCII is left to an escape, since cmd's own code page decides how a typed letter reaches the program
    const written =
      name === 'cmd' ? JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) : JSON.stringify(value)
    calls.length = 0
    const ran = run(['patch', 'board', written, '--if-revision', '3'])
    const sent = calls.find((c) => c.path === 'state:patch')?.args
    check(
      `${name}: it patch board ${written} --if-revision 3`,
      ran.status === 0 && sent?.patch === JSON.stringify(value) && sent?.baseRevision === 3,
      `exit ${ran.status}, sent ${JSON.stringify(sent)}, said ${ran.stderr.trim().slice(0, 400)}`,
    )
  }
  calls.length = 0
  const set = run(['set', 'board', 'order', '["c1","c 2"]'])
  const setSent = calls.find((c) => c.path === 'state:patch')?.args
  check(
    `${name}: it set board order ["c1","c 2"]`,
    set.status === 0 && setSent?.patch === '{"order":["c1","c 2"]}',
    `exit ${set.status}, sent ${JSON.stringify(setSent)}, said ${set.stderr.trim().slice(0, 400)}`,
  )
  // These go on to ask for more than the stand-in answers; what is checked is that their JSON was taken, as JSON
  for (const words of [
    ['create', 'Plan', '--html', '<p>hi</p>', '--state', '{"steps":{"build":"not yet"}}'],
    ['tour', 'answer', 'k57abc', '{"say":"Right: twelve times twelve is 144."}', '--no-wait'],
  ]) {
    const ran = run(words)
    const said = `${ran.stdout}${ran.stderr}`
    check(`${name}: it ${words.join(' ')} takes its JSON`, !/not valid JSON|does not know what to do with/.test(said), said.trim().slice(0, 400))
  }
}
server.close()
rmSync(home, { recursive: true, force: true })
if (failed) {
  console.error(`${failed} failed`)
  process.exit(1)
}
