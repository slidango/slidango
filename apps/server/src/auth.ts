import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { and, count, eq, gt, isNull, or, sql } from 'drizzle-orm'
import type { DeckAccess, DeckRole, DirectoryUser, Person, TokenScope, User } from '@slidango/shared'
import type { Config } from './config'
import { type Db, schema } from './db'

// Set by Caddy forward_auth from the oauth2-proxy auth response. Caddy drops
// client-supplied copies, and the app is only reachable through Caddy.
const EMAIL_HEADER = 'x-auth-request-email'
const NAME_HEADERS = ['x-auth-request-preferred-username', 'x-auth-request-user']

export type HeaderBag = Headers | Record<string, string | string[] | undefined>

export function header(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest()
export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

/** Constant-time comparison; hashing first makes the lengths equal. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b))
}

/** URL-safe random token with a readable prefix, e.g. `sld_…`. */
export function randomToken(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url')
}

// --- Passwords (AUTH_MODE=local) ----------------------------------------------

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

/** `scrypt$N$r$p$salt$hash`; the parameters travel with the hash so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 })
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = stored?.split('$') ?? []
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    // Same work as a real check, so unknown emails don't answer faster.
    await hashPassword(password)
    return false
  }
  const [, N, r, p, salt, hash] = parts as [string, string, string, string, string, string]
  const expected = Buffer.from(hash, 'base64url')
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// --- Sessions (AUTH_MODE=local) -----------------------------------------------

type LocalAuth = Extract<Config['auth'], { mode: 'local' }>

export const SESSION_COOKIE = 'slides_session'

interface SessionData {
  userId: string
  /** Must match users.session_version; bumping it ends every session of the user. */
  version: number
}

function sessionKey(auth: LocalAuth): Buffer {
  return createHmac('sha256', auth.secret).update('session-v2').digest()
}

function sign(payload: string, auth: LocalAuth): string {
  return createHmac('sha256', sessionKey(auth)).update(payload).digest('base64url')
}

export function createSession(session: SessionData, auth: LocalAuth, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ u: session.userId, v: session.version, x: now + auth.sessionDays * 86_400_000 }),
  ).toString('base64url')
  return `${payload}.${sign(payload, auth)}`
}

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  for (const part of cookieHeader?.split(';') ?? []) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

export function readSession(cookieHeader: string | undefined, auth: LocalAuth, now = Date.now()): SessionData | null {
  const token = cookieValue(cookieHeader, SESSION_COOKIE)
  const [payload, signature] = token?.split('.') ?? []
  if (!payload || !signature || !safeEqual(signature, sign(payload, auth))) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { u?: unknown; v?: unknown; x?: unknown }
    if (typeof data.u !== 'string' || typeof data.v !== 'number' || typeof data.x !== 'number' || data.x < now) return null
    return { userId: data.u, version: data.v }
  } catch {
    return null
  }
}

