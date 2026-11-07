// Writes THIRD_PARTY_NOTICES.md: every package whose code ends up in something It gives to a
// person or serves to a browser, with its license. The list is taken from the bundles
// themselves, never from a package.json: a package is named only if some of its code is in
// the output.
//
//   node scripts/notices.mjs           writes the file
//   node scripts/notices.mjs --check   fails if the file is not what would be written (CI)
//   node scripts/notices.mjs --bun     also asks Bun, which builds the standalone programs,
//                                      what it bundles, and fails if that is another list, or
//                                      if this Bun is another build than the notices describe
//
// The standalone programs also hold the Bun runtime, which no bundle shows. What is said of it
// is Bun's own statement of what it links, the words of every license that statement names,
// and the words for what Bun builds in and the statement does not name. All of it is kept in
// scripts/notices/, and scripts/notices-runtime.mjs holds it to the statement.
//
// Run `npm run generate` first: the program's entry point imports the files that writes, and
// one of them, the backend's functions as the program carries them, is read here.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { build as vite } from 'vite'
import { fence, keptFor, runtimeNotice } from './notices-runtime.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(root, 'THIRD_PARTY_NOTICES.md')
const rel = (file) => path.relative(root, path.resolve(root, file)).split(path.sep).join('/')

/** The package a file under node_modules belongs to: the innermost one, by its own package.json. */
function packageOf(file) {
  const parts = rel(file).split('/')
  const at = parts.lastIndexOf('node_modules')
  if (at < 0) return undefined
  const scoped = parts[at + 1]?.startsWith('@')
  const dir = path.join(root, ...parts.slice(0, at + (scoped ? 3 : 2)))
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  return { dir, name: manifest.name, version: manifest.version, license: licenseOf(manifest), homepage: repositoryOf(manifest) }
}
const licenseOf = (m) =>
  (typeof m.license === 'string' ? m.license : (m.license?.type ?? (m.licenses ?? []).map((l) => l.type).join(' OR '))) || 'not stated in its package.json'
/** Where a package says its source is, as an address a browser opens, however its package.json spells it. */
const repositoryOf = (m) => {
  const url = (typeof m.repository === 'string' ? m.repository : (m.repository?.url ?? m.homepage ?? ''))
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^(?:ssh:\/\/)?git@github\.com[:/]/, 'https://github.com/')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
  // "owner/name" alone is npm's shorthand for GitHub
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url
}

/** Every file esbuild put some bytes of into an output. A file that was resolved and then dropped whole is not one. */
const used = (metafile) => [
  ...new Set(
    Object.values(metafile.outputs).flatMap((o) =>
      Object.entries(o.inputs)
        .filter(([, i]) => i.bytesInOutput > 0)
        .map(([f]) => f),
    ),
  ),
]
const quiet = { bundle: true, write: false, metafile: true, logLevel: 'silent', absWorkingDir: root }

// ---------- each thing that is given out, built the way it is built ----------

/**
 * The `it` program. `packages/cli/build.mjs` builds the Node bundle this way; Bun builds the
 * standalone programs from the same entry. The service that shows pages is part of it, and is
 * bundled with it. The site, the backend's functions and the script in every page are carried
 * in it as text that was built before: each of those is a part of its own below.
 */
async function program() {
  const r = await esbuild({
    ...quiet,
    entryPoints: ['packages/cli/src/main.ts'],
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: 'it.mjs',
    loader: { '.md': 'text', '.txt': 'text' },
  })
  return used(r.metafile)
}

