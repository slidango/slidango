/**
 * Maintenance commands, e.g. inside the container:
 *   docker compose exec app npx tsx src/cli.ts invite admin@example.com
 * `invite` prints a one-time admin setup link (AUTH_MODE=local) and works for existing accounts too.
 */
import { loadConfig } from './config'
import { openDb } from './db'
import { Invites } from './invites'

const [command, email] = process.argv.slice(2)
const config = loadConfig()

if (command !== 'invite' || !email || !email.includes('@')) {
  console.error('usage: tsx src/cli.ts invite <email>')
  process.exit(2)
}
if (config.auth.mode !== 'local') {
  console.error('Invite links only exist with AUTH_MODE=local; with SSO, add the address to ADMIN_EMAILS instead.')
  process.exit(1)
}

const { db, close } = await openDb(config.databaseUrl)
try {
  const link = await new Invites(db, config.publicUrl).create({ email, purpose: 'invite', grantAdmin: true, createdBy: null })
  console.log(`Admin setup link for ${email} (valid until ${link.expiresAt}):\n${link.url}`)
} finally {
  await close()
}
