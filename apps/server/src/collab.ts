import { Hocuspocus } from '@hocuspocus/server'
import { eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { SLIDES_TEXT, type User, collabDocumentName, deckIdFromDocumentName } from '@slidango/shared'
import { can, type Users } from './auth'
import type { Config } from './config'
import { type Db, schema } from './db'
import type { Decks } from './decks'

export interface CollabContext {
  user?: User
  /** Set for server-side changes (restore, LLM, template switch). */
  origin?: string
}

interface PendingWrite {
  timer: NodeJS.Timeout
  document: Y.Doc
}

/**
 * Hocuspocus is the only writer of slides.md. Every change (clients, LLM,
 * restores) goes through a Y.Doc and lands on disk via the debounced sync below.
 */
export function createCollab(deps: { db: Db; decks: Decks; users: Users; config: Config; log: Logger }) {
  const { db, decks, users, config, log } = deps
  const pendingWrites = new Map<string, PendingWrite>()
  const lastWritten = new Map<string, string>()

  async function writeToDisk(deckId: string, document: Y.Doc) {
    const content = document.getText(SLIDES_TEXT).toString()
    if (lastWritten.get(deckId) === content) return
    await decks.writeSlides(deckId, content)
    lastWritten.set(deckId, content)
  }

  function scheduleDiskWrite(deckId: string, document: Y.Doc) {
    const pending = pendingWrites.get(deckId)
    if (pending) clearTimeout(pending.timer)
    const timer = setTimeout(() => {
      pendingWrites.delete(deckId)
      writeToDisk(deckId, document).catch((err) => log.error({ err, deckId }, 'writing slides.md failed'))
    }, config.diskSyncDebounceMs)
    pendingWrites.set(deckId, { timer, document })
  }

  async function flushDiskWrite(deckId: string) {
    const pending = pendingWrites.get(deckId)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingWrites.delete(deckId)
    await writeToDisk(deckId, pending.document)
  }

  async function storeState(deckId: string, document: Y.Doc) {
    const state = Y.encodeStateAsUpdate(document)
    await db
      .insert(schema.yjsDocuments)
      .values({ deckId, state })
      .onConflictDoUpdate({ target: schema.yjsDocuments.deckId, set: { state, updatedAt: new Date() } })
    await decks.touch(deckId)
  }

  function requireDeckId(documentName: string) {
    const deckId = deckIdFromDocumentName(documentName)
    if (!deckId) throw new Error(`unknown document ${documentName}`)
    return deckId
  }

  const hocuspocus = new Hocuspocus<CollabContext>({
    name: 'slidango',
    debounce: config.storeDebounceMs,
    maxDebounce: 10_000,
    quiet: true,

    async onAuthenticate({ documentName, requestHeaders, connectionConfig }) {
      const user = await users.fromHeaders(requestHeaders)
      const deckId = deckIdFromDocumentName(documentName)
      const deck = deckId ? await decks.get(deckId) : null
      if (!user || !deck || !can(user, deck, 'view')) throw new Error('forbidden')
      connectionConfig.readOnly = deck.archived || !can(user, deck, 'edit')
      return { user }
    },

    async onLoadDocument({ documentName, document }) {
      const deckId = requireDeckId(documentName)
      const [row] = await db.select().from(schema.yjsDocuments).where(eq(schema.yjsDocuments.deckId, deckId))
      if (row) {
        Y.applyUpdate(document, row.state)
      } else {
        // Decks get their Yjs state at creation; this only covers decks without one.
        // Store the seed right away: seeding twice would create different Yjs items
        // for the same text, and clients holding the first seed would get it doubled.
        document.getText(SLIDES_TEXT).insert(0, await decks.readSlides(deckId))
        await storeState(deckId, document)
      }
      return document
    },

    async afterLoadDocument({ documentName, document }) {
      const deckId = requireDeckId(documentName)
      lastWritten.set(deckId, await decks.readSlides(deckId))
      await writeToDisk(deckId, document)
    },

    async onChange({ documentName, document }) {
      scheduleDiskWrite(requireDeckId(documentName), document)
    },

    async onStoreDocument({ documentName, document }) {
      const deckId = requireDeckId(documentName)
      await storeState(deckId, document)
      await flushDiskWrite(deckId)
    },

    async afterUnloadDocument({ documentName }) {
      const deckId = requireDeckId(documentName)
      await flushDiskWrite(deckId)
      lastWritten.delete(deckId)
    },
  })

  return {
    hocuspocus,

    /** Creates the Yjs state of a new deck, so the document is seeded exactly once. */
    async initDocument(deckId: string, content: string) {
      const document = new Y.Doc()
      document.getText(SLIDES_TEXT).insert(0, content)
      await storeState(deckId, document)
      document.destroy()
    },

    /** Number of live client connections for a deck (used by the runner's idle shutdown). */
    connectionCount(deckId: string) {
      return hocuspocus.documents.get(collabDocumentName(deckId))?.getConnectionsCount() ?? 0
    },

    /** Writes the live state of one deck to disk now (e.g. before a Git commit). */
    async flushDeck(deckId: string) {
      const document = hocuspocus.documents.get(collabDocumentName(deckId))
      if (!document || document.isLoading) return
      await flushDiskWrite(deckId)
      await writeToDisk(deckId, document)
    },

    /**
     * Replaces the deck text through Hocuspocus so every client sees it live.
     * `update` may be a function of the current text; it runs inside the Yjs
     * transaction, so nothing typed concurrently is lost. Returning null leaves
     * the text unchanged. Only the changed middle part is replaced, which keeps
     * other cursors stable. Resolves to the text that was written (or null).
     */
    async replaceContent(
      deckId: string,
      update: string | ((current: string) => string | null),
      origin = 'server',
    ): Promise<string | null> {
      const connection = await hocuspocus.openDirectConnection(collabDocumentName(deckId), { origin })
      let written: string | null = null
      try {
        await connection.transact((document) => {
          const text = document.getText(SLIDES_TEXT)
          const current = text.toString()
          const content = typeof update === 'function' ? update(current) : update
          if (content === null) return
          written = content
          if (current === content) return
          let start = 0
          while (start < current.length && start < content.length && current[start] === content[start]) start++
          let end = 0
          while (
            end < current.length - start &&
            end < content.length - start &&
            current[current.length - 1 - end] === content[content.length - 1 - end]
          )
            end++
          text.delete(start, current.length - start - end)
          text.insert(start, content.slice(start, content.length - end))
        })
        await this.flushDeck(deckId)
      } finally {
        await connection.disconnect()
      }
      return written
    },

    /** Current deck text: the live document if loaded, else the file. */
    async readContent(deckId: string): Promise<string> {
      const document = hocuspocus.documents.get(collabDocumentName(deckId))
      if (document && !document.isLoading) return document.getText(SLIDES_TEXT).toString()
      return decks.readSlides(deckId)
    },

    /** Persist everything before the process exits. */
    async flushAll() {
      await Promise.all(
        [...hocuspocus.documents.values()].map(async (document) => {
          if (document.isLoading) return
          const deckId = requireDeckId(document.name)
          await storeState(deckId, document)
          await flushDiskWrite(deckId)
          await writeToDisk(deckId, document)
        }),
      )
    },
  }
}

export type Collab = ReturnType<typeof createCollab>

export interface Logger {
  error(obj: object, msg: string): void
}
