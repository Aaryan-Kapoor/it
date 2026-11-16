# The Codex processes of one throwaway profile, by role, as their command lines tell them apart:
# the window (the harness's codex.exe, started by node with codex.js), the background server
# (`app-server … --managed-daemon` from <CODEX_HOME>\packages\app-server-daemon\releases\<version>),
# its `app-server daemon pid-update-loop`, and a `codex exec` (a copy It's Auto-wake starts).
# One line each: role, id, parent id, version, start time. No command line is printed.
#   powershell -File codex-procs.ps1 <run folder, such as D:\r\0045ode>
param([string]$Top)
$t = $Top.ToLower()
Get-CimInstance Win32_Process -Filter "Name='codex.exe'" | Where-Object { ([string]$_.CommandLine).ToLower().Contains($t) -or ([string]$_.CommandLine).Contains('codex-0.16') } | ForEach-Object {
  $c = [string]$_.CommandLine
  $role = if ($c -match 'managed-daemon') { 'server' } elseif ($c -match 'pid-update-loop') { 'server-pid-loop' } elseif ($c -match '\sexec\s') { 'exec (a copy)' } elseif ($c -match 'app-server') { 'app-server (other)' } elseif ($c -match '\supdate') { 'updater' } else { 'window' }
  $v = [regex]::Match($c, 'releases.(\d+\.\d+\.\d+)').Groups[1].Value
  if (-not $v) { $v = [regex]::Match($c, 'codex-(\d+\.\d+\.\d+)').Groups[1].Value }
  '{0,-16} pid {1,-6} parent {2,-6} v{3,-8} started {4}' -f $role, $_.ProcessId, $_.ParentProcessId, $v, $_.CreationDate.ToUniversalTime().ToString('HH:mm:ss')
}
