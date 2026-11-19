import { existsSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { type FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  type Deck,
  type Preview,
  type User,
  createDeckSchema,
  setHeadmatter,
  slugify,
  themeVersionSchema,
  updateDeckSchema,
} from '@slidango/shared'
import {
  type Action,
  LoginLimiter,
  SESSION_COOKIE,
  Users,
  can,
  checkPassword,
  createSession,
  sessionCookie,
} from './auth'
import { createCollab } from './collab'
import type { Config } from './config'
import type { Db } from './db'
import { Decks, initialSlides, toDeck } from './decks'
import { PreviewHosts, createPreviewProxy } from './preview'
import { Agent } from './llm/agent'
import { registerLlmRoutes } from './llm/routes'
import { LlmConfig } from './llm/settings'
import { Runner } from './runner'
import { MAX_THEME_BYTES, ThemeError, Themes } from './themes'
import { Versions } from './versions'

const IMAGE_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
}
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null
  }
}

function toFetchHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v)
  }
  return headers
}

export async function buildApp(config: Config, db: Db) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 1024 * 1024 })
  const users = new Users(db, config)
  const decks = new Decks(db, config.dataDir)
  const collab = createCollab({ db, decks, users, config, log: app.log })
  const versions = new Versions((id) => decks.dir(id))
  const themes = new Themes(db, {
    dataDir: config.dataDir,
    builtinRuntimeDir: dirname(config.builtinRuntime),
    pnpm: config.pnpm,
    installTimeoutMs: 10 * 60_000,
  })
  const previewHosts = new PreviewHosts(config.previewUrl)
  const previewProxy = createPreviewProxy()
  const runner = new Runner({
    ...config.runner,
    deckDir: (id) => decks.dir(id),
    runtimeModules: (version) => (version ? themes.runtimeModules(version) : config.builtinRuntime),
    // Editors and open preview tabs (e.g. someone presenting) both keep a preview alive.
    connectionCount: (id) => collab.connectionCount(id) + previewProxy.openSockets(id),
    log: app.log,
  })

  const llm = new LlmConfig(db, config.llm)
  const agent = new Agent({
    db,
    llm,
    decks,
    themes,
    collab,
    versions,
    runtimeModules: (version) => (version ? themes.runtimeModules(version) : config.builtinRuntime),
  })

  async function preview(deck: { id: string; slug: string; themeVersion: string | null }): Promise<Preview> {
    const status = await runner.ensure(deck.id, deck.themeVersion)
    return { ...status, url: previewHosts.url(deck.slug) }
  }

  /** Resolves `<slug>.<preview domain>` to a running Slidev port, or null if not a preview request. */
  async function previewTarget(
    host: string | undefined,
    headers: Parameters<Users['fromHeaders']>[0],
  ): Promise<null | { error: 401 | 404 | 500 } | { deck: { id: string; themeVersion: string | null }; origin: string | null }> {
    const slug = previewHosts.slugFromHost(host)
    if (!slug) return null
    const user = await users.fromHeaders(headers)
    const deck = await decks.bySlug(slug)
    if (!user) return { error: 401 }
    if (!deck || !can(user, deck, 'view')) return { error: 404 }
    return { deck, origin: runner.target(deck.id) }
  }

  const publicOrigin = new URL(config.publicUrl).origin

  /** Only redirect back to the app itself or one of its previews (no open redirect). */
  function safeNext(next: unknown): string | null {
    if (typeof next !== 'string' || !next) return null
    try {
      const url = new URL(next, publicOrigin)
      if (url.origin === publicOrigin) return url.href
      if (url.protocol === new URL(publicOrigin).protocol && previewHosts.slugFromHost(url.host)) return url.href
    } catch {
      // fall through
    }
    return null
  }

  app.decorateRequest('user', null)
  app.addHook('onRequest', async (req, reply) => {
    const target = await previewTarget(req.headers.host, req.headers)
    if (target) {
      if ('error' in target && target.error === 401 && config.auth.mode === 'password' && req.method === 'GET') {
        const here = `${new URL(publicOrigin).protocol}//${req.headers.host}${req.url}`
        return reply.redirect(`${publicOrigin}/login?next=${encodeURIComponent(here)}`)
      }
      if ('error' in target) return reply.code(target.error).type('text/plain').send('No access.')
      if (target.origin === null) {
        void runner.ensure(target.deck.id, target.deck.themeVersion)
        return reply.code(503).header('retry-after', '1').type('text/html').send(STARTING_PAGE)
      }
      reply.hijack()
      previewProxy.web(req.raw, reply.raw, target.origin)
      return
    }
    if (!req.url.startsWith('/api') && !req.url.startsWith('/collab')) return
    if (req.url.startsWith('/api/auth/')) return
    req.user = await users.fromHeaders(req.headers)
    if (!req.user) return reply.code(401).send({ error: 'unauthenticated' })
  })

  async function loadDeck(req: FastifyRequest<{ Params: { id: string } }>, action: Action) {
    const deck = await decks.get(req.params.id)
    if (!deck) throw app.httpErrors.notFound()
    if (!can(req.user, deck, action)) throw app.httpErrors.forbidden()
    return deck
  }

  await app.register(import('@fastify/sensible'))
  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 * 1024 } })
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_THEME_BYTES, files: 1 } })

  // Preview WebSockets (Vite HMR) bypass Fastify routing; everything else goes to @fastify/websocket.
  app.addHook('onReady', async () => {
    const listeners = app.server.listeners('upgrade') as ((...args: unknown[]) => void)[]
    app.server.removeAllListeners('upgrade')
    app.server.on('upgrade', async (req, socket, head) => {
      const target = await previewTarget(req.headers.host, req.headers).catch(() => ({ error: 500 as const }))
      if (!target) return listeners.forEach((l) => l.call(app.server, req, socket, head))
      if ('error' in target || target.origin === null) return socket.destroy()
      previewProxy.ws(req, socket, head, target.origin, target.deck.id)
    })
  })

  app.get('/healthz', async () => ({ ok: true }))

  app.get('/api/me', async (req) => req.user)

  // --- Login (only in AUTH_MODE=password; with OIDC, oauth2-proxy handles it) ---

  app.get('/api/auth/config', async () => ({ mode: config.auth.mode }))

  const loginLimiter = new LoginLimiter()
  const loginSchema = z.object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().email().max(200),
    password: z.string().max(1000),
    next: z.string().max(2000).optional(),
  })

  app.post('/api/auth/login', async (req, reply) => {
    const auth = config.auth
    if (auth.mode !== 'password') throw app.httpErrors.notFound()
    const input = loginSchema.parse(req.body)
    // Behind Caddy/nginx every request comes from the proxy. The proxy appends the address it saw,
    // so only the right-most entry is trustworthy; anything left of it is client-supplied.
    const forwarded = req.headers['x-forwarded-for']
    const client = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)?.split(',').at(-1)?.trim() || req.ip
    if (loginLimiter.blocked(client)) {
      return reply.code(429).send({ error: 'Too many failed attempts. Try again in 15 minutes.' })
    }
    const role = checkPassword(input.password, auth)
    if (!role) {
      loginLimiter.fail(client)
      await new Promise((r) => setTimeout(r, 500))
      return reply.code(401).send({ error: 'Wrong password.' })
    }
    loginLimiter.reset(client)
    const token = createSession({ email: input.email, name: input.name, isAdmin: role === 'admin' }, auth)
    reply.header('set-cookie', sessionCookie(token, auth))
    const user = await users.fromHeaders({ cookie: `${SESSION_COOKIE}=${token}` })
    return { user, next: safeNext(input.next) }
  })

  app.post('/api/auth/logout', async (_req, reply) => {
    if (config.auth.mode !== 'password') throw app.httpErrors.notFound()
    reply.header('set-cookie', sessionCookie(null, config.auth))
    return { ok: true }
  })

  const withPreview = (deck: Deck) => ({ ...deck, previewUrl: previewHosts.url(deck.slug) })

  app.get<{ Querystring: { archived?: string } }>('/api/decks', async (req) =>
    (await decks.list(req.query.archived === 'true')).map(withPreview),
  )

  app.post('/api/decks', async (req, reply) => {
    const input = createDeckSchema.parse(req.body)
    const theme = await themes.defaultTheme()
    let content: string | undefined
    if (theme) {
      content =
        (input.mode === 'starter' ? await themes.starter(theme.version, theme.name, input.title) : null) ??
        setHeadmatter(initialSlides(input.title), { theme: theme.name })
    }
    // "Mit Assistent" starts empty (headmatter only); the briefing replaces the preview until the draft.
    if (input.mode === 'assistant') content = headmatterOf(content ?? initialSlides(input.title))
    const deck = await decks.create(input, req.user!.id, { themeVersion: theme?.version ?? null, content })
    await collab.initDocument(deck.id, await decks.readSlides(deck.id))
    await versions.commit(deck.id, 'Deck created', req.user)
    return reply.code(201).send(deck)
  })

  app.get<{ Params: { id: string } }>('/api/decks/:id', async (req) => withPreview(toDeck(await loadDeck(req, 'view'))))

  app.patch<{ Params: { id: string } }>('/api/decks/:id', async (req) => {
    await loadDeck(req, 'edit')
    return decks.update(req.params.id, updateDeckSchema.parse(req.body))
  })

  app.delete<{ Params: { id: string } }>('/api/decks/:id', async (req) => {
    await loadDeck(req, 'manage')
    return decks.update(req.params.id, { archived: true })
  })

  app.post<{ Params: { id: string } }>('/api/decks/:id/unarchive', async (req) => {
    await loadDeck(req, 'manage')
    return decks.update(req.params.id, { archived: false })
  })

  app.post<{ Params: { id: string } }>('/api/decks/:id/preview', async (req) => preview(await loadDeck(req, 'view')))

  app.get<{ Params: { id: string } }>('/api/decks/:id/versions', async (req) => {
    await loadDeck(req, 'view')
    return versions.list(req.params.id)
  })

  app.post<{ Params: { id: string } }>('/api/decks/:id/versions', async (req, reply) => {
    await loadDeck(req, 'edit')
    const { message } = z.object({ message: z.string().trim().max(500).optional() }).parse(req.body ?? {})
    await collab.flushDeck(req.params.id)
    const version = await versions.commit(req.params.id, message || 'Version saved', req.user)
    return version ? reply.code(201).send(version) : reply.code(200).send(null)
  })

  app.post<{ Params: { id: string } }>('/api/decks/:id/restore', async (req) => {
    const deck = await loadDeck(req, 'edit')
    if (deck.archived) throw app.httpErrors.conflict('Deck is archived')
    const { sha } = z.object({ sha: z.string() }).parse(req.body)
    const content = await versions.show(req.params.id, sha)
    if (content === null) throw app.httpErrors.notFound('Version not found')
    await collab.replaceContent(req.params.id, content, 'restore')
    return versions.commit(req.params.id, `Restored version ${sha.slice(0, 7)}`, req.user)
  })

  app.post<{ Params: { id: string } }>('/api/decks/:id/assets', async (req, reply) => {
    const deck = await loadDeck(req, 'edit')
    const file = await req.file()
    if (!file) throw app.httpErrors.badRequest('No file')
    const ext = IMAGE_TYPES[file.mimetype]
    if (!ext) throw app.httpErrors.unsupportedMediaType('Only PNG, JPEG, GIF, WebP or SVG')
    const buffer = await file.toBuffer()
    if (file.file.truncated || buffer.length > MAX_IMAGE_BYTES) throw app.httpErrors.payloadTooLarge('10 MB at most')
    const base = slugify(file.filename.slice(0, file.filename.length - extname(file.filename).length)) || 'bild'
    const name = `${base}-${Date.now().toString(36)}${ext}`
    await mkdir(join(decks.dir(deck.id), 'public'), { recursive: true })
    await writeFile(join(decks.dir(deck.id), 'public', name), buffer)
    return reply.code(201).send({ path: `/${name}` })
  })

  app.get('/api/themes', async () => (await themes.list()).filter((t) => t.status === 'ready'))

  app.post<{ Params: { id: string } }>('/api/decks/:id/theme', async (req) => {
    const deck = await loadDeck(req, 'manage')
    const { version } = z.object({ version: themeVersionSchema }).parse(req.body)
    const theme = await themes.get(version)
    if (!theme || theme.status !== 'ready') throw app.httpErrors.notFound('Template version not available')
    if (deck.themeVersion === version) return toDeck(deck)
    await collab.flushDeck(deck.id)
    const current = await decks.readSlides(deck.id)
    await collab.replaceContent(deck.id, setHeadmatter(current, { theme: theme.name }), 'theme')
    const updated = await decks.update(deck.id, { themeVersion: version })
    await runner.restart(deck.id, version)
    await versions.commit(deck.id, `Template updated to ${version}`, req.user, { allowEmpty: true })
    return updated
  })

  const requireAdmin = (req: FastifyRequest) => {
    if (!req.user?.isAdmin) throw app.httpErrors.forbidden()
  }

  app.get('/api/admin/themes', async (req) => {
    requireAdmin(req)
    return themes.list()
  })

  app.post('/api/admin/themes', async (req, reply) => {
    requireAdmin(req)
    const file = await req.file()
    if (!file) throw app.httpErrors.badRequest('No file')
    const data = await file.toBuffer()
    if (file.file.truncated) throw app.httpErrors.payloadTooLarge('50 MB at most')
    const field = (name: string) => {
      const f = file.fields[name]
      return f && !Array.isArray(f) && f.type === 'field' ? String(f.value) : ''
    }
    try {
      const version = themeVersionSchema.parse(field('version'))
      const { theme, installed } = await themes.upload(
        { version, changelog: field('changelog').slice(0, 5000), filename: file.filename, data },
        req.user!.id,
      )
      installed.catch((err) => req.log.error({ err, version }, 'theme install crashed'))
      return reply.code(202).send(theme)
    } catch (err) {
      if (err instanceof ThemeError) throw app.httpErrors.badRequest(err.message)
      throw err
    }
  })

  app.put<{ Params: { version: string } }>('/api/admin/themes/:version/default', async (req) => {
    requireAdmin(req)
    try {
      await themes.setDefault(req.params.version)
    } catch (err) {
      if (err instanceof ThemeError) throw app.httpErrors.badRequest(err.message)
      throw err
    }
    return themes.list()
  })

  app.get('/api/admin/previews', async (req) => {
    requireAdmin(req)
    return runner.list()
  })

  registerLlmRoutes(app, { db, agent, llm, decks, collab, versions, users, loadDeck })

  app.get('/collab', { websocket: true }, (socket, req) => {
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
      headers: toFetchHeaders(req.headers),
    })
    const connection = collab.hocuspocus.handleConnection(socket, request)
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      connection.handleMessage(new Uint8Array(bytes))
    })
    socket.on('close', (code, reason) => connection.handleClose({ code, reason: reason.toString() } as CloseEvent))
    // Pongs count as activity so idle-but-open editors are not dropped.
    socket.on('pong', () => connection.touch())
    const ping = setInterval(() => socket.ping(), 15_000)
    socket.on('close', () => clearInterval(ping))
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof Error && err.name === 'ZodError') {
      return reply.code(400).send({ error: 'invalid input', issues: (err as unknown as { issues: unknown }).issues })
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) req.log.error(err)
    return reply.code(status).send({ error: status >= 500 ? 'internal error' : (err as Error).message })
  })

  if (config.webDist && existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' })
      return reply.sendFile('index.html')
    })
  }

  app.addHook('onClose', async () => {
    await collab.flushAll()
    collab.hocuspocus.closeConnections()
    await runner.stopAll()
    previewProxy.close()
  })

  return { app, collab, decks, users, runner, versions, themes, agent, llm, previewProxy }
}

function headmatterOf(markdown: string): string {
  const head = /^---\n[\s\S]*?\n---/.exec(markdown)?.[0]
  return head ? `${head}\n` : ''
}

const STARTING_PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1">
<title>Starting preview</title><body style="font-family:system-ui;color:#6b6b76;display:grid;place-items:center;height:100vh;margin:0">Starting preview …</body>`
