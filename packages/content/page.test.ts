// Putting It first in a page, held to what a browser does with the result. Each page here is
// passed through the scanner, and what comes out is run: by a parser that follows the HTML
// standard, and, where they are installed, by Chromium and Firefox themselves, which are given
// the bytes as the content service sends them. What is asserted is what matters to a page: It
// ran, once, before anything of the page's own, and the page's own scripts ran as they would
// have without It.
import { existsSync } from 'node:fs'
import { JSDOM, VirtualConsole } from 'jsdom'
import { type Browser, type BrowserType, chromium, firefox } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { withTags } from './src/page'

/** What stands for It, and for a script of the page's own: each writes down that it ran. */
const IT = '<script>(window.order = window.order || []).push("it")</script>'
const OWN = '<script>(window.order = window.order || []).push("page")</script>'
const TAGS = new TextEncoder().encode(IT)

/** A page as bytes, cut into pieces of a size, as a file is read. */
function pieces(page: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= page.length) return controller.close()
      controller.enqueue(page.subarray(at, at + size))
      at += size
    },
  })
}
const bytesOf = (page: string | Uint8Array) => (typeof page === 'string' ? Buffer.from(page) : Buffer.from(page))
/** The page with It put in it, however the page is cut into pieces. */
const placed = async (page: string | Uint8Array, size = 64 * 1024) => Buffer.from(await new Response(withTags(pieces(bytesOf(page), size), TAGS)).arrayBuffer())

const utf16 = (text: string, big = false) => {
  const body = Buffer.from(text, 'utf16le')
  if (big) body.swap16()
  return Buffer.concat([Buffer.from(big ? [0xfe, 0xff] : [0xff, 0xfe]), body])
}

