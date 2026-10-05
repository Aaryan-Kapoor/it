// What the third-party notices say of the runtime inside the standalone programs.
//
// A standalone program is the `it` program inside a copy of the Bun runtime, and Bun links the
// work of others into that runtime. Bun's own statement of it, `LICENSE.md` in its repository,
// names each library and each package and the license it is under, and gives the words of no
// license. So the words are kept here, in scripts/notices/bun-<version>/, each as the library
// itself gives them at the commit that Bun's repository names for it, or as the package gives
// them at the version Bun's repository names, and `sources.json` beside them says where each
// is from. The same file lists what Bun's repository builds in or keeps and its statement does
// not name, with the words for each.
//
// What is kept is held to Bun's statement and to that list. A library or a package the
// statement names that has no text here stops the notices from being written, and so from
// passing their check, and so does anything on the list without one. Where no text could be
// established, the list says so in a sentence, under `without`, and the notices say it in the
// text's place. A text that nothing accounts for stops them too, and so does a link of the
// statement that still leads to a branch, which moves on, and not to a commit.
//
// Another Bun is a change to what is kept, and to nothing here: its `LICENSE.md` as
// bun-<version>.md, and bun-<version>/ with its `sources.json` and the texts that names.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const COMMIT = /^[0-9a-f]{40}$/
const text = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd()

