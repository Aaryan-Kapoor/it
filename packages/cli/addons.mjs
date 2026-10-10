// Packs the add-ons into the CLI, so that `it setup` can install them with nothing to download.
// Each harness's add-on is a folder under addons/; the agent skill is shared and copied into
// each one where that harness looks for skills. The license goes into each one too, so that
// the terms are wherever an add-on is, and so does a note of which It folder installed it.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '../../addons')
const skill = readFileSync(path.join(root, 'skill/SKILL.md'), 'utf8')
const license = readFileSync(path.join(here, '../../LICENSE.md'), 'utf8')
/**
 * Where each harness's add-on wants the skill, relative to the add-on's folder. For Claude Code
 * and Codex that is beside the plugin and not inside it: `it setup` copies it from there into
 * the app's own skills folder, where the agent is shown it as "it". Inside the plugin it would
 * be shown as "it-bridge:it".
 */
const SKILL_AT = {
  'claude-code': 'skills/it/SKILL.md',
  codex: 'skills/it/SKILL.md',
  pi: 'skills/it/SKILL.md',
  opencode: 'skills/it/SKILL.md',
  openclaw: 'skills/it/SKILL.md',
  // Beside the plugin, not inside it: Hermes lists skills from its own skills folder only
  hermes: 'skills/it/SKILL.md',
}
/**
 * Where the license goes in each add-on: the folder the harness copies as the add-on. OpenCode
 * is given no folder, only a file to load, and that file's first lines say the terms.
 */
const LICENSE_AT = {
  'claude-code': 'it-bridge/LICENSE.md',
  codex: 'plugins/it-bridge/LICENSE.md',
  pi: 'LICENSE.md',
  openclaw: 'LICENSE.md',
  hermes: 'it-bridge/LICENSE.md',
}

/**
 * Where each add-on carries the note of which It folder installed it: inside what the harness
 * keeps as the add-on, so that the note goes wherever the add-on goes. OpenCode keeps no folder
 * for an add-on, so there it lies beside the skill. `it setup` fills in the folder's name.
 */
const HOME_AT = {
  'claude-code': 'it-bridge/it-home.json',
  codex: 'plugins/it-bridge/it-home.json',
  pi: 'it-home.json',
  opencode: 'skills/it/it-home.json',
  openclaw: 'it-home.json',
  hermes: 'it-bridge/it-home.json',
}
const homeNote = `${JSON.stringify(
  {
    about: 'It put this add-on here. `home` is the It folder it was installed from, and only `it setup` run for that folder replaces or removes it.',
    home: null,
  },
  null,
  1,
)}\n`

function walk(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    if (name === '__pycache__') continue
    if (statSync(full).isDirectory()) walk(full, base, out)
    // An add-on's own tests are not part of what is installed
    else if (/\.test\.[a-z]+$|^test_.*\.py$|\.pyc$/.test(name)) continue
    else out[path.relative(base, full).split(path.sep).join('/')] = readFileSync(full, 'utf8')
  }
  return out
}

const addons = {}
for (const id of readdirSync(root).sort()) {
  if (id === 'skill' || !statSync(path.join(root, id)).isDirectory()) continue
  const files = walk(path.join(root, id))
  if (SKILL_AT[id]) files[SKILL_AT[id]] = skill
  if (LICENSE_AT[id]) files[LICENSE_AT[id]] = license
  if (HOME_AT[id]) files[HOME_AT[id]] = homeNote
  const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12)
  addons[id] = { version, files }
}
writeFileSync(
  path.join(here, 'src/addons.generated.ts'),
  `// Written by packages/cli/addons.mjs. Do not edit.\nexport const SKILL: string = ${JSON.stringify(skill)}\nexport const LICENSE: string = ${JSON.stringify(license)}\nexport const ADDONS: Record<string, { version: string; files: Record<string, string> }> = ${JSON.stringify(addons, null, 1)}\n`,
)
console.log(
  `add-ons: ${Object.entries(addons)
    .map(([k, a]) => `${k} ${a.version}`)
    .join(', ')}`,
)
