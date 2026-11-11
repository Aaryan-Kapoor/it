// Packs the add-ons into the CLI, so that `it setup` can install them with nothing to download.
// Each harness's add-on is a folder under addons/; the agent skill is shared and copied into
// each one where that harness looks for skills. The license goes into each one too, so that
// the terms are wherever an add-on is, and so does a note of which It folder installed it.
// It says when Codex's plugin folder is not the one whose fingerprint is recorded, and a
// release refuses to be built until the fingerprint is changed on purpose.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODEX_PLUGIN, codexPluginFingerprint, packAddons } from './addons-pack.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '../../addons')
const skill = readFileSync(path.join(root, 'skill/SKILL.md'), 'utf8')
/**
 * What the skill leaves for when it is needed, each part under the word `it help <word>` prints
 * it by. The skill is read whole by an agent every time it is used, so it holds what every
 * page needs, and names each of these where an agent would want it.
 */
const more = Object.fromEntries(
  readdirSync(path.join(root, 'skill/more'))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => [name.slice(0, -3), readFileSync(path.join(root, 'skill/more', name), 'utf8')]),
)
const license = readFileSync(path.join(here, '../../LICENSE.md'), 'utf8')
export const addons = packAddons({ root, skill, license })
/** Whether Codex's plugin folder is the one whose fingerprint is recorded in `addons-pack.mjs`. */
export const codexPluginKept = codexPluginFingerprint(addons) === CODEX_PLUGIN
writeFileSync(
  path.join(here, 'src/addons.generated.ts'),
  `// Written by packages/cli/addons.mjs. Do not edit.\nexport const SKILL: string = ${JSON.stringify(skill)}\nexport const MORE: Record<string, string> = ${JSON.stringify(more, null, 1)}\nexport const LICENSE: string = ${JSON.stringify(license)}\nexport const ADDONS: Record<string, { version: string; build: string; files: Record<string, string> }> = ${JSON.stringify(addons, null, 1)}\n`,
)
console.log(
  `add-ons: ${Object.entries(addons)
    .map(([k, a]) => `${k} ${a.build} (files ${a.version})`)
    .join(', ')}`,
)
if (!codexPluginKept)
  console.warn(
    `add-ons: Codex's plugin folder has changed (fingerprint ${codexPluginFingerprint(addons)}), so everyone who upgrades has to approve It's hooks in Codex again. A release is refused until CODEX_PLUGIN in packages/cli/addons-pack.mjs says this fingerprint.`,
  )
