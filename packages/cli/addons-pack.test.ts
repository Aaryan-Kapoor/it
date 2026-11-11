import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { CODEX_PLUGIN, CODEX_PLUGIN_AT, codexPluginFingerprint, packAddons } from './addons-pack.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../addons')
const skill = readFileSync(path.join(root, 'skill/SKILL.md'), 'utf8')
const license = readFileSync(path.join(root, '../LICENSE.md'), 'utf8')

test('an edit to the skill alone changes the files It installs and leaves the build each add-on reports as it was', () => {
  const before = packAddons({ root, skill, license })
  const after = packAddons({ root, skill: `${skill}\nOne more sentence for the agent.\n`, license })
  for (const id of Object.keys(before)) {
    expect(after[id]!.build).toBe(before[id]!.build)
    // Setup still installs the add-on again, since what it installs has changed
    expect(after[id]!.version).not.toBe(before[id]!.version)
  }
  // And the build is what the add-on's own code reports, wherever the code says it
  for (const [id, addon] of Object.entries(before))
    for (const text of Object.values(addon.files)) {
      expect(text).not.toContain('IT_ADDON_BUILD')
      expect(text).not.toContain('IT_ADDON_VERSION')
      if (id !== 'codex' && /ADDON_VERSION\s*=/.test(text)) expect(text).toMatch(new RegExp(`ADDON_VERSION\\s*=\\s*['"]${addon.build}['"]`))
    }
})

test('packing gives the same ids each time, and an add-on’s build is apart from the id of all its files', () => {
  const before = packAddons({ root, skill, license })
  const again = packAddons({ root, skill, license })
  expect(Object.fromEntries(Object.entries(again).map(([id, a]) => [id, a.build]))).toEqual(
    Object.fromEntries(Object.entries(before).map(([id, a]) => [id, a.build])),
  )
  // Every add-on's build differs from its files' id, since the skill is among the files and not in the build
  for (const addon of Object.values(before)) expect(addon.build).not.toBe(addon.version)
})

/** Every file committed in a folder, by its path inside it. */
function committed(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) committed(full, base, out)
    else out[path.relative(base, full).split(path.sep).join('/')] = readFileSync(full, 'utf8')
  }
  return out
}
const pluginOf = (addons: ReturnType<typeof packAddons>) =>
  Object.fromEntries(
    Object.entries(addons.codex!.files)
      .filter(([name]) => name.startsWith(CODEX_PLUGIN_AT))
      .map(([name, text]) => [name.slice(CODEX_PLUGIN_AT.length), text]),
  )

test('Codex’s plugin folder is packed exactly as it is committed, with nothing put into it from elsewhere', () => {
  const packed = pluginOf(packAddons({ root, skill, license }))
  expect(packed).toEqual(committed(path.join(root, 'codex', CODEX_PLUGIN_AT)))
  // Its license and its note of the It folder are among its own files
  expect(Object.keys(packed).sort()).toEqual(['.codex-plugin/plugin.json', 'LICENSE.md', 'hooks/hooks.json', 'it-home.json'])
  expect(packed['LICENSE.md']).toMatch(/^# License\n[\s\S]*\n## It License\n/)
  expect(JSON.parse(packed['it-home.json']!)).toMatchObject({ home: null })
})

test('a new license, skill or wording of an add-on elsewhere leaves Codex’s plugin folder as it was', () => {
  const before = packAddons({ root, skill, license })
  const after = packAddons({ root, skill: `${skill}\nOne more sentence for the agent.\n`, license: `${license}\nOne more term.\n` })
  expect(pluginOf(after)).toEqual(pluginOf(before))
  expect(codexPluginFingerprint(after)).toBe(codexPluginFingerprint(before))
  // The license as it is now goes beside the plugin folder, where Codex does not count it
  expect(after.codex!.files['LICENSE.md']).toBe(`${license}\nOne more term.\n`)
  // And `it setup` still installs the add-on again, since the files it installs have changed
  expect(after.codex!.version).not.toBe(before.codex!.version)
})

test('Codex’s plugin folder is the one whose fingerprint is recorded, which is changed only on purpose', () => {
  // Codex 0.167 ties its approval of It's hooks to every file in the plugin folder. When this
  // fails, every person who upgrades has to approve the hooks again, and in T3 Code and the
  // Codex desktop app nothing asks them to. Change CODEX_PLUGIN only when that is worth it.
  expect(codexPluginFingerprint(packAddons({ root, skill, license }))).toBe(CODEX_PLUGIN)
  // Any change to a file in the folder changes the fingerprint
  const changed = packAddons({ root, skill, license })
  changed.codex!.files[`${CODEX_PLUGIN_AT}LICENSE.md`] += '\n'
  expect(codexPluginFingerprint(changed)).not.toBe(CODEX_PLUGIN)
  const added = packAddons({ root, skill, license })
  added.codex!.files[`${CODEX_PLUGIN_AT}NOTICE.md`] = ''
  expect(codexPluginFingerprint(added)).not.toBe(CODEX_PLUGIN)
})
