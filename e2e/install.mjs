// Installs It the way a person does, from a stand-in for the repository's releases on this
// machine: the install script for this system downloads the program that `release.mjs` built,
// checks it, and puts it in a folder made for the test. Nothing is published and nothing of the
// person's own is touched.
//
//   node packages/cli/release.mjs && node e2e/install.mjs
//   node e2e/install.mjs <folder holding the built programs>
//
// Away from Windows it needs python3, which is how an install is given a terminal to print to.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { root, sleep } from './lib.mjs'
import { redact } from './logs.mjs'

const built = path.resolve(process.argv[2] ?? path.join(root, 'packages/cli/dist/bin'))
const results = []
// What a failed check prints may hold anything the scripts said: cleaned of anything shaped like a credential first
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : `\n         ${redact(String(detail)).slice(0, 600)}`}`)
}
const windows = process.platform === 'win32'
const program = windows ? 'it-windows-x64.exe' : `it-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
if (!existsSync(path.join(built, program)) || !existsSync(path.join(built, 'SHA256SUMS'))) {
  console.error(`no ${program} in ${built}: build the programs first with node packages/cli/release.mjs`)
  process.exit(2)
}

// The releases as GitHub lays them out: <base>/latest/download/<file> and <base>/download/<tag>/<file>
const tmp = mkdtempSync(path.join(os.tmpdir(), 'it-install-'))
const releases = path.join(tmp, 'releases')
const lay = (dir) => {
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(built)) copyFileSync(path.join(built, name), path.join(dir, name))
  return dir
}
lay(path.join(releases, 'latest', 'download'))
lay(path.join(releases, 'download', 'v0.0.1'))
// A release whose program is not the one its checksums were made for, and one whose license is not
const tampered = lay(path.join(releases, 'download', 'tampered'))
writeFileSync(path.join(tampered, program), `${readFileSync(path.join(built, program)).subarray(0, 4096).toString('latin1')}not the program`)
const relicensed = lay(path.join(releases, 'download', 'relicensed'))
writeFileSync(path.join(relicensed, 'LICENSE.md'), 'Do as you like.\n')
// One whose checksums were written on Windows, with its line endings
const crlf = lay(path.join(releases, 'download', 'crlf'))
writeFileSync(path.join(crlf, 'SHA256SUMS'), readFileSync(path.join(built, 'SHA256SUMS'), 'utf8').replace(/\n/g, '\r\n'))
// And one whose checksums name a file that only looks like the license's name to a pattern
const lookalike = lay(path.join(releases, 'download', 'lookalike'))
writeFileSync(path.join(lookalike, 'SHA256SUMS'), readFileSync(path.join(built, 'SHA256SUMS'), 'utf8').replace('  LICENSE.md', '  LICENSEXmd'))
// And another release whole: a different program, license and notices, with checksums that are
// right for them, so that it can be told which release each installed file came from
const latest = path.join(releases, 'latest', 'download')
const other = path.join(releases, 'download', 'other')
mkdirSync(other, { recursive: true })
const otherHolds = {
  [program]: '#!/bin/sh\necho \'{"version": "9.9.9"}\'\n',
  'LICENSE.md': 'The terms of another release.\n',
  'THIRD_PARTY_NOTICES.md': 'The notices of another release.\n',
}
for (const [name, holds] of Object.entries(otherHolds)) writeFileSync(path.join(other, name), holds)
writeFileSync(
  path.join(other, 'SHA256SUMS'),
  Object.entries(otherHolds)
    .map(([name, holds]) => `${createHash('sha256').update(holds).digest('hex')}  ${name}\n`)
    .join(''),
)
// One whose license is not sent until the test says so, so that an install can be caught in
// the middle of its downloads
const held = lay(path.join(releases, 'download', 'held'))
let reachedHeld = false
let letGo = () => {}
// And one whose program is the one its checksums were made for, and cannot be started on any
// system: what stands in for a program built for another system's libraries or another chip
const unstartable = path.join(releases, 'download', 'unstartable')
mkdirSync(unstartable, { recursive: true })
const unstartableHolds = { ...otherHolds, [program]: '#!/no/such/program\n' }
for (const [name, holds] of Object.entries(unstartableHolds)) writeFileSync(path.join(unstartable, name), holds)
writeFileSync(
  path.join(unstartable, 'SHA256SUMS'),
  Object.entries(unstartableHolds)
    .map(([name, holds]) => `${createHash('sha256').update(holds).digest('hex')}  ${name}\n`)
    .join(''),
)

/** Whether an install said anything of the usage counts It reports. It says nothing of them: the program does, at the first command a person runs at a terminal. */
const saysOfUsage = (r) => /reports usage|telemetry/i.test(r.said)
/** Everything asked of this machine's stand-in servers, by the host that was asked and the path. */
const asked = []
const serve = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      asked.push(`${req.headers.host}${req.url}`)
      handler(req, res)
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
const server = await serve(async (req, res) => {
  const file = path.join(releases, decodeURIComponent((req.url ?? '/').split('?')[0]))
  if (!file.startsWith(releases) || !existsSync(file)) return res.writeHead(404).end()
  if (file === path.join(held, 'LICENSE.md')) {
    reachedHeld = true
    await new Promise((resolve) => {
      letGo = resolve
    })
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(readFileSync(file))
})
const base = `http://127.0.0.1:${server.address().port}`
// Somewhere else, which the install must never be led to: it serves the same files to whoever asks
const elsewhereServer = await serve((req, res) => {
  const file = path.join(releases, 'latest', 'download', path.basename(req.url ?? ''))
  res.writeHead(existsSync(file) ? 200 : 404).end(existsSync(file) ? readFileSync(file) : undefined)
})
const elsewherePort = elsewhereServer.address().port
// And a base on this machine that sends every request on to it
const redirecting = await serve((req, res) => res.writeHead(302, { location: `http://127.0.0.1:${elsewherePort}${req.url}` }).end())

// And a proxy, which a download from this machine itself has no business going through
const throughProxy = []
const proxy = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    throughProxy.push(req.url)
    res.writeHead(502).end()
  })
  s.listen(0, '127.0.0.1', () => resolve(s))
})

/**
 * Runs a command to its end without stopping this process, which is also what answers its
 * downloads. `started` is given the running command, for a test that has something to do to it.
 */
const run = (cmd, args, env, cwd, started) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    started?.(child)
    let said = ''
    child.stdout.on('data', (d) => (said += d))
    child.stderr.on('data', (d) => (said += d))
    child.on('error', (err) => resolve({ status: -1, said: String(err) }))
    child.on('close', (status) => resolve({ status, said }))
  })

// Run by python3 with a command after it: the command is given a terminal for what it prints,
// as it has when a person runs it, and what it prints there is passed on. The terminal is kept
// open here until the command has ended and everything it printed has been read.
const AT_A_TERMINAL = `
import os, select, subprocess, sys
ours, theirs = os.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=theirs, stderr=theirs)
while True:
    if select.select([ours], [], [], 0.05)[0]:
        os.write(1, os.read(ours, 65536))
    elif child.poll() is not None:
        break
sys.exit(child.returncode if child.returncode >= 0 else 128 - child.returncode)
`

/**
 * What an install script, or the program it installed, is started with here: everything this
 * test has, except anything It-specific, anything that marks an agent's conversation, and the
 * two variables that turn usage reporting off. The program writes it down in its folder when
 * it finds one of those two, and a test that then lists the folder would depend on the shell
 * it was run from.
 */
const plainEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(IT_|DO_NOT_TRACK$|CLAUDE|CODEX_|OPENCLAW_|HERMES_|OPENCODE_|PI_SESSION_ID$)/.test(k)))

/**
 * Runs this system's install script as a person with a home of their own. `terminal` gives the
 * script a terminal to print to; without it, what it prints goes to this program, as it does
 * to an agent or a script that runs it. What it said comes back twice: as it was said, and
 * `flat`, with every run of white space made one space, which is how to look for a sentence in
 * an error that Windows PowerShell has folded to the width of a window.
 */
async function install(
  name,
  extraEnv = {},
  {
    shell = '/bin/sh',
    home = path.join(tmp, name),
    first = '',
    started,
    terminal = false,
    piped = false,
    script = path.join(root, 'install/install.sh'),
    // What is given after the script, as `sh -s -- login ...` gives it to one read from a pipe
    args = [],
  } = {},
) {
  mkdirSync(home, { recursive: true })
  const env = {
    ...plainEnv(),
    HOME: home,
    USERPROFILE: home,
    SHELL: shell,
    IT_INSTALL_BASE: base,
    // On Windows the PATH a person has is kept in the registry, which a test must leave alone
    ...(windows ? { IT_INSTALL_NO_PATH: '1' } : {}),
    ...extraEnv,
  }
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k]
  const ps1 = path.join(root, 'install/install.ps1')
  // `piped` hands PowerShell the script as one piece of text to run, which is what
  // `irm ... | iex` does, and then asks what running it left behind in the session
  const pipedIn = [
    '$itTestTls = [Net.ServicePointManager]::SecurityProtocol',
    `Get-Content -Raw -LiteralPath '${ps1.replaceAll("'", "''")}' | Invoke-Expression`,
    "if ((Test-Path variable:root) -or (Test-Path function:Get-File) -or $ErrorActionPreference -ne 'Continue' -or [Net.ServicePointManager]::SecurityProtocol -ne $itTestTls) { Write-Output 'something was left behind in the session'; exit 9 }",
  ].join('\n')
  const r = windows
    ? await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...(piped ? encoded(pipedIn) : ['-File', ps1])], env, home, started)
    : // `first` is a line of shell run in the very process that then becomes the install, so
      // that it can do something under the number that process is known by
      await run(
        terminal ? 'python3' : 'sh',
        [...(terminal ? ['-c', AT_A_TERMINAL, 'sh'] : []), ...(first ? ['-c', `${first}; exec sh "$1"`, 'sh', script] : [script, ...args])],
        env,
        home,
        started,
      )
  const folder = env.IT_HOME ? path.resolve(home, env.IT_HOME) : path.join(home, '.it')
  const said = r.said.replace(/\r\n/g, '\n')
  return { home, folder, it: path.join(folder, 'bin', windows ? 'it.exe' : 'it'), code: r.status, said, flat: said.replace(/\s+/g, ' ') }
}
const runs = (it, home) => {
  try {
    return JSON.parse(
      execFileSync(it, ['--version'], { env: { ...plainEnv(), HOME: home, USERPROFILE: home, IT_HOME: path.join(home, '.it') }, encoding: 'utf8' }),
    ).version
  } catch (err) {
    return `did not run: ${err.message}`
  }
}
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null)
/** The commands an install printed for the person to copy: the next step, and the PATH for this terminal. */
const printed = (r) => ({
  next: /^ {2}(.* setup)$/m.exec(r.said)?.[1] ?? '',
  path: /or run: {2}(export PATH=.*)$/m.exec(r.said)?.[1] ?? '',
})
/**
 * How PowerShell is handed a command in a form that no quoting on the way can change. Asked
 * this way it would print its errors as XML, unless told to print them as text.
 */
