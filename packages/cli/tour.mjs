// Packs the tour into the CLI: the guide an agent follows, and the pages it shows as it goes.
// The pages are whole pages, written here and not by the agent, so that the first things a new
// person sees are the same for everyone.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const from = path.join(here, 'tour')
const guide = readFileSync(path.join(from, 'TOUR.md'), 'utf8')
const said = JSON.parse(readFileSync(path.join(from, 'pages.json'), 'utf8'))
const pages = {}
for (const [name, page] of Object.entries(said)) pages[name] = { ...page, html: readFileSync(path.join(from, 'pages', `${name}.html`), 'utf8') }
writeFileSync(
  path.join(here, 'src/tour.generated.ts'),
  `// Written by packages/cli/tour.mjs. Do not edit.\nexport const GUIDE: string = ${JSON.stringify(guide)}\nexport const PAGES: Record<string, { title: string; params: Record<string, unknown>; state: Record<string, unknown>; html: string }> = ${JSON.stringify(pages, null, 1)}\n`,
)
console.log(`tour: ${Object.keys(pages).length} pages`)
