import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { CreateDeck, Deck, SlideOp, User } from '@slidango/shared'
import { type AuthContext, can } from './auth'
import type { Collab } from './collab'
import type { DeckWithRole, Decks } from './decks'
import type { Agent } from './llm/agent'
import { LlmError } from './llm/agent'
import type { PreviewHosts } from './preview'
import type { Themes } from './themes'
import type { Versions } from './versions'

interface Deps {
  agent: Agent
  decks: Decks
  collab: Collab
  versions: Versions
  previewHosts: PreviewHosts
  createDeck: (input: CreateDeck, user: User) => Promise<Deck>
  themes: Themes
}

/** How long an MCP client stays visible in a deck after its last call. */
const PRESENCE_MS = 30_000
const AI_COLOR = '#62b6b3'

const opSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('replace'),
    index: z.number().int().describe('Slide number (1-based) to replace'),
    content: z.string().describe('Complete new slide: optional frontmatter block, then the body; no leading ---'),
  }),
  z.object({
    type: z.literal('insert'),
    after: z.number().int().describe('Insert after this slide number (1-based)'),
    contents: z.array(z.string()).min(1).describe('One entry per new slide'),
  }),
  z.object({
    type: z.literal('delete'),
    indexes: z.array(z.number().int()).min(1).describe('Slide numbers to delete'),
  }),
  z.object({
    type: z.literal('move'),
    from: z.number().int(),
    to: z.number().int().describe('New position; slide 1 always stays first'),
  }),
])

const INSTRUCTIONS = `Slidango is a collaborative editor for Slidev decks (Markdown slides). People may be typing in the same deck right now.
Workflow: list_decks → read_deck (and get_template_guide for layouts) → propose_changes. Changes become a suggestion that a person reviews in the editor, unless they turned on "Apply directly".
Slide numbers in operations always refer to the numbering returned by read_deck. Slide 1 holds the deck settings: it can be replaced, but not deleted or moved, and nothing goes before it.
Only use layouts from get_template_guide. Write exactly one slide per content string, without --- separators.`