const encoded = (command) => ['-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]
/** Runs a line of PowerShell. */
const inPowerShell = (command, r) => run('powershell', ['-NoProfile', ...encoded(command)], { ...plainEnv(), IT_HOME: r.folder }, r.home)
/** Runs a command as it was printed, the way someone who copied it into their own shell would. */
const asPrinted = (command, r) =>
  windows ? inPowerShell(command, r) : run('sh', ['-c', command], { PATH: '/usr/bin:/bin', HOME: r.home, IT_HOME: r.folder }, r.home)
const nothingInstalled = (r) => !existsSync(r.it) && !existsSync(path.join(r.folder, 'LICENSE.md')) && !existsSync(path.join(r.folder, 'telemetry.json'))
const nothingLeftBehind = (r) => !existsSync(path.join(r.folder, 'bin')) || readdirSync(path.join(r.folder, 'bin')).every((f) => f === 'it' || f === 'it.exe')
/** Whether a folder holds one release's program, license and notices, all three, and so nothing of any other release's. */
const whole = (r, release) =>
  [
    [r.it, program],
    [path.join(r.folder, 'LICENSE.md'), 'LICENSE.md'],
    [path.join(r.folder, 'THIRD_PARTY_NOTICES.md'), 'THIRD_PARTY_NOTICES.md'],
  ].every(([at, name]) => existsSync(at) && readFileSync(at).equals(readFileSync(path.join(release, name))))
/** Nothing an install makes for its own use while it runs is still in the folder: no folder of downloads, and no lock. */
const nothingOfItsOwn = (r) => !existsSync(r.folder) || readdirSync(r.folder).every((f) => !f.startsWith('.'))
/** Waits, for a few seconds at most, until something is so. */
const until = async (so) => {
  for (let i = 0; i < 200 && !so(); i++) await sleep(50)
  return so()
}
/**
 * A folder to put first on the PATH, holding a stand-in for `mv` that does what the script
 * says whenever the license is about to be moved into place, and is `mv` otherwise. By then
 * the program has been replaced and the notices have not.
 */
const mvThat = (name, atTheLicense) => {
  const dir = path.join(tmp, name)
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'mv'), `#!/bin/sh\nfor last; do :; done\ncase "$last" in */LICENSE.md)\n${atTheLicense(dir)}\n;; esac\nexec /bin/mv "$@"\n`, {
    mode: 0o755,
  })
  return { dir, PATH: `${dir}${path.delimiter}${process.env.PATH}` }
}
/**
 * A folder holding the commands named and no others, each a link to where this system keeps
 * it: put alone on the PATH, it is a system that has only those.
 */
const systemWithOnly = (dir, names) => {
  mkdirSync(dir, { recursive: true })
  for (const name of names) {
    const found = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((d) => path.join(d, name))
      .find((f) => existsSync(f))
    if (found) symlinkSync(found, path.join(dir, name))
  }
  return dir
}

