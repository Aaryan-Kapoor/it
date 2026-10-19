// What the site may call where a browser does not count it as secure, checked in its source.
// plainhttp.test.ts holds the flows it names to plain http. This holds every other file to the
// same: a call a browser offers only to a secure site fails here, wherever it was added, unless
// the file is one that checks for it first.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(at)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [at] : []
  })
}

/** The code alone: a comment that says not to use a call is not a use of it. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

test('no file of the site calls what a browser offers only to a secure site, except one that checks for it first', () => {
  const found: string[] = []
  for (const file of sources(here)) {
    const name = path.relative(here, file).split(path.sep).join('/')
    const lines = code(readFileSync(file, 'utf8')).split('\n')
    for (const { call, name: what, checkedIn } of SECURE_ONLY) {
      if (checkedIn.includes(name)) continue
      lines.forEach((line, i) => {
        if (call.test(line)) found.push(`${name}:${i + 1} uses ${what}`)
      })
    }
  }
  expect(found).toEqual([])
})

test('the check finds such a call', () => {
  expect(SECURE_ONLY.some(({ call }) => call.test(code('const tab = crypto.randomUUID() // a comment')))).toBe(true)
  expect(SECURE_ONLY.some(({ call }) => call.test(code('// Not `randomUUID`, which a browser offers only to a secure site')))).toBe(false)
})
