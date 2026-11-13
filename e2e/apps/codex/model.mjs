// A stand-in for the model that Codex asks, on this machine, answering by a script. It speaks
// what Codex speaks to a model provider that is set as `wire_api = "responses"`: Codex posts its
// whole conversation to `/v1/responses` and reads the answer as a stream of server-sent events.
// No real model is asked, and nothing leaves the machine.
//
// Each request is kept, by the conversation Codex names in it and the newest thing a person said
// in it, so that a check can see which conversation asked what, and in what order. The script
// is given each request as it comes and says what to answer: a command for Codex to run with the
// shell tool it offers, or words, which end the turn.
import http from 'node:http'

/** The text of a message as Codex sends it, its parts joined. */
export const textOf = (item) => (typeof item?.content === 'string' ? item.content : (item?.content ?? []).map((part) => part.text ?? '').join(''))

/**
 * What a request from Codex is, for a script to go by: the conversation it is in, the newest
 * message from the person and where it stands in the input, the item the input ends with, and
 * the shell tool Codex offered.
 */
export function readRequest(body) {
  const input = Array.isArray(body.input) ? body.input : []
  let at = -1
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i]?.type === 'message' && input[i]?.role === 'user') {
      at = i
      break
    }
  }
  const last = input.at(-1)
  const tools = (body.tools ?? []).map((t) => t.name).filter(Boolean)
  return {
    thread: body.client_metadata?.thread_id ?? null,
    newest: at >= 0 ? textOf(input[at]) : '',
    // What came after the person's newest message: what a hook added, the calls Codex made and
    // what they gave back
    since: input.slice(at + 1),
    // How many of the calls made since have given back what they printed
    outputs: input.slice(at + 1).filter((item) => item?.type === 'function_call_output').length,
    last: last?.type === 'message' ? `message:${last.role}` : (last?.type ?? null),
    tools,
    model: body.model,
  }
}

/**
 * The arguments of a call to the shell tool Codex offered, for one command line. Codex has
 * offered it under three names over its versions, each with its own way of being given the
 * command.
 */
export function shellCall(tools, command) {
  if (tools.includes('exec_command')) return { name: 'exec_command', arguments: { cmd: command } }
  if (tools.includes('shell_command')) return { name: 'shell_command', arguments: { command } }
  if (tools.includes('shell')) return { name: 'shell', arguments: { command: ['bash', '-lc', command] } }
  return null
}

/**
 * Starts the stand-in on 127.0.0.1 at `port`. `script(request)` is given each request read by
 * `readRequest`, and answers `{ run: '<command line>' }` or `{ say: '<words>' }`. Resolves with
 * every request kept (`seen`), a way to wait for one (`until`), and `close`.
 */
export function standInModel({ port, script }) {
  const seen = []
  const others = []
  let n = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.endsWith('/responses')) {
        others.push(`${req.method} ${req.url}`)
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end('{"error":{"message":"not here"}}')
      }
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        res.writeHead(400)
        return res.end()
      }
      n += 1
      const asked = { n, at: Date.now(), ...readRequest(body) }
      let answer
      try {
        answer = script(asked) ?? { say: 'OK' }
      } catch (err) {
        answer = { say: `The stand-in's script failed: ${err.message}` }
      }
      const call = answer.run === undefined ? null : shellCall(asked.tools, answer.run)
      asked.answered = call ? { run: answer.run, tool: call.name } : { say: answer.run === undefined ? answer.say : 'no shell tool was offered' }
      seen.push(asked)
      const id = `resp_${n}`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      send('response.created', { response: { id } })
      const item = call
        ? { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: call.name, arguments: JSON.stringify(call.arguments) }
        : { type: 'message', id: `msg_${n}`, role: 'assistant', content: [{ type: 'output_text', text: asked.answered.say }] }
      send('response.output_item.added', { output_index: 0, item })
      send('response.output_item.done', { output_index: 0, item })
      send('response.completed', {
        response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: null, output_tokens_details: null } },
      })
      res.end()
    })
  })
  const until = async (test, ms) => {
    const end = Date.now() + ms
    for (;;) {
      const found = seen.find(test)
      if (found || Date.now() > end) return found
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        seen,
        others,
        until,
        close: () =>
          new Promise((r) => {
            server.close(() => r())
            server.closeAllConnections()
          }),
      }),
    )
  })
}
