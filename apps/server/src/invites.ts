import { and, eq, gt, isNull } from 'drizzle-orm'
import type { InviteLink, PendingInvite } from '@slidango/shared'
import { randomToken, sha256Hex } from './auth'
import { type Db, schema } from './db'

const INVITE_DAYS = 7

type InviteRow = typeof schema.invites.$inferSelect

/**
 * One-time links for AUTH_MODE=local. An admin copies the link and hands it over;
 * no mail server needed. Only the token's hash is stored.
 */
export class Invites {
  constructor(
    private db: Db,
    private publicUrl: string,
  ) {}

  /** Creates a link; older open links for the same email and purpose stop working. */
  async create(input: { email: string; purpose: 'invite' | 'reset'; grantAdmin?: boolean; createdBy: string | null }): Promise<InviteLink> {
    const email = input.email.toLowerCase()
    const token = randomToken()
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000)
    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.invites)
        .where(and(eq(schema.invites.email, email), eq(schema.invites.purpose, input.purpose), isNull(schema.invites.usedAt)))
      await tx.insert(schema.invites).values({
        email,
        tokenHash: sha256Hex(token),
        purpose: input.purpose,
        grantAdmin: input.grantAdmin ?? false,
        createdBy: input.createdBy,
        expiresAt,
      })
    })
    return { url: `${new URL(this.publicUrl).origin}/invite/${token}`, expiresAt: expiresAt.toISOString() }
  }

  /** The open, unexpired invite for a token, or null. */
  async find(token: string): Promise<InviteRow | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null
    const [row] = await this.db
      .select()
      .from(schema.invites)
      .where(
        and(eq(schema.invites.tokenHash, sha256Hex(token)), isNull(schema.invites.usedAt), gt(schema.invites.expiresAt, new Date())),
      )
    return row ?? null
  }

  /** Marks the invite used; false if someone else used it first. */
  async consume(id: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.invites)
      .set({ usedAt: new Date() })
      .where(and(eq(schema.invites.id, id), isNull(schema.invites.usedAt)))
      .returning({ id: schema.invites.id })
    return rows.length === 1
  }

  async pending(): Promise<PendingInvite[]> {
    const rows = await this.db
      .select()
      .from(schema.invites)
      .where(and(isNull(schema.invites.usedAt), gt(schema.invites.expiresAt, new Date())))
      .orderBy(schema.invites.createdAt)
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      purpose: r.purpose,
      grantAdmin: r.grantAdmin,
      expiresAt: r.expiresAt.toISOString(),
    }))
  }

  async revoke(id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false
    const rows = await this.db
      .delete(schema.invites)
      .where(and(eq(schema.invites.id, id), isNull(schema.invites.usedAt)))
      .returning({ id: schema.invites.id })
    return rows.length === 1
  }
}
