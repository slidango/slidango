import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { APIConnectionError, APIError } from 'openai'
import { extractText, getDocumentProxy } from 'unpdf'
import { z } from 'zod'
import {
  type BriefingFile,
  type LlmEvent,
  briefingFieldsSchema,
  chatRequestSchema,
  draftRequestSchema,
  isDeckEmpty,
  llmSettingsSchema,
} from '@slidango/shared'
import { type Action, type Users, can } from '../auth'
import type { Collab } from '../collab'
import { type Db, schema } from '../db'
import type { Decks } from '../decks'
import type { Versions } from '../versions'
import { type Agent, LlmError } from './agent'
import { type LlmConfig, LlmNotConfiguredError } from './settings'

const MAX_BRIEFING_FILE = 20 * 1024 * 1024
const MAX_BRIEFING_FILES = 10
const MAX_FILE_TEXT = 200_000

function fileType(name: string): BriefingFile['type'] | null {
  const ext = extname(name).toLowerCase()
  if (['.md', '.markdown', '.txt'].includes(ext)) return 'text'
  if (ext === '.pdf') return 'pdf'
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image'
  return null
}

/** Streams LLM events as Server-Sent Events; the request's lifetime is the abort signal. */
async function sse(req: FastifyRequest, reply: FastifyReply, run: (emit: (e: LlmEvent) => void, signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController()
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort()
  })
  reply.hijack()
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  })
  const emit = (event: LlmEvent) => {
    if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  try {
    await run(emit, controller.signal)
    emit({ type: 'done' })
  } catch (err) {
    if (controller.signal.aborted) return reply.raw.end()
    emit({ type: 'error', message: describeError(req, err) })
  }
  reply.raw.end()
}

function describeError(req: FastifyRequest, err: unknown): string {
  if (err instanceof LlmError || err instanceof LlmNotConfiguredError) return err.message
  if (err instanceof APIConnectionError) {
    req.log.warn({ err: err.message }, 'LLM endpoint unreachable')
    return 'The LLM endpoint is not reachable. Check Settings → Slidango AI.'
  }
  if (err instanceof APIError && err.status) {
    req.log.warn({ status: err.status, err: err.message }, 'LLM endpoint error')
    return `The LLM endpoint returned error ${err.status}: ${err.message}`
  }
  req.log.error(err)
  return 'Internal error while calling the LLM'
}

