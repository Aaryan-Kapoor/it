// A stand-in for the two model services the agent apps a project agent runs with talk to, on
// this machine: Anthropic's Messages API for Claude Code and OpenAI's Responses API for Codex,
// each streamed as the app asks. It answers every turn in words that say what it was sent and
// how many messages of the person's came before it in the conversation, which is how a test
// tells that a resumed conversation carried what came before. It needs no account, and nothing
// it is sent leaves the machine.
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Asked {
  path: string
  body: any
}

/** What a turn is answered with: what the person said last, and how many of their messages came before it. */
export const answerTo = (said: string, before: number) => `Heard “${said.slice(0, 80)}”. Earlier messages from you in this conversation: ${before}.`

/** The person's own messages in an Anthropic request, leaving out what is a tool's result and what the app adds in angle brackets. */
function anthropicSaid(body: any): string[] {
  const out: string[] = []
  for (const m of body?.messages ?? []) {
    if (m.role !== 'user') continue
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? [])
    const text = parts
      .filter((p: any) => p.type === 'text' && typeof p.text === 'string' && !p.text.trim().startsWith('<'))
      .map((p: any) => p.text)
      .join('\n')
      .trim()
    if (text) out.push(text)
  }
  return out
}
/** The same in a Responses request. */
function responsesSaid(body: any): string[] {
  const out: string[] = []
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (item.type !== 'message' || item.role !== 'user') continue
    const text = (item.content ?? [])
      .filter((p: any) => p.type === 'input_text' && typeof p.text === 'string' && !p.text.trim().startsWith('<') && !p.text.startsWith('# AGENTS.md'))
      .map((p: any) => p.text)
      .join('\n')
      .trim()
    if (text) out.push(text)
  }
  return out
}

const sse = (res: http.ServerResponse, events: [string, unknown][]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}

export async function standInModel(): Promise<{ url: string; asked: Asked[]; close: () => Promise<void> }> {
  const asked: Asked[] = []
  let n = 0
  const server = http.createServer((req, res) => {
    const pieces: Buffer[] = []
    req.on('data', (p: Buffer) => pieces.push(p))
    req.on('end', () => {
      let body: any = null
      try {
        body = JSON.parse(Buffer.concat(pieces).toString('utf8') || 'null')
      } catch {}
      const at = (req.url ?? '').split('?')[0]!
      asked.push({ path: at, body })
      const id = `stand-in-${++n}`
      if (req.method === 'POST' && at === '/v1/messages') {
        const said = anthropicSaid(body)
        const text = answerTo(said.at(-1) ?? '', Math.max(0, said.length - 1))
        const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        const message = { id, type: 'message', role: 'assistant', model: body?.model ?? 'stand-in', content: [], stop_reason: null, stop_sequence: null, usage }
        if (!body?.stream) {
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn' }))
        }
        return sse(res, [
          ['message_start', { type: 'message_start', message }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }],
          ['message_stop', { type: 'message_stop' }],
        ])
      }
      if (req.method === 'POST' && at === '/v1/responses') {
        const said = responsesSaid(body)
        const text = answerTo(said.at(-1) ?? '', Math.max(0, said.length - 1))
        const item = { type: 'message', role: 'assistant', id: `msg-${id}`, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
        const usage = {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 20,
        }
        return sse(res, [
          ['response.created', { type: 'response.created', response: { id } }],
          ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
          ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text }],
          ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
          ['response.completed', { type: 'response.completed', response: { id, usage } }],
        ])
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'not_found', message: 'The stand-in model has nothing here.' } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    asked,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
