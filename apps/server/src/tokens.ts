import { and, desc, eq, gt, isNull, or } from 'drizzle-orm'
import type { ApiToken, CreatedToken, TokenScope, User } from '@slidango/shared'
import { type AuthContext, randomToken, sha256Hex, toUser } from './auth'
import { type Db, schema } from './db'

const PREFIX = 'sld_'
const LAST_USED_EVERY_MS = 60_000

type TokenRow = typeof schema.apiTokens.$inferSelect

function toToken(row: TokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: row.scope,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }
}

/**
 * Personal access tokens (`sld_…`) for the API and MCP. Only the SHA-256 hash is stored.
 * A token acts as its owner, checked fresh on every request: disabled owners or lost deck
 * rights apply at once. Tokens never carry admin rights; `read` tokens only view.
 */
export class Tokens {
  private lastUsed = new Map<string, number>()

  constructor(private db: Db) {}

  async create(user: User, input: { name: string; scope: TokenScope; expiresInDays: number | null }): Promise<CreatedToken> {
    const token = randomToken(PREFIX)
    const [row] = await this.db
      .insert(schema.apiTokens)
      .values({
        userId: user.id,
        name: input.name,
        prefix: token.slice(0, PREFIX.length + 6),
        tokenHash: sha256Hex(token),
        scope: input.scope,
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      })
      .returning()
    return { ...toToken(row!), token }
  }

  /** Active tokens of a user. */
  async list(userId: string): Promise<ApiToken[]> {
    const rows = await this.db
      .select()
      .from(schema.apiTokens)
      .where(and(eq(schema.apiTokens.userId, userId), this.active()))
      .orderBy(desc(schema.apiTokens.createdAt))
    return rows.map(toToken)
  }

  async revoke(userId: string, id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false
    const rows = await this.db
      .update(schema.apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.apiTokens.id, id), eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
      .returning({ id: schema.apiTokens.id })
    return rows.length === 1
  }

  async revokeAll(userId: string): Promise<number> {
    const rows = await this.db
      .update(schema.apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
      .returning({ id: schema.apiTokens.id })
    return rows.length
  }

  /** The caller behind a bearer token, or null if unknown, revoked, expired or its owner is disabled. */
  async resolve(token: string): Promise<AuthContext | null> {
    const [row] = await this.db
      .select({ token: schema.apiTokens, user: schema.users })
      .from(schema.apiTokens)
      .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
      .where(and(eq(schema.apiTokens.tokenHash, sha256Hex(token)), this.active()))
    if (!row || row.user.status !== 'active') return null
    this.touch(row.token.id)
    return {
      user: { ...toUser(row.user), isAdmin: false },
      via: 'token',
      token: { id: row.token.id, name: row.token.name, scope: row.token.scope },
    }
  }

  private active() {
    return and(
      isNull(schema.apiTokens.revokedAt),
      or(isNull(schema.apiTokens.expiresAt), gt(schema.apiTokens.expiresAt, new Date())),
    )
  }

  private touch(id: string) {
    const now = Date.now()
    if ((this.lastUsed.get(id) ?? 0) > now - LAST_USED_EVERY_MS) return
    this.lastUsed.set(id, now)
    void this.db
      .update(schema.apiTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(schema.apiTokens.id, id))
      .catch(() => {})
  }
}

/** Requests per token and minute; MCP clients in a loop should not swamp the server. */
export class TokenRateLimiter {
  private windows = new Map<string, { start: number; count: number }>()

  constructor(
    private max = 120,
    private windowMs = 60_000,
  ) {}

  allow(id: string, now = Date.now()): boolean {
    const w = this.windows.get(id)
    if (!w || w.start + this.windowMs < now) {
      this.windows.set(id, { start: now, count: 1 })
      if (this.windows.size > 10_000) for (const [k, v] of this.windows) if (v.start + this.windowMs < now) this.windows.delete(k)
      return true
    }
    w.count++
    return w.count <= this.max
  }
}
