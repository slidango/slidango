import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { Deck, Preview } from '@slidango/shared'
import { buildApp } from './app'
import { loadConfig } from './config'
import type { Db } from './db'
import { PreviewHosts } from './preview'
import { openTestDb } from './test-db'

const alice = { 'x-auth-request-email': 'alice@example.com' }

describe('PreviewHosts', () => {
  it('maps hosts to slugs', () => {
    const hosts = new PreviewHosts('https://{slug}.slides.intern')
    expect(hosts.url('q4')).toBe('https://q4.slides.intern')
    expect(hosts.slugFromHost('q4.slides.intern')).toBe('q4')
    expect(hosts.slugFromHost('Q4.slides.intern:443')).toBe('q4')
    expect(hosts.slugFromHost('slides.intern')).toBeNull()
    expect(hosts.slugFromHost('a.b.slides.intern')).toBeNull()
    expect(hosts.slugFromHost('q4.slides.internet')).toBeNull()
    expect(new PreviewHosts('http://{slug}.localhost:3000').slugFromHost('x.localhost:3000')).toBe('x')
  })
})

describe('preview, versions and assets', () => {
  let dataDir: string
  let db: Db
  let closeDb: () => Promise<void>
  let server: Awaited<ReturnType<typeof buildApp>> & { port: number }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'slidango-'))
    ;({ db, close: closeDb } = await openTestDb())
    const built = await buildApp(loadConfig({ DATA_DIR: dataDir, PREVIEW_URL: 'http://{slug}.localhost:3000' }), db)
    built.app.log.level = 'warn'
    await built.app.listen({ port: 0, host: '127.0.0.1' })
    const address = built.app.server.address()
    server = { ...built, port: typeof address === 'object' && address ? address.port : 0 }
  })

  afterAll(async () => {
    await server.app.close()
    await closeDb()
    await rm(dataDir, { recursive: true, force: true })
  })

  const base = () => `http://127.0.0.1:${server.port}`
  // fetch() drops custom Host headers, which preview routing depends on.
  const get = (path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      request({ host: '127.0.0.1', port: server.port, path, headers }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode!, body }))
      })
        .on('error', reject)
        .end()
    })
  const createDeck = async (title: string) =>
    (await server.app.inject({ method: 'POST', url: '/api/decks', headers: alice, payload: { title } })).json<Deck>()

  it('starts slidev, proxies HTTP and HMR, and reflects edits within 2 s', { timeout: 90_000 }, async () => {
    const deck = await createDeck('Preview Test')
    const res = await server.app.inject({ method: 'POST', url: `/api/decks/${deck.id}/preview`, headers: alice })
    const preview = res.json<Preview>()
    if (preview.status !== 'ready') console.log(preview.logs.join('\n'))
    expect(preview).toMatchObject({ status: 'ready', url: 'http://preview-test.localhost:3000' })

    const host = 'preview-test.localhost:3000'
    const page = await get('/', { ...alice, host })
    expect(page.status).toBe(200)
    expect(page.body).toContain('<div id="app">')

    // Without identity the preview is not served; Slidev's MCP endpoint never is.
    expect((await get('/', { host })).status).toBe(401)
    expect((await get('/__mcp', { ...alice, host })).status).toBe(404)

    const client = (await get('/@vite/client', { ...alice, host })).body
    const token = /const wsToken = "([^"]+)"/.exec(client)?.[1]
    expect(token).toBeTruthy()
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${token}`, 'vite-hmr', { headers: { ...alice, host } })
    const messages: string[] = []
    ws.on('message', (m) => messages.push(m.toString()))
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    await expect.poll(() => messages.some((m) => m.includes('"connected"'))).toBe(true)
    // An open preview (e.g. someone presenting) keeps the Slidev process from idling out.
    expect(server.previewProxy.openSockets(deck.id)).toBe(1)

    const startedAt = Date.now()
    messages.length = 0
    await server.collab.replaceContent(deck.id, `${await readFile(join(dataDir, 'decks', deck.id, 'slides.md'), 'utf8')}\n---\n\n# Neu\n`)
    await expect.poll(() => messages.some((m) => /"type":"(update|full-reload|custom)"/.test(m)), { timeout: 2000 }).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(2000)
    ws.close()
    await expect.poll(() => server.previewProxy.openSockets(deck.id)).toBe(0)
  })

  it('saves and restores versions live', async () => {
    const deck = await createDeck('Versionen')
    const initial = await readFile(join(dataDir, 'decks', deck.id, 'slides.md'), 'utf8')
    const list = async () => (await server.app.inject({ url: `/api/decks/${deck.id}/versions`, headers: alice })).json<{ sha: string; message: string; author: string }[]>()
    const [created] = await list()
    expect(created).toMatchObject({ message: 'Deck created', author: 'alice@example.com' })

    await server.collab.replaceContent(deck.id, `${initial}\n---\n\n# Zweite\n`)
    const saved = await server.app.inject({ method: 'POST', url: `/api/decks/${deck.id}/versions`, headers: alice, payload: { message: 'Mit zweiter Folie' } })
    expect(saved.statusCode).toBe(201)
    const nothing = await server.app.inject({ method: 'POST', url: `/api/decks/${deck.id}/versions`, headers: alice, payload: {} })
    expect(nothing.json()).toBeNull()

    const restored = await server.app.inject({ method: 'POST', url: `/api/decks/${deck.id}/restore`, headers: alice, payload: { sha: created!.sha } })
    expect(restored.statusCode).toBe(200)
    expect(await readFile(join(dataDir, 'decks', deck.id, 'slides.md'), 'utf8')).toBe(initial)
    expect((await list()).map((v) => v.message)).toEqual([`Restored version ${created!.sha.slice(0, 7)}`, 'Mit zweiter Folie', 'Deck created'])

    const bad = await server.app.inject({ method: 'POST', url: `/api/decks/${deck.id}/restore`, headers: alice, payload: { sha: 'zzz' } })
    expect(bad.statusCode).toBe(404)
  })

  it('stores uploaded images in public/', async () => {
    const deck = await createDeck('Bilder')
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'Mein Logo.png')
    const res = await fetch(`${base()}/api/decks/${deck.id}/assets`, { method: 'POST', headers: alice, body: form })
    expect(res.status).toBe(201)
    const { path } = (await res.json()) as { path: string }
    expect(path).toMatch(/^\/mein-logo-[a-z0-9]+\.png$/)
    expect((await readFile(join(dataDir, 'decks', deck.id, 'public', path.slice(1)))).length).toBe(4)

    const text = new FormData()
    text.append('file', new Blob(['x'], { type: 'text/html' }), 'x.html')
    expect((await fetch(`${base()}/api/decks/${deck.id}/assets`, { method: 'POST', headers: alice, body: text })).status).toBe(415)
  })
})
