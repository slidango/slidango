import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Deck, DeckAccess, DeckRole } from '@slidango/shared'
import { buildApp } from './app'
import { can } from './auth'
import { loadConfig } from './config'
import type { Db } from './db'
import { openTestDb } from './test-db'

const owner = { 'x-auth-request-email': 'owner@example.com', 'x-auth-request-preferred-username': 'Olivia' }
const other = { 'x-auth-request-email': 'other@example.com', 'x-auth-request-preferred-username': 'Oscar' }
const admin = { 'x-auth-request-email': 'admin@example.com' }

let dataDir: string
let db: Db
let closeDb: () => Promise<void>

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'slidango-access-'))
  ;({ db, close: closeDb } = await openTestDb())
})

afterAll(async () => {
  await closeDb()
  await rm(dataDir, { recursive: true, force: true })
})

async function start() {
  const built = await buildApp(
    loadConfig({ DATA_DIR: dataDir, ADMIN_EMAILS: 'admin@example.com', PREVIEW_URL: 'http://{slug}.slides.localhost:3000' }),
    db,
  )
  built.app.log.level = 'silent'
  return built
}

describe('can()', () => {
  const user = { id: 'u', email: 'u@x', name: 'U', isAdmin: false, autoApply: false }
  const deck = (access: DeckAccess, role: DeckRole | null) => ({ id: 'd', ownerId: 'o', access, role })

  it('combines roles, deck access, admin rights and token scope', () => {
    const matrix: [DeckAccess, DeckRole | null, string][] = [
      ['team-edit', null, 'view,edit'],
      ['team-view', null, 'view'],
      ['members', null, ''],
      ['members', 'viewer', 'view'],
      ['members', 'editor', 'view,edit'],
      ['team-view', 'owner', 'view,edit,manage'],
    ]
    for (const [access, role, allowed] of matrix) {
      const got = (['view', 'edit', 'manage'] as const).filter((a) => can(user, deck(access, role), a)).join(',')
      expect(got, `${access}/${role}`).toBe(allowed)
    }
    expect(can({ ...user, isAdmin: true }, deck('members', null), 'manage')).toBe(true)
    const readToken = { user, via: 'token' as const, token: { id: 't', name: 'T', scope: 'read' as const } }
    expect(can(readToken, deck('members', 'owner'), 'view')).toBe(true)
    expect(can(readToken, deck('members', 'owner'), 'edit')).toBe(false)
    expect(can(null, deck('team-edit', null), 'view')).toBe(false)
  })
})

