// A stand-in for a model's API, for an agent app that is pointed at it through its own settings.
// It listens on this machine only, speaks OpenAI's chat completions as an app streams them, and
// answers each request it is sent by a script: words, or a call of one of the tools the app
// offered. Every request is kept whole, so that a run can read what the app sent: which
// messages, in which order, after which click.
import http from 'node:http'

/** The text of a message in a chat completions request, whichever of its two shapes it has. */
export function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n')
}

/** The newest message from the user in a request, as text, or null where it has none. */
export function newestFromUser(request) {
  const users = (request?.messages ?? []).filter((m) => m?.role === 'user')
  return users.length ? textOf(users.at(-1)) : null
}

/**
 * The name of the tool, among those the app offered in a request, that runs a shell command,
 * and the name of its parameter for the command. Pi calls it `bash`, with `command`.
 */
export function shellTool(request) {
  for (const t of request?.tools ?? []) {
    const fn = t?.function
    const props = Object.keys(fn?.parameters?.properties ?? {})
    if (fn?.name === 'bash' && props.includes('command')) return { name: fn.name, param: 'command' }
  }
  return null
}

const chunk = (id, delta, finish = null) => ({
  id,
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: 'script',
  choices: [{ index: 0, delta, finish_reason: finish }],
})

/**
 * Starts the stand-in on `port` of 127.0.0.1. `script(request, n)` is asked for the answer to
 * the nth request (from 0), and returns `{ text }` or `{ call: { name, arguments } }`, or a
 * promise of one; what it throws is answered as a refusal, and kept as the stand-in's fault.
 */
export function standInModel({ port, script }) {
  const requests = []
  const faults = []
  let calls = 0
  const server = http.createServer((req, res) => {
    const pieces = []
    req.on('data', (p) => pieces.push(p))
    req.on('end', async () => {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
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
      const n = requests.length
      requests.push({ at: Date.now(), headers: { authorization: req.headers.authorization ? 'present' : 'absent' }, body: request })
      let answer
      try {
        answer = await script(request, n)
      } catch (err) {
        faults.push(`request ${n + 1}: ${err.message}`)
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'the stand-in has no answer for this request' } }))
        return
      }
      const id = `chatcmpl-standin-${n + 1}`
      const call = answer.call
        ? { index: 0, id: `call_standin_${++calls}`, type: 'function', function: { name: answer.call.name, arguments: JSON.stringify(answer.call.arguments) } }
        : null
      const finish = call ? 'tool_calls' : 'stop'
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      if (request.stream === false) {
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
        requests,
        faults,
        /** Waits until the stand-in has been sent `n` requests in all, and says whether it was. */
        async until(n, ms) {
          const end = Date.now() + ms
          while (Date.now() < end && requests.length < n) await new Promise((r) => setTimeout(r, 100))
          return requests.length >= n
        },
        close: () => new Promise((r) => server.close(() => r())),
      }),
    )
  })
}
