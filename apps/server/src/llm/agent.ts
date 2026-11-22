import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import type OpenAI from 'openai'
import type { ChatCompletionContentPart, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import { parse as parseYaml } from 'yaml'
import {
  type Briefing,
  type BriefingFields,
  type ChatMessage,
  type ChatSession,
  type DeckSlide,
  InvalidOpError,
  type LlmEvent,
  type OutlineItem,
  type Proposal,
  type SlideOp,
  type User,
  applyOps,
  isDeckEmpty,
  outlineItemSchema,
  parseDeck,
  referencedIndexes,
  setHeadmatter,
  undoOps,
} from '@slidango/shared'
import type { Collab } from '../collab'
import { type Db, schema } from '../db'
import type { Decks } from '../decks'
import type { Themes } from '../themes'
import type { Versions } from '../versions'
import { prompt } from './prompts'
import type { LlmConfig } from './settings'
import { availableLayouts, validateSlide } from './validate'

export type Emit = (event: LlmEvent) => void

export class LlmError extends Error {}

const MAX_TOOL_ROUNDS = 6
const MAX_BRIEFING_CHARS = 60_000
const HISTORY_MESSAGES = 20
const DRAFT_CONCURRENCY = 3

type ProposalRow = typeof schema.proposals.$inferSelect

export function toProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    deckId: row.deckId,
    summary: row.summary,
    ops: row.ops,
    status: row.status,
    slideCount: row.slideCount,
    createdAt: row.createdAt.toISOString(),
    source: row.source,
    client: row.client,
  }
}

function toSession(row: typeof schema.llmSessions.$inferSelect): ChatSession {
  return { id: row.id, title: row.title, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

const CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'replace_slide',
      description: 'Ersetzt den Inhalt einer Folie.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'Folien-Nummer (ab 1)' },
          content: { type: 'string', description: 'Vollständiger neuer Inhalt der Folie, optional mit Frontmatter-Block' },
        },
        required: ['index', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'insert_slides',
      description: 'Fügt neue Folien nach einer bestehenden Folie ein.',
      parameters: {
        type: 'object',
        properties: {
          after_index: { type: 'integer', description: 'Nummer der Folie, nach der eingefügt wird (ab 1)' },
          contents: { type: 'array', items: { type: 'string' }, description: 'Inhalt je neuer Folie' },
        },
        required: ['after_index', 'contents'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_slides',
      description: 'Löscht Folien.',
      parameters: {
        type: 'object',
        properties: { indexes: { type: 'array', items: { type: 'integer' } } },
        required: ['indexes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_slide',
      description: 'Verschiebt eine Folie an eine neue Position.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'integer', description: 'Aktuelle Nummer der Folie' },
          to: { type: 'integer', description: 'Neue Position (ab 2)' },
        },
        required: ['from', 'to'],
      },
    },
  },
]

const OUTLINE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'set_outline',
    description: 'Legt die Gliederung der Präsentation fest.',
    parameters: {
      type: 'object',
      properties: {
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              message: { type: 'string', description: 'Kernaussage in einem Satz' },
              layout: { type: 'string' },
            },
            required: ['title', 'message', 'layout'],
          },
        },
      },
      required: ['slides'],
    },
  },
}

interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** Streams one completion; text deltas go to `onText`, tool calls are collected. */
async function complete(
  client: OpenAI,
  params: {
    model: string
    messages: ChatCompletionMessageParam[]
    tools?: ChatCompletionTool[]
    toolChoice?: { type: 'function'; function: { name: string } }
  },
  signal: AbortSignal,
  onText: (delta: string) => void = () => {},
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const stream = await client.chat.completions.create(
    {
      model: params.model,
      messages: params.messages,
      stream: true,
      ...(params.tools ? { tools: params.tools } : {}),
      ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
    },
    { signal },
  )
  let text = ''
  const calls: ToolCall[] = []
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta
    if (!delta) continue
    if (delta.content) {
      text += delta.content
      onText(delta.content)
    }
    for (const call of delta.tool_calls ?? []) {
      const entry = (calls[call.index] ??= { id: '', name: '', arguments: '' })
      if (call.id) entry.id = call.id
      if (call.function?.name) entry.name += call.function.name
      if (call.function?.arguments) entry.arguments += call.function.arguments
    }
  }
  return { text, toolCalls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` })) }
}

function formatBriefing(briefing: Briefing | null): string {
  if (!briefing) return '(kein Briefing)'
  const f = briefing.fields
  const lines = [
    f.topic && `Thema: ${f.topic}`,
    f.goal && `Ziel: ${f.goal}`,
    f.audience && `Zielgruppe: ${f.audience}`,
    f.language && `Sprache: ${f.language}`,
    f.tone && `Tonalität: ${f.tone}`,
    f.slideCount && `Umfang: ${f.slideCount} Folien`,
    f.durationMinutes && `Dauer: ${f.durationMinutes} Minuten`,
    f.notes && `Notizen:\n${f.notes}`,
  ].filter(Boolean)
  let budget = MAX_BRIEFING_CHARS
  for (const file of briefing.files) {
    if (!file.text || budget <= 0) continue
    const text = file.text.slice(0, budget)
    budget -= text.length
    lines.push(`\n### Datei: ${file.name}\n${text}`)
  }
  return lines.join('\n') || '(kein Briefing)'
}

function sizeInstruction(fields: BriefingFields | undefined): string {
  if (fields?.slideCount) return `Plane genau ${fields.slideCount} Folien.`
  if (fields?.durationMinutes) {
    return `Plane etwa ${Math.max(3, Math.round(fields.durationMinutes / 1.5))} Folien für ${fields.durationMinutes} Minuten.`
  }
  return 'Wähle einen passenden Umfang (meist 8–12 Folien).'
}

function numberedDeck(slides: DeckSlide[]): string {
  return slides.map((s) => `### Folie ${s.index}\n${s.content || '(leer)'}`).join('\n\n')
}

/** Model output often comes wrapped in a code fence or with stray separators. */
export function cleanSlide(text: string): string {
  let out = text.trim()
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(out)
  if (fenced) out = fenced[1]!.trim()
  // A leading separator is fine only as the start of a frontmatter block.
  if (/^---\n\s*\n/.test(out) || out === '---') out = out.replace(/^---\n/, '').trim()
  return out.replace(/\n---\s*$/, '').trim()
}

export class Agent {
  constructor(
    private deps: {
      db: Db
      llm: LlmConfig
      decks: Decks
      themes: Themes
      collab: Collab
      versions: Versions
      runtimeModules: (themeId: string | null) => string
    },
  ) {}

  async briefing(deckId: string): Promise<Briefing | null> {
    const [row] = await this.deps.db.select().from(schema.briefings).where(eq(schema.briefings.deckId, deckId))
    return row ? { fields: row.fields, files: row.files } : null
  }

  private async deckContext(deckId: string) {
    const deck = (await this.deps.decks.get(deckId))!
    const theme = deck.themeId ? await this.deps.themes.get(deck.themeId) : null
    const markdown = await this.deps.collab.readContent(deckId)
    const layouts = await availableLayouts(this.deps.runtimeModules(deck.themeId), theme?.name ?? null)
    const guide = (deck.themeId && (await this.deps.themes.guide(deck.themeId))) || '(Slidev-Standard-Theme, kein Leitfaden)'
    const briefing = await this.briefing(deckId)
    const slidev = await prompt('slidev', { layouts: layouts.join(', ') })
    return { deck, markdown, slides: parseDeck(markdown), layouts, guide, briefing, slidev }
  }

