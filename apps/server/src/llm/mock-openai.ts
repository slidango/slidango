// Test double for an OpenAI-compatible endpoint: streams scripted answers the
// way real servers do (content deltas, tool calls split into fragments).
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockReply {
  text?: string
  toolCalls?: { name: string; arguments: unknown }[]
}

export interface MockRequest {
  model: string
  messages: { role: string; content: unknown; tool_call_id?: string }[]
  tools?: { function: { name: string } }[]
  tool_choice?: unknown
}

export type MockHandler = (request: MockRequest) => MockReply

export async function startMockOpenAI(handler: MockHandler, port = 0) {
  const requests: MockRequest[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
      const request = JSON.parse(body) as MockRequest
      requests.push(request)
      const reply = handler(request)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      send({ role: 'assistant' })
      for (const piece of (reply.text ?? '').match(/[\s\S]{1,12}/g) ?? []) send({ content: piece })
      reply.toolCalls?.forEach((call, index) => {
        const args = JSON.stringify(call.arguments)
        send({ tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: call.name, arguments: '' } }] })
        for (const piece of args.match(/[\s\S]{1,20}/g) ?? []) send({ tool_calls: [{ index, function: { arguments: piece } }] })
      })
      send({}, reply.toolCalls?.length ? 'tool_calls' : 'stop')
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Plain text of a message's content (string or content parts). */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p: { text?: string }) => p.text ?? '').join('')
  return ''
}
