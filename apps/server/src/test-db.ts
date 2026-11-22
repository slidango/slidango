import { randomBytes } from 'node:crypto'
import { type Db, openDb } from './db'

/**
 * A fresh database for one test file. With TEST_DATABASE_URL (CI: real Postgres) every file gets
 * its own database on that server, created and dropped here, so files running in parallel never
 * share templates, decks or migrations. Without it, an in-memory PGlite.
 */
export async function openTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return openDb('pglite:memory')
  const { default: postgres } = await import('postgres')
  const name = `slidango_test_${randomBytes(6).toString('hex')}`
  const admin = postgres(url, { max: 1, onnotice: () => {} })
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const target = new URL(url)
  target.pathname = `/${name}`
  const { db, close } = await openDb(target.toString())
  return {
    db,
    close: async () => {
      await close()
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      await admin.end()
    },
  }
}
