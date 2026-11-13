// A stand-in for a model's API, on this machine, that answers by script. It speaks the OpenAI
// chat completions API as OpenCode's "openai-compatible" provider asks it: one POST to
// /v1/chat/completions for each step of a turn, streamed back as server-sent events. Each
// request is kept, whole, so that a check can read what OpenCode sent, and each answer is what
// the `answer` function given to it says: words, or one call of a tool.
//
//   const model = await standInModel((request) => ({ text: 'Done.' }))
//   model.url            the address to give OpenCode as the provider's base URL
//   model.requests       every request so far, parsed, in the order they came
//   await model.next(ms) waits for the next request after the ones already read, and gives it
//   await model.close()
//
// It listens on 127.0.0.1 and nowhere else, and takes no key: whatever key OpenCode sends it is
// made up.
import http from 'node:http'

/** The text of a message as the chat completions API carries it: a string, or a list of parts. */
export function textOf(message) {
  const c = message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('')
  return ''
}

/** The newest message on the person's side of a request, or undefined. */
export const newestUser = (request) => [...(request?.messages ?? [])].reverse().find((m) => m.role === 'user')

/** Whether a request comes back with a tool's answer: the step after a tool was called. */
export const afterTool = (request) => request?.messages?.at(-1)?.role === 'tool'

export async function standInModel(answer, { port = 0 } = {}) {
  const requests = []
  let read = 0
  const waiters = []
  const server = http.createServer((req, res) => {
    const pieces = []
    req.on('data', (p) => pieces.push(p))
    req.on('end', () => {
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(new URL(req.url, 'http://x').pathname)) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not here"}}')
        return
      }
      let body
      try {
        body = JSON.parse(Buffer.concat(pieces).toString('utf8'))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"not JSON"}}')
        return
      }
      requests.push(body)
      for (const w of waiters.splice(0)) w()
      let said
      try {
        said = answer(body) ?? { text: '' }
      } catch (err) {
        said = { text: `The stand-in could not answer: ${err.message}` }
      }
      reply(res, body, said)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const at = server.address().port
  return {
    url: `http://127.0.0.1:${at}/v1`,
    requests,
    /** The next request after those already read, within `ms`, or undefined. */
    async next(ms = 30_000) {
      const end = Date.now() + ms
      while (read >= requests.length) {
        const left = end - Date.now()
        if (left <= 0) return undefined
        await new Promise((resolve) => {
          const t = setTimeout(resolve, left)
          waiters.push(() => {
            clearTimeout(t)
            resolve()
          })
        })
      }
      return requests[read++]
    },
    /** Marks every request so far as read. */
    skip() {
      read = requests.length
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

let calls = 0
/** Writes one answer: streamed where the request asks for a stream, which OpenCode always does, and whole otherwise. */
function reply(res, request, said) {
  const id = `chatcmpl-standin-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const model = request.model ?? 'stand-in'
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  const tool = said.tool
    ? { id: `call_standin_${++calls}`, type: 'function', function: { name: said.tool.name, arguments: JSON.stringify(said.tool.args) } }
    : null
  const finish = tool ? 'tool_calls' : 'stop'
  if (!request.stream) {
    const message = tool ? { role: 'assistant', content: null, tool_calls: [tool] } : { role: 'assistant', content: said.text ?? '' }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], usage }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const chunk = (delta, finish_reason = null, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`)
  chunk({ role: 'assistant', content: '' })
  if (tool) chunk({ tool_calls: [{ index: 0, ...tool }] })
  else if (said.text) chunk({ content: said.text })
  chunk({}, finish)
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`)
  res.end('data: [DONE]\n\n')
}
