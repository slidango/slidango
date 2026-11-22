import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { createSession, hashPassword, readSession, verifyPassword } from './auth'
import { loadConfig } from './config'
import type { Db } from './db'
import { openTestDb } from './test-db'

const SECRET = 'x'.repeat(40)

let dataDir: string
let db: Db
let closeDb: () => Promise<void>

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'slidango-auth-'))
  ;({ db, close: closeDb } = await openTestDb())
})

afterAll(async () => {
  await closeDb()
  await rm(dataDir, { recursive: true, force: true })
})

const localEnv = {
  AUTH_MODE: 'local',
  AUTH_SECRET: SECRET,
  PUBLIC_URL: 'https://slides.intern',
  PREVIEW_DOMAIN: 'slides.intern',
  ADMIN_EMAILS: 'root@example.com',
}

async function start(env: Record<string, string> = {}) {
  const built = await buildApp(loadConfig({ DATA_DIR: dataDir, ...localEnv, ...env }), db)
  built.app.log.level = 'silent'
  return built
}

function cookieFrom(setCookie: string | string[] | undefined) {
  const header = Array.isArray(setCookie) ? setCookie[0]! : setCookie!
  return header.split(';')[0]!
}

const tokenOf = (url: string) => url.split('/invite/')[1]!

describe('config', () => {
  it('defaults to oidc and validates local mode', () => {
    expect(loadConfig({}).auth).toEqual({ mode: 'oidc', allowedDomains: [] })
    expect(loadConfig({ ALLOWED_EMAIL_DOMAINS: '@Example.com, acme.org' }).auth).toEqual({
      mode: 'oidc',
      allowedDomains: ['example.com', 'acme.org'],
    })
    expect(() => loadConfig({ AUTH_MODE: 'ldap' })).toThrow(/AUTH_MODE/)
    expect(() => loadConfig({ ...localEnv, AUTH_SECRET: 'zu-kurz' })).toThrow(/AUTH_SECRET/)
    expect(loadConfig(localEnv).auth).toMatchObject({ mode: 'local', cookieDomain: 'slides.intern', secure: true })
  })

  it('treats the old shared-password mode as local and warns', () => {
    const config = loadConfig({ ...localEnv, AUTH_MODE: 'password', AUTH_PASSWORD: 'gemeinsam-geheim' })
    expect(config.auth.mode).toBe('local')
    expect(config.warnings.join(' ')).toMatch(/deprecated/)
    expect(config.warnings.join(' ')).toMatch(/AUTH_PASSWORD/)
  })
})

describe('passwords and sessions', () => {
  const auth = loadConfig(localEnv).auth as Extract<ReturnType<typeof loadConfig>['auth'], { mode: 'local' }>

  it('hashes with scrypt and verifies', async () => {
    const hash = await hashPassword('correct horse battery')
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/)
    expect(await verifyPassword('correct horse battery', hash)).toBe(true)
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false)
    expect(await verifyPassword('anything', null)).toBe(false)
  })

  it('accepts its own session tokens and rejects tampered or expired ones', () => {
    const session = { userId: '00000000-0000-0000-0000-000000000001', version: 3 }
    const token = createSession(session, auth)
    expect(readSession(`other=1; slides_session=${token}`, auth)).toEqual(session)
    const [payload, signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ u: session.userId, v: 4, x: Date.now() + 1e9 })).toString('base64url')
    expect(readSession(`slides_session=${forged}.${signature}`, auth)).toBeNull()
    expect(readSession(`slides_session=${payload}.`, auth)).toBeNull()
    expect(readSession(`slides_session=${token}`, auth, Date.now() + 31 * 86_400_000)).toBeNull()
    expect(readSession(`slides_session=${token}`, { ...auth, secret: 'y'.repeat(40) })).toBeNull()
  })
})