/** What Bun itself bundles from the same entry, read from its source map. */
function programByBun() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'it-notices-'))
  try {
    execFileSync('bun', ['build', path.join(root, 'packages/cli/src/main.ts'), '--target=bun', '--sourcemap=external', '--outdir', dir], { stdio: 'ignore' })
    const map = JSON.parse(readFileSync(path.join(dir, 'main.js.map'), 'utf8'))
    return map.sources.map((s) => path.resolve(dir, s))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The script placed first in every page, as `packages/runtime/build.mjs` builds it. */
async function runtime() {
  const r = await esbuild({ ...quiet, entryPoints: ['packages/runtime/src/it.ts'], format: 'iife', minify: true, target: 'es2020' })
  return used(r.metafile)
}

/**
 * The backend's functions, read from the file of them that the program carries
 * (`scripts/functions.mjs` writes it, with the `convex` package's own bundler). Every module in
 * that file comes with a map of the files it was made from, and those are the files. A module
 * with no map would say nothing of what is in it, so it stops this script.
 */
function functions() {
  const file = path.join(root, 'packages/cli/src/functions.generated.ts')
  const text = /^export const FUNCTIONS: string = (.*)$/m.exec(existsSync(file) ? readFileSync(file, 'utf8') : '')?.[1]
  if (!text) throw new Error('the backend functions have not been built: run `npm run generate` first')
  const modules = []
  const find = (value) => {
    if (Array.isArray(value)) value.forEach(find)
    else if (value && typeof value === 'object') {
      if (typeof value.path === 'string' && typeof value.source === 'string') modules.push(value)
      else Object.values(value).forEach(find)
    }
  }
  find(JSON.parse(JSON.parse(text)))
  if (!modules.length) throw new Error('the file of backend functions holds no module')
  const files = new Set()
  for (const module of modules) {
    if (typeof module.sourceMap !== 'string') throw new Error(`the backend functions hold ${module.path} with no map of what it was made from`)
    // A map names its files from where the module was written: a folder beside convex/, with the module's own folders inside it
    for (const source of JSON.parse(module.sourceMap).sources) {
      const from = path.resolve(root, 'out', path.dirname(module.path), source)
      // What the bundler made up itself is no file
      if (existsSync(from)) files.add(from)
    }
  }
  return [...files]
}

/** The site, built by Vite as `npm run build -w web` builds it. */
async function site() {
  const r = await vite({
    root: path.join(root, 'web'),
    logLevel: 'silent',
    build: { write: false, sourcemap: false },
  })
  const chunks = (Array.isArray(r) ? r : [r]).flatMap((o) => o.output).filter((c) => c.type === 'chunk')
  return chunks.flatMap((c) =>
    Object.entries(c.modules)
      .filter(([, m]) => m.renderedLength > 0)
      // Vite adds a query to some. A module Rollup or Vite made up itself has a leading NUL:
      // Vite's own are code of Vite's that ends up in the site, and are counted as Vite's.
      .map(([id]) => (id.startsWith('\0vite/') ? path.join(root, 'node_modules/vite/package.json') : id.replace(/\?.*$/, '')))
      .filter((id) => !id.startsWith('\0')),
  )
}

/** The add-ons are given out as they are written. They may use only what their host and Node provide. */
function addons() {
  const found = []
  const walk = (dir) => {
    for (const name of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = `${dir}/${name.name}`
      if (name.isDirectory()) walk(file)
      else if (/\.(js|mjs|ts)$/.test(name.name) && !/\.test\./.test(name.name)) {
        const text = readFileSync(path.join(root, file), 'utf8')
        for (const m of text.matchAll(
          /(?:^|\n)\s*(?:import\s[^'"\n]*from\s*|import\s*|(?:const|let|var)\s[^=\n]*=\s*(?:await\s+import|require)\s*\(\s*)['"]([^'"]+)['"]/g,
        ))
          if (!/^(node:|\.{1,2}\/)/.test(m[1])) found.push(`${file} imports ${m[1]}`)
      }
    }
  }
  walk('addons')
  if (found.length) throw new Error(`an add-on uses a package, which nothing would install for it:\n  ${found.join('\n  ')}`)
}

// ---------- other people's code inside a package's own files ----------

/**
 * A package boundary does not show everything. Convex carries the work of others inside its own
 * files: copied in, or bundled into one of them. Each is named here with where its license is
 * found, and the list is held to what is really there: a file under Convex's `vendor` folder
 * that is not named here stops this script, and so does a version that is not the one the
 * license was taken from.
 */
const CARRIED = {
  convex: [
    {
      name: 'base64-js',
      // A file of the package as it is bundled, or the source it was built from, which is what a map names
      when: /\/(?:dist\/esm|src)\/values\/base64\.[jt]s$/,
      license: 'MIT',
      source: 'https://github.com/beatgammit/base64-js',
      headerOf: 'src/values/base64.ts',
      // The copied file's opening comment names its license and not its words. They are kept
      // here, from the commit that comment names, and the comment is held to naming that commit
      terms: { commit: '88957c9943c7e2a0f03cdf73e71d579e433627d3', kept: 'base64-js-88957c9.txt' },
    },
    {
      name: 'long.js',
      when: /\/(?:dist\/esm|src)\/vendor\/long\.[jt]s$/,
      license: 'Apache-2.0',
      source: 'https://github.com/dcodeIO/long.js',
      headerOf: 'src/vendor/long.ts',
    },
    {
      name: 'jwt-decode',
      when: /\/(?:dist\/esm|src)\/vendor\/jwt-decode\//,
      license: 'MIT',
      source: 'https://github.com/auth0/jwt-decode',
      file: 'src/vendor/jwt-decode/LICENSE',
    },
    // The client Convex gives programs that are not browsers has these three bundled into it
    { name: 'ws', when: /\/dist\/esm\/browser\/simple_client-node\.js$/, license: 'MIT', source: 'https://github.com/websockets/ws', installed: 'ws' },
    {
      name: 'bufferutil',
      when: /\/dist\/esm\/browser\/simple_client-node\.js$/,
      license: 'MIT',
      source: 'https://github.com/websockets/bufferutil',
      kept: true,
    },
    {
      name: 'node-gyp-build',
      when: /\/dist\/esm\/browser\/simple_client-node\.js$/,
      license: 'MIT',
      source: 'https://github.com/prebuild/node-gyp-build',
      kept: true,
    },
  ],
}
/**
 * The comments a source file opens with, which is where a copied-in file says whose it is.
 * With `first`, only the first of them: what stands before the first empty line.
 */
function headerOf(file, first = false) {
  const text = readFileSync(file, 'utf8')
  const lines = []
  let inBlock = false
  for (const line of text.split('\n')) {
    if (inBlock) {
      lines.push(line.replace(/\*\/\s*$/, ''))
      if (line.includes('*/')) inBlock = false
    } else if (/^\s*\/\//.test(line)) lines.push(line.replace(/^\s*\/\/ ?/, ''))
    else if (/^\s*\/\*/.test(line)) {
      lines.push(line.replace(/^\s*\/\*+ ?/, '').replace(/\*\/\s*$/, ''))
      inBlock = !line.includes('*/')
    } else if (line.trim() === '') {
      if (first && lines.length) break
      if (lines.length) lines.push('')
    } else break
  }
  return lines.join('\n').trim()
}
/** What a package carries, for the files of it that are in a bundle: each with its version where one is written in the file, and its license text. */
function carriedIn(pkg, files) {
  const rules = CARRIED[pkg.name] ?? []
  const stray = files.filter((f) => /\/vendor\//.test(rel(f)) && !rules.some((r) => r.when.test(rel(f))))
  if (stray.length)
    throw new Error(`${pkg.name} carries code in ${stray.map(rel).join(', ')} that scripts/notices.mjs does not name: say whose it is, in CARRIED`)
  const out = []
  for (const rule of rules) {
    const file = files.find((f) => rule.when.test(rel(f)))
    if (!file) continue
    // Bundled into one file, a package is still named in it with its version
    const version = new RegExp(`${rule.name}@([0-9]+\\.[0-9]+\\.[0-9]+)`).exec(readFileSync(path.resolve(root, file), 'utf8'))?.[1]
    let text
    if (rule.headerOf) {
      text = headerOf(path.join(pkg.dir, rule.headerOf))
      if (rule.terms) {
        if (!text.includes(rule.terms.commit))
          throw new Error(
            `${pkg.name} now carries ${rule.name} from another commit than ${rule.terms.commit}: put that commit's license in scripts/notices/, and name both in CARRIED`,
          )
        text = `${text}\n\n${readFileSync(path.join(root, 'scripts/notices', rule.terms.kept), 'utf8').trim()}`
      }
    } else if (rule.file) text = readFileSync(path.join(pkg.dir, rule.file), 'utf8')
    else if (rule.installed) {
      const dir = path.join(root, 'node_modules', rule.installed)
      const has = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version
      if (has !== version) throw new Error(`${pkg.name} carries ${rule.name} ${version}, and the one installed, whose license would be used, is ${has}`)
      text = texts(dir)
        .map(([, t]) => t)
        .join('\n\n')
    } else if (rule.kept) {
      const kept = path.join(root, 'scripts/notices', `${rule.name}-${version}.txt`)
      if (!existsSync(kept))
        throw new Error(
          `${pkg.name} carries ${rule.name} ${version}: put that version's license in scripts/notices/${rule.name}-${version}.txt, and remove the older one`,
        )
      text = readFileSync(kept, 'utf8')
    }
    if (!text?.trim()) throw new Error(`no license text was found for ${rule.name}, which ${pkg.name} carries`)
    out.push({ name: rule.name, version, license: rule.license, source: rule.source, text: text.replace(/\r\n/g, '\n').trimEnd() })
  }
  return out
}

// ---------- the file ----------

const PARTS = [
  ['The `it` program', program],
  ["The backend's functions", functions],
  ['The site', site],
  ['The script in every page', runtime],
]

const packages = new Map()
const perPart = []
for (const [part, list] of PARTS) {
  const names = new Set()
  for (const file of await list()) {
    const p = packageOf(file)
    if (!p) continue
    const key = `${p.name}@${p.version}`
    names.add(key)
    if (!packages.has(key)) packages.set(key, { ...p, parts: [], files: new Map() })
    const known = packages.get(key)
    if (!known.parts.includes(part)) known.parts.push(part)
    // Which of its files went into which part: what a package carries inside is in some parts and not others
    if (!known.files.has(part)) known.files.set(part, [])
    known.files.get(part).push(file)
  }
  perPart.push([part, [...names].sort()])
}
addons()

if (process.argv.includes('--bun')) {
  const want = perPart[0][1]
  const have = [
    ...new Set(
      programByBun()
        .map(packageOf)
        .filter(Boolean)
        .map((p) => `${p.name}@${p.version}`),
    ),
  ].sort()
  if (want.join() !== have.join())
    throw new Error(`Bun bundles another list for the program than this file says:\n  this file: ${want.join(', ')}\n  Bun:       ${have.join(', ')}`)
  console.log(`Bun bundles the same packages for the program: ${have.join(', ')}`)
}

/** A package's own license and notice files, as it ships them. */
function texts(dir) {
  return readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice|third[-_]?party[-_]?notices)([-._].*)?$/i.test(f))
    .sort()
    .map((f) => [f, readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trimEnd()])
}

// The standalone programs are the `it` program inside the Bun runtime, so Bun's own notice goes
// with them, and with it the words of every license that notice names
const workflow = readFileSync(path.join(root, '.github/workflows/it.yml'), 'utf8')
const bunVersion = /^\s*BUN_VERSION:\s*(\S+)\s*$/m.exec(workflow)?.[1]
if (!bunVersion) throw new Error('.github/workflows/it.yml does not say which Bun the programs are built with')
const runtimeLines = runtimeNotice(path.join(root, 'scripts/notices'), bunVersion)
if (process.argv.includes('--bun')) {
  // The notices describe one build of Bun, which is known by what it reports of itself
  const described = keptFor(path.join(root, 'scripts/notices'), bunVersion).sources.bun.reports
  const reported = execFileSync('bun', ['--revision'], { encoding: 'utf8' }).trim()
  if (reported !== described) throw new Error(`the notices describe the Bun that reports itself as ${described}, and this Bun reports itself as ${reported}`)
  console.log(`This Bun is the one the notices describe: ${reported}`)
}

// The backend program is Convex's, and is in nothing It gives out: the `it` program fetches it
// on a machine's first run. Which release, and from where, is read from the source that does
// the fetching, so that what is said here is what is fetched.
const release = /^export const RELEASE = '([^']+)'$/m.exec(readFileSync(path.join(root, 'packages/cli/src/serve/config.ts'), 'utf8'))?.[1]
const releases = /^const RELEASES = '(https:\/\/github\.com\/[^']+)\/releases\/download'$/m.exec(
  readFileSync(path.join(root, 'packages/cli/src/serve/backend.ts'), 'utf8'),
)?.[1]
if (!release || !releases) throw new Error('packages/cli/src/serve does not say which release of the backend program is fetched, or from where')
/**
 * What each release of the backend program says its license is. The program carries a
 * description of its own API, and that description names the license: it is read from the
 * program of a release when the release is taken up, and written here beside the release.
 */
