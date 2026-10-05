// Bundles the in-page script and writes it where the content service can serve it. The service
// puts the script first in every page, pinned by the version in its address.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
// The script is sent to every browser that shows a page, so it says whose it is and under what
// terms in its own first line, which minifying keeps. It says where the terms that came with
// this very copy can be read, and names no address that could later hold other terms
const NOTICE =
  '/*! It. Copyright (c) 2026 Aaryan Kapoor. Source-available under the It License 1.0. This notice stays with the script. The terms are in LICENSE.md: the site that shows this page serves it at /LICENSE.md, and it is in the folder It is installed in. */'
const out = await build({
  entryPoints: [path.join(here, 'src/it.ts')],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  write: false,
  banner: { js: NOTICE },
})
const code = out.outputFiles[0].text
const version = createHash('sha256').update(code).digest('hex').slice(0, 12)
mkdirSync(path.join(here, 'dist'), { recursive: true })
writeFileSync(path.join(here, 'dist/it.js'), code)
writeFileSync(
  path.join(here, '../content/src/runtime.generated.ts'),
  `// Written by packages/runtime/build.mjs. Do not edit.\nexport const RUNTIME_VERSION = ${JSON.stringify(version)}\nexport const RUNTIME = ${JSON.stringify(code)}\n`,
)
console.log(`runtime ${version}, ${code.length} bytes`)