export function sessionCookie(token: string | null, auth: LocalAuth): string {
  const parts = [
    `${SESSION_COOKIE}=${token ?? ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    token ? `Max-Age=${auth.sessionDays * 86_400}` : 'Max-Age=0',
  ]
  if (auth.cookieDomain) parts.push(`Domain=${auth.cookieDomain}`)
  if (auth.secure) parts.push('Secure')
  return parts.join('; ')
}

/** Failed logins per key (client address, email), so passwords cannot be guessed at full speed. */
export class LoginLimiter {
  private failures = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private max = 10,
    private windowMs = 15 * 60_000,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    const entry = this.failures.get(key)
    if (!entry || entry.resetAt < now) return false
    return entry.count >= this.max
  }

  fail(key: string, now = Date.now()) {
    const entry = this.failures.get(key)
    if (!entry || entry.resetAt < now) this.failures.set(key, { count: 1, resetAt: now + this.windowMs })
    else entry.count++
    if (this.failures.size > 10_000) {
      for (const [k, v] of this.failures) if (v.resetAt < now) this.failures.delete(k)
    }
  }

  reset(key: string) {
    this.failures.delete(key)
  }
}

// --- Users ---------------------------------------------------------------------

type UserRow = typeof schema.users.$inferSelect

export function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, isAdmin: row.isAdmin, autoApply: row.autoApply }
}

/** Who is asking, and how they proved it. Token requests never carry admin rights. */
export interface AuthContext {
  user: User
  via: 'session' | 'proxy' | 'dev' | 'token'
  token?: { id: string; name: string; scope: TokenScope }
}

/** Resolves bearer tokens; set by Tokens so auth does not depend on it. */
export type TokenResolver = (token: string) => Promise<AuthContext | null>

export function bearerToken(headers: HeaderBag): string | null {
  const value = header(headers, 'authorization')
  const match = value ? /^Bearer\s+(sld_[A-Za-z0-9_-]{20,})\s*$/.exec(value) : null
  return match?.[1] ?? null
}

const LAST_SEEN_EVERY_MS = 5 * 60_000

export class Users {
  tokenResolver: TokenResolver | null = null
  private lastSeen = new Map<string, number>()

  constructor(
    private db: Db,
    private config: Config,
  ) {}

  /** Resolves the request's caller: bearer token, session cookie (local), proxy headers (oidc) or the dev user. */
  async resolve(headers: HeaderBag): Promise<AuthContext | null> {
    const bearer = bearerToken(headers)
    if (bearer) return this.tokenResolver ? this.tokenResolver(bearer) : null

    const auth = this.config.auth
    if (auth.mode === 'local') {
      // Proxy headers are not trusted here: nothing in front of the app vouches for them.
      const session = readSession(header(headers, 'cookie'), auth)
      if (session) {
        const row = await this.row(session.userId)
        if (row && row.status === 'active' && row.sessionVersion === session.version && row.passwordHash) {
          this.touch(row.id)
          return { user: toUser(row), via: 'session' }
        }
      }
    } else {
      const email = header(headers, EMAIL_HEADER)?.trim().toLowerCase()
      if (email) {
        if (auth.allowedDomains.length && !auth.allowedDomains.includes(email.split('@')[1] ?? '')) return null
        const name = NAME_HEADERS.map((h) => header(headers, h)?.trim()).find(Boolean) ?? email
        const user = await this.fromIdentity(email, name)
        return user ? { user, via: 'proxy' } : null
      }
    }
    if (!this.config.devUser) return null
    const user = await this.fromIdentity(this.config.devUser.email.toLowerCase(), this.config.devUser.name)
    return user ? { user, via: 'dev' } : null
  }

  async fromHeaders(headers: HeaderBag): Promise<User | null> {
    return (await this.resolve(headers))?.user ?? null
  }

  /**
   * A user vouched for by the proxy (or the dev setting): created on first sight, name kept current.
   * ADMIN_EMAILS promotes but never demotes; admin rights otherwise live in the database.
   */
  private async fromIdentity(email: string, name: string): Promise<User | null> {
    const promote = this.config.adminEmails.includes(email)
    let [row] = await this.db.select().from(schema.users).where(eq(schema.users.email, email))
    if (!row) {
      ;[row] = await this.db
        .insert(schema.users)
        .values({ email, name, isAdmin: promote })
        .onConflictDoUpdate({ target: schema.users.email, set: { name } })
        .returning()
    } else if (row.status !== 'active') {
      return null
    } else if (row.name !== name || (promote && !row.isAdmin)) {
      ;[row] = await this.db
        .update(schema.users)
        .set({ name, isAdmin: row.isAdmin || promote })
        .where(eq(schema.users.id, row.id))
        .returning()
    }
    this.touch(row!.id)
    return toUser(row!)
  }

  private touch(id: string) {
    const now = Date.now()
    if ((this.lastSeen.get(id) ?? 0) > now - LAST_SEEN_EVERY_MS) return
    this.lastSeen.set(id, now)
    void this.db
      .update(schema.users)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(schema.users.id, id))
      .catch(() => {})
  }

  async row(id: string): Promise<UserRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.id, id))
    return row ?? null
  }

  async byId(id: string): Promise<User | null> {
    const row = await this.row(id)
    return row ? toUser(row) : null
  }

  async byEmail(email: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase()))
    return row ?? null
  }

  async create(email: string, name: string, isAdmin: boolean): Promise<UserRow> {
    const [row] = await this.db.insert(schema.users).values({ email: email.toLowerCase(), name, isAdmin }).returning()
    return row!
  }

  /** local mode: verifies email + password; null for unknown, disabled or wrong. */
  async checkLogin(email: string, password: string): Promise<UserRow | null> {
    const row = await this.byEmail(email)
    const ok = await verifyPassword(password, row?.passwordHash ?? null)
    if (!row || !ok || row.status !== 'active') return null
    this.touch(row.id)
    return row
  }

  /** Sets a new password and ends all other sessions; returns the new session version. */
  async setPassword(id: string, password: string): Promise<UserRow> {
    const [row] = await this.db
      .update(schema.users)
      .set({ passwordHash: await hashPassword(password), sessionVersion: sql`${schema.users.sessionVersion} + 1` })
      .where(eq(schema.users.id, id))
      .returning()
    return row!
  }

  /** Signs the user out everywhere (sessions only; tokens are revoked separately). */
  async endSessions(id: string): Promise<UserRow | null> {
    const [row] = await this.db
      .update(schema.users)
      .set({ sessionVersion: sql`${schema.users.sessionVersion} + 1` })
      .where(eq(schema.users.id, id))
      .returning()
    return row ?? null
  }

  async update(user: User, patch: { autoApply?: boolean; name?: string }): Promise<User> {
    const [row] = await this.db.update(schema.users).set(patch).where(eq(schema.users.id, user.id)).returning()
    return toUser(row!)
  }

  async updatePerson(id: string, patch: { status?: 'active' | 'disabled'; isAdmin?: boolean }): Promise<UserRow | null> {
    // Disabling also ends sessions, so re-enabling does not revive old cookies.
    const bump = patch.status === 'disabled' ? { sessionVersion: sql`${schema.users.sessionVersion} + 1` } : {}
    const [row] = await this.db
      .update(schema.users)
      .set({ ...patch, ...bump })
      .where(eq(schema.users.id, id))
      .returning()
    return row ?? null
  }

  async adminCount(): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(schema.users)
      .where(and(eq(schema.users.isAdmin, true), eq(schema.users.status, 'active')))
    return row?.n ?? 0
  }

  /** Everyone, for Settings → People. */
  async people(): Promise<Person[]> {
    const now = new Date()
    const tokens = this.db
      .select({ userId: schema.apiTokens.userId, n: count().as('n') })
      .from(schema.apiTokens)
      .where(
        and(
          isNull(schema.apiTokens.revokedAt),
          or(isNull(schema.apiTokens.expiresAt), gt(schema.apiTokens.expiresAt, now)),
        ),
      )
      .groupBy(schema.apiTokens.userId)
      .as('tokens')
    const rows = await this.db
      .select({ user: schema.users, n: tokens.n })
      .from(schema.users)
      .leftJoin(tokens, eq(tokens.userId, schema.users.id))
      .orderBy(schema.users.name)
    return rows.map(({ user, n }) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: user.isAdmin,
      status: user.status,
      hasPassword: user.passwordHash !== null,
      lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      activeTokens: Number(n ?? 0),
    }))
  }

  /** Active users, offered when sharing a deck. */
  async directory(): Promise<DirectoryUser[]> {
    const rows = await this.db
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.status, 'active'))
      .orderBy(schema.users.name)
    return rows
  }
}

// --- Permissions -----------------------------------------------------------------

export type Action = 'view' | 'edit' | 'manage'

/** A deck as far as permissions go, with the caller's membership role (null: not a member). */
export interface DeckAccessInfo {
  id: string
  ownerId: string
  access: DeckAccess
  role: DeckRole | null
}

const ROLE_ACTIONS: Record<DeckRole, Action[]> = {
  owner: ['view', 'edit', 'manage'],
  editor: ['view', 'edit'],
  viewer: ['view'],
}

const ACCESS_ACTIONS: Record<DeckAccess, Action[]> = {
  'team-edit': ['view', 'edit'],
  'team-view': ['view'],
  members: [],
}

/**
 * Single permission check for API, collab, preview proxy, proposals and MCP.
 * Admins may do everything; members by role; everyone else by the deck's access setting.
 * Read-only tokens never get more than `view`.
 */
export function can(caller: User | AuthContext | null, deck: DeckAccessInfo, action: Action): boolean {
  if (!caller) return false
  const ctx: AuthContext = 'user' in caller ? caller : { user: caller, via: 'session' }
  if (ctx.token?.scope === 'read' && action !== 'view') return false
  if (ctx.user.isAdmin) return true
  if (deck.role && ROLE_ACTIONS[deck.role].includes(action)) return true
  return ACCESS_ACTIONS[deck.access].includes(action)
}

/** The `can` summary sent with decks, so the UI can hide what the user may not do. */
export function permissions(caller: User | AuthContext, deck: DeckAccessInfo) {
  return { edit: can(caller, deck, 'edit'), manage: can(caller, deck, 'manage') }
}
