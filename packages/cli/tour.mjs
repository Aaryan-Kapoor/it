// Packs the tour into the CLI: the guide an agent follows, and the pages it shows as it goes.
// The pages are whole pages, written here and not by the agent, so that the first things a new
// person sees are the same for everyone. What all of them share (their look, the agent's plate,
// the two buttons that go on) is written once, in tour/kit, and set into each page here where
// the page marks the place for it.
//
// The tour's first page is put together here from a shell, tour/pages/start.html, and one file
// for each of its parts, tour/parts/<name>.html, in the order pages.json gives under `parts`.
// tour/parts/README.md says what a part is. A part that is named and not there, or that does
// not name itself, stops the build. The first page carries the typefaces it is set in, from
// tour/fonts, and takes the rules of chess and the fitting of a drawing into an action from the
// chessboard and the whiteboard, so that each is written once.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembled } from './tour-parts.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const from = path.join(here, 'tour')
const guide = readFileSync(path.join(from, 'TOUR.md'), 'utf8')
const said = JSON.parse(readFileSync(path.join(from, 'pages.json'), 'utf8'))
const kit = (name) => readFileSync(path.join(from, 'kit', name), 'utf8').trimEnd()
/** The part of a page from the line that begins with `begin` up to the one that begins with `end`, which is left out unless `through`. */
function lifted(name, begin, end, through) {
  const html = readFileSync(path.join(from, 'pages', `${name}.html`), 'utf8')
  const at = html.indexOf(begin)
  const to = html.indexOf(end, at)
  if (at < 0 || to < 0) throw new Error(`tour/pages/${name}.html no longer has what tour.mjs lifts out of it, from "${begin.trim()}" to "${end.trim()}"`)
  return html.slice(at, through ? to + end.length : to).trimEnd()
}
// Each face is named for its family and weight, as text-400.woff2
const FAMILY = { text: 'Text', display: 'Display', caveat: 'Hand' }
const face = (family, weight, file) =>
  `  @font-face { font-family: ${family}; font-weight: ${weight}; font-display: swap; src: url(data:font/woff2;base64,${readFileSync(file).toString('base64')}) format("woff2"); }`
const fonts = readdirSync(path.join(from, 'fonts'))
  .filter((file) => file.endsWith('.woff2'))
  .sort()
  .map((file) => {
    const [, family, weight] = /^([a-z]+)-(\d+)\.woff2$/.exec(file) ?? []
    if (!Object.hasOwn(FAMILY, family ?? '')) throw new Error(`tour/fonts/${file} is not named for a family the tour knows`)
    return face(FAMILY[family], weight, path.join(from, 'fonts', file))
  })
  .join('\n')
const KIT = {
  '/*kit.css*/': kit('kit.css'),
  '/*kit.js*/': kit('kit.js'),
  '<!--rail-->': kit('rail.html'),
  '/*navigation.js*/': kit('navigation.js'),
  '/*fonts.css*/': fonts,
  '/*chess.engine*/': lifted('chess', '  // ── engine: begin ──', '  // ── engine: end ──', true),
  '/*whiteboard.fitting*/': lifted('whiteboard', '    function snapshot(', '    sendBtn.addEventListener', false),
}
const pages = {}
for (const [name, { parts, ...page }] of Object.entries(said)) {
  let html = readFileSync(path.join(from, 'pages', `${name}.html`), 'utf8')
  if (parts) {
    html = assembled(html, parts, (part) => readFileSync(path.join(from, 'parts', `${part}.html`), 'utf8'))
    // The agent answers each part under the part's own name in the state, which begins empty
    page.state = { ...Object.fromEntries(parts.map((part) => [part, {}])), ...page.state }
  }
  for (const [mark, text] of Object.entries(KIT)) {
    // Each place is marked once in a page that has it. The words are set in as they are: a `$` in them is only a `$`
    if (html.split(mark).length > 2) throw new Error(`tour/pages/${name}.html marks the place for ${mark} more than once`)
    html = html.replace(mark, () => text)
  }
  pages[name] = { ...page, html }
}
writeFileSync(
  path.join(here, 'src/tour.generated.ts'),
  `// Written by packages/cli/tour.mjs. Do not edit.\nexport const GUIDE: string = ${JSON.stringify(guide)}\nexport const PAGES: Record<string, { title: string; params: Record<string, unknown>; state: Record<string, unknown>; html: string }> = ${JSON.stringify(pages, null, 1)}\n`,
)
console.log(`tour: ${Object.keys(pages).length} pages`)
