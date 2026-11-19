import { buildApp } from './app'
import { loadConfig } from './config'
import { openDb } from './db'

const config = loadConfig()
const { db, close } = await openDb(config.databaseUrl)
const { app } = await buildApp(config, db)

await app.listen({ port: config.port, host: config.host })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down')
    await app.close()
    await close()
    process.exit(0)
  })
}