describe('local accounts', () => {
  it('bootstraps the first admin with a setup link, then invites others', async () => {
    const built = await start()
    const { app, invites } = built
    // The setup link for ADMIN_EMAILS: create one the same way bootstrapAdmins does.
    const setup = await invites.create({ email: 'root@example.com', purpose: 'invite', grantAdmin: true, createdBy: null })

    const info = await app.inject({ url: `/api/auth/invite/${tokenOf(setup.url)}` })
    expect(info.json()).toMatchObject({ email: 'root@example.com', purpose: 'invite' })

    const short = await app.inject({
      method: 'POST',
      url: `/api/auth/invite/${tokenOf(setup.url)}`,
      payload: { name: 'Root', password: 'kurz' },
    })
    expect(short.statusCode).toBe(400)

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/auth/invite/${tokenOf(setup.url)}`,
      payload: { name: 'Root', password: 'root-password-123' },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().user).toMatchObject({ email: 'root@example.com', name: 'Root', isAdmin: true })
    const rootCookie = cookieFrom(accepted.headers['set-cookie'])
    expect(String(accepted.headers['set-cookie'])).toMatch(/HttpOnly.*Domain=slides\.intern.*Secure/)

    // The link works exactly once.
    const again = await app.inject({
      method: 'POST',
      url: `/api/auth/invite/${tokenOf(setup.url)}`,
      payload: { name: 'Mallory', password: 'mallory-password' },
    })
    expect(again.statusCode).toBe(404)

    // Proxy headers mean nothing in local mode.
    expect((await app.inject({ url: '/api/me', headers: { 'x-auth-request-email': 'root@example.com' } })).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/me', headers: { cookie: rootCookie } })).json()).toMatchObject({ isAdmin: true })

    // Invite Alice; she signs in with her own password afterwards.
    const invite = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie: rootCookie },
      payload: { email: 'Alice@Example.com' },
    })
    expect(invite.statusCode).toBe(201)
    const people = await app.inject({ url: '/api/admin/people', headers: { cookie: rootCookie } })
    expect(people.json().invites).toEqual([expect.objectContaining({ email: 'alice@example.com', purpose: 'invite' })])

    await app.inject({
      method: 'POST',
      url: `/api/auth/invite/${tokenOf(invite.json().url)}`,
      payload: { name: 'Alice', password: 'alice-password-1' },
    })
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: 'nope-nope-nope' },
    })
    expect(wrong.statusCode).toBe(401)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ALICE@example.com', password: 'alice-password-1', next: '/decks/x' },
    })
    expect(login.statusCode).toBe(200)
    expect(login.json()).toMatchObject({ user: { name: 'Alice', isAdmin: false }, next: 'https://slides.intern/decks/x' })
    const aliceCookie = cookieFrom(login.headers['set-cookie'])
    expect((await app.inject({ url: '/api/admin/people', headers: { cookie: aliceCookie } })).statusCode).toBe(403)

    // Changing the password ends other sessions but keeps the current one.
    const other = cookieFrom(
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'alice@example.com', password: 'alice-password-1' } }))
        .headers['set-cookie'],
    )
    const changed = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { cookie: aliceCookie },
      payload: { current: 'alice-password-1', password: 'alice-password-2' },
    })
    expect(changed.statusCode).toBe(200)
    const fresh = cookieFrom(changed.headers['set-cookie'])
    expect((await app.inject({ url: '/api/me', headers: { cookie: other } })).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/me', headers: { cookie: fresh } })).statusCode).toBe(200)

    // Admins disable people: their sessions stop at once, and they cannot sign in again.
    const alice = people.json().people.find((p: { email: string }) => p.email === 'root@example.com')
    expect(alice).toMatchObject({ isAdmin: true, hasPassword: true })
    const aliceId = (await app.inject({ url: '/api/me', headers: { cookie: fresh } })).json().id
    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/admin/people/${aliceId}`,
      headers: { cookie: rootCookie },
      payload: { status: 'disabled' },
    })
    expect(disabled.json()).toMatchObject({ status: 'disabled' })
    expect((await app.inject({ url: '/api/me', headers: { cookie: fresh } })).statusCode).toBe(401)
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: 'alice-password-2' },
    })
    expect(blocked.statusCode).toBe(401)

    // Admins cannot lock themselves out.
    const rootId = (await app.inject({ url: '/api/me', headers: { cookie: rootCookie } })).json().id
    const self = await app.inject({
      method: 'PATCH',
      url: `/api/admin/people/${rootId}`,
      headers: { cookie: rootCookie },
      payload: { isAdmin: false },
    })
    expect(self.statusCode).toBe(409)

    // Password reset link for an existing account.
    await app.inject({ method: 'PATCH', url: `/api/admin/people/${aliceId}`, headers: { cookie: rootCookie }, payload: { status: 'active' } })
    const reset = await app.inject({ method: 'POST', url: `/api/admin/people/${aliceId}/reset`, headers: { cookie: rootCookie } })
    expect((await app.inject({ url: `/api/auth/invite/${tokenOf(reset.json().url)}` })).json()).toMatchObject({
      purpose: 'reset',
      name: 'Alice',
    })
    await app.close()
  }, 30_000)

  it('sends unauthenticated preview visitors to the login page', async () => {
    const { app } = await start()
    const res = await app.inject({ url: '/3', headers: { host: 'some-deck.slides.intern' } })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`https://slides.intern/login?next=${encodeURIComponent('https://some-deck.slides.intern/3')}`)
    await app.close()
  })

  it('only redirects back to the app or its previews', async () => {
    const { app, invites } = await start()
    const link = await invites.create({ email: 'nora@example.com', purpose: 'invite', createdBy: null })
    await app.inject({
      method: 'POST',
      url: `/api/auth/invite/${tokenOf(link.url)}`,
      payload: { name: 'Nora', password: 'nora-password-1' },
    })
    const login = (next: string) =>
      app
        .inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nora@example.com', password: 'nora-password-1', next } })
        .then((r) => r.json().next)
    expect(await login('https://deck-1.slides.intern/2')).toBe('https://deck-1.slides.intern/2')
    expect(await login('/decks/abc')).toBe('https://slides.intern/decks/abc')
    expect(await login('https://evil.example.com/')).toBeNull()
    expect(await login('https://slides.intern.evil.example.com/')).toBeNull()
    expect(await login('http://deck-1.slides.intern/')).toBeNull()
    await app.close()
  })

  it('locks out after repeated failures per client and per email', async () => {
    const { app } = await start()
    // nginx/Caddy append the real address; the client controls everything before it.
    const attempt = (email: string, spoofed: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `${spoofed}, 203.0.113.7` },
        payload: { email, password: 'wrong-password' },
      })
    for (let i = 0; i < 10; i++) expect((await attempt(`u${i}@example.com`, `10.0.0.${i}`)).statusCode).toBe(401)
    expect((await attempt('other@example.com', '10.0.0.99')).statusCode).toBe(429)
    await app.close()
  }, 30_000)
})

