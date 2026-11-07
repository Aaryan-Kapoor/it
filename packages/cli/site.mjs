// Packs the built site into the CLI, so that the program serves it with nothing to fetch. It
// reads web/dist, which `npm run build -w web` writes, and writes a table of every file in it:
// its path, its type and its bytes. `--from=<folder>` and `--to=<file>` name another folder to
// read and another file to write.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const given = (name) => process.argv.find((word) => word.startsWith(`--${name}=`))?.slice(name.length + 3)
const from = path.resolve(given('from') ?? path.join(here, '../../web/dist'))
const to = path.resolve(given('to') ?? path.join(here, 'src/site.generated.ts'))

// What a browser is told each kind of file is. The license, the notices and the install scripts
// are sent as plain text, so that a browser shows them and does not offer to save them.
const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  sh: 'text/plain; charset=utf-8',
  ps1: 'text/plain; charset=utf-8',
}
const typeOf = (file) => TYPES[file.split('.').pop().toLowerCase()] ?? 'application/octet-stream'

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, base, out)
    // A source map is for whoever works on the site. It is several times the size of the script
    // it describes, and every command would carry it.
    else if (!name.endsWith('.map')) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

const built = existsSync(path.join(from, 'index.html'))
const site = {}
let size = 0
for (const file of built ? walk(from) : []) {
  const bytes = readFileSync(path.join(from, file))
  size += bytes.length
  site[file] = { type: typeOf(file), bytes: bytes.toString('base64') }
}
writeFileSync(
  to,
  `// Written by packages/cli/site.mjs. Do not edit.\n// Each file of the site by its path: its type, and its bytes in base64.\nexport const SITE: Record<string, { type: string; bytes: string }> = ${JSON.stringify(site, null, 1)}\n`,
)
console.log(
  built
    ? `site: ${Object.keys(site).length} files, ${Math.ceil(size / 1024)} KB`
    : 'site: none. The site has not been built (`npm run build -w web`), so what is built now carries no site.',
)
