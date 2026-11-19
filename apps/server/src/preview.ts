import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import httpProxy from 'http-proxy'

/** Maps `<slug>.<preview domain>` hosts to slugs and back, from a template like `https://{slug}.slides.intern`. */
export class PreviewHosts {
  private pattern: RegExp

  constructor(private template: string) {
    const host = new URL(template.replace('{slug}', 'slug')).hostname.replace(/^slug/, '{slug}')
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{slug\\}', '([a-z0-9-]+)')
    this.pattern = new RegExp(`^${escaped}$`)
  }

  url(slug: string) {
    return this.template.replace('{slug}', slug)
  }

  slugFromHost(hostHeader: string | undefined): string | null {
    if (!hostHeader) return null
    const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase()
    return this.pattern.exec(hostname)?.[1] ?? null
  }
}

/**
 * Forwards HTTP and the Vite HMR WebSocket to a deck's Slidev dev server.
 * The Host header is rewritten because Vite rejects unknown hosts.
 */
export function createPreviewProxy() {
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: false })
  proxy.on('error', (err, _req, res) => {
    if (res instanceof Object && 'writeHead' in res) {
      const response = res as ServerResponse
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Preview not reachable.')
    } else {
      ;(res as Duplex).destroy()
    }
  })

  // Open preview WebSockets (Vite HMR) per deck: someone presenting from a
  // preview tab keeps the Slidev process alive without an editor open.
  const sockets = new Map<string, number>()

  return {
    openSockets: (deckId: string) => sockets.get(deckId) ?? 0,
    web(req: IncomingMessage, res: ServerResponse, origin: string) {
      if (isBlocked(req.url)) {
        res.writeHead(404).end()
        return
      }
      req.headers.host = `localhost:${new URL(origin).port}`
      stripIdentity(req)
      proxy.web(req, res, { target: origin })
    },
    ws(req: IncomingMessage, socket: Duplex, head: Buffer, origin: string, deckId: string) {
      if (isBlocked(req.url)) {
        socket.destroy()
        return
      }
      sockets.set(deckId, (sockets.get(deckId) ?? 0) + 1)
      socket.once('close', () => {
        const left = (sockets.get(deckId) ?? 1) - 1
        if (left > 0) sockets.set(deckId, left)
        else sockets.delete(deckId)
      })
      req.headers.host = `localhost:${new URL(origin).port}`
      delete req.headers.origin
      stripIdentity(req)
      proxy.ws(req, socket, head, { target: origin })
    },
    close: () => proxy.close(),
  }
}

/**
 * Slidev's MCP endpoint can edit slides; the app must stay the only writer of
 * slides.md, so it is not exposed.
 */
function isBlocked(url = '/') {
  return url.startsWith('/__mcp')
}

/** Slidev has no use for the user's identity or SSO cookie. */
function stripIdentity(req: IncomingMessage) {
  for (const key of Object.keys(req.headers)) if (key.startsWith('x-auth-request-')) delete req.headers[key]
  delete req.headers.cookie
}
