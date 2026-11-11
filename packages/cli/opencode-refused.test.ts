import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { fieldsOf, opencodePlugins, opencodeRefusedAt, refusedIn, unchangedSince } from './src/opencode-refused'

// The lines OpenCode writes when it refuses a plugin, as each version wrote them (seen with
// OpenCode 1.18.32 and 2.2.7 on Linux, and with 2.2.5 on Windows in #424)
const refusedBy1 = (at: Date, file: string) =>
  `timestamp=${at.toISOString()} level=ERROR run=f985fb3e message="failed to load plugin" path=${pathToFileURL(file).href} error="Plugin export is not a function"`
const refusedBy2 = (at: Date, file: string) =>
  `timestamp=${at.toISOString()} level=WARN run=9f604eaf message="failed to load plugin" target=${file} ref=err_fbb577dd cause="Cause([Fail(PluginModule.LoadError: Plugin must export a default definition with an id and an effect or setup function. (cause: SchemaError(Missing key\\n  at [\\"default\\"])))])" http.span=96 role=server`
const loadingBy2 = (at: Date, file: string) =>
  `timestamp=${at.toISOString()} level=INFO run=9f604eaf msg="loading plugin" id=${file} entrypoint=${pathToFileURL(file).href} http.span=82 role=server`

describe('whether OpenCode refused to load It’s add-on', () => {
  let dir: string
  let plugin: string
  let logs: string
  const put = new Date(Date.now() - 60_000)
  const after = (ms: number) => new Date(put.getTime() + ms)
  const log = (...lines: string[]) => writeFileSync(path.join(logs, 'opencode.log'), `${lines.join('\n')}\n`)

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'it-opencode-refused-'))
    plugin = path.join(dir, 'config', 'opencode', 'plugins', 'it-bridge.js')
    logs = path.join(dir, 'data', 'opencode', 'log')
    mkdirSync(path.dirname(plugin), { recursive: true })
    mkdirSync(logs, { recursive: true })
    writeFileSync(plugin, '// the add-on')
    utimesSync(plugin, put, put)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('names the file under each folder It put the add-on into, and none for an install that is not whole', () => {
    expect(
      opencodePlugins({
        installs: [
          { version: 'abc', dir: path.join(dir, 'config', 'opencode') },
          { version: 'installing', dir: path.join(dir, 'elsewhere') },
          { version: 'abc', dir: 'relative' },
          { version: 'abc' },
        ],
      }),
    ).toEqual([plugin])
    expect(opencodePlugins(null)).toEqual([])
    expect(opencodePlugins({ installs: 'no' })).toEqual([])
  })

  test.each([
    ['1.x', refusedBy1],
    ['2.x', refusedBy2],
  ])('reads a refusal in the words OpenCode %s writes, made after the file was put there', (_, refused) => {
    log(loadingBy2(after(1000), plugin), refused(after(1000), plugin), 'timestamp=2026-11-11T00:00:00.000Z level=INFO message=init')
    expect(opencodeRefusedAt([plugin], [logs])).toBe(after(1000).getTime())
  })

  test('takes the last of several refusals', () => {
    log(refusedBy2(after(1000), plugin), refusedBy1(after(5000), plugin), refusedBy2(after(3000), plugin))
    expect(opencodeRefusedAt([plugin], [logs])).toBe(after(5000).getTime())
  })

  test('counts no refusal from before the file was put there, which was of another file', () => {
    log(refusedBy2(after(-1000), plugin))
    expect(opencodeRefusedAt([plugin], [logs])).toBeUndefined()
    // Nor one of another plugin, nor a plugin that loaded
    log(refusedBy2(after(1000), path.join(path.dirname(plugin), 'other.js')), loadingBy2(after(2000), plugin))
    expect(opencodeRefusedAt([plugin], [logs])).toBeUndefined()
  })

  test('says nothing where the add-on is not there, or OpenCode has written no log', () => {
    log(refusedBy2(after(1000), plugin))
    expect(opencodeRefusedAt([path.join(dir, 'gone', 'it-bridge.js')], [logs])).toBeUndefined()
    expect(opencodeRefusedAt([plugin], [path.join(dir, 'no-logs')])).toBeUndefined()
    expect(opencodeRefusedAt([], [logs])).toBeUndefined()
  })

  test('reads only the end of a long log, where a refusal OpenCode has just written is, and says nothing of one before that', () => {
    const filler = 'timestamp=2026-11-11T00:00:00.000Z level=INFO message="something else"'
    log(refusedBy2(after(1000), plugin), ...Array.from({ length: 20_000 }, () => filler))
    expect(opencodeRefusedAt([plugin], [logs])).toBeUndefined()
    log(refusedBy2(after(1000), plugin), ...Array.from({ length: 20_000 }, () => filler), refusedBy2(after(2000), plugin))
    expect(opencodeRefusedAt([plugin], [logs])).toBe(after(2000).getTime())
  })

  test('takes a refusal the log no longer shows to stand while It’s file is as it was then, and not once it has been put there again', () => {
    expect(unchangedSince([plugin], after(1000).getTime())).toBe(true)
    utimesSync(plugin, after(2000), after(2000))
    expect(unchangedSince([plugin], after(1000).getTime())).toBe(false)
    expect(unchangedSince([path.join(dir, 'gone.js')], after(1000).getTime())).toBe(false)
    expect(unchangedSince([], after(1000).getTime())).toBe(false)
  })

  test('counts only a line whose own field names It’s file whole, and not one that mentions it elsewhere', () => {
    const files = [{ file: plugin, since: put.getTime() }]
    const at = after(1000).toISOString()
    // Another plugin whose name begins with It's
    expect(refusedIn(refusedBy2(after(1000), `${plugin}.backup.js`), files)).toBeUndefined()
    // Another plugin whose error names It's file
    const other = path.join(path.dirname(plugin), 'other.js')
    expect(refusedIn(`timestamp=${at} level=WARN message="failed to load plugin" target=${other} cause="cannot read ${plugin}"`, files)).toBeUndefined()
    // Words inside a quoted value are not fields of the line
    expect(refusedIn(`timestamp=${at} level=WARN message="failed to load plugin" target=${other} cause="x target=${plugin}"`, files)).toBeUndefined()
    expect(refusedIn(`timestamp=${at} level=INFO message="loaded" note="failed to load plugin target=${plugin}"`, files)).toBeUndefined()
    // And in quotes, as 2.x writes a path with spaces in it, It's file is found
    expect(refusedIn(`timestamp=${at} level=WARN message="failed to load plugin" target="${plugin}" cause="…"`, files)).toBe(after(1000).getTime())
    expect(fieldsOf('timestamp=1 message="a \\"b\\" c" path=x').get('message')).toBe('a "b" c')
  })

  test('reads no log last written before the add-on was put there', () => {
    log(refusedBy2(after(1000), plugin))
    utimesSync(path.join(logs, 'opencode.log'), after(-5000), after(-5000))
    expect(opencodeRefusedAt([plugin], [logs])).toBeUndefined()
  })

  test('finds a Windows path however its case is written, and with each backslash written once or twice', () => {
    const file = 'C:\\Users\\Someone\\.config\\opencode\\plugins\\it-bridge.js'
    const files = [{ file, since: put.getTime() }]
    const once = `timestamp=${after(1000).toISOString()} level=WARN message="failed to load plugin" target="c:\\users\\someone\\.config\\opencode\\plugins\\it-bridge.js" cause="…"`
    const twice = once.replaceAll('\\', '\\\\').replace(after(1000).toISOString(), after(2000).toISOString())
    expect(refusedIn(once, files, 'win32')).toBe(after(1000).getTime())
    expect(refusedIn(`${once}\n${twice}`, files, 'win32')).toBe(after(2000).getTime())
    // Where case tells paths apart, another case is another file
    expect(refusedIn(once, files, 'linux')).toBeUndefined()
  })
})
