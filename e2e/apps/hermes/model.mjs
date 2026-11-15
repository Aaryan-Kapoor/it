// A stand-in for the model behind Hermes Agent, which Hermes reaches as a custom provider of
// OpenAI's chat completions (`model.provider: custom` and `model.base_url` in its settings). It
// listens on this machine only, needs no key, and answers each request by a script: words, or a
// call of the tool Hermes offers for running a shell command. Every request is kept whole, so
// that a run can read what Hermes sent: which messages, in which order, after which click.
//
// Hermes also asks a model for things beside the conversation, such as a title for it, and some
// releases ask whether the model is there before the first turn. Those are answered with a few
// words and kept apart from the conversation's own requests (`asides`).
import http from 'node:http'

/** The text of a message in a chat completions request, whichever of its two shapes it has. */
export function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
}

/** The newest message from the user in a request, as text, or null where it has none. */
export function newestFromUser(request) {
  const users = (request?.messages ?? []).filter((m) => m?.role === 'user')
  return users.length ? textOf(users.at(-1)) : null
}

/**
 * The tool, among those Hermes offered in a request, that runs a shell command, and the name of
 * its parameter for the command. Hermes calls it `terminal`, with `command`; any tool whose
 * parameters have a `command` is taken where that name is not offered.
 */
export function shellTool(request) {
  const tools = (request?.tools ?? []).map((t) => t?.function).filter(Boolean)
  const takes = (fn) => Object.keys(fn?.parameters?.properties ?? {}).includes('command')
  const fn = tools.find((f) => f.name === 'terminal' && takes(f)) ?? tools.find(takes)
  return fn ? { name: fn.name, param: 'command' } : null
}

/** Whether a request is the conversation's own: it offers Hermes's tools. A title or a summary offers none. */
export const isTurn = (request) => Array.isArray(request?.tools) && request.tools.length > 0

const chunk = (id, delta, finish = null) => ({
  id,
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: 'script',
  choices: [{ index: 0, delta, finish_reason: finish }],
})

/**
 * Starts the stand-in on `port` of 127.0.0.1. `script(request)` is asked for the answer to each
 * of the conversation's requests, and returns `{ text }` or `{ run: '<command>' }`, which is a
 * call of Hermes's shell tool. What it throws is answered as a refusal, and kept as a fault.
 */
export function standInModel({ port, script }) {
  const turns = []
  const asides = []
  const faults = []
  let calls = 0
  const server = http.createServer((req, res) => {
    const pieces = []
    req.on('data', (p) => pieces.push(p))
    req.on('end', async () => {
      if (req.method === 'GET' && /\/models\/?$/.test(req.url)) {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ object: 'list', data: [{ id: 'script', object: 'model', owned_by: 'it' }] }))
        return
      }
      if (req.method !== 'POST' || !/\/chat\/completions\/?$/.test(req.url)) {
        asides.push(`${req.method} ${req.url}`)
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not here"}}')
        return
      }
      let request
      try {
        request = JSON.parse(Buffer.concat(pieces).toString('utf8'))
      } catch {
        res.writeHead(400).end()
        return
      }
      let answer
      if (!isTurn(request)) {
        asides.push(`a request with no tools: ${(newestFromUser(request) ?? '').slice(0, 80)}`)
        answer = { text: 'A page with one button' }
      } else {
        turns.push({ at: Date.now(), body: request })
        try {
          answer = await script(request)
          if (answer.run) {
            const tool = shellTool(request)
            if (!tool) throw new Error(`Hermes offered no tool that runs a command: ${request.tools.map((t) => t?.function?.name).join(', ')}`)
            answer = { call: { name: tool.name, arguments: { [tool.param]: answer.run } } }
          }
        } catch (err) {
          faults.push(`request ${turns.length}: ${err.message}`)
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'the stand-in has no answer for this request' } }))
          return
        }
      }
      const id = `chatcmpl-standin-${turns.length}-${asides.length}`
      const call = answer.call
        ? { index: 0, id: `call_standin_${++calls}`, type: 'function', function: { name: answer.call.name, arguments: JSON.stringify(answer.call.arguments) } }
        : null
      const finish = call ? 'tool_calls' : 'stop'
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      if (!request.stream) {
        const message = call ? { role: 'assistant', content: null, tool_calls: [call] } : { role: 'assistant', content: answer.text ?? '' }
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'script',
            choices: [{ index: 0, message, finish_reason: finish }],
            usage,
          }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = (data) => res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
      send(chunk(id, { role: 'assistant', content: '' }))
      if (call) send(chunk(id, { tool_calls: [call] }))
      else send(chunk(id, { content: answer.text ?? '' }))
      send(chunk(id, {}, finish))
      send({ ...chunk(id, {}), choices: [], usage })
      send('[DONE]')
      res.end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        turns,
        asides,
        faults,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    )
  })
}
