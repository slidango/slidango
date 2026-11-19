import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

export { schema }

/**
 * Both drivers share the pg-core query builder; we type against postgres-js and
 * use PGlite (embedded Postgres) only for local development and tests.
 */
export type Db = PostgresJsDatabase<typeof schema>

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle')

export async function openDb(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite')
    const { drizzle } = await import('drizzle-orm/pglite')
    const { migrate } = await import('drizzle-orm/pglite/migrator')
    const path = url.slice('pglite:'.length)
    if (path !== 'memory') mkdirSync(path, { recursive: true })
    const client = new PGlite(path === 'memory' ? undefined : path)
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder })
    return { db: db as unknown as Db, close: () => client.close() }
  }
  const { default: postgres } = await import('postgres')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const { migrate } = await import('drizzle-orm/postgres-js/migrator')
  const client = postgres(url, { max: 10, onnotice: () => {} })
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
  return { db, close: () => client.end() }
}
