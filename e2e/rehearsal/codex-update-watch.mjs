// Watches one throwaway CODEX_HOME through Codex's own server update: every 500 ms the state of
// each conversation lock (read as It's `lockedElsewhere` does), every 3 s the Codex processes of
// that home (server / pid loop / other, with version and parent), and the updater's events.
// Writes a line only when something changes, with the UTC time.
//   node e2e/rehearsal/codex-update-watch.mjs <CODEX_HOME> <out file> [minutes]
import { execFileSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import path from 'node:path'

const [home, out, minutes = '20'] = process.argv.slice(2)
const locksDir = path.join(home, 'thread-writer-locks')
const updLog = path.join(home, 'app-server-daemon', 'daemon-updater.stderr.log')
const t0 = Date.now()
const say = (s) => appendFileSync(out, `${new Date().toISOString().slice(11, 23)} +${((Date.now() - t0) / 1000).toFixed(1)}s ${s}\n`)

function locks() {
  if (!existsSync(locksDir)) return 'no folder'
  const names = readdirSync(locksDir)
  if (!names.length) return 'no file'
  return names.map((n) => {
    let fd
    try { fd = openSync(path.join(locksDir, n), 'r') } catch (e) { return `${n.slice(0, 8)}:cannot-open` }
    try { readSync(fd, Buffer.alloc(1), 0, 1, 0); return `${n.slice(0, 8)}:NOT-held` } catch (e) { return `${n.slice(0, 8)}:held` } finally { closeSync(fd) }
  }).join(' ')
}

const needle = home.replace(/\\/g, '\\\\')
function procs() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='codex.exe'" | Where-Object { $_.CommandLine -like '*${home.replace(/'/g, "''")}*' } | ForEach-Object { $c=$_.CommandLine; $v= if ($c -match 'releases\\\\([0-9.]+)') { $matches[1] } else { '?' }; $k= if ($c -match 'pid-update-loop') {'pidloop'} elseif ($c -match 'managed-daemon') {'server'} else {'other'}; "\${k}:$($_.ProcessId):\${v}<$($_.ParentProcessId)" }`
  try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15000 }).trim().split(/\r?\n/).filter(Boolean).sort().join(' ') || 'none' } catch { return 'could not list' }
}
void needle

let lastL = '', lastP = '', updSeen = 0, nextP = 0
say(`watching ${path.basename(path.dirname(home))}`)
while (Date.now() - t0 < Number(minutes) * 60000) {
  const l = locks()
  if (l !== lastL) { say(`locks ${l}`); lastL = l }
  if (Date.now() >= nextP) {
    const p = procs()
    if (p !== lastP) { say(`procs ${p}`); lastP = p }
    nextP = Date.now() + 3000
    if (existsSync(updLog)) {
      const lines = readFileSync(updLog, 'utf8').split(/\r?\n/).filter((x) => x.startsWith('{'))
      for (const x of lines.slice(updSeen)) {
        try { const j = JSON.parse(x); say(`updater ${j.stage ?? j.event} ${j.outcome ?? ''} ${j.details?.release ?? ''} ${j.details?.trigger ?? ''} at ${new Date(j.timestampMs).toISOString().slice(11, 19)}`) } catch { say('updater (line not read)') }
      }
      updSeen = lines.length
    }
  }
  await new Promise((r) => setTimeout(r, 500))
}
say('done')