  private async briefingImages(deckId: string, briefing: Briefing | null): Promise<ChatCompletionContentPart[]> {
    const parts: ChatCompletionContentPart[] = []
    for (const file of briefing?.files ?? []) {
      if (file.type !== 'image') continue
      const data = await readFile(join(this.deps.decks.dir(deckId), '.briefing', file.id)).catch(() => null)
      if (!data) continue
      const mime = file.name.toLowerCase().endsWith('.png') ? 'image/png' : file.name.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg'
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data.toString('base64')}` } })
    }
    return parts
  }

  async layouts(deckId: string): Promise<string[]> {
    return (await this.deckContext(deckId)).layouts
  }

  /** A person's conversations about a deck, newest first; every user has their own. */
  async sessions(deckId: string, userId: string): Promise<ChatSession[]> {
    const rows = await this.deps.db
      .select()
      .from(schema.llmSessions)
      .where(and(eq(schema.llmSessions.deckId, deckId), eq(schema.llmSessions.userId, userId)))
      .orderBy(desc(schema.llmSessions.updatedAt))
      .limit(50)
    return rows.map(toSession)
  }

  /** Messages of one conversation; other people's conversations stay invisible. */
  async history(deckId: string, userId: string, sessionId: string | null): Promise<ChatMessage[]> {
    if (!sessionId) return []
    const rows = await this.deps.db
      .select({ message: schema.llmMessages, userName: schema.users.name })
      .from(schema.llmMessages)
      .leftJoin(schema.users, eq(schema.users.id, schema.llmMessages.userId))
      .where(
        and(
          eq(schema.llmMessages.deckId, deckId),
          eq(schema.llmMessages.userId, userId),
          eq(schema.llmMessages.sessionId, sessionId),
        ),
      )
      .orderBy(desc(schema.llmMessages.createdAt))
      .limit(100)
    return rows.reverse().map(({ message, userName }) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      userName: message.role === 'user' ? userName : null,
      createdAt: message.createdAt.toISOString(),
    }))
  }

  /** Continues the given conversation or starts a new one titled after the first message. */
  private async session(deckId: string, userId: string, sessionId: string | null, message: string): Promise<ChatSession> {
    if (sessionId) {
      const [row] = await this.deps.db
        .update(schema.llmSessions)
        .set({ updatedAt: new Date() })
        .where(and(eq(schema.llmSessions.id, sessionId), eq(schema.llmSessions.deckId, deckId), eq(schema.llmSessions.userId, userId)))
        .returning()
      if (!row) throw new LlmError('Conversation not found')
      return toSession(row)
    }
    const title = message.replace(/\s+/g, ' ').trim().slice(0, 80)
    const [row] = await this.deps.db.insert(schema.llmSessions).values({ deckId, userId, title }).returning()
    return toSession(row!)
  }

  async proposals(deckId: string, userId: string): Promise<Proposal[]> {
    const rows = await this.deps.db
      .select()
      .from(schema.proposals)
      .where(and(eq(schema.proposals.deckId, deckId), eq(schema.proposals.createdBy, userId)))
      .orderBy(desc(schema.proposals.createdAt))
      .limit(100)
    return rows.map(toProposal)
  }

  /**
   * One chat turn. The model changes the deck only through tools; the collected
   * operations become a proposal (applied right away if the user opted in).
   */
  async chat(
    deckId: string,
    user: User & { autoApply: boolean },
    message: string,
    cursorSlide: number | null,
    sessionId: string | null,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<void> {
    const { client, model } = await this.deps.llm.client()
    const ctx = await this.deckContext(deckId)
    const system = await prompt('chat', {
      slidev: ctx.slidev,
      guide: ctx.guide,
      briefing: formatBriefing(ctx.briefing),
      slideCount: String(ctx.slides.length),
      deck: numberedDeck(ctx.slides),
      cursor: cursorSlide ? `Der Cursor des Users steht auf Folie ${cursorSlide}.` : '',
    })
    const session = await this.session(deckId, user.id, sessionId, message)
    if (session.id !== sessionId) emit({ type: 'session', session })
    const history = (await this.history(deckId, user.id, session.id)).slice(-HISTORY_MESSAGES)
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: system },
      ...history.map((m) => ({ role: m.role, content: m.content.text }) as ChatCompletionMessageParam),
      { role: 'user', content: message },
    ]
    await this.deps.db.insert(schema.llmMessages).values({ deckId, userId: user.id, sessionId: session.id, role: 'user', content: { text: message } })

    const ops: SlideOp[] = []
    let answer = ''
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await complete(client, { model, messages, tools: CHAT_TOOLS }, signal, (delta) => {
        answer += delta
        emit({ type: 'text', delta })
      })
      if (result.toolCalls.length === 0) break
      messages.push({
        role: 'assistant',
        content: result.text || null,
        tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
      })
      for (const call of result.toolCalls) {
        const outcome = this.recordTool(call, ctx.markdown, ctx.slides.length, ctx.layouts, ops)
        messages.push({ role: 'tool', tool_call_id: call.id, content: outcome })
      }
    }

    let proposalId: string | undefined
    if (ops.length) {
      const hashes = Object.fromEntries(referencedIndexes(ops).map((i) => [i, ctx.slides[i - 1]!.hash]))
      const [row] = await this.deps.db
        .insert(schema.proposals)
        .values({
          deckId,
          summary: answer.trim().slice(0, 1000),
          ops,
          baseHashes: hashes,
          createdBy: user.id,
          slideCount: ctx.slides.length,
        })
        .returning()
      proposalId = row!.id
      const proposal = user.autoApply ? await this.apply(row!.id, user) : toProposal(row!)
      emit({ type: 'proposal', proposal })
    }
    await this.deps.db
      .insert(schema.llmMessages)
      .values({ deckId, userId: user.id, sessionId: session.id, role: 'assistant', content: { text: answer.trim(), proposalId } })
  }

  /** Validates one tool call and records it; the returned text goes back to the model. */
  private recordTool(call: ToolCall, markdown: string, slideCount: number, layouts: string[], ops: SlideOp[]): string {
    let args: Record<string, unknown>
    try {
      args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
    } catch {
      return 'Error: the arguments are not valid JSON.'
    }
    const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : NaN)
    let op: SlideOp
    switch (call.name) {
      case 'replace_slide':
        op = { type: 'replace', index: int(args.index), content: String(args.content ?? '') }
        break
      case 'insert_slides':
        op = { type: 'insert', after: int(args.after_index), contents: Array.isArray(args.contents) ? args.contents.map(String) : [] }
        break
      case 'delete_slides':
        op = { type: 'delete', indexes: Array.isArray(args.indexes) ? args.indexes.map(int) : [] }
        break
      case 'move_slide':
        op = { type: 'move', from: int(args.from), to: int(args.to) }
        break
      default:
        return `Error: unknown tool ${call.name}.`
    }
    const error = checkOp(op, markdown, slideCount, layouts, ops)
    if (error) return error
    ops.push(op)
    return 'OK, noted.'
  }

  /** Current deck for external clients (MCP): slides with hashes, allowed layouts and the template guide. */
  async snapshot(deckId: string) {
    const ctx = await this.deckContext(deckId)
    return { deck: ctx.deck, markdown: ctx.markdown, slides: ctx.slides, layouts: ctx.layouts, guide: ctx.guide }
  }

  /**
   * A proposal from an external client (MCP), checked exactly like Slidango AI's tool calls.
   * `baseHashes` lets the client pin the slide versions it read; otherwise the current ones are used.
   * Applied right away only if the person opted into "Apply directly".
   */
  async proposeExternal(
    deckId: string,
    user: User,
    input: { ops: SlideOp[]; summary: string; client: string; baseHashes?: Record<number, string> },
  ): Promise<{ proposal: Proposal } | { error: string }> {
    const ctx = await this.deckContext(deckId)
    if (!input.ops.length) return { error: 'Error: no operations.' }
    const accepted: SlideOp[] = []
    for (const [i, op] of input.ops.entries()) {
      const error = checkOp(op, ctx.markdown, ctx.slides.length, ctx.layouts, accepted)
      if (error) return { error: `Operation ${i + 1}: ${error}` }
      accepted.push(op)
    }
    const hashes = Object.fromEntries(
      referencedIndexes(accepted).map((i) => [i, input.baseHashes?.[i] ?? ctx.slides[i - 1]!.hash]),
    )
    const [row] = await this.deps.db
      .insert(schema.proposals)
      .values({
        deckId,
        summary: input.summary.trim().slice(0, 1000),
        ops: accepted,
        baseHashes: hashes,
        createdBy: user.id,
        slideCount: ctx.slides.length,
        source: 'mcp',
        client: input.client,
      })
      .returning()
    return { proposal: user.autoApply ? await this.apply(row!.id, user) : toProposal(row!) }
  }

  private async loadProposal(id: string) {
    const [row] = await this.deps.db.select().from(schema.proposals).where(eq(schema.proposals.id, id))
    return row ?? null
  }

  async isOwnProposal(id: string, userId: string): Promise<boolean> {
    const row = await this.loadProposal(id)
    return row?.createdBy === userId
  }

  async getProposal(id: string): Promise<Proposal | null> {
    const row = await this.loadProposal(id)
    return row ? toProposal(row) : null
  }

  /** Applies an open proposal in one transaction, or marks it stale. */
  async apply(id: string, _user: User): Promise<Proposal> {
    const row = await this.loadProposal(id)
    if (!row) throw new LlmError('Suggestion not found')
    if (row.status !== 'open') throw new LlmError('Suggestion is no longer open')
    let outcome: ReturnType<typeof applyOps> | null = null
    await this.deps.collab.replaceContent(
      row.deckId,
      (current) => {
        outcome = applyOps(current, row.ops, row.baseHashes)
        return outcome.ok ? outcome.text : null
      },
      'llm',
    )
    const result = outcome as ReturnType<typeof applyOps> | null
    const status = result?.ok ? 'applied' : 'stale'
    const [updated] = await this.deps.db
      .update(schema.proposals)
      .set({ status, previous: result?.ok ? result.undo : null })
      .where(and(eq(schema.proposals.id, id), eq(schema.proposals.status, 'open')))
      .returning()
    return toProposal(updated ?? { ...row, status })
  }

  async reject(id: string): Promise<Proposal> {
    const [row] = await this.deps.db
      .update(schema.proposals)
      .set({ status: 'rejected' })
      .where(and(eq(schema.proposals.id, id), eq(schema.proposals.status, 'open')))
      .returning()
    if (!row) throw new LlmError('Suggestion is no longer open')
    return toProposal(row)
  }

  /** Writes back the slides the proposal replaced, if they are unchanged since. */
  async undo(id: string): Promise<Proposal> {
    const row = await this.loadProposal(id)
    if (!row || row.status !== 'applied' || !row.previous) throw new LlmError('Only applied suggestions can be undone')
    const previous = row.previous
    let ok = false
    await this.deps.collab.replaceContent(
      row.deckId,
      (current) => {
        const result = undoOps(current, previous)
        ok = result.ok
        return result.ok ? result.text : null
      },
      'llm-undo',
    )
    if (!ok) throw new LlmError('These slides changed in the meantime, so this can no longer be undone.')
    const [updated] = await this.deps.db.update(schema.proposals).set({ status: 'undone' }).where(eq(schema.proposals.id, id)).returning()
    return toProposal(updated!)
  }

  /** First LLM run: an editable outline from the briefing. */
  async outline(deckId: string, emit: Emit, signal: AbortSignal): Promise<OutlineItem[]> {
    const { client, model, vision } = await this.deps.llm.client()
    const ctx = await this.deckContext(deckId)
    if (!ctx.briefing?.fields.topic && !ctx.briefing?.fields.goal) throw new LlmError('Briefing: topic and goal are missing')
    const system = await prompt('outline', {
      slidev: ctx.slidev,
      guide: ctx.guide,
      briefing: formatBriefing(ctx.briefing),
      size: sizeInstruction(ctx.briefing?.fields),
    })
    const images = vision ? await this.briefingImages(deckId, ctx.briefing) : []
    const user: ChatCompletionMessageParam = images.length
      ? { role: 'user', content: [{ type: 'text', text: 'Erstelle die Gliederung.' }, ...images] }
      : { role: 'user', content: 'Erstelle die Gliederung.' }
    const result = await complete(
      client,
      { model, messages: [{ role: 'system', content: system }, user], tools: [OUTLINE_TOOL], toolChoice: { type: 'function', function: { name: 'set_outline' } } },
      signal,
    )
    const raw = result.toolCalls.find((c) => c.name === 'set_outline')?.arguments ?? /\{[\s\S]*\}/.exec(result.text)?.[0]
    let items: OutlineItem[]
    try {
      const parsed = JSON.parse(raw ?? '') as { slides?: unknown[] }
      items = (parsed.slides ?? []).map((s) => outlineItemSchema.parse(s))
    } catch {
      throw new LlmError('The model didn’t return a valid outline.')
    }
    if (!items.length) throw new LlmError('The model didn’t return a valid outline.')
    items = items.map((item) => ({ ...item, layout: ctx.layouts.includes(item.layout) ? item.layout : 'default' }))
    emit({ type: 'outline', items })
    return items
  }

  /**
   * Second run: writes the deck slide by slide. The deck is empty, so finished
   * slides go in directly (in order) and everyone watches it grow.
   */
  async draft(deckId: string, user: User, outline: OutlineItem[], remarks: string, emit: Emit, signal: AbortSignal) {
    const { client, model, vision } = await this.deps.llm.client()
    const ctx = await this.deckContext(deckId)
    if (!isDeckEmpty(ctx.markdown)) throw new LlmError('The first draft needs an empty deck.')
    const outlineText = outline.map((o, i) => `${i + 1}. ${o.title} – ${o.message} (Layout: ${o.layout})`).join('\n')
    const images = vision ? await this.briefingImages(deckId, ctx.briefing) : []

    const write = async (i: number): Promise<{ content: string; warning?: string }> => {
      const item = outline[i]!
      const system = await prompt('draft-slide', {
        slidev: ctx.slidev,
        guide: ctx.guide,
        briefing: formatBriefing(ctx.briefing),
        outline: outlineText,
        remarks: remarks ? `## Anmerkungen zur Gliederung\n\n${remarks}` : '',
        number: String(i + 1),
        total: String(outline.length),
        title: item.title,
        message: item.message,
        layout: item.layout,
      })
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: system },
        images.length && i === 0
          ? { role: 'user', content: [{ type: 'text', text: 'Schreibe die Folie.' }, ...images] }
          : { role: 'user', content: 'Schreibe die Folie.' },
      ]
      let content = cleanSlide((await complete(client, { model, messages }, signal)).text)
      let errors = validateSlide(content, ctx.layouts)
      if (errors.length) {
        messages.push({ role: 'assistant', content }, { role: 'user', content: `Korrigiere die Folie: ${errors.join(' ')}` })
        content = cleanSlide((await complete(client, { model, messages }, signal)).text)
        errors = validateSlide(content, ctx.layouts)
      }
      if (!errors.length) return { content }
      const warning = errors.join(' ')
      // The note goes after the frontmatter block; before it, Slidev would split the slide.
      const note = `<!-- Note: checked automatically, please review: ${warning.replace(/--/g, '–')} -->`
      const fm = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(content)?.[0] ?? ''
      return { content: `${fm}${fm ? '\n' : ''}${note}\n\n${content.slice(fm.length).trim()}`, warning }
    }

    // A few slides are generated in parallel; they are inserted strictly in order.
    const pending: Promise<{ content: string; warning?: string }>[] = []
    let next = 0
    const startNext = () => {
      if (next < outline.length && !signal.aborted) pending.push(write(next++))
    }
    for (let i = 0; i < DRAFT_CONCURRENCY; i++) startNext()

    for (let i = 0; i < outline.length; i++) {
      if (signal.aborted) break
      const slide = await pending[i]!
      startNext()
      await this.deps.collab.replaceContent(
        deckId,
        (current) => (i === 0 ? mergeIntoFirstSlide(current, slide.content) : appendSlide(current, slide.content)),
        'llm-draft',
      )
      emit({ type: 'slide', index: i + 1, total: outline.length, title: outline[i]!.title, warning: slide.warning })
    }
    if (!signal.aborted) await this.deps.versions.commit(deckId, 'Erstentwurf (LLM)', user)
  }

  /** "Verwerfen": back to the empty deck (headmatter only). */
  async discardDraft(deckId: string) {
    await this.deps.collab.replaceContent(deckId, (current) => headmatterOnly(current), 'llm-draft')
  }
}

