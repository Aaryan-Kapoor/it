// Takes It out of the account `itrehearsal` with It's own uninstall, ends what is left of It
// and the agent apps there by their ids, and says what is left.
//   node e2e/rehearsal/clean-user.mjs
import { psAs, userEnv } from './asuser.mjs'

const r = await psAs(
  'itrehearsal',
  [
    "$ErrorActionPreference = 'Continue'",
    // First the sign-in files lent to a run, overwritten with random bytes and deleted
    "foreach ($f in @(\"$env:USERPROFILE\\.codex\\auth.json\", \"$env:USERPROFILE\\.claude\\.credentials.json\")) { if (Test-Path $f) { try { $n = [Math]::Max(64, (Get-Item $f).Length); $b = New-Object byte[] $n; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [IO.File]::WriteAllBytes($f, $b) } catch {}; Remove-Item -Force $f -ErrorAction SilentlyContinue } }",
    "'lent sign-in files left: ' + ((@(\"$env:USERPROFILE\\.codex\\auth.json\", \"$env:USERPROFILE\\.claude\\.credentials.json\") | Where-Object { Test-Path $_ }).Count)",
    "if (Test-Path \"$env:USERPROFILE\\.it\\bin\\it.exe\") { (& \"$env:USERPROFILE\\.it\\bin\\it.exe\" uninstall --yes 2>&1 | Out-String).Trim().Split(\"`n\") | Select-Object -Last 2 }",
    '$me = $PID',
    "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me -and ([string]$_.ExecutablePath) -like ($env:USERPROFILE + '\\*') } | ForEach-Object { 'ending ' + $_.Name + ' ' + $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me -and $_.Name -match '^(codex|codex-.*|claude|node)\\.exe$' } | Where-Object { try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $env:USERNAME } catch { $false } } | ForEach-Object { 'ending ' + $_.Name + ' ' + $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "foreach ($d in @(\"$env:USERPROFILE\\.it\", \"$env:USERPROFILE\\.itdiag\", \"$env:USERPROFILE\\hackathon\")) { if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } }",
    // Where It's own uninstall could not take its task away (another account's It in the session), the account's own task is removed by the account
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Get-ScheduledTask -TaskPath '\\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq ('it-' + $sid) } | ForEach-Object { Unregister-ScheduledTask -TaskPath '\\' -TaskName $_.TaskName -Confirm:$false; 'removed the account task ' + $_.TaskName }",
    '"tasks: " + ((Get-ScheduledTask -TaskPath "\\" -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "it*" } | ForEach-Object { $_.TaskName }) -join ",")',
    '"it folder: " + (Test-Path "$env:USERPROFILE\\.it")',
  ].join('\n'),
  userEnv('itrehearsal'),
)
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, '').trim())
