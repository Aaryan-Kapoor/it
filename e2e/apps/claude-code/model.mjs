// A stand-in for the model behind Claude Code: a small server on this machine that answers
// Anthropic's Messages API by a script, so that the real Claude Code can be run through whole
// turns with no account and no model. Claude Code is pointed at it with ANTHROPIC_BASE_URL and
// a made-up key.
//
// Claude Code asks more of its model than the conversation's turns: a title for the
// conversation, a check of the key, a count of tokens. Only a request that offers the agent its
// tools is one of the conversation's turns, and only those are handed to the script; every other
// request is answered with a few words, so that nothing Claude Code asks on the side holds it up.
import { randomBytes } from 'node:crypto'
import http from 'node:http'

/** The text of a message's content, whichever shape it is given in. */
export const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('\n')

/**
 * What a turn's request holds, as the script reads it: the messages, the newest message from
 * the user side (which is the person's words, a tool's result, or a prompt an add-on submitted),
 * its text, the tool results it carries, and the id Claude Code gives the conversation where it
 * says one.
 */
export function readTurn(body, headers) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const last = [...messages].reverse().find((m) => m.role === 'user')
  const blocks = Array.isArray(last?.content) ? last.content : []
  const results = blocks.filter((b) => b?.type === 'tool_result')
  // The text of the newest user message, without what Claude Code puts beside it of its own
  // (reminders inside <system-reminder> tags), which is no part of what was submitted
  const own = blocks.length ? blocks.filter((b) => b?.type === 'text' && !/^\s*<system-reminder>/.test(b.text)) : []
  const text = (blocks.length ? textOf(own) : textOf(last?.content)).trim()
  let session = headers['x-claude-code-session-id'] ?? null
  if (!session) {
    // Older versions say it only inside the request's metadata
    const said = body.metadata?.user_id
    const found = typeof said === 'string' ? /session_([0-9a-f-]{36})/.exec(said)?.[1] : null
    if (found) session = found
    else if (typeof said === 'string') {
      try {
        session = JSON.parse(said).session_id ?? null
      } catch {}
    }
  }
  return { messages, last, text, results, session }
}

/** An answer of a few words, which ends the turn. */
export const words = (text) => ({ content: [{ type: 'text', text }], stop: 'end_turn' })
/** An answer that asks Claude Code to run one shell command with its Bash tool, which it then answers with the result. */
export const runs = (command, why = 'Running it.') => ({
  content: [
    { type: 'text', text: why },
    { type: 'tool_use', id: `toolu_${randomBytes(12).toString('hex')}`, name: 'Bash', input: { command, description: why } },
  ],
  stop: 'tool_use',
})

/** One answer, written as the API streams it. */
function streamed(res, model, { content, stop }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_${randomBytes(8).toString('hex')}` })
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const id = `msg_${randomBytes(12).toString('hex')}`
  const usage = { input_tokens: 20, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  send('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })
  content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } })
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    }
    send('content_block_stop', { index })
  })
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } })
  send('message_stop', {})
  res.end()
}

/** One answer, whole, for a request that did not ask for a stream. */
function whole(res, model, { content, stop }) {
  res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_${randomBytes(8).toString('hex')}` })
  res.end(
    JSON.stringify({
      id: `msg_${randomBytes(12).toString('hex')}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
  )
}

/**
 * Starts the stand-in on a port of this machine's own. `script(turn)` is given each of the
 * conversation's turns as `readTurn` reads it, and returns the answer (`words` or `runs`).
 * Resolves with its address, every turn it was asked (`turns`), every other request by its path
 * (`asides`), what went wrong in answering (`faults`), and `close`.
 */
export function standInModel(script) {
  const turns = []
  const asides = []
  const faults = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://model')
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {}
      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        asides.push(url.pathname)
        return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":20}')
      }
      if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
        asides.push(`${req.method} ${url.pathname}`)
        return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"not_found_error","message":"Not found"}}')
      }
      const model = typeof body.model === 'string' ? body.model : 'stand-in'
      const answer = (reply) => (body.stream ? streamed(res, model, reply) : whole(res, model, reply))
      // A request that offers no tools is one Claude Code makes on the side
      if (!Array.isArray(body.tools) || !body.tools.some((t) => t?.name === 'Bash')) {
        asides.push(`${url.pathname} (${model})`)
        return answer(words('A page and a button.'))
      }
      const turn = { ...readTurn(body, req.headers), at: Date.now() }
      turns.push(turn)
      let reply
      try {
        reply = script(turn)
      } catch (err) {
        faults.push(err.message)
      }
      answer(reply ?? words('Nothing more to do.'))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        turns,
        asides,
        faults,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.()
            server.close(() => r())
          }),
      })
    })
  })
}
