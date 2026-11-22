import { boolean, customType, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { BriefingFields, BriefingFile, ChatContent, SlideOp, UndoInfo } from '@slidango/shared'

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (value) => new Uint8Array(value),
})

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  /** Apply LLM proposals without review (still undoable). */
  autoApply: boolean('auto_apply').notNull().default(false),
  /** AUTH_MODE=local only: scrypt hash (see passwords.ts); null until an invite is accepted. */
  passwordHash: text('password_hash'),
  /** Disabled users cannot sign in; their sessions and tokens stop working at once. */
  status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
  /** Part of every session cookie; bumping it signs the user out everywhere. */
  sessionVersion: integer('session_version').notNull().default(0),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** One-time links for AUTH_MODE=local: accept an invitation or reset a password. */
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  /** SHA-256 of the token; the token itself is only shown once. */
  tokenHash: text('token_hash').notNull().unique(),
  purpose: text('purpose', { enum: ['invite', 'reset'] }).notNull(),
  grantAdmin: boolean('grant_admin').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
})

/** Personal access tokens for the API and the MCP endpoint. Never admin, never more than their owner. */
export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** First characters of the token, to recognise it in lists. */
  prefix: text('prefix').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  scope: text('scope', { enum: ['read', 'write'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

export const decks = pgTable('decks', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  /** Installed template (themes.id) the deck uses; null for Slidev's default theme. */
  themeId: text('theme_id'),
  /** Who sees the deck besides its members: everyone may edit, everyone may view, or members only. */
  access: text('access', { enum: ['team-edit', 'team-view', 'members'] }).notNull().default('team-edit'),
  archived: boolean('archived').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const deckMembers = pgTable(
  'deck_members',
  {
    deckId: uuid('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'editor', 'viewer'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.deckId, t.userId] })],
)

export const yjsDocuments = pgTable('yjs_documents', {
  deckId: uuid('deck_id')
    .primaryKey()
    .references(() => decks.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Installed template versions. A template is all rows with the same package name. */
export const themes = pgTable('themes', {
  /** `<package name>@<version>`, unique across all templates. */
  id: text('id').primaryKey(),
  /** npm package name of the theme, used as `theme:` in the headmatter. */
  name: text('name').notNull(),
  /** Display name, e.g. "Slidango" (package.json `displayName`, else derived from the name). */
  label: text('label').notNull().default(''),
  version: text('version').notNull(),
  changelog: text('changelog').notNull().default(''),
  status: text('status', { enum: ['installing', 'ready', 'failed'] }).notNull(),
  log: text('log').notNull().default(''),
  isDefault: boolean('is_default').notNull().default(false),
  /** Shipped with Slidango (lives in the built-in runtime, cannot be uploaded or removed). */
  builtin: boolean('builtin').notNull().default(false),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
})

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
})

export const briefings = pgTable('briefings', {
  deckId: uuid('deck_id')
    .primaryKey()
    .references(() => decks.id, { onDelete: 'cascade' }),
  fields: jsonb('fields').$type<BriefingFields>().notNull(),
  files: jsonb('files').$type<BriefingFile[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** One conversation of a person with the assistant; a new browser session starts a new one. */
export const llmSessions = pgTable('llm_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  deckId: uuid('deck_id')
    .notNull()
    .references(() => decks.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  title: text('title').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const llmMessages = pgTable('llm_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  deckId: uuid('deck_id')
    .notNull()
    .references(() => decks.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id),
  sessionId: uuid('session_id').references(() => llmSessions.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: jsonb('content').$type<ChatContent>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const proposals = pgTable('proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  deckId: uuid('deck_id')
    .notNull()
    .references(() => decks.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull().default(''),
  ops: jsonb('ops').$type<SlideOp[]>().notNull(),
  baseHashes: jsonb('base_hashes').$type<Record<number, string>>().notNull(),
  /** Slide texts before applying, for undo. */
  previous: jsonb('previous').$type<UndoInfo>(),
  status: text('status', { enum: ['open', 'applied', 'rejected', 'stale', 'undone'] }).notNull().default('open'),
  createdBy: uuid('created_by').references(() => users.id),
  /** Slidango AI in the app, or an external client over MCP. */
  source: text('source', { enum: ['assistant', 'mcp'] }).notNull().default('assistant'),
  /** MCP only: the name of the token that made the proposal, e.g. "Claude Code". */
  client: text('client'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Slide count when proposed; the client shows diffs against this numbering. */
  slideCount: integer('slide_count').notNull(),
})
