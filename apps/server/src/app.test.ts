import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { type Deck, SLIDES_TEXT, collabDocumentName } from '@slidango/shared'
import { buildApp } from './app'
import { loadConfig } from './config'
import { type Db, openDb, schema } from './db'
import { eq } from 'drizzle-orm'

const alice = { 'x-auth-request-email': 'alice@example.com', 'x-auth-request-preferred-username': 'Alice' }
const bob = { 'x-auth-request-email': 'Bob@Example.com', 'x-auth-request-user': 'bob' }

let dataDir: string
let db: Db
let closeDb: () => Promise<void>

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'slidango-'))
  ;({ db, close: closeDb } = await openDb(process.env.TEST_DATABASE_URL ?? 'pglite:memory'))
})

afterAll(async () => {
  await closeDb()
  await rm(dataDir, { recursive: true, force: true })
})

async function start() {
  const config = { ...loadConfig({ DATA_DIR: dataDir, ADMIN_EMAILS: 'alice@example.com' }), storeDebounceMs: 200 }
  const built = await buildApp(config, db)
  built.app.log.level = 'warn'
  await built.app.listen({ port: 0, host: '127.0.0.1' })
  const address = built.app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { ...built, port }
}

function connect(port: number, deckId: string, headers: Record<string, string>) {
  class AuthedWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, { headers })
    }
  }
  const document = new Y.Doc()
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}/collab`,
    WebSocketPolyfill: AuthedWebSocket,
  })
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: collabDocumentName(deckId),
    document,
    token: 'proxy',
  })
  provider.attach()
  const synced = new Promise<void>((resolve, reject) => {
    provider.on('synced', () => resolve())
    provider.on('authenticationFailed', () => reject(new Error('authentication failed')))
  })
  const destroy = () => {
    provider.destroy()
    socket.destroy()
  }
  return { destroy, text: document.getText(SLIDES_TEXT), synced }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
  return Date.now() - start
}

describe('API', () => {
  it('rejects requests without identity', async () => {
    const { app } = await start()
    expect((await app.inject({ url: '/api/me' })).statusCode).toBe(401)
    await app.close()
  })

  it('creates users from proxy headers and manages decks', async () => {
    const { app } = await start()
    const me = (await app.inject({ url: '/api/me', headers: alice })).json()
    expect(me).toMatchObject({ email: 'alice@example.com', name: 'Alice', isAdmin: true })
    expect((await app.inject({ url: '/api/me', headers: bob })).json()).toMatchObject({
      email: 'bob@example.com',
      name: 'bob',
      isAdmin: false,
    })

    const create = (title: string) =>
      app.inject({ method: 'POST', url: '/api/decks', headers: alice, payload: { title } })
    const first = (await create('Quartalsbericht Q4')).json<Deck>()
    const second = (await create('Quartalsbericht Q4')).json<Deck>()
    expect(first.slug).toBe('quartalsbericht-q4')
    expect(second.slug).toBe('quartalsbericht-q4-2')
    expect((await create('')).statusCode).toBe(400)

    const slides = await readFile(join(dataDir, 'decks', first.id, 'slides.md'), 'utf8')
    expect(slides).toContain('editor: false')

    const renamed = await app.inject({ method: 'PATCH', url: `/api/decks/${first.id}`, headers: bob, payload: { title: 'Neu' } })
    expect(renamed.json()).toMatchObject({ title: 'Neu', slug: 'quartalsbericht-q4' })

    await app.inject({ method: 'DELETE', url: `/api/decks/${second.id}`, headers: alice })
    const listed = (await app.inject({ url: '/api/decks', headers: alice })).json<Deck[]>()
    expect(listed.map((d) => d.id)).toContain(first.id)
    expect(listed.map((d) => d.id)).not.toContain(second.id)

    expect((await app.inject({ url: '/api/decks/not-a-uuid', headers: alice })).statusCode).toBe(404)
    await app.close()
  })
})

describe('collaboration', () => {
  it('syncs two editors, writes slides.md quickly and survives a restart', async () => {
    let server = await start()
    const deck = (
      await server.app.inject({ method: 'POST', url: '/api/decks', headers: alice, payload: { title: 'Collab' } })
    ).json<Deck>()
    const slidesPath = join(dataDir, 'decks', deck.id, 'slides.md')

    const a = connect(server.port, deck.id, alice)
    const b = connect(server.port, deck.id, bob)
    await Promise.all([a.synced, b.synced])
    expect(a.text.toString()).toContain('# Collab')

    a.text.insert(a.text.length, '\n---\n\nFolie von Alice\n')
    b.text.insert(0, '<!-- Bob -->\n')
    await waitFor(() => a.text.toString() === b.text.toString() && a.text.toString().includes('Bob'))
    const expected = a.text.toString()

    const elapsed = await waitFor(async () => (await readFile(slidesPath, 'utf8')) === expected)
    expect(elapsed).toBeLessThan(1000)

    a.destroy()
    b.destroy()
    await server.app.close()

    server = await start()
    const c = connect(server.port, deck.id, alice)
    await c.synced
    expect(c.text.toString()).toBe(expected)
    c.destroy()
    await server.app.close()
  })

  it('rejects unauthenticated sockets and unknown decks', async () => {
    const server = await start()
    const unknown = connect(server.port, '00000000-0000-0000-0000-000000000000', alice)
    await expect(unknown.synced).rejects.toThrow('authentication failed')
    unknown.destroy()
    await server.app.close()
  })

  it('keeps slides.md the single writer path for server-side changes', async () => {
    const server = await start()
    const deck = (
      await server.app.inject({ method: 'POST', url: '/api/decks', headers: alice, payload: { title: 'Direct' } })
    ).json<Deck>()
    const a = connect(server.port, deck.id, alice)
    await a.synced
    const direct = await server.collab.hocuspocus.openDirectConnection(collabDocumentName(deck.id))
    await direct.transact((doc) => doc.getText(SLIDES_TEXT).insert(0, '<!-- server -->\n'))
    await direct.disconnect()
    await waitFor(() => a.text.toString().startsWith('<!-- server -->'))
    await waitFor(async () => (await readFile(join(dataDir, 'decks', deck.id, 'slides.md'), 'utf8')).startsWith('<!-- server -->'))
    a.destroy()
    await server.app.close()
  })
})

describe('document seeding', () => {
  it('stores the Yjs state at creation, so a reload can never seed the text a second time', async () => {
    const server = await start()
    const deck = (
      await server.app.inject({ method: 'POST', url: '/api/decks', headers: alice, payload: { title: 'Seed' } })
    ).json<Deck>()
    // Before any client connected: a crash now must not lead to a second, differently-identified seed.
    const [row] = await db.select().from(schema.yjsDocuments).where(eq(schema.yjsDocuments.deckId, deck.id))
    const stored = new Y.Doc()
    Y.applyUpdate(stored, row!.state)
    expect(stored.getText(SLIDES_TEXT).toString()).toContain('# Seed')

    // A client holding that state merges with a freshly loaded server without duplicates.
    const a = connect(server.port, deck.id, alice)
    await a.synced
    expect(a.text.toString().match(/# Seed/g)).toHaveLength(1)
    a.destroy()
    await server.app.close()
  })
})
