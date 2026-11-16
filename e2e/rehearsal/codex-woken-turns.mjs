// For each woken turn in a Codex rollout (a user message saying It reopened the conversation):
// whether the reopening note told Codex which form to use, and every command it ran, with
// whether it was refused ("blocked by policy") or what exit code it had. Prints only the
// start of each command; nothing of the rollout's other content.
//   node e2e/rehearsal/codex-woken-turns.mjs <rollout.jsonl>...
import { readFileSync } from 'node:fs'

for (const file of process.argv.slice(2)) {
  let turn = null
  const turns = []
  const calls = new Map()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    const p = j.payload ?? {}
    if (p.type === 'message' && p.role === 'user') {
      const text = (p.content ?? []).map((c) => c.text ?? '').join(' ')
      if (/<environment_context>|AGENTS\.md|<permissions/.test(text) && !/reopened this conversation/.test(text)) continue
      turn = /reopened this conversation/.test(text) ? { at: String(j.timestamp).slice(11, 19), told: /it set |--file|exact form|use this form/i.test(text), calls: [] } : null
      if (turn) turns.push(turn)
    }
    if (!turn) continue
    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      let cmd = String(p.input ?? p.arguments ?? '')
      try { const a = JSON.parse(cmd); cmd = a.cmd ?? a.command ?? cmd; if (Array.isArray(cmd)) cmd = cmd.join(' ') } catch {}
      const c = { cmd: String(cmd).replace(/\s+/g, ' ').slice(0, 110), out: '?' }
      calls.set(p.call_id, c)
      turn.calls.push(c)
    }
    if ((p.type === 'custom_tool_call_output' || p.type === 'function_call_output') && calls.has(p.call_id)) {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output)
      const c = calls.get(p.call_id)
      if (/blocked by policy/.test(out)) c.out = 'REFUSED'
      else {
        const m = /exit(?:ed with)?[ _]?code[":\s]*(-?\d+)/i.exec(out)
        c.out = m ? `exit ${m[1]}` : 'ran'
        if (/not valid JSON/.test(out)) c.out += ' (not valid JSON)'
      }
    }
  }
  for (const t of turns) {
    console.log(`  woken ${t.at} told-form=${t.told}`)
    for (const c of t.calls) console.log(`    ${c.out.padEnd(22)} ${c.cmd}`)
  }
}
