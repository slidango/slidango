import { z } from 'zod'

export const deckModeSchema = z.enum(['assistant', 'starter', 'empty'])
export type DeckMode = z.infer<typeof deckModeSchema>

export const createDeckSchema = z.object({
  title: z.string().trim().min(1).max(200),
  mode: deckModeSchema.default('empty'),
  /** Installed template (Theme.id); omitted: the default template; null: Slidev's default theme. */
  themeId: z.string().max(300).nullable().optional(),
})
export type CreateDeck = z.infer<typeof createDeckSchema>

export const updateDeckSchema = z.object({
  title: z.string().trim().min(1).max(200),
})
export type UpdateDeck = z.infer<typeof updateDeckSchema>

export const deckAccessSchema = z.enum(['team-edit', 'team-view', 'members'])
/** `team-edit`: every signed-in user may edit · `team-view`: everyone may view · `members`: members only. */
export type DeckAccess = z.infer<typeof deckAccessSchema>

export const deckRoleSchema = z.enum(['owner', 'editor', 'viewer'])
export type DeckRole = z.infer<typeof deckRoleSchema>

export const deckSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  ownerId: z.string(),
  /** Installed template (Theme.id), null for Slidev's default theme. */
  themeId: z.string().nullable(),
  access: deckAccessSchema,
  archived: z.boolean(),
  /** The requesting user's membership role, if any; set where a user is known. */
  role: deckRoleSchema.nullable().optional(),
  /** What the requesting user may do beyond viewing; set where a user is known. */
  can: z.object({ edit: z.boolean(), manage: z.boolean() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Full Slidev preview (for presenting); set on list and detail responses. */
  previewUrl: z.string().optional(),
  /** Time of the last slide-1 image (ms), null if none yet; set on list responses. */
  thumbnailAt: z.number().nullable().optional(),
})
export type Deck = z.infer<typeof deckSchema>

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  isAdmin: z.boolean(),
  /** Apply LLM proposals without review. */
  autoApply: z.boolean(),
})
export type User = z.infer<typeof userSchema>

/** Yjs document name for a deck; shared by client and Hocuspocus. */
export const collabDocumentName = (deckId: string) => `deck:${deckId}`
export const deckIdFromDocumentName = (name: string) =>
  name.startsWith('deck:') ? name.slice('deck:'.length) : null

/** Name of the Y.Text holding slides.md. */
export const SLIDES_TEXT = 'slides'

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug || 'deck'
}

export const previewStatusSchema = z.object({
  status: z.enum(['stopped', 'starting', 'ready', 'error']),
  /** Last log lines, only when status is `error`. */
  logs: z.array(z.string()),
})
export type PreviewStatus = z.infer<typeof previewStatusSchema>

export interface Preview extends PreviewStatus {
  url: string
}
export { slideAtLine } from './slides'
export { setHeadmatter } from './headmatter'

export const themeVersionSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/, 'Version: letters, digits, dot, dash or plus')

/** One installed version of a template (a Slidev theme package). */
export interface Theme {
  /** `<package>@<version>`; decks point to this. */
  id: string
  /** Display name of the template, e.g. "Slidango". */
  label: string
  version: string
  /** npm package name; all versions of one template share it. */
  name: string
  changelog: string
  status: 'installing' | 'ready' | 'failed'
  log: string
  isDefault: boolean
  /** Shipped with Slidango. */
  builtin: boolean
  uploadedAt: string
}
export * from './deck'

// --- LLM ---------------------------------------------------------------------

export const briefingFieldsSchema = z.object({
  topic: z.string().trim().max(2000).default(''),
  goal: z.string().trim().max(2000).default(''),
  audience: z.string().trim().max(1000).default(''),
  language: z.string().trim().max(100).default('Deutsch'),
  tone: z.string().trim().max(200).default(''),
  /** Either minutes or a slide count. */
  durationMinutes: z.number().int().min(1).max(240).nullable().default(null),
  slideCount: z.number().int().min(1).max(100).nullable().default(null),
  notes: z.string().trim().max(20_000).default(''),
})
export type BriefingFields = z.infer<typeof briefingFieldsSchema>