describe('deck sharing', () => {
  it('hides members-only decks, shares them by role and transfers ownership', async () => {
    const { app } = await start()
    const create = await app.inject({ method: 'POST', url: '/api/decks', headers: owner, payload: { title: 'Secret plans' } })
    const deck = create.json() as Deck
    expect(deck).toMatchObject({ access: 'team-edit', role: 'owner', can: { edit: true, manage: true } })
    const otherId = (await app.inject({ url: '/api/me', headers: other })).json().id

    // team-edit: others may edit, but not manage (rename, archive, share).
    const seen = (await app.inject({ url: `/api/decks/${deck.id}`, headers: other })).json()
    expect(seen).toMatchObject({ role: null, can: { edit: true, manage: false } })
    expect((await app.inject({ method: 'PATCH', url: `/api/decks/${deck.id}`, headers: other, payload: { title: 'X' } })).statusCode).toBe(403)

    // members: invisible to others (404, not 403) and missing from their list.
    await app.inject({ method: 'PUT', url: `/api/decks/${deck.id}/access`, headers: owner, payload: { access: 'members' } })
    expect((await app.inject({ url: `/api/decks/${deck.id}`, headers: other })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/decks', headers: other })).json().map((d: Deck) => d.id)).not.toContain(deck.id)
    expect((await app.inject({ url: '/api/decks', headers: admin })).json().map((d: Deck) => d.id)).toContain(deck.id)
    expect((await app.inject({ url: '/', headers: { ...other, host: `${deck.slug}.slides.localhost` } })).statusCode).toBe(404)

    // viewer: may look, not type.
    await app.inject({ method: 'PUT', url: `/api/decks/${deck.id}/members/${otherId}`, headers: owner, payload: { role: 'viewer' } })
    expect((await app.inject({ url: `/api/decks/${deck.id}`, headers: other })).json()).toMatchObject({
      role: 'viewer',
      can: { edit: false, manage: false },
    })
    expect((await app.inject({ method: 'POST', url: `/api/decks/${deck.id}/versions`, headers: other, payload: {} })).statusCode).toBe(403)

    // Ownership moves; the previous owner stays as editor.
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/decks/${deck.id}/members/${deck.ownerId}`, headers: owner })).statusCode,
    ).toBe(409)
    const transferred = await app.inject({
      method: 'PUT',
      url: `/api/decks/${deck.id}/members/${otherId}`,
      headers: owner,
      payload: { role: 'owner' },
    })
    expect(transferred.json().members).toEqual([
      expect.objectContaining({ userId: otherId, role: 'owner' }),
      expect.objectContaining({ userId: deck.ownerId, role: 'editor' }),
    ])
    expect((await app.inject({ url: `/api/decks/${deck.id}`, headers: owner })).json().can).toEqual({ edit: true, manage: false })
    await app.close()
  }, 30_000)
})

describe('API tokens and MCP', () => {
  it('acts as its owner, never as admin, and stops when revoked', async () => {
    const { app } = await start()
    const created = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: admin,
      payload: { name: 'Script', scope: 'read', expiresInDays: 30 },
    })
    expect(created.statusCode).toBe(201)
    const { token, id, prefix } = created.json()
    expect(token).toMatch(/^sld_/)
    expect(token.startsWith(prefix)).toBe(true)
    const bearer = { authorization: `Bearer ${token}` }

    expect((await app.inject({ url: '/api/me', headers: bearer })).json()).toMatchObject({ email: 'admin@example.com', isAdmin: false })
    expect((await app.inject({ url: '/api/decks', headers: bearer })).statusCode).toBe(200)
    // Read scope, no admin, no minting more tokens.
    expect((await app.inject({ method: 'POST', url: '/api/decks', headers: bearer, payload: { title: 'Nope' } })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/admin/people', headers: bearer })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/me/tokens', headers: bearer, payload: {} })).statusCode).toBe(403)
    // The list never contains the secret.
    const list = (await app.inject({ url: '/api/me/tokens', headers: admin })).json()
    expect(list).toEqual([expect.objectContaining({ id, name: 'Script', scope: 'read' })])
    expect(JSON.stringify(list)).not.toContain(token)

    await app.inject({ method: 'DELETE', url: `/api/me/tokens/${id}`, headers: admin })
    expect((await app.inject({ url: '/api/me', headers: bearer })).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/me', headers: { authorization: 'Bearer sld_not-a-real-token-at-all' } })).statusCode).toBe(401)
    await app.close()
  })

  it('serves the MCP tools: read, propose, review in the app', async () => {
    const built = await start()
    const { app } = built
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const deck = (await app.inject({ method: 'POST', url: '/api/decks', headers: owner, payload: { title: 'MCP Deck' } })).json() as Deck
    const mint = async (headers: Record<string, string>, scope: 'read' | 'write') =>
      (await app.inject({ method: 'POST', url: '/api/me/tokens', headers, payload: { name: 'Claude Code', scope, expiresInDays: null } })).json()
        .token as string
    const writeToken = await mint(owner, 'write')

    // Without a token the endpoint refuses, even with valid proxy headers.
    expect((await app.inject({ method: 'POST', url: '/mcp', headers: owner, payload: {} })).statusCode).toBe(401)

    const connect = async (token: string) => {
      const client = new Client({ name: 'test', version: '1.0.0' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      )
      return client
    }
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
      const text = result.content[0]!.text
      let data: unknown = text
      try {
        data = JSON.parse(text)
      } catch {
        // plain-text error
      }
      return { data: data as Record<string, unknown> & unknown[], error: result.isError === true, text }
    }

    const client = await connect(writeToken)
    const tools = (await client.listTools()).tools.map((t) => t.name)
    expect(tools).toEqual(
      expect.arrayContaining(['list_decks', 'read_deck', 'get_template_guide', 'propose_changes', 'save_version', 'create_deck']),
    )

    const decks = (await call(client, 'list_decks', {})).data as unknown as { id: string; canEdit: boolean }[]
    expect(decks.find((d) => d.id === deck.id)).toMatchObject({ canEdit: true })

    const read = (await call(client, 'read_deck', { deck_id: deck.id })).data as unknown as {
      slides: { index: number; hash: string; content: string }[]
    }
    expect(read.slides).toHaveLength(1)

    // The same checks as Slidango AI: unknown layouts and slide 1 are refused with a reason.
    const badLayout = await call(client, 'propose_changes', {
      deck_id: deck.id,
      summary: 'x',
      operations: [{ type: 'insert', after: 1, contents: ['---\nlayout: fancy\n---\n\n# Hi'] }],
    })
    expect(badLayout.error).toBe(true)
    expect(badLayout.text).toMatch(/Layout "fancy" doesn’t exist/)
    const first = await call(client, 'propose_changes', { deck_id: deck.id, summary: 'x', operations: [{ type: 'delete', indexes: [1] }] })
    expect(first.text).toMatch(/Slide 1 holds the deck settings/)

    const proposed = await call(client, 'propose_changes', {
      deck_id: deck.id,
      summary: 'Add an agenda',
      operations: [{ type: 'insert', after: 1, contents: ['# Agenda\n\n- One\n- Two'] }],
      base_hashes: { 1: read.slides[0]!.hash },
    })
    expect(proposed.data).toMatchObject({ status: 'open' })

    // The proposal shows up for its owner in the app, marked as coming from the MCP client.
    const inApp = (await app.inject({ url: `/api/decks/${deck.id}/llm/state`, headers: owner })).json()
    const proposals = (Array.isArray(inApp) ? inApp : inApp.proposals) as { id: string; source: string; client: string }[]
    expect(proposals.find((p) => p.id === proposed.data.proposalId)).toMatchObject({ source: 'mcp', client: 'Claude Code' })

    // Applying from MCP needs "Apply directly"; the person can always apply in the app.
    expect((await call(client, 'apply_proposal', { proposal_id: proposed.data.proposalId })).text).toMatch(/Apply directly/)
    await app.inject({ method: 'PATCH', url: '/api/me', headers: owner, payload: { autoApply: true } })
    expect((await call(client, 'apply_proposal', { proposal_id: proposed.data.proposalId })).data).toMatchObject({ status: 'applied' })
    expect((await call(client, 'read_deck', { deck_id: deck.id })).data).toMatchObject({ slideCount: 2 })
    expect((await call(client, 'save_version', { deck_id: deck.id, message: 'Agenda via MCP' })).data).toMatchObject({ saved: true })

    // Read tokens and other people's limits apply.
    const reader = await connect(await mint(other, 'read'))
    expect((await call(reader, 'read_deck', { deck_id: deck.id })).error).toBe(false)
    expect((await call(reader, 'propose_changes', { deck_id: deck.id, summary: 'x', operations: [{ type: 'delete', indexes: [2] }] })).text).toMatch(
      /read-only/,
    )
    await app.inject({ method: 'PUT', url: `/api/decks/${deck.id}/access`, headers: owner, payload: { access: 'members' } })
    expect((await call(reader, 'read_deck', { deck_id: deck.id })).text).toMatch(/not found/)

    const created = await call(client, 'create_deck', { title: 'From Claude' })
    expect(created.data).toMatchObject({ title: 'From Claude' })

    await client.close()
    await reader.close()
    await app.close()
  }, 60_000)
})