/** The MCP endpoint: stateless Streamable HTTP, authenticated per request by an API token. */
export function registerMcpRoutes(app: FastifyInstance, deps: Deps) {
  const presenceTimers = new Map<string, NodeJS.Timeout>()

  function showPresence(deckId: string, ctx: AuthContext) {
    const key = `${deckId}:${ctx.token!.id}`
    deps.collab.setPresence(deckId, {
      user: { id: `mcp:${ctx.token!.id}`, name: `${ctx.token!.name} · ${ctx.user.name}`, color: AI_COLOR, ai: true },
    })
    clearTimeout(presenceTimers.get(key))
    presenceTimers.set(
      key,
      setTimeout(() => {
        presenceTimers.delete(key)
        deps.collab.setPresence(deckId, null)
      }, PRESENCE_MS),
    )
  }

  function buildServer(ctx: AuthContext) {
    const server = new McpServer({ name: 'slidango', version: '1.0.0' }, { instructions: INSTRUCTIONS })
    const text = (value: unknown) => ({
      content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    })
    const fail = (message: string) => ({ ...text(message), isError: true })
    const writable = () => ctx.token?.scope === 'write'

    /** Loads a deck the caller may use for `action`; returns an error text otherwise. */
    async function deckFor(deckId: string, action: 'view' | 'edit'): Promise<DeckWithRole | string> {
      const deck = await deps.decks.forUser(deckId, ctx.user.id)
      if (!deck || !can(ctx, deck, 'view')) return `Deck ${deckId} not found.`
      if (action === 'edit') {
        if (!writable()) return 'This token is read-only. Create a token with write scope to change decks.'
        if (!can(ctx, deck, 'edit')) return `You may only view deck “${deck.title}”.`
        if (deck.archived) return `Deck “${deck.title}” is archived and read-only.`
      }
      return deck
    }

    server.registerTool(
      'list_decks',
      {
        title: 'List decks',
        description: 'Decks you can see, newest first, with your permissions.',
        inputSchema: { include_archived: z.boolean().optional() },
        annotations: { readOnlyHint: true },
      },
      async ({ include_archived }) => {
        const decks = await deps.decks.list(ctx, include_archived ?? false)
        return text(
          decks.map((d) => ({
            id: d.id,
            title: d.title,
            updatedAt: d.updatedAt,
            archived: d.archived,
            access: d.access,
            role: d.role ?? null,
            canEdit: writable() && (d.can?.edit ?? false) && !d.archived,
            previewUrl: deps.previewHosts.url(d.slug),
          })),
        )
      },
    )

    server.registerTool(
      'read_deck',
      {
        title: 'Read a deck',
        description:
          'All slides of a deck with number, title, layout, Markdown content and a hash. Pass the hashes back to propose_changes as base_hashes so changes by others are detected.',
        inputSchema: { deck_id: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ deck_id }) => {
        const deck = await deckFor(deck_id, 'view')
        if (typeof deck === 'string') return fail(deck)
        showPresence(deck.id, ctx)
        const snap = await deps.agent.snapshot(deck.id)
        return text({
          id: deck.id,
          title: deck.title,
          slideCount: snap.slides.length,
          slides: snap.slides.map((s) => ({
            index: s.index,
            title: s.title ?? null,
            layout: s.layout ?? null,
            hidden: s.hidden,
            hash: s.hash,
            content: s.content,
          })),
        })
      },
    )

    server.registerTool(
      'get_template_guide',
      {
        title: 'Template guide',
        description: 'Layouts allowed in this deck and the template’s writing guide (guide.md).',
        inputSchema: { deck_id: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ deck_id }) => {
        const deck = await deckFor(deck_id, 'view')
        if (typeof deck === 'string') return fail(deck)
        const snap = await deps.agent.snapshot(deck.id)
        return text({ layouts: snap.layouts, guide: snap.guide })
      },
    )

    server.registerTool(
      'propose_changes',
      {
        title: 'Propose changes',
        description:
          'Suggests changes to a deck: replace, insert, delete or move slides. All slide numbers refer to read_deck. A person reviews the suggestion in the editor (applied at once only if they enabled "Apply directly").',
        inputSchema: {
          deck_id: z.string(),
          summary: z.string().max(1000).describe('One or two sentences: what changes and why'),
          operations: z.array(opSchema).min(1).max(50),
          base_hashes: z
            .record(z.string(), z.string())
            .optional()
            .describe('Slide number → hash from read_deck, for the slides you change'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ deck_id, summary, operations, base_hashes }) => {
        const deck = await deckFor(deck_id, 'edit')
        if (typeof deck === 'string') return fail(deck)
        showPresence(deck.id, ctx)
        const baseHashes = base_hashes
          ? Object.fromEntries(Object.entries(base_hashes).map(([k, v]) => [Number(k), v]))
          : undefined
        const result = await deps.agent.proposeExternal(deck.id, ctx.user, {
          ops: operations as SlideOp[],
          summary,
          client: ctx.token!.name,
          baseHashes,
        })
        if ('error' in result) return fail(result.error)
        const { proposal } = result
        const state =
          proposal.status === 'applied'
            ? 'Applied right away (the person enabled "Apply directly"); it can be undone with undo_proposal.'
            : proposal.status === 'stale'
              ? 'Not applied: the slides changed since you read them. Read the deck again.'
              : 'Waiting for review in the editor.'
        return text({ proposalId: proposal.id, status: proposal.status, message: state })
      },
    )

    for (const action of ['apply', 'undo'] as const) {
      server.registerTool(
        `${action}_proposal`,
        {
          title: action === 'apply' ? 'Apply a proposal' : 'Undo a proposal',
          description:
            action === 'apply'
              ? 'Applies one of your own open proposals. Only allowed if the person enabled "Apply directly".'
              : 'Restores the slides an applied proposal of yours replaced, if nobody changed them since.',
          inputSchema: { proposal_id: z.string() },
          annotations: { readOnlyHint: false, destructiveHint: action === 'apply' },
        },
        async ({ proposal_id }) => {
          const proposal = /^[0-9a-f-]{36}$/i.test(proposal_id) ? await deps.agent.getProposal(proposal_id) : null
          if (!proposal || proposal.source !== 'mcp') return fail('Proposal not found.')
          const owned = await deps.agent.isOwnProposal(proposal.id, ctx.user.id)
          if (!owned) return fail('Proposal not found.')
          const deck = await deckFor(proposal.deckId, 'edit')
          if (typeof deck === 'string') return fail(deck)
          if (action === 'apply' && !ctx.user.autoApply) {
            return fail('Applying needs "Apply directly" turned on by the person in Slidango. Ask them to review the suggestion instead.')
          }
          showPresence(deck.id, ctx)
          try {
            const result = action === 'apply' ? await deps.agent.apply(proposal.id, ctx.user) : await deps.agent.undo(proposal.id)
            return text({ proposalId: result.id, status: result.status })
          } catch (err) {
            if (err instanceof LlmError) return fail(err.message)
            throw err
          }
        },
      )
    }

    server.registerTool(
      'save_version',
      {
        title: 'Save a version',
        description: 'Saves the current state of a deck as a version (a Git commit) with a message.',
        inputSchema: { deck_id: z.string(), message: z.string().trim().min(1).max(500) },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ deck_id, message }) => {
        const deck = await deckFor(deck_id, 'edit')
        if (typeof deck === 'string') return fail(deck)
        await deps.collab.flushDeck(deck.id)
        const version = await deps.versions.commit(deck.id, message, ctx.user)
        return text(version ? { saved: true, sha: version.sha } : { saved: false, message: 'No changes since the last version.' })
      },
    )

    server.registerTool(
      'create_deck',
      {
        title: 'Create a deck',
        description: 'Creates a new deck you own. "starter" uses the template’s example deck if there is one.',
        inputSchema: {
          title: z.string().trim().min(1).max(200),
          mode: z.enum(['empty', 'starter']).optional(),
          template_id: z.string().max(300).optional().describe('From list_templates; omitted: the default template'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ title, mode, template_id }) => {
        if (!writable()) return fail('This token is read-only. Create a token with write scope to create decks.')
        try {
          const deck = await deps.createDeck({ title, mode: mode ?? 'empty', themeId: template_id }, ctx.user)
          return text({ id: deck.id, title: deck.title, template: deck.themeId, previewUrl: deps.previewHosts.url(deck.slug) })
        } catch (err) {
          return fail((err as Error).message)
        }
      },
    )

    server.registerTool(
      'list_templates',
      {
        title: 'List templates',
        description: 'Templates new decks can use, with their versions. The default one is marked.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => {
        const ready = (await deps.themes.list()).filter((t) => t.status === 'ready')
        return text(ready.map((t) => ({ id: t.id, template: t.label, version: t.version, default: t.isDefault, builtin: t.builtin })))
      },
    )

    return server
  }

  app.post('/mcp', async (req, reply) => {
    const ctx = req.auth!
    const server = buildServer(ctx)
    // Stateless: no session ids, every request carries its own token.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    reply.hijack()
    reply.raw.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req.raw, reply.raw, req.body)
    } catch (err) {
      req.log.error({ err }, 'mcp request failed')
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' })
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }))
      }
    }
  })

  // Stateless server: no server-initiated streams and no sessions to end.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      handler: async (_req, reply) =>
        reply
          .code(405)
          .header('allow', 'POST')
          .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }),
    })
  }
}