const BACKEND_LICENSE = { 'precompiled-2026-09-28-5c7cb5b': 'LicenseRef-FSL-1.1-Apache-2.0' }
if (!Object.hasOwn(BACKEND_LICENSE, release))
  throw new Error(`It fetches the release ${release} of the backend program: read from that program what license it names, and write it in BACKEND_LICENSE`)

// The site also carries typefaces, which no bundle shows: files in web/public/fonts, served as
// they are. Each is named here with whose it is and what it is under, and every file in that
// folder has to be one of them: a face that was added and not named would be given out with no
// word of whose it is.
const FONTS = [
  {
    name: 'Inter and Inter Display 4.000',
    by: 'The Inter Project Authors (Rasmus Andersson)',
    files: ['display-600', 'display-700', 'display-800', 'text-400', 'text-500', 'text-600', 'text-700'],
    what: 'Latin subsets of seven weights',
    says: 'Copyright 2016 The Inter Project Authors',
    license: 'SIL Open Font License 1.1',
    source: 'https://github.com/rsms/inter',
    kept: 'inter-OFL.txt',
  },
  {
    name: 'Noto Sans Symbols 2 2.003',
    by: 'The Noto Project Authors',
    files: ['chess'],
    what: 'the twelve chess pieces, and nothing else of it',
    says: 'Copyright 2017 Google Inc. All Rights Reserved.',
    license: 'SIL Open Font License 1.1',
    source: 'https://github.com/notofonts/symbols',
    kept: 'noto-sans-symbols-2-OFL.txt',
  },
  {
    name: 'Arimo Bold 1.33',
    by: 'Steve Matteson, for Google',
    files: ['mark'],
    what: 'five glyphs, and nothing else of it',
    says: 'Copyright 2010 Google Inc. All Rights Reserved.',
    license: 'Apache License 2.0',
    source: 'https://fonts.google.com/specimen/Arimo',
    kept: 'apache-2.0.txt',
  },
]
const served = readdirSync(path.join(root, 'web/public/fonts'))
  .filter((file) => file.endsWith('.woff2'))
  .map((file) => file.slice(0, -'.woff2'.length))
  .sort()
