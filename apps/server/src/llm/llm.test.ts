import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ChatMessage, type ChatSession, type Deck, type LlmEvent, type Proposal, parseDeck } from '@slidango/shared'
import { buildApp } from '../app'
import { loadConfig } from '../config'
import type { Db } from '../db'
import { type MockHandler, type MockRequest, startMockOpenAI, textOf } from './mock-openai'
import { openTestDb } from '../test-db'

const alice = { 'x-auth-request-email': 'alice@example.com', 'x-auth-request-preferred-username': 'Alice' }
const admin = { 'x-auth-request-email': 'admin@example.com' }

let handler: MockHandler = () => ({ text: 'Hallo' })
let mock: Awaited<ReturnType<typeof startMockOpenAI>>
let dataDir: string
let db: Db
let closeDb: () => Promise<void>
let server: Awaited<ReturnType<typeof buildApp>>
let base: string

beforeAll(async () => {
  mock = await startMockOpenAI((req) => handler(req))
  dataDir = await mkdtemp(join(tmpdir(), 'slidango-llm-'))
  ;({ db, close: closeDb } = await openTestDb())
  server = await buildApp(
    loadConfig({ DATA_DIR: dataDir, ADMIN_EMAILS: 'admin@example.com', LLM_BASE_URL: mock.baseUrl, LLM_MODEL: 'mock-model' }),
    db,
  )
  server.app.log.level = 'warn'
  await server.app.listen({ port: 0, host: '127.0.0.1' })
  const address = server.app.server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(async () => {
  await server.app.close()
  await closeDb()
  await mock.close()
  await rm(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
  mock.requests.length = 0
})

async function createDeck(title: string, mode = 'empty') {
  return (await server.app.inject({ method: 'POST', url: '/api/decks', headers: alice, payload: { title, mode, themeId: null } })).json<Deck>()
}

/** POSTs to an SSE endpoint and collects all events. */
async function stream(path: string, body: unknown, headers: Record<string, string> = alice): Promise<LlmEvent[]> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as LlmEvent)
}

const content = (deckId: string) => server.collab.readContent(deckId)
const slideContents = async (deckId: string) => parseDeck(await content(deckId)).map((s) => s.content)
const proposalOf = (events: LlmEvent[]) => (events.find((e) => e.type === 'proposal') as { proposal: Proposal } | undefined)?.proposal
const post = (url: string, headers = alice) => server.app.inject({ method: 'POST', url, headers })

describe('chat', () => {
  it('turns tool calls into a proposal that applies and undoes live', async () => {
    const deck = await createDeck('Chat Deck')
    await server.collab.replaceContent(deck.id, (c) => `${c}\n---\n\n# Zweite\n`)
    handler = (req) => {
      if (req.messages.some((m) => m.role === 'tool')) return { text: 'Ich schlage eine neue zweite Folie und eine Agenda vor.' }
      return {
        toolCalls: [
          { name: 'replace_slide', arguments: { index: 2, content: '---\nlayout: center\n---\n\n# Zweite, besser' } },
          { name: 'insert_slides', arguments: { after_index: 1, contents: ['# Agenda\n\n- Eins\n- Zwei'] } },
        ],
      }
    }
    const before = await content(deck.id)
    const events = await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'Mach Folie 2 besser', cursorSlide: 2 })
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toContain('Agenda')

    // The model saw the numbered deck, the cursor and the user's message.
    const system = textOf(mock.requests[0]!.messages[0]!.content)
    expect(system).toContain('### Folie 2\n# Zweite')
    expect(system).toContain('Cursor des Users steht auf Folie 2')
    expect(mock.requests[0]!.tools?.map((t) => t.function.name)).toEqual(['replace_slide', 'insert_slides', 'delete_slides', 'move_slide'])

    const proposal = proposalOf(events)!
    expect(proposal).toMatchObject({ status: 'open', slideCount: 2 })
    expect(await content(deck.id)).toBe(before)

    const applied = await post(`/api/proposals/${proposal.id}/apply`)
    expect(applied.json()).toMatchObject({ status: 'applied' })
    expect((await slideContents(deck.id)).slice(1)).toEqual(['# Agenda\n\n- Eins\n- Zwei', '---\nlayout: center\n---\n\n# Zweite, besser'])
    expect(await readFile(join(dataDir, 'decks', deck.id, 'slides.md'), 'utf8')).toBe(await content(deck.id))

    expect((await post(`/api/proposals/${proposal.id}/apply`)).statusCode).toBe(409)
    expect((await post(`/api/proposals/${proposal.id}/undo`)).json()).toMatchObject({ status: 'undone' })
    expect(await content(deck.id)).toBe(before)

    const session = events.find((e) => e.type === 'session') as { session: ChatSession } | undefined
    expect(session?.session.title).toBe('Mach Folie 2 besser')
    const state = (
      await server.app.inject({ url: `/api/decks/${deck.id}/llm/state?session=${session!.session.id}`, headers: alice })
    ).json<{ messages: ChatMessage[]; proposals: Proposal[] }>()
    expect(state.messages.map((m) => [m.role, m.userName])).toEqual([
      ['user', 'Alice'],
      ['assistant', null],
    ])
    expect(state.messages[1]!.content.proposalId).toBe(proposal.id)

    // The conversation is Alice's own: Bob sees an empty chat for the same deck, and the
    // model gets only his history as context.
    const bob = { 'x-auth-request-email': 'bob@example.com' }
    const bobState = (await server.app.inject({ url: `/api/decks/${deck.id}/llm/state`, headers: bob })).json<{ messages: ChatMessage[]; proposals: Proposal[] }>()
    expect(bobState).toMatchObject({ sessions: [], messages: [], proposals: [] })
    handler = () => ({ text: 'Hallo Bob' })
    mock.requests.length = 0
    await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'Hallo' }, bob)
    expect(mock.requests[0]!.messages.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('starts a fresh conversation per session and can continue earlier ones', async () => {
    const deck = await createDeck('Sessions Deck')
    handler = () => ({ text: 'Antwort' })
    const sessionOf = (events: LlmEvent[]) => (events.find((e) => e.type === 'session') as { session: ChatSession }).session
    const state = async (session: string, headers: Record<string, string> = alice) =>
      (await server.app.inject({ url: `/api/decks/${deck.id}/llm/state?session=${session}`, headers })).json<{
        sessions: ChatSession[]
        messages: ChatMessage[]
      }>()

    const first = sessionOf(await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'Erste Frage' }))
    mock.requests.length = 0
    const continued = await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'Nachfrage', sessionId: first.id })
    expect(continued.some((e) => e.type === 'session')).toBe(false)
    // Continuing sends the earlier turns as context.
    expect(mock.requests[0]!.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])

    mock.requests.length = 0
    const second = sessionOf(await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'Ganz neues Thema' }))
    expect(second.id).not.toBe(first.id)
    // A new session starts without the old conversation.
    expect(mock.requests[0]!.messages.map((m) => m.role)).toEqual(['system', 'user'])

    const now = await state(second.id)
    expect(now.sessions.map((s) => s.title)).toEqual(['Ganz neues Thema', 'Erste Frage'])
    expect(now.messages.map((m) => m.content.text)).toEqual(['Ganz neues Thema', 'Antwort'])
    expect((await state(first.id)).messages).toHaveLength(4)

    // Someone else can neither read nor continue the conversation.
    const bob = { 'x-auth-request-email': 'bob@example.com' }
    expect((await state(first.id, bob)).messages).toEqual([])
    const foreign = await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'Hi', sessionId: first.id }, bob)
    expect(foreign).toContainEqual({ type: 'error', message: 'Conversation not found' })
    expect((await state(first.id)).messages).toHaveLength(4)
  })

  it('reports invalid tool calls back to the model so it can correct them', async () => {
    const deck = await createDeck('Fehler Deck')
    let round = 0
    handler = (req) => {
      round++
      const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool')
      if (round === 1) return { toolCalls: [{ name: 'replace_slide', arguments: { index: 1, content: '---\nlayout: fancy\n---\n# X' } }] }
      if (round === 2) {
        expect(textOf(lastTool?.content)).toMatch(/Layout "fancy" doesn’t exist/)
        return { toolCalls: [{ name: 'delete_slides', arguments: { indexes: [1] } }] }
      }
      if (round === 3) {
        expect(textOf(lastTool?.content)).toMatch(/Slide 1 holds the deck settings/)
        return { toolCalls: [{ name: 'insert_slides', arguments: { after_index: 1, contents: ['---\nlayout: center\n---\n# Ok'] } }] }
      }
      return { text: 'Erledigt.' }
    }
    const events = await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'Mach was' })
    expect(proposalOf(events)?.ops).toEqual([{ type: 'insert', after: 1, contents: ['---\nlayout: center\n---\n# Ok'] }])
  })

  it('marks a proposal stale when its slides changed meanwhile, but not for other slides', async () => {
    const deck = await createDeck('Stale Deck')
    await server.collab.replaceContent(deck.id, (c) => `${c}\n---\n\n# Zwei\n\n---\n\n# Drei\n`)
    handler = (req) =>
      req.messages.some((m) => m.role === 'tool')
        ? { text: 'ok' }
        : { toolCalls: [{ name: 'replace_slide', arguments: { index: 2, content: '# Zwei neu' } }] }

    const first = proposalOf(await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'a' }))!
    await server.collab.replaceContent(deck.id, (c) => c.replace('# Drei', '# Drei (Bob)'))
    expect((await post(`/api/proposals/${first.id}/apply`)).json()).toMatchObject({ status: 'applied' })
    expect(await content(deck.id)).toContain('# Drei (Bob)')

    const second = proposalOf(await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'b' }))!
    await server.collab.replaceContent(deck.id, (c) => c.replace('# Zwei neu', '# Zwei (Bob)'))
    expect((await post(`/api/proposals/${second.id}/apply`)).json()).toMatchObject({ status: 'stale' })
    expect(await content(deck.id)).toContain('# Zwei (Bob)')
  })

  it('applies right away for users who opted in', async () => {
    const deck = await createDeck('Auto Deck')
    await server.app.inject({ method: 'PATCH', url: '/api/me', headers: alice, payload: { autoApply: true } })
    handler = (req) =>
      req.messages.some((m) => m.role === 'tool')
        ? { text: 'ok' }
        : { toolCalls: [{ name: 'insert_slides', arguments: { after_index: 1, contents: ['# Direkt'] } }] }
    const proposal = proposalOf(await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'x' }))!
    expect(proposal.status).toBe('applied')
    expect(await slideContents(deck.id)).toContain('# Direkt')
    await server.app.inject({ method: 'PATCH', url: '/api/me', headers: alice, payload: { autoApply: false } })
  })

  it('answers without a proposal when no tools are used', async () => {
    const deck = await createDeck('Frage Deck')
    handler = () => ({ text: 'Das Deck hat eine Folie.' })
    const events = await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'Wie viele Folien?' })
    expect(proposalOf(events)).toBeUndefined()
    expect(events.at(-1)).toEqual({ type: 'done' })
  })
})

