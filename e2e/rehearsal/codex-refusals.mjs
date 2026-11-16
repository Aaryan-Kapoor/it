// The commands a Codex rollout (in a run's agent-transcript) records as refused, decoded: for each
// exec call, the command Codex asked for and, where it was refused, the exact refusal text.
//   node e2e/rehearsal/codex-refusals.mjs <rollout.jsonl>
import { readFileSync } from 'node:fs'

const calls = new Map()
for (const line of readFileSync(process.argv[2], 'utf8').split('\n')) {
  let j
  try { j = JSON.parse(line) } catch { continue }
  const p = j.payload ?? {}
  if (p.type === 'custom_tool_call' || p.type === 'function_call') calls.set(p.call_id, { t: j.timestamp, input: String(p.input ?? p.arguments ?? '') })
  if ((p.type === 'custom_tool_call_output' || p.type === 'function_call_output') && calls.has(p.call_id)) {
    const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output)
    const m = /exec_command failed: ([^\n]*?Rejected\([\s\S]*?\)[^\n]*)/.exec(out.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
    if (!m) continue
    const c = calls.get(p.call_id)
    console.log(`${String(c.t).slice(11, 19)} ASKED: ${c.input.slice(0, 600)}`)
    console.log(`         REFUSED: ${m[1].slice(0, 700)}`)
  }
}
