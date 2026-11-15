// Installs the agent apps for `itrehearsal` as a participant has them: `npm install -g` into the
// account's own npm folder (%APPDATA%\npm), and that folder on the account's own PATH (its
// registry, as Node's installer puts it for the person who runs it), so that a program started
// with the account's own environment, as Task Scheduler starts It's service, finds them.
//   node e2e/rehearsal/clean-apps.mjs [--codex 0.167.2] [--claude 2.1.322]
import { psAs, userEnv } from './asuser.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const pkgs = [`@openai/codex@${arg('codex', '0.167.2')}`, `@anthropic-ai/claude-code@${arg('claude', '2.1.322')}`]
const env = userEnv('itrehearsal', { extra: { npm_config_prefix: 'C:\\Users\\itrehearsal\\AppData\\Roaming\\npm', npm_config_cache: 'C:\\Users\\itrehearsal\\AppData\\Local\\npm-cache' } })
const script = [
  "$ErrorActionPreference = 'Continue'",
  '$npm = Join-Path $env:APPDATA "npm"',
  'New-Item -ItemType Directory -Force $npm | Out-Null',
  `& 'C:\\Program Files\\nodejs\\npm.cmd' install -g ${pkgs.join(' ')} 2>&1 | Select-Object -Last 3`,
  '$p = [Environment]::GetEnvironmentVariable("Path", "User")',
  'if (($p -split ";") -notcontains $npm) { [Environment]::SetEnvironmentVariable("Path", (($p.TrimEnd(";") + ";" + $npm).TrimStart(";")), "User"); "added to the account PATH: " + $npm }',
  '"account PATH now: " + [Environment]::GetEnvironmentVariable("Path", "User")',
  '"codex: " + ((Get-ChildItem $npm -Filter "codex*" | ForEach-Object Name) -join ",") + "; claude: " + ((Get-ChildItem $npm -Filter "claude*" | ForEach-Object Name) -join ",")',
].join('\n')
const r = await psAs('itrehearsal', script, env)
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, ''))
