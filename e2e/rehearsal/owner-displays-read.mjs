// The owner's own It, read only (by the program's full path): with --keys, only the field names
// of `it displays` and of the Claude Code entry in `it status`; without, the names of the
// displays first seen in the owner-wake window (16 November 00:15-00:45 UTC, the harness's two
// browser profiles) and the hint `it status` gives for an outdated Claude Code add-on. Nothing
// else is printed or kept.
//   node e2e/rehearsal/owner-displays-read.mjs [--keys]
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const exe = path.join(os.homedir(), '.it', 'bin', 'it.exe')
const run = (args) => JSON.parse(execFileSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] }))
const keysOnly = process.argv.includes('--keys')
const ds = run(['displays'])
const list = Array.isArray(ds) ? ds : (ds.displays ?? [])
const st = run(['status', '--json'])
const claude = JSON.stringify(st).includes('claude-code') ? findClaude(st) : null
function findClaude(o) {
  if (!o || typeof o !== 'object') return null
  if (o.id === 'claude-code' || o.harness === 'claude-code' || o.name === 'claude-code') return o
  for (const v of Object.values(o)) { const f = findClaude(v); if (f) return f }
  return null
}
if (keysOnly) {
  console.log(`displays: ${list.length}; fields: ${[...new Set(list.flatMap((d) => Object.keys(d)))].join(', ')}`)
  console.log(`status top fields: ${Object.keys(st).join(', ')}`)
  console.log(`claude-code entry fields: ${claude ? Object.keys(claude).join(', ') : 'none found'}`)
} else {
  // The harness's two browsers were last seen when their runs ended, in that window
  const t = (d) => (typeof d.lastSeenAt === 'number' ? d.lastSeenAt : Date.parse(d.lastSeenAt ?? ''))
  const from = Date.parse('2026-11-16T00:15:00Z'), to = Date.parse('2026-11-16T00:45:00Z')
  for (const d of list.filter((d) => t(d) >= from && t(d) <= to)) console.log(`display: "${d.name ?? '?'}" (named ${d.named}) last seen ${new Date(t(d)).toISOString().slice(11, 19)} UTC`)
  const a = claude?.addon ?? {}
  console.log(`claude-code addon fields: ${typeof a === 'object' ? Object.keys(a).join(', ') : typeof a}`)
  const pick = (o) => (o && typeof o === 'object' ? ['outdated', 'state', 'hint', 'fix', 'next', 'message', 'say'].filter((k) => k in o).map((k) => `${k}: ${JSON.stringify(o[k])}`).join(' | ') : String(o))
  console.log(`claude-code addon: ${pick(a)}`)
  // Anywhere in the Claude Code entry: a field about being out of date, and its hint
  const walk = (o, p) => {
    if (!o || typeof o !== 'object') return
    for (const [k, v] of Object.entries(o)) {
      if (/outdated|hint|fix|next|update|reload/i.test(k) || (typeof v === 'string' && /outdated|out of date|reload|restart/i.test(v))) console.log(`  ${p}${k}: ${JSON.stringify(v).slice(0, 300)}`)
      walk(v, `${p}${k}.`)
    }
  }
  walk(claude, '')
}
