// Whether Codex has yet to run It's hooks as they are now: Codex 0.167 ties its approval of a
// plugin's hooks to the contents of the whole plugin folder, and runs none of them once a file in
// it has changed since the approval, as after an upgrade that changed one.
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { codexApproved, codexHooksPending, codexLegacyBaseline, codexPluginHash } from './src/setup'

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
    // from a marketplace with `codex plugin add` in a Codex folder of its own: on Linux, and on
    // Windows, where Codex reckons each file by its path as Windows writes it, with backslashes
    expect(codexPluginHash(plugin)).toBe(
      process.platform === 'win32'
        ? 'sha256:56b468e4bc56924e8a0a9cd6604944a7e0479120187b76d4c148cd7ae2acd131'
        : 'sha256:9889302441f571ce0f10531aaec2a0624214cb1ddb016eac96225a3a0c4745c9',
    )
  })

  test.skipIf(process.platform === 'win32')('are not reckoned where the folder holds a link, which Codex refuses', () => {
    symlinkSync(path.join(plugin, 'LICENSE.md'), path.join(plugin, 'link'))
    expect(codexPluginHash(plugin)).toBeNull()
    expect(codexPluginHash(path.join(tmp, 'nowhere'))).toBeNull()
  })
})

describe('what Codex’s settings say of its approval of It’s hooks', () => {
  test('the contents approved for each hook, and that one is noted at all', () => {
    expect(codexApproved(approved('sha256:bb'))).toEqual({ noted: true, contents: ['sha256:bb', 'sha256:bb'], unread: false })
    expect(codexApproved(approved(null))).toEqual({ noted: true, contents: [], unread: false })
    // Another plugin's approval, or a value outside It's tables, is not It's
    expect(
      codexApproved('[hooks.state."other@x:hooks/hooks.json:stop:0:0"]\ntrusted_content_hash = "sha256:cc"\n[model]\ntrusted_content_hash = "sha256:dd"\n'),
    ).toEqual({
      noted: false,
      contents: [],
      unread: false,
    })
  })

  test('written in any of the ways TOML allows: either quotation mark, dotted keys, or an inline table', () => {
    const key = '"it-bridge@it:hooks/hooks.json:stop:0:0"'
    for (const config of [
      `[hooks.state.${key}]\ntrusted_content_hash = 'sha256:bb'\n`,
      `[hooks.state]\n${key}.trusted_content_hash = "sha256:bb"\n`,
      `[hooks]\nstate.${key} = { trusted_hash = "sha256:aa", trusted_content_hash = "sha256:bb" }\n`,
      `hooks.state.${key}.trusted_content_hash = "sha256:bb"\n`,
      `[hooks.state]\n${key} = { trusted_hash = "sha256:aa", "trusted_content_hash" = "sha256:bb" }\n`,
      `[hooks.state.${key}]\n'trusted_content_hash' = "sha256:bb"\n`,
      `[hooks.state.${key}]\ntrusted_content_hash = '''sha256:bb'''\n`,
      `[hooks.state.${key}]\ntrusted_content_hash = """sha256:bb"""\n`,
    ])
      expect([config, codexApproved(config)]).toEqual([config, { noted: true, contents: ['sha256:bb'], unread: false }])
  })

  test('an array of tables after It’s ends It’s table, and a value of It’s that is no string cannot be read', () => {
    const key = '"it-bridge@it:hooks/hooks.json:stop:0:0"'
    expect(codexApproved(`[hooks.state.${key}]\ntrusted_hash = "sha256:aa"\n[[other]]\ntrusted_content_hash = "sha256:cc"\n`)).toEqual({
      noted: true,
      contents: [],
      unread: false,
    })
    expect(codexApproved(`[hooks.state.${key}]\ntrusted_content_hash = 12\n`)).toEqual({ noted: true, contents: [], unread: true })
    // A string over several lines is not read, and is said so, rather than taken for an empty one
    expect(codexApproved(`[hooks.state.${key}]\ntrusted_content_hash = '''\nsha256:bb'''\n`)).toEqual({ noted: true, contents: [], unread: true })
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

  test('only the version of the plugin Codex runs counts: the newest it keeps, whatever an older one holds', () => {
    const older = codexPluginHash(plugin)!
    const newer = path.join(path.dirname(plugin), '0.2.0')
    cpSync(plugin, newer, { recursive: true })
    writeFileSync(path.join(newer, 'LICENSE.md'), 'A newer license.\n')
    // Approved for the old one alone: the one Codex runs has changed
    writeFileSync(path.join(codex, 'config.toml'), approved(older))
    expect(codexHooksPending(codex)).toBe(true)
    // Approved for the one Codex runs, with an older one that cannot be read beside it
    writeFileSync(path.join(codex, 'config.toml'), approved(codexPluginHash(newer)))
    rmSync(path.join(plugin, 'LICENSE.md'))
    symlinkSync(path.join(newer, 'LICENSE.md'), path.join(plugin, 'LICENSE.md'))
    expect(codexHooksPending(codex)).toBe(false)
  })

  test('only folders named for a version are versions: a file a system leaves beside them does not hide the one Codex runs', () => {
    const newer = path.join(path.dirname(plugin), '0.2.0')
    cpSync(plugin, newer, { recursive: true })
    writeFileSync(path.join(path.dirname(plugin), '.DS_Store'), 'not a version')
    writeFileSync(path.join(codex, 'config.toml'), approved(codexPluginHash(plugin)))
    writeFileSync(path.join(newer, 'LICENSE.md'), 'A newer license.\n')
    expect(codexHooksPending(codex)).toBe(true)
  })

  test('no where an approval of It’s cannot be read, since it cannot then be told to be out of date', () => {
    writeFileSync(path.join(codex, 'config.toml'), '[hooks.state."it-bridge@it:hooks/hooks.json:stop:0:0"]\ntrusted_content_hash = 12\n')
    expect(codexHooksPending(codex)).toBe(false)
  })

  test('an approval by the hooks’ text alone holds while the plugin holds what Codex kept when they first ran, and not once it changes', () => {
    writeFileSync(path.join(codex, 'config.toml'), approved(null))
    // Codex has not run them yet, and takes the plugin as it finds it then
    expect(codexHooksPending(codex)).toBe(false)
    mkdirSync(path.join(codex, '.hook-trust'))
    writeFileSync(codexLegacyBaseline(codex), codexPluginHash(plugin)!)
    expect(codexHooksPending(codex)).toBe(false)
    writeFileSync(path.join(plugin, 'LICENSE.md'), 'A newer license.\n')
    expect(codexHooksPending(codex)).toBe(true)
  })

  test.skipIf(process.platform === 'win32')('what Codex kept is looked for where Codex 0.167.0 itself was seen to keep it', () => {
    // The name a real Codex 0.167.0 gave the file, for an approval by the hooks' text alone, with its settings at this path
    expect(codexLegacyBaseline('/tmp/itr/lg/.codex')).toBe('/tmp/itr/lg/.codex/.hook-trust/9e131a6999e945da1b869f1065367f9e23710dab99629a544a73aadaaa238073')
  })

  test('no where the plugin cannot be read, since it cannot then be told to have changed', () => {
    writeFileSync(path.join(codex, 'config.toml'), approved('sha256:bb'))
    rmSync(path.join(codex, 'plugins'), { recursive: true })
    expect(codexHooksPending(codex)).toBe(false)
  })
})
