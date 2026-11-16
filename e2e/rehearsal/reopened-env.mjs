// Watches for a conversation It reopens (the harness's own copy of an agent app started with
// `exec` or `--resume`, never the owner's) and, for each new one, writes down at once the NAMES of
// its environment variables (never a value) and the kinds of the folders on its PATH, first one
// first (env-names.ps1), with its parent and the start of its command line.
//   node e2e/rehearsal/reopened-env.mjs <out file> [minutes]
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const [out, minutes = '30', test = ''] = process.argv.slice(2)
const t0 = Date.now()
const seen = new Set()
const say = (s) => appendFileSync(out, `${new Date().toISOString().slice(11, 23)} ${s}\n`)
const ps = [
  "Get-CimInstance Win32_Process -Filter \"Name='codex.exe' OR Name='claude.exe' OR Name='node.exe'\" | Where-Object {",
  test
    ? `  $c = [string]$_.CommandLine; $c -like '*\\r\\*' -and $c -match '${test.replace(/'/g, "''")}' } | ForEach-Object {`
    : "  $c = [string]$_.CommandLine; $c -like '*it-rehearsal\\work\\apps*' -and ($c -match '\\sexec(\\s|$)' -or $c -match '--resume') } | ForEach-Object {",
  "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.ParentProcessId)\" -ErrorAction SilentlyContinue",
  "  $s = [string]$_.CommandLine -replace '^.*?\\\\(codex|claude)(\\.exe|\\.js)?\"?\\s*', '$1 '",
  "  '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.Name, $(if ($p) { $p.Name } else { '?' }), $s.Substring(0, [Math]::Min(160, $s.Length)) }",
].join('\n')
say('watching for reopened conversations')
while (Date.now() - t0 < Number(minutes) * 60000) {
  let rows = []
  try { rows = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim().split(/\r?\n/).filter(Boolean) } catch {}
  for (const row of rows) {
    const [pid, name, parent, cmd] = row.split('|')
    if (seen.has(pid)) continue
    seen.add(pid)
    let env = ''
    try { env = execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(here, 'env-names.ps1'), pid], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim() } catch (e) { env = `could not read (${String(e.message).slice(0, 60)})` }
    say(`NEW ${pid} ${name} parent ${parent}: ${cmd.replace(/C:\\Users\\[^\\]+/gi, '<profile>')}`)
    say(`ENV ${pid} ${env}`)
  }
  await new Promise((r) => setTimeout(r, 1000))
}
say('done')