const named = FONTS.flatMap((f) => f.files).sort()
if (served.join() !== named.join())
  throw new Error(
    `web/public/fonts holds ${served.join(', ')}, and scripts/notices.mjs names ${named.join(', ')}: every typeface the site serves is named there, with its license`,
  )
const fontLines = [
  '## Typefaces the site carries',
  '',
  'The pictures on the first screen of the site are drawn in typefaces that the site serves from `/fonts/`, as files converted to WOFF2. Each remains under its own license, which is given here in full.',
  '',
  ...FONTS.flatMap((f) => [
    `### ${f.name}`,
    '',
    `By ${f.by}. License: ${f.license}. Served as: ${f.files.map((name) => `\`${name}.woff2\``).join(', ')}, which hold ${f.what}. The files themselves say: "${f.says}" Source: <${f.source}>.`,
    '',
    fence(
      readFileSync(path.join(root, 'scripts/notices/fonts', f.kept), 'utf8')
        .replace(/\r\n/g, '\n')
        .trimEnd(),
    ),
    '',
  ]),
]

const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const lines = [
  '# Third-party notices',
  '',
  'It includes the work of other people. This file names every package whose code is built into something It gives out or serves to a browser, with the license each is under. Each of them remains under its own license, as `LICENSE.md` says.',
  '',
  'This file is written by `scripts/notices.mjs`, which builds each part and lists the packages that put code into it. Do not edit it by hand: run `npm run notices` after changing what a part depends on. The add-ons in `addons/` include no package at all, which the same script checks.',
  '',
  'The standalone programs also hold the Bun runtime, which no build of a part shows. What Bun says it links and embeds is given below as Bun states it, with the words of every license that statement names, and after them the words for what Bun builds in and its statement does not name. Those are kept in `scripts/notices/`, and the script refuses to write this file where one of them is missing.',
  '',
  '## What is in each part',
  '',
  'The `it` program is what a person is given. The service that shows pages is part of it. It carries the other three parts inside it as they were built: it loads the functions into the backend, it serves the site, and it puts the script first in every page it shows. So a copy of the program holds every package in this table.',
  '',
  '| Part | Packages built into it |',
  '|---|---|',
  ...perPart.map(([part, names]) => `| ${part} | ${names.length ? names.map((n) => `\`${n}\``).join(', ') : 'None'} |`),
  '',
  ...runtimeLines,
  '## The backend program, which is fetched and not included',
  '',
  `It runs Convex's backend program, \`convex-local-backend\`, on the person's own machine. That program is in nothing It gives out. The \`it\` program fetches it the first time It is set up on a machine, from the release \`${release}\` at <${releases}/releases>, or from a mirror of those releases where the person names one with \`IT_BACKEND_RELEASES\`, and keeps what it fetched only if it matches a SHA-256 checksum written in It's own source.`,
  '',
  `The program is Convex's work and stays under Convex's terms. In the description of its own API, which it carries, it names its license as \`${BACKEND_LICENSE[release]}\`. The terms themselves are in its repository, <${releases}>.`,
  '',
  ...fontLines,
  '## Packages',
  '',
]
for (const p of sorted) {
  lines.push(`### ${p.name} ${p.version}`, '')
  lines.push(
    `License: ${p.license}. Built into: ${p.parts.map((x) => x[0].toLowerCase() + x.slice(1)).join('; ')}.${p.homepage ? ` Source: <${p.homepage}>.` : ''}`,
    '',
  )
  const found = texts(p.dir)
  if (!found.length) {
    // Its license is then kept here, by name and version, from the place its `package.json` names as its source
    const kept = path.join(root, 'scripts/notices', `${p.name.replace('/', '__')}-${p.version}.txt`)
    if (existsSync(kept))
      lines.push(
        'This package ships no license file of its own. The license its `package.json` names is this one, from the source named above:',
        '',
        fence(readFileSync(kept, 'utf8').replace(/\r\n/g, '\n').trimEnd()),
        '',
      )
    else {
      // Nor is one kept here. A file of the package that is built in may open with a comment that says whose it is and under what license
      const said = [...p.files.values()]
        .flat()
        .map((file) => headerOf(path.resolve(root, file), true))
        .find((header) => /copyright|licen[cs]e/i.test(header))
      if (said) lines.push('This package ships no license file of its own. The file of it that is built in opens with this notice:', '', fence(said), '')
      else lines.push('This package ships no license file of its own. The license above is the one its `package.json` names.', '')
    }
  }
  for (const [name, text] of found) lines.push(`\`${name}\`:`, '', fence(text), '')
  // The work of others that this package carries inside its own files, by the parts it reaches
  const inside = new Map()
  for (const [part, files] of p.files)
    for (const c of carriedIn(p, files)) {
      const key = `${c.name}@${c.version ?? ''}`
      if (!inside.has(key)) inside.set(key, { ...c, parts: [] })
      inside.get(key).parts.push(part)
    }
  for (const c of [...inside.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`#### Carried inside ${p.name}: ${c.name}${c.version ? ` ${c.version}` : ''}`, '')
    lines.push(`License: ${c.license}. Built into: ${c.parts.map((x) => x[0].toLowerCase() + x.slice(1)).join('; ')}. Source: <${c.source}>.`, '')
    lines.push(fence(c.text), '')
  }
}
const body = `${lines.join('\n').trimEnd()}\n`

if (process.argv.includes('--check')) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== body) {
    console.error('THIRD_PARTY_NOTICES.md is not what the bundles say it should be. Run: npm run notices')
    process.exit(1)
  }
  console.log(`THIRD_PARTY_NOTICES.md is current: ${sorted.length} packages`)
} else {
  writeFileSync(OUT, body)
  console.log(`wrote THIRD_PARTY_NOTICES.md: ${sorted.length} packages`)
  for (const [part, names] of perPart) console.log(`  ${part}: ${names.join(', ') || 'none'}`)
}