describe('briefing, outline and first draft', () => {
  it('stores the briefing and extracts text from uploaded files', async () => {
    const deck = await createDeck('Briefing Deck', 'assistant')
    expect((await server.app.inject({ url: `/api/decks/${deck.id}/llm/state`, headers: alice })).json()).toMatchObject({ empty: true })

    const saved = await server.app.inject({
      method: 'PUT',
      url: `/api/decks/${deck.id}/briefing`,
      headers: alice,
      payload: { topic: 'Kaffee', goal: 'Mehr Kaffee', audience: 'Team', slideCount: 3 },
    })
    expect(saved.json()).toMatchObject({ fields: { topic: 'Kaffee', language: 'Deutsch', slideCount: 3 }, files: [] })

    const form = new FormData()
    form.append('file', new Blob([minimalPdf('Bohnen aus Wien') as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), 'notizen.pdf')
    const upload = await fetch(`${base}/api/decks/${deck.id}/briefing/files`, { method: 'POST', headers: alice, body: form })
    expect(upload.status).toBe(201)
    const briefing = await server.agent.briefing(deck.id)
    expect(briefing?.files[0]).toMatchObject({ name: 'notizen.pdf', type: 'pdf' })
    expect(briefing?.files[0]?.text).toContain('Bohnen aus Wien')

    const bad = new FormData()
    bad.append('file', new Blob(['x']), 'virus.exe')
    expect((await fetch(`${base}/api/decks/${deck.id}/briefing/files`, { method: 'POST', headers: alice, body: bad })).status).toBe(415)
  })

  it('creates an outline, then drafts slide by slide into the empty deck', async () => {
    const deck = await createDeck('Entwurf Deck', 'assistant')
    await server.app.inject({
      method: 'PUT',
      url: `/api/decks/${deck.id}/briefing`,
      headers: alice,
      payload: { topic: 'Kaffee', goal: 'Mehr Kaffee', slideCount: 3 },
    })

    handler = (req: MockRequest) => {
      expect(req.tool_choice).toEqual({ type: 'function', function: { name: 'set_outline' } })
      expect(textOf(req.messages[0]!.content)).toContain('Plane genau 3 Folien.')
      return {
        toolCalls: [
          {
            name: 'set_outline',
            arguments: {
              slides: [
                { title: 'Kaffee', message: 'Warum Kaffee', layout: 'cover' },
                { title: 'Fakten', message: 'Zahlen', layout: 'erfunden' },
                { title: 'Fazit', message: 'Mehr trinken', layout: 'end' },
              ],
            },
          },
        ],
      }
    }
    const outlineEvents = await stream(`/api/decks/${deck.id}/llm/outline`, {})
    const outline = (outlineEvents.find((e) => e.type === 'outline') as { items: { title: string; layout: string }[] }).items
    expect(outline.map((o) => o.layout)).toEqual(['cover', 'default', 'end'])

    // The user edits the outline before drafting; one slide comes back broken twice.
    const edited = [...outline.slice(0, 2), { title: 'Danke', message: 'Abschluss', layout: 'end' }]
    handler = (req) => {
      const system = textOf(req.messages[0]!.content)
      const n = Number(/Schreibe Folie (\d+) von/.exec(system)![1])
      expect(system).toContain('Anmerkungen zur Gliederung\n\nKurz halten')
      if (n === 1) return { text: '```markdown\n---\nlayout: cover\nclass: text-center\n---\n\n# Kaffee\n\n<!-- Begrüßung -->\n```' }
      if (n === 2) return { text: '---\nlayout: kaputt\n---\n\n# Fakten' }
      return { text: '---\nlayout: end\n---\n\n# Danke\n\n<!-- Schluss -->' }
    }
    const events = await stream(`/api/decks/${deck.id}/llm/draft`, { outline: edited, remarks: 'Kurz halten' })
    expect(events.filter((e) => e.type === 'slide').map((e) => (e as { index: number }).index)).toEqual([1, 2, 3])
    expect((events[1] as { warning?: string }).warning).toMatch(/kaputt/)
    expect(events.at(-1)).toEqual({ type: 'done' })

    const slides = parseDeck(await content(deck.id))
    expect(slides).toHaveLength(3)
    expect(slides[0]!.content).toMatch(/^---\ntitle: "Entwurf Deck"\neditor: false\nlayout: cover\nclass: text-center\n---\n\n# Kaffee\n\n<!-- Begrüßung -->$/)
    expect(slides[1]!.content).toMatch(/^---\nlayout: kaputt\n---\n\n<!-- Note: checked automatically.*kaputt.* -->\n\n# Fakten$/)
    expect(slides[2]!.layout).toBe('end')
    expect((await server.versions.list(deck.id))[0]!.message).toBe('Erstentwurf (LLM)')

    // Drafting needs an empty deck; "Verwerfen" empties it again.
    const again = await stream(`/api/decks/${deck.id}/llm/draft`, { outline: edited, remarks: '' })
    expect(again.at(-1)).toEqual({ type: 'error', message: 'The first draft needs an empty deck.' })
    await post(`/api/decks/${deck.id}/llm/draft/discard`)
    expect(await content(deck.id)).toBe('---\ntitle: "Entwurf Deck"\neditor: false\nlayout: cover\nclass: text-center\n---\n')
  })
})

describe('settings', () => {
  it('lets admins configure the endpoint without exposing the key', async () => {
    expect((await server.app.inject({ url: '/api/admin/settings', headers: alice })).statusCode).toBe(403)
    const res = await server.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: admin,
      payload: { baseUrl: mock.baseUrl, model: 'other-model', apiKey: 'sk-secret' },
    })
    expect(res.json()).toEqual({ baseUrl: mock.baseUrl, model: 'other-model', hasApiKey: true, vision: false })
    expect(res.body).not.toContain('sk-secret')
    // An empty key keeps the stored one.
    await server.app.inject({ method: 'PUT', url: '/api/admin/settings', headers: admin, payload: { baseUrl: mock.baseUrl, model: 'mock-model', apiKey: '' } })
    expect((await server.llm.get()).apiKey).toBe('sk-secret')
  })

  it('reports a missing configuration as a readable error', async () => {
    await server.app.inject({ method: 'PUT', url: '/api/admin/settings', headers: admin, payload: { baseUrl: 'http://127.0.0.1:9/v1', model: 'x' } })
    const deck = await createDeck('Offline Deck')
    const events = await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'Hallo' })
    expect(events.at(-1)).toEqual({ type: 'error', message: 'The LLM endpoint is not reachable. Check Settings → Slidango AI.' })
    await server.app.inject({ method: 'PUT', url: '/api/admin/settings', headers: admin, payload: { baseUrl: mock.baseUrl, model: 'mock-model' } })
  })
})

/** A one-page PDF with a line of text, built by hand so the test needs no fixtures. */
function minimalPdf(text: string): Uint8Array<ArrayBuffer> {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}
