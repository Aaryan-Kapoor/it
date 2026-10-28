// Stand-ins for the two agent apps a project agent is run with, as small Node programs that
// speak each one's JSON lines: Claude Code's print mode, and Codex's app server. Each writes
// down what it was started with and what it was sent, in the file SEEN names, whole each time.
// A message that is "crash" ends the program badly, "fail" fails the turn, "slow" (or one that
// ends with it) starts a turn that never ends, and "leave something" starts a program that
// outlives the turn.
export const CLAUDE = `
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const argv = process.argv.slice(2)
const at = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1] }
const session = at('--session-id') ?? at('--resume')
const seen = { argv, cwd: process.cwd(), env: { IT_RUN: process.env.IT_RUN, IT_SESSION: process.env.IT_SESSION, IT_HARNESS: process.env.IT_HARNESS, PWD: process.env.PWD }, got: [] }
const save = () => { fs.writeFileSync(process.env.SEEN + '.tmp', JSON.stringify(seen)); fs.renameSync(process.env.SEEN + '.tmp', process.env.SEEN) }
save()
let rest = ''
process.stdin.on('data', (d) => {
  rest += d
  let i
  while ((i = rest.indexOf('\\n')) !== -1) {
    const row = JSON.parse(rest.slice(0, i))
    rest = rest.slice(i + 1)
    const text = row.message.content[0].text
    seen.got.push(text)
    save()
    if (text === 'slow' || text.endsWith('slow')) continue
    if (text === 'crash') { process.stderr.write('error: the model could not be reached\\n'); process.exit(3) }
    if (text === 'leave something') {
      const left = spawn('sleep', ['300'], { stdio: 'ignore' })
      fs.writeFileSync(process.env.SEEN + '.left', String(left.pid))
    }
    const out = (r) => process.stdout.write(JSON.stringify(r) + '\\n')
    out({ type: 'system', subtype: 'init', session_id: session })
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'heard: ' + text }] }, session_id: session })
    out({ type: 'result', subtype: 'success', is_error: text === 'fail', result: text === 'fail' ? 'API Error: overloaded' : 'heard: ' + text, session_id: session })
  }
})
`

export const CODEX = `
const fs = require('node:fs')
const seen = { argv: process.argv.slice(2), asked: [], answered: [] }
const save = () => { fs.writeFileSync(process.env.SEEN + '.tmp', JSON.stringify(seen)); fs.renameSync(process.env.SEEN + '.tmp', process.env.SEEN) }
save()
let rest = ''
let thread = null
const out = (r) => process.stdout.write(JSON.stringify(r) + '\\n')
process.stdin.on('data', (d) => {
  rest += d
  let i
  while ((i = rest.indexOf('\\n')) !== -1) {
    const row = JSON.parse(rest.slice(0, i))
    rest = rest.slice(i + 1)
    if (row.method) seen.asked.push({ method: row.method, params: row.params })
    else seen.answered.push(row)
    save()
    if (row.method === 'initialize') out({ id: row.id, result: { userAgent: 'stand-in' } })
    if (row.method === 'thread/start') { thread = 'thread-made-1'; out({ id: row.id, result: { thread: { id: thread } } }) }
    if (row.method === 'thread/resume') {
      if (row.params.threadId === 'thread-lost') { out({ id: row.id, error: { code: -32600, message: 'no rollout found for thread id thread-lost' } }); continue }
      thread = row.params.threadId; out({ id: row.id, result: { thread: { id: thread } } })
    }
    if (row.method === 'turn/start') {
      const text = row.params.input[0].text
      out({ id: row.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
      out({ method: 'turn/started', params: { threadId: thread, turn: { id: 'turn-1' } } })
      out({ id: 'ask-1', method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: 'turn-1', itemId: 'c1' } })
      out({ id: 'ask-2', method: 'item/tool/requestUserInput', params: { threadId: thread } })
      out({ method: 'item/completed', params: { threadId: 'another-thread', item: { type: 'agentMessage', id: 'x', text: 'not this one' } } })
      out({ method: 'item/completed', params: { threadId: thread, turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: 'did: ' + text } } })
      out({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn-1', status: text === 'fail' ? 'failed' : 'completed', error: text === 'fail' ? { message: 'stream disconnected' } : null } } })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`
