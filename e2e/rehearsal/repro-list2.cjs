// It's process listing, as packages/cli/src/serve/backend.ts runs it, from a Node process: run
// as the account under test to see how it ends there.
const { spawnSync } = require('node:child_process')
const script = [
  "$ErrorActionPreference = 'Stop'",
  '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  '$session = (Get-Process -Id $PID).SessionId',
  "$names = @('convex-local-backend.exe', 'it.exe')",
  'Get-CimInstance Win32_Process -Property Handle, ProcessId, SessionId, Name, CommandLine | ForEach-Object {',
  '  $line = [string]$_.CommandLine',
  `  if ($_.ProcessId -eq ${process.pid}) { 'self' } elseif ($line) {`,
  "    if ($line.Contains('--instance-name')) { 'seen' }",
  '  } elseif ($names -contains $_.Name) {',
  "    $owner = 'unknown'",
  "    try { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid; if ($o.ReturnValue -eq 0 -and $o.Sid) { $owner = if ($o.Sid -eq $me) { 'mine' } else { 'other' } } } catch { }",
  "    'unseen {0} {1} {2}' -f $_.ProcessId, $owner, [int]($_.SessionId -eq $session)",
  '  }',
  '}',
  "'end'",
].join('\n')
for (let i = 0; i < 2; i++) {
  const t0 = Date.now()
  const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const rows = (ran.stdout || '').split(/\r?\n/).map((l) => l.trim())
  console.log(
    `try ${i}: ${Date.now() - t0} ms, error ${ran.error ? ran.error.code : 'none'}, status ${ran.status}, self ${rows.includes('self')}, end ${rows.includes('end')}, rows ${rows.length}`,
  )
  console.log(`stderr: ${(ran.stderr || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600)}`)
}
