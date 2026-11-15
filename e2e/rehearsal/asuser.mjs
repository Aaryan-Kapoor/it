// Programs run as another local Windows account (`itrehearsal`), with its own profile: through
// start-as.ps1, which reads the account's password from the owner's record and hands it only to
// Windows. The terminal of that account is agent-host.py, reached over TCP on 127.0.0.1.
import { spawnSync } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { protectDir } from './credentials.mjs'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { here, sleep, WORK } from './lib.mjs'

export const PYEMBED = path.join(WORK, 'pyembed', 'python.exe')
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** The environment a person signed in as `user` has: that account's own folders, and the system's. */
export function userEnv(user, { path: extraPath = [], extra = {} } = {}) {
  const home = `C:\\Users\\${user}`
  const system = process.env.SystemRoot ?? 'C:\\Windows'
  const local = `${home}\\AppData\\Local`
  return {
    USERPROFILE: home,
    HOMEDRIVE: 'C:',
    HOMEPATH: `\\Users\\${user}`,
    APPDATA: `${home}\\AppData\\Roaming`,
    LOCALAPPDATA: local,
    TEMP: `${local}\\Temp`,
    TMP: `${local}\\Temp`,
    USERNAME: user,
    USERDOMAIN: process.env.COMPUTERNAME ?? '',
    COMPUTERNAME: process.env.COMPUTERNAME ?? '',
    SystemRoot: system,
    windir: system,
    SystemDrive: 'C:',
    ComSpec: `${system}\\System32\\cmd.exe`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL',
    OS: 'Windows_NT',
    PSModulePath: `${home}\\Documents\\WindowsPowerShell\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;${system}\\system32\\WindowsPowerShell\\v1.0\\Modules`,
    ...Object.fromEntries(
      [
        'PROCESSOR_ARCHITECTURE',
        'PROCESSOR_IDENTIFIER',
        'PROCESSOR_LEVEL',
        'PROCESSOR_REVISION',
        'NUMBER_OF_PROCESSORS',
        'ProgramFiles',
        'ProgramFiles(x86)',
        'ProgramW6432',
        'ProgramData',
        'CommonProgramFiles',
        'CommonProgramFiles(x86)',
        'CommonProgramW6432',
        'PUBLIC',
        'ALLUSERSPROFILE',
        'DriverData',
      ]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    ),
    PATH: [
      ...extraPath,
      `${system}\\system32`,
      system,
      `${system}\\System32\\Wbem`,
      `${system}\\System32\\WindowsPowerShell\\v1.0\\`,
      `${system}\\System32\\OpenSSH\\`,
      'C:\\Program Files\\nodejs\\',
      'C:\\Program Files\\Git\\cmd',
      `${local}\\Microsoft\\WindowsApps`,
    ].join(';'),
    ...extra,
  }
}

/**
 * Starts a program as `user` through start-as.ps1, and resolves with its process id (and, with
 * `wait`, its exit code and output). start-as.ps1 is itself started by WMI, outside the job
 * that holds this session's processes: Windows refuses to start a program as another account
 * from inside such a job ("Access is denied"). The request it is given holds no secret.
 */
