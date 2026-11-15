# Starts a program as another local Windows account, with that account's own profile loaded and
# an environment given in full, so that nothing of the account that starts it (its home, its
# settings, its temporary folder) is handed on. What to start is a JSON request:
#
#   {"user": "itrehearsal", "exe": "...", "args": ["..."], "cwd": "...", "env": {"NAME": "value"},
#    "wait": false, "out": "<file for what it prints, when wait is true>"}
#
# on standard input, or in a file named by -Request, with what this says written to the file
# named by -Result: so that it can be started by WMI, outside the job of the session that asks,
# since Windows refuses to start a program as another account from inside a job that holds the
# asker. The request holds no secret, and its file is deleted once read.
#
# The account's password is read from the owner's record of it, the one file named below, and
# goes no further than the SecureString handed to Windows: it is never on a command line,
# printed or written anywhere. Says the process id, and with "wait", the exit code after it.
param([string]$Request, [string]$Result)
$ErrorActionPreference = 'Stop'
$said = New-Object System.Collections.Generic.List[string]
function Say($text) { $said.Add($text); if (-not $Result) { $text } else { [IO.File]::WriteAllLines($Result, $said) } }
try {
  $record = if ($env:IT_REHEARSAL_ACCOUNT_RECORD) { $env:IT_REHEARSAL_ACCOUNT_RECORD } else { Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'it-rehearsal-account.txt' }
  if ($Request) { $asked = Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json; Remove-Item -LiteralPath $Request -Force }
  else { $asked = [Console]::In.ReadToEnd() | ConvertFrom-Json }
  $line = Get-Content -LiteralPath $record | Where-Object { $_ -like 'Password: *' } | Select-Object -First 1
  if (-not $line) { throw 'the record of the account has no password line' }
  $secure = ConvertTo-SecureString -String $line.Substring(10) -AsPlainText -Force
  $line = $null
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $asked.exe
  $psi.Arguments = (@($asked.args) | ForEach-Object {
      $a = [string]$_
      if ($a -eq '' -or $a -match '[\s"]') { '"' + ($a -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' } else { $a }
    }) -join ' '
  # The account's profile is made at its first sign-in, so a folder in it may not be there yet
  # A folder in the other account's profile is one this account may not look into at all: it is
  # then given as it is, since the program started as that account can
  $there = $false
  if ($asked.cwd) { try { $there = Test-Path -LiteralPath $asked.cwd -ErrorAction Stop } catch { $there = $true } }
  $psi.WorkingDirectory = if ($there) { $asked.cwd } else { $env:SystemRoot }
  $psi.UserName = $asked.user
  $psi.Domain = $env:COMPUTERNAME
  $psi.Password = $secure
  $psi.LoadUserProfile = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables.Clear()
  foreach ($p in $asked.env.PSObject.Properties) { $psi.EnvironmentVariables[$p.Name] = [string]$p.Value }
  if ($asked.wait -and $asked.out) {
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
  }
  $proc = [System.Diagnostics.Process]::Start($psi)
  $secure.Dispose()
  Say "pid $($proc.Id)"
  if ($asked.wait) {
    if ($asked.out) {
      $o = $proc.StandardOutput.ReadToEndAsync()
      $e = $proc.StandardError.ReadToEndAsync()
      $proc.WaitForExit()
      [IO.File]::WriteAllText($asked.out, $o.Result + $e.Result)
    } else { $proc.WaitForExit() }
    Say "exit $($proc.ExitCode)"
  }
} catch {
  Say "error $($_.Exception.Message)"
}
