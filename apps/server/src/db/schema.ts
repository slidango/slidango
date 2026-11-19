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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const decks = pgTable('decks', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  themeVersion: text('theme_version'),
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

export const themes = pgTable('themes', {
  version: text('version').primaryKey(),
  /** npm package name of the theme, used as `theme:` in the headmatter. */
  name: text('name').notNull(),
  changelog: text('changelog').notNull().default(''),
  status: text('status', { enum: ['installing', 'ready', 'failed'] }).notNull(),
  log: text('log').notNull().default(''),
  isDefault: boolean('is_default').notNull().default(false),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Slide count when proposed; the client shows diffs against this numbering. */
  slideCount: integer('slide_count').notNull(),
})
