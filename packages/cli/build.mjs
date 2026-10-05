// Bundles the CLI into one file that Node can run. The standalone program is built from the
// same entry point with `bun build --compile` (see the release workflow).
import { copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
// What the program carries inside it is written first: the add-ons, the site, and the backend functions
await import('./addons.mjs')
await import('./site.mjs')
await import('../../scripts/functions.mjs')
await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(here, 'dist/it.mjs'),
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  loader: { '.md': 'text', '.txt': 'text' },
})
// The bundle has other people's packages built into it, so the terms it comes under and the
// notices of what it includes are put beside it, as they are beside the standalone programs
for (const terms of ['LICENSE.md', 'THIRD_PARTY_NOTICES.md']) copyFileSync(path.join(here, '../..', terms), path.join(here, 'dist', terms))
console.log('built dist/it.mjs')
