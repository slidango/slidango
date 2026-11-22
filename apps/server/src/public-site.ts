import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import type { FastifyReply } from 'fastify'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Serves one file of a static Slidev build. Paths without a file (slide routes like /3)
 * get index.html, so the single-page app can route them; missing assets answer 404.
 */
export async function servePublicFile(reply: FastifyReply, root: string, path: string) {
  let decoded: string
  try {
    decoded = decodeURIComponent(path.split('?')[0] ?? '')
  } catch {
    return reply.code(400).type('text/plain').send('Bad path')
  }
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  const file = join(root, relative)
  if (file !== root && !file.startsWith(root + sep)) return reply.code(404).send('Not found')

  const info = await stat(file).catch(() => null)
  let target = file
  if (!info?.isFile()) {
    if (extname(relative) && !relative.endsWith('.html')) return reply.code(404).type('text/plain').send('Not found')
    target = join(root, 'index.html')
    if (!(await stat(target).catch(() => null))?.isFile()) {
      return reply.code(503).header('retry-after', '5').type('text/plain').send('The public version is being built. Try again in a moment.')
    }
  }
  // Vite's assets carry a content hash; everything else may change with the next saved version.
  const hashed = relative.startsWith(`assets${sep}`) || relative.startsWith('assets/')
  reply.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'public, no-cache')
  reply.header('x-content-type-options', 'nosniff')
  reply.header('referrer-policy', 'strict-origin-when-cross-origin')
  return reply.type(TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream').send(createReadStream(target))
}