function appendSlide(current: string, content: string): string {
  const slides = parseDeck(current)
  const result = applyOps(current, [{ type: 'insert', after: slides.length, contents: [content] }], {})
  return result.ok ? result.text : current
}

function headmatterOnly(markdown: string): string {
  const first = parseDeck(markdown)[0]!.content
  const head = /^---\n[\s\S]*?\n---/.exec(first)?.[0]
  return head ? `${head}\n` : ''
}

/** The first drafted slide lives in slide 1: its frontmatter keys merge into the headmatter. */
export function mergeIntoFirstSlide(current: string, content: string): string {
  const fm = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content)
  const body = fm ? content.slice(fm[0].length).trim() : content.trim()
  let keys: Record<string, string | number | boolean> = {}
  if (fm) {
    try {
      const data = parseYaml(fm[1]!) as Record<string, unknown>
      keys = Object.fromEntries(
        Object.entries(data ?? {}).filter(([k, v]) => ['string', 'number', 'boolean'].includes(typeof v) && k !== 'theme'),
      ) as Record<string, string | number | boolean>
    } catch {
      keys = {}
    }
  }
  const head = setHeadmatter(headmatterOnly(current) || '---\n---\n', keys).trimEnd()
  const rest = parseDeck(current).slice(1).map((s) => s.segment)
  return [`${head}\n\n${body}\n`, ...rest].join('\n')
}

/**
 * Validates one slide operation against the deck and the operations before it.
 * Returns an error text for the model (or MCP client) to correct, or null.
 */
export function checkOp(op: SlideOp, markdown: string, slideCount: number, layouts: string[], before: SlideOp[]): string | null {
  const invalid = referencedIndexes([op]).filter((i) => !(Number.isInteger(i) && i >= 1 && i <= slideCount))
  if (op.type === 'move' && !(op.to >= 2 && op.to <= slideCount)) invalid.push(op.to)
  if (invalid.length) return `Error: slide ${invalid.join(', ')} does not exist (1–${slideCount}).`

  const contents = op.type === 'replace' ? [op.content] : op.type === 'insert' ? op.contents : []
  if (op.type === 'insert' && contents.length === 0) return 'Error: contents is empty.'
  for (const [i, content] of contents.entries()) {
    const errors = validateSlide(content, layouts)
    if (errors.length) return `Error in ${op.type === 'insert' ? `slide ${i + 1} of contents` : 'content'}: ${errors.join(' ')}`
  }
  try {
    applyOps(markdown, [...before, op], {})
  } catch (err) {
    if (err instanceof InvalidOpError) return `Error: ${err.message}`
    throw err
  }
  return null
}
