// What the scripts that run a real agent app give the programs they start on Windows, so that
// those programs find a home of the run's own there, as HOME gives them one on Linux and macOS.
//
// On Windows HOME is not where a program looks. Node and Bun take the home folder from
// USERPROFILE, and where it is not set they ask the system, which answers with the person's own
// profile: a program given HOME alone would read and write the person's own settings there.
// The folders for settings and caches are APPDATA and LOCALAPPDATA, and the temporary folder is
// TEMP. Each is given here inside the run's own home. The rest are the system's own, which a
// program on Windows cannot do without: where Windows is, which shell runs a .cmd file, and
// which kinds of file are commands.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export const windows = process.platform === 'win32'

/** The variables that put a program's home, settings, caches and temporary files in `home`: none but on Windows. */
export function homeOnWindows(home) {
  if (!windows) return {}
  const roaming = path.join(home, 'AppData', 'Roaming')
  const local = path.join(home, 'AppData', 'Local')
  const temp = path.join(local, 'Temp')
  for (const folder of [roaming, local, temp]) mkdirSync(folder, { recursive: true })
  const { root } = path.parse(home)
  const system = process.env.SystemRoot ?? 'C:\\Windows'
  return {
    USERPROFILE: home,
    HOMEDRIVE: root.replace(/[\\/]$/, ''),
    HOMEPATH: home.slice(root.length - 1),
    APPDATA: roaming,
    LOCALAPPDATA: local,
    TEMP: temp,
    TMP: temp,
    SystemRoot: system,
    windir: system,
    SystemDrive: process.env.SystemDrive ?? 'C:',
    ComSpec: process.env.ComSpec ?? path.join(system, 'System32', 'cmd.exe'),
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC',
    OS: 'Windows_NT',
    ...Object.fromEntries(
      ['PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles']
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    ),
  }
}

/**
 * The system's own folders of commands, for a PATH: on Windows, Windows's own and Git's `cmd`
 * folder where Git for Windows is installed, as its installer puts it on a person's PATH (Claude
 * Code runs its Bash tool with Git's bash there). On Linux and macOS, the usual ones.
 */
export function systemPath() {
  if (!windows) return ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const system = process.env.SystemRoot ?? 'C:\\Windows'
  const git = gitFolder()
  return [
    path.join(system, 'System32'),
    system,
    path.join(system, 'System32', 'Wbem'),
    path.join(system, 'System32', 'WindowsPowerShell', 'v1.0'),
    ...(git ? [path.join(git, 'cmd')] : []),
  ]
}

/** Where Git for Windows is installed, where it is in the usual place: null where it is not. */
export function gitFolder() {
  if (!windows) return null
  for (const base of [process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean)) {
    const folder = path.join(base, 'Git')
    if (existsSync(path.join(folder, 'cmd', 'git.exe')) && existsSync(path.join(folder, 'bin', 'bash.exe'))) return folder
  }
  return null
}

/**
 * The processes whose program is in `folder`, or whose command line names it: on Windows, which
 * shows no other process's environment, how a run finds what it started that is still running.
 * The listing itself is left out. Null where the processes could not be listed.
 */
export function processesIn(folder) {
  const listing = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  )
  let all = null
  try {
    if (listing.status === 0) all = [JSON.parse(listing.stdout)].flat()
  } catch {}
  if (!all) return null
  const at = folder.toLowerCase()
  return all
    .filter((p) => p.ProcessId !== process.pid && !/Get-CimInstance Win32_Process/.test(p.CommandLine ?? ''))
    .filter(
      (p) =>
        String(p.ExecutablePath ?? '')
          .toLowerCase()
          .startsWith(at) ||
        String(p.CommandLine ?? '')
          .toLowerCase()
          .includes(at),
    )
    .map((p) => ({ pid: p.ProcessId, command: p.CommandLine ?? p.ExecutablePath ?? '' }))
}

/**
 * A folder for a PATH with the Node that runs this script in it and nothing else: on Windows a
 * copy (or a link) of node.exe in `folder`, since Node's own folder may hold the commands that
 * npm installed for the person, their agent apps among them. Elsewhere Node's own folder.
 */
export function nodeAlone(folder) {
  if (!windows) return path.dirname(process.execPath)
  mkdirSync(folder, { recursive: true })
  const node = path.join(folder, 'node.exe')
  if (!existsSync(node))
    try {
      linkSync(process.execPath, node)
    } catch {
      copyFileSync(process.execPath, node)
    }
  return folder
}

/**
 * How long to wait for something that waits on It's own commands, which on Windows take far longer
 * than elsewhere: a single `it status` took 25 seconds on GitHub's Windows runner. Elsewhere as given.
 */
export const patience = (ms) => (windows ? ms * 4 : ms)

/** The names a command may be found by in a folder: the command itself and, on Windows, the kinds of file a command is. */
export const commandNames = (command) => (windows ? ['', '.exe', '.cmd', '.bat', '.ps1', '.com'] : ['']).map((kind) => command + kind)