export async function startAs({ user, exe, args = [], cwd, env, wait = false, ms = 600_000 }) {
  const outDir = path.join(WORK, 'as-out')
  protectDir(outDir)
  mkdirSync(outDir, { recursive: true })
  const tag = `${Date.now()}-${randomBytes(4).toString('hex')}`
  const request = path.join(outDir, `${tag}.request.json`)
  const result = path.join(outDir, `${tag}.result.txt`)
  const out = wait ? path.join(outDir, `${tag}.out.txt`) : undefined
  writeFileSync(request, JSON.stringify({ user, exe, args, cwd, env, wait, out }))
  const line = `"${POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${path.join(here, 'start-as.ps1')}" -Request "${request}" -Result "${result}"`
  const created = spawnSync(
    POWERSHELL,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:IT_AS_LINE; CurrentDirectory = '${WORK}' }; "$($r.ReturnValue) $($r.ProcessId)"`,
    ],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, IT_AS_LINE: line } },
  )
  if (!/^0 \d+/.test(created.stdout.trim())) throw new Error(`WMI did not start the launcher: ${created.stdout} ${created.stderr}`)
  const end = Date.now() + ms
  let said = ''
  while (Date.now() < end) {
    await sleep(400)
    try {
      said = readFileSync(result, 'utf8')
    } catch {
      continue
    }
    if (/^error /m.test(said) || (/^pid \d+/m.test(said) && (!wait || /^exit /m.test(said)))) break
  }
  rmSync(request, { force: true })
  rmSync(result, { force: true })
  const pid = Number(/pid (\d+)/.exec(said)?.[1]) || null
  const exit = /exit (-?\d+)/.exec(said)?.[1]
  let output = ''
  if (out)
    try {
      output = readFileSync(out, 'utf8')
      rmSync(out, { force: true })
    } catch {}
  if (!pid) throw new Error(`could not start as ${user}: ${said.replace(/\s+/g, ' ').slice(0, 400) || 'no word from the launcher'}`)
  return { pid, exit: exit === undefined ? null : Number(exit), output }
}

/** Runs a PowerShell command as `user` and resolves with what it printed. Nothing secret goes in the command. */
export async function psAs(user, command, env) {
  // Windows takes a command line of at most 1024 characters when it starts a program as another account
  const script = path.join(WORK, 'user-bin', `${Date.now()}-${randomBytes(4).toString('hex')}.ps1`)
  mkdirSync(path.dirname(script), { recursive: true })
  writeFileSync(script, `\ufeff${command}\r\n`)
  try {
    return await startAs({ user, exe: POWERSHELL, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], cwd: `C:\\Users\\${user}`, env: env ?? userEnv(user), wait: true })
  } finally {
    rmSync(script, { force: true })
  }
}

/**
 * The terminal of `user`: agent-host.py started as that account, and one TCP connection to it.
 * `files` are the sign-ins lent to the run, written by the host as that account, readable by it
 * alone, and shredded when the shell ends. Resolves with a child-like object for terminal.mjs.
 */
export async function hostTerminal({ user, port, argv, cwd, cols, rows, env, appEnv = {}, files = [], logFile }) {
  const key = randomBytes(24).toString('hex')
  protectDir(path.join(WORK, 'as-out'))
  const started = await startAs({
    user,
    exe: PYEMBED,
    args: ['-I', userCopy('agent-host.py')],
    cwd: `C:\\Users\\${user}`,
    env: { ...env, IT_HOST_PORT: String(port), IT_HOST_KEY: key, IT_REHEARSAL_PYPATH: path.join(WORK, 'pyembed', 'site-packages'), IT_HOST_LOG: logFile },
  })
  let socket = null
  for (let i = 0; i < 60 && !socket; i++) {
    await sleep(500)
    socket = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => resolve(s))
      s.once('error', () => resolve(null))
    })
  }
  if (!socket) throw new Error(`the terminal of ${user} did not answer on ${port}`)
  // The host proves that it knows the key before anything secret is sent to it
  const nonce = randomBytes(24).toString('hex')
  socket.write(`${JSON.stringify({ nonce })}\n`)
  const proof = await new Promise((resolve) => {
    let buf = ''
    const late = setTimeout(() => resolve(''), 30_000)
    const on = (d) => {
      buf += d
      if (buf.includes('\n')) {
        clearTimeout(late)
        socket.off('data', on)
        resolve(buf.split('\n')[0].trim())
      }
    }
    socket.on('data', on)
  })
  const want = createHmac('sha256', key).update(nonce).digest('hex')
  if (proof.length !== want.length || !timingSafeEqual(Buffer.from(proof), Buffer.from(want))) {
    socket.destroy()
    throw new Error(`what answered on ${port} is not the terminal of ${user} that was started`)
  }
  socket.write(`${JSON.stringify({ key, argv, cwd, cols, rows, files, env: appEnv })}\n`)
  return { pid: started.pid, socket }
}

/** A copy of one of the harness's scripts where another account can read it: the harness lives in the owner's profile, which that account cannot. */
function userCopy(name) {
  const dir = path.join(WORK, 'user-bin')
  mkdirSync(dir, { recursive: true })
  const to = path.join(dir, name)
  copyFileSync(path.join(here, name), to)
  return to
}
