import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { desc, eq, like, or } from 'drizzle-orm'
import { type CreateDeck, type Deck, slugify } from '@slidango/shared'
import type { Db } from './db'
import { schema } from './db'

type DeckRow = typeof schema.decks.$inferSelect

export function toDeck(row: DeckRow): Deck {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    ownerId: row.ownerId,
    themeVersion: row.themeVersion,
    archived: row.archived,
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

  async list(includeArchived = false): Promise<Deck[]> {
    const rows = await this.db
      .select()
      .from(schema.decks)
      .where(includeArchived ? undefined : eq(schema.decks.archived, false))
      .orderBy(desc(schema.decks.updatedAt))
    return rows.map(toDeck)
  }

  async get(id: string): Promise<DeckRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    const [row] = await this.db.select().from(schema.decks).where(eq(schema.decks.id, id))
    return row ?? null
  }

  async bySlug(slug: string): Promise<DeckRow | null> {
    const [row] = await this.db.select().from(schema.decks).where(eq(schema.decks.slug, slug))
    return row ?? null
  }

  async create(
    input: CreateDeck,
    ownerId: string,
    opts: { themeVersion?: string | null; content?: string } = {},
  ): Promise<Deck> {
    const slug = await this.uniqueSlug(slugify(input.title))
    const row = await this.db.transaction(async (tx) => {
      const [deck] = await tx
        .insert(schema.decks)
        .values({ slug, title: input.title, ownerId, themeVersion: opts.themeVersion ?? null })
        .returning()
      await tx.insert(schema.deckMembers).values({ deckId: deck!.id, userId: ownerId, role: 'owner' })
      return deck!
    })
    await mkdir(join(this.dir(row.id), 'public'), { recursive: true })
    await writeAtomic(this.slidesPath(row.id), opts.content ?? initialSlides(input.title))
    return toDeck(row)
  }

  async update(id: string, patch: { title?: string; archived?: boolean; themeVersion?: string | null }): Promise<Deck | null> {
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

