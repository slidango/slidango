// Test stand-in for Caddy + oauth2-proxy: turns an `e2e-user` cookie into the
// identity headers the app trusts, for HTTP and WebSocket upgrades alike.
import http from 'node:http'
import net from 'node:net'

const [listenPort, targetPort] = process.argv.slice(2).map(Number) as [number, number]

function identityHeaders(req: http.IncomingMessage): Record<string, string> {
  const match = /(?:^|;\s*)e2e-user=([^;]+)/.exec(req.headers.cookie ?? '')
  if (!match) return {}
  const [email, name] = decodeURIComponent(match[1]!).split('|')
  return { 'x-auth-request-email': email!, 'x-auth-request-preferred-username': name ?? email! }
}

function forwardedHeaders(req: http.IncomingMessage) {
  const headers = { ...req.headers }
  for (const key of Object.keys(headers)) if (key.startsWith('x-auth-request-')) delete headers[key]
  return { ...headers, ...identityHeaders(req) }
}

const server = http.createServer((req, res) => {
  const upstream = http.request(
    { port: targetPort, host: '127.0.0.1', method: req.method, path: req.url, headers: forwardedHeaders(req) },
    (up) => {
      res.writeHead(up.statusCode!, up.headers)
      up.pipe(res)
    },
  )
  upstream.on('error', () => res.writeHead(502).end())
  req.pipe(upstream)
})

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(targetPort, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [key, value] of Object.entries(forwardedHeaders(req))) {
      for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) lines.push(`${key}: ${v}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(listenPort, '127.0.0.1')
