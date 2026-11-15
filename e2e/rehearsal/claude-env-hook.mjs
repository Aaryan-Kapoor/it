// For audit item 3: gives `itrehearsal`'s Claude Code a SessionStart hook that writes the NAMES
// (never the values) of the variables each starting session has, with the time and its parent
// process's name, to C:\Users\itrehearsal\claude-session-env.txt; so that a conversation It's
// Auto-wake reopens can be compared with one the person started in their terminal.
//   node e2e/rehearsal/claude-env-hook.mjs [--off | --read]
import { psAs, userEnv } from './asuser.mjs'

const home = 'C:\\Users\\itrehearsal'
const out = `${home}\\claude-session-env.txt`
const hookFile = `${home}\\.claude\\it-rehearsal-env-names.ps1`
// The hook's own script: names only, one line per session start
const hookPs1 = [
  `$names = (Get-ChildItem env: | ForEach-Object Name | Sort-Object) -join ','`,
  `$parent = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId`,
  `$pname = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $parent)).Name`,
  `$grand = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $parent)).ParentProcessId`,
  `$gname = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $grand)).Name`,
  `((Get-Date).ToUniversalTime().ToString('HH:mm:ss') + ' parent=' + $pname + ' grandparent=' + $gname + ' names=' + $names) | Out-File -Append -Encoding utf8 '${out}'`,
].join('\r\n')
const q = (s) => `'${s.replace(/'/g, "''")}'`
const settings = `${home}\\.claude\\settings.json`
let script
if (process.argv.includes('--read')) script = [`if (Test-Path ${q(out)}) { Get-Content ${q(out)} } else { 'nothing written' }`]
else
  script = [
    "$ErrorActionPreference = 'Stop'",
    `$s = if (Test-Path ${q(settings)}) { Get-Content -Raw ${q(settings)} | ConvertFrom-Json } else { [pscustomobject]@{} }`,
    ...(process.argv.includes('--off')
      ? ["if ($s.PSObject.Properties['hooks']) { $s.PSObject.Properties.Remove('hooks') }", `Remove-Item -Force ${q(hookFile)} -ErrorAction SilentlyContinue`, "'hook taken away'"]
      : [
          `[IO.File]::WriteAllText(${q(hookFile)}, ${q(hookPs1)})`,
          `$cmd = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${hookFile}"'`,
          "$entry = [pscustomobject]@{ hooks = @([pscustomobject]@{ type = 'command'; command = $cmd }) }",
          '$s | Add-Member -Force -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{ SessionStart = @($entry) })',
          "'hook set'",
        ]),
    `[IO.File]::WriteAllText(${q(settings)}, ($s | ConvertTo-Json -Depth 10))`,
  ]
const r = await psAs('itrehearsal', script.join('\n'), userEnv('itrehearsal'))
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, ''))