// Pages that begin, or end, in every way a page can that is not simply an element. Where a page
// is given with a script before and after something, the question is which of them a browser
// runs, and whether It ran before the first that does.
const PAGES: Record<string, string | Buffer> = {
  'begins with a doctype and <html>': `<!doctype html><html lang="en"><head>${OWN}</head><body>${OWN}</body></html>`,
  'begins with <head>': `<HEAD >${OWN}<title>t</title></HEAD>${OWN}`,
  'begins with a script': `${OWN}<p>words</p>${OWN}`,
  'begins with words, then <html>': `words <html lang="en">${OWN}`,
  'has <html> and then a <head> with attributes': `<html><head data-x="1">${OWN}</head></html>`,
  'has ">" in the attributes of <html>': `<html a=">" b='>' c=d/e>f>${OWN}`,
  'has a quote in an attribute’s name': `<div a"b='>${OWN}'>${OWN}`,
  'has a quote where an attribute would begin': `<div "a">${OWN}">${OWN}`,
  'has a closing tag whose name holds a quote': `</a=b='>${OWN}'>${OWN}`,
  'has a closing tag whose name holds two quotes': `</a"b">${OWN}`,
  'has a closing tag with ">" in a quoted attribute': `</p class=">${OWN}">${OWN}`,
  'has a closing tag with a quote after its name': `</p ">${OWN}">${OWN}`,
  'has a closing tag with nothing in it': `</>${OWN}`,
  'has a closing tag that is no tag': `</ x='>${OWN}'>${OWN}`,
  'begins with closing tags that move a browser on': `</head></body></html></br></p>${OWN}`,
  'has a comment that ends at once': `<!-->${OWN}-->${OWN}`,
  'has a comment that ends after one dash': `<!--->${OWN}-->${OWN}`,
  'has a comment that "!>" does not end': `<!--!>${OWN}-->${OWN}`,
  'has a comment that "-!>" does not end': `<!---!>${OWN}-->${OWN}`,
  'has a comment that "--!>" ends': `<!----!>${OWN}-->${OWN}`,
  'has a comment that ends with "--!>"': `<!-- a --!>${OWN}-->${OWN}`,
  'has a comment with a comment begun in it': `<!-- <!-- -->${OWN}-->${OWN}`,
  'has a comment with many dashes': `<!------ a ------>${OWN}`,
  'has a doctype with ">" in quotes': `<!DOCTYPE html SYSTEM "a>${OWN}">${OWN}`,
  'has a processing instruction': `<?xml version="1.0" a=">${OWN}"?>${OWN}`,
  'has a declaration that is none': `<!ELEMENT x ">${OWN}">${OWN}`,
  'has a stray "<"': `a < b << c <1 <${OWN}`,
  'has bytes that are no letters': Buffer.concat([Buffer.from([0x00, 0xff, 0xc3, 0x3c, 0x00]), Buffer.from(`html>${OWN}<html>${OWN}`)]),
  'is UTF-8 with its mark': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`<html><head>${OWN}</head>é</html>`)]),
  'is UTF-16 with its mark, little end first': utf16(`<html><head>${OWN}</head><body>é ✓ 😀</body></html>`),
  'is UTF-16 with its mark, big end first': utf16(`<html><head>${OWN}</head><body>é ✓ 😀</body></html>`, true),
  'is UTF-16 and begins with a script': utf16(`${OWN}words`),
  'is UTF-16 and ends in half a letter': Buffer.concat([utf16(`<p>${OWN}`), Buffer.from([0x41])]),
  'is UTF-16 and ends inside a comment': utf16(`${OWN}<!-- unfinished`, true),
  'is UTF-16 with no element in it': utf16('only words'),
  'is only the mark of UTF-16': Buffer.from([0xff, 0xfe]),
  'has no element in it': 'only words, and <!-- a comment -->',
  'is empty': '',
  'ends inside a comment': `${OWN}<!-- unfinished ${OWN}`,
  'is only a comment that is never finished': `<!-- unfinished ${OWN}`,
  'ends inside a comment that had begun to end, by one dash': `<!-- unfinished ${OWN} -`,
  'ends inside a comment that had begun to end, by two': `<!-- unfinished ${OWN} --`,
  'ends inside a comment that had begun to end with "--!"': `<!-- unfinished ${OWN} --!`,
  'ends as a comment begins': '<!--',
  'ends a dash after a comment begins': '<!---',
  'ends inside a doctype': '<!doctype html',
  'ends inside a doctype’s quotes': `<!DOCTYPE html PUBLIC "${OWN}`,
  'ends after "<!"': 'words <!',
  'ends after "<!-"': 'words <!-',
  'ends inside a processing instruction': `<?x ${OWN}`,
  'ends inside what "</" and a space begin': `</ x ${OWN}`,
  'ends inside the tag of <html>, in quotes': `<html title="unfinished ${OWN}`,
  'ends inside the tag of another element, in quotes': `${OWN}<section data-x='unfinished ${OWN}`,
  'ends inside a tag, before a value': `words <html lang=`,
  'ends inside a tag’s name': `words <section`,
  'ends inside a closing tag': `</section class="${OWN}`,
  'ends inside a closing tag’s name': '</sec',
  'ends with "<"': 'words <',
  'ends with "</"': 'words </',
  'begins with a tag far longer than a tag is': `<html data-x="${'a>'.repeat(100_000)}">${OWN}</html>`,
  'ends inside a tag far longer than a tag is': `${OWN}<p data-x="${'a>'.repeat(100_000)}`,
  'has its first tag across the end of a piece': `<!--${'-'.repeat(65_536 - 16)}--><html data-across="${'a>'.repeat(40)}">${OWN}</html>`,
  'has its first element a quarter of a megabyte in': `${'words '.repeat(40_000)}${OWN}`,
  'begins with <plaintext>': `<plaintext>${OWN}`,
  'begins with <title>': `<title>${OWN}</title>${OWN}`,
  'begins with <textarea>': `<textarea>${OWN}</textarea>${OWN}`,
  'begins with <style>': `<style>${OWN}</style>${OWN}`,
  'begins with <template>': `<template>${OWN}</template>${OWN}`,
  'begins with <noscript>': `<noscript>${OWN}</noscript>${OWN}`,
  'begins with <svg>': `<svg><title>${OWN}</title></svg>${OWN}`,
  'begins with <base>': `<base href="http://elsewhere.invalid/x/">${OWN}`,
  'begins with <body>': `<body onload="(window.order = window.order || []).push('loaded')">${OWN}`,
}