export interface BriefingFile {
  id: string
  name: string
  type: 'text' | 'pdf' | 'image'
  /** Extracted text (text and PDF files). */
  text?: string
  size: number
}

export interface Briefing {
  fields: BriefingFields
  files: BriefingFile[]
}

export const outlineItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().max(1000).default(''),
  layout: z.string().trim().max(100).default('default'),
})
export type OutlineItem = z.infer<typeof outlineItemSchema>

export const draftRequestSchema = z.object({
  outline: z.array(outlineItemSchema).min(1).max(100),
  remarks: z.string().trim().max(5000).default(''),
})

export interface ChatContent {
  text: string
  proposalId?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: ChatContent
  userName: string | null
  createdAt: string
}

/** One conversation of a person with the assistant about a deck. */
export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface Proposal {
  id: string
  deckId: string
  summary: string
  ops: import('./deck').SlideOp[]
  status: 'open' | 'applied' | 'rejected' | 'stale' | 'undone'
  slideCount: number
  createdAt: string
  /** Slidango AI in the app, or an external client over MCP. */
  source: 'assistant' | 'mcp'
  /** MCP only: the client (token) name, e.g. "Claude Code". */
  client: string | null
}

export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
  /** 1-based slide under the user's cursor. */
  cursorSlide: z.number().int().min(1).nullable().default(null),
  /** Continues this conversation; null starts a new one. */
  sessionId: z.string().uuid().nullable().default(null),
})

export const llmSettingsSchema = z.object({
  baseUrl: z.string().trim().url(),
  model: z.string().trim().min(1).max(200),
  /** Omitted or empty keeps the stored key. */
  apiKey: z.string().max(2000).optional(),
})

export interface LlmSettings {
  baseUrl: string
  model: string
  hasApiKey: boolean
}

/** Server-sent event payloads of the LLM endpoints. */
export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'outline'; items: OutlineItem[] }
  | { type: 'slide'; index: number; total: number; title: string; warning?: string }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'session'; session: ChatSession }
  | { type: 'error'; message: string }
  | { type: 'done' }
export { validateSlide } from './validate'

// --- Accounts, sharing, tokens ------------------------------------------------

export type AuthMode = 'oidc' | 'local'

export interface DeckMember {
  userId: string
  name: string
  email: string
  role: DeckRole
}

export interface DeckSharing {
  access: DeckAccess
  members: DeckMember[]
}

export const setAccessSchema = z.object({ access: deckAccessSchema })
export const setMemberSchema = z.object({ role: deckRoleSchema })

/** Another signed-in user, as offered when sharing a deck. */
export interface DirectoryUser {
  id: string
  name: string
  email: string
}

/** A user as admins see it in Settings → People. */
export interface Person {
  id: string
  email: string
  name: string
  isAdmin: boolean
  status: 'active' | 'disabled'
  /** local mode: false until an invitation has been accepted. */
  hasPassword: boolean
  lastSeenAt: string | null
  createdAt: string
  activeTokens: number
}

export interface PendingInvite {
  id: string
  email: string
  purpose: 'invite' | 'reset'
  grantAdmin: boolean
  expiresAt: string
}

export const createInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  grantAdmin: z.boolean().default(false),
})

/** Returned once: the link only exists in this response. */
export interface InviteLink {
  url: string
  expiresAt: string
}

export const updatePersonSchema = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  isAdmin: z.boolean().optional(),
})

export const passwordSchema = z.string().min(10, 'Use at least 10 characters.').max(200)

export const acceptInviteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  password: passwordSchema,
})

export const changePasswordSchema = z.object({
  current: z.string().max(200),
  password: passwordSchema,
})

export const updateMeSchema = z.object({
  autoApply: z.boolean().optional(),
  name: z.string().trim().min(1).max(100).optional(),
})

export const tokenScopeSchema = z.enum(['read', 'write'])
export type TokenScope = z.infer<typeof tokenScopeSchema>

export const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(60),
  scope: tokenScopeSchema,
  /** Days until expiry; null never expires. */
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable(),
})

export interface ApiToken {
  id: string
  name: string
  prefix: string
  scope: TokenScope
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

/** Returned once on creation; only the hash is stored. */
export interface CreatedToken extends ApiToken {
  token: string
}
