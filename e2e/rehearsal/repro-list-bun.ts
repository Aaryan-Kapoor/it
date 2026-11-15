// The Windows process listing of packages/cli/src/serve/backend.ts (~963), alone, to find what
// makes it hang in the program Bun compiles and not under Node. One variant per run:
//
//   repro-list-bun.exe [env] [progress] [stdin-ignore]
//     env           pass `env: process.env` to spawnSync (as service.ts does)
//     progress      begin the script with $ProgressPreference = 'SilentlyContinue' (as service.ts does)
//     stdin-ignore  give PowerShell no standard input (stdio[0] 'ignore')
//
// Prints one line of JSON: how long it took, how it ended, and whether the list came back whole.
// Compiled with the Bun that builds the release; also runs under Node as it is (node --experimental-strip-types).
import { spawnSync } from 'node:child_process'

const want = new Set(process.argv.slice(2))
const names = ["'convex-local-backend.exe'", "'it.exe'"].join(', ')
const script = [
  ...(want.has('progress') ? ["$ProgressPreference = 'SilentlyContinue'"] : []),
  "$ErrorActionPreference = 'Stop'",
  '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  '$session = (Get-Process -Id $PID).SessionId',
  `$names = @(${names})`,
  'Get-CimInstance Win32_Process -Property Handle, ProcessId, SessionId, Name, CommandLine | ForEach-Object {',
  '  $line = [string]$_.CommandLine',
  `  if ($_.ProcessId -eq ${process.pid}) { 'self' } elseif ($line) {`,
  "    if ($line.Contains('--instance-name')) { 'seen {0} {1}' -f $_.ProcessId, [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line)) }",
  '  } elseif ($names -contains $_.Name) {',
  "    $owner = 'unknown'",
  "    try { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid; if ($o.ReturnValue -eq 0 -and $o.Sid) { $owner = if ($o.Sid -eq $me) { 'mine' } else { 'other' } } } catch { }",
  "    'unseen {0} {1} {2}' -f $_.ProcessId, $owner, [int]($_.SessionId -eq $session)",
  '  }',
  '}',
  "'end'",
].join('\n')
const t0 = Date.now()
const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: Number(process.env.REPRO_TIMEOUT_MS ?? 60_000),
  maxBuffer: 64 * 1024 * 1024,
  ...(want.has('env') ? { env: process.env } : {}),
  ...(want.has('stdin-ignore') ? { stdio: ['ignore', 'pipe', 'pipe'] } : {}),
})
const rows = String(ran.stdout ?? '').split(/\r?\n/).map((l) => l.trim())
console.log(
  JSON.stringify({
    variant: [...want].join('+') || 'as released',
    runtime: typeof (globalThis as { Bun?: unknown }).Bun === 'undefined' ? `node ${process.version}` : `bun ${(globalThis as { Bun: { version: string } }).Bun.version}`,
    ms: Date.now() - t0,
    status: ran.status,
    signal: ran.signal,
    error: ran.error ? String((ran.error as NodeJS.ErrnoException).code ?? ran.error.message) : null,
    self: rows.includes('self'),
    end: rows.includes('end'),
    err: String(ran.stderr ?? '').replace(/\s+/g, ' ').slice(0, 300),
  }),
)