// Pages made of pieces put together by chance, the same each time: what may come before an
// element, what an element may be, and how a page may end without finishing what it began.
const BEFORE = [
  '<!doctype html>',
  '<!DOCTYPE html PUBLIC "a>b">',
  '<!-- c -->',
  '<!-->',
  '<!--->',
  '<!---->',
  '<!--a--!>',
  '<!--!>-->',
  '<!-- <!-- -->',
  '<!x>',
  '<?pi "a>b"?>',
  '</>',
  '</ x>',
  "</a=b='>",
  '</a "x">',
  "</p class='>'>",
  '</br>',
  '</body>',
  '</html>',
  '</head>',
  'words',
  ' ',
  '\n',
  '<',
  '< ',
  '<<',
  '<1',
  '&lt;',
  '\0',
  '"',
  "'",
  '>',
  '-->',
]
const ELEMENTS = [
  OWN,
  OWN,
  OWN,
  '<html>',
  '<html lang="en">',
  `<html a='>' b=">">`,
  '<head>',
  '<HEAD >',
  '<body>',
  '<p>',
  '<title>t</title>',
  '<main a=b/c>',
  '<div "a">',
  '<div =a>',
  '<a/b>',
  '<html/>',
  '<img/>',
  '<textarea>',
  '<template>',
  '</template>',
]
const ENDINGS = [
  '',
  '',
  '',
  '<!-- x',
  '<!-- x -',
  '<!-- x --',
  '<!-- x --!',
  '<!',
  '<!-',
  '<!doc',
  '<!DOCTYPE html "x',
  '<?x',
  '</',
  '</x',
  '</x a="',
  '<',
  '<x',
  '<html',
  '<html a',
  '<html a=',
  '<html a="x',
  "<script a='",
  '<script',
]
function byChance(count: number): string[] {
  let seed = 20261004
  const next = (below: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
    // The high bits, which are the ones that change by chance
    return (seed >>> 16) % below
  }
  const one = (from: string[]) => from[next(from.length)]!
  return Array.from({ length: count }, () => {
    let page = ''
    for (let n = next(4); n > 0; n--) page += one(BEFORE)
    // Half of them have a script of their own as their first element
    if (next(2)) page += OWN
    for (let n = next(5); n > 0; n--) page += next(3) ? one(ELEMENTS) : one(BEFORE)
    return page + one(ENDINGS)
  })
}

/** What ran, in order, when a parser that follows the standard reads a page as the content service sends it. */
function parsed(page: Buffer): string[] {
  const dom = new JSDOM(page, { contentType: 'text/html; charset=utf-8', runScripts: 'dangerously', virtualConsole: new VirtualConsole() })
  const order = [...((dom.window as unknown as { order?: string[] }).order ?? [])]
  dom.window.close()
  return order
}
/** It ran, once, first; and the page's own scripts ran as they do without It. */
function expectFirst(name: string, without: string[], withIt: string[]): void {
  expect([name, withIt[0], withIt.filter((ran) => ran === 'it').length]).toEqual([name, 'it', 1])
  expect([name, withIt.slice(1)]).toEqual([name, without])
}

