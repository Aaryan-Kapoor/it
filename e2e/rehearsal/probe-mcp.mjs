// A minimal MCP server (stdio) for item 3(iii): added with `claude mcp add --scope user probe -- node
// probe-mcp.mjs <log>`, it writes one line to <log> each time a Claude Code starts it (the time
// and its parent's process id), so that it shows whether a conversation It reopens has the
// person's user-wide servers. One tool, `probe_ping`, which answers "pong".
//   node e2e/rehearsal/probe-mcp.mjs <log file>
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const log = process.argv[2]
const note = (s) => { try { appendFileSync(log, `${new Date().toISOString()} pid ${process.pid} parent ${process.ppid} ${s}\n`) } catch {} }
note('started')
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.method === 'initialize') {
    note('initialize')
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1.0.0' } } })
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'probe_ping', description: 'Answers pong. For a test only.', inputSchema: { type: 'object', properties: {} } }] } })
  } else if (m.method === 'tools/call') {
    note('tools/call')
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } })
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, result: {} })
  }
}).on('close', () => note('closed'))