/** A piece of text inside a fence longer than any run of backticks in it. */
export const fence = (text) => {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${ticks}text\n${text}\n${ticks}`
}

/** What Bun's statement names in the table under one of its headings: each row by the name the statement gives it. */
export function namedUnder(statement, heading) {
  const from = statement.indexOf(`\n## ${heading}\n`)
  if (from < 0) throw new Error(`Bun’s statement has no part named "${heading}"`)
  const next = statement.indexOf('\n## ', from + 1)
  const rows = statement
    .slice(from, next < 0 ? undefined : next)
    .split('\n')
    .filter((line) => line.startsWith('|'))
    // The table's two first rows are its headings and the rule under them
    .slice(2)
  if (!rows.length) throw new Error(`Bun’s statement names nothing under "${heading}"`)
  return rows.map((row) => {
    const named = /\[`?([^\]`]+)`?\]/.exec(row.split('|')[1] ?? '')?.[1]
    if (!named) throw new Error(`a row under "${heading}" in Bun’s statement names nothing: ${row}`)
    return named
  })
}
/** The two tables of Bun's statement, and the list in `sources.json` that has the texts for each. */
export const STATED = { libraries: 'Linked libraries', polyfills: 'Polyfills' }

/** The links of a text that lead to a branch of a repository and not to a commit of it. */
export const toBranches = (statement) =>
  [...statement.matchAll(/https?:\/\/[^\s<>()|]+/g)]
    .map((m) => m[0])
    .filter((link) => /\/refs\/heads\//.test(link) || /\/(?:blob|tree)\/(?![0-9a-f]{40}(?:\/|$))/.test(link))

/** What is kept for a Bun: its statement, and what `sources.json` says of the texts. */
export function keptFor(notices, version) {
  const stated = path.join(notices, `bun-${version}.md`)
  const listed = path.join(notices, `bun-${version}`, 'sources.json')
  if (!existsSync(stated) || !existsSync(listed))
    throw new Error(
      `the programs are built with Bun ${version}, and scripts/notices/ has no bun-${version}.md, or no bun-${version}/sources.json: copy LICENSE.md from that Bun’s commit of oven-sh/bun, keep the text of every license it names as the library gives it at the commit that Bun is built with, say in sources.json where each is from, and remove what is kept for the older Bun`,
    )
  return { statement: text(stated), sources: JSON.parse(readFileSync(listed, 'utf8')) }
}

/**
 * What the notices say of the Bun runtime, as lines: Bun's own statement, the words of every
 * license the statement names, and the words for what it does not name. `notices` is the
 * folder they are kept in, and `version` the Bun that the programs are built with.
 */
export function runtimeNotice(notices, version) {
  const kept = path.join(notices, `bun-${version}`)
  const { statement, sources } = keptFor(notices, version)
  const where = `scripts/notices/bun-${version}/sources.json`
  const { bun, webkit } = sources
  const list = (name) => (Array.isArray(sources[name]) ? sources[name] : [])

  // Which Bun this is: the commit it was built from, which it reports itself, and the tag of its release
  if (typeof bun?.repository !== 'string' || !COMMIT.test(bun.commit ?? '') || !COMMIT.test(bun.tagged ?? '') || typeof bun.tag !== 'string')
    throw new Error(`${where} does not say, under bun, which repository, which commit and which tag this Bun is`)
  if (bun.reports !== `${version}+${bun.commit.slice(0, 9)}`)
    throw new Error(`${where} does not say, under bun, what this Bun reports of itself: the version, a plus, and the first nine characters of its commit`)

  // Everything the statement names has an entry here, and no entry is for something it does not name
  const stated = Object.fromEntries(Object.entries(STATED).map(([name, heading]) => [name, namedUnder(statement, heading)]))
  for (const [name, heading] of Object.entries(STATED)) {
    for (const named of stated[name])
      if (list(name).filter((entry) => entry.named === named).length !== 1)
        throw new Error(
          `Bun’s statement names ${named} under "${heading}", and ${where} has no text for it, or more than one entry: keep its license there, under ${name}`,
        )
    for (const entry of list(name))
      if (!stated[name].includes(entry.named))
        throw new Error(`${where} keeps a text for ${entry.named}, which Bun’s statement does not name under "${heading}": remove it, or put it under unnamed`)
  }
  for (const entry of list('unnamed'))
    if (
      typeof entry.named !== 'string' ||
      Object.values(stated).flat().includes(entry.named) ||
      list('unnamed').filter((one) => one.named === entry.named).length !== 1
    )
      throw new Error(`${where} has ${entry.named} under unnamed, which is for what Bun’s statement does not name, each once`)
  for (const part of ['bun', 'webkit'])
    if (typeof sources[part]?.says !== 'string' || !statement.includes(sources[part].says))
      throw new Error(`${where} does not say, under ${part}, which words of Bun’s statement its texts are for, or the statement does not have those words`)

  // Each text is there, with where it is from. Where none could be established, that is said, and why.
  const used = new Set()
  const textsOf = (entry, name) => {
    if (entry.without !== undefined) {
      if (typeof entry.without !== 'string' || entry.without.trim().length < 40 || entry.texts !== undefined)
        throw new Error(`${where} gives no text for ${name}, and has to say why in a sentence, under without, and name no text beside it`)
      return []
    }
    const fromRepository = typeof entry.repository === 'string' && entry.repository.startsWith('https://') && COMMIT.test(entry.commit ?? '')
    const fromPackage = typeof entry.package === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(entry.version ?? '')
    if (fromRepository === fromPackage)
      throw new Error(`${where} does not say which repository and which commit the text for ${name} is from, or which package and which version`)
    if (!Array.isArray(entry.texts) || !entry.texts.length) throw new Error(`${where} names no text for ${name}`)
    return entry.texts.map(({ from, kept: file }) => {
      const at = typeof file === 'string' && path.basename(file) === file ? path.join(kept, file) : undefined
      const words = at && existsSync(at) ? text(at) : ''
      if (!words.trim()) throw new Error(`the text for ${name} that ${where} names, ${file}, is not in scripts/notices/bun-${version}/, or is empty`)
      used.add(file)
      return { from, words }
    })
  }
  const from = (entry) => {
    if (entry.without !== undefined) return entry.without
    const source = entry.package
      ? `From the package \`${entry.package}\` at version ${entry.version}, as npm gives it out: <https://registry.npmjs.org/${entry.package}/-/${entry.package}-${entry.version}.tgz>.`
      : `From <${entry.repository}> at commit \`${entry.commit}\`${entry.pinned ? `, which \`${entry.pinned}\` in Bun's repository names` : ''}.`
    return `${source}${entry.note ? ` ${entry.note}` : ''}`
  }
  const shown = (texts) => texts.flatMap(({ from, words }) => [...(from ? [`\`${from}\`:`, ''] : []), fence(words), ''])
  const each = (name, title = (entry) => entry.named) =>
    list(name).flatMap((entry) => {
      const texts = textsOf(entry, entry.named)
      return [`#### ${title(entry)}`, '', from(entry), '', ...shown(texts)]
    })

  const own = textsOf(bun, 'Bun')
  const engine = textsOf(webkit, 'JavaScriptCore and WebKit')
  const libraries = each('libraries')
  const polyfills = each('polyfills', (entry) => (entry.version ? `${entry.named} ${entry.version}` : entry.named))
  const unnamed = each('unnamed')
  if (!own.length || !engine.length) throw new Error(`${where} names no text for Bun itself, or none for JavaScriptCore and WebKit`)
  const stray = readdirSync(kept).filter((file) => file !== 'sources.json' && !used.has(file))
  if (stray.length)
    throw new Error(`scripts/notices/bun-${version}/ holds ${stray.join(', ')}, which ${where} does not name: say what each is the text of, or remove it`)

  // A link of the statement that leads to a branch is given as one to the commit a text is from
  let said = statement
  for (const [branch, commit] of Object.entries(sources.links ?? {})) {
    if (!said.includes(branch) || toBranches(commit).length)
      throw new Error(`${where} gives a link in place of ${branch}, which Bun’s statement does not have, or gives one that leads to no commit`)
    said = said.replaceAll(branch, commit)
  }
  const moving = toBranches(said)
  if (moving.length)
    throw new Error(`Bun’s statement links to a branch, which moves on: ${moving.join(', ')}. Say in ${where}, under links, which commit each is to be`)

  return [
    `## The runtime inside the standalone programs: Bun ${version}`,
    '',
    `The standalone programs are built with \`bun build --compile\`, which puts the \`it\` program's code inside a copy of the Bun runtime. The Bun they are built with reports itself as \`${bun.reports}\`: version ${version}, built from commit \`${bun.commit}\` of <${bun.repository}>. The tag \`${bun.tag}\` of that repository is another commit, \`${bun.tagged}\`. Bun's statement, and the build files of Bun's that name the commits below, are the same at both.`,
    '',
    `What follows is Bun's own statement of its license and of what it links, \`LICENSE.md\` at that commit. Where the statement links to a branch of a library, which moves on, the link is given here as one to the commit that the library's text below is from.`,
    '',
    fence(said),
    '',
    '### The words of the licenses that statement names',
    '',
    "Bun's statement names each license and gives the words of none. They follow, each as the library itself gives them at the commit that Bun's repository names for the library, and with each is said where it is from. Where Bun's repository names no commit for a library, or a library has no license file, that is said as well.",
    '',
    '#### Bun',
    '',
    `Bun's statement says: "${bun.says}" ${bun.note}`,
    '',
    ...shown(own),
    '#### JavaScriptCore and WebKit',
    '',
    from(webkit),
    '',
    ...shown(engine),
    ...libraries,
    '### The packages that statement says are embedded',
    '',
    `Bun's statement names these packages under "${STATED.polyfills}". The version of each is the one that \`src/node-fallbacks/bun.lock\` in Bun's repository names at that commit, and the text is from that version of the package as npm gives it out, whose checksum is the one the lock file has for it. For some of them, what Bun's repository builds from is a file of its own in \`src/node-fallbacks\` that holds a changed copy of the package's code, and the package's text is given all the same. The lock file also names the packages that these depend on, which the statement does not name and for which no text is given here.`,
    '',
    ...polyfills,
    '### What Bun builds in or keeps, and its statement does not name',
    '',
    "Bun's build files name these libraries, or Bun's repository or its WebKit keeps them, and Bun's statement names none of them. The statement gives no list to hold these to, so this one is of what Bun's build files register and of what its repository and its WebKit keep beside the libraries above, and it may not be all there is.",
    '',
    ...unnamed,
  ]
}
