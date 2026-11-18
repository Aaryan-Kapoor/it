// JSON given to the real standalone program through each shell on Windows, as an agent writes it:
// Windows PowerShell 5.1, PowerShell 7, cmd and Git Bash. Windows PowerShell 5.1 hands a program
// the JSON in a single-quoted argument without its double quotes kept, and It reads it whole from
// its own command line (packages/cli/src/windows-args.ts). A stand-in for It's service on this
// machine notes what each command sends, and the check is that `it patch` and `it set` send the
// very JSON that was written, and that `it create --state` and `it tour answer` take theirs. Each
// form the guide gives an agent for Windows (`it help page`) is written here as it gives it, and
// what the guide says `it set` changes in Windows PowerShell 5.1 is held to that shell.
//
// node e2e/windows-json.mjs <the program>. Run on Windows alone, by the main workflow's job that
// starts the Windows program.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const program = process.argv[2] && path.resolve(process.argv[2])
if (process.platform !== 'win32' || !program || !existsSync(program)) {
  console.error('Usage, on Windows: node e2e/windows-json.mjs <the standalone program>')
  process.exit(2)
}

// The stand-in: it answers what the command asks before a call, and notes each call. It answers
// `it tour answer` with an action of the tour's first page and that page's state, so that the
// command goes on to send its answer
const REQUEST = '0123456789abcdef0123456789abcdef'
const ANSWERS = {
  'state:patch': { revision: 2 },
  'state:get': { json: '{}', revision: 1 },
  'delivery:get': { id: 'k57abc', artifact: 'tour-start', payload: JSON.stringify({ part: 'sums', request: REQUEST }) },
}
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
      json({ status: 'success', value: ANSWERS[call.path] ?? null, logLines: [] })
    })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`
const home = mkdtempSync(path.join(os.tmpdir(), 'it-windows-json-'))
// A machine set up as It sets one up, so that the program asks the stand-in at all
writeFileSync(path.join(home, 'installation.json'), '{"product":"It","format":1,"about":"This folder holds an installation of It."}\n')
writeFileSync(path.join(home, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key: {} }))
writeFileSync(path.join(home, 'token.json'), JSON.stringify({ token: 'a-token', exp: Math.floor(Date.now() / 1000) + 3600, machine: 'machine-1', site: url }))
const env = { ...process.env, IT_HOME: home, IT_URL: url, IT_SITE_URL: url, DO_NOT_TRACK: '1', IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage' }

const opts = { env, windowsHide: true }
/** Runs a command and resolves with how it ended and what it said, without holding up the stand-in, which answers it meanwhile. */
const ran = (file, args, extra = {}) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { ...opts, ...extra })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    const timer = setTimeout(() => child.kill(), 60_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
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
    has('powershell.exe') && ((words) => ran('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& '${program}' ${words.map(ps).join(' ')}`])),
  ],
  ['PowerShell 7', has('pwsh') && ((words) => ran('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `& '${program}' ${words.map(ps).join(' ')}`]))],
  ['cmd', (words) => ran('cmd.exe', ['/d', '/s', '/c', `""${program}" ${words.map(bare).join(' ')}"`], { windowsVerbatimArguments: true })],
  // The command is given to Git Bash in a script file, as typed: given with -c on its command line, Git Bash's own reading of that line comes first
  [
    'Git Bash',
    gitBash &&
      ((words) => {
        const script = path.join(home, 'command.sh')
        writeFileSync(script, `'${program.replaceAll('\\', '/')}' ${words.map(sh).join(' ')}\n`)
        return ran(gitBash, [script])
      }),
  ],
]
const ps = (w) => `'${w.replaceAll("'", "''")}'`
const sh = (w) => `'${w.replaceAll("'", "'\\''")}'`
const bare = (w) => (/^[[{]/.test(w) ? w : /[\s"<>|&^]/.test(w) ? `"${w}"` : w)

// What is written, and what It must send for it
const JSONS = [
  { a: 1 },
  { note: 'two words', more: 'and three more' },
  { say: 'she said "hi" twice' },
  // A backslash, but none just before a quote with a switch after it, which PowerShell 7's older way could have built from one argument
  { path: 'C:\\Users\\ana', n: 'a\\b' },
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
    const done = await run(['patch', 'board', written, '--if-revision', '3'])
    const sent = calls.find((c) => c.path === 'state:patch')?.args
    check(
      `${name}: it patch board ${written} --if-revision 3`,
      done.status === 0 && sent?.patch === JSON.stringify(value) && sent?.baseRevision === 3,
      `exit ${done.status}, sent ${JSON.stringify(sent)}, said ${done.stderr.trim().slice(0, 400)}`,
    )
  }
  // Written as the guide has an agent write JSON on Windows, with every option before it: a path
  // with its backslashes doubled and one with forward slashes, a backslash just before a quote, a
  // dash in a string, an array of strings that are numbers, an apostrophe, which PowerShell
  // writes as two, a letter Codex refuses written as its escape, a path that Git Bash would
  // rewrite as an argument of its own, the line the tour gives for the drums, with a note and
  // with an empty one, and JSON with a space outside its strings, which Windows PowerShell puts in quotes of its own. cmd hands JSON
  // on bare, and reads a space outside its strings as the end of a word, so that form is not
  // written there
  for (const written of [
    String.raw`{"folder":"D:\\work"}`,
    '{"folder":"D:/work"}',
    String.raw`{"dir":"C:\\"}`,
    '{"a":1,"b":"x - y"}',
    '{"order":["1","2"]}',
    `{"say":"That's it."}`,
    String.raw`{"say":"a \u2014 b"}`,
    '{"path":"/tmp/board.json"}',
    '{"theirs":{"request":"k57abc","pattern":["..x...x.","....x...","........","...x...."],"note":"I added hats between your hits."}}',
    '{"theirs":{"request":"k57abc","pattern":["..x...x.","....x...","........","...x...."],"note":""}}',
    ...(name === 'cmd' ? [] : ['{"a": 1, "b": "x y"}']),
  ]) {
    calls.length = 0
    const done = await run(['patch', 'board', '--if-revision', '3', written])
    const sent = calls.find((c) => c.path === 'state:patch')?.args
    check(
      `${name}: it patch board --if-revision 3 ${written}`,
      done.status === 0 && sent?.patch === JSON.stringify(JSON.parse(written)) && sent?.baseRevision === 3,
      `exit ${done.status}, sent ${JSON.stringify(sent)}, said ${done.stderr.trim().slice(0, 400)}`,
    )
  }
  // What the guide has an agent keep away from is read exactly as written or refused with nothing
  // changed, whichever the shell: an option after JSON with a backslash just before a quote
  {
    calls.length = 0
    const written = String.raw`{"dir":"C:\\"}`
    const done = await run(['patch', 'board', written, '--if-revision', '3'])
    const sent = calls.find((c) => c.path === 'state:patch')?.args
    const said = `${done.stdout}${done.stderr}`
    check(
      `${name}: it patch board ${written} --if-revision 3 is read as written, or refused with nothing changed`,
      done.status === 0 ? sent?.patch === written && sent?.baseRevision === 3 : sent === undefined && /not valid JSON/.test(said),
      `exit ${done.status}, sent ${JSON.stringify(sent)}, said ${said.trim().slice(0, 400)}`,
    )
  }
  // A path written with one backslash is not JSON in any shell, and the refusal says how a backslash is written
  {
    calls.length = 0
    const written = String.raw`{"folder":"D:\work"}`
    const done = await run(['patch', 'board', written])
    const said = `${done.stdout}${done.stderr}`
    check(
      `${name}: it patch board ${written} is refused, and told how a backslash is written`,
      done.status !== 0 && calls.every((c) => c.path !== 'state:patch') && said.includes('a backslash inside a JSON string is written twice'),
      `exit ${done.status}, sent ${JSON.stringify(calls)}, said ${said.trim().slice(0, 400)}`,
    )
  }
  // --state given its JSON after an equals sign, which Windows PowerShell 5.1 leaves nothing to read back from
  if (name === 'Windows PowerShell 5.1') {
    calls.length = 0
    const done = await run(['create', 'Plan', '--html', '<p>hi</p>', '--state={"a":1}'])
    const said = `${done.stdout}${done.stderr}`
    check(
      `${name}: it create Plan --html <p>hi</p> --state={"a":1} is refused`,
      done.status !== 0 && calls.length === 0 && /not valid JSON/.test(said),
      said.trim().slice(0, 400),
    )
  }
  // What the guide has an agent give `it set`: text with no double quote in it, a number, true or false
  for (const [key, value, patch] of [
    ['status', 'Deploying 3 of 7', '{"status":"Deploying 3 of 7"}'],
    ['folder', String.raw`D:\My Files\work`, String.raw`{"folder":"D:\\My Files\\work"}`],
    ['n', '4', '{"n":4}'],
    ['done', 'false', '{"done":false}'],
  ]) {
    calls.length = 0
    const done = await run(['set', 'board', key, value])
    const sent = calls.find((c) => c.path === 'state:patch')?.args
    check(
      `${name}: it set board ${key} ${value}`,
      done.status === 0 && sent?.patch === patch,
      `exit ${done.status}, sent ${JSON.stringify(sent)}, said ${done.stderr.trim().slice(0, 400)}`,
    )
  }
  // What `it set` changes without a word in Windows PowerShell 5.1, as the guide says, and sets as
  // it is written in PowerShell 7 and Git Bash: a JSON string, which loses its quotes, and an
  // array of strings that are numbers. In cmd a double quote is cmd's own, so these are not
  // written there
  if (name !== 'cmd')
    for (const [value, written, changed] of [
      ['"true"', '{"v":"true"}', '{"v":true}'],
      [String.raw`"D:\\work"`, String.raw`{"v":"D:\\work"}`, String.raw`{"v":"D:\\\\work"}`],
      ['["1","2"]', '{"v":["1","2"]}', '{"v":[1,2]}'],
    ]) {
      calls.length = 0
      const done = await run(['set', 'board', 'v', value])
      const sent = calls.find((c) => c.path === 'state:patch')?.args
      const expected = name === 'Windows PowerShell 5.1' ? changed : written
      check(
        `${name}: it set board v ${value} sets ${expected}`,
        done.status === 0 && sent?.patch === expected,
        `exit ${done.status}, sent ${JSON.stringify(sent)}, said ${done.stderr.trim().slice(0, 400)}`,
      )
    }
  // JSON in a file, given by its path with forward slashes, is read as it is in the file, which no shell changes
  {
    const inFile = (file, text) => {
      writeFileSync(path.join(home, file), text)
      return path.join(home, file).replaceAll('\\', '/')
    }
    const patch = String.raw`{"order":["1","2"],"say":"she said \"hi\" - twice","dir":"C:\\"}`
    calls.length = 0
    const patched = await run(['patch', 'board', '--file', inFile('patch.json', patch)])
    const patchSent = calls.find((c) => c.path === 'state:patch')?.args
    check(
      `${name}: it patch board --file <path>`,
      patched.status === 0 && patchSent?.patch === patch,
      `exit ${patched.status}, sent ${JSON.stringify(patchSent)}, said ${patched.stderr.trim().slice(0, 400)}`,
    )
    calls.length = 0
    const one = await run(['set', 'board', 'order', '--file', inFile('order.json', '["1","2"]')])
    const oneSent = calls.find((c) => c.path === 'state:patch')?.args
    check(
      `${name}: it set board order --file <path>`,
      one.status === 0 && oneSent?.patch === '{"order":["1","2"]}',
      `exit ${one.status}, sent ${JSON.stringify(oneSent)}, said ${one.stderr.trim().slice(0, 400)}`,
    )
    // Under a title of its own, since a command given again takes up the publication it began and sends no state
    const state = '{"steps":{"build":"not yet"},"say":"she said \\"hi\\""}'
    calls.length = 0
    const made = await run(['create', `In a file from ${name}`, '--html', '<p>hi</p>', '--state-file', inFile('state.json', state)])
    const begun = calls.find((c) => c.path === 'publish:begin')?.args
    check(
      `${name}: it create --html <p>hi</p> --state-file <path> sends the state in the file`,
      begun?.state === state,
      `sent ${JSON.stringify(begun)}, said ${`${made.stdout}${made.stderr}`.trim().slice(0, 400)}`,
    )
  }
  calls.length = 0
  const set = await run(['set', 'board', 'order', '["c1","c 2"]'])
  const setSent = calls.find((c) => c.path === 'state:patch')?.args
  check(
    `${name}: it set board order ["c1","c 2"]`,
    set.status === 0 && setSent?.patch === '{"order":["c1","c 2"]}',
    `exit ${set.status}, sent ${JSON.stringify(setSent)}, said ${set.stderr.trim().slice(0, 400)}`,
  )
  // The state a page starts with, under a title of its own, since a command given again takes up the publication it began and sends no state
  {
    const state = '{"steps":{"build":"not yet"}}'
    calls.length = 0
    const done = await run(['create', `On the line from ${name}`, '--html', '<p>hi</p>', '--state', state])
    const begun = calls.find((c) => c.path === 'publish:begin')?.args
    check(
      `${name}: it create --html <p>hi</p> --state ${state} sends that state`,
      begun?.state === state,
      `sent ${JSON.stringify(begun)}, said ${`${done.stdout}${done.stderr}`.trim().slice(0, 400)}`,
    )
  }
  // An answer to the tour's first page, which is put under the part its action came from, with the action's request: one with a colon and a number in it, and one with an apostrophe, which the tour has an agent write as two in PowerShell
  for (const answer of [{ say: 'Right: twelve times twelve is 144.' }, { say: "That's it." }]) {
    calls.length = 0
    const done = await run(['tour', 'answer', 'k57abc', JSON.stringify(answer), '--no-wait'])
    const sent = calls.find((c) => c.path === 'state:patch')?.args
    check(
      `${name}: it tour answer k57abc ${JSON.stringify(answer)} --no-wait`,
      sent?.slug === 'tour-start' && sent?.patch === JSON.stringify({ sums: { ...answer, request: REQUEST } }) && sent?.baseRevision === 1,
      `exit ${done.status}, sent ${JSON.stringify(sent)}, said ${`${done.stdout}${done.stderr}`.trim().slice(0, 400)}`,
    )
  }
}
server.close()
rmSync(home, { recursive: true, force: true })
if (failed) {
  console.error(`${failed} failed`)
  process.exit(1)
}
