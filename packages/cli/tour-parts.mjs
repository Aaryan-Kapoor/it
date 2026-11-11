// Puts the tour's first page together from its shell and its parts, for packages/cli/tour.mjs.
// It is apart from that file so that a test can give it parts that are wrong and see it refuse.
/**
 * One part of the first page, as its file has it: its styles, its section and its script. The
 * file holds at most one <style>, exactly one section that names the part, and exactly one
 * <script> that hands the part to the shell under the same name, and nothing else but comments.
 */
export function partOf(name, read) {
  const file = `tour/parts/${name}.html`
  if (typeof name !== 'string' || !/^[a-z][a-z0-9]*$/.test(name))
    throw new Error(`${JSON.stringify(name)} is no name for a part of the tour's first page: a name is small letters and digits`)
  let text
  try {
    text = read(name)
  } catch {
    throw new Error(`pages.json names the part "${name}", and ${file} is not there`)
  }
  const one = (tag, most) => {
    const found = [...text.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'))]
    if (found.length > 1 || (found.length < 1 && !most))
      throw new Error(`${file} holds ${found.length} <${tag}> elements, and a part has ${most ? 'at most' : 'exactly'} one`)
    return found[0]?.[0] ?? ''
  }
  const style = one('style', true)
  const script = one('script', false)
  const section = one('section', false)
  const open = /^<section\b[^>]*>/.exec(section)[0]
  const attr = (key) => new RegExp(`\\s${key}="([^"]*)"`).exec(open)?.[1]
  if (attr('data-part') !== name) throw new Error(`${file} does not name itself: its section is to begin <section class="part" data-part="${name}" …>`)
  if (!/\sclass="part"/.test(open) || !/\shidden(\s|>)/.test(open))
    throw new Error(`${file}: the section of a part has class="part" and is hidden until the shell shows it`)
  for (const key of ['data-title', 'data-line']) if (!attr(key)) throw new Error(`${file}: the section of a part says its ${key}`)
  // An element is found by its id from anywhere on the page, so each id in a part begins with the part's name
  const stray = [...section.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]).find((id) => !id.startsWith(`${name}-`))
  if (stray !== undefined) throw new Error(`${file} gives an element the id "${stray}": an id in a part begins with the part's name and a hyphen, as "${name}-…"`)
  if (!script.includes(`Shell.part("${name}"`)) throw new Error(`${file} does not hand itself to the shell: its script is to call Shell.part("${name}", …)`)
  const rest = text
    .replace(style, '')
    .replace(script, '')
    .replace(section, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
  if (rest) throw new Error(`${file} holds something outside its style, its section and its script: ${JSON.stringify(rest.slice(0, 60))}`)
  return { style: style.replace(/^<style\b[^>]*>|<\/style>$/g, '').replace(/^\n+|\s+$/g, ''), section, script }
}
/** The first page whole: the shell with each part set in where the shell marks the place for its styles, its section and its script. */
export function assembled(shell, names, read) {
  if (!Array.isArray(names) || !names.length) throw new Error('pages.json gives the first page no parts')
  if (new Set(names).size !== names.length) throw new Error('pages.json names a part of the first page twice')
  const parts = names.map((name) => partOf(name, read))
  const SET = {
    '/*parts.css*/': parts.map((p, i) => `  /* ── ${names[i]} ── */\n${p.style}`).join('\n'),
    '<!--parts.html-->': parts.map((p) => p.section).join('\n\n'),
    '<!--parts.js-->': parts.map((p) => p.script).join('\n'),
  }
  let html = shell
  for (const [mark, text] of Object.entries(SET)) {
    if (html.split(mark).length !== 2)
      throw new Error(`tour/pages/start.html marks the place for ${mark} ${html.split(mark).length - 1} times, and it is marked once`)
    html = html.replace(mark, () => text)
  }
  // An element is found by its id from anywhere on the page, so no two parts may give one the same
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
  const twice = ids.find((id, i) => ids.indexOf(id) !== i)
  if (twice) throw new Error(`the tour's first page has two elements with the id "${twice}": an id in a part begins with the part's name`)
  return html
}