describe('oidc mode', () => {
  it('has no password login and honours ALLOWED_EMAIL_DOMAINS', async () => {
    const { app } = await start({ AUTH_MODE: 'oidc', ALLOWED_EMAIL_DOMAINS: 'example.com' })
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@example.com', password: 'x' } })
    expect(res.statusCode).toBe(404)
    expect((await app.inject({ url: '/api/me', headers: { 'x-auth-request-email': 'a@example.com' } })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/me', headers: { 'x-auth-request-email': 'a@evil.com' } })).statusCode).toBe(401)
    await app.close()
  })

  it('promotes ADMIN_EMAILS but keeps admin rights granted in the app', async () => {
    const { app, users } = await start({ AUTH_MODE: 'oidc', ADMIN_EMAILS: 'boss@example.com' })
    const boss = { 'x-auth-request-email': 'boss@example.com' }
    const carol = { 'x-auth-request-email': 'carol@example.com' }
    expect((await app.inject({ url: '/api/me', headers: boss })).json()).toMatchObject({ isAdmin: true })
    const carolId = (await app.inject({ url: '/api/me', headers: carol })).json().id
    await app.inject({ method: 'PATCH', url: `/api/admin/people/${carolId}`, headers: boss, payload: { isAdmin: true } })
    // Not in ADMIN_EMAILS, but stays admin on the next request.
    expect((await app.inject({ url: '/api/me', headers: carol })).json()).toMatchObject({ isAdmin: true })
    expect(await users.adminCount()).toBeGreaterThanOrEqual(2)
    await app.close()
  })
})
