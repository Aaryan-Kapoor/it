// Whether Codex has yet to run It's hooks as they are now: Codex 0.167 ties its approval of a
// plugin's hooks to the contents of the whole plugin folder, and runs none of them once a file in
// it has changed since the approval, as after an upgrade that changed one.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { codexApproved, codexHooksPending, codexPluginHash } from './src/setup'

let tmp: string
let codex: string
let plugin: string
const itHome = process.env.IT_HOME
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'it-codex-hooks-'))
  codex = path.join(tmp, '.codex')
  plugin = path.join(codex, 'plugins', 'cache', 'it', 'it-bridge', '0.1.0')
  // A plugin as Codex installs one, with these three files
  mkdirSync(path.join(plugin, 'hooks'), { recursive: true })
  mkdirSync(path.join(plugin, '.codex-plugin'))
  writeFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), '{"name":"it-bridge","version":"0.1.0","hooks":"./hooks/hooks.json"}\n')
  writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"it hook codex","timeout":5}]}]}}\n')
  writeFileSync(path.join(plugin, 'LICENSE.md'), 'The license.\n')
  process.env.IT_HOME = path.join(tmp, '.it')
  mkdirSync(path.join(tmp, '.it', 'addons'), { recursive: true })
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  if (itHome === undefined) delete process.env.IT_HOME
  else process.env.IT_HOME = itHome
})

/** Codex's settings, with an approval of each of It's hooks for the contents given, as Codex 0.167 writes it. */
const approved = (contents: string | null) =>
  ['stop', 'session_start']
    .map(
      (event) =>
        `[hooks.state."it-bridge@it:hooks/hooks.json:${event}:0:0"]\ntrusted_hash = "sha256:aa"\n${contents === null ? '' : `trusted_content_hash = "${contents}"\n`}`,
    )
    .join('\n')

describe('the contents of It’s plugin, as Codex reckons them', () => {
  test('are the same for the same folder, and change with any file in it, its name, or a folder added', () => {
    const first = codexPluginHash(plugin)
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(codexPluginHash(plugin)).toBe(first)
    writeFileSync(path.join(plugin, 'LICENSE.md'), 'The license, changed.\n')
    const changed = codexPluginHash(plugin)
    expect(changed).not.toBe(first)
    mkdirSync(path.join(plugin, 'empty'))
    expect(codexPluginHash(plugin)).not.toBe(changed)
  })

  test('leave out what Python makes of itself, as Codex does', () => {
    const before = codexPluginHash(plugin)
    mkdirSync(path.join(plugin, 'hooks', '__pycache__'))
    writeFileSync(path.join(plugin, 'hooks', '__pycache__', 'x.pyc'), 'bytecode')
    writeFileSync(path.join(plugin, 'hooks', 'y.pyc'), 'bytecode')
    expect(codexPluginHash(plugin)).toBe(before)
  })

  test('are what Codex itself reckons them to be', () => {
    // What Codex 0.167.0's own `hooks/list` gave as the contents of this very plugin, installed
    // from a marketplace with `codex plugin add` in a Codex folder of its own
    expect(codexPluginHash(plugin)).toBe('sha256:9889302441f571ce0f10531aaec2a0624214cb1ddb016eac96225a3a0c4745c9')
  })

  test.skipIf(process.platform === 'win32')('are not reckoned where the folder holds a link, which Codex refuses', () => {
    symlinkSync(path.join(plugin, 'LICENSE.md'), path.join(plugin, 'link'))
    expect(codexPluginHash(plugin)).toBeNull()
    expect(codexPluginHash(path.join(tmp, 'nowhere'))).toBeNull()
  })
})

describe('what Codex’s settings say of its approval of It’s hooks', () => {
  test('the contents approved for each hook, and that one is noted at all', () => {
    expect(codexApproved(approved('sha256:bb'))).toEqual({ noted: true, contents: ['sha256:bb', 'sha256:bb'] })
    expect(codexApproved(approved(null))).toEqual({ noted: true, contents: [] })
    // Another plugin's approval, or a value outside It's tables, is not It's
    expect(
      codexApproved('[hooks.state."other@x:hooks/hooks.json:stop:0:0"]\ntrusted_content_hash = "sha256:cc"\n[model]\ntrusted_content_hash = "sha256:dd"\n'),
    ).toEqual({
      noted: false,
      contents: [],
    })
  })
})

describe('whether Codex has yet to run It’s hooks', () => {
  test('yes where nothing is approved and no hook has run', () => {
    expect(codexHooksPending(codex)).toBe(true)
  })

  test('no where the approval is of the plugin as it is now, and yes again once a file in it has changed, though a hook ran before', () => {
    writeFileSync(path.join(codex, 'config.toml'), approved(codexPluginHash(plugin)))
    writeFileSync(path.join(tmp, '.it', 'addons', 'codex.hooks-seen'), '')
    expect(codexHooksPending(codex)).toBe(false)
    writeFileSync(path.join(plugin, 'LICENSE.md'), 'A newer license.\n')
    expect(codexHooksPending(codex)).toBe(true)
  })

  test('no where a Codex before 0.167 approved the hooks by their own text alone, or where a hook has run and nothing is noted', () => {
    writeFileSync(path.join(codex, 'config.toml'), approved(null))
    expect(codexHooksPending(codex)).toBe(false)
    writeFileSync(path.join(codex, 'config.toml'), '')
    writeFileSync(path.join(tmp, '.it', 'addons', 'codex.hooks-seen'), '')
    expect(codexHooksPending(codex)).toBe(false)
  })

  test('no where the plugin cannot be read, since it cannot then be told to have changed', () => {
    writeFileSync(path.join(codex, 'config.toml'), approved('sha256:bb'))
    rmSync(path.join(codex, 'plugins'), { recursive: true })
    expect(codexHooksPending(codex)).toBe(false)
  })
})
