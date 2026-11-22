import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InjectOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Deck, PublicDeck, PublicState } from '@slidango/shared'
import { buildApp } from './app'
import { loadConfig } from './config'
import type { Db } from './db'
import { openTestDb } from './test-db'

const alice = { 'x-auth-request-email': 'alice@example.com' }
const bob = { 'x-auth-request-email': 'bob@example.com' }

describe('public decks', () => {
  let dataDir: string
  let db: Db
  let closeDb: () => Promise<void>
  let server: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'slidango-'))
    ;({ db, close: closeDb } = await openTestDb())
    server = await buildApp(loadConfig({ DATA_DIR: dataDir, PREVIEW_URL: 'http://{slug}.localhost:3000' }), db)
    server.app.log.level = 'warn'
  })

  afterAll(async () => {
    await server.app.close()
    await closeDb()
    await rm(dataDir, { recursive: true, force: true })
  })

  const inject = (opts: InjectOptions | string) => server.app.inject(opts)

  it('publishes the last saved version as a static site without notes', { timeout: 240_000 }, async () => {
    const deck = (
      await inject({ method: 'POST', url: '/api/decks', headers: alice, payload: { title: 'Open Talk', mode: 'empty', themeId: null } })
    ).json<Deck>()
    expect(deck.public).toBe(false)

    // Saved version: one slide with a speaker note. Then an unsaved edit that must stay private.
    const slides = join(dataDir, 'decks', deck.id, 'slides.md')
    await writeFile(slides, '---\ntitle: Open Talk\neditor: false\n---\n\n# Saved headline\n\n<!-- secret speaker note -->\n')
    expect((await inject({ method: 'POST', url: `/api/decks/${deck.id}/versions`, headers: alice, payload: {} })).statusCode).toBe(201)
    await writeFile(slides, '---\ntitle: Open Talk\neditor: false\n---\n\n# Unsaved draft\n')

    // Not public yet: nothing is listed or served, signed out.
    expect((await inject({ url: '/api/public/decks' })).json()).toEqual([])
    expect((await inject({ url: `/p/${deck.slug}/` })).statusCode).toBe(404)

    // Only managers publish, never with a token.
    expect((await inject({ method: 'PUT', url: `/api/decks/${deck.id}/public`, headers: bob, payload: { public: true } })).statusCode).toBe(403)
    const token = (
      await inject({ method: 'POST', url: '/api/me/tokens', headers: alice, payload: { name: 'script', scope: 'write', expiresInDays: 30 } })
    ).json<{ token: string }>().token
    const viaToken = await inject({
      method: 'PUT',
      url: `/api/decks/${deck.id}/public`,
      headers: { authorization: `Bearer ${token}` },
      payload: { public: true },
    })
    expect(viaToken.statusCode).toBe(403)

    const published = await inject({ method: 'PUT', url: `/api/decks/${deck.id}/public`, headers: alice, payload: { public: true } })
    expect(published.json<PublicState>()).toMatchObject({ public: true, status: 'building', allowed: true })
    await server.publisher.idle()
    const state = (await inject({ url: `/api/decks/${deck.id}/public`, headers: alice })).json<PublicState>()
    expect(state).toMatchObject({ status: 'ready', url: `/p/${deck.slug}/`, error: null })

    // Listed for everyone; the site works signed out, slide routes fall back to the app.
    const listed = (await inject({ url: '/api/public/decks' })).json<PublicDeck[]>()
    expect(listed.map((d) => d.slug)).toEqual([deck.slug])
    const index = await inject({ url: `/p/${deck.slug}/` })
    expect(index.statusCode).toBe(200)
    expect(index.headers['content-type']).toMatch(/text\/html/)
    expect((await inject({ url: `/p/${deck.slug}/3` })).body).toBe(index.body)
    expect((await inject({ url: `/p/${deck.slug}` })).statusCode).toBe(302)
    expect((await inject({ url: `/p/${deck.slug}/missing.js` })).statusCode).toBe(404)
    expect((await inject({ url: `/p/${deck.slug}/..%2f..%2f..%2fdecks/${deck.id}/slides.md` })).statusCode).toBe(404)

    // The build holds the saved headline, not the draft, and no notes.
    const site = await readSite(server.publisher.siteDir(deck.id))
    expect(site).toContain('Saved headline')
    expect(site).not.toContain('Unsaved draft')
    expect(site).not.toContain('secret speaker note')

    // Unpublishing takes it offline at once.
    await inject({ method: 'PUT', url: `/api/decks/${deck.id}/public`, headers: alice, payload: { public: false } })
    expect((await inject({ url: `/p/${deck.slug}/` })).statusCode).toBe(404)
    expect((await inject({ url: '/api/public/decks' })).json()).toEqual([])
  })
})

/** All text of a built site, to search it. */
async function readSite(dir: string): Promise<string> {
  const { readdir, readFile } = await import('node:fs/promises')
  let text = ''
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(html|js|css|json)$/.test(entry.name)) text += await readFile(join(entry.parentPath, entry.name), 'utf8')
  }
  return text
}
