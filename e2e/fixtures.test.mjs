// What the end-to-end run sends as if a person or a page had: every such value carries the
// mark that the check of the logs looks for, so that a log which repeats one is caught. This
// reads the page the run publishes and the run's own script, and holds them to that.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { leaks, PRIVATE_MARK } from './logs.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'plan')
const page = readFileSync(path.join(fixture, 'index.html'), 'utf8')
const run = readFileSync(path.join(here, 'run.mjs'), 'utf8')
const dir = mkdtempSync(path.join(os.tmpdir(), 'it-fixtures-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The first thing each call of this kind in a text is given after what comes before it, as it is written. */
const given = (text, call) => [...text.matchAll(call)].map((m) => m[1].trim())

describe('the page the end-to-end run publishes', () => {
  test('marks its title, its heading, and everything its buttons send, stage or store', () => {
    expect(/<title>(.*)<\/title>/.exec(page)[1]).toContain(PRIVATE_MARK)
    expect(/<h1>(.*)<\/h1>/.exec(page)[1]).toContain(PRIVATE_MARK)
    const sent = [
      ...given(page, /It\.action\('[^']+', (\{[^}]*\})/g),
      ...given(page, /It\.stage\('[^']+', ('[^']*')/g),
      ...given(page, /It\.store\.set\('[^']+', ('[^']*')/g),
    ]
    expect(sent).toHaveLength(4)
    for (const value of sent) expect(value).toContain(PRIVATE_MARK)
  })

  test('has a file whose own path is marked, and asks for it', () => {
    const files = readdirSync(fixture, { recursive: true }).map((name) => name.split(path.sep).join('/'))
    const marked = files.filter((name) => name.includes(PRIVATE_MARK))
    expect(marked).toHaveLength(1)
    expect(page).toContain(`src="${marked[0]}"`)
    expect(run).toContain(`fetch('${marked[0]}'`)
  })
})

describe('the end-to-end run', () => {
  test('marks every title it publishes under, every machine and display it names and every notification it sends', () => {
    const titles = given(run, /\[\s*'create',\s*([^,]+),/g)
    const machines = [...given(run, /(?<!\.)\bjoin\(\w+, ([^,)]+)/g), ...given(run, /'--name',\s*([^,\]]+\)?)/g)]
    const displays = given(run, /\.reminders input'\)\.fill\(([^)]+)\)/g)
    const notes = given(run, /\[\s*'notify',\s*([^,\]]+)/g)
    expect(titles.length).toBeGreaterThanOrEqual(8)
    expect(machines).toHaveLength(8)
    expect(displays).toHaveLength(2)
    expect(notes).toHaveLength(2)
    for (const title of titles) expect(title).toMatch(/^marked\('|PRIVATE_MARK/)
    for (const machine of machines) expect(machine).toMatch(/^marked\(['`]|^BOX$|^OTHER$/)
    for (const display of displays) expect(display).toMatch(/^WALL$|^SCREEN$/)
    for (const note of notes) expect(note).toMatch(/^NOTE$|PRIVATE_MARK/)
    for (const name of ['BOX', 'OTHER', 'WALL', 'SCREEN', 'LATE']) expect(run).toMatch(new RegExp(`const ${name} = marked\\('`))
    expect(run).toMatch(/const NOTE = `[^`]*\$\{PRIVATE_MARK\}/)
    // The machine It runs on is named by the stack, which marks its name as well
    expect(readFileSync(path.join(here, 'lib.mjs'), 'utf8')).toMatch(/export const STACK_MACHINE = `[^`]*\$\{PRIVATE_MARK\}/)
    // And so is every name and text the run sends to a function of the backend's directly
    const sent = [...given(run, /:rename', \{[^}]*\bname: (`[^`]*`|'[^']*'|\w+)/g), ...given(run, /'notifications:send', \{ text: (`[^`]*`|'[^']*')/g)]
    expect(sent.length).toBeGreaterThanOrEqual(5)
    for (const text of sent) expect(text).toMatch(/PRIVATE_MARK|^LATE$/)
  })

  test('marks every text it puts in a page’s state, whether the page starts with it, is set to it or is patched with it', () => {
    const set = given(run, /\[\s*'set',\s*\w+,\s*'\w+',\s*([^\]]+)\]/g)
    expect(set).toHaveLength(2)
    for (const value of set) expect(value).toMatch(/^DEPLOYING$|PRIVATE_MARK/)
    expect(run).toMatch(/const DEPLOYING = `[^`]*\$\{PRIVATE_MARK\}/)
    // Each state the run writes out in full is read as the run would send it, and every text in it looked at
    const written = [...given(run, /'--state',\s*(`[^`]*`|'[^']*')/g), ...given(run, /\[\s*'patch',\s*\w+,\s*(`[^`]*`|'[^']*')/g)]
    expect(written).toHaveLength(5)
    const texts = (value) => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(texts) : [])
    for (const literal of written) {
      const sent = JSON.parse(literal.slice(1, -1).replaceAll(`${'$'}{PRIVATE_MARK}`, PRIVATE_MARK))
      for (const text of texts(sent)) expect(text, literal).toContain(PRIVATE_MARK)
    }
  })

  test('so that a log which repeated any of them would be caught', async () => {
    const tag = 'abcde'
    const log = path.join(dir, 'service.log')
    writeFileSync(
      log,
      [
        'a line with nothing in it',
        `title: Agent page ${PRIVATE_MARK}${tag}`,
        `name: e2e laptop ${PRIVATE_MARK}${tag}`,
        `click: approve ${/It\.action\('approve', (\{[^}]*\})/.exec(page)[1]}`,
        `state: ${/It\.store\.set\('draft', '([^']*)'/.exec(page)[1]}`,
        `GET /v/1/img/${readdirSync(path.join(fixture, 'img'))[0]} 200`,
      ].join('\n'),
    )
    const { found } = await leaks([log])
    expect(found.map((f) => f.line)).toEqual([2, 3, 4, 5, 6])
    for (const f of found) expect(f.what).toBe('what a page or a person sent')
  })
})