describe('where It is put', () => {
  test('a page comes out the same however it is cut into pieces', async () => {
    for (const [name, page] of Object.entries(PAGES)) {
      const whole = await placed(page)
      const sizes = bytesOf(page).length > 4000 ? [1000, 4096, 65_535, 65_537] : [1, 2, 3, 7, 64]
      for (const size of sizes) expect([name, size, (await placed(page, size)).equals(whole)]).toEqual([name, size, true])
    }
  })

  test('nothing of a page is lost or changed, but what a browser would take as finished at its end', async () => {
    const without = (out: Buffer) => out.toString().replace(IT, '')
    for (const [name, page] of Object.entries(PAGES)) {
      if (typeof page !== 'string') continue
      const out = without(await placed(page))
      // The few characters that finish a comment or a doctype the page left unfinished
      expect([name, out.startsWith(page), out.slice(page.length)]).toEqual([name, true, expect.stringMatching(/^(-->|->|>)?$/)])
    }
    // A page in UTF-16 comes out as the same page in UTF-8, without its mark
    expect((await placed(utf16('<html><p>é ✓ 😀</p></html>'))).toString()).toBe(`<html>${IT}<p>é ✓ 😀</p></html>`)
    expect((await placed(utf16('<html><p>é ✓ 😀</p></html>', true), 3)).toString()).toBe(`<html>${IT}<p>é ✓ 😀</p></html>`)
    // And a page that only looks like one is left as it is
    const unmarked = Buffer.from('<p>plain</p>', 'utf16le')
    expect((await placed(unmarked)).equals(Buffer.concat([unmarked, TAGS]))).toBe(true)
  })

  test('where the bytes go: inside <html> or <head>, before any other first element, and at the end of a page with none', async () => {
    const at = async (page: string) => (await placed(page)).toString().replace(IT, '@')
    expect(await at('<!DOCTYPE html>\n<!-- a <b>comment</b> --><html lang="en"><head></head></html>')).toBe(
      '<!DOCTYPE html>\n<!-- a <b>comment</b> --><html lang="en">@<head></head></html>',
    )
    expect(await at('<!---><!----><!--a--!><HEAD ><title>t</title></HEAD>')).toBe('<!---><!----><!--a--!><HEAD >@<title>t</title></HEAD>')
    expect(await at('<html/><p>x</p>')).toBe('<html/>@<p>x</p>')
    expect(await at('</p>< 1 <? pi ?><!x>text <main id="m"></main>')).toBe('</p>< 1 <? pi ?><!x>text @<main id="m"></main>')
    expect(await at('<htmlx><head></head></htmlx>')).toBe('@<htmlx><head></head></htmlx>')
    expect(await at('only words')).toBe('only words@')
    expect(await at('<!-- never closed <html>')).toBe('<!-- never closed <html>-->@')
    expect(await at('words <html lang="en')).toBe('words @<html lang="en')
    expect(await at('words <section')).toBe('words @<section')
  })
})

describe('how much of a page is held back', () => {
  test('a tag that does not end is not waited for past so much of it: It goes before it, and the page goes on being passed on as it comes', async () => {
    let feed!: ReadableStreamDefaultController<Uint8Array>
    const page = new ReadableStream<Uint8Array>({
      start(controller) {
        feed = controller
      },
    })
    // Whatever comes out is kept as it comes, for as long as the page goes on
    const out: Buffer[] = []
    let ended = false
    const reader = withTags(page, TAGS).getReader()
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        out.push(Buffer.from(value))
      }
      ended = true
    })()
    const passed = () => Buffer.concat(out)
    /** Waits until so many bytes have come out, which they do at once when nothing holds them back. */
    const until = async (bytes: number) => {
      for (const end = Date.now() + 5000; passed().length < bytes && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5))
    }
    // A tag that opens and then goes on: an attribute that is never closed, a piece at a time
    feed.enqueue(Buffer.from('words <div data-long="'))
    const piece = Buffer.alloc(16 * 1024, 'a')
    for (let n = 0; n < 3; n++) feed.enqueue(piece)
    // Up to there, what came before the tag has been passed on, and the tag is held back
    await until(6)
    await new Promise((r) => setTimeout(r, 150))
    expect(passed().toString()).toBe('words ')
    // Past sixty-four thousand bytes of it, It is put before the tag, and everything held is passed on
    for (let n = 0; n < 2; n++) feed.enqueue(piece)
    const whole = 6 + TAGS.length + 16 + 5 * piece.length
    await until(whole)
    expect(
      passed()
        .subarray(0, 6 + TAGS.length + 16)
        .toString(),
    ).toBe(`words ${IT}<div data-long="`)
    expect(passed().length).toBe(whole)
    // And from then on each piece goes straight through, the page still not having ended
    feed.enqueue(piece)
    await until(whole + piece.length)
    expect([passed().length, ended]).toEqual([whole + piece.length, false])
    feed.close()
    await reading
    expect(passed().length).toBe(whole + piece.length)
  })
})

