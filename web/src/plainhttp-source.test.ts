// What the site may call where a browser does not count it as secure, checked in its source.
// plainhttp.test.ts holds the flows it names to plain http. This holds every other file to the
// same: a call a browser offers only to a secure site fails here, wherever it was added, unless
// the file is one that checks for it first.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Each call, and the files that may make it because they check that it is there. */
const SECURE_ONLY: { call: RegExp; name: string; checkedIn: string[] }[] = [
  { call: /\brandomUUID\b/, name: 'crypto.randomUUID', checkedIn: [] },
  { call: /\.subtle\b/, name: 'crypto.subtle', checkedIn: [] },
  { call: /\bnavigator\.locks\b/, name: 'navigator.locks', checkedIn: [] },
  { call: /\bnavigator\.storage\b/, name: 'navigator.storage', checkedIn: [] },
  { call: /\bnavigator\.credentials\b/, name: 'navigator.credentials', checkedIn: [] },
  { call: /\bserviceWorker\b/, name: 'navigator.serviceWorker', checkedIn: ['push.ts'] },
  { call: /\bPushManager\b/, name: 'PushManager', checkedIn: ['push.ts'] },
  { call: /\bnavigator\.clipboard\b/, name: 'navigator.clipboard', checkedIn: ['brand.tsx'] },
  { call: /\bmediaDevices\b/, name: 'navigator.mediaDevices', checkedIn: ['media.ts'] },
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(at)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [at] : []
  })
}

/**
 * The code alone, line for line: a comment that says not to use a call is not a use of it. What
 * is a comment is found as TypeScript finds it, so that `//` in a string, a template or what a
 * component shows, as in an address put together from its parts, is not taken for one. A
 * comment is made blank and keeps its lines, so that each line is counted as it is in the file.
 */
function code(text: string, tsx = false): string {
  const file = ts.createSourceFile('source', text, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const comments: { pos: number; end: number }[] = []
  // What lies before a token and is not part of it, as the parser has it, is space and comments alone
  const visit = (node: ts.Node): void => {
    if (ts.isJSDoc(node)) return
    const children = node.getChildren(file)
    if (children.length > 0) children.forEach(visit)
    else
      for (const { pos, end } of ts.getLeadingCommentRanges(text.slice(node.pos, node.getStart(file)), 0) ?? [])
        comments.push({ pos: node.pos + pos, end: node.pos + end })
  }
  visit(file)
  let kept = ''
  let at = 0
  for (const { pos, end } of comments) {
    kept += text.slice(at, pos) + text.slice(pos, end).replace(/[^\n]/g, ' ')
    at = end
  }
  return kept + text.slice(at)
}

test('no file of the site calls what a browser offers only to a secure site, except one that checks for it first', () => {
  const found: string[] = []
  for (const file of sources(here)) {
    const name = path.relative(here, file).split(path.sep).join('/')
    const lines = code(readFileSync(file, 'utf8'), file.endsWith('.tsx')).split('\n')
    for (const { call, name: what, checkedIn } of SECURE_ONLY) {
      if (checkedIn.includes(name)) continue
      lines.forEach((line, i) => {
        if (call.test(line)) found.push(`${name}:${i + 1} uses ${what}`)
      })
    }
  }
  expect(found).toEqual([])
})

test('the check finds such a call wherever it is in the code, on the line it is on, and not in a comment', () => {
  /** The lines of a file that make such a call, counted from 1. */
  const calling = (text: string, tsx = false) =>
    code(text, tsx)
      .split('\n')
      .flatMap((line, i) => (SECURE_ONLY.some(({ call }) => call.test(line)) ? [i + 1] : []))
  expect(calling('const tab = crypto.randomUUID() // a comment')).toEqual([1])
  expect(calling('// Not `randomUUID`, which a browser offers only to a secure site')).toEqual([])
  expect(calling('/** Not `randomUUID`. */\nconst tab = 1 /* nor crypto.subtle */')).toEqual([])
  // After an address put together in a template, and after one in a string
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a template as a file has it
  expect(calling('const at = `${location.protocol}//${location.hostname}/${crypto.randomUUID()}`')).toEqual([1])
  expect(calling("const at = 'http://' + crypto.randomUUID()")).toEqual([1])
  // After a pattern that has what would begin a comment in it
  expect(calling('const slashes = /a\\/*b/.test(s) && crypto.randomUUID()')).toEqual([1])
  // Counted on its own line after a comment of many lines
  expect(calling('/*\n * one\n * two\n */\nconst tab = crypto.randomUUID()')).toEqual([5])
  // In what a component shows
  expect(calling('const P = () => <p>// {crypto.randomUUID()}</p>', true)).toEqual([1])
})
