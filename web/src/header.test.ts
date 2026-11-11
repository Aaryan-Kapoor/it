// What the bar over the site shows on a phone-sized screen, checked in the stylesheet: the rest of
// how things stand has no room there, but that It cannot be reached is shown, as it is on a desktop.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const sheet = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8')

/** The rules of the narrowest layout of the bar, where its parts are laid out on a grid of their own. */
function narrowest(): string {
  const blocks = sheet.split('@media (max-width: 520px) {').slice(1)
  const bar = blocks.find((b) => b.slice(0, b.indexOf('\n}\n')).includes('  .grid-header {'))
  if (!bar) throw new Error('the bar has no layout of its own on the narrowest screens')
  return bar.slice(0, bar.indexOf('\n}\n'))
}
/** What one rule of that layout says, or nothing where it has no such rule. */
function rule(selector: string): string | null {
  const block = narrowest()
  const at = block.indexOf(`\n  ${selector} {`)
  return at === -1 ? null : block.slice(at, block.indexOf('}', at))
}

describe('the bar on a phone-sized screen', () => {
  test('keeps the line that says how things stand, beside the name, where the desktop has it on its one row', () => {
    const meta = rule('.grid-meta')
    expect(meta).not.toBeNull()
    expect(meta).not.toContain('display: none')
    expect(meta).toContain('grid-row: 1;')
  })

  test('shows it only while It cannot be reached, which is when the line says offline', () => {
    expect(rule('.grid-meta.online')).toContain('display: none;')
    // The word itself is the desktop's, from the rules every width shares
    expect(sheet).toMatch(/\n\.grid-meta-live::after \{\n {2}content: "offline";/)
  })
})