try {
  // Whatever a person takes from a release, they can check
  const published = new Map(
    readFileSync(path.join(built, 'SHA256SUMS'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split('  ').reverse()),
  )
  const unchecked = readdirSync(built).filter(
    (f) =>
      f !== 'SHA256SUMS' &&
      published.get(f) !==
        createHash('sha256')
          .update(readFileSync(path.join(built, f)))
          .digest('hex'),
  )
  check('every file of a release is named in its checksums, with the checksum it has', unchecked.length === 0, unchecked.join(' '))
  // Some shells, and Windows PowerShell reading a script with no mark at its start, misread anything else
  check(
    'both install scripts are written in plain letters only',
    ['install/install.sh', 'install/install.ps1'].every((f) => readFileSync(path.join(root, f)).every((byte) => byte < 128)),
  )

  // Windows tells running programs of a changed PATH when one of the account's variables is set
  // or removed, and a script that set one of its own for that would overwrite one already there
  check(
    'the Windows script announces a changed PATH without setting or removing any variable of the account’s',
    !/SetEnvironmentVariable/.test(readFileSync(path.join(root, 'install/install.ps1'), 'utf8')),
  )

  const one = await install('one')
  check('the install script downloads the program for this system and puts it in ~/.it/bin', one.code === 0 && existsSync(one.it), one.said)
  check('the program it installed runs', /^\d+\.\d+\.\d+$/.test(runs(one.it, one.home)), runs(one.it, one.home))
  check('it is the program that was built, byte for byte', existsSync(one.it) && readFileSync(one.it).equals(readFileSync(path.join(built, program))))
  check(
    'the license and the notices of what the program includes are put beside it',
    // As they are in the release, which is what the checksums were made for
    ['LICENSE.md', 'THIRD_PARTY_NOTICES.md'].every(
      (f) => existsSync(path.join(one.folder, f)) && readFileSync(path.join(one.folder, f)).equals(readFileSync(path.join(built, f))),
    ),
  )
  check(
    'and the person is told where the terms are, and what to run next',
    /It License, which is in .*LICENSE\.md/.test(one.said) && /setup/.test(one.said),
    one.said,
  )
  check(
    'and how it ended and what to run next are the last things it says, set apart from the rest by a line with nothing on it',
    /\n\nIt is installed\. Start it, and connect your agents, with:\n\n {2}.* setup\n?$/.test(one.said.replace(/\r\n/g, '\n')),
    JSON.stringify(one.said.slice(-300)),
  )
  check(
    'it says nothing of the usage counts It reports, which the program says itself at the first command a person runs, and leaves no note that anyone was told',
    !saysOfUsage(one) && !existsSync(path.join(one.folder, 'telemetry.json')),
    one.said,
  )
  check(
    'only the latest release was asked for, and only its checksums, the program for this system and the two files of terms',
    asked
      .map((a) => a.replace(/^[^/]+/, ''))
      .sort()
      .join() ===
      ['/latest/download/LICENSE.md', '/latest/download/SHA256SUMS', '/latest/download/THIRD_PARTY_NOTICES.md', `/latest/download/${program}`].sort().join(),
    asked.join(' '),
  )

  if (!windows) {
    // ---------- the PATH, in the file the person's own shell reads ----------
    const line = `export PATH='${path.join(one.home, '.it', 'bin')}':"$PATH"`
    check(
      'with a plain shell and no profile at all, one is made, holding the line that puts the folder on the PATH',
      read(path.join(one.home, '.profile'))?.includes(line),
      read(path.join(one.home, '.profile')),
    )
    const again = await install('one')
    check(
      'installing again replaces the program, adds the line no second time, and says that it is there already',
      again.code === 0 &&
        read(path.join(one.home, '.profile')).split(line).length === 2 &&
        !/Added |could not/.test(again.said) &&
        again.said.includes(`is already on the PATH of every new terminal. To use it in this one, run:  ${line}\n`),
      `${again.said}\n${read(path.join(one.home, '.profile'))}`,
    )
    // A profile that cannot be written to is left as it is, and the person is told what to do instead
    mkdirSync(path.join(tmp, 'read-only'), { recursive: true })
    writeFileSync(path.join(tmp, 'read-only', '.profile'), '# mine\n', { mode: 0o400 })
    const readOnly = await install('read-only')
    check(
      'a profile that cannot be changed is left as it was, the program is installed all the same, and the person is told to add the folder themselves',
      readOnly.code === 0 &&
        existsSync(readOnly.it) &&
        read(path.join(readOnly.home, '.profile')) === '# mine\n' &&
        /Your PATH could not be changed/.test(readOnly.said) &&
        // And only that: the shell's own complaint about the file is not passed on
        !/denied|cannot|\.profile:/i.test(readOnly.said),
      readOnly.said,
    )
    // bash reads two files, and here the one a login shell reads cannot be written to
    mkdirSync(path.join(tmp, 'half-read-only'), { recursive: true })
    writeFileSync(path.join(tmp, 'half-read-only', '.bash_profile'), '# mine\n', { mode: 0o400 })
    const halfReadOnly = await install('half-read-only', {}, { shell: '/bin/bash' })
    check(
      'where one of bash’s two files can be changed and the other cannot, the install says which was changed and which was not, and promises nothing of a new terminal',
      halfReadOnly.code === 0 &&
        read(path.join(halfReadOnly.home, '.bash_profile')) === '# mine\n' &&
        read(path.join(halfReadOnly.home, '.bashrc'))?.includes('\nexport PATH=') &&
        /Added .* to your PATH, in ~\/\.bashrc, but ~\/\.bash_profile could not be changed/.test(halfReadOnly.said) &&
        !/Open a new terminal/.test(halfReadOnly.said) &&
        printed(halfReadOnly).path.startsWith('export PATH='),
      halfReadOnly.said,
    )

    // ---------- a folder that cannot be kept to this user ----------
    // A stand-in for `chmod` that refuses to keep a folder to its owner, and is `chmod` otherwise
    const noChmod = path.join(tmp, 'chmod-refuses')
    mkdirSync(noChmod)
    writeFileSync(
      path.join(noChmod, 'chmod'),
      '#!/bin/sh\ncase "$1" in 700) echo "chmod: a stand-in refuses this" >&2; exit 1 ;; esac\nexec /bin/chmod "$@"\n',
      { mode: 0o755 },
    )
    const refusingChmod = { PATH: `${noChmod}${path.delimiter}${process.env.PATH}` }
    mkdirSync(path.join(tmp, 'open-to-others', '.it'), { recursive: true })
    chmodSync(path.join(tmp, 'open-to-others', '.it'), 0o755)
    asked.length = 0
    const openToOthers = await install('open-to-others', refusingChmod)
    check(
      'a folder that others can look inside, and that cannot be set otherwise, is not installed into, and that is said before anything is asked for',
      openToOthers.code !== 0 &&
        /only you can look inside/.test(openToOthers.said) &&
        asked.length === 0 &&
        nothingInstalled(openToOthers) &&
        (statSync(openToOthers.folder).mode & 0o777) === 0o755,
      `${openToOthers.said}\nasked: ${asked.join(' ')}`,
    )
    mkdirSync(path.join(tmp, 'kept-already', '.it'), { recursive: true })
    chmodSync(path.join(tmp, 'kept-already', '.it'), 0o700)
    const keptAlready = await install('kept-already', refusingChmod)
    check(
      'and one that only its owner can look inside already is installed into, though it could not be set again',
      keptAlready.code === 0 && existsSync(keptAlready.it),
      keptAlready.said,
    )
    check('nothing is left behind in the folder but the program', readdirSync(path.join(one.folder, 'bin')).join() === 'it')
    check(
      'and beside it only the terms, the notices, and the note of where it was downloaded from, since that was not the usual place',
      readdirSync(one.folder).sort().join() === 'LICENSE.md,THIRD_PARTY_NOTICES.md,bin,releases.json',
      readdirSync(one.folder).join(' '),
    )
    check(
      'the note names the place this install was told to download from, and only this user can read it: the program looks there for a newer It, in whatever terminal it is next run',
      read(path.join(one.folder, 'releases.json'))?.trim() === JSON.stringify({ base }) &&
        (process.platform === 'win32' || (statSync(path.join(one.folder, 'releases.json')).mode & 0o077) === 0),
      String(read(path.join(one.folder, 'releases.json'))),
    )

    // ---------- who has been told that It reports usage ----------
    const noteOf = (r) => {
      const file = path.join(r.folder, 'telemetry.json')
      return existsSync(file) ? { ...JSON.parse(readFileSync(file, 'utf8')), mode: statSync(file).mode & 0o777 } : null
    }
    const watched = await install('watched', {}, { terminal: true })
    check(
      'run at a terminal, where a person reads it, the install says what it did in a few marked lines and what to run next, in place of the sentences',
      watched.code === 0 &&
        /✓.* Downloaded for \S+ \S+, and checked/.test(watched.said) &&
        /✓.* Installed in /.test(watched.said) &&
        /Next: {2}.* setup/.test(watched.said) &&
        !/It is installed\. Start it/.test(watched.said),
      watched.said,
    )
    check(
      'and it says nothing there of usage reporting either, and leaves no note: the setup it leads into is the command that says it',
      watched.code === 0 && !saysOfUsage(watched) && noteOf(watched) === null,
      `${watched.said} ${JSON.stringify(noteOf(watched))}`,
    )
    const byAnAgent = await install('by-an-agent', { CODEX_THREAD_ID: 'a-conversation' }, { terminal: true })
    check(
      'an agent that runs the install is given a terminal by some agent apps, and is still no person: it is given the sentences, with what to run next, and no note is left',
      byAnAgent.code === 0 &&
        /It is installed\. Start it/.test(byAnAgent.said) &&
        !/✓/.test(byAnAgent.said) &&
        !saysOfUsage(byAnAgent) &&
        noteOf(byAnAgent) === null,
      `${byAnAgent.said} ${JSON.stringify(noteOf(byAnAgent))}`,
    )
    // A note the program left before, whatever it holds, is the program's own, and an install leaves it as it is
    const saysOff = `${JSON.stringify({ enabled: false, offBy: 'command', told: 1 }, null, 1)}\n`
    mkdirSync(path.join(tmp, 'note-says-off', '.it'), { recursive: true })
    writeFileSync(path.join(tmp, 'note-says-off', '.it', 'telemetry.json'), saysOff)
    const noteSaysOff = await install('note-says-off', {}, { terminal: true })
    check(
      'the note the program keeps of what it told the person is left as it is by an install over it',
      noteSaysOff.code === 0 && existsSync(noteSaysOff.it) && !saysOfUsage(noteSaysOff) && read(path.join(noteSaysOff.folder, 'telemetry.json')) === saysOff,
      noteSaysOff.said,
    )
    const zsh = await install('zsh', {}, { shell: '/bin/zsh' })
    check(
      'someone whose shell is zsh gets the line in the file zsh reads, made if it was not there, and in no other',
      zsh.code === 0 && read(path.join(zsh.home, '.zshrc'))?.includes('export PATH=') && read(path.join(zsh.home, '.profile')) === null,
      zsh.said,
    )
    // fish reads none of those files, and is given one of It's own, in fish's own words
    // Where fish keeps its files is said by a variable where one is set, and the machine this runs on may set one: it is
    // set here to a folder of this install's own, so that nothing is written into the home of whoever runs the suite
    const fishKeeps = path.join(tmp, 'fish', 'kept for fish')
    const fish = await install('fish', { XDG_CONFIG_HOME: fishKeeps }, { shell: '/usr/bin/fish' })
    const fishFile = path.join(fishKeeps, 'fish', 'conf.d', 'it.fish')
    check(
      'a person whose shell is fish gets the line in a file of fish’s own, written as fish reads it, and no other shell’s file is made',
      fish.code === 0 &&
        read(fishFile)?.includes(`contains -- '${path.dirname(fish.it)}' $PATH; or set -gx PATH '${path.dirname(fish.it)}' $PATH`) &&
        read(path.join(fish.home, '.profile')) === null &&
        read(path.join(fish.home, '.bashrc')) === null &&
        fish.said.includes(fishFile),
      `${fish.said}\n${read(fishFile)}`,
    )
    mkdirSync(path.join(tmp, 'bash'), { recursive: true })
    writeFileSync(path.join(tmp, 'bash', '.bash_profile'), '# mine\n')
    const bash = await install('bash', {}, { shell: '/usr/bin/bash' })
    check(
      'someone whose shell is bash, with a .bash_profile, gets it there and in .bashrc, and what was in the file stays',
      bash.code === 0 &&
        read(path.join(bash.home, '.bash_profile')).startsWith('# mine\n') &&
        read(path.join(bash.home, '.bash_profile')).includes('export PATH=') &&
        read(path.join(bash.home, '.bashrc'))?.includes('export PATH=') &&
        read(path.join(bash.home, '.profile')) === null,
      bash.said,
    )
    // What a login shell of bash's finds first on its PATH, started as a new terminal starts one
    const loginShell = async (r) =>
      // biome-ignore lint/suspicious/noTemplateCurlyInString: these are a shell's braces, in a shell's own script
      /^first=(.*)$/m.exec((await run('bash', ['-l', '-c', 'printf "first=%s\\n" "${PATH%%:*}"'], { PATH: '/usr/bin:/bin', HOME: r.home }, r.home)).said)?.[1]
    check(
      'and a login shell started there afterwards has the folder on its PATH',
      (await loginShell(bash)) === path.join(bash.folder, 'bin'),
      await loginShell(bash),
    )
    mkdirSync(path.join(tmp, 'bash-login'), { recursive: true })
    writeFileSync(path.join(tmp, 'bash-login', '.bash_login'), '# mine\n')
    const bashLogin = await install('bash-login', {}, { shell: '/usr/bin/bash' })
    check(
      'with a .bash_login and no .bash_profile, which is then the file a login shell reads, the line goes there, and a login shell has the folder on its PATH',
      bashLogin.code === 0 &&
        read(path.join(bashLogin.home, '.bash_login')).startsWith('# mine\n') &&
        read(path.join(bashLogin.home, '.bash_login')).includes('export PATH=') &&
        read(path.join(bashLogin.home, '.bashrc'))?.includes('export PATH=') &&
        read(path.join(bashLogin.home, '.profile')) === null &&
        (await loginShell(bashLogin)) === path.join(bashLogin.folder, 'bin'),
      `${bashLogin.said}\nfirst on a login shell's PATH: ${await loginShell(bashLogin)}`,
    )
    const bashNeither = await install('bash-neither', {}, { shell: '/usr/bin/bash' })
    check(
      'with neither, the line goes in .profile, which is made, and a login shell has the folder on its PATH',
      bashNeither.code === 0 &&
        read(path.join(bashNeither.home, '.profile'))?.includes('export PATH=') &&
        read(path.join(bashNeither.home, '.bashrc'))?.includes('export PATH=') &&
        (await loginShell(bashNeither)) === path.join(bashNeither.folder, 'bin'),
      `${bashNeither.said}\nfirst on a login shell's PATH: ${await loginShell(bashNeither)}`,
    )
    mkdirSync(path.join(tmp, 'zdotdir', 'kept for zsh'), { recursive: true })
    const zdotdir = await install('zdotdir', { ZDOTDIR: path.join(tmp, 'zdotdir', 'kept for zsh') }, { shell: '/bin/zsh' })
    check(
      'someone whose zsh keeps its files in another folder gets the line in the file there, and none is made in their home',
      zdotdir.code === 0 &&
        read(path.join(tmp, 'zdotdir', 'kept for zsh', '.zshrc'))?.includes('export PATH=') &&
        read(path.join(zdotdir.home, '.zshrc')) === null &&
        zdotdir.said.includes(path.join(tmp, 'zdotdir', 'kept for zsh', '.zshrc')),
      zdotdir.said,
    )
    mkdirSync(path.join(tmp, 'mentioned'), { recursive: true })
    writeFileSync(path.join(tmp, 'mentioned', '.profile'), `# I once had ${path.join(tmp, 'mentioned', '.it', 'bin')} on my PATH\n`)
    const mentioned = await install('mentioned')
    check(
      'a profile that only mentions the folder still gets the line',
      read(path.join(mentioned.home, '.profile')).includes('\nexport PATH='),
      read(path.join(mentioned.home, '.profile')),
    )
    // The terminal `it uninstall` was run in keeps the PATH it had, with the folder on it, after the line was taken out of the shell's files
    const stale = path.join(tmp, 'stale', '.it', 'bin')
    const left = await install('stale', { PATH: `${stale}${path.delimiter}${plainEnv().PATH}` })
    check(
      'where the folder is on this terminal’s PATH and in none of the files the shell reads, as after It was taken off the machine, the line is added, so that a new terminal finds It too',
      left.code === 0 &&
        read(path.join(left.home, '.profile'))?.includes(`\nexport PATH='${stale}':"$PATH"\n`) &&
        /Added .* to your PATH, in ~\/\.profile/.test(left.said),
      `${left.said}\n${read(path.join(left.home, '.profile'))}`,
    )
    // A person who put the folder on their PATH themselves has it in a file of their own writing
    mkdirSync(path.join(tmp, 'own'), { recursive: true })
    const theirs = `export PATH="${path.join(tmp, 'own', '.it', 'bin')}:$PATH" # mine\n`
    writeFileSync(path.join(tmp, 'own', '.profile'), theirs)
    const own = await install('own', { PATH: `${path.join(tmp, 'own', '.it', 'bin')}${path.delimiter}${plainEnv().PATH}` })
    check(
      'where the folder is on the PATH because the person’s own file puts it there, that file is left as they wrote it',
      own.code === 0 && read(path.join(own.home, '.profile')) === theirs && !/Added |could not/.test(own.said),
      `${own.said}\n${read(path.join(own.home, '.profile'))}`,
    )
    // ---------- a computer that is to join an It that runs on another ----------
    // An It to join: it says under what address its backend signs, and makes a machine for a key and an invite
    const joinedWith = []
    const it = await serve((req, res) => {
      const chunks = []
      req
        .on('data', (c) => chunks.push(c))
        .on('end', () => {
          const answer = (value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
          if (req.method === 'GET' && req.url === '/cli/config') return answer({ protocol: 1, issuer: 'http://127.0.0.1:1' })
          if (req.method === 'POST' && req.url === '/bridge/enroll') {
            joinedWith.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            return answer({ machine: 'machine-2' })
          }
          res.writeHead(404).end()
        })
    })
    const there = `http://127.0.0.1:${it.address().port}`
    const JOIN = ['login', '--url', there, '--code', 'Ab3dEf6hIj9kLm2nOp5q', '--name', 'the laptop', '--no-setup']
    const begun = (r) => ['service.json', 'backend'].filter((name) => existsSync(path.join(r.folder, name)))
    const joining = await install('joining', {}, { args: JOIN })
    check(
      'given the command that joins an It on another computer, the script installs the program and joins with it, and sets no It up here',
      joining.code === 0 &&
        runs(joining.it, joining.home) !== undefined &&
        joinedWith.length === 1 &&
        joinedWith[0].code === 'Ab3dEf6hIj9kLm2nOp5q' &&
        joinedWith[0].name === 'the laptop' &&
        JSON.parse(read(path.join(joining.folder, 'machine.json')) ?? '{}').at === there &&
        begun(joining).length === 0 &&
        /"machine": "machine-2"/.test(joining.said) &&
        !/ setup$/m.test(joining.said),
      `${joining.said}\n${JSON.stringify(joinedWith)}\nbegun: ${begun(joining)}`,
    )
    const joiningLed = await install('joining-led', {}, { args: JOIN, terminal: true })
    check(
      'and at a terminal too, where an install by itself goes on to set It up: the person is not led through a setup, and the machine has joined',
      joiningLed.code === 0 &&
        joinedWith.length === 2 &&
        JSON.parse(read(path.join(joiningLed.folder, 'machine.json')) ?? '{}').at === there &&
        begun(joiningLed).length === 0 &&
        /Installed in /.test(joiningLed.said) &&
        /"machine": "machine-2"/.test(joiningLed.said) &&
        !/Backend program|Background service/.test(joiningLed.said),
      `${joiningLed.said}\nbegun: ${begun(joiningLed)}`,
    )
    const notJoining = await install('not-joining', {}, { args: ['setup', '--none'] })
    check(
      'given anything else after it, the script says what it takes and installs nothing',
      notJoining.code === 2 && /It does not know what to do with "setup"\. Nothing was installed\./.test(notJoining.said) && !existsSync(notJoining.folder),
      `${notJoining.code}\n${notJoining.said}`,
    )
    await new Promise((resolve) => it.close(resolve))
    const quiet = await install('quiet', { IT_INSTALL_NO_PATH: '1' })
    check(
      'asked to leave the PATH alone, it makes and changes no profile',
      quiet.code === 0 && read(path.join(quiet.home, '.profile')) === null && !/PATH/.test(quiet.said),
      quiet.said,
    )

    // ---------- a folder whose name a shell would read as more than a name ----------
    const marker = path.join(tmp, 'RAN')
    const odd = await install('odd', { IT_HOME: path.join(tmp, 'odd', `it's "here" $(touch ${marker}) $HOME`) })
    const profile = path.join(odd.home, '.profile')
    // The profile is read by a shell, as it would be when the person next opens a terminal,
    // and that shell is asked what it then finds first on the PATH
    // biome-ignore lint/suspicious/noTemplateCurlyInString: these are a shell's braces, in a shell's own script
    const first = (await run('sh', ['-c', '. "$1" && printf %s "${PATH%%:*}"', 'sh', profile], { PATH: '/usr/bin:/bin', HOME: odd.home }, odd.home)).said
    check(
      'the folder goes on the PATH exactly as it is named, and nothing in its name is run',
      odd.code === 0 && existsSync(odd.it) && first === path.join(odd.folder, 'bin') && !existsSync(marker),
      `${odd.said}\nfirst on the PATH: ${first}`,
    )
    // The command the person is told to run next is run as it was printed
    const told = printed(odd)
    const next = await asPrinted(told.next.replace(/ setup$/, ' --version'), odd)
    check(
      'and the command it prints for the next step works as printed, in a folder with spaces and quotes',
      next.status === 0 && /"version"/.test(next.said) && !existsSync(marker),
      `${told.next}\n${next.said}`,
    )
    // A name that a shell's own `echo` would rewrite on the way to the screen: a backslash and
    // three digits become the quote that ends the name, and what follows it becomes a command
    const escaped = await install('escaped', { IT_HOME: path.join(tmp, 'escaped', `x\\047;touch ${marker};#`) })
    const copied = printed(escaped)
    const started = await asPrinted(copied.next.replace(/ setup$/, ' --version'), escaped)
    const onPath = await asPrinted(`${copied.path}; printf %s "\${PATH%%:*}"`, escaped)
    check(
      'every command it prints is the command that was meant, and running each as printed runs nothing in the name, backslashes and all',
      escaped.code === 0 && started.status === 0 && /"version"/.test(started.said) && onPath.said === path.join(escaped.folder, 'bin') && !existsSync(marker),
      `${escaped.said}\n${started.said}\n${onPath.said}`,
    )
    const relative = await install('relative', { IT_HOME: '-kept-here' })
    check(
      'a folder named by a relative path, even one that begins with a dash, is taken from where the script was run',
      relative.code === 0 && existsSync(path.join(relative.home, '-kept-here', 'bin', 'it')),
      relative.said,
    )

    // ---------- what is already there, where the install writes ----------
    // Links where the three files go: one to a file of the person's own, one to a folder, and
    // one to nowhere, which a write through it would make
    const linked = path.join(tmp, 'linked')
    mkdirSync(path.join(linked, '.it', 'bin'), { recursive: true })
    mkdirSync(path.join(linked, 'folder'))
    writeFileSync(path.join(linked, 'mine'), 'KEEP THIS\n')
    symlinkSync(path.join(linked, 'mine'), path.join(linked, '.it', 'bin', 'it'))
    symlinkSync(path.join(linked, 'folder'), path.join(linked, '.it', 'LICENSE.md'))
    symlinkSync(path.join(linked, 'nowhere'), path.join(linked, '.it', 'THIRD_PARTY_NOTICES.md'))
    // And one where the program keeps its note about usage reporting, which an install has nothing to write to
    symlinkSync(path.join(linked, 'nowhere-either'), path.join(linked, '.it', 'telemetry.json'))
    const overLinks = await install('linked', {}, { terminal: true })
    check(
      'a link where a file is to go is replaced by the file itself, and nothing is written to wherever it led',
      overLinks.code === 0 &&
        ['bin/it', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md'].every((f) => lstatSync(path.join(overLinks.folder, f)).isFile()) &&
        readFileSync(overLinks.it).equals(readFileSync(path.join(built, program))) &&
        read(path.join(linked, 'mine')) === 'KEEP THIS\n' &&
        readdirSync(path.join(linked, 'folder')).length === 0 &&
        !existsSync(path.join(linked, 'nowhere')),
      `${overLinks.said}\n${readdirSync(linked).join(' ')}`,
    )
    check(
      'and nothing is written through a link that stands where the program keeps its note about usage reporting',
      !existsSync(path.join(linked, 'nowhere-either')) && lstatSync(path.join(linked, '.it', 'telemetry.json')).isSymbolicLink(),
      readdirSync(linked).join(' '),
    )
    // A profile that is a link is the person's own doing, and the line goes where it leads
    const dotfiles = path.join(tmp, 'dotfiles')
    mkdirSync(path.join(dotfiles, 'kept-elsewhere'), { recursive: true })
    writeFileSync(path.join(dotfiles, 'kept-elsewhere', 'profile'), '# mine\n')
    symlinkSync(path.join(dotfiles, 'kept-elsewhere', 'profile'), path.join(dotfiles, '.profile'))
    const throughLink = await install('dotfiles')
    check(
      'a profile that is a link to a file kept elsewhere gets the line in that file, and stays a link',
      throughLink.code === 0 &&
        lstatSync(path.join(dotfiles, '.profile')).isSymbolicLink() &&
        read(path.join(dotfiles, 'kept-elsewhere', 'profile')).startsWith('# mine\n') &&
        read(path.join(dotfiles, 'kept-elsewhere', 'profile')).includes('\nexport PATH='),
      throughLink.said,
    )

    // ---------- all three files, or none ----------
    // An install that is stopped once the program is in place and before the license is
    const failsOnce = mvThat(
      'mv-fails-once',
      (dir) => `if [ ! -e "${dir}/failed" ]; then : > "${dir}/failed"; echo "mv: a stand-in refuses this once" >&2; exit 1; fi`,
    )
    const kept = await install('kept', { IT_VERSION: 'other' })
    const half = await install('kept', { PATH: failsOnce.PATH })
    check(
      'an install that fails once the program has been replaced puts back what was there, so that no release is left beside another release’s terms',
      kept.code === 0 &&
        half.code !== 0 &&
        existsSync(path.join(failsOnce.dir, 'failed')) &&
        whole(half, other) &&
        nothingOfItsOwn(half) &&
        nothingLeftBehind(half),
      `${half.said}\n${readdirSync(half.folder).join(' ')}`,
    )
    rmSync(path.join(failsOnce.dir, 'failed'), { force: true })
    const none = await install('none-yet', { PATH: failsOnce.PATH })
    check(
      'and where nothing was installed before, it leaves nothing installed',
      none.code !== 0 && !existsSync(none.it) && !existsSync(path.join(none.folder, 'LICENSE.md')) && nothingOfItsOwn(none) && nothingLeftBehind(none),
      `${none.said}\n${readdirSync(none.folder).join(' ')}`,
    )
    // The same failure, where the notices this run downloaded have gone from its folder by then:
    // the notices that were installed before are not this run's to remove
    const losesNotices = mvThat(
      'mv-loses-notices',
      (dir) =>
        `if [ ! -e "${dir}/failed" ]; then : > "${dir}/failed"; rm -f "$(dirname "$3")/notices"; echo "mv: a stand-in refuses this once" >&2; exit 1; fi`,
    )
    const untouched = await install('untouched', { IT_VERSION: 'other' })
    const lostNotices = await install('untouched', { PATH: losesNotices.PATH })
    check(
      'putting back removes only a file this run put there: the notices of the earlier install stay though this run’s own have gone missing',
      untouched.code === 0 && lostNotices.code !== 0 && whole(lostNotices, other) && nothingOfItsOwn(lostNotices),
      `${lostNotices.said}\n${readdirSync(lostNotices.folder).join(' ')}`,
    )
    // And where the license can be moved neither in nor back: what was there never left its place, since it is
    // kept aside under a second name and not by moving it, so the earlier install is whole and nothing is left over
    const refusesAlways = mvThat('mv-refuses-always', () => 'echo "mv: a stand-in refuses this" >&2; exit 1')
    const before = await install('cannot-put-back', { IT_VERSION: 'other' })
    const stuck = await install('cannot-put-back', { PATH: refusesAlways.PATH })
    const keptIn = readdirSync(stuck.folder).filter((f) => f.startsWith('.install.'))
    check(
      'a file that can be moved neither in nor back never left its place: the earlier install is whole, and nothing of this run is left beside it',
      before.code === 0 &&
        stuck.code !== 0 &&
        keptIn.length === 0 &&
        read(path.join(stuck.folder, 'LICENSE.md')) === otherHolds['LICENSE.md'] &&
        !stuck.said.includes('could be put back') &&
        readFileSync(stuck.it).equals(readFileSync(path.join(other, program))) &&
        !existsSync(path.join(stuck.folder, '.installing')),
      `${stuck.said}\n${readdirSync(stuck.folder).join(' ')}`,
    )
    // Where what is there can be kept aside only as a copy (a disk that gives a file no second
    // name), and the copy stops half way, as on a disk that fills: the half is never taken for
    // what was there, and the program that was installed is still the whole of itself
    const halfCopy = path.join(tmp, 'copy-stops-half-way')
    mkdirSync(halfCopy)
    writeFileSync(path.join(halfCopy, 'ln'), '#!/bin/sh\nfor last; do :; done\ncase "$last" in */old.*) exit 1 ;; esac\nexec /bin/ln "$@"\n', { mode: 0o755 })
    writeFileSync(
      path.join(halfCopy, 'cp'),
      '#!/bin/sh\nfor last; do :; done\ncase "$last" in */old.*) printf half > "$last"; echo "cp: a stand-in stops half way" >&2; exit 1 ;; esac\nexec /bin/cp "$@"\n',
      { mode: 0o755 },
    )
    const wholeBefore = await install('half-copy', { IT_VERSION: 'other' })
    const halved = await install('half-copy', { PATH: `${halfCopy}${path.delimiter}${process.env.PATH}` })
    check(
      'a copy kept aside that stopped half way is never put back as what was there: the earlier install is whole, and nothing of this run is left beside it',
      wholeBefore.code === 0 &&
        halved.code !== 0 &&
        readFileSync(halved.it).equals(readFileSync(path.join(other, program))) &&
        read(path.join(halved.folder, 'LICENSE.md')) === otherHolds['LICENSE.md'] &&
        readdirSync(halved.folder).filter((f) => f.startsWith('.install.')).length === 0 &&
        readdirSync(path.dirname(halved.it)).join(' ') === path.basename(halved.it),
      `${halved.said}\n${readdirSync(halved.folder).join(' ')}\n${readdirSync(path.dirname(halved.it)).join(' ')}`,
    )
    // What it prints goes to a program that has stopped reading, as in `... | sh | head -1`
    const unread = await install('unread', {}, { first: 'sleep 0.3', started: (child) => child.stdout.destroy() })
    check(
      'an install whose words cannot be written any more stops, says so by its exit, and leaves nothing of its own behind',
      unread.code === 141 && nothingOfItsOwn(unread) && nothingLeftBehind(unread),
      `${unread.code} ${unread.said}\n${existsSync(unread.folder) ? readdirSync(unread.folder).join(' ') : ''}`,
    )
    // Two installs at once: the first is held at that same point, with the lock, while the second runs
    const waits = mvThat('mv-waits', (dir) => `: > "${dir}/reached"; while [ ! -e "${dir}/go" ]; do sleep 0.1; done`)
    const earlier = install('both', { IT_VERSION: 'other', PATH: waits.PATH })
    const reached = await until(() => existsSync(path.join(waits.dir, 'reached')))
    const second = await install('both')
    writeFileSync(path.join(waits.dir, 'go'), '')
    const earlierDone = await earlier
    check(
      'of two installs at once into one folder, the second is told another is at work and changes nothing, and the first finishes whole',
      reached &&
        second.code !== 0 &&
        /Another install of It/.test(second.said) &&
        earlierDone.code === 0 &&
        whole(earlierDone, other) &&
        nothingOfItsOwn(earlierDone),
      `${second.said}\n${earlierDone.said}\n${readdirSync(earlierDone.folder).join(' ')}`,
    )
    const afterwards = await install('both')
    check(
      'and the next install, once the first has finished, replaces all three',
      afterwards.code === 0 && whole(afterwards, latest) && nothingOfItsOwn(afterwards),
      afterwards.said,
    )
    // Stopped by a signal in the middle of its downloads, over what the last install left. A
    // shell acts on a signal once the command it is waiting for has ended, so the download is
    // let finish after the signal is sent. The signal is the shell's from the moment it is
    // sent, and the shell meets it when it next runs, which is before it can find that its
    // command has ended: nothing has to be waited for in between.
    let downloading
    const cut = install('both', { IT_VERSION: 'held' }, { started: (child) => (downloading = child) })
    const reachedTheLicense = await until(() => reachedHeld)
    const signalSent = downloading.kill('SIGTERM')
    letGo()
    const cutDone = await cut
    check(
      'an install stopped by a signal while it downloads changes nothing, clears up after itself, and says by its exit that it was stopped',
      reachedTheLicense && signalSent && cutDone.code === 143 && whole(cutDone, latest) && nothingOfItsOwn(cutDone) && nothingLeftBehind(cutDone),
      `signal sent: ${signalSent}; ${cutDone.code} ${cutDone.said}\n${readdirSync(cutDone.folder).join(' ')}`,
    )
    // A signal that comes while the three files are being replaced is not acted on: by then the
    // only way to leave one release's files together is to finish
    rmSync(path.join(waits.dir, 'reached'), { force: true })
    rmSync(path.join(waits.dir, 'go'), { force: true })
    let replacing
    const signalled = install('both', { IT_VERSION: 'other', PATH: waits.PATH }, { started: (child) => (replacing = child) })
    const reachedAgain = await until(() => existsSync(path.join(waits.dir, 'reached')))
    const signalSentAgain = replacing.kill('SIGTERM')
    writeFileSync(path.join(waits.dir, 'go'), '')
    const signalledDone = await signalled
    check(
      'an install sent a signal while it is replacing the three files finishes replacing them, and leaves nothing of its own behind',
      reachedAgain &&
        signalSentAgain &&
        signalledDone.code === 0 &&
        whole(signalledDone, other) &&
        nothingOfItsOwn(signalledDone) &&
        nothingLeftBehind(signalledDone),
      `signal sent: ${signalSentAgain}; ${signalledDone.code} ${signalledDone.said}\n${readdirSync(signalledDone.folder).join(' ')}`,
    )
    // An install that is still running holds its lock however long it takes. The first is held
    // where it was before, and its lock is made to look an hour old
    const longAgo = new Date(Date.now() - 3_600_000)
    rmSync(path.join(waits.dir, 'reached'), { force: true })
    rmSync(path.join(waits.dir, 'go'), { force: true })
    const slow = install('slow', { IT_VERSION: 'other', PATH: waits.PATH })
    const reachedSlow = await until(() => existsSync(path.join(waits.dir, 'reached')))
    const slowLock = path.join(tmp, 'slow', '.it', '.installing')
    for (const f of [path.join(slowLock, 'owner'), slowLock]) if (existsSync(f)) utimesSync(f, longAgo, longAgo)
    const impatient = await install('slow')
    writeFileSync(path.join(waits.dir, 'go'), '')
    const slowDone = await slow
    check(
      'an install that is still running keeps its lock however old the lock has grown, and the next is told which process holds it',
      reachedSlow &&
        impatient.code !== 0 &&
        /Another install of It, process \d+ on /.test(impatient.said) &&
        slowDone.code === 0 &&
        whole(slowDone, other) &&
        nothingOfItsOwn(slowDone),
      `${impatient.said}\n${slowDone.said}\n${readdirSync(slowDone.folder).join(' ')}`,
    )
    // A signal sent to everything an install started reaches the command that is moving a
    // file, which stops, and the install puts back what was there. The stand-in for `mv` waits
    // for good the first time the license is moved, and says which process it is
    const hangs = mvThat('mv-hangs', (dir) => `if [ ! -e "${dir}/pid" ]; then echo $$ > "${dir}/pid"; while :; do sleep 0.1; done; fi`)
    const isRunning = (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const beforeHung = await install('hung', { IT_VERSION: 'other' })
    const hung = install('hung', { PATH: hangs.PATH })
    const reachedHung = await until(() => Number(read(path.join(hangs.dir, 'pid'))) > 0)
    const moving = Number(read(path.join(hangs.dir, 'pid')))
    if (reachedHung) process.kill(moving, 'SIGTERM')
    const stopped = reachedHung && (await until(() => !isRunning(moving)))
    // One that took no notice is ended here, so that the test itself ends
    if (reachedHung && !stopped) process.kill(moving, 'SIGKILL')
    const hungDone = await hung
    check(
      'a command that is moving a file can be stopped by a signal, and the install then puts back what was there and gives up its lock',
      beforeHung.code === 0 && stopped && hungDone.code !== 0 && whole(hungDone, other) && nothingOfItsOwn(hungDone) && nothingLeftBehind(hungDone),
      `${hungDone.code} ${hungDone.said}\n${readdirSync(hungDone.folder).join(' ')}`,
    )
    // A lock nobody holds any more, and locks that somebody may. A lock names the process that
    // holds it and the machine that process is on
    const gone = Number(execFileSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }))
    const lockFor = (name, owner, old = false) => {
      const lock = path.join(tmp, name, '.it', '.installing')
      mkdirSync(lock, { recursive: true })
      if (owner) writeFileSync(path.join(lock, 'owner'), `${owner}\n`)
      if (old) utimesSync(lock, longAgo, longAgo)
      return lock
    }
    lockFor('left-locked', `${gone} ${os.hostname()}`)
    const leftLocked = await install('left-locked')
    check(
      'a lock left by an install that has stopped running does not stand in the way of the next',
      leftLocked.code === 0 && whole(leftLocked, latest) && nothingOfItsOwn(leftLocked),
      `${leftLocked.said}\n${readdirSync(leftLocked.folder).join(' ')}`,
    )
    // A lock whose process is running: this test's own
    const heldLock = lockFor('locked', `${process.pid} ${os.hostname()}`, true)
    const locked = await install('locked')
    check(
      'a lock whose process is running is left where it is, however old it is, and the install names that process and the folder to remove if it is no install',
      locked.code !== 0 &&
        locked.said.includes(`Another install of It, process ${process.pid} on ${os.hostname()}, is putting its files in`) &&
        locked.said.includes(`remove the folder ${heldLock} `) &&
        !existsSync(locked.it) &&
        read(path.join(heldLock, 'owner')) === `${process.pid} ${os.hostname()}\n`,
      `${locked.said}\n${readdirSync(locked.folder).join(' ')}`,
    )
    // One held on another machine that keeps the same folder, where a process's number says nothing here
    lockFor('locked-elsewhere', `${gone} another-machine`, true)
    const lockedElsewhere = await install('locked-elsewhere')
    check(
      'a lock held on another machine is left where it is, since nothing here can say whether its process is running',
      lockedElsewhere.code !== 0 && /Another install of It, process \d+ on another-machine,/.test(lockedElsewhere.said) && !existsSync(lockedElsewhere.it),
      lockedElsewhere.said,
    )
    // One that names nobody: its install was killed before it could, or has this moment made it
    lockFor('locked-by-nobody', '', true)
    const lockedByNobody = await install('locked-by-nobody')
    check(
      'a lock that names no process is left where it is, however old it is',
      lockedByNobody.code !== 0 &&
        /Another install of It is putting its files in/.test(lockedByNobody.said) &&
        !existsSync(lockedByNobody.it) &&
        readdirSync(lockedByNobody.folder).sort().join() === '.installing,bin',
      `${lockedByNobody.said}\n${readdirSync(lockedByNobody.folder).join(' ')}`,
    )
    // A lock of an install that is gone, which another install is this moment taking over
    const taken = lockFor('being-taken', `${gone} ${os.hostname()}`)
    mkdirSync(`${taken}.taking`)
    const beingTaken = await install('being-taken')
    check(
      'a lock that another install is taking over is left to that install, and the person is told of both folders to remove if none is running',
      beingTaken.code !== 0 &&
        /Another install of It/.test(beingTaken.said) &&
        beingTaken.said.includes(`${taken}.taking`) &&
        !existsSync(beingTaken.it) &&
        existsSync(path.join(taken, 'owner')),
      `${beingTaken.said}\n${readdirSync(beingTaken.folder).join(' ')}`,
    )

    // ---------- what an install that was killed left behind ----------
    // A folder of downloads names the install that made it, as a lock does
    const leftBy = (name, holds) => {
      const dir = path.join(tmp, 'leftovers', '.it', name)
      mkdirSync(dir, { recursive: true })
      for (const [file, text] of Object.entries(holds)) writeFileSync(path.join(dir, file), text)
      return dir
    }
    const abandoned = leftBy('.install.abandoned', { owner: `${gone} ${os.hostname()}\n`, program: 'half a download' })
    const holdsTheOld = leftBy('.install.holds-the-old', { owner: `${gone} ${os.hostname()}\n`, 'old.license': 'the only copy' })
    const inUse = leftBy('.install.in-use', { owner: `${process.pid} ${os.hostname()}\n`, program: 'a download under way' })
    const madeElsewhere = leftBy('.install.made-elsewhere', { owner: `${gone} another-machine\n`, program: 'half a download' })
    const unnamed = leftBy('.install.unnamed', { program: 'whose?' })
    const afterLeftovers = await install('leftovers')
    check(
      'the folder of downloads an install that was killed left behind is cleared by the next, and no other folder is: not one that holds a file moved aside, one whose install is running or is on another machine, or one that names no install',
      afterLeftovers.code === 0 &&
        whole(afterLeftovers, latest) &&
        !existsSync(abandoned) &&
        read(path.join(holdsTheOld, 'old.license')) === 'the only copy' &&
        existsSync(path.join(inUse, 'program')) &&
        existsSync(path.join(madeElsewhere, 'program')) &&
        existsSync(path.join(unnamed, 'program')),
      `${afterLeftovers.said}\n${readdirSync(afterLeftovers.folder).join(' ')}`,
    )

    // ---------- on a system with fewer commands ----------
    // No mktemp, so the folder for the downloads is made under a name that can be guessed, and
    // where there is a shasum, no sha256sum either
    const hasShasum = (process.env.PATH ?? '').split(path.delimiter).some((d) => existsSync(path.join(d, 'shasum')))
    const few = systemWithOnly(path.join(tmp, 'few-commands'), [
      ...['sh', 'uname', 'mkdir', 'rmdir', 'chmod', 'rm', 'mv', 'ln', 'curl', 'cut', 'tr', 'awk', 'sed', 'grep', 'basename', 'date', 'ls'],
      hasShasum ? 'shasum' : 'sha256sum',
    ])
    const sparse = await install('sparse', { PATH: few })
    check(
      'with no mktemp, and shasum in place of sha256sum, it installs all the same and leaves nothing of its own behind',
      sparse.code === 0 &&
        existsSync(sparse.it) &&
        readFileSync(sparse.it).equals(readFileSync(path.join(built, program))) &&
        readdirSync(sparse.folder).every((f) => !f.startsWith('.')),
      `${sparse.said}\n${existsSync(sparse.folder) ? readdirSync(sparse.folder).join(' ') : ''}`,
    )
    const noCurl = await install(
      'no-curl',
      { PATH: systemWithOnly(path.join(tmp, 'no-curl'), ['sh', 'uname', 'mkdir', 'chmod']) },
      { home: path.join(tmp, 'without-curl') },
    )
    check(
      'with no curl it says that curl is needed, and makes nothing',
      noCurl.code !== 0 && /Install curl first/.test(noCurl.said) && !existsSync(noCurl.folder),
      noCurl.said,
    )
    const noSums = await install(
      'no-sums',
      { PATH: systemWithOnly(path.join(tmp, 'no-sums'), ['sh', 'uname', 'mkdir', 'chmod', 'curl']) },
      { home: path.join(tmp, 'without-sums') },
    )
    check(
      'with neither sha256sum nor shasum it says that one is needed, and makes nothing',
      noSums.code !== 0 && /Install sha256sum or shasum first/.test(noSums.said) && !existsSync(noSums.folder),
      noSums.said,
    )
    // There, something put beforehand at the very name the folder would be given, leading elsewhere
    mkdirSync(path.join(tmp, 'planted', '.it'), { recursive: true })
    writeFileSync(path.join(tmp, 'planted', 'mine'), 'KEEP THIS\n')
    const planted = await install('planted', { PATH: few }, { first: 'ln -s "$HOME/mine" "$HOME/.it/.install.$$"' })
    check(
      'and a link put where that folder would be made stops the install, with nothing written to wherever it leads',
      planted.code !== 0 && !existsSync(planted.it) && read(path.join(tmp, 'planted', 'mine')) === 'KEEP THIS\n',
      planted.said,
    )

    // ---------- a Mac whose shell is run for the other kind of chip ----------
    // A shell started under translation on an Apple chip says the chip is Intel's. Stand-ins
    // for the two commands that are asked say what they say there
    const mac = (name, translated) => {
      const dir = path.join(tmp, name)
      mkdirSync(dir)
      writeFileSync(path.join(dir, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo x86_64 ;; esac\n', { mode: 0o755 })
      writeFileSync(path.join(dir, 'sysctl'), `#!/bin/sh\necho ${translated}\n`, { mode: 0o755 })
      return { PATH: `${dir}${path.delimiter}${process.env.PATH}` }
    }
    asked.length = 0
    await install('translated', mac('a-translated-shell', 1))
    const forTranslated = asked.join(' ')
    asked.length = 0
    await install('intel', mac('an-intel-mac', 0))
    const forIntel = asked.join(' ')
    check(
      'a shell run under translation on an Apple chip is given the program for that chip, and an Intel Mac the program for Intel',
      /\/it-darwin-arm64/.test(forTranslated) &&
        !/\/it-darwin-x64/.test(forTranslated) &&
        /\/it-darwin-x64/.test(forIntel) &&
        !/\/it-darwin-arm64/.test(forIntel),
      `${forTranslated}\n${forIntel}`,
    )

    // ---------- a Linux whose C library is too old, or is another one ----------
    // Stand-ins for the two commands that are asked say what they say on such a system
    const libc = (name, getconf, ldd) => {
      const dir = path.join(tmp, name)
      mkdirSync(dir)
      writeFileSync(path.join(dir, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; -n) echo there ;; esac\n', { mode: 0o755 })
      writeFileSync(path.join(dir, 'getconf'), `#!/bin/sh\n${getconf}\n`, { mode: 0o755 })
      writeFileSync(path.join(dir, 'ldd'), `#!/bin/sh\n${ldd}\n`, { mode: 0o755 })
      return { PATH: `${dir}${path.delimiter}${process.env.PATH}` }
    }
    // Told that it is on a Linux with an Intel chip, the script installs the program for one, which it starts to see that it
    // runs: so these two are for a machine that is one. On a Mac the script is still made to say what such a Linux would
    // ask for, by the check after them, which installs nothing.
    const onSuchALinux = process.platform === 'linux' && process.arch === 'x64'
    const oldLibc = onSuchALinux ? await install('old-libc', libc('an-older-linux', 'echo "glibc 2.34"', 'echo "ldd (GNU libc) 2.34"')) : null
    if (!oldLibc)
      console.log(
        '  --   the two checks of a Linux whose C library is old, or new enough, are left out here: they install the program for Linux on an Intel chip',
      )
    else
      check(
        'on a Linux whose C library is older than the backend program needs, the command is installed and it says that It cannot run there, in place of telling them to set it up',
        oldLibc.code === 0 &&
          existsSync(oldLibc.it) &&
          /It cannot run on this system/.test(oldLibc.said) &&
          /this system has 2\.34/.test(oldLibc.said) &&
          /it login/.test(oldLibc.said) &&
          !/connect your agents, with/.test(oldLibc.said),
        oldLibc.said,
      )
    const newLibc = onSuchALinux ? await install('new-libc', libc('a-newer-linux', 'echo "glibc 2.35"', 'echo "ldd (GNU libc) 2.35"')) : null
    if (newLibc)
      check(
        'and with the library the backend program needs, nothing of that is said',
        newLibc.code === 0 && existsSync(newLibc.it) && !/cannot run/.test(newLibc.said) && /connect your agents, with/.test(newLibc.said),
        newLibc.said,
      )
    const musl = await install(
      'musl',
      libc(
        'a-linux-with-musl',
        'echo "getconf: GNU_LIBC_VERSION: unknown variable" >&2; exit 1',
        'echo "musl libc (x86_64)" >&2; echo "Version 1.2.5" >&2; exit 1',
      ),
      { home: path.join(tmp, 'with-musl') },
    )
    check(
      'on a Linux with another C library it says that there is no program for it, and makes nothing',
      musl.code !== 0 && /has musl, as Alpine does/.test(musl.said) && !existsSync(musl.folder),
      musl.said,
    )

    // ---------- a script that did not all arrive ----------
    // `curl ... | sh` hands the shell the script as it comes. Cut short after the downloads and
    // before the files are put in place, it must do nothing at all
    const scriptText = readFileSync(path.join(root, 'install/install.sh'), 'utf8')
    const cutShort = path.join(tmp, 'install-cut-short.sh')
    writeFileSync(cutShort, scriptText.slice(0, scriptText.indexOf('\nreplacing=1\n') + 1))
    asked.length = 0
    const partial = await install('partial', {}, { script: cutShort })
    check(
      'a script cut short on its way runs none of what did arrive: nothing is asked for and nothing is made',
      scriptText.includes('\nreplacing=1\n') && partial.code !== 0 && asked.length === 0 && !existsSync(partial.folder),
      `${partial.said}\nasked: ${asked.join(' ')}`,
    )

    // And whole, handed to the shell the same way
    const throughAPipe = await install('through-a-pipe', {}, { first: 'cat "$1" | sh; exit' })
    check(
      'the whole script piped into a shell, as `curl ... | sh` runs it, installs',
      throughAPipe.code === 0 && whole(throughAPipe, latest) && nothingOfItsOwn(throughAPipe),
      throughAPipe.said,
    )

    // ---------- on a system whose commands read options as macOS's do ----------
    // They stop looking for options at the first plain argument, so a `--` after it is taken
    // for a file's name. The commands here do the same when POSIXLY_CORRECT is set, which is
    // how a mistake of that kind is caught without a Mac
    const strict = await install('strict', { POSIXLY_CORRECT: '1' })
    check(
      'where commands stop reading options at the first plain argument, as on macOS, it installs all the same, and keeps the folder to this user',
      strict.code === 0 && existsSync(strict.it) && (statSync(path.join(strict.home, '.it')).mode & 0o777) === 0o700 && !/chmod|No such file/.test(strict.said),
      strict.said,
    )

    // ---------- with no home at all ----------
    const homeless = await install('homeless', { HOME: undefined, USERPROFILE: undefined })
    check(
      'with neither HOME nor IT_HOME there is nowhere to install, and it says so before asking for anything',
      homeless.code !== 0 && /nowhere to install/.test(homeless.said),
      homeless.said,
    )
    const noHome = await install('nohome', { HOME: undefined, IT_HOME: path.join(tmp, 'nohome', 'it') })
    check(
      'with IT_HOME and no HOME it installs, and says the PATH was left alone',
      noHome.code === 0 && existsSync(noHome.it) && /PATH was left alone/.test(noHome.said),
      noHome.said,
    )
  }

  if (windows) {
    // ---------- a folder whose name PowerShell would read as more than a name ----------
    // Run as printed, the name would write a file where the command was run
    const odd = await install('odd', { IT_HOME: path.join(tmp, 'odd', "it's $(Set-Content RAN 1) `here") })
    const told = printed(odd)
    const next = await asPrinted(told.next.replace(/ setup$/, ' --version'), odd)
    check(
      'the command it prints is the command that was meant, and running it as printed runs nothing in the name',
      odd.code === 0 && existsSync(odd.it) && next.status === 0 && /"version"/.test(next.said) && !existsSync(path.join(odd.home, 'RAN')),
      `${odd.said}\n${next.said}`,
    )

    // ---------- taken off the machine again, by the program that is in the folder ----------
    // On Windows a program that is running cannot delete its own file. It moves itself out of
    // the folder first, to where temporary files are kept, and is deleted from there by a
    // program it leaves behind for that, a moment after it has ended.
    const gone = await install('gone')
    const asideIn = () => readdirSync(os.tmpdir()).filter((name) => /^it-removed-\d+-[0-9a-z]+\.exe$/.test(name))
    const asideBefore = asideIn()
    const off = await run(gone.it, ['uninstall', '--yes'], { ...plainEnv(), HOME: gone.home, USERPROFILE: gone.home, IT_HOME: gone.folder }, gone.home)
    let said = null
    try {
      said = JSON.parse(off.said.slice(off.said.indexOf('{')))
    } catch {}
    check(
      'the program takes It off the machine by itself: its own folder is deleted whole, the program in it included, and nothing is left for the person to do',
      gone.code === 0 && off.status === 0 && said?.removed === true && said.left === undefined && !existsSync(gone.folder),
      `${off.said}\nstill there: ${existsSync(gone.folder) ? readdirSync(gone.folder).join(' ') : 'nothing'}`,
    )
    let aside = asideIn().filter((name) => !asideBefore.includes(name))
    for (let waited = 0; aside.length && waited < 100; waited++) {
      await sleep(500)
      aside = asideIn().filter((name) => !asideBefore.includes(name))
    }
    // Where it is still there, what would say why: which PowerShell programs are running and what started each, and what Windows says to deleting the file now
    const why = () => {
      const seen = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='powershell.exe' or Name='it.exe' or Name like 'it-removed-%'" | ForEach-Object { '{0} pid {1} from {2}, {3} letters' -f $_.Name, $_.ProcessId, $_.ParentProcessId, ([string]$_.CommandLine).Length }; try { [IO.File]::Delete('${path.join(os.tmpdir(), aside[0] ?? 'none').replaceAll("'", "''")}'); 'deleted from here' } catch { 'not deleted from here: ' + $_.Exception.GetBaseException().Message }`,
        ],
        { encoding: 'utf8' },
      )
      return `${aside.join(' ')}\n${seen.stdout}${seen.stderr}`
    }
    check('and the program it moved out of the folder to do that is gone too, a moment after it ended', aside.length === 0, aside.length ? why() : '')
  }

  // ---------- over a program that is there already, and over one that is running ----------
  const over = await install('over')
  const overAgain = await install('over')
  check(
    'a second install over the first puts all three files in place again, and leaves nothing else',
    over.code === 0 &&
      overAgain.code === 0 &&
      whole(overAgain, latest) &&
      /^\d+\.\d+\.\d+$/.test(runs(overAgain.it, overAgain.home)) &&
      nothingLeftBehind(overAgain) &&
      nothingOfItsOwn(overAgain),
    `${overAgain.said}\n${readdirSync(path.join(over.folder, 'bin')).join(' ')}`,
  )
  // The installed program is started on something that waits: a hook reads what its agent app
  // sends it, and here nothing is sent until the test is done with it
  const running = spawn(over.it, ['hook', 'codex'], {
    env: { ...plainEnv(), HOME: over.home, USERPROFILE: over.home, IT_HOME: over.folder },
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  const ended = new Promise((resolve) => running.on('close', resolve))
  // It is running once the system has started it: from then on the file is a running program's.
  // That it then waits, and does not end by itself, is seen in that it is still running when
  // the install over it is done.
  const wasRunning =
    (await new Promise((resolve) => {
      running.once('spawn', () => resolve(true))
      running.once('error', () => resolve(false))
    })) && running.exitCode === null
  const overRunning = await install('over')
  // Windows will not remove a program that is running, so there the old one stays, under another name
  const aside = readdirSync(path.join(over.folder, 'bin')).filter((f) => f !== 'it' && f !== 'it.exe')
  check(
    'an install while the installed program is running replaces it all the same, and the one that is running runs on',
    wasRunning &&
      running.exitCode === null &&
      overRunning.code === 0 &&
      whole(overRunning, latest) &&
      /^\d+\.\d+\.\d+$/.test(runs(overRunning.it, overRunning.home)) &&
      (windows ? aside.length === 1 && /^it\.old\.\d+\.exe$/.test(aside[0]) : aside.length === 0),
    `${overRunning.said}\n${aside.join(' ')}`,
  )
  running.stdin.end()
  await ended
  // Windows lets go of a program's file a moment after the program has ended. The old program
  // stays there under another name, and can be opened for writing once it has been let go of.
  if (windows)
    for (const name of aside)
      await until(() => {
        try {
          closeSync(openSync(path.join(over.folder, 'bin', name), 'r+'))
          return true
        } catch {
          return false
        }
      })
  const overEnded = await install('over')
  check(
    'and once that program has ended, the next install leaves nothing in the folder but the new program',
    overEnded.code === 0 && whole(overEnded, latest) && nothingLeftBehind(overEnded) && nothingOfItsOwn(overEnded),
    `${overEnded.said}\n${readdirSync(path.join(over.folder, 'bin')).join(' ')}`,
  )
  if (windows) {
    // The folder's own list of who may open it, rule by rule, and whether it takes any more from
    // the folder it is in. Each rule is printed as who it names, what it allows, and whether
    // what is inside the folder takes it too
    const access = await inPowerShell(
      [
        `$a = Get-Acl -LiteralPath '${over.folder.replaceAll("'", "''")}'`,
        '$rules = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { "$($_.IdentityReference.Value)/$($_.AccessControlType)/$($_.FileSystemRights)/$($_.InheritanceFlags)" } | Sort-Object)',
        '$want = @(@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, "S-1-5-18", "S-1-5-32-544") | ForEach-Object { "$_/Allow/FullControl/ContainerInherit, ObjectInherit" } | Sort-Object)',
        '"protected=$($a.AreAccessRulesProtected) asWanted=$(($rules -join ";") -eq ($want -join ";")) rules=$($rules -join ";")"',
      ].join('\n'),
      over,
    )
    check(
      'It’s folder takes no access from the folder it is in, and gives all of it to this user, the system and its administrators and to nobody else',
      /protected=True asWanted=True /.test(access.said),
      access.said,
    )
    const pipedIn = await install('piped', {}, { piped: true })
    check(
      'piped into PowerShell as text, which is how `irm ... | iex` runs it, it installs, and leaves behind in the session neither its variables nor its functions, and neither of the two settings it changes while it runs',
      pipedIn.code === 0 && whole(pipedIn, latest) && !/left behind/.test(pipedIn.said),
      pipedIn.said,
    )
  }

  // ---------- a program that cannot start here ----------
  const startable = await install('startable')
  const wontStart = await install('wont-start', { IT_VERSION: 'unstartable' })
  const overStartable = await install('startable', { IT_VERSION: 'unstartable' })
  check(
    'a program that matches its checksum and cannot start on this system is not installed, and what was installed before stays',
    startable.code === 0 &&
      wontStart.code !== 0 &&
      /does not start on this system/.test(wontStart.flat) &&
      // And why, as the system said it: what it holds names a program that is not there to run it
      (windows
        ? /Windows would not start it: |It ended at once, with the code |It had not answered after thirty seconds/.test(wontStart.flat)
        : /does not have what the program needs in order to start|would not run it/.test(wontStart.flat) &&
          /What was said as it was tried: /.test(wontStart.flat)) &&
      nothingInstalled(wontStart) &&
      nothingOfItsOwn(wontStart) &&
      overStartable.code !== 0 &&
      whole(overStartable, latest) &&
      nothingLeftBehind(overStartable) &&
      nothingOfItsOwn(overStartable),
    `${wontStart.said}\n${overStartable.said}`,
  )

  // ---------- a folder where a file is to go ----------
  for (const [name, where] of [
    ['program', path.join('bin', windows ? 'it.exe' : 'it')],
    ['license', 'LICENSE.md'],
  ]) {
    const home = path.join(tmp, `a-folder-for-the-${name}`)
    mkdirSync(path.join(home, '.it', where), { recursive: true })
    asked.length = 0
    const r = await install(`a-folder-for-the-${name}`)
    check(
      `a folder where the ${name} is to go is not installed over or into, and that is said before anything is asked for`,
      r.code !== 0 &&
        /is a folder/.test(r.flat) &&
        asked.length === 0 &&
        readdirSync(path.join(home, '.it', where)).length === 0 &&
        readdirSync(path.join(home, '.it')).every((f) => f === 'bin' || f === where),
      `${r.said}\nasked: ${asked.join(' ')}`,
    )
  }

  // ---------- which release ----------
  asked.length = 0
  const named = await install('named', { IT_VERSION: 'v0.0.1' })
  check(
    'a release named by its tag is downloaded from that release',
    named.code === 0 && existsSync(named.it) && asked.every((a) => a.includes('/download/v0.0.1/')),
    `${named.said} ${asked.join(' ')}`,
  )
  const elsewhere = await install('elsewhere', { IT_HOME: path.join(tmp, 'elsewhere', 'kept here') })
  check(
    'with IT_HOME set, that folder is used, spaces and all',
    elsewhere.code === 0 && existsSync(elsewhere.it) && elsewhere.it.includes('kept here'),
    elsewhere.said,
  )
  const sums = await install('crlf', { IT_VERSION: 'crlf' })
  check('checksums written with Windows line endings are read all the same', sums.code === 0 && existsSync(sums.it), sums.said)

  // ---------- what is refused, and that nothing is installed or left behind when it is ----------
  const bad = await install('bad', { IT_VERSION: 'tampered' })
  check(
    'a program that does not match its published checksum is refused, and nothing is installed or left behind',
    bad.code !== 0 && /does not match its published checksum/.test(bad.flat) && nothingInstalled(bad) && nothingLeftBehind(bad),
    bad.said,
  )
  const badLicense = await install('bad-license', { IT_VERSION: 'relicensed' })
  check(
    'so is a license that does not match, though the program beside it does',
    badLicense.code !== 0 && /LICENSE\.md does not match/.test(badLicense.flat) && nothingInstalled(badLicense) && nothingLeftBehind(badLicense),
    badLicense.said,
  )
  const alike = await install('lookalike', { IT_VERSION: 'lookalike' })
  check('and a checksum is believed only for the file of exactly that name', alike.code !== 0 && nothingInstalled(alike), alike.said)
  const missing = await install('missing', { IT_VERSION: 'v9.9.9' })
  check('a release that does not exist installs nothing', missing.code !== 0 && nothingInstalled(missing) && nothingLeftBehind(missing), missing.said)
  const weird = await install('weird', { IT_VERSION: '../latest/download' })
  check('a release name that is not a tag is refused', weird.code !== 0 && nothingInstalled(weird), weird.said)

  // ---------- only https, or this machine and nothing it sends the install on to ----------
  asked.length = 0
  const plain = await install('plain', { IT_INSTALL_BASE: 'http://example.invalid/releases' })
  check('a base that is not https, and is not this machine, is refused', plain.code !== 0 && /https/.test(plain.flat) && nothingInstalled(plain), plain.said)
  // What looks like this machine and is a name and password for somewhere else
  const spoofed = await install('spoofed', { IT_INSTALL_BASE: `http://127.0.0.1:80@127.0.0.1:${elsewherePort}` })
  const dotted = await install('dotted', { IT_INSTALL_BASE: `http://localhost:${elsewherePort}.example.invalid` })
  check(
    'so is one that only begins like this machine’s address, before anything is asked of anyone',
    spoofed.code !== 0 && dotted.code !== 0 && nothingInstalled(spoofed) && nothingInstalled(dotted) && asked.length === 0,
    `${spoofed.said}\n${dotted.said}\nasked: ${asked.join(' ')}`,
  )
  const sent = await install('redirected', { IT_INSTALL_BASE: `http://127.0.0.1:${redirecting.address().port}` })
  check(
    'and a base on this machine that sends the install on elsewhere is not followed',
    sent.code !== 0 && nothingInstalled(sent) && nothingLeftBehind(sent) && !asked.some((a) => a.startsWith(`127.0.0.1:${elsewherePort}`)),
    `${sent.said}\nasked: ${asked.join(' ')}`,
  )
  const viaProxy = `http://127.0.0.1:${proxy.address().port}`
  const direct = await install('direct', { http_proxy: viaProxy, HTTP_PROXY: viaProxy, all_proxy: viaProxy, ALL_PROXY: viaProxy, no_proxy: '', NO_PROXY: '' })
  check(
    'and a proxy named in the environment is not asked for what this machine itself serves',
    direct.code === 0 && existsSync(direct.it) && throughProxy.length === 0,
    `${direct.said}\nthe proxy was asked for: ${throughProxy.join(' ')}`,
  )
} finally {
  for (const s of [server, elsewhereServer, redirecting, proxy]) s.close()
  rmSync(tmp, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
