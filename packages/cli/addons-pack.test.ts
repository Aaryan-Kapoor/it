import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { packAddons } from './addons-pack.mjs'

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