export function registerLlmRoutes(
  app: FastifyInstance,
  deps: {
    db: Db
    agent: Agent
    llm: LlmConfig
    decks: Decks
    collab: Collab
    versions: Versions
    users: Users
    loadDeck: (req: FastifyRequest<{ Params: { id: string } }>, action: Action) => Promise<typeof schema.decks.$inferSelect>
  },
) {
  const { db, agent, llm, decks, collab, loadDeck } = deps
  const drafting = new Set<string>()

  app.get('/api/llm/status', async () => {
    const settings = await llm.public()
    return { configured: Boolean(settings.baseUrl && settings.model) }
  })

  app.get<{ Params: { id: string } }>('/api/decks/:id/briefing', async (req) => {
    await loadDeck(req, 'view')
    return (await agent.briefing(req.params.id)) ?? { fields: briefingFieldsSchema.parse({}), files: [] }
  })

  app.put<{ Params: { id: string } }>('/api/decks/:id/briefing', async (req) => {
    await loadDeck(req, 'edit')
    const fields = briefingFieldsSchema.parse(req.body)
    await db
      .insert(schema.briefings)
      .values({ deckId: req.params.id, fields })
      .onConflictDoUpdate({ target: schema.briefings.deckId, set: { fields, updatedAt: new Date() } })
    return agent.briefing(req.params.id)
  })

  app.post<{ Params: { id: string } }>('/api/decks/:id/briefing/files', async (req, reply) => {
    const deck = await loadDeck(req, 'edit')
    const file = await req.file()
    if (!file) throw app.httpErrors.badRequest('No file')
    const type = fileType(file.filename)
    if (!type) throw app.httpErrors.unsupportedMediaType('Allowed: MD, TXT, PDF, PNG, JPG, WebP, GIF')
    const data = await file.toBuffer()
    if (file.file.truncated || data.length > MAX_BRIEFING_FILE) throw app.httpErrors.payloadTooLarge('20 MB at most')
    const current = (await agent.briefing(deck.id)) ?? { fields: briefingFieldsSchema.parse({}), files: [] }
    if (current.files.length >= MAX_BRIEFING_FILES) throw app.httpErrors.badRequest(`${MAX_BRIEFING_FILES} files at most`)

    let text: string | undefined
    if (type === 'text') text = data.toString('utf8')
    if (type === 'pdf') {
      try {
        text = (await extractText(await getDocumentProxy(new Uint8Array(data)), { mergePages: true })).text
      } catch {
        throw app.httpErrors.badRequest('Couldn’t read the PDF')
      }
    }
    const entry: BriefingFile = {
      id: `${randomUUID()}${extname(file.filename).toLowerCase()}`,
      name: file.filename.slice(0, 200),
      type,
      text: text?.slice(0, MAX_FILE_TEXT),
      size: data.length,
    }
    const dir = join(decks.dir(deck.id), '.briefing')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, entry.id), data)
    const files = [...current.files, entry]
    await db
      .insert(schema.briefings)
      .values({ deckId: deck.id, fields: current.fields, files })
      .onConflictDoUpdate({ target: schema.briefings.deckId, set: { files, updatedAt: new Date() } })
    return reply.code(201).send({ ...entry, text: undefined })
  })

  app.delete<{ Params: { id: string; fileId: string } }>('/api/decks/:id/briefing/files/:fileId', async (req) => {
    const deck = await loadDeck(req, 'edit')
    const current = await agent.briefing(deck.id)
    if (!current?.files.some((f) => f.id === req.params.fileId)) throw app.httpErrors.notFound()
    const files = current.files.filter((f) => f.id !== req.params.fileId)
    await db.update(schema.briefings).set({ files, updatedAt: new Date() }).where(eq(schema.briefings.deckId, deck.id))
    await rm(join(decks.dir(deck.id), '.briefing', req.params.fileId), { force: true })
    return { ok: true }
  })

  app.get<{ Params: { id: string } }>('/api/decks/:id/layouts', async (req) => {
    await loadDeck(req, 'view')
    return agent.layouts(req.params.id)
  })

  app.get<{ Params: { id: string }; Querystring: { session?: string } }>('/api/decks/:id/llm/state', async (req) => {
    await loadDeck(req, 'view')
    const session = req.query.session && /^[0-9a-f-]{36}$/i.test(req.query.session) ? req.query.session : null
    return {
      empty: isDeckEmpty(await collab.readContent(req.params.id)),
      drafting: drafting.has(req.params.id),
      sessions: await agent.sessions(req.params.id, req.user!.id),
      messages: await agent.history(req.params.id, req.user!.id, session),
      proposals: await agent.proposals(req.params.id, req.user!.id),
    }
  })

  app.post<{ Params: { id: string } }>('/api/decks/:id/llm/outline', async (req, reply) => {
    await loadDeck(req, 'edit')
    await sse(req, reply, async (emit, signal) => {
      await agent.outline(req.params.id, emit, signal)
    })
  })

  app.post<{ Params: { id: string } }>('/api/decks/:id/llm/draft', async (req, reply) => {
    const deck = await loadDeck(req, 'edit')
    if (deck.archived) throw app.httpErrors.conflict('Deck is archived')
    const { outline, remarks } = draftRequestSchema.parse(req.body)
    if (drafting.has(deck.id)) throw app.httpErrors.conflict('A draft is already running for this deck')
    drafting.add(deck.id)
    try {
      await sse(req, reply, (emit, signal) => agent.draft(deck.id, req.user!, outline, remarks, emit, signal))
    } finally {
      drafting.delete(deck.id)
    }
  })

  app.post<{ Params: { id: string } }>('/api/decks/:id/llm/draft/discard', async (req) => {
    const deck = await loadDeck(req, 'edit')
    if (drafting.has(deck.id)) throw app.httpErrors.conflict('The draft is still running')
    await agent.discardDraft(deck.id)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/decks/:id/llm/chat', async (req, reply) => {
    const deck = await loadDeck(req, 'edit')
    if (deck.archived) throw app.httpErrors.conflict('Deck is archived')
    const { message, cursorSlide, sessionId } = chatRequestSchema.parse(req.body)
    await sse(req, reply, (emit, signal) => agent.chat(deck.id, req.user!, message, cursorSlide, sessionId, emit, signal))
  })

  const proposalAction = (action: 'apply' | 'reject' | 'undo') =>
    async (req: FastifyRequest<{ Params: { id: string } }>) => {
      const proposal = await agent.getProposal(req.params.id)
      if (!proposal) throw app.httpErrors.notFound()
      const deck = await decks.forUser(proposal.deckId, req.user!.id)
      if (!deck || !can(req.auth, deck, 'view')) throw app.httpErrors.notFound()
      if (!can(req.auth, deck, 'edit')) throw app.httpErrors.forbidden()
      if (deck.archived) throw app.httpErrors.conflict('Deck is archived')
      try {
        if (action === 'apply') return await agent.apply(proposal.id, req.user!)
        if (action === 'reject') return await agent.reject(proposal.id)
        return await agent.undo(proposal.id)
      } catch (err) {
        if (err instanceof LlmError) throw app.httpErrors.conflict(err.message)
        throw err
      }
    }
  app.post('/api/proposals/:id/apply', proposalAction('apply'))
  app.post('/api/proposals/:id/reject', proposalAction('reject'))
  app.post('/api/proposals/:id/undo', proposalAction('undo'))

  app.get('/api/admin/settings', async (req) => {
    if (!req.user?.isAdmin) throw app.httpErrors.forbidden()
    return llm.public()
  })

  app.put('/api/admin/settings', async (req) => {
    if (!req.user?.isAdmin) throw app.httpErrors.forbidden()
    const input = llmSettingsSchema.extend({ vision: z.boolean().optional() }).parse(req.body)
    await llm.update(input)
    return llm.public()
  })
}