// The parser runs a page's scripts with a part of Node that Bun does not have in full, so under
// Bun the pages are only put through the scanner, above, which is the part that is It's.
if ('Bun' in globalThis)
  console.log(
    '  skip  the tests of what a parser that follows the standard makes of a page: under Bun the parser cannot run a page’s scripts as it does under Node',
  )
describe.skipIf('Bun' in globalThis)('what a parser that follows the standard makes of it', () => {
  test('in every page It runs once, before anything of the page’s, and the page’s scripts run as they do without It', async () => {
    for (const [name, page] of Object.entries(PAGES)) expectFirst(name, parsed(bytesOf(page)), parsed(await placed(page)))
  })

  test('and in five hundred pages put together by chance, most of which run a script of their own', async () => {
    let ranTheirOwn = 0
    for (const page of byChance(500)) {
      const without = parsed(bytesOf(page))
      if (without.includes('page')) ranTheirOwn += 1
      expectFirst(JSON.stringify(page), without, parsed(await placed(page, 5)))
    }
    // The question asked of each page is a real one
    expect(ranTheirOwn).toBeGreaterThan(250)
    expect(Object.values(PAGES).filter((page) => parsed(bytesOf(page)).includes('page')).length).toBeGreaterThan(40)
  }, 120_000)
})

// The same, in the browsers themselves. They are run where Playwright has them installed, and
// under Node, which is what Playwright runs under.
const here = (type: BrowserType) => {
  try {
    return !('Bun' in globalThis) && existsSync(type.executablePath())
  } catch {
    return false
  }
}
const BROWSERS = [
  ['Chromium', chromium],
  ['Firefox', firefox],
] as const
for (const [name, type] of BROWSERS) {
  const why = 'Bun' in globalThis ? 'Playwright, which runs the browser, does not run under Bun' : `Playwright has no ${name} installed on this machine`
  if (!here(type)) console.log(`  skip  the tests of what ${name} makes of a page: ${why}`)
}
describe.each(BROWSERS)('what %s makes of it', (_name, type) => {
  let browser: Browser
  /** What ran, in order, when the browser is sent these bytes as the content service sends them. */
  let ran: (page: Buffer) => Promise<string[]>
  // A browser is slow to start on a machine that is busy, and slow to load its first page: it
  // is given minutes for the one, before any case begins, and each page it is sent as long
  beforeAll(async () => {
    if (!here(type)) return
    browser = await type.launch({ timeout: 0 })
    const tab = await (await browser.newContext()).newPage()
    tab.setDefaultNavigationTimeout(120_000)
    let sent = Buffer.alloc(0)
    await tab.route('**/*', (route) =>
      new URL(route.request().url()).pathname === '/page'
        ? route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' }, body: sent })
        : route.fulfill({ status: 404, body: '' }),
    )
    ran = async (page) => {
      sent = page
      await tab.goto('http://page.invalid/page', { waitUntil: 'load' })
      return tab.evaluate(() => [...((window as unknown as { order?: string[] }).order ?? [])])
    }
  }, 300_000)
  afterAll(() => browser?.close())

  // Both are left out where the browser is not there to run them: see `here`, and the line written above when it is not
  test.skipIf(!here(type))(
    'in every page It runs once, before anything of the page’s, and the page’s scripts run as they do without It',
    async () => {
      for (const [name, page] of Object.entries(PAGES)) expectFirst(name, await ran(bytesOf(page)), await ran(await placed(page)))
    },
    120_000,
  )

  test.skipIf(!here(type))(
    'and in two hundred pages put together by chance',
    async () => {
      for (const page of byChance(200)) expectFirst(JSON.stringify(page), await ran(bytesOf(page)), await ran(await placed(page, 5)))
    },
    240_000,
  )
})
