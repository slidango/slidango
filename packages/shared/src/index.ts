import { z } from 'zod'

export const deckModeSchema = z.enum(['assistant', 'starter', 'empty'])
export type DeckMode = z.infer<typeof deckModeSchema>

export const createDeckSchema = z.object({
  title: z.string().trim().min(1).max(200),
  mode: deckModeSchema.default('empty'),
})
export type CreateDeck = z.infer<typeof createDeckSchema>

export const updateDeckSchema = z.object({
  title: z.string().trim().min(1).max(200),
})
export type UpdateDeck = z.infer<typeof updateDeckSchema>

export const deckSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  ownerId: z.string(),
  themeVersion: z.string().nullable(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Full Slidev preview (for presenting); set on list and detail responses. */
  previewUrl: z.string().optional(),
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
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/, 'Version: Buchstaben, Ziffern, Punkt, Bindestrich')

export interface Theme {
  version: string
  name: string
  changelog: string
  status: 'installing' | 'ready' | 'failed'
  log: string
  isDefault: boolean
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
