import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq, isNotNull, like, ne, or } from 'drizzle-orm'
import { type CreateDeck, type Deck, type DeckAccess, type DeckRole, type DeckSharing, type User, slugify } from '@slidango/shared'
import { type AuthContext, permissions } from './auth'
import type { Db } from './db'
import { schema } from './db'

type DeckRow = typeof schema.decks.$inferSelect
/** A deck with the caller's membership role (null: not a member). */
export type DeckWithRole = DeckRow & { role: DeckRole | null }

export function toDeck(row: DeckRow | DeckWithRole, caller?: User | AuthContext): Deck {
  const role = 'role' in row ? row.role : undefined
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    ownerId: row.ownerId,
    themeId: row.themeId,
    access: row.access,
    archived: row.archived,
    ...(role !== undefined ? { role } : {}),
    ...(caller && role !== undefined ? { can: permissions(caller, row as DeckWithRole) } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function initialSlides(title: string): string {
  // editor: false keeps Slidev's built-in editor off; the app is the only writer.
  return `---\ntitle: ${JSON.stringify(title)}\neditor: false\n---\n\n# ${title}\n`
}

export class Decks {
  constructor(
    private db: Db,
    private dataDir: string,
  ) {}

  dir(id: string) {
    return join(this.dataDir, 'decks', id)
  }

  slidesPath(id: string) {
    return join(this.dir(id), 'slides.md')
  }

  /** Decks the caller may see: admins all, others members-only decks only where they are members. */
  async list(caller: AuthContext, includeArchived = false): Promise<Deck[]> {
    const member = schema.deckMembers
    const rows = await this.db
      .select({ deck: schema.decks, role: member.role })
      .from(schema.decks)
      .leftJoin(member, and(eq(member.deckId, schema.decks.id), eq(member.userId, caller.user.id)))
      .where(
        and(
          includeArchived ? undefined : eq(schema.decks.archived, false),
          caller.user.isAdmin ? undefined : or(ne(schema.decks.access, 'members'), isNotNull(member.role)),
        ),
      )
      .orderBy(desc(schema.decks.updatedAt))
    return rows.map(({ deck, role }) => toDeck({ ...deck, role: role ?? null }, caller))
  }

  async get(id: string): Promise<DeckRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    const [row] = await this.db.select().from(schema.decks).where(eq(schema.decks.id, id))
    return row ?? null
  }

  /** The deck with the user's role, for permission checks. */
  async forUser(id: string, userId: string): Promise<DeckWithRole | null> {
    const row = await this.get(id)
    return row ? { ...row, role: await this.roleOf(id, userId) } : null
  }

  async bySlug(slug: string): Promise<DeckRow | null> {
    const [row] = await this.db.select().from(schema.decks).where(eq(schema.decks.slug, slug))
    return row ?? null
  }

  async bySlugForUser(slug: string, userId: string): Promise<DeckWithRole | null> {
    const row = await this.bySlug(slug)
    return row ? { ...row, role: await this.roleOf(row.id, userId) } : null
  }

  async roleOf(deckId: string, userId: string): Promise<DeckRole | null> {
    const [row] = await this.db
      .select({ role: schema.deckMembers.role })
      .from(schema.deckMembers)
      .where(and(eq(schema.deckMembers.deckId, deckId), eq(schema.deckMembers.userId, userId)))
    return row?.role ?? null
  }

  // --- Sharing ---

  async sharing(id: string): Promise<DeckSharing | null> {
    const deck = await this.get(id)
    if (!deck) return null
    const members = await this.db
      .select({ userId: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.deckMembers.role })
      .from(schema.deckMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.deckMembers.userId))
      .where(eq(schema.deckMembers.deckId, id))
      .orderBy(schema.users.name)
    const order = { owner: 0, editor: 1, viewer: 2 }
    return { access: deck.access, members: members.sort((a, b) => order[a.role] - order[b.role]) }
  }

  async setAccess(id: string, access: DeckAccess) {
    await this.db.update(schema.decks).set({ access }).where(eq(schema.decks.id, id))
  }

  /**
   * Adds or changes a member. Making someone owner transfers ownership:
   * the previous owner stays on as editor, so a deck always has exactly one owner.
   */
  async setMember(id: string, userId: string, role: DeckRole) {
    await this.db.transaction(async (tx) => {
      if (role === 'owner') {
        await tx
          .update(schema.deckMembers)
          .set({ role: 'editor' })
          .where(and(eq(schema.deckMembers.deckId, id), eq(schema.deckMembers.role, 'owner')))
        await tx.update(schema.decks).set({ ownerId: userId }).where(eq(schema.decks.id, id))
      }
      await tx
        .insert(schema.deckMembers)
        .values({ deckId: id, userId, role })
        .onConflictDoUpdate({ target: [schema.deckMembers.deckId, schema.deckMembers.userId], set: { role } })
    })
  }

  async removeMember(id: string, userId: string) {
    await this.db
      .delete(schema.deckMembers)
      .where(and(eq(schema.deckMembers.deckId, id), eq(schema.deckMembers.userId, userId)))
  }

  async create(
    input: CreateDeck,
    ownerId: string,
    opts: { themeId?: string | null; content?: string } = {},
  ): Promise<Deck> {
    const slug = await this.uniqueSlug(slugify(input.title))
    const row = await this.db.transaction(async (tx) => {
      const [deck] = await tx
        .insert(schema.decks)
        .values({ slug, title: input.title, ownerId, themeId: opts.themeId ?? null })
        .returning()
      await tx.insert(schema.deckMembers).values({ deckId: deck!.id, userId: ownerId, role: 'owner' })
      return deck!
    })
    await mkdir(join(this.dir(row.id), 'public'), { recursive: true })
    await writeAtomic(this.slidesPath(row.id), opts.content ?? initialSlides(input.title))
    return toDeck({ ...row, role: 'owner' }, { id: ownerId, email: '', name: '', isAdmin: false, autoApply: false })
  }

  async update(id: string, patch: { title?: string; archived?: boolean; themeId?: string | null }): Promise<Deck | null> {
    const [row] = await this.db
      .update(schema.decks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.decks.id, id))
      .returning()
    return row ? toDeck(row) : null
  }

  async touch(id: string) {
    await this.db.update(schema.decks).set({ updatedAt: new Date() }).where(eq(schema.decks.id, id))
  }

  readSlides(id: string): Promise<string> {
    return readFile(this.slidesPath(id), 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return ''
      throw err
    })
  }

  writeSlides(id: string, content: string) {
    return writeAtomic(this.slidesPath(id), content)
  }

  /** Slugs are subdomain labels for previews, so they stay unique and never change. */
  private async uniqueSlug(base: string): Promise<string> {
    const taken = new Set(
      (
        await this.db
          .select({ slug: schema.decks.slug })
          .from(schema.decks)
          .where(or(eq(schema.decks.slug, base), like(schema.decks.slug, `${base}-%`)))
      ).map((r) => r.slug),
    )
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`
      if (!taken.has(candidate)) return candidate
    }
  }
}

let tmpCounter = 0

export async function writeAtomic(path: string, content: string) {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

