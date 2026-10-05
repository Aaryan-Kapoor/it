// What the third-party notices say of the Bun runtime inside the standalone programs
// (scripts/notices-runtime.mjs). Bun's own statement names the libraries it links and the
// packages it embeds, and gives the words of no license, so the words are kept beside it, with
// the words for what Bun builds in and its statement does not name. What is kept is held to
// the statement and to that list: these tests take a text away, or add a library, and see that
// no notices are written then.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { keptFor, namedUnder, runtimeNotice, STATED, toBranches } from '../scripts/notices-runtime.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const kept = path.join(root, 'scripts', 'notices')
const version = /^\s*BUN_VERSION:\s*(\S+)\s*$/m.exec(readFileSync(path.join(root, '.github', 'workflows', 'it.yml'), 'utf8'))[1]
const { statement, sources } = keptFor(kept, version)
const libraries = namedUnder(statement, STATED.libraries)
const packages = namedUnder(statement, STATED.polyfills)

const made = []
afterAll(() => {
  for (const folder of made) rmSync(folder, { recursive: true, force: true })
})
/** A copy of what is kept, for a test to change, with where its list of sources and Bun's statement are. */
const copy = () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'it-notices-'))
  made.push(folder)
  cpSync(kept, folder, { recursive: true })
  const list = path.join(folder, `bun-${version}`, 'sources.json')
  return {
    folder,
    texts: path.join(folder, `bun-${version}`),
    stated: path.join(folder, `bun-${version}.md`),
    sources: () => JSON.parse(readFileSync(list, 'utf8')),
    keep: (sources) => writeFileSync(list, JSON.stringify(sources)),
  }
}
/** What stops the notices from being written once a copy's list of sources has been changed. */
const refusal = (change) => {
  const one = copy()
  const changed = one.sources()
  change(changed, one)
  one.keep(changed)
  try {
    runtimeNotice(one.folder, version)
  } catch (err) {
    return err.message
  }
  return 'nothing: the notices were written'
}

