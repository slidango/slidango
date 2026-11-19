import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { User } from '@slidango/shared'
import type { Config } from './config'
import { type Db, schema } from './db'

// Set by Caddy forward_auth from the oauth2-proxy auth response. Caddy drops
// client-supplied copies, and the app is only reachable through Caddy.
const EMAIL_HEADER = 'x-auth-request-email'
const NAME_HEADERS = ['x-auth-request-preferred-username', 'x-auth-request-user']

type HeaderBag = Headers | Record<string, string | string[] | undefined>

function header(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

export interface Identity {
  email: string
  name: string
  isAdmin: boolean
}

export function identityFromHeaders(headers: HeaderBag, config: Config): Identity | null {
  if (config.auth.mode === 'password') {
    // Proxy headers are not trusted here: nothing in front of the app vouches for them.
    const session = readSession(header(headers, 'cookie'), config.auth)
    if (session) return session
  } else {
    const email = header(headers, EMAIL_HEADER)?.trim().toLowerCase()
    if (email) {
      const name = NAME_HEADERS.map((h) => header(headers, h)?.trim()).find(Boolean) ?? email
      return { email, name, isAdmin: config.adminEmails.includes(email) }
    }
  }
  if (!config.devUser) return null
  const email = config.devUser.email.toLowerCase()
  return { email, name: config.devUser.name, isAdmin: config.adminEmails.includes(email) }
}

// --- Shared-password sessions ------------------------------------------------

type PasswordAuth = Extract<Config['auth'], { mode: 'password' }>

export const SESSION_COOKIE = 'slides_session'

const sha256 = (value: string) => createHash('sha256').update(value).digest()

/** Constant-time comparison; hashing first makes the lengths equal. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b))
}

/** Changing a password changes the key, which ends every existing session. */
function sessionKey(auth: PasswordAuth): Buffer {
  return createHmac('sha256', auth.secret)
    .update(`session\0${auth.password}\0${auth.adminPassword ?? ''}`)
    .digest()
}

function sign(payload: string, auth: PasswordAuth): string {
  return createHmac('sha256', sessionKey(auth)).update(payload).digest('base64url')
}

export function createSession(identity: Identity, auth: PasswordAuth, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ e: identity.email, n: identity.name, a: identity.isAdmin, x: now + auth.sessionDays * 86_400_000 }),
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

export function readSession(cookieHeader: string | undefined, auth: PasswordAuth, now = Date.now()): Identity | null {
  const token = cookieValue(cookieHeader, SESSION_COOKIE)
  if (!token) return null
  const [payload, signature] = token.split('.')
  if (!payload || !signature || !safeEqual(signature, sign(payload, auth))) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof data.e !== 'string' || typeof data.n !== 'string' || typeof data.x !== 'number' || data.x < now) return null
    return { email: data.e, name: data.n, isAdmin: data.a === true }
  } catch {
    return null
  }
}

export function sessionCookie(token: string | null, auth: PasswordAuth): string {
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

/** Which password was entered: `admin`, `user`, or null if neither. */
export function checkPassword(input: string, auth: PasswordAuth): 'admin' | 'user' | null {
  // Compare against both so the response time does not reveal which one matched.
  const isUser = safeEqual(input, auth.password)
  const isAdmin = auth.adminPassword !== null && safeEqual(input, auth.adminPassword)
  return isAdmin ? 'admin' : isUser ? 'user' : null
}

/** Failed logins per client, so the shared password cannot be guessed at full speed. */
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

export class Users {
  private cache = new Map<string, User>()

  constructor(
    private db: Db,
    private config: Config,
  ) {}

  /** Resolves the request's user, creating it on first sight. */
  async fromHeaders(headers: HeaderBag): Promise<User | null> {
    const identity = identityFromHeaders(headers, this.config)
    if (!identity) return null
    const cached = this.cache.get(identity.email)
    if (cached && cached.name === identity.name && cached.isAdmin === identity.isAdmin) return cached

    const { isAdmin } = identity
    const [row] = await this.db
      .insert(schema.users)
      .values({ email: identity.email, name: identity.name, isAdmin })
      .onConflictDoUpdate({ target: schema.users.email, set: { name: identity.name, isAdmin } })
      .returning()
    const user: User = { id: row!.id, email: row!.email, name: row!.name, isAdmin: row!.isAdmin, autoApply: row!.autoApply }
    this.cache.set(identity.email, user)
    return user
  }

  async update(user: User, patch: { autoApply: boolean }): Promise<User> {
    const [row] = await this.db.update(schema.users).set(patch).where(eq(schema.users.id, user.id)).returning()
    const updated: User = { ...user, autoApply: row!.autoApply }
    this.cache.set(user.email, updated)
    return updated
  }

  async byId(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.id, id))
    return row ? { id: row.id, email: row.email, name: row.name, isAdmin: row.isAdmin, autoApply: row.autoApply } : null
  }
}

export type Action = 'view' | 'edit' | 'manage'

/**
 * Single permission check for API, collab, preview proxy and proposals.
 * v1: every signed-in user may do everything. Roles come from deck_members later.
 */
export function can(user: User | null, _deck: { id: string; ownerId: string }, _action: Action): boolean {
  return user !== null
}
