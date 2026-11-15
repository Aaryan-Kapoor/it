// The commands an agent ran in a run, from its kept transcript (agent-transcript/), with each one
// that failed: for counting how an agent answered the tour, patched pages and saved files.
//   node e2e/rehearsal/transcript-commands.mjs <run folder> [regex of commands to show]
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const dir = path.join(process.argv[2], 'agent-transcript')
const show = new RegExp(process.argv[3] ?? 'tour|patch|save|it\\.exe|\\bit\\b', 'i')
const calls = new Map()
for (const f of readdirSync(dir)) {
  for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const t = String(o.timestamp ?? '').slice(11, 19)
    // Codex: payload.type custom_tool_call / function_call, and their outputs
    const p = o.payload ?? {}
    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      const text = String(p.input ?? p.arguments ?? '')
      const cmds = [...text.matchAll(/cmd\\?"?\s*:\s*\\?"((?:[^"\\]|\\.)*)/g)].map((m) => m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"'))
      const shown = (cmds.length ? cmds : [text]).filter((c) => show.test(c))
      if (shown.length) {
        calls.set(p.call_id, t)
        for (const c of shown) console.log(`${t} RUN  ${c.slice(0, 220)}`)
      }
    }
    if ((p.type === 'custom_tool_call_output' || p.type === 'function_call_output') && calls.has(p.call_id)) {
      const out = JSON.stringify(p.output ?? '')
      const bad = /not valid JSON|does not know what to do|Exit code: [1-9]|exit code [1-9]|"error":\{/i.exec(out)
      if (bad) console.log(`${t} FAIL ${out.slice(Math.max(0, bad.index - 60), bad.index + 160)}`)
    }
    // Claude Code: message.content tool_use / tool_result
    const c = o.message?.content
    if (Array.isArray(c))
      for (const b of c) {
        if (b.type === 'tool_use' && b.input?.command && show.test(b.input.command)) {
          calls.set(b.id, t)
          console.log(`${t} RUN  ${String(b.input.command).slice(0, 220)}`)
        }
        if (b.type === 'tool_result' && calls.has(b.tool_use_id)) {
          const out = JSON.stringify(b.content ?? '')
          const bad = /not valid JSON|does not know what to do|Exit code [1-9]|"error":\{/i.exec(out)
          if (bad || b.is_error) console.log(`${t} FAIL ${out.slice(Math.max(0, (bad?.index ?? 0) - 60), (bad?.index ?? 0) + 160)}`)
        }
      }
  }
}