describe('the notices of the Bun runtime', () => {
  const lines = runtimeNotice(kept, version)
  const written = lines.join('\n')
  /** The lines under a heading, up to the next heading of the notices' own. */
  const under = (heading) => {
    const at = lines.indexOf(heading)
    const next = lines.findIndex((line, i) => i > at && /^#{3,4} /.test(line))
    return at < 0 ? undefined : lines.slice(at + 1, next < 0 ? undefined : next).join('\n')
  }
  const hasText = (part) => /```+text\n[\s\S]{400,}\n```+/.test(part ?? '')

  test('have the words of a license for Bun, for JavaScriptCore and WebKit, and for every library Bun’s statement names', () => {
    expect(libraries.length).toBeGreaterThan(15)
    const parts = ['Bun', 'JavaScriptCore and WebKit', ...libraries]
    const starts = parts.map((named) => lines.indexOf(`#### ${named}`))
    for (const [i, named] of parts.entries()) {
      expect(starts[i], named).toBeGreaterThan(i ? starts[i - 1] : -1)
      expect(hasText(under(`#### ${named}`)), named).toBe(true)
    }
  })

  test('say for every library which repository and which commit its text is from', () => {
    for (const named of libraries) expect(under(`#### ${named}`), named).toMatch(/^\nFrom <https:\/\/[^>]+> at commit `[0-9a-f]{40}`/)
  })

  test('have the words of a license for every package Bun’s statement says it embeds, at the version Bun’s repository names, or say why they have none', () => {
    expect(packages.length).toBeGreaterThan(15)
    const without = []
    for (const named of packages) {
      const entry = sources.polyfills.find((one) => one.named === named)
      if (entry.without) {
        without.push(named)
        expect(under(`#### ${named}`), named).toBe(`\n${entry.without}\n`)
        continue
      }
      const part = under(`#### ${named} ${entry.version}`)
      expect(part, named).toMatch(new RegExp(`^\\nFrom the package \`${named}\` at version ${entry.version.replaceAll('.', '\\.')}, as npm gives it out`))
      expect(hasText(part), named).toBe(true)
    }
    // The one package whose version Bun's repository does not name
    expect(without).toEqual(['stream-browserify'])
  })

  test('have the words for what Bun builds in and its statement does not name: three libraries its build files register, SQLite, zig-clap, and what WebKit keeps beside its own code', () => {
    const names = sources.unnamed.map((entry) => entry.named)
    expect(names).toEqual(['ls-hpack', 'highway', 'HdrHistogram_c', 'SQLite', 'zig-clap', "What WebKit's WTF carries"])
    for (const named of names) {
      const part = under(`#### ${named}`)
      expect(part, named).toMatch(/^\nFrom <https:\/\/[^>]+> at commit `[0-9a-f]{40}`/)
      // SQLite's own statement is a few lines, and the others are whole licenses
      expect(/```+text\n[\s\S]{200,}\n```+/.test(part), named).toBe(true)
    }
    expect(under('#### SQLite')).toContain('The author disclaims copyright to this source code.')
  })

  test('say which build of Bun they describe, by what it reports of itself, and that its tag is another commit', () => {
    expect(sources.bun.reports).toBe(`${version}+${sources.bun.commit.slice(0, 9)}`)
    expect(sources.bun.tagged).not.toBe(sources.bun.commit)
    expect(lines[2]).toContain(`reports itself as \`${sources.bun.reports}\`: version ${version}, built from commit \`${sources.bun.commit}\``)
    expect(lines[2]).toContain(`The tag \`bun-v${version}\` of that repository is another commit, \`${sources.bun.tagged}\``)
    // The script that is asked about Bun holds the Bun it runs to that
    const script = readFileSync(path.join(root, 'scripts', 'notices.mjs'), 'utf8')
    expect(script).toMatch(/execFileSync\('bun', \['--revision'\], \{ encoding: 'utf8' \}\)\.trim\(\)\n\s+if \(reported !== described\) throw new Error/)
  })

  test('link to no branch of a repository, which moves on: each such link of Bun’s statement is to a commit', () => {
    expect(toBranches(statement).length).toBeGreaterThan(0)
    const said = written.slice(0, written.indexOf('### The words of the licenses that statement names'))
    expect(toBranches(said)).toEqual([])
  })

  test('are in THIRD_PARTY_NOTICES.md whole, as the check of that file holds them', () => {
    expect(readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')).toContain(`${written}\n`)
  })
})

describe('what stops the notices of the runtime from being written', () => {
  test('a library of Bun’s statement that no text is kept for', () => {
    expect(
      refusal((changed) => {
        changed.libraries = changed.libraries.filter((library) => library.named !== 'zstd')
      }),
    ).toMatch(/names zstd under "Linked libraries", and .* has no text for it/)
  })

  test('a package of Bun’s statement that no text is kept for', () => {
    expect(
      refusal((changed) => {
        changed.polyfills = changed.polyfills.filter((one) => one.named !== 'util')
      }),
    ).toMatch(/names util under "Polyfills", and .* has no text for it/)
  })

  test('a library or a package that the statement comes to name, until its text is kept', () => {
    const one = copy()
    writeFileSync(one.stated, statement.replace('| [`brotli`]', '| [`another`](https://example.com/another) | MIT |\n| [`brotli`]'))
    expect(() => runtimeNotice(one.folder, version)).toThrow(/names another under "Linked libraries"/)
    const other = copy()
    writeFileSync(other.stated, statement.replace('| [`assert`]', '| [`one-more`](https://npmjs.com/package/one-more) | MIT |\n| [`assert`]'))
    expect(() => runtimeNotice(other.folder, version)).toThrow(/names one-more under "Polyfills"/)
  })

  test('something Bun’s statement does not name that is on the list with no text', () => {
    expect(
      refusal((changed) => {
        changed.unnamed[0].texts = []
      }),
    ).toMatch(/names no text for ls-hpack/)
    expect(
      refusal((changed) => {
        delete changed.unnamed[3].texts
      }),
    ).toMatch(/names no text for SQLite/)
  })

  test('an entry that gives no text and does not say why in a sentence, or says why and names a text all the same', () => {
    const none = (entry) => {
      for (const key of ['repository', 'commit', 'package', 'version', 'pinned', 'note', 'texts']) delete entry[key]
    }
    expect(
      refusal((changed, one) => {
        none(changed.unnamed[1])
        changed.unnamed[1].without = 'Not known.'
        for (const file of ['highway-LICENSE.txt', 'highway-LICENSE-BSD3.txt']) rmSync(path.join(one.texts, file))
      }),
    ).toMatch(/gives no text for highway, and has to say why in a sentence/)
    expect(
      refusal((changed) => {
        changed.unnamed[1].without = 'Bun’s repository names no commit of this library, so no text of it is given.'
      }),
    ).toMatch(/gives no text for highway, and has to say why in a sentence, under without, and name no text beside it/)
    // Said in a sentence, with no text named, it is what the notices say in the text's place
    const one = copy()
    const changed = one.sources()
    none(changed.unnamed[1])
    changed.unnamed[1].without = 'Bun’s repository names no commit of this library, so no text of it is given.'
    for (const file of ['highway-LICENSE.txt', 'highway-LICENSE-BSD3.txt']) rmSync(path.join(one.texts, file))
    one.keep(changed)
    const lines = runtimeNotice(one.folder, version)
    expect(lines[lines.indexOf('#### highway') + 2]).toBe(changed.unnamed[1].without)
  })

  test('something on the list of what the statement does not name that the statement names, or that is there twice', () => {
    expect(
      refusal((changed) => {
        changed.unnamed.push({ ...changed.libraries[0] })
      }),
    ).toMatch(/has boringssl under unnamed, which is for what Bun’s statement does not name/)
    expect(
      refusal((changed) => {
        changed.unnamed.push({ ...changed.unnamed[0] })
      }),
    ).toMatch(/has ls-hpack under unnamed, .* each once/)
  })

  test('a text that is named and is not there, or is empty', () => {
    const one = copy()
    rmSync(path.join(one.texts, 'zstd-COPYING.txt'))
    expect(() => runtimeNotice(one.folder, version)).toThrow(/the text for zstd .*zstd-COPYING\.txt, is not in .*or is empty/)
    writeFileSync(path.join(one.texts, 'zstd-COPYING.txt'), '\n')
    expect(() => runtimeNotice(one.folder, version)).toThrow(/zstd-COPYING\.txt, is not in .*or is empty/)
  })

  test('a text for Bun itself or for WebKit that is not there', () => {
    for (const part of ['bun', 'webkit'])
      expect(
        refusal((changed) => {
          changed[part].texts = []
        }),
        part,
      ).toMatch(/names no text for/)
  })

  test('a text that does not say which commit of which repository it is from, or which version of which package', () => {
    expect(
      refusal((changed) => {
        changed.libraries[0].commit = 'master'
      }),
    ).toMatch(/does not say which repository and which commit the text for boringssl is from, or which package and which version/)
    expect(
      refusal((changed) => {
        changed.polyfills[0].version = 'latest'
      }),
    ).toMatch(/does not say .* the text for assert is from/)
  })

  test('a text that is kept and that nothing accounts for', () => {
    const one = copy()
    writeFileSync(path.join(one.texts, 'left-over.txt'), 'A license.\n')
    expect(() => runtimeNotice(one.folder, version)).toThrow(/holds left-over\.txt, which .* does not name/)
    expect(
      refusal((changed) => {
        changed.libraries.push({ ...changed.libraries[0], named: 'nothing-linked' })
      }),
    ).toMatch(/keeps a text for nothing-linked, which Bun’s statement does not name under "Linked libraries"/)
  })

  test('a link of the statement to a branch that is given no commit', () => {
    const [branch] = Object.keys(sources.links)
    expect(
      refusal((changed) => {
        delete changed.links[branch]
      }),
    ).toMatch(/links to a branch, which moves on/)
    expect(
      refusal((changed) => {
        changed.links[branch] = branch
      }),
    ).toMatch(/leads to no commit/)
  })

  test('a list that does not say which build of Bun it is for, as that Bun reports itself', () => {
    expect(
      refusal((changed) => {
        changed.bun.reports = `${version}+0000000`
      }),
    ).toMatch(/does not say, under bun, what this Bun reports of itself/)
    expect(
      refusal((changed) => {
        delete changed.bun.tagged
      }),
    ).toMatch(/does not say, under bun, which repository, which commit and which tag this Bun is/)
  })

  test('another Bun than the one whose statement and texts are kept', () => {
    expect(() => runtimeNotice(kept, '0.0.1')).toThrow(/built with Bun 0\.0\.1, and scripts\/notices\/ has no bun-0\.0\.1\.md/)
  })
})
