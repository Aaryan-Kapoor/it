// The tool calls of one Claude Code transcript (a .jsonl in a THROWAWAY profile), with their
// times, the start of each command and the start of each result: to see what a conversation It
// reopened tried and what was refused. Never run on the owner's own transcripts.
//   node e2e/rehearsal/transcript-tools.mjs <transcript.jsonl> [since ISO time]
import { readFileSync } from 'node:fs'

const [file, since = ''] = process.argv.slice(2)
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line) continue
  let j
  try { j = JSON.parse(line) } catch { continue }
  const t = String(j.timestamp ?? '')
  if (since && t < since) continue
  // Codex's rollout: response items (calls, their outputs, messages) and the session's own events
  const p = j.payload
  if (p && typeof p === 'object') {
    const say = (k, s) => console.log(t.slice(11, 19), k, String(s ?? '').slice(0, 260).replace(/\s+/g, ' '))
    if (p.type === 'function_call' || p.type === 'custom_tool_call') say('USE ', `${p.name} ${p.arguments ?? p.input ?? ''}`)
    else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') say('RES ', typeof p.output === 'string' ? p.output : JSON.stringify(p.output))
    else if (p.type === 'user_message') say('USER', p.message)
    else if (p.type === 'agent_message') say('SAYS', p.message)
    else if (j.type === 'turn_context') say('TURN', `approval ${p.approval_policy} sandbox ${JSON.stringify(p.sandbox_policy)} cwd ${p.cwd ? 'set' : '-'}`)
    else if (/turn_aborted|task_started|task_complete|error/.test(String(p.type))) say('EVNT', `${p.type} ${p.reason ?? p.message ?? ''}`)
    continue
  }
  const c = j.message?.content
  if (j.type === 'user' && typeof c === 'string') console.log(t.slice(11, 19), 'USER', c.slice(0, 300).replace(/\s+/g, ' '))
  if (!Array.isArray(c)) continue
  for (const x of c) {
    if (x.type === 'text' && j.type === 'user') console.log(t.slice(11, 19), 'USER', String(x.text).slice(0, 300).replace(/\s+/g, ' '))
    if (x.type === 'text' && j.type === 'assistant') console.log(t.slice(11, 19), 'SAYS', String(x.text).slice(0, 200).replace(/\s+/g, ' '))
    if (x.type === 'tool_use') console.log(t.slice(11, 19), 'USE ', x.name, JSON.stringify(x.input ?? {}).slice(0, 220))
    if (x.type === 'tool_result') {
      const r = typeof x.content === 'string' ? x.content : JSON.stringify(x.content ?? '')
      console.log(t.slice(11, 19), x.is_error ? 'FAIL' : 'RES ', r.slice(0, 200).replace(/\s+/g, ' '))
    }
  }
}
