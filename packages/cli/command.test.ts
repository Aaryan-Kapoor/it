// The commands as a person or an agent runs them. Each test starts the program itself, built
// from the source as it stands, in folders of its own, with a stand-in for the backend where a
// command talks to one. Nothing here reaches a real backend, a real agent app, a real
// background service or the person's own folders: the program is given a home, a PATH and an
// It folder that hold only what the test put there.
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PORTS } from '@it/protocol'
import { build } from 'esbuild'
import { exportJWK, generateKeyPair } from 'jose'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { bases } from './test-ports'

// Every test here starts the program, and some start it a dozen times over. Each is given the
// time that takes on a machine that is busy with other things as well.
vi.setConfig({ testTimeout: 30_000 })

let scratch: string
let program: string
beforeAll(async () => {
  // Short names: a connector's socket goes in these folders, and a socket's path can only be so long
  scratch = mkdtempSync(path.join(os.tmpdir(), 'it-cmd-'))
  program = path.join(scratch, 'it.mjs')
  // Bundled the way `build.mjs` bundles it, into a folder that is thrown away afterwards
  await build({
    entryPoints: [path.join(__dirname, 'src/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: program,
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    loader: { '.md': 'text', '.txt': 'text' },
    logLevel: 'silent',
  })
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * What each system's own command says of a service that is running, when it is asked how the
 * service is: systemd says that it is active, and launchd that its state is running. A stand-in
 * for the system's commands answers as the real one of each does, and a test holds what the
 * system it runs on says.
 */
const RUNS = process.platform === 'linux' ? 'active' : 'running'
/** The answers of a stand-in for the system's commands that has the service registered and running: systemd's to `is-active` and `is-enabled`, and launchd's to `print`. */
const SAYS_IT_RUNS = '*" is-active "*) echo active ;; *" is-enabled "*) echo enabled ;; *" print "*) echo "state = running" ;;'
/** The base ports a test here takes when it has something listen where It would: each from a block of this file's own, and held until the test gives it back. */
const ports = bases(16_000, 20)
/** The port the site is said to be at, on a machine that has It's settings. Nothing listens there. */
const SITE_PORT = 21000
const SITE = `http://localhost:${SITE_PORT}`
/**
 * A person's home with nothing in it, an It folder inside it, and a folder of commands that is
 * all the program can find. With `here`, the folder holds It's settings as the machine It runs
 * on does. They are read only for the port: the backend each test talks to is a stand-in.
 */
function machine(enrolled = true, here = false) {
  const home = mkdtempSync(path.join(scratch, 'h-'))
  const it = path.join(home, '.it')
  const bin = path.join(home, 'commands')
  mkdirSync(it)
  mkdirSync(bin)
  if (enrolled) writeFileSync(path.join(it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key: {} }))
  if (here) writeFileSync(path.join(it, 'service.json'), JSON.stringify({ port: SITE_PORT }))
  return { home, it, bin }
}

interface Ran {
  code: number | null
  /** The signal that ended the command, where one did. */
  signal: string | null
  out: string
  err: string
}
/** How a command ended, for a test that found nothing where it looked for the command's answer. */
const ended = (ran: Ran) =>
  `it ended with ${ran.code}${ran.signal ? `, by ${ran.signal}` : ''}, having printed ${ran.out.length} bytes and said ${ran.err.length ? JSON.stringify(ran.err.slice(-400)) : 'nothing'}`
/**
 * What a command printed, read as the JSON it is. A command that printed nothing is said to have,
 * with how it ended: a reader that was given nothing says only that nothing is no JSON.
 */
function printed(ran: Ran): any {
  if (!ran.out.trim()) throw new Error(`The command printed nothing: ${ended(ran)}.`)
  return JSON.parse(ran.out)
}
/** An error as one line, with what to do about it after what it is. */
const inWords = (said: { message: string; hint?: string }) => [said.message, said.hint].filter(Boolean).join(' ')
/** The error a command ended by saying, which is the last line of what it said. One that said nothing is said to have, with how it ended. */
function error(ran: Ran): { code: string; message: string; hint?: string } {
  const last = ran.err.trim().split('\n').pop() ?? ''
  if (!last) throw new Error(`The command said nothing: ${ended(ran)}.`)
  return JSON.parse(last).error
}
/**
 * The standalone program runs under Bun, which does some things its own way: how it says that a
 * connection was refused, when what was written leaves the process, and what it sends through a
 * proxy. Where Bun is on this machine, a test of one of those runs the same program under it.
 */
const bun = (process.env.PATH ?? '')
  .split(path.delimiter)
  .map((dir) => path.join(dir, process.platform === 'win32' ? 'bun.exe' : 'bun'))
  .find((file) => existsSync(file))
const RUNTIMES: [name: string, runtime: string | undefined][] = [
  ['Node', process.execPath],
  ['Bun', bun],
]
/**
 * Runs the program with only the environment given here: nothing of whoever runs the tests
 * reaches it. `before` is what the runtime itself is told ahead of the program, for a test that
 * has something loaded into the runtime first.
 */
function run(
  m: { home: string; it: string; bin: string },
  args: string[],
  env: Record<string, string> = {},
  runtime = process.execPath,
  before: string[] = [],
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(
      runtime,
      [...before, program, ...args],
      { cwd: m.home, env: { PATH: m.bin, HOME: m.home, IT_HOME: m.it, IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage', ...env }, timeout: 60_000 },
      (err, out, stderr) =>
        resolve({
          code: err ? ((err as { code?: number }).code ?? null) : 0,
          signal: (err as { signal?: string } | null)?.signal ?? null,
          out: String(out),
          err: String(stderr),
        }),
    )
    child.stdin?.end()
  })
}

interface Asked {
  path: string
  args: Record<string, unknown>
}
/** What the stand-in backend answers with when it refuses a call, as the backend's own code refuses one. */
class Refusal {
  constructor(readonly data: { code: string; message: string }) {}
}
/**
 * Something that answers as the backend does, on this machine. `answer` says what each function
 * returns; whatever it does not name returns nothing. The program is pointed at it, and is
 * given a token so that it never has to prove who it is. One that asks for a token all the same
 * is given one, unless the test puts another answer in `token.answer`. `joined` holds what
 * machines asking to join sent, and `join` says what each is answered. `uploads` holds where
 * each file of a page was sent, and how many bytes of it arrived, and `live` each live
 * connection that was asked for, which is then closed: that it was asked for here is all a test
 * needs of it.
 */
async function backend(
  m: { it: string },
  answer: (asked: Asked) => unknown = () => null,
  join: (sent: Record<string, unknown>) => [status: number, body: unknown] = () => [200, { machine: 'machine-2' }],
) {
  const asked: Asked[] = []
  const joined: Record<string, unknown>[] = []
  const uploads: { path: string; bytes: number }[] = []
  const live: string[] = []
  const token = { asked: 0, answer: (): [status: number, body: unknown] => [200, { token: 'a-token', expires_in: 300 }] }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req
      .on('data', (c: Buffer) => chunks.push(c))
      .on('end', () => {
        const json = (value: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
        if (req.method === 'GET' && req.url === '/cli/config') return json({ protocol: 1, issuer: 'http://127.0.0.1:23001' })
        // Asked how it is, it says that it is It, as the backend does
        if (req.method === 'GET' && req.url === '/health') return json({ ok: true, it: true })
        if (req.method === 'POST' && req.url === '/bridge/token') {
          token.asked++
          const [status, body] = token.answer()
          return typeof body === 'string' ? res.writeHead(status, { 'content-type': 'application/json' }).end(body) : json(body, status)
        }
        if (req.method === 'PUT') {
          uploads.push({ path: req.url ?? '', bytes: Buffer.concat(chunks).length })
          return json({})
        }
        if (req.method === 'POST' && req.url === '/bridge/enroll') {
          const sent = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          joined.push(sent)
          const [status, body] = join(sent)
          return json(body, status)
        }
        const call = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { path: string; args: [Record<string, unknown>] }
        const one = { path: call.path, args: call.args?.[0] ?? {} }
        asked.push(one)
        const said = answer(one)
        if (said instanceof Refusal) return json({ status: 'error', errorMessage: 'refused', errorData: said.data, logLines: [] })
        json({ status: 'success', value: said ?? null, logLines: [] })
      })
  })
  server.on('upgrade', (req, socket) => {
    live.push(req.url ?? '')
    socket.on('error', () => {}).destroy()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  writeFileSync(path.join(m.it, 'token.json'), JSON.stringify({ token: 'a-token', exp: Math.floor(Date.now() / 1000) + 3600, machine: 'machine-1', site: url }))
  return {
    url,
    asked,
    joined,
    uploads,
    live,
    token,
    env: { IT_URL: url, IT_SITE_URL: url },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections()
      }),
  }
}

/**
 * Something that stands in for Pi on this machine: it says a version It can connect to, keeps
 * what it was told to install in a file, lists that, and notes every word it was run with.
 */
const pi = (m: { home: string; bin: string }) => {
  writeFileSync(
    path.join(m.bin, 'pi'),
    [
      '#!/bin/sh',
      'PATH=/bin:/usr/bin',
      'echo "$*" >> "$HOME/pi-was-run"',
      'case "$1" in',
      '  --version) echo 0.82.0 ;;',
      '  install) echo "$2" > "$HOME/pi-has" ;;',
      '  remove) rm -f "$HOME/pi-has" ;;',
      '  list) [ -f "$HOME/pi-has" ] && cat "$HOME/pi-has" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(path.join(m.bin, 'pi'), 0o755)
  return () => (existsSync(path.join(m.home, 'pi-was-run')) ? readFileSync(path.join(m.home, 'pi-was-run'), 'utf8').trim().split('\n') : [])
}

/** Python, where it is on this machine: it gives a command a terminal to print to, which is how a person reads one. */
const python = (process.env.PATH ?? '')
  .split(path.delimiter)
  .map((dir) => path.join(dir, 'python3'))
  .find((file) => existsSync(file))
const AT_A_TERMINAL = `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
shown = b''
while True:
    try:
        piece = os.read(fd, 65536)
    except OSError:
        break
    if not piece:
        break
    shown += piece
status = os.waitpid(pid, 0)[1]
sys.stdout.buffer.write(shown)
sys.exit(os.waitstatus_to_exitcode(status))
`
/**
 * Runs the program at a terminal of its own, with nobody typing, and gives everything it showed
 * there, as a person would read it: what it printed and what it said along the way, in the
 * order they came. Usage reporting is off, so that the line a first command at a terminal says
 * of it is not among them.
 */
function atTerminal(m: { home: string; it: string; bin: string }, args: string[], env: Record<string, string> = {}, runtime = process.execPath) {
  return new Promise<{ code: number | null; shown: string }>((resolve) => {
    const child = execFile(
      python!,
      ['-c', AT_A_TERMINAL, runtime, program, ...args],
      { cwd: m.home, env: { PATH: m.bin, HOME: m.home, IT_HOME: m.it, IT_TELEMETRY_ENABLED: 'false', ...env }, timeout: 60_000 },
      (err, out) => resolve({ code: err ? ((err as { code?: number }).code ?? null) : 0, shown: String(out).replace(/\r\n/g, '\n') }),
    )
    child.stdin?.end()
  })
}

describe.skipIf(process.platform === 'win32')('a switch written with a value', () => {
  test('`it logout --force=false` is not forced: a machine that could not be taken off the person’s machines keeps its key', async () => {
    // No backend is known here, so It cannot be told that the machine is leaving
    for (const off of ['--force=false', '--force=no', '--force=0']) {
      const m = machine()
      const ran = await run(m, ['logout', off])
      expect([off, ran.code]).toEqual([off, 1])
      expect(ran.err).toContain('still one of them')
      expect(existsSync(path.join(m.it, 'machine.json'))).toBe(true)
    }
    // Forced, the key goes whether or not It could be told
    for (const on of ['--force', '--force=true', '--force=yes']) {
      const m = machine()
      const ran = await run(m, ['logout', on])
      expect([on, ran.code, ran.out.trim()]).toEqual([on, 0, JSON.stringify({ ok: true }, null, 2)])
      expect(existsSync(path.join(m.it, 'machine.json'))).toBe(false)
    }
  })

  test('a switch given anything that is neither yes nor no is refused, and nothing is done', async () => {
    const m = machine()
    const ran = await run(m, ['logout', '--force=perhaps'])
    expect(ran.code).toBe(2)
    expect(error(ran)).toMatchObject({
      code: 'invalid',
      message: '--force is a switch, and "perhaps" is neither yes nor no.',
    })
    expect(existsSync(path.join(m.it, 'machine.json'))).toBe(true)
    // A word left after the switch is not dropped in silence, with the switch read as given
    const spaced = await run(m, ['logout', '--force', 'false'])
    expect(spaced.code).toBe(2)
    expect(existsSync(path.join(m.it, 'machine.json'))).toBe(true)
  })

  test('a word left after a switch is refused by every command that takes a set number of words, before anything is done', async () => {
    const m = machine()
    const b = await backend(m)
    try {
      for (const [args, left] of [
        [['ack', 'click-1', '--failed', 'false'], 'false'],
        [['setup', '--none', 'false'], 'false'],
        [['login', '--no-setup', 'false'], 'false'],
        [['create', 'Plan', '--open', 'false', '--html', '<p>hi</p>'], 'false'],
        [['update', 'plan', '--take', 'no', '--html', '<p>hi</p>'], 'no'],
        [['wait', '--follow', 'false'], 'false'],
        [['wait', 'plan'], 'plan'],
        [['open', 'plan', 'Kitchen'], 'Kitchen'],
        [['delete', 'plan', 'other'], 'other'],
        [['status', 'now'], 'now'],
      ] as const) {
        const ran = await run(m, [...args], b.env)
        expect([args, ran.code, ran.out]).toEqual([args, 2, ''])
        expect(error(ran)).toMatchObject({ code: 'invalid', message: `It does not know what to do with "${left}".` })
      }
      expect(b.asked).toEqual([])
      // A command there is none of is said to be that, whatever it is called
      expect(error(await run(m, ['constructor', 'x'], b.env)).message).toBe('No such command: constructor')
      // `it set` and `it notify` read all their last words together as one text, and still do
      const set = await run(m, ['set', 'plan', 'note', 'two', 'words'], b.env)
      expect(set.code).toBe(0)
      expect(b.asked.map((x) => [x.path, x.args.patch])).toEqual([['state:patch', '{"note":"two words"}']])
    } finally {
      await b.close()
    }
  })

  test('`it patch --replace=false` merges, and only a switch that is on replaces the whole state', async () => {
    const m = machine()
    const b = await backend(m, () => ({ revision: 2 }))
    try {
      const sent = async (...flags: string[]) => {
        b.asked.length = 0
        const ran = await run(m, ['patch', 'plan', '{"a":1}', ...flags], b.env)
        expect([flags, ran.code]).toEqual([flags, 0])
        return b.asked.find((x) => x.path === 'state:patch')!.args
      }
      expect(await sent('--replace=false')).toEqual({ slug: 'plan', patch: '{"a":1}' })
      expect(await sent()).toEqual({ slug: 'plan', patch: '{"a":1}' })
      expect(await sent('--replace')).toEqual({ slug: 'plan', patch: '{"a":1}', replace: true })
      expect(await sent('--replace=true')).toEqual({ slug: 'plan', patch: '{"a":1}', replace: true })
      // And a word left after it is refused before anything is sent
      b.asked.length = 0
      expect((await run(m, ['patch', 'plan', '{"a":1}', '--replace', 'false'], b.env)).code).toBe(2)
      expect(b.asked).toEqual([])
    } finally {
      await b.close()
    }
  })

  test('`it create --take=false` leaves a page with the conversation that has it, and `--take=true` takes it', async () => {
    const m = machine()
    const b = await backend(m, ({ path: fn }) =>
      fn === 'publish:begin'
        ? { artifactId: 'artifact-1', slug: 'plan', version: 1, upload: { url: `${b.url}/upload/`, grant: 'a-grant' } }
        : fn === 'publish:finish'
          ? { slug: 'plan', version: 1, url: 'https://site.example/p/plan' }
          : null,
    )
    try {
      const begun = async (...flags: string[]) => {
        b.asked.length = 0
        const ran = await run(m, ['create', 'Plan', '--id', 'plan', '--html', '<p>hi</p>', ...flags], b.env)
        expect([flags, ran.code]).toEqual([flags, 0])
        return b.asked.find((x) => x.path === 'publish:begin')!.args
      }
      expect(await begun('--take=false')).not.toHaveProperty('take')
      expect(await begun()).not.toHaveProperty('take')
      expect(await begun('--take=true')).toMatchObject({ take: true })
      expect(await begun('--take')).toMatchObject({ take: true })
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('taking It off a machine', () => {
  test('`it uninstall` takes away the service, its line in each shell profile, what it left in the agent apps, and its folder, and does none of it without being asked twice', async () => {
    const m = machine(true, true)
    for (const name of ['systemctl', 'loginctl', 'launchctl']) {
      writeFileSync(path.join(m.bin, name), '#!/bin/sh\nexit 0\n')
      chmodSync(path.join(m.bin, name), 0o755)
    }
    const line = `export PATH='${path.join(m.it, 'bin')}':"$PATH"`
    // A profile the person had, with the installer's three lines at its end; one the installer made; and one It was never in
    writeFileSync(path.join(m.home, '.bashrc'), `alias ll='ls -l'\n\n# It\n${line}\n`)
    writeFileSync(path.join(m.home, '.profile'), `\n# It\n${line}\n`)
    writeFileSync(path.join(m.home, '.zshrc'), 'export EDITOR=vi\n')
    // What Codex and Claude Code keep of an add-on after their own commands have removed it
    mkdirSync(path.join(m.home, '.codex', 'plugins', 'cache', 'it', 'it-bridge'), { recursive: true })
    mkdirSync(path.join(m.home, '.claude', 'plugins', 'cache', 'it'), { recursive: true })
    writeFileSync(
      path.join(m.home, '.codex', 'config.toml'),
      'model = "gpt-6"\n\n[hooks.state]\n\n[hooks.state."it-bridge@it:hooks/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:aa"\n\n[hooks.state."it-bridge@it:hooks/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:bb"\n\n[projects."/work"]\ntrust_level = "trusted"\n',
    )
    mkdirSync(path.join(m.home, '.config', 'systemd', 'user'), { recursive: true })
    // Not at a terminal and not told --yes: nothing is changed, and it says how it is asked for
    const unasked = await run(m, ['uninstall'])
    expect(unasked.code).toBe(2)
    expect(error(unasked).hint).toBe('Run `it uninstall` at a terminal, where it asks first, or `it uninstall --yes`.')
    expect(existsSync(path.join(m.it, 'machine.json'))).toBe(true)
    const done = await run(m, ['uninstall', '--yes'])
    expect([done.code, printed(done)]).toEqual([0, { removed: true, folder: m.it, said: expect.any(Array) }])
    expect(existsSync(m.it)).toBe(false)
    // Its lines are out, with the comment and the blank line above them, and nothing else is touched
    expect(readFileSync(path.join(m.home, '.bashrc'), 'utf8')).toBe("alias ll='ls -l'\n")
    expect(existsSync(path.join(m.home, '.profile'))).toBe(false)
    expect(readFileSync(path.join(m.home, '.zshrc'), 'utf8')).toBe('export EDITOR=vi\n')
    expect(readFileSync(path.join(m.home, '.codex', 'config.toml'), 'utf8')).toBe('model = "gpt-6"\n\n[projects."/work"]\ntrust_level = "trusted"\n')
    expect(existsSync(path.join(m.home, '.codex', 'plugins', 'cache', 'it'))).toBe(false)
    expect(existsSync(path.join(m.home, '.claude', 'plugins', 'cache', 'it'))).toBe(false)
    expect(existsSync(path.join(m.home, '.config', 'systemd'))).toBe(false)
    // The background service of another It folder is another It's, and is not taken away with this one
    const other = machine(true, true)
    const log = path.join(other.home, 'asked.txt')
    for (const name of ['systemctl', 'loginctl', 'launchctl']) {
      writeFileSync(path.join(other.bin, name), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexit 0\n`)
      chmodSync(path.join(other.bin, name), 0o755)
    }
    if (process.platform === 'linux') {
      mkdirSync(path.join(other.home, '.config', 'systemd', 'user'), { recursive: true })
      const unit = path.join(other.home, '.config', 'systemd', 'user', 'it.service')
      writeFileSync(unit, '[Service]\nEnvironment="IT_HOME=/somewhere/else/.it"\nExecStart=/somewhere/else/.it/bin/it serve\n')
      expect((await run(other, ['uninstall', '--yes'])).code).toBe(0)
      expect(existsSync(unit)).toBe(true)
      expect(existsSync(log) ? readFileSync(log, 'utf8') : '').not.toMatch(/disable/)
    }
    // A folder that does not hold It is never removed, whatever names it
    const stray = mkdtempSync(path.join(scratch, 'not-it-'))
    writeFileSync(path.join(stray, 'thesis.txt'), 'mine')
    const wrong = await run(m, ['uninstall', '--yes'], { IT_HOME: stray })
    expect([wrong.code, existsSync(path.join(stray, 'thesis.txt'))]).toEqual([2, true])
    expect(wrong.err).toContain('does not hold It')
  })
})

describe.skipIf(process.platform === 'win32')('a picture an action carried', () => {
  test('`it action --save` writes it to the file as the picture it is, and prints the action without its text', async () => {
    const m = machine()
    // The smallest PNG there is: one transparent dot
    const dot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const listed = (payload: unknown) => ({
      id: 'k57',
      artifact: 'board',
      title: 'Whiteboard',
      name: 'snapshot',
      payload: JSON.stringify(payload),
      at: 1,
      attended: true,
      delivery: 'handed_off',
      route: 'addon',
      outcome: null,
    })
    let carried: unknown = { png: `data:image/png;base64,${dot}`, strokes: [] }
    const b = await backend(m, (asked) => (asked.path === 'delivery:get' ? listed(carried) : null))
    try {
      const to = path.join(m.home, 'drawing.png')
      const saved = await run(m, ['action', 'k57', '--save', to], b.env)
      expect(saved.code).toBe(0)
      expect(readFileSync(to).toString('base64')).toBe(dot)
      expect(printed(saved)).toMatchObject({
        id: 'k57',
        action: 'snapshot',
        data: { png: '(a picture, image/png, 1 KB, left out of this message)', strokes: [] },
        saved: { file: to, type: 'image/png', bytes: Buffer.from(dot, 'base64').length },
      })
      // Without the switch it prints everything it carried, as before
      expect(printed(await run(m, ['action', 'k57'], b.env)).data).toEqual(carried)
      // An action that carried no picture says so, and writes nothing
      carried = { cell: 4 }
      const none = await run(m, ['action', 'k57', '--save', path.join(m.home, 'nothing.png')], b.env)
      expect([none.code, existsSync(path.join(m.home, 'nothing.png'))]).toEqual([2, false])
      expect(none.err).toContain('This action carried no picture or other file to save.')
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('a page another conversation made', () => {
  test('`it create` gives it to the conversation that makes it again and says so, and `it update` leaves it where it is and says how to have it', async () => {
    const m = machine()
    const b = await backend(m, (asked) =>
      asked.path === 'artifacts:get'
        ? { title: 'Board' }
        : asked.path === 'publish:begin'
          ? { artifactId: 'artifact-1', slug: 'board', version: 2, upload: { url: `${b.url}/upload/`, grant: 'a-grant' } }
          : asked.path === 'artifacts:take'
            ? { took: true }
            : asked.path === 'displays:show'
              ? { displays: ['Kitchen'] }
              : asked.path === 'publish:finish'
                ? // The backend's word on what became of the page: taken by a publish that asked for it, left where it was by one that did not
                  {
                    slug: 'board',
                    version: 2,
                    url: 'https://site.example/p/board',
                    ...(b.asked.findLast((x) => x.path === 'publish:begin')!.args.take ? { took: true } : { elsewhere: true }),
                  }
                : null,
    )
    try {
      const mine = { ...b.env, CODEX_THREAD_ID: 'codex-today' }
      const begun = () => b.asked.findLast((x) => x.path === 'publish:begin')!.args
      // Made again by today's conversation: the person is talking to it, and what they do on the page comes to it
      const made = await run(m, ['create', 'Board', '--id', 'board', '--html', '<p>hi</p>'], mine)
      expect(begun()).toMatchObject({ take: true, session: { harness: 'codex', id: 'codex-today' } })
      expect([made.code, printed(made)]).toEqual([
        0,
        {
          id: 'board',
          version: 2,
          url: `${b.url}/p/board`,
          note: 'This page was another conversation’s, and is this one’s now: what is done on it comes here.',
        },
      ])
      // A new version of it from a conversation that did not make it leaves it where it is, and says how to have it
      const updated = await run(m, ['update', 'board', '--html', '<p>hi</p>'], mine)
      expect(begun().take).toBeUndefined()
      expect(printed(updated).note).toBe(
        'What is done on this page goes to another conversation, the one that made it, and not to this one. If the person is to be answered here, publish it again with --take.',
      )
      expect(printed(await run(m, ['update', 'board', '--html', '<p>hi</p>', '--take'], mine)).note).toMatch(/is this one’s now/)
      // Made by a script, in no conversation, there is nobody to give it to: nothing is asked for
      await run(m, ['create', 'Board', '--id', 'board', '--html', '<p>hi</p>'], b.env)
      expect(begun().take).toBeUndefined()
      // A conversation that only brings the page up for its person takes it as well: it is the one they are talking to
      b.asked.length = 0
      const opened = await run(m, ['open', 'board'], mine)
      expect(b.asked.find((x) => x.path === 'artifacts:take')!.args).toEqual({
        slug: 'board',
        session: { harness: 'codex', id: 'codex-today' },
        agent: 'codex',
      })
      expect(printed(opened).note).toBe('This page was another conversation’s, and is this one’s now: what is done on it comes here.')
      // Brought up from no conversation, it stays where it is and nothing is asked
      b.asked.length = 0
      expect(printed(await run(m, ['open', 'board'], b.env)).note).toBeUndefined()
      expect(b.asked.some((x) => x.path === 'artifacts:take')).toBe(false)
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('a command that two agent apps have marked', () => {
  const answers = (asked: Asked) =>
    asked.path === 'publish:begin'
      ? { artifactId: 'artifact-1', slug: 'plan', version: 1, upload: { url: 'http://127.0.0.1:9/upload/', grant: 'a-grant' } }
      : asked.path === 'publish:finish'
        ? { slug: 'plan', version: 1, url: 'https://site.example/p/plan' }
        : null
  // A pair for an app that is nowhere above the command, beside Codex's own variable: whatever machine runs this, the conversation is a choice
  const both = { IT_HARNESS: 'an-app-of-their-own', IT_SESSION: 'theirs-1', CODEX_THREAD_ID: 'codex-1' }

  test('`it create` says beside the page’s id which conversation the page was given to, and which other app had marked the command', async () => {
    const m = machine()
    let later = false
    const b = await backend(m, (asked) => {
      if (asked.path === 'artifacts:get') return { title: 'Plan' }
      if (asked.path === 'publish:finish' && later) return { slug: 'plan', version: 2, url: 'https://site.example/p/plan' }
      const said = answers(asked)
      return asked.path === 'publish:begin' ? { ...(said as object), upload: { url: `${b.url}/upload/`, grant: 'a-grant' } } : said
    })
    try {
      const ran = await run(m, ['create', 'Plan', '--id', 'plan', '--html', '<p>hi</p>'], { ...b.env, ...both })
      expect([ran.code, printed(ran)]).toEqual([
        0,
        {
          id: 'plan',
          version: 1,
          // The page's address is at the address this machine was told to ask
          url: `${b.url}/p/plan`,
          note: 'This page was given to the an-app-of-their-own conversation theirs-1. This command also carried the marks of Codex, and which of them ran it could not be told. If that is not the conversation you are in, publish it again with --take, and with IT_HARNESS and IT_SESSION set to your own app and conversation.',
        },
      ])
      // And that is the conversation the backend was told
      expect(b.asked.find((x) => x.path === 'publish:begin')!.args.session).toEqual({ harness: 'an-app-of-their-own', id: 'theirs-1' })
      // A later version leaves the page with the conversation that has it, unless it is taken: then the note says only where it was published from
      later = true
      const updated = await run(m, ['update', 'plan', '--html', '<p>hi</p>'], { ...b.env, ...both })
      expect(printed(updated).note).toMatch(/^This page was published from the an-app-of-their-own conversation theirs-1\. /)
      const taken = await run(m, ['update', 'plan', '--html', '<p>hi</p>', '--take'], { ...b.env, ...both })
      expect(printed(taken).note).toMatch(/^This page was given to the an-app-of-their-own conversation theirs-1\. /)
      later = false
      // One app's marks alone leave nothing to say
      b.asked.length = 0
      const alone = await run(m, ['create', 'Plan', '--id', 'plan', '--html', '<p>hi</p>'], { ...b.env, CODEX_THREAD_ID: 'codex-1' })
      expect([alone.code, printed(alone)]).toEqual([0, { id: 'plan', version: 1, url: `${b.url}/p/plan` }])
      expect(b.asked.find((x) => x.path === 'publish:begin')!.args.session).toEqual({ harness: 'codex', id: 'codex-1' })
    } finally {
      await b.close()
    }
  })

  test('`it wait` with no page named says the same apart from what it prints, and says nothing of it when a page is named', async () => {
    const m = machine()
    const b = await backend(m, (asked) => (asked.path === 'artifacts:get' ? { title: 'Plan' } : null))
    try {
      const ran = await run(m, ['wait', '--timeout', '1'], { ...b.env, ...both })
      expect(
        ran.err
          .split('\n')
          .filter((line) => line.startsWith('{"note"'))
          .map((line) => JSON.parse(line).note),
      ).toEqual([
        'This waits for actions on the pages of the an-app-of-their-own conversation theirs-1. This command also carried the marks of Codex, and which of them ran it could not be told. If that is not the conversation you are in, name the page with --id.',
      ])
      expect(ran.out).not.toContain('note')
      const named = await run(m, ['wait', '--id', 'plan', '--timeout', '1'], { ...b.env, ...both })
      expect(named.err).not.toContain('"note"')
    } finally {
      await b.close()
    }
  }, 40_000)
})

describe.skipIf(process.platform === 'win32')('a connector that cannot start, on a machine where it is all of It there is to run', () => {
  /** Starts `it serve` on a machine that joined an It elsewhere, and gives what it has written down once that holds a line. */
  async function served(m: { home: string; it: string; bin: string }, log: string, env: Record<string, string>) {
    const child = spawn(process.execPath, [program, 'serve', '--log', log], {
      cwd: m.home,
      env: { PATH: m.bin, HOME: m.home, IT_HOME: m.it, IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage', IT_URL: 'http://127.0.0.1:9', ...env },
      stdio: 'ignore',
    })
    try {
      for (const until = Date.now() + 20_000; Date.now() < until; await new Promise((r) => setTimeout(r, 50)))
        if (existsSync(log) && /could not start/.test(readFileSync(log, 'utf8'))) break
      return { written: existsSync(log) ? readFileSync(log, 'utf8') : '', running: child.exitCode === null }
    } finally {
      child.kill('SIGKILL')
    }
  }

  test('writes a fixed word for why to its log, and never the name of the person’s folder, and the service goes on to try again', async () => {
    const m = machine()
    // A folder too deep for a socket's path, with a name in it that must go nowhere
    const deep = path.join(m.home, `PRIVATE-NAME-${'x'.repeat(100)}`)
    mkdirSync(deep)
    writeFileSync(path.join(deep, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key: {} }))
    const { written, running } = await served(m, path.join(m.home, 'it.log'), { IT_HOME: deep })
    expect(written).toMatch(/ connector: could not start: home_too_long\n$/)
    expect(written).not.toContain('PRIVATE-NAME')
    expect(running).toBe(true)
  })

  test('says in the same way that another connector already answers for the folder', async () => {
    const m = machine()
    // Something that answers as a connector does, with this very program's process behind its lock
    const token = 'cd'.repeat(24)
    const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'))
    const socket = path.join(m.it, 'connector.sock')
    await new Promise<void>((r) => server.listen(socket, r))
    try {
      writeFileSync(path.join(m.it, 'connector.json'), JSON.stringify({ socket, token, pid: process.pid, version: 'x', startedAt: 0 }))
      expect((await served(m, path.join(m.home, 'it.log'), {})).written).toMatch(/ connector: could not start: already_running\n$/)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})

describe.skipIf(process.platform === 'win32')('what a command that fails says, and where', () => {
  const PRIVATE = 'PRIVATE-NAME-of-a-plan'

  test('it answers whoever ran it, with what they gave it, and none of that is written where the service writes: there, a service that cannot start is one fixed word', async () => {
    const m = machine()
    // An It folder whose own name is the person's, with settings that are not as It wrote them
    const it = path.join(m.home, PRIVATE)
    mkdirSync(it)
    writeFileSync(path.join(it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key: {} }))
    writeFileSync(path.join(it, 'service.json'), JSON.stringify({ port: SITE_PORT }))
    const log = path.join(m.home, 'it.log')
    const written = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
    // A word the command has no use for is said back to whoever gave it, and nothing is written down
    const word = await run(m, ['serve', PRIVATE, '--log', log], { IT_HOME: it })
    expect([word.code, error(word).message, written()]).toEqual([2, `It does not know what to do with "${PRIVATE}".`, ''])
    // Started as the system starts it, the service that cannot start says one word for why, in its log and in what it prints, and the folder's name in neither
    const started = await run(m, ['serve', '--log', log], { IT_HOME: it })
    expect([started.code, error(started)]).toEqual([1, { code: 'settings', message: 'It could not start.', hint: 'Run `it serve` in a terminal to read why.' }])
    expect(written()).toMatch(/^\S+ could not start: settings\n$/)
    expect(started.err + started.out + written()).not.toContain(PRIVATE)
    // A person at a terminal is told which file it is, and that is still not written down
    if (python) {
      expect((await atTerminal(m, ['serve', '--log', log], { IT_HOME: it })).shown).toContain(path.join(it, 'service.json'))
      expect(written()).not.toContain(PRIVATE)
    }
    // Any other command that fails answers the same way, and has no part in what the service writes
    const before = written()
    const create = await run(m, ['create', PRIVATE, '--file', path.join(m.home, `${PRIVATE}.html`)], { IT_HOME: it })
    expect([create.code, error(create).message]).toEqual([2, `No such file: ${path.join(m.home, `${PRIVATE}.html`)}`])
    expect((await run(m, [PRIVATE], { IT_HOME: it })).err).toContain(`No such command: ${PRIVATE}`)
    expect(written()).toBe(before)
  })
})

describe.skipIf(process.platform === 'win32')('the background service, as `it service` speaks of it', () => {
  /** A command of the system's that says a service is registered and running, and does what it is asked without a word. */
  const manager = (m: { bin: string }) => {
    for (const name of ['systemctl', 'loginctl', 'launchctl']) {
      writeFileSync(path.join(m.bin, name), `#!/bin/sh\ncase " $* " in ${SAYS_IT_RUNS} esac\nexit 0\n`)
      chmodSync(path.join(m.bin, name), 0o755)
    }
  }
  const registered = (m: { home: string }) =>
    process.platform === 'linux' ? path.join(m.home, '.config/systemd/user/it.service') : path.join(m.home, 'Library/LaunchAgents/dev.it.plist')

  test('`it service status` says whether it is registered and whether It is running, and `it service logs` prints the end of what it wrote down', async () => {
    const m = machine(true, true)
    const status = await run(m, ['service', 'status'])
    expect([status.code, printed(status)]).toEqual([
      0,
      { registered: false, state: expect.any(String), where: registered(m), running: false, connector: { running: false } },
    ])
    // With no word after it, it is the same question
    expect(printed(await run(m, ['service']))).toMatchObject({ registered: false, running: false })
    expect((await run(m, ['service', 'logs'])).out).toBe('')
    mkdirSync(path.join(m.it, 'logs'))
    writeFileSync(path.join(m.it, 'logs', 'it.log'), Array.from({ length: 300 }, (_, n) => `line ${n + 1}`).join('\n'))
    const logs = await run(m, ['service', 'logs'])
    expect([logs.code, logs.out.split('\n').length, logs.out.split('\n')[0], logs.out.split('\n').at(-1)]).toEqual([0, 200, 'line 101', 'line 300'])
  })

  test('`it service install` registers it for this folder under It’s own name, and `it service uninstall` takes it away', async () => {
    const m = machine(true, true)
    manager(m)
    const installed = await run(m, ['service', 'install'])
    expect([installed.code, printed(installed)]).toEqual([0, { registered: true, state: RUNS, where: registered(m) }])
    const definition = readFileSync(registered(m), 'utf8')
    expect(definition).toContain(path.join(m.it, 'logs', 'it.log'))
    expect(definition).not.toMatch(/connector/i)
    const removed = await run(m, ['service', 'uninstall'])
    expect([removed.code, printed(removed), existsSync(registered(m))]).toEqual([0, { ok: true }, false])
    // On a machine where It was never set up there is nothing to register
    expect(error(await run(machine(false), ['service', 'install'])).code).toBe('not_set_up')
  })

  test('the one service a machine has is taken away only from the folder that registered it', async () => {
    const m = machine(true, true)
    manager(m)
    expect((await run(m, ['service', 'install'])).code).toBe(0)
    // Another It folder of the same person, which did not register it
    const other = path.join(m.home, 'another-it')
    mkdirSync(other)
    writeFileSync(path.join(other, 'machine.json'), JSON.stringify({ id: 'machine-2', name: 'other', key: {} }))
    const refused = await run(m, ['service', 'uninstall'], { IT_HOME: other })
    expect([refused.code, error(refused)]).toEqual([
      2,
      {
        code: 'invalid',
        message: 'The background service on this machine runs It from another folder, and is left as it is.',
        hint: 'Run this with IT_HOME set to that folder to take it away.',
      },
    ])
    expect(existsSync(registered(m))).toBe(true)
    // Whose the service is does not turn on what the system says of it: one that the system has running and does
    // not start by itself, or has neither, is still the other folder's, and nothing is asked of the system about it
    const calls = path.join(m.home, 'system-was-asked')
    for (const [enabled, active] of [
      ['disabled', 'active'],
      ['disabled', 'inactive'],
      ['enabled', 'inactive'],
    ]) {
      for (const name of ['systemctl', 'loginctl', 'launchctl']) {
        writeFileSync(
          path.join(m.bin, name),
          `#!/bin/sh\necho "${name} $*" >> '${calls}'\ncase " $* " in *" is-active "*) echo ${active} ;; *" is-enabled "*) echo ${enabled}; [ ${enabled} = enabled ] || exit 1 ;; esac\nexit 0\n`,
        )
        chmodSync(path.join(m.bin, name), 0o755)
      }
      rmSync(calls, { force: true })
      const again = await run(m, ['service', 'uninstall'], { IT_HOME: other })
      expect([enabled, active, again.code, error(again).message]).toEqual([
        enabled,
        active,
        2,
        'The background service on this machine runs It from another folder, and is left as it is.',
      ])
      expect([enabled, active, existsSync(registered(m))]).toEqual([enabled, active, true])
      const asked = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
      expect(asked.filter((line) => / (disable|stop|bootout|daemon-reload) /.test(`${line} `))).toEqual([])
    }
    // The folder it is for takes it away, in whatever state the system has it
    expect([(await run(m, ['service', 'uninstall'])).code, existsSync(registered(m))]).toEqual([0, false])
    // With none registered at all, taking it away is done already, from either folder
    expect([(await run(m, ['service', 'uninstall'])).code, existsSync(registered(m))]).toEqual([0, false])
    expect((await run(m, ['service', 'uninstall'], { IT_HOME: other })).code).toBe(0)
  })

  test('the command takes those four words and no other, and nothing is called after the connector any more', async () => {
    const m = machine(true, true)
    expect(error(await run(m, ['service', 'restart']))).toEqual({
      code: 'invalid',
      message: 'No such service command: restart',
      hint: 'it service install | uninstall | status | logs',
    })
    for (const args of [['connector'], ['connector', 'run'], ['connector', 'logs'], ['connector', 'status']])
      expect([args.join(' '), error(await run(m, args))]).toEqual([
        args.join(' '),
        { code: 'invalid', message: 'No such command: connector', hint: 'Run `it help`.' },
      ])
    const help = (await run(m, ['help'])).out
    expect(help).toMatch(/^ {2}it service install \| uninstall \| status \| logs$/m)
    expect(help).not.toMatch(/it connector/)
  })
})

describe.skipIf(process.platform === 'win32')(
  '`it setup` where the backend is at an address it was told, and the connector it is asked to leave running',
  () => {
    /**
     * A command of the system's, as far as the program can tell: it does nothing, and ends as
     * the test says. One that ends well says, when it is asked, that the service is enabled and
     * active, as a system that did what it was asked would.
     */
    const command = (m: { bin: string }, name: string, code: number) => {
      const says = code === 0 ? `case " $* " in ${SAYS_IT_RUNS} esac\n` : ''
      writeFileSync(path.join(m.bin, name), `#!/bin/sh\n${says}exit ${code}\n`)
      chmodSync(path.join(m.bin, name), 0o755)
    }
    const systemCommands = ['systemctl', 'loginctl', 'launchctl']

    test('tells the site what it found, and never that a connector is alive', async () => {
      const m = machine()
      const b = await backend(m)
      try {
        const ran = await run(m, ['setup', '--yes', '--no-service'], b.env)
        expect(ran.code).toBe(0)
        expect(b.asked.map((x) => x.path)).toEqual(['machines:choose', 'machines:inventory'])
        expect(b.asked[1]!.args).toEqual({ harnesses: [] })
      } finally {
        await b.close()
      }
    })

    test('says plainly that the service could not be registered, and fails, unless it was told not to register one', async () => {
      const m = machine()
      for (const name of systemCommands) command(m, name, 1)
      const b = await backend(m)
      try {
        const ran = await run(m, ['setup', '--yes'], b.env)
        expect(ran.code).toBe(1)
        expect(ran.err).toContain('It could not be registered as a background service')
        expect(ran.err).toContain('Until It runs on this machine, nothing done on a page reaches an agent here. Run `it serve` yourself to keep it going.')
        expect(printed(ran)).toMatchObject({ service: { registered: false }, problem: expect.stringContaining('could not be registered') })
        const without = await run(m, ['setup', '--yes', '--no-service'], b.env)
        expect([without.code, printed(without).problem]).toEqual([0, undefined])
        // On Linux nothing is written where systemd cannot be reached for this person, so no definition is left to say
        // that It starts by itself, to a program or to a person
        if (process.platform === 'linux') {
          expect(ran.err).toContain('this machine has no systemd for your account that can be reached from here')
          expect(existsSync(path.join(m.home, '.config/systemd/user/it.service'))).toBe(false)
          expect((await run(m, ['service', 'install'], b.env)).code).toBe(1)
          expect(printed(await run(m, ['service', 'status'], b.env))).toMatchObject({ registered: false })
          expect(printed(await run(m, ['status'], b.env)).background).toMatchObject({ registered: false })
          if (python)
            expect((await atTerminal(m, ['service', 'status'], b.env)).shown).toContain(
              'Nothing starts It by itself on this machine: no systemd for your account can be reached from here. `it serve` runs it, in a terminal or under a supervisor of your own.',
            )
        }
      } finally {
        await b.close()
      }
    })

    test.skipIf(process.platform !== 'linux')(
      'says that It will stop when the person logs out, where the system would not keep it running past that, at a terminal as in what a program reads',
      async () => {
        const m = machine()
        // systemd takes the service, and the system will not let it outlive the person's session
        command(m, 'systemctl', 0)
        command(m, 'loginctl', 1)
        const b = await backend(m)
        const answers = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'))
        const NOTE = 'It will stop when you log out of this machine: `loginctl enable-linger` was refused. Ask whoever runs the machine to allow it.'
        try {
          // Something that answers as a connector does, where this folder's connector would
          const socket = path.join(m.it, 'connector.sock')
          await new Promise<void>((r) => answers.listen(socket, r))
          writeFileSync(path.join(m.it, 'connector.json'), JSON.stringify({ socket, token: 'ef'.repeat(24), pid: process.pid, version: 'x', startedAt: 0 }))
          const ran = await run(m, ['setup', '--yes'], b.env)
          expect([ran.code, printed(ran).service]).toEqual([0, expect.objectContaining({ registered: true, state: 'active', note: NOTE })])
          expect(ran.err.split('\n')).toContain(NOTE)
          if (python) {
            const shown = (await atTerminal(m, ['setup', '--yes'], b.env)).shown.split('\n')
            expect(shown).toContain('It runs in the background (active).')
            expect(shown[shown.indexOf('It runs in the background (active).') + 1]).toBe(NOTE)
            // With JSON asked for at a terminal, it is said there too, beside the JSON that has it
            expect((await atTerminal(m, ['setup', '--yes', '--json'], b.env)).shown).toContain(NOTE)
          }
        } finally {
          await new Promise((r) => answers.close(r))
          await b.close()
        }
      },
      60_000,
    )

    test('fails too when the service was registered and no connector answers, and succeeds once one does', async () => {
      const m = machine()
      for (const name of systemCommands) command(m, name, 0)
      const b = await backend(m)
      const answers = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'))
      try {
        const ran = await run(m, ['setup', '--yes'], b.env)
        expect(ran.code).toBe(1)
        expect(ran.err).toContain('It was registered as a background service, but it is not answering.')
        expect(printed(ran).problem).toContain('not answering')
        // Something that answers as a connector does, where this folder's connector would
        const socket = path.join(m.it, 'connector.sock')
        await new Promise<void>((r) => answers.listen(socket, r))
        writeFileSync(path.join(m.it, 'connector.json'), JSON.stringify({ socket, token: 'ef'.repeat(24), pid: process.pid, version: 'x', startedAt: 0 }))
        const again = await run(m, ['setup', '--yes'], b.env)
        expect([again.code, printed(again).problem]).toEqual([0, undefined])
        expect(again.err).toContain('It runs in the background')
        // And a person who asks is told what that part of It does for them, and not what it is called
        if (python) {
          const told = (await atTerminal(m, ['service', 'status'], b.env)).shown
          expect(told.split('\n')).toContain('It is ready to hand what is done on a page to the conversation that made it, on this machine.')
          expect(told).not.toMatch(/connector/i)
        }
        // What was registered runs the whole of It, and belongs to this folder
        const unit = path.join(m.home, '.config/systemd/user/it.service')
        if (process.platform === 'linux') expect(readFileSync(unit, 'utf8')).toMatch(/^ExecStart=.* "serve" "--log" ".*"$/m)
      } finally {
        await new Promise((r) => answers.close(r))
        await b.close()
      }
    }, 40_000)
  },
)

describe.skipIf(process.platform === 'win32')('a page shown when no display is paired', () => {
  const HINT = `No display is paired yet, so there is nowhere to show it. Run \`it site\` to open ${SITE} in a browser on this machine, already paired. Other displays are added from there.`
  const answers = (displays: string[]) => (asked: Asked) =>
    asked.path === 'publish:begin'
      ? { artifactId: 'artifact-1', slug: 'plan', version: 1, upload: { url: 'http://127.0.0.1:9/upload/', grant: 'a-grant' } }
      : asked.path === 'publish:finish'
        ? { slug: 'plan', version: 1, url: 'https://site.example/p/plan' }
        : asked.path === 'displays:show'
          ? { displays }
          : asked.path === 'displays:list'
            ? displays.map((name) => ({ name }))
            : null

  test('`it open` and `it create --open` say so in what they print, with how to open the site on one', async () => {
    const m = machine(true, true)
    const b = await backend(m, (asked) => {
      const said = answers([])(asked)
      return asked.path === 'publish:begin' ? { ...(said as object), upload: { url: `${b.url}/upload/`, grant: 'a-grant' } } : said
    })
    try {
      const opened = await run(m, ['open', 'plan'], b.env)
      expect([opened.code, printed(opened)]).toEqual([0, { id: 'plan', shownOn: [], hint: HINT }])
      const created = await run(m, ['create', 'Plan', '--id', 'plan', '--html', '<p>hi</p>', '--open'], b.env)
      expect([created.code, printed(created)]).toEqual([0, { id: 'plan', version: 1, url: 'https://site.example/p/plan', shownOn: [], hint: HINT }])
    } finally {
      await b.close()
    }
  })

  test('a page that was published and could not be shown is still said, on standard output, with why it was not shown and that it need not be published again', async () => {
    const m = machine()
    const b = await backend(m, (asked) => {
      if (asked.path === 'displays:show') return new Refusal({ code: 'rate_limited', message: 'Too many at once. Try again in a moment.' })
      const said = answers(['Kitchen'])(asked)
      return asked.path === 'publish:begin' ? { ...(said as object), upload: { url: `${b.url}/upload/`, grant: 'a-grant' } } : said
    })
    try {
      const created = await run(m, ['create', 'Plan', '--id', 'plan', '--html', '<p>hi</p>', '--open'], b.env)
      expect([created.code, printed(created)]).toEqual([
        1,
        {
          id: 'plan',
          version: 1,
          url: `${b.url}/p/plan`,
          shownOn: [],
          notShown: { code: 'rate_limited', message: 'Too many at once. Try again in a moment.' },
          hint: 'The page is published, and only showing it failed: `notShown` says why. Do not publish it again. Run `it open plan` to show it.',
        },
      ])
      // No error is printed beside it: the command did publish
      expect(created.err).not.toContain('"error"')
    } finally {
      await b.close()
    }
  })

  test('nothing of the kind is said when a display took the page', async () => {
    const m = machine()
    const b = await backend(m, answers(['Kitchen']))
    try {
      const opened = await run(m, ['open', 'plan'], b.env)
      expect([opened.code, printed(opened)]).toEqual([0, { id: 'plan', shownOn: ['Kitchen'] }])
    } finally {
      await b.close()
    }
  })

  test('a display whose pairing was ended is named beside the ones the page is shown on, with why, and the hint says that it must be paired again', async () => {
    const m = machine(true, true)
    let asked: string | undefined
    const b = await backend(m, (one) => {
      if (one.path === 'publish:begin') return { artifactId: 'artifact-1', slug: 'plan', version: 1, upload: { url: `${b.url}/upload/`, grant: 'a-grant' } }
      if (one.path === 'publish:finish') return { slug: 'plan', version: 1, url: 'https://site.example/p/plan' }
      if (one.path !== 'displays:show') return null
      asked = one.args.display as string | undefined
      // The desk's browser is paired. The kitchen's and the wall's were ended, and each is still a display the person has
      return asked === 'Kitchen'
        ? { displays: [], notShown: [{ display: 'Kitchen', reason: 'not_paired' }] }
        : {
            displays: ['Desk'],
            notShown: [
              { display: 'Kitchen', reason: 'not_paired' },
              { display: 'Wall', reason: 'not_paired' },
            ],
          }
    })
    const AGAIN = 'On the machine It runs on, `it site` pairs the browser there. Another screen is paired from the site, under Displays, with “Add a display”.'
    try {
      const one = await run(m, ['open', 'plan', '--on', 'Kitchen'], b.env)
      expect([one.code, printed(one)]).toEqual([
        0,
        {
          id: 'plan',
          shownOn: [],
          notShownOn: [{ display: 'Kitchen', reason: 'not_paired' }],
          hint: `Kitchen is not paired any more: the pairing of its browser was ended, and it shows nothing until that browser is paired again. ${AGAIN}`,
        },
      ])
      const created = await run(m, ['create', 'Plan', '--id', 'plan', '--html', '<p>hi</p>', '--open'], b.env)
      expect([created.code, printed(created)]).toEqual([
        0,
        {
          id: 'plan',
          version: 1,
          url: 'https://site.example/p/plan',
          shownOn: ['Desk'],
          notShownOn: [
            { display: 'Kitchen', reason: 'not_paired' },
            { display: 'Wall', reason: 'not_paired' },
          ],
          hint: `Kitchen and Wall are not paired any more: the pairing of their browsers was ended, and they show nothing until those browsers are paired again. ${AGAIN}`,
        },
      ])
    } finally {
      await b.close()
    }
  })

  test('`it setup` ends by saying where the site is, and how to open it already paired', async () => {
    const m = machine(true, true)
    const b = await backend(m)
    try {
      const ran = await run(m, ['setup', '--yes', '--no-service'], b.env)
      expect(ran.code).toBe(0)
      expect(ran.err.trimEnd().split('\n').pop()).toBe(`It’s site is at ${SITE}. Run \`it site\` to open it in a browser on this machine, already paired.`)
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('what a person is told when something is not there', () => {
  test('where It was never set up, every command that needs it says in one sentence to run `it setup`', async () => {
    const said = { code: 'not_set_up', message: 'It has not been set up on this machine, so run `it setup` first.' }
    for (const args of [
      ['list'],
      ['create', 'Plan', '--html', '<p>hi</p>'],
      ['read', 'plan'],
      ['open', 'plan'],
      ['whoami'],
      ['site'],
      ['wait', '--id', 'plan'],
      ['displays'],
    ]) {
      const ran = await run(machine(false), args)
      expect([args, ran.code, ran.out, error(ran)]).toEqual([args, 1, '', said])
    }
    // A machine that has an identity and nowhere to use it is told the same
    expect(error(await run(machine(), ['list']))).toEqual(said)
    // And `it status` says it as what to do next
    const status = await run(machine(false), ['status'])
    expect([status.code, printed(status)]).toEqual([0, { running: false, enrolled: false, hint: 'Run `it setup`.' }])
  })

  test('on the machine It runs on, when It is not running, every command says that and how to start it, and `it status` says it with what is known from this machine alone', async () => {
    // Set up and enrolled, and nothing is listening: the service is stopped
    const m = machine(true, true)
    const said = {
      code: 'offline',
      message: 'It is not running on this machine.',
      hint: 'Start it with `it serve`, or run `it setup` to keep it running in the background.',
    }
    const key = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)
    writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the desk', key }))
    for (const args of [['list'], ['whoami'], ['create', 'Plan', '--html', '<p>hi</p>'], ['site', '--no-open'], ['displays'], ['open', 'plan']]) {
      const ran = await run(m, args)
      expect([args[0], ran.code, ran.out, error(ran)]).toEqual([args[0], 1, '', said])
    }
    const status = await run(m, ['status'])
    expect(status.code).toBe(0)
    expect(printed(status)).toEqual({
      running: false,
      // It is one of the person's machines, whether or not It is running to say so
      enrolled: true,
      machine: { id: 'machine-1', name: 'the desk' },
      site: SITE,
      network: { on: false, addresses: [] },
      connector: { running: false },
      background: expect.objectContaining({ registered: false }),
      harnesses: [],
      version: expect.any(String),
      protocol: 1,
      hint: 'It is not running on this machine. Start it with `it serve`, or run `it setup` to keep it running in the background.',
    })
    // Nothing of where the backend listens, which a person can do nothing with
    expect(status.out + status.err).not.toMatch(/127\.0\.0\.1|backend/)
  })

  test('`it status` says that It is running and what It says of this machine, and when It does not know the machine any more, what to do about that', async () => {
    const m = machine()
    const key = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)
    writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the desk', key }))
    let knows = true
    const b = await backend(m, (asked) =>
      asked.path !== 'machines:me'
        ? null
        : knows
          ? { id: 'machine-1', name: 'the desk', wanted: ['codex'] }
          : new Refusal({ code: 'unauthenticated', message: 'This browser is not paired with It, or this machine is not enrolled.' }),
    )
    try {
      const status = await run(m, ['status'], b.env)
      expect(printed(status)).toMatchObject({ running: true, enrolled: true, machine: { id: 'machine-1', name: 'the desk', wanted: ['codex'] } })
      expect(Object.keys(printed(status))).toEqual([
        'running',
        'enrolled',
        'machine',
        'site',
        'network',
        'connector',
        'background',
        'harnesses',
        'version',
        'protocol',
      ])
      knows = false
      const after = printed(await run(m, ['status'], b.env))
      // What is on this machine still says it was enrolled, and what It says is said beside it
      expect(after).toMatchObject({ running: true, enrolled: true, machine: { id: 'machine-1', name: 'the desk' } })
      // Which of the two happened it cannot tell, so it says both, and what to do is the same
      expect(after.hint).toBe(
        'It does not know this machine any more: it was revoked on the site, or everything It held was erased there. Run `it setup` to enrol it again.',
      )
    } finally {
      await b.close()
    }
  })

  test('an It on another machine that does not answer is named by its address, with what to check there', async () => {
    const m = machine()
    // Nothing listens at this address. The token is one the program already holds, so the call itself is what fails.
    const at = 'http://127.0.0.1:9'
    writeFileSync(
      path.join(m.it, 'token.json'),
      JSON.stringify({ token: 'a-token', exp: Math.floor(Date.now() / 1000) + 3600, machine: 'machine-1', site: at }),
    )
    const ran = await run(m, ['list'], { IT_URL: at, IT_SITE_URL: at })
    expect(error(ran)).toEqual({
      code: 'offline',
      message: 'It could not reach the It at http://127.0.0.1:9.',
      hint: 'Check that It is running on the machine it runs on, that its network is on, which `it network` says there, and that this machine can reach that address.',
    })
    // And the same when it is a token that could not be asked for
    rmSync(path.join(m.it, 'token.json'))
    const key = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)
    writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key }))
    expect(error(await run(m, ['list'], { IT_URL: at, IT_SITE_URL: at })).message).toBe('It could not reach the It at http://127.0.0.1:9.')
    // A machine that joined there says the same of every command, and `it status` says that it does not answer
    writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key, at, issuer: at }))
    expect(error(await run(m, ['list'])).message).toBe('It could not reach the It at http://127.0.0.1:9.')
    expect(printed(await run(m, ['status']))).toMatchObject({
      running: false,
      enrolled: true,
      machine: { id: 'machine-1', name: 'test' },
      site: at,
      hint: 'The It this machine joined does not answer at http://127.0.0.1:9.',
    })
  })

  test('the help says how It is set up, opened and run, and how another machine joins', async () => {
    const ran = await run(machine(), ['help'])
    expect(ran.out).toMatch(/^ {2}it setup \[--all \| --only a,b \| --none\] \[--name <name>\] \[--no-service\]$/m)
    expect(ran.out).toMatch(/^ {2}it site /m)
    expect(ran.out).toMatch(/^ {2}it serve /m)
    expect(ran.out).toMatch(/^ {2}it login --url <address> --code <invite> \[--name <name>\] \[--no-setup\]$/m)
    // Every command the program takes is in it, each with its switches, and none is a line with no words
    for (const line of [
      /^ {2}it patch <id> '<json>' \[--replace\] \[--if-revision <n>\]$/m,
      /^ {2}it serve \[--log <file>\] {2,}\S/m,
      /--yes connects\s+every app it would otherwise ask about/,
      /--no-setup joins and\s+connects no agent app/,
      /With --json, and wherever a program reads what they print,\s+they print JSON/,
      /^ {2}it site \[--no-open\] {2,}\S/m,
      /^ {2}it network \[on \| off \| tailscale\]$/m,
      /^ {2}it status {2,}\S/m,
      /^ {2}it whoami {2,}\S/m,
      /^ {2}it logout \[--force\] {2,}\S/m,
      /^ {2}it version \| it help$/m,
      /^ {2}it update <id> .*\[--title "<title>"\]/m,
      /\[--agent <name>\]/,
      /\[--take\]/,
    ])
      expect(ran.out).toMatch(line)
    const commands = [
      'create',
      'update',
      'list',
      'read',
      'delete',
      'rollback',
      'set',
      'patch',
      'state',
      'open',
      'notify',
      'displays',
      'wait',
      'actions',
      'action',
      'ack',
    ]
    for (const command of [...commands, 'setup', 'site', 'network', 'status', 'whoami', 'serve', 'login', 'logout', 'skill', 'telemetry', 'version', 'help'])
      expect([command, new RegExp(`\\bit ${command}\\b`).test(ran.out)]).toEqual([command, true])
    // What is said of a command is said in whole sentences. It stands in a column of its own, beside
    // the command or under it, and what is said of one command ends where the next command begins
    const explained = ran.out
      .split('\n')
      .flatMap((line) => (/^ {2}it \S/.test(line) ? ['|', line.slice(31, 33) === '  ' ? line.slice(33) : ''] : /^ {33}\S/.test(line) ? [line] : ['|']))
      .join(' ')
      .split('|')
      .map((words) => words.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    expect(explained.length).toBeGreaterThan(12)
    for (const words of explained) expect([words, /^(?:[A-Z]|--[a-z])/.test(words) && words.endsWith('.')]).toEqual([words, true])
    // And no line of it is cut off where a terminal of the usual width ends
    expect(ran.out.split('\n').filter((line) => /^ {33}\S/.test(line) && line.length > 100)).toEqual([])
    // And each of them is a command: none that the help names is refused as no command at all
    for (const command of ['whoami', 'version', 'logout', 'network', 'status'])
      expect([command, (await run(machine(false), [command])).err]).toEqual([command, expect.not.stringContaining('No such command')])
  })

  test('with no agent app on the machine, setup says an agent can still use It, and how it learns to', async () => {
    const m = machine()
    const b = await backend(m)
    try {
      const ran = await run(m, ['setup', '--yes', '--no-service'], b.env)
      expect(ran.err).toContain(
        'None was found. Any agent can still use `it` to make pages and `it wait` to hear what is done on them, and `it skill` prints the instructions to give it.',
      )
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('an It that is not running, under each runtime the program runs under', () => {
  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(
      `under ${name}, a command on the machine It runs on says that It is not running and how to start it, whether it holds a token or has to ask for one`,
      async () => {
        const m = machine(true, true)
        const said = {
          code: 'offline',
          message: 'It is not running on this machine.',
          hint: 'Start it with `it serve`, or run `it setup` to keep it running in the background.',
        }
        const key = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)
        writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the desk', key }))
        // With no token, asking for one is what meets nothing
        const asking = await run(m, ['list'], {}, runtime)
        expect([asking.code, asking.out, error(asking)]).toEqual([1, '', said])
        // With a token it already holds, the call itself is
        writeFileSync(
          path.join(m.it, 'token.json'),
          JSON.stringify({
            token: 'a-token',
            exp: Math.floor(Date.now() / 1000) + 3600,
            machine: 'machine-1',
            site: `http://127.0.0.1:${SITE_PORT + PORTS.backendSite}`,
          }),
        )
        for (const args of [['list'], ['set', 'plan', 'step', '2'], ['create', 'Plan', '--html', '<p>hi</p>']]) {
          const calling = await run(m, args, {}, runtime)
          expect([args[0], calling.code, calling.out, error(calling)]).toEqual([args[0], 1, '', said])
        }
        const status = await run(m, ['status'], {}, runtime)
        expect([status.code, printed(status)]).toEqual([0, expect.objectContaining({ running: false, enrolled: true, hint: `${said.message} ${said.hint}` })])
      },
      40_000,
    )
})

describe.skipIf(process.platform === 'win32')('a machine that It gives no token, under each runtime the program runs under', () => {
  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(
      `under ${name}, a command says that this machine’s proof of who it is was not checked, and says nothing of signing in`,
      async () => {
        const m = machine(false)
        const b = await backend(m)
        try {
          const key = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)
          writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the desk', key, at: b.url, issuer: b.url }))
          // With no token of its own, the machine has to ask for one
          rmSync(path.join(m.it, 'token.json'))
          const answers: [answer: [number, unknown], code: string, message: string][] = [
            // Trouble that It may be over in a moment, which is asked about a few times before it is said
            [[503, {}], 'unavailable', 'It could not check this machine’s proof of who it is just now. Try again in a moment.'],
            // A refusal that is none of the ones It is known to make
            [[400, {}], 'error', 'It would not check this machine’s proof of who it is (400).'],
            // And what is no token, though it was answered as one
            [[200, {}], 'error', 'It answered this machine’s proof with something that is no token.'],
            [[200, { token: 7, expires_in: 300 }], 'error', 'It answered this machine’s proof with something that is no token.'],
            [[200, 'not JSON at all'], 'error', 'It answered this machine’s proof with something that is no token.'],
          ]
          for (const [answer, code, message] of answers) {
            b.token.answer = () => answer
            const before = b.token.asked
            const ran = await run(m, ['list'], {}, runtime)
            // Where the command said nothing at all, how it ended is what there is to show
            expect([answer, ran.code, ran.out, ran.err.trim() ? error(ran) : 'said nothing']).toEqual([answer, 1, '', { code, message }])
            expect([answer, b.token.asked - before]).toEqual([answer, answer[0] === 503 ? 4 : 1])
            expect(ran.err).not.toMatch(/sign/i)
            // No function was called without a token
            expect(b.asked).toEqual([])
          }
        } finally {
          await b.close()
        }
      },
      40_000,
    )
})

describe.skipIf(process.platform === 'win32')('a command that waits for something that keeps no program alive by itself', () => {
  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(
      `under ${name}, the program is still there when the wait is over: it prints its whole answer and ends as the answer says`,
      async () => {
        // The proof of who this machine is, made slowly and with nothing held meanwhile that a runtime counts
        // as work still to be done, as a wait in a runtime's own cryptography is on a machine that is busy
        const slow = path.join(scratch, `slow-proof-${name}.mjs`)
        writeFileSync(
          slow,
          'const sign = crypto.subtle.sign.bind(crypto.subtle)\ncrypto.subtle.sign = (...given) => new Promise((resolve, reject) => void setTimeout(() => sign(...given).then(resolve, reject), 400).unref())\n',
        )
        const before = name === 'Bun' ? ['--preload', slow] : ['--import', pathToFileURL(slow).href]
        const m = machine(false)
        const b = await backend(m, (asked) => (asked.path === 'machines:me' ? { id: 'machine-1', name: 'the desk', wanted: [] } : null))
        try {
          const key = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)
          writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the desk', key, at: b.url, issuer: b.url }))
          // With no token of its own, the machine makes its proof before anything else
          rmSync(path.join(m.it, 'token.json'))
          const answered = await run(m, ['whoami'], {}, runtime, before)
          expect([answered.code, printed(answered)]).toEqual([0, { id: 'machine-1', name: 'the desk', wanted: [] }])
          expect(b.token.asked).toBe(1)
          // And where the command is to fail, it fails as itself, having made every proof it had to
          rmSync(path.join(m.it, 'token.json'))
          b.token.answer = () => [503, {}]
          const refused = await run(m, ['list'], {}, runtime, before)
          expect([refused.code, refused.out, error(refused)]).toEqual([
            1,
            '',
            { code: 'unavailable', message: 'It could not check this machine’s proof of who it is just now. Try again in a moment.' },
          ])
          expect(b.token.asked).toBe(5)
        } finally {
          await b.close()
        }
      },
      60_000,
    )
})

describe.skipIf(process.platform === 'win32' || !python)('what a person at a terminal is told', () => {
  const NOT_RUNNING = 'It is not running on this machine. Start it with `it serve`, or run `it setup` to keep it running in the background.'
  const NOT_REGISTERED = 'It is not registered to start by itself. `it setup` registers it, and `it serve` runs it in a terminal until then.'
  const NO_SYSTEMD =
    'Nothing starts It by itself on this machine: no systemd for your account can be reached from here. `it serve` runs it, in a terminal or under a supervisor of your own.'
  /** The machine's system answers when asked, and knows of no service of It's. Whether the machine the tests run on has a systemd that can be reached is not what is being tried. */
  const systemAnswers = (m: { bin: string }) => {
    for (const name of ['systemctl', 'loginctl', 'launchctl']) {
      writeFileSync(path.join(m.bin, name), `#!/bin/sh\ncase " $* " in *" show-environment "*) exit 0 ;; esac\nexit 1\n`)
      chmodSync(path.join(m.bin, name), 0o755)
    }
  }
  /** A machine It is set up on, as far as a command can tell from its folder: its settings, whole, and its identity. Nothing runs there. */
  const setUp = async () => {
    const m = machine(true, true)
    systemAnswers(m)
    const key = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)
    writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the desk', key }))
    writeFileSync(
      path.join(m.it, 'service.json'),
      JSON.stringify({ port: SITE_PORT, network: false, instanceSecret: 'a'.repeat(64), adminKey: 'it-000000000000|made-up', sessionSecret: 'made-up' }),
    )
    return m
  }

  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(
      `under ${name}, \`it status\` says in sentences how things stand, what is wrong first, and prints JSON only when asked for it`,
      async () => {
        // Where It was never set up there is one thing to say
        const nowhere = await atTerminal(machine(false), ['status'], {}, runtime)
        expect([nowhere.code, nowhere.shown]).toEqual([0, 'It is not set up on this machine. Run `it setup`.\n'])
        // Set up, enrolled and not running
        const m = await setUp()
        const stopped = await atTerminal(m, ['status'], {}, runtime)
        expect([stopped.code, stopped.shown.split('\n')]).toEqual([
          0,
          [
            NOT_RUNNING,
            `Its site is at ${SITE} while it runs.`,
            'This machine is enrolled as “the desk”.',
            'The network is off, so It answers this machine only. `it network on` lets your other devices on the same network reach it.',
            'No agent app was found on this machine.',
            NOT_REGISTERED,
            expect.stringMatching(/^This is It \d+\.\d+\.\d+\.$/),
            '',
          ],
        ])
        expect(stopped.shown).not.toMatch(/harness|[{}"]/)
        // Asked for JSON, it prints what it prints to a program
        const asked = await atTerminal(m, ['status', '--json'], {}, runtime)
        expect(JSON.parse(asked.shown)).toMatchObject({ running: false, enrolled: true, site: SITE, harnesses: [], hint: NOT_RUNNING })
      },
    )

  test('`it status` on a machine that joined an It says that it is running, where its site is, and which agent apps are connected', async () => {
    const m = machine(false)
    systemAnswers(m)
    pi(m)
    let knows = true
    const b = await backend(m, (asked) =>
      asked.path !== 'machines:me'
        ? null
        : knows
          ? { id: 'machine-1', name: 'the laptop', wanted: [] }
          : new Refusal({ code: 'unauthenticated', message: 'This browser is not paired with It, or this machine is not enrolled.' }),
    )
    try {
      const key = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)
      writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the laptop', key, at: b.url, issuer: b.url }))
      const running = await atTerminal(m, ['status'])
      expect(running.shown.split('\n')).toEqual([
        `The It this machine joined is running, and its site is at ${b.url}.`,
        'This machine is enrolled as “the laptop”.',
        'Pi is not connected.',
        'Run `it setup` to choose which agent apps are connected.',
        NOT_REGISTERED,
        'It is not handing what is done on a page to the conversations on this machine, so nothing done there reaches an agent here by itself. `it service logs` says what it met.',
        expect.stringMatching(/^This is It /),
        '',
      ])
      // An app whose add-on is held back, asked for by its name alone, is refused in words, and nothing is changed for the apps that were not named
      b.asked.length = 0
      const held = await run(m, ['setup', '--only', 'openclaw', '--no-service'])
      expect(held.code).toBe(2)
      expect(held.err).toContain('has not yet been tried in a chat channel')
      expect(held.err).toContain('run `IT_EXPERIMENTAL=openclaw it setup` once')
      expect(b.asked.filter((x) => x.path === 'machines:choose')).toEqual([])
      // Connected, the app is said to be, and nothing is left to advise
      expect((await run(m, ['setup', '--only', 'pi', '--no-service'])).code).toBe(0)
      expect((await atTerminal(m, ['status'])).shown.split('\n').slice(2, 4)).toEqual(['Pi is connected.', NOT_REGISTERED])
      // When It does not know the machine any more, that and what to do about it come first, and the machine is not said to be enrolled
      knows = false
      expect((await atTerminal(m, ['status'])).shown.split('\n').slice(0, 3)).toEqual([
        'It does not know this machine any more: it was revoked on the site, or everything It held was erased there. Run `it logout`, then join again with `it login`.',
        `The It this machine joined is running, and its site is at ${b.url}.`,
        'Pi is connected.',
      ])
    } finally {
      await b.close()
    }
  })

  test('`it site` says that the site is opening, or how to open it, with the address on a line of its own', async () => {
    const m = machine(true, true)
    const opened = path.join(m.home, 'opened')
    for (const name of ['xdg-open', 'open']) {
      writeFileSync(path.join(m.bin, name), `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`)
      chmodSync(path.join(m.bin, name), 0o755)
    }
    const b = await backend(m, () => ({ code: 'Ab3dEf6hIj9kLm2nOp5q' }))
    const url = `${SITE}/pair#Ab3dEf6hIj9kLm2nOp5q`
    try {
      // A screen is there to open a browser on (the test names one, whatever the machine it runs on has)
      const screen = { ...b.env, DISPLAY: ':0' }
      expect((await atTerminal(m, ['site'], screen)).shown.split('\n')).toEqual(['It’s site is opening in your browser, already paired:', `  ${url}`, ''])
      const ASKED = ['Open this in a browser on this machine:', `  ${url}`, 'It pairs one browser, once, within ten minutes.']
      // With no screen to open one on, it is not said to be opening: the person is given the address to open
      if (process.platform === 'linux') {
        rmSync(opened, { force: true })
        const none = await atTerminal(m, ['site'], { ...b.env, DISPLAY: '', WAYLAND_DISPLAY: '' })
        expect(none.shown.split('\n').slice(0, 2)).toEqual(ASKED.slice(0, 2))
        expect(existsSync(opened)).toBe(false)
      }
      expect((await atTerminal(m, ['site', '--no-open'], b.env)).shown.split('\n')).toEqual([...ASKED, ''])
      // Run from another computer, with the network off: nothing there can open the address, and the person is told what lets a device in
      expect((await atTerminal(m, ['site'], { ...b.env, SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' })).shown.split('\n')).toEqual([
        ...ASKED,
        'No other device can open that: `it network tailscale` or `it network on` lets one, and this then prints an address for it.',
        '',
      ])
      expect(JSON.parse((await atTerminal(m, ['site', '--no-open', '--json'], b.env)).shown)).toEqual({ url })
    } finally {
      await b.close()
    }
  })

  test('`it network` says which it is in a sentence, with the machine’s other addresses under it, and `it service status` whether It runs and starts by itself', async () => {
    const m = await setUp()
    const STOPPED = 'It is not running on this machine at the moment, so this takes effect when it starts.'
    // Nothing is running here, and each of these says so: the setting is all there is until It starts
    expect((await atTerminal(m, ['network'])).shown).toBe(`The network is off. It answers this machine only.\n${STOPPED}\n`)
    const on = (await atTerminal(m, ['network', 'on'])).shown.split('\n')
    expect(on[0]).toMatch(/^The network is on[.,] /)
    expect(on.at(-2)).toBe(STOPPED)
    // Whatever stands between the two is an address, on a line of its own
    for (const line of on.slice(1, -2)) expect(line).toMatch(/^ {2}http:\/\/\S+:21000$/)
    expect(on.join('\n')).not.toMatch(/[{}"]/)
    // Asked afterwards how it stands, it says the same, and no more promises a site that can be reached than turning it on did
    expect((await atTerminal(m, ['network'])).shown.split('\n')).toEqual(on)
    const piped = await run(m, ['network'])
    expect(piped.err.trim().split('\n').at(-1)).toBe(STOPPED)
    const asked = JSON.parse((await atTerminal(m, ['network', '--json'])).shown.replace(/^[^{]*/, '')) as { network: boolean; addresses: string[] }
    expect([asked.network, asked.addresses.length]).toEqual([true, Math.max(0, on.length - 3) + (/ at http/.test(on[0]!) ? 1 : 0)])

    expect((await atTerminal(m, ['service', 'status'])).shown.split('\n')).toEqual([NOT_RUNNING, NOT_REGISTERED, ''])
    // Where no systemd can be reached for this person, as in a container, that is said, and `it setup` is not offered as the way to register it
    if (process.platform === 'linux') {
      writeFileSync(path.join(m.bin, 'systemctl'), '#!/bin/sh\nexit 1\n')
      expect((await atTerminal(m, ['service', 'status'])).shown.split('\n')).toEqual([NOT_RUNNING, NO_SYSTEMD, ''])
      expect((await atTerminal(m, ['status'])).shown).toContain(NO_SYSTEMD)
    }
    // Registered, with a stand-in for the system's own command that says the service is active
    for (const name of ['systemctl', 'loginctl', 'launchctl']) {
      writeFileSync(path.join(m.bin, name), `#!/bin/sh\ncase " $* " in ${SAYS_IT_RUNS} esac\nexit 0\n`)
      chmodSync(path.join(m.bin, name), 0o755)
    }
    expect((await run(m, ['service', 'install'])).code).toBe(0)
    expect((await atTerminal(m, ['service', 'status'])).shown.split('\n')).toEqual([
      NOT_RUNNING,
      `It is registered with the system to start by itself (${RUNS}).`,
      '',
    ])
    expect(JSON.parse((await atTerminal(m, ['service', 'status', '--json'])).shown)).toMatchObject({ registered: true, running: false })
  })

  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(
      `under ${name}, It is said to be running only when its door answers: with its backend program answering by itself, as while a setup is at work, it is said not to be`,
      async () => {
        const m = await setUp()
        // A base port of this test's own, with something answering as the backend program does where that program listens
        const base = await ports.next()
        const env = { IT_PORT: String(base) }
        const asked: string[] = []
        // Something that answers as It does when it is asked how it is, and nothing else
        const answering = (port: number) =>
          new Promise<http.Server>((resolve) => {
            const server = http.createServer((req, res) => {
              asked.push(`${port} ${req.url}`)
              if (req.url === '/health') res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"it":true}')
              else res.writeHead(503).end()
            })
            server.listen(port, '127.0.0.1', () => resolve(server))
          })
        const closed = (server: http.Server) => new Promise<void>((resolve) => void server.close(() => resolve()))
        const alone = await answering(base + PORTS.backendSite)
        const ALONE =
          'It is not running on this machine: only its backend program is, as it is while `it setup` is at work. If no setup is at work here, one was ended before it had stopped that program, and running `it setup` again stops it. Start it with `it serve`, or run `it setup` to keep it running in the background.'
        try {
          const status = await run(m, ['status'], env, runtime)
          expect([status.code, status.code === 0 ? '' : status.err]).toEqual([0, ''])
          expect(printed(status)).toMatchObject({ running: false, enrolled: true, site: `http://localhost:${base}`, hint: ALONE })
          const shown = (await atTerminal(m, ['status'], env, runtime)).shown
          expect(shown.split('\n').slice(0, 2)).toEqual([ALONE, `Its site is at http://localhost:${base} while it runs.`])
          expect(shown).not.toContain('It is running on this machine')
          expect((await atTerminal(m, ['service', 'status'], env, runtime)).shown.split('\n')[0]).toBe(ALONE)
          // No address is made for a browser to be paired at, where nothing would answer it
          const site = await run(m, ['site', '--no-open'], env, runtime)
          expect([site.code, site.out, error(site).code]).toEqual([1, '', 'offline'])
          expect(site.err).toContain('only its backend program is')
          // And a setting is written with nothing waited for: no service is there to take it
          const on = await run(m, ['network', 'on'], env, runtime)
          expect([on.code, on.err.trim().split('\n').at(-1)]).toEqual([
            0,
            'It is not running on this machine at the moment, so this takes effect when it starts.',
          ])
          // Nothing but how it is was asked of the backend program meanwhile
          expect([...new Set(asked)]).toEqual([`${base + PORTS.backendSite} /health`])
          // With the door answering, It is running
          const door = await answering(base)
          try {
            const up = await run(m, ['status'], env, runtime)
            // Where it did not end well, how it ended and what it said show why
            expect([up.code, up.code === 0 ? '' : up.err]).toEqual([0, ''])
            expect(printed(up)).toMatchObject({ running: true, site: `http://localhost:${base}` })
            expect((await atTerminal(m, ['service', 'status'], env, runtime)).shown.split('\n')[0]).toBe('It is running on this machine.')
          } finally {
            await closed(door)
          }
        } finally {
          await closed(alone)
          await ports.release()
        }
      },
      60_000,
    )

  /**
   * Another program at a port: whatever it is asked, it answers well and as itself. Each kind
   * answers as some program a person may have there does, and none of them says that it is It.
   */
  const OTHERS: Record<string, (res: http.ServerResponse) => void> = {
    'a page of its own for whatever is asked': (res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Another app</title>'),
    'JSON that says all is well': (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"status":"healthy"}'),
    'JSON that is no object': (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('"it"'),
    'that it has no such thing': (res) => res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'),
    'what is not an answer at all': (res) => void res.socket?.end('SSH-2.0-OpenSSH_9.6\r\n'),
  }
  const another = (port: number, answer: (res: http.ServerResponse) => void) =>
    new Promise<http.Server>((resolve) => {
      const server = http.createServer((_req, res) => answer(res))
      server.listen(port, '127.0.0.1', () => resolve(server))
    })
  const shut = (server: http.Server) =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })

  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(
      `under ${name}, another program that answers at the port of It’s site is not taken for It: It is said not to be running, and that the other program has the port, in sentences and in JSON alike`,
      async () => {
        const m = await setUp()
        const base = await ports.next()
        const env = { IT_PORT: String(base) }
        const OTHER = `It is not running on this machine: another program answers at port ${base}, where It’s site would be. Stop whatever is using that port, or choose another first port for It by setting IT_PORT. Start it with \`it serve\`, or run \`it setup\` to keep it running in the background.`
        try {
          for (const [what, answer] of Object.entries(OTHERS)) {
            const other = await another(base, answer)
            try {
              const status = await run(m, ['status'], env, runtime)
              expect([what, status.code, printed(status)]).toEqual([what, 0, expect.objectContaining({ running: false, enrolled: true, hint: OTHER })])
              // At a terminal it is said once, first, and nothing after it says otherwise
              const shown = (await atTerminal(m, ['status'], env, runtime)).shown.split('\n')
              expect([what, shown.slice(0, 2)]).toEqual([what, [OTHER, 'This machine is enrolled as “the desk”.']])
              expect([what, shown.filter((line) => /It is running|while it runs/.test(line))]).toEqual([what, []])
              expect([what, (await atTerminal(m, ['service', 'status'], env, runtime)).shown.split('\n')[0]]).toEqual([what, OTHER])
              expect([what, printed(await run(m, ['service', 'status'], env, runtime)).running]).toEqual([what, false])
              // No address at that port is given out to pair a browser at, and a setting is not waited for there
              const site = await run(m, ['site', '--no-open'], env, runtime)
              expect([what, site.code, site.out, inWords(error(site))]).toEqual([what, 1, '', OTHER])
            } finally {
              await shut(other)
            }
          }
        } finally {
          await ports.release()
        }
      },
      120_000,
    )

  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(
      `under ${name}, on a machine that joined an It, another program that answers at the address it joined at is not taken for that It`,
      async () => {
        const m = machine(false)
        const base = await ports.next()
        const at = `http://127.0.0.1:${base}`
        const key = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)
        writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the laptop', key, at, issuer: at }))
        const OTHER = `What answers at ${at} is another program, and not the It this machine joined. Check on the machine It runs on that It is running, and at which address, which \`it network\` says there.`
        try {
          for (const [what, answer] of Object.entries(OTHERS)) {
            const other = await another(base, answer)
            try {
              const status = await run(m, ['status'], {}, runtime)
              expect([what, status.code, printed(status)]).toEqual([
                what,
                0,
                expect.objectContaining({ running: false, enrolled: true, site: at, hint: OTHER }),
              ])
              const shown = (await atTerminal(m, ['status'], {}, runtime)).shown.split('\n')
              expect([what, shown[0], shown.filter((line) => line.includes('joined is running'))]).toEqual([what, OTHER, []])
              expect([what, (await atTerminal(m, ['service', 'status'], {}, runtime)).shown.split('\n')[0]]).toEqual([what, OTHER])
            } finally {
              await shut(other)
            }
          }
          // With nothing there at all, it is the It that does not answer
          expect(printed(await run(m, ['status'], {}, runtime)).hint).toBe(`The It this machine joined does not answer at ${at}.`)
        } finally {
          await ports.release()
        }
      },
      120_000,
    )

  test('`it service status` where It was never set up says that, as `it status` does, and speaks of no machine that joined an It', async () => {
    const m = machine(false)
    const NEVER = 'It is not set up on this machine. Run `it setup`.\n'
    expect((await atTerminal(m, ['service', 'status'])).shown).toBe(NEVER)
    expect((await atTerminal(m, ['service'])).shown).toBe(NEVER)
    expect((await atTerminal(m, ['status'])).shown).toBe(NEVER)
    // Nor where an address was given and this machine never joined the It there
    expect((await atTerminal(m, ['service', 'status'], { IT_URL: 'http://127.0.0.1:9' })).shown).toBe(NEVER)
    // What a program reads is what it always was
    expect(printed(await run(m, ['service', 'status']))).toMatchObject({ registered: false, running: false, connector: { running: false } })
    expect(JSON.parse((await atTerminal(m, ['service', 'status', '--json'])).shown)).toMatchObject({ registered: false, running: false })
  })

  test('`it setup` says which agent apps are connected in a sentence each, ends with where the site is, and prints no JSON', async () => {
    const m = machine()
    pi(m)
    const b = await backend(m, (asked) => (asked.path === 'machines:me' ? { id: 'machine-1', name: 'test', wanted: [] } : null))
    try {
      const connected = await atTerminal(m, ['setup', '--only', 'pi', '--no-service'], { ...b.env, PATH: `${m.bin}${path.delimiter}${path.join(m.it, 'bin')}` })
      expect([connected.code, connected.shown.split('\n')]).toEqual([
        0,
        [
          'Looking for agent apps on this machine…',
          '  Pi 0.82.0',
          'connecting Pi',
          'Pi is connected.',
          '',
          'Pi: Restart Pi, or run /reload in it.',
          '',
          `It’s site is at ${b.url}. Run \`it site\` to open it in a browser on this machine, already paired.`,
          '',
        ],
      ])
      // Taken out again, it says so, and asked for JSON it prints what it prints to a program
      const none = await atTerminal(m, ['setup', '--none', '--no-service'], b.env)
      expect(none.shown.split('\n')).toEqual(['Looking for agent apps on this machine…', '  Pi 0.82.0', 'disconnecting Pi', 'Pi is not connected.', ''])
      const asked = await atTerminal(m, ['setup', '--none', '--no-service', '--json'], b.env)
      expect(JSON.parse(asked.shown.slice(asked.shown.indexOf('{')))).toEqual({
        harnesses: [{ id: 'pi', version: '0.82.0', addon: 'not_connected' }],
        service: { registered: false, state: 'not installed' },
      })
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('what a command printed, when the command ends', () => {
  /** Starts a program with its output going into pipes that nobody reads for a moment, as a reader with other things to do leaves them, and gives all of it once the program has ended. */
  const readSlowly = (runtime: string, args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: Buffer; err: Buffer }>((resolve) => {
      const child = spawn(runtime, args, { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (piece: Buffer) => out.push(piece)).pause()
      child.stderr.on('data', (piece: Buffer) => err.push(piece)).pause()
      setTimeout(() => {
        child.stdout.resume()
        child.stderr.resume()
      }, 300)
      child.once('close', (code) => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err) }))
    })
  let probe = ''
  beforeAll(async () => {
    probe = path.join(scratch, 'ends.mjs')
    // Prints far more than a pipe holds, to both of its outputs, and ends itself at once as a command that failed does
    const contents = `
      import { end, written } from ${JSON.stringify(path.join(__dirname, 'src/lib'))}
      const line = 'x'.repeat(99) + '\\n'
      for (let n = 0; n < 5000; n++) written(process.stdout, line)
      for (let n = 0; n < 5000; n++) written(process.stderr, line)
      await end(3)
    `
    await build({
      stdin: { contents, resolveDir: __dirname, loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: probe,
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      logLevel: 'silent',
    })
  })

  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(`under ${name}, everything written has left the process before it ends itself, however slowly it is read`, async () => {
      const ran = await readSlowly(runtime!, [probe])
      expect([ran.code, ran.out.length, ran.err.length]).toEqual([3, 500_000, 500_000])
    })

  for (const [name, runtime] of RUNTIMES)
    test.skipIf(!runtime)(`under ${name}, a command read slowly through a pipe is read whole: what it printed, and the error it ended with`, async () => {
      const m = machine(true, true)
      // The end of a long log, which is more than a pipe holds
      mkdirSync(path.join(m.it, 'logs'))
      const lines = Array.from({ length: 200 }, (_, n) => `line ${n + 1} ${'y'.repeat(2000)}`)
      writeFileSync(path.join(m.it, 'logs', 'it.log'), lines.join('\n'))
      const env = { PATH: m.bin, HOME: m.home, IT_HOME: m.it, IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage' }
      const logs = await readSlowly(runtime!, [program, 'service', 'logs'], env)
      expect([logs.code, logs.out.toString('utf8') === lines.join('\n')]).toEqual([0, true])
      // A command that is refused says why, and ends with the status that says it was refused
      const refused = await readSlowly(runtime!, [program, 'list', 'more'], env)
      expect([refused.code, refused.out.length, JSON.parse(refused.err.toString('utf8')).error.code]).toEqual([2, 0, 'invalid'])
      // And one that could not be done: It is not running here
      const key = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)
      writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the desk', key }))
      const failed = await readSlowly(runtime!, [program, 'list'], env)
      expect([failed.code, JSON.parse(failed.err.toString('utf8').trim().split('\n').pop()!).error.code]).toEqual([1, 'offline'])
    })
})

describe.skipIf(process.platform === 'win32')('with a proxy named in the environment', () => {
  /** Something that takes whatever is sent to it as a proxy would, notes the first line of each thing asked, and passes nothing on. */
  async function collecting() {
    const asked: string[] = []
    const server = net.createServer((socket) => {
      socket.on('error', () => {})
      let got = ''
      socket.on('data', (piece: Buffer) => {
        const first = !got.includes('\r\n')
        got += piece.toString('latin1')
        if (!first || !got.includes('\r\n')) return
        asked.push(got.split('\r\n')[0]!)
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const at = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    return {
      asked,
      // Named in every variable either runtime reads, with nothing left out of its reach
      env: { HTTP_PROXY: at, http_proxy: at, HTTPS_PROXY: at, https_proxy: at, ALL_PROXY: at, all_proxy: at, NO_PROXY: '', no_proxy: '' },
      close: () => new Promise<void>((r) => void server.close(() => r())),
    }
  }
  /** Something that answers on a port as this machine's connector does, with each answer sealed by the token as the connector seals it. */
  async function connector(m: { it: string }) {
    const token = 'ab'.repeat(24)
    const asked: string[] = []
    const server = http.createServer((req, res) => {
      asked.push(req.url ?? '')
      const text = JSON.stringify({ ok: true, version: 'x', pid: 1 })
      const seal = createHmac('sha256', token).update(`${req.headers['x-it-nonce']}\n200\n${text}`).digest('hex')
      res.writeHead(200, { 'content-type': 'application/json', 'x-it-mac': seal }).end(text)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    writeFileSync(
      path.join(m.it, 'connector.json'),
      JSON.stringify({ port: (server.address() as net.AddressInfo).port, token, pid: process.pid, version: 'x', startedAt: 0 }),
    )
    return { asked, close: () => new Promise<void>((r) => void server.close(() => r())) }
  }

  for (const [name, runtime, told] of [
    ['Node told to use the environment’s proxy', process.execPath, { NODE_USE_ENV_PROXY: '1' }],
    ['Bun', bun, {}],
  ] as const)
    test.skipIf(!runtime)(
      `under ${name}, what a command asks of It, the files it uploads and what it asks of the connector all go to them, and the proxy is sent nothing`,
      async () => {
        // A machine that joined an It on another computer: all it asks goes to that It's door
        const m = machine(false)
        const proxy = await collecting()
        const b = await backend(m, (asked) =>
          asked.path === 'publish:begin'
            ? { artifactId: 'artifact-1', slug: 'plan', version: 1, upload: { url: 'http://127.0.0.1:9/upload/u/', grant: 'a-grant' } }
            : asked.path === 'publish:finish'
              ? { slug: 'plan', version: 1, url: 'http://localhost:9/p/plan' }
              : asked.path === 'machines:me'
                ? { id: 'machine-1', name: 'the laptop', wanted: [] }
                : [],
        )
        const local = await connector(m)
        try {
          writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the laptop', key: {}, at: b.url, issuer: b.url }))
          const env = { ...proxy.env, ...told }
          const listed = await run(m, ['list'], env, runtime)
          expect([listed.code, printed(listed)]).toEqual([0, []])
          const created = await run(m, ['create', 'Plan', '--id', 'plan', '--html', '<p>a page of the person’s own</p>'], env, runtime)
          expect([created.code, printed(created)]).toEqual([0, { id: 'plan', version: 1, url: `${b.url}/p/plan` }])
          expect(b.uploads).toEqual([{ path: '/upload/u/index.html', bytes: Buffer.byteLength('<p>a page of the person’s own</p>') }])
          const status = printed(await run(m, ['status'], env, runtime))
          expect(status).toMatchObject({ running: true, enrolled: true, connector: { ok: true } })
          expect(local.asked).toEqual(['/health'])
          expect(proxy.asked).toEqual([])
        } finally {
          await local.close()
          await b.close()
          await proxy.close()
        }
      },
      40_000,
    )

  for (const [name, runtime, told] of [
    ['Node told to use the environment’s proxy', process.execPath, { NODE_USE_ENV_PROXY: '1' }],
    ['Bun', bun, {}],
  ] as const)
    test.skipIf(!runtime)(
      `under ${name}, the service of a machine that joined an It keeps its live connection, and asks everything it asks, with that It itself`,
      async () => {
        const m = machine(false)
        const proxy = await collecting()
        const b = await backend(m, (asked) => (asked.path === 'machines:me' ? { wanted: [] } : null))
        writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the laptop', key: {}, at: b.url, issuer: b.url }))
        const log = path.join(m.home, 'service.log')
        // Usage reporting is off here: its counts go to the internet, which is the one thing a proxy is for
        const child = spawn(runtime!, [program, 'serve', '--log', log], {
          cwd: m.home,
          env: { PATH: m.bin, HOME: m.home, IT_HOME: m.it, IT_HARNESSES: 'none', IT_TELEMETRY_ENABLED: 'false', ...proxy.env, ...told },
          stdio: 'ignore',
        })
        const ended = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
        try {
          // Its connector says to It that it is alive, and opens the live connection it hears of clicks on
          for (let n = 0; n < 400 && !(b.asked.some((x) => x.path === 'machines:report') && b.live.length > 0); n++) await new Promise((r) => setTimeout(r, 50))
          expect(b.asked.some((x) => x.path === 'machines:report')).toBe(true)
          expect(b.live[0]).toMatch(/^\/api\/[\d.]+\/sync$/)
          child.kill('SIGTERM')
          expect(await ended).toBe(0)
          expect(proxy.asked).toEqual([])
        } finally {
          child.kill('SIGKILL')
          await b.close()
          await proxy.close()
        }
      },
      60_000,
    )
})

describe.skipIf(process.platform === 'win32')('`it serve` on a machine whose backend is elsewhere', () => {
  test('runs the connector alone, starts no backend of its own, and stops when it is asked to', async () => {
    // The folder holds settings, and the address it was told is believed over them
    const m = machine(true, true)
    const b = await backend(m, (asked) => (asked.path === 'machines:me' ? { wanted: [] } : null))
    const log = path.join(m.home, 'service.log')
    const child = spawn(process.execPath, [program, 'serve', '--log', log], {
      cwd: m.home,
      env: { PATH: m.bin, HOME: m.home, IT_HOME: m.it, IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage', IT_HARNESSES: 'none', ...b.env },
      stdio: 'ignore',
    })
    const ended = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    try {
      const lines = () => (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').map((line) => line.replace(/^\S+ /, ''))
      for (let n = 0; n < 200 && !lines().some((line) => /^connector \S+ started/.test(line)); n++) await new Promise((r) => setTimeout(r, 50))
      expect(lines().some((line) => /^connector \S+ started/.test(line))).toBe(true)
      child.kill('SIGTERM')
      expect(await ended).toBe(0)
      expect(lines().filter((line) => line.startsWith('backend') || line.startsWith('service'))).toEqual(['service stopped'])
      expect(existsSync(path.join(m.it, 'backend'))).toBe(false)
    } finally {
      child.kill('SIGKILL')
      await b.close()
    }
  }, 40_000)
})

describe.skipIf(process.platform === 'win32')('`it site`', () => {
  /**
   * A stand-in for whatever opens an address in a browser on this system: it writes down what
   * it was given. With `each`, it writes down every address it is ever given, one to a line.
   */
  const opener = (m: { home: string; bin: string }, each = false) => {
    const opened = path.join(m.home, 'opened')
    for (const name of ['xdg-open', 'open']) {
      writeFileSync(path.join(m.bin, name), `#!/bin/sh\nprintf '${each ? '%s\\n' : '%s'}' "$1" ${each ? '>>' : '>'} '${opened}'\n`)
      chmodSync(path.join(m.bin, name), 0o755)
    }
    return opened
  }
  const waitFor = async (file: string) => {
    for (let n = 0; n < 100 && !existsSync(file); n++) await new Promise((r) => setTimeout(r, 50))
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined
  }

  test('asks, as this machine, for an invite that signs the person in, prints the address that carries it and opens it', async () => {
    const m = machine(true, true)
    const opened = opener(m)
    const b = await backend(m, (asked) => (asked.path === 'sessions:inviteOwner' ? { code: 'Ab3dEf6hIj9kLm2nOp5q' } : null))
    try {
      // With a screen to open a browser on, which the test names whatever the machine it runs on has
      const ran = await run(m, ['site'], { ...b.env, DISPLAY: ':0' })
      expect([ran.code, printed(ran)]).toEqual([0, { url: `${SITE}/pair#Ab3dEf6hIj9kLm2nOp5q` }])
      expect(b.asked).toEqual([{ path: 'sessions:inviteOwner', args: {} }])
      expect(await waitFor(opened)).toBe(`${SITE}/pair#Ab3dEf6hIj9kLm2nOp5q`)
    } finally {
      await b.close()
    }
  })

  test('with `--no-open`, and over SSH, the address is printed and no browser is started', async () => {
    const m = machine(true, true)
    const opened = opener(m, true)
    // Each asking is given an invite of its own, so that an address says which run it was printed by
    const codes = ['Ab3dEf6hIj9kLm2nOp5q', 'Bc4eFg7iJk0lMn3oPq6r', 'Cd5fGh8jKl1mNo4pQr7s']
    const b = await backend(m, () => ({ code: codes.shift() }))
    try {
      for (const [args, env, code] of [
        [['site', '--no-open'], {}, 'Ab3dEf6hIj9kLm2nOp5q'],
        [['site'], { SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' }, 'Bc4eFg7iJk0lMn3oPq6r'],
      ] as const) {
        const ran = await run(m, [...args], { ...b.env, DISPLAY: ':0', ...env })
        expect([ran.code, printed(ran)]).toEqual([0, { url: `${SITE}/pair#${code}` }])
      }
      // A run that does start a browser comes after them. Once its address has been written
      // down, one that either of the runs before it had started would have been written down too
      expect((await run(m, ['site'], { ...b.env, DISPLAY: ':0' })).code).toBe(0)
      const given = () => (existsSync(opened) ? readFileSync(opened, 'utf8') : '').split('\n').filter(Boolean)
      for (let n = 0; n < 200 && !given().includes(`${SITE}/pair#Cd5fGh8jKl1mNo4pQr7s`); n++) await new Promise((r) => setTimeout(r, 50))
      expect(given()).toEqual([`${SITE}/pair#Cd5fGh8jKl1mNo4pQr7s`])
    } finally {
      await b.close()
    }
  })

  test('an answer that is no invite is put in no address and opened nowhere', async () => {
    const m = machine(true, true)
    const opened = opener(m)
    for (const code of ['x" & calc.exe', 'a/../b?c', '', 7, null]) {
      const b = await backend(m, () => ({ code }))
      try {
        const ran = await run(m, ['site'], b.env)
        expect([code, ran.code, ran.out]).toEqual([code, 1, ''])
        expect(error(ran).message).toBe('It answered with something that is no invite.')
      } finally {
        await b.close()
      }
    }
    expect(existsSync(opened)).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('a second machine', () => {
  test('`it login` joins with an invite: it sends the invite, a name and the public half of a key it made, and keeps the private half', async () => {
    const m = machine(false)
    const b = await backend(m)
    try {
      const ran = await run(m, ['login', '--url', `${b.url}/`, '--code', 'Ab3dEf6hIj9kLm2nOp5q', '--name', 'the laptop', '--no-setup'])
      expect([ran.code, printed(ran)]).toEqual([0, { machine: 'machine-2', name: 'the laptop' }])
      expect(b.joined).toEqual([
        { code: 'Ab3dEf6hIj9kLm2nOp5q', name: 'the laptop', publicKey: { kty: 'EC', crv: 'P-256', x: expect.any(String), y: expect.any(String) } },
      ])
      const kept = JSON.parse(readFileSync(path.join(m.it, 'machine.json'), 'utf8'))
      // Where it joined, and the address the backend there signs under, are kept beside its identity
      expect(kept).toEqual({
        id: 'machine-2',
        name: 'the laptop',
        key: expect.objectContaining({ d: expect.any(String) }),
        at: b.url,
        issuer: 'http://127.0.0.1:23001',
      })
      expect([kept.key.x, kept.key.y]).toEqual([(b.joined[0]!.publicKey as { x: string }).x, (b.joined[0]!.publicKey as { y: string }).y])
      // The private half went nowhere
      expect(JSON.stringify(b.joined)).not.toContain(kept.key.d)
      if (process.platform !== 'win32') expect(statSync(path.join(m.it, 'machine.json')).mode & 0o777).toBe(0o600)
      // Joined, it is one machine and does not join a second time
      const again = await run(m, ['login', '--url', b.url, '--code', 'Zy8xWv5uTs2rQp9oNm6l', '--no-setup'])
      expect([again.code, error(again)]).toEqual([
        2,
        { code: 'invalid', message: 'This machine has already joined an It.', hint: 'Run `it logout` to leave it first.' },
      ])
      expect(b.joined).toHaveLength(1)
    } finally {
      await b.close()
    }
  })

  test('`it login` goes on as a first setup does on a machine that has just joined, with `--none` too: the service is registered unless it is told not to, and where the site is and what is left to do are said', async () => {
    const SERVE =
      'It is not running in the background on this machine. Run `it serve` here, in a terminal or under a supervisor of your own, so that what is done on a page reaches the agents on this machine.'
    const joining = async (more: string[]) => {
      const m = machine(false)
      pi(m)
      // The system's own commands, which note what they were asked and say that the service is enabled and active
      const calls = path.join(m.home, 'system-was-asked')
      for (const name of ['systemctl', 'loginctl', 'launchctl']) {
        writeFileSync(path.join(m.bin, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\ncase " $* " in ${SAYS_IT_RUNS} esac\nexit 0\n`)
        chmodSync(path.join(m.bin, name), 0o755)
      }
      // And something that answers as this folder's connector would, once the service runs
      const answers = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'))
      const socket = path.join(m.it, 'connector.sock')
      await new Promise<void>((r) => answers.listen(socket, r))
      writeFileSync(path.join(m.it, 'connector.json'), JSON.stringify({ socket, token: 'ef'.repeat(24), pid: process.pid, version: 'x', startedAt: 0 }))
      const b = await backend(m, (asked) => (asked.path === 'machines:me' ? { id: 'machine-2', name: 'the laptop', wanted: [] } : null))
      try {
        const ran = await run(m, ['login', '--url', b.url, '--code', 'Ab3dEf6hIj9kLm2nOp5q', '--name', 'the laptop', ...more])
        const asked = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
        return { m, b, ran, registered: asked.some((line) => / (enable|bootstrap) /.test(`${line} `)) }
      } finally {
        await new Promise((r) => answers.close(r))
        await b.close()
      }
    }
    // With nothing connected and no service asked for: joined, with where the site is and how It is run here
    const bare = await joining(['--none', '--no-service'])
    expect(bare.ran.code).toBe(0)
    expect(bare.ran.err).toContain('This machine has joined as "the laptop".')
    expect(bare.ran.err.split('\n')).toContain(SERVE)
    expect(bare.ran.err.trimEnd().split('\n').pop()).toBe(
      `It’s site is at ${bare.b.url}. Run \`it site\` to open it in a browser on this machine, already paired.`,
    )
    expect(printed(bare.ran)).toMatchObject({ harnesses: [{ id: 'pi', addon: 'not_connected' }], service: { registered: false } })
    expect(bare.registered).toBe(false)
    // With nothing connected, the service is registered all the same: it is a first run on this machine
    const none = await joining(['--none'])
    expect([none.ran.code, none.registered]).toEqual([0, true])
    expect(none.ran.err).toContain(`It runs in the background (${RUNS}).`)
    expect(none.ran.err).not.toContain('It is not running in the background')
    expect(none.ran.err.trimEnd().split('\n').pop()).toBe(
      `It’s site is at ${none.b.url}. Run \`it site\` to open it in a browser on this machine, already paired.`,
    )
    expect(printed(none.ran)).toMatchObject({ harnesses: [{ id: 'pi', addon: 'not_connected' }], service: { registered: true } })
    // And with an app connected and no service, the same is said of running It here
    const one = await joining(['--only', 'pi', '--no-service'])
    expect([one.ran.code, one.registered]).toEqual([0, false])
    expect(one.ran.err.split('\n')).toContain(SERVE)
    expect(printed(one.ran)).toMatchObject({ harnesses: [{ id: 'pi', addon: 'connected' }] })
  }, 60_000)

  test('a machine whose address has had too many codes refused is told that, and how long to wait, and not only that something went wrong', async () => {
    const m = machine(false)
    const b = await backend(
      m,
      () => null,
      () => [429, { error: 'too_many_wrong_codes' }],
    )
    try {
      const ran = await run(m, ['login', '--url', b.url, '--code', 'Ab3dEf6hIj9kLm2nOp5q', '--no-setup'])
      expect([ran.code, error(ran)]).toEqual([
        1,
        {
          code: 'rate_limited',
          message: 'Too many codes from this machine were refused in the last minute.',
          hint: 'Wait a minute, then try again with a code made just now.',
        },
      ])
      expect(existsSync(path.join(m.it, 'machine.json'))).toBe(false)
    } finally {
      await b.close()
    }
  })

  test('an invite that is refused, an address that does not answer, and a command with half of what it needs each join nothing', async () => {
    const m = machine(false)
    const b = await backend(
      m,
      () => null,
      () => [401, { error: 'refused' }],
    )
    try {
      const refused = await run(m, ['login', '--url', b.url, '--code', 'Ab3dEf6hIj9kLm2nOp5q', '--no-setup'])
      expect([refused.code, error(refused)]).toEqual([
        1,
        { code: 'unauthenticated', message: 'That invite is wrong, used or out of date.', hint: 'Make a new one on the site, and use it within ten minutes.' },
      ])
      const nowhere = await run(m, ['login', '--url', 'http://127.0.0.1:9', '--code', 'Ab3dEf6hIj9kLm2nOp5q', '--no-setup'])
      expect([nowhere.code, error(nowhere).code, error(nowhere).message]).toEqual([1, 'offline', 'It could not reach the It at http://127.0.0.1:9.'])
      for (const args of [['login'], ['login', '--url', b.url], ['login', '--code', 'Ab3dEf6hIj9kLm2nOp5q']]) {
        const ran = await run(m, args)
        expect([args, ran.code, error(ran).hint]).toEqual([args, 2, 'Usage: it login --url <address> --code <invite> [--name <name>] [--no-setup]'])
      }
      const odd = await run(m, ['login', '--url', `${b.url}/pair#Ab3dEf6hIj9kLm2nOp5q`, '--code', 'Ab3dEf6hIj9kLm2nOp5q'])
      expect([odd.code, error(odd).code]).toEqual([2, 'invalid'])
      expect(existsSync(path.join(m.it, 'machine.json'))).toBe(false)
    } finally {
      await b.close()
    }
  })

  test('`it logout` takes it off the person’s machines and forgets its key', async () => {
    const m = machine()
    const b = await backend(m)
    try {
      const ran = await run(m, ['logout'], b.env)
      expect([ran.code, printed(ran)]).toEqual([0, { ok: true }])
      expect(b.asked.map((x) => x.path)).toEqual(['machines:leave'])
      expect(existsSync(path.join(m.it, 'machine.json'))).toBe(false)
      expect(existsSync(path.join(m.it, 'token.json'))).toBe(false)
    } finally {
      await b.close()
    }
  })

  test('the machine It runs on neither joins nor leaves: both commands say that it is the one', async () => {
    const m = machine(true, true)
    const b = await backend(m)
    try {
      const leave = await run(m, ['logout'], b.env)
      expect([leave.code, error(leave)]).toEqual([
        2,
        {
          code: 'invalid',
          message: 'This machine is the one It runs on, so it cannot leave.',
          hint: '`it setup --none` takes the add-ons out of your agent apps, and `it service uninstall` stops It running in the background.',
        },
      ])
      expect((await run(m, ['logout', '--force'], b.env)).code).toBe(2)
      const join = await run(m, ['login', '--url', b.url, '--code', 'Ab3dEf6hIj9kLm2nOp5q'], b.env)
      expect([join.code, error(join).message]).toEqual([2, 'This machine is the one It runs on, so it has nothing to join.'])
      expect(b.asked).toEqual([])
      expect(b.joined).toEqual([])
      expect(existsSync(path.join(m.it, 'machine.json'))).toBe(true)
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('a machine that joined an It on another computer, and is told that It is at another address now', () => {
  test('sends a page’s files to the address it was told, and every address it prints is there: the page’s, the site’s, and the one a browser is paired at', async () => {
    const m = machine(false)
    const b = await backend(m, (asked) =>
      asked.path === 'publish:begin'
        ? // The backend names its door as its own machine reaches it
          { artifactId: 'artifact-1', slug: 'plan', version: 1, upload: { url: 'http://127.0.0.1:4700/upload/u/', grant: 'a-grant' } }
        : asked.path === 'publish:finish'
          ? { slug: 'plan', version: 1, url: 'http://localhost:4700/p/plan' }
          : asked.path === 'sessions:inviteOwner'
            ? { code: 'Ab3dEf6hIj9kLm2nOp5q' }
            : asked.path === 'displays:show'
              ? { displays: [] }
              : asked.path === 'machines:me'
                ? { id: 'machine-1', name: 'the laptop', wanted: [] }
                : [],
    )
    try {
      // It joined at an address where nothing answers any more
      writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'the laptop', key: {}, at: 'http://127.0.0.1:9', issuer: b.url }))
      const told = { IT_URL: b.url }
      const created = await run(m, ['create', 'Plan', '--id', 'plan', '--html', '<p>hi</p>', '--open'], told)
      expect([created.code, printed(created)]).toEqual([
        0,
        {
          id: 'plan',
          version: 1,
          url: `${b.url}/p/plan`,
          shownOn: [],
          hint: `No display is paired yet, so there is nowhere to show it. Run \`it site\` to open ${b.url} in a browser on this machine, already paired. Other displays are added from there.`,
        },
      ])
      expect(b.uploads).toEqual([{ path: '/upload/u/index.html', bytes: 9 }])
      const site = await run(m, ['site', '--no-open'], told)
      expect([site.code, printed(site)]).toEqual([0, { url: `${b.url}/pair#Ab3dEf6hIj9kLm2nOp5q` }])
      expect(printed(await run(m, ['status'], told))).toMatchObject({ running: true, enrolled: true, site: b.url })
      // Told nothing, it asks where it joined, and says that nothing answers there
      const untold = printed(await run(m, ['status']))
      expect(untold).toMatchObject({ running: false, site: 'http://127.0.0.1:9', hint: 'The It this machine joined does not answer at http://127.0.0.1:9.' })
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('a machine that joined an It on another computer, when that It’s door refuses it', () => {
  /** A door that answers everything it is asked the same way, and a machine that had joined at it. With `token`, the machine holds one, and asks for none. */
  async function refusing(status: number, body: string, type = 'application/json', token = true) {
    const m = machine(false)
    const server = http.createServer((req, res) => {
      req.resume().on('end', () => res.writeHead(status, { 'content-type': type }).end(body))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key: (await aKey()).privateJwk, at: url, issuer: url }))
    if (token)
      writeFileSync(
        path.join(m.it, 'token.json'),
        JSON.stringify({ token: 'a-token', exp: Math.floor(Date.now() / 1000) + 3600, machine: 'machine-1', site: url }),
      )
    return {
      m,
      url,
      close: () =>
        new Promise<void>((r) => {
          server.close(() => r())
          server.closeAllConnections()
        }),
    }
  }
  const aKey = async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true })
    return { privateJwk: await exportJWK(privateKey) }
  }
  const NO_NAME = 'It does not answer to this name. Open it as http://localhost:4700 on the machine it runs on, or by one of that machine’s own addresses.\n'

  // Each refusal is a test of its own: every one starts the program four times over
  const refusals: [what: string, status: number, body: string, type: string, code: string, message: (at: string) => string][] = [
    [
      'a path the door does not pass on',
      404,
      '{"error":"api_path"}',
      'application/json',
      'unsupported',
      (at) => `The It at ${at} does not take that from another machine (api_path).`,
    ],
    [
      'a request the door takes for another site’s',
      403,
      '{"error":"foreign_origin"}',
      'application/json',
      'unsupported',
      (at) => `The It at ${at} does not take that from another machine (foreign_origin).`,
    ],
    ['a name the door does not answer to', 421, NO_NAME, 'text/plain; charset=utf-8', 'offline', (at) => `The It at ${at} does not answer to that address.`],
    [
      'a backend the door could not reach',
      502,
      '{"error":"backend_unreachable"}',
      'application/json',
      'unavailable',
      (at) => `The It at ${at} is running, and could not answer just now. Try again in a moment.`,
    ],
    ['a request longer than the door takes', 413, '{"error":"too_large"}', 'application/json', 'limit', () => 'That is more than It takes in one request.'],
    // What the backend itself says of a request it could not read is a sentence inside JSON: the sentence is said
    [
      'a request the backend itself could not read',
      400,
      '{"code":"BadJsonBody","message":"Expected request with `Content-Type: application/json`"}',
      'application/json',
      'error',
      () => 'Expected request with `Content-Type: application/json`',
    ],
  ]
  for (const [what, status, body, type, code, message] of refusals)
    test(`${what} is said by every command as what happened and what to do, and never as the door’s own JSON`, async () => {
      const d = await refusing(status, body, type)
      try {
        for (const args of [['list'], ['whoami'], ['set', 'plan', 'step', '2'], ['create', 'Plan', '--html', '<p>hi</p>']]) {
          const ran = await run(d.m, args)
          expect([args[0], ran.code, error(ran).code, error(ran).message]).toEqual([args[0], 1, code, message(d.url)])
          expect(ran.out).toBe('')
        }
      } finally {
        await d.close()
      }
    })

  test('an It that was given another port since the machine joined signs under another address: the machine reads it again at the door, keeps it, and goes on as itself', async () => {
    const m = machine(false)
    /** What the stand-in backend signs under now, and every address a proof was made out to. */
    let issuer = ''
    const madeOutTo: string[] = []
    const configRead: number[] = []
    const server = http.createServer((req, res) => {
      const pieces: Buffer[] = []
      req
        .on('data', (c: Buffer) => pieces.push(c))
        .on('end', () => {
          const json = (value: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
          if (req.url === '/cli/config') {
            configRead.push(Date.now())
            return json({ protocol: 1, issuer })
          }
          if (req.url === '/bridge/token') {
            const { proof } = JSON.parse(Buffer.concat(pieces).toString('utf8')) as { proof: string }
            const audience = (JSON.parse(Buffer.from(proof.split('.')[1]!, 'base64url').toString('utf8')) as { aud: string }).aud
            madeOutTo.push(audience)
            // A proof made out to any other address is no proof of this machine's, as the backend answers it
            return audience === `${issuer}/bridge/token`
              ? json({ token: 'a-token', expires_in: 300 })
              : json({ error: 'The proof does not verify.', reason: 'signature' }, 401)
          }
          json({ status: 'success', value: [], logLines: [] })
        })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const key = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)
    const kept = () => JSON.parse(readFileSync(path.join(m.it, 'machine.json'), 'utf8')) as { id: string; issuer: string; key: { d: string } }
    try {
      // Joined when the backend signed under one address, which has another port in it now
      writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key, at, issuer: 'http://127.0.0.1:31691' }))
      issuer = 'http://127.0.0.1:31641'
      const ran = await run(m, ['list'])
      expect([ran.code, printed(ran)]).toEqual([0, []])
      expect(madeOutTo).toEqual(['http://127.0.0.1:31691/bridge/token', 'http://127.0.0.1:31641/bridge/token'])
      // What it read is kept, with the identity it had: the next command asks nothing again
      expect(kept()).toMatchObject({ id: 'machine-1', issuer: 'http://127.0.0.1:31641', key: { d: key.d } })
      rmSync(path.join(m.it, 'token.json'))
      expect((await run(m, ['list'])).code).toBe(0)
      expect([madeOutTo.length, configRead.length]).toEqual([3, 1])
      // Where the address is the one it has and the proof is still refused, it is the key that is not It's for this machine, and that is what is said: nothing of having been revoked
      writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ ...kept(), issuer: 'http://127.0.0.1:31641' }))
      rmSync(path.join(m.it, 'token.json'))
      issuer = 'http://127.0.0.1:31641'
      const refusing = http.createServer((req, res) => {
        req
          .resume()
          .on('end', () =>
            res
              .writeHead(req.url === '/cli/config' ? 200 : 401, { 'content-type': 'application/json' })
              .end(JSON.stringify(req.url === '/cli/config' ? { protocol: 1, issuer } : { error: 'The proof does not verify.', reason: 'signature' })),
          )
      })
      await new Promise<void>((r) => refusing.listen(0, '127.0.0.1', r))
      try {
        const there = `http://127.0.0.1:${(refusing.address() as { port: number }).port}`
        writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ ...kept(), at: there }))
        const refused = await run(m, ['list'])
        expect([refused.code, error(refused)]).toEqual([
          1,
          {
            code: 'unauthenticated',
            message: 'It did not take this machine’s proof of who it is: the key this machine holds is not the one It has for it.',
            hint: 'Run `it logout --force`, then join again with `it login`.',
          },
        ])
      } finally {
        await new Promise<void>((r) => {
          refusing.close(() => r())
          refusing.closeAllConnections()
        })
      }
    } finally {
      await new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections()
      })
    }
  })

  test('a door that will not answer by the address the machine joined at says so when the machine asks for a token, and when another asks to join there', async () => {
    const d = await refusing(421, NO_NAME, 'text/plain; charset=utf-8', false)
    try {
      const ran = await run(d.m, ['list'])
      expect([ran.code, error(ran)]).toEqual([
        1,
        {
          code: 'offline',
          message: `The It at ${d.url} does not answer to that address.`,
          hint: 'On the machine It runs on, `it network` lists the addresses it answers to. Join at one of those with `it login`, after `it logout` if this machine had joined at another.',
        },
      ])
      const fresh = machine(false)
      const join = await run(fresh, ['login', '--url', d.url, '--code', 'Ab3dEf6hIj9kLm2nOp5q', '--no-setup'])
      expect([join.code, error(join).code, error(join).message]).toEqual([1, 'offline', `The It at ${d.url} does not answer to that address.`])
      expect(existsSync(path.join(fresh.it, 'machine.json'))).toBe(false)
    } finally {
      await d.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('`it setup --none`, which connects no agent app', () => {
  /** A backend program that is not there: a first run asks for it before anything else, and ends saying so. */
  const noProgram = (m: { home: string }) => ({ IT_BACKEND_BIN: path.join(m.home, 'no-such-program') })
  const begun = (m: { it: string }) => ['service.json', 'machine.json', 'backend'].filter((name) => existsSync(path.join(m.it, name)))
  /** The note a folder keeps of an add-on it put into Claude Code. No `claude` is on the PATH here, so it cannot be asked to take it out. */
  const noteAddon = (m: { it: string }) => {
    mkdirSync(path.join(m.it, 'addons'), { recursive: true })
    writeFileSync(path.join(m.it, 'addons', 'claude-code.json'), JSON.stringify({ version: '0.1.0', at: 1 }))
  }
  const NOTHING_STARTED = 'It is not set up in this folder, which holds only what an earlier use of It left there, so nothing was started.'
  const COULD_NOT_ASK = 'Claude Code could not be run from here, so its add-on was left as it is'

  test('on a machine that has never been set up it is a first run: the first thing it asks for is the backend program', async () => {
    // As the install script leaves a machine: the program's own files, and nothing of a machine
    const m = machine(false)
    mkdirSync(path.join(m.it, 'bin'))
    mkdirSync(path.join(m.it, 'addons'))
    writeFileSync(path.join(m.it, 'LICENSE.md'), 'the terms')
    const ran = await run(m, ['setup', '--none', '--no-service'], noProgram(m))
    expect([ran.code, error(ran).code]).toEqual([1, 'backend_program'])
    expect(ran.err).not.toContain(NOTHING_STARTED)
  })

  test('in a folder a machine has left it takes that folder’s add-ons out and begins nothing, and `it logout` has tried to take them out already', async () => {
    const m = machine(false)
    const b = await backend(m)
    try {
      // A machine that joined the It at that address, with nothing set but its folder
      writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key: {}, at: b.url, issuer: b.url }))
      noteAddon(m)
      // While it is one of the person's machines, `--none` takes add-ons out and tells the backend that none is wanted
      const still = await run(m, ['setup', '--none', '--no-service'], noProgram(m))
      expect(still.code).toBe(0)
      expect(b.asked.map((x) => [x.path, x.args])).toEqual([
        ['machines:choose', { harnesses: [] }],
        ['machines:inventory', { harnesses: [] }],
      ])
      expect(still.err).toContain(COULD_NOT_ASK)
      // Leaving takes the add-ons out too. This one could not be, so its note is kept for later
      const left = await run(m, ['logout'])
      expect([left.code, printed(left)]).toEqual([0, { ok: true }])
      expect(left.err).toContain(COULD_NOT_ASK)
      expect(begun(m)).toEqual([])
      expect(existsSync(path.join(m.it, 'addons', 'claude-code.json'))).toBe(true)
      const asked = b.asked.length
      // Afterwards `--none` is that taking out, tried again, and nothing more
      const ran = await run(m, ['setup', '--none', '--no-service'], noProgram(m))
      expect([ran.code, printed(ran)]).toEqual([0, { harnesses: [], wanted: [] }])
      expect(ran.err).toContain(COULD_NOT_ASK)
      expect(ran.err).toContain(NOTHING_STARTED)
      expect(begun(m)).toEqual([])
      // And still when the add-on is out, and the folder holds nothing of it any more
      rmSync(path.join(m.it, 'addons'), { recursive: true })
      const again = await run(m, ['setup', '--none'], noProgram(m))
      expect([again.code, printed(again)]).toEqual([0, { harnesses: [], wanted: [] }])
      expect(again.err).toContain(NOTHING_STARTED)
      expect(again.err).not.toContain(COULD_NOT_ASK)
      expect(begun(m)).toEqual([])
      expect(b.asked.length).toBe(asked)
      // Setting It up there is asked for in so many words, and is then a first run
      const plain = await run(m, ['setup', '--yes', '--no-service'], noProgram(m))
      expect([plain.code, error(plain).code]).toEqual([1, 'backend_program'])
    } finally {
      await b.close()
    }
  })

  test('in a folder with no settings that still has a note of an add-on it takes that out and begins nothing, then and afterwards', async () => {
    const m = machine(false)
    noteAddon(m)
    const ran = await run(m, ['setup', '--none'], noProgram(m))
    expect([ran.code, printed(ran)]).toEqual([0, { harnesses: [], wanted: [] }])
    expect(ran.err).toContain(COULD_NOT_ASK)
    expect(ran.err).toContain(NOTHING_STARTED)
    expect(begun(m)).toEqual([])
    // The folder is known for what it is once the add-on is out of it as well
    rmSync(path.join(m.it, 'addons'), { recursive: true })
    const again = await run(m, ['setup', '--none'], noProgram(m))
    expect(again.code).toBe(0)
    expect(again.err).toContain(NOTHING_STARTED)
    expect(begun(m)).toEqual([])
  })

  test('where the backend is named and this machine has not joined it, it takes add-ons out, begins nothing and asks the backend nothing', async () => {
    const m = machine(false)
    const b = await backend(m)
    try {
      const ran = await run(m, ['setup', '--none'], { ...b.env, ...noProgram(m) })
      expect([ran.code, printed(ran)]).toEqual([0, { harnesses: [], wanted: [] }])
      expect(begun(m)).toEqual([])
      expect(b.asked).toEqual([])
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('`it setup`, and which agent apps it connects', () => {
  const chose = (b: { asked: Asked[] }) => b.asked.filter((x) => x.path === 'machines:choose').map((x) => x.args.harnesses)
  const UNASKED =
    'There is no terminal here to ask at, so Pi was not connected. Run `it setup --all` to connect every agent app that was found, or `it setup --only pi` to connect the one named.'

  test('where there is no terminal to ask at, it connects nothing that was not connected, says what it found, and says which command connects it', async () => {
    const m = machine()
    const ran = pi(m)
    const b = await backend(m, (asked) => (asked.path === 'machines:me' ? { id: 'machine-1', name: 'test', wanted: [] } : null))
    try {
      const setup = await run(m, ['setup', '--no-service'], b.env)
      expect(setup.code).toBe(0)
      expect(setup.err).toContain('  Pi 0.82.0')
      expect(setup.err).toContain(UNASKED)
      expect(printed(setup)).toEqual({
        harnesses: [{ id: 'pi', version: '0.82.0', addon: 'not_connected' }],
        service: { registered: false, state: 'not installed' },
        hint: UNASKED,
      })
      // Pi was looked at, and nothing was put into it
      expect(ran().some((words) => words.startsWith('install'))).toBe(false)
      expect(chose(b)).toEqual([[]])
    } finally {
      await b.close()
    }
  })

  test('`--yes` answers yes for every app that would be asked about, and so do `--all` and `--only` for the ones they name', async () => {
    for (const flags of [['--yes'], ['--all'], ['--only', 'pi']]) {
      const m = machine()
      const ran = pi(m)
      const b = await backend(m, (asked) => (asked.path === 'machines:me' ? { id: 'machine-1', name: 'test', wanted: [] } : null))
      try {
        const setup = await run(m, ['setup', '--no-service', ...flags], b.env)
        expect([flags, setup.code]).toEqual([flags, 0])
        expect(printed(setup)).toEqual({
          harnesses: [{ id: 'pi', version: '0.82.0', addon: 'connected' }],
          service: { registered: false, state: 'not installed' },
        })
        expect(setup.err).not.toContain('There is no terminal here')
        expect([flags, ran().filter((words) => words.startsWith('install')).length, chose(b)]).toEqual([flags, 1, [['pi']]])
      } finally {
        await b.close()
      }
    }
  })

  test('with no terminal, what the person chose before stays chosen and what is connected stays connected, and neither is taken out', async () => {
    const m = machine()
    const ran = pi(m)
    let wanted: string[] = []
    const b = await backend(m, (asked) => (asked.path === 'machines:me' ? { id: 'machine-1', name: 'test', wanted } : null))
    try {
      expect((await run(m, ['setup', '--no-service', '--only', 'pi'], b.env)).code).toBe(0)
      // It has stopped knowing what was chosen, as after everything was erased, and Pi is still connected
      b.asked.length = 0
      const kept = await run(m, ['setup', '--no-service'], b.env)
      expect([kept.code, printed(kept).harnesses, chose(b)]).toEqual([0, [{ id: 'pi', version: '0.82.0', addon: 'connected' }], [['pi']]])
      expect(kept.err).not.toContain('There is no terminal here')
      expect(ran().some((words) => words.startsWith('remove'))).toBe(false)
      // And an app that was chosen and whose add-on has gone from it is given it again, as the connector would by itself
      rmSync(path.join(m.home, 'pi-has'))
      rmSync(path.join(m.it, 'addons'), { recursive: true })
      wanted = ['pi']
      b.asked.length = 0
      const again = await run(m, ['setup', '--no-service'], b.env)
      expect([again.code, printed(again).harnesses, chose(b)]).toEqual([0, [{ id: 'pi', version: '0.82.0', addon: 'connected' }], [['pi']]])
    } finally {
      await b.close()
    }
  })

  test('`it setup --none` where It is set up takes the add-ons out and leaves the background service as it is, neither registering it nor starting it again', async () => {
    // A machine that joined an It, with its background service registered and running, and Pi connected
    const m = machine(false)
    const ran = pi(m)
    // What the system's own commands were asked, each time one was run
    const calls = path.join(m.home, 'system-was-asked')
    for (const name of ['systemctl', 'loginctl', 'launchctl']) {
      writeFileSync(path.join(m.bin, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\ncase " $* " in ${SAYS_IT_RUNS} esac\nexit 0\n`)
      chmodSync(path.join(m.bin, name), 0o755)
    }
    const b = await backend(m, (asked) => (asked.path === 'machines:me' ? { id: 'machine-1', name: 'test', wanted: ['pi'] } : null))
    try {
      writeFileSync(path.join(m.it, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key: {}, at: b.url, issuer: b.url }))
      expect((await run(m, ['setup', '--only', 'pi', '--no-service'])).code).toBe(0)
      expect((await run(m, ['service', 'install'])).code).toBe(0)
      const registered =
        process.platform === 'linux' ? path.join(m.home, '.config/systemd/user/it.service') : path.join(m.home, 'Library/LaunchAgents/dev.it.plist')
      const definition = readFileSync(registered, 'utf8')
      const asked = () => readFileSync(calls, 'utf8').trim().split('\n')
      const before = asked().length
      b.asked.length = 0
      const none = await run(m, ['setup', '--none'])
      expect(none.code).toBe(0)
      // Pi's add-on is out, and It was told that none is wanted
      expect(ran().some((words) => words.startsWith('remove'))).toBe(true)
      expect(chose(b)).toEqual([[]])
      expect(printed(none)).toEqual({
        harnesses: [{ id: 'pi', version: '0.82.0', addon: 'not_connected' }],
        service: { registered: true, state: expect.any(String), where: registered },
      })
      // The system was asked how the service is, and to do nothing: what is registered is as it was
      expect(
        asked()
          .slice(before)
          .filter((line) => !/ is-active | is-enabled | print /.test(`${line} `)),
      ).toEqual([])
      expect(readFileSync(registered, 'utf8')).toBe(definition)
      expect(none.err).not.toMatch(/It runs in the background|registered as a background service|It’s site is at/)
    } finally {
      await b.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('`it setup`, and whether an agent will find `it`', () => {
  test('says that It’s folder of programs is not on the PATH, with the line that puts it there, and says nothing once it is', async () => {
    // A home with an apostrophe in its name: the line must still be one a shell reads as meant
    const m = machine()
    const odd = path.join(m.home, "o'neil")
    mkdirSync(odd)
    writeFileSync(path.join(odd, 'machine.json'), JSON.stringify({ id: 'machine-1', name: 'test', key: {} }))
    const b = await backend({ it: odd })
    try {
      const ran = await run(m, ['setup', '--yes', '--no-service'], { ...b.env, IT_HOME: odd })
      expect(ran.code).toBe(0)
      expect(ran.err).toContain('`it` is not on your PATH yet, so an agent that runs it by name will not find it.')
      const line = /^ {2}(export PATH=.*)$/m.exec(ran.err)![1]!
      expect(line).toBe(`export PATH='${path.join(m.home, 'o')}'\\''${path.join('neil', 'bin')}':"$PATH"`)
      // Read by a shell, the line puts the folder first, and the launcher that setup left there is found by its name
      expect(existsSync(path.join(odd, 'bin', 'it'))).toBe(true)
      const found = execFileSync('/bin/sh', ['-c', `PATH=/usr/bin:/bin; ${line}; command -v it`])
        .toString()
        .trim()
      expect(found).toBe(path.join(odd, 'bin', 'it'))
      const onPath = await run(m, ['setup', '--yes', '--no-service'], { ...b.env, IT_HOME: odd, PATH: `${m.bin}${path.delimiter}${path.join(odd, 'bin')}` })
      expect(onPath.err).not.toContain('PATH')
    } finally {
      await b.close()
    }
  })
})
