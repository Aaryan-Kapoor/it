// Whether an up-to-date Codex alone replaces its background server while it sits idle: Codex of
// the version given (only that one installed for the throwaway profile), started in a console
// window of its own, minimised, with a CODEX_HOME of its own, left alone; every minute the ids
// and versions of its app-server processes are written down. At the end everything it started is
// ended by its own id and the lent sign-in shredded.
//   node e2e/rehearsal/codex-idle-daemon.mjs [--version 0.169.0] [--minutes 60]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { codexAuth, shredAll, shredOnExit } from './credentials.mjs'
import { killTree, ownerSkillsOff, profileEnv, runFolders, sleep, WORK } from './lib.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const version = arg('version', '0.169.0')
const minutes = Number(arg('minutes', 60))
shredOnExit()
const f = runFolders(`codex-idle-${version}`)
const appBin = path.join(WORK, 'apps', `codex-${version}`, 'node_modules', '.bin')
const codexJs = path.join(WORK, 'apps', `codex-${version}`, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
const env = profileEnv(f, { port: 5660, appBin, guard: true })
mkdirSync(f.codexHome, { recursive: true })
writeFileSync(path.join(f.codexHome, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\ncli_auth_credentials_store = "file"\n${ownerSkillsOff()}`)
codexAuth(f.codexHome)
const out = path.join(f.results, 'daemon.log')
const note = (s) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${s}`
  console.log(line)
  writeFileSync(out, `${line}\n`, { flag: 'a' })
}
// A console of its own, minimised: `start /min` gives the program a console window, which a TUI needs
const starter = spawn('cmd.exe', [`/d /c start "codex-idle" /min "${process.execPath}" "${codexJs}"`], { env, cwd: f.work, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' })
await new Promise((r) => starter.on('exit', r))
note(`Codex ${version} started, minimised, in ${f.work}`)
const mark = f.codexHome.toLowerCase()
const daemons = () => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name='codex.exe' or Name='node.exe'" | Where-Object { ([string]$_.CommandLine).ToLower().Contains('${mark.replace(/'/g, "''")}') -or ([string]$_.CommandLine).Contains('codex-${version}') } | ForEach-Object { $k = if ($_.CommandLine -match 'managed-daemon') {'daemon'} elseif ($_.CommandLine -match 'pid-update-loop') {'pid-loop'} elseif ($_.Name -eq 'node.exe') {'launcher'} else {'window'}; $v = [regex]::Match([string]$_.CommandLine, 'releases.(\\d+\\.\\d+\\.\\d+)').Groups[1].Value; '{0}:{1}:{2}' -f $k, $_.ProcessId, $v }`], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .filter(Boolean)
      .sort()
      .join(' ')
  } catch {
    return '?'
  }
}
let last = ''
for (let m = 0; m <= minutes; m++) {
  const now = daemons()
  note(`${m} min: ${now}${now !== last && last ? '   <- CHANGED' : ''}`)
  last = now
  if (m < minutes) await sleep(60_000)
}
// Everything of the run, by its own id
for (const part of last.split(' ')) {
  const pid = Number(part.split(':')[1])
  if (pid) killTree(pid)
}
note(`ended; the lent sign-in shredded: ${shredAll()}`)
process.exit(0)
