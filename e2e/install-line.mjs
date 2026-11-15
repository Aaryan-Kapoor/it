// The install line as a person pastes it into a terminal, `curl -fsSL <address>/install.sh | sh`,
// typed into an interactive shell that has a real terminal of its own, against a stand-in for
// the releases on this machine. The install then hands the terminal to `it setup`, and this
// presses keys at setup's first question as a person would: the down arrow, which must move the
// mark, and Control+C, which must end setup and give the shell its terminal back. It does the
// same once more with `it setup` started by hand with its input from `/dev/tty`, where setup must
// either hear the keys or say that it cannot and end. Nothing is set up: setup is left at its
// first question.
//
//   node packages/cli/release.mjs && node e2e/install-line.mjs
//   node e2e/install-line.mjs <folder holding the built programs>
//
// It needs python3, whose `pty` module gives the shell a terminal that is its controlling
// terminal, as a terminal window gives the shell it starts, and curl. It runs in each of zsh and
// bash that the machine has. It is not for Windows, whose install line is another.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { root } from './lib.mjs'
import { redact } from './logs.mjs'

if (process.platform === 'win32') {
  console.error('The install line is for Linux and macOS. On Windows, e2e/install.mjs runs install.ps1.')
  process.exit(2)
}
const built = path.resolve(process.argv[2] ?? path.join(root, 'packages/cli/dist/bin'))
const script = path.resolve(process.env.IT_INSTALL_SCRIPT ?? path.join(root, 'install/install.sh'))
const program = `it-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
if (!existsSync(path.join(built, program)) || !existsSync(path.join(built, 'SHA256SUMS'))) {
  console.error(`no ${program} in ${built}: build the programs first with node packages/cli/release.mjs`)
  process.exit(2)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok && detail) console.log(redact(String(detail)).slice(-3000).replace(/^/gm, '     '))
}

// The releases as GitHub lays them out, both the latest and any release by its tag, so that a
// script with a release written into it is answered too, and the script itself at /install.sh
// as the site serves it
const server = http.createServer((req, res) => {
  const wanted = decodeURIComponent((req.url ?? '/').split('?')[0])
  if (wanted === '/install.sh') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(readFileSync(script))
  const m = /^\/(?:latest\/download|download\/v[0-9A-Za-z._-]+)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(wanted)
  const file = m && path.join(built, m[1])
  if (!file || !existsSync(file)) return void res.writeHead(404).end()
  res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(readFileSync(file))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

// Run by python3 with a description of what to do: starts a shell with a terminal of its own,
// which is its controlling terminal as in a terminal window, types into it and reads what it
// draws. What is read is searched with the terminal's own codes taken out, so that a line drawn
// in colour reads as its words. It prints, as JSON, which of the things it looked for it saw,
// and the end of what was drawn.
const DRIVE = String.raw`
import fcntl, json, os, pty, re, select, struct, sys, termios, time
spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(spec['argv'][0], spec['argv'])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
drawn = b''
def read(seconds):
    global drawn
    end = time.time() + seconds
    while True:
        left = end - time.time()
        if left <= 0:
            return
        if select.select([fd], [], [], min(left, 0.05))[0]:
            try:
                got = os.read(fd, 65536)
            except OSError:
                return
            if not got:
                return
            drawn += got
plain = lambda: re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]|\r', '', drawn.decode('utf-8', 'replace'))
seen = {}
since = 0
for step in spec['steps']:
    if 'send' in step:
        since = len(plain())
        os.write(fd, step['send'].encode())
    if 'wait' in step:
        read(step['wait'])
    if 'expect' in step:
        pattern = re.compile(step['expect'])
        end = time.time() + step['timeout']
        found = None
        while time.time() < end:
            found = pattern.search(plain(), since)
            if found:
                break
            read(0.2)
        seen[step['as']] = found.group(0) if found else None
        if not found and step.get('stop'):
            break
# The terminal is closed, which hangs up on the shell and whatever runs in it
os.close(fd)
for _ in range(50):
    if os.waitpid(pid, os.WNOHANG)[0]:
        break
    time.sleep(0.1)
else:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
print(json.dumps({'seen': seen, 'drawn': plain()[-6000:]}))
`

/** Everything this test has, but anything of It's own and anything that marks an agent's conversation, which would turn the script and the program to words for an agent. */
const plainEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(IT_|DO_NOT_TRACK$|CLAUDE|CODEX_|OPENCLAW_|HERMES_|OPENCODE_|PI_SESSION_ID$|ZDOTDIR$|BASH_ENV$|ENV$)/.test(k)),
  )

const tmp = mkdtempSync(path.join(os.tmpdir(), 'it-line-'))
/** Stops by its number anything left running from the program installed into this home, which only a fault here would leave. */
const leftFrom = (home) => {
  const listed = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })
  for (const row of listed.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(row)
    if (m && m[2].includes(path.join(home, '.it', 'bin'))) {
      try {
        process.kill(Number(m[1]), 'SIGKILL')
      } catch {}
    }
  }
}

/**
 * Starts the shell named in a home of its own, with a terminal, types `line` at its prompt, and
 * at setup's first question presses the down arrow and then Control+C, and asks the shell how
 * the line ended. Says what it saw.
 */
async function atTheQuestion(shell, home, line) {
  const env = {
    ...plainEnv(),
    HOME: home,
    SHELL: shell,
    TERM: 'xterm-256color',
    IT_INSTALL_BASE: base,
    // What the program reports goes to an address on this machine where nothing listens
    IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    PS1: '$ ',
    PROMPT: '$ ',
  }
  const argv = path.basename(shell) === 'zsh' ? [shell, '-i'] : [shell, '--noprofile', '--norc', '-i']
  const steps = [
    { wait: 2 },
    { send: `${line}\r` },
    { expect: 'Where is your It\\?[\\s\\S]*On another computer', timeout: 240, as: 'question', stop: true },
    // Time for setup to begin reading keys, as a person takes to read the question
    { wait: 1.5 },
    { send: '\x1b[B' },
    { expect: '❯ ?On another computer', timeout: 10, as: 'moved' },
    { send: '\x03' },
    { wait: 2 },
    { send: 'echo "ended:$?"\r' },
    { expect: 'ended:\\d+', timeout: 10, as: 'ended' },
  ]
  const said = await new Promise((resolve) => {
    const child = spawn('python3', ['-c', DRIVE, JSON.stringify({ argv, steps })], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', () => {
      try {
        resolve(JSON.parse(out))
      } catch {
        resolve({ seen: {}, drawn: `${out}\n${err}` })
      }
    })
  })
  leftFrom(home)
  return said
}

const shells = ['/bin/zsh', '/bin/bash', '/usr/bin/zsh', '/usr/bin/bash'].filter(existsSync).filter((s, i, all) => all.findIndex((t) => path.basename(t) === path.basename(s)) === i)
try {
  for (const shell of shells) {
    const name = path.basename(shell)
    const home = path.join(tmp, name)
    mkdirSync(home, { recursive: true })
    // An empty startup file of the shell's own, as a person has one, so that zsh does not offer to write one first
    for (const file of ['.zshrc', '.bashrc']) writeFileSync(path.join(home, file), '')
    const r = await atTheQuestion(shell, home, `curl -fsSL ${base}/install.sh | sh`)
    check(`in ${name}, the install line installs It and goes on to setup's first question`, r.seen.question, r.drawn)
    if (!r.seen.question) continue
    check(`in ${name}, setup hears the down arrow at its first question`, r.seen.moved, r.drawn)
    check(`in ${name}, Control+C ends setup at its first question and gives the shell its terminal back`, r.seen.ended === 'ended:130', r.drawn)
    check(`in ${name}, nothing was set up`, !readdirSync(path.join(home, '.it')).some((f) => ['settings.json', 'service.json', 'backend'].includes(f)))

    // Setup started by hand with its input from /dev/tty, as the script started it before: it
    // hears the keys, or says that it cannot and ends, and never sits there deaf
    const byHand = await new Promise((resolve) => {
      const steps = [
        { wait: 2 },
        { send: `"$HOME/.it/bin/it" setup < /dev/tty; echo "ended:$?"\r` },
        { expect: 'Where is your It\\?[\\s\\S]*On another computer|ended:\\d+', timeout: 60, as: 'first', stop: true },
        { wait: 1.5 },
        { send: '\x1b[B' },
        { expect: '❯ ?On another computer|ended:\\d+', timeout: 10, as: 'moved' },
        { send: '\x03' },
        { expect: 'ended:\\d+', timeout: 10, as: 'ended' },
      ]
      const env = { ...plainEnv(), HOME: home, SHELL: shell, TERM: 'xterm-256color', IT_TELEMETRY_URL: 'http://127.0.0.1:9/usage', BASH_SILENCE_DEPRECATION_WARNING: '1', PS1: '$ ', PROMPT: '$ ' }
      const argv = name === 'zsh' ? [shell, '-i'] : [shell, '--noprofile', '--norc', '-i']
      const child = spawn('python3', ['-c', DRIVE, JSON.stringify({ argv, steps })], { env, cwd: home, stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.on('close', () => {
        try {
          resolve(JSON.parse(out))
        } catch {
          resolve({ seen: {}, drawn: out })
        }
      })
    })
    leftFrom(home)
    const heard = byHand.seen.moved?.includes('❯') && byHand.seen.ended === 'ended:130'
    const refused = /ended:[1-9]/.test(byHand.seen.first ?? '') && /setup`? again in a terminal/i.test(byHand.drawn)
    check(`in ${name}, setup started with its input from /dev/tty hears the keys, or says it cannot and ends`, heard || refused, byHand.drawn)
    if (refused) console.log(`     (setup said it cannot read keys there, and ended)`)
  }
  if (!shells.length) check('there is a zsh or a bash to type the install line into', false)
} finally {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
