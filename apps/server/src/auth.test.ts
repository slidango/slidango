import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { createSession, readSession } from './auth'
import { loadConfig } from './config'
import { type Db, openDb } from './db'

const PASSWORD = 'gemeinsam-geheim'
const ADMIN_PASSWORD = 'admin-geheim-123'
const SECRET = 'x'.repeat(40)

let dataDir: string
let db: Db
let closeDb: () => Promise<void>

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'slidango-auth-'))
  ;({ db, close: closeDb } = await openDb(process.env.TEST_DATABASE_URL ?? 'pglite:memory'))
})

afterAll(async () => {
  await closeDb()
  await rm(dataDir, { recursive: true, force: true })
})

const passwordEnv = {
  AUTH_MODE: 'password',
  AUTH_PASSWORD: PASSWORD,
  AUTH_ADMIN_PASSWORD: ADMIN_PASSWORD,
  AUTH_SECRET: SECRET,
  PUBLIC_URL: 'https://slides.intern',
  PREVIEW_DOMAIN: 'slides.intern',
}

async function start(env: Record<string, string> = {}) {
  const built = await buildApp(loadConfig({ DATA_DIR: dataDir, ...passwordEnv, ...env }), db)
  built.app.log.level = 'warn'
  return built
}

function sessionFrom(setCookie: string | string[] | undefined) {
  const header = Array.isArray(setCookie) ? setCookie[0]! : setCookie!
  return header.split(';')[0]!
}

describe('config', () => {
  it('defaults to oidc and validates password mode', () => {
    expect(loadConfig({}).auth).toEqual({ mode: 'oidc' })
    expect(() => loadConfig({ AUTH_MODE: 'ldap' })).toThrow(/AUTH_MODE/)
    expect(() => loadConfig({ ...passwordEnv, AUTH_PASSWORD: 'kurz' })).toThrow(/AUTH_PASSWORD/)
    expect(() => loadConfig({ ...passwordEnv, AUTH_SECRET: 'zu-kurz' })).toThrow(/AUTH_SECRET/)
    expect(() => loadConfig({ ...passwordEnv, AUTH_ADMIN_PASSWORD: PASSWORD })).toThrow(/differ/)
    const auth = loadConfig(passwordEnv).auth
    expect(auth).toMatchObject({ mode: 'password', cookieDomain: 'slides.intern', secure: true })
  })
})

describe('sessions', () => {
  const auth = loadConfig(passwordEnv).auth as Extract<ReturnType<typeof loadConfig>['auth'], { mode: 'password' }>
  const identity = { email: 'a@example.com', name: 'A', isAdmin: false }

  it('accepts its own tokens and rejects tampered, expired or re-keyed ones', () => {
    const token = createSession(identity, auth)
    expect(readSession(`other=1; slides_session=${token}`, auth)).toEqual(identity)

    const [payload, signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ e: 'a@example.com', n: 'A', a: true, x: Date.now() + 1e9 })).toString(
      'base64url',
    )
    expect(readSession(`slides_session=${forged}.${signature}`, auth)).toBeNull()
    expect(readSession(`slides_session=${payload}.`, auth)).toBeNull()
    expect(readSession(`slides_session=${token}`, auth, Date.now() + 31 * 86_400_000)).toBeNull()
    expect(readSession(`slides_session=${token}`, { ...auth, password: 'neues-passwort' })).toBeNull()
  })
})

describe('password login', () => {
  it('logs in with the shared password and ignores proxy headers', async () => {
    const { app } = await start()
    const spoofed = await app.inject({ url: '/api/me', headers: { 'x-auth-request-email': 'mallory@example.com' } })
    expect(spoofed.statusCode).toBe(401)
    expect((await app.inject({ url: '/api/auth/config' })).json()).toEqual({ mode: 'password' })

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Alice', email: 'alice@example.com', password: 'falsch' },
    })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.headers['set-cookie']).toBeUndefined()

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Alice', email: 'Alice@Example.com', password: PASSWORD },
    })
    expect(ok.statusCode).toBe(200)
    const setCookie = String(ok.headers['set-cookie'])
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/Domain=slides\.intern/)
    expect(setCookie).toMatch(/Secure/)
    const cookie = sessionFrom(ok.headers['set-cookie'])
    expect(ok.json().user).toMatchObject({ email: 'alice@example.com', name: 'Alice', isAdmin: false })

    const me = await app.inject({ url: '/api/me', headers: { cookie } })
    expect(me.json()).toMatchObject({ email: 'alice@example.com', isAdmin: false })
    const deck = await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie }, payload: { title: 'Mit Passwort' } })
    expect(deck.statusCode).toBe(201)
    expect((await app.inject({ url: '/api/admin/previews', headers: { cookie } })).statusCode).toBe(403)

    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
    expect(String(logout.headers['set-cookie'])).toMatch(/Max-Age=0/)
    await app.close()
  })

  it('grants admin rights with the admin password only', async () => {
    const { app } = await start()
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'Admin', email: 'admin@example.com', password: ADMIN_PASSWORD },
    })
    const cookie = sessionFrom(login.headers['set-cookie'])
    expect(login.json().user).toMatchObject({ isAdmin: true })
    expect((await app.inject({ url: '/api/admin/previews', headers: { cookie } })).statusCode).toBe(200)
    await app.close()
  })

  it('only redirects back to the app or its previews', async () => {
    const { app } = await start()
    const login = (next: string) =>
      app
        .inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { name: 'A', email: 'a@example.com', password: PASSWORD, next },
        })
        .then((r) => r.json().next)
    expect(await login('https://deck-1.slides.intern/2')).toBe('https://deck-1.slides.intern/2')
    expect(await login('/decks/abc')).toBe('https://slides.intern/decks/abc')
    expect(await login('https://evil.example.com/')).toBeNull()
    expect(await login('https://slides.intern.evil.example.com/')).toBeNull()
    expect(await login('http://deck-1.slides.intern/')).toBeNull()
    await app.close()
  })

  it('sends unauthenticated preview visitors to the login page', async () => {
    const { app } = await start()
    const res = await app.inject({ url: '/3', headers: { host: 'some-deck.slides.intern' } })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(
      `https://slides.intern/login?next=${encodeURIComponent('https://some-deck.slides.intern/3')}`,
    )
    await app.close()
  })

  it('locks out a client after repeated failures', async () => {
    const { app } = await start()
    // nginx/Caddy append the real address; the client controls everything before it.
    const attempt = (password: string, spoofed: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `${spoofed}, 203.0.113.7` },
        payload: { name: 'A', email: 'a@example.com', password },
      })
    for (let i = 0; i < 10; i++) expect((await attempt('falsch', `10.0.0.${i}`)).statusCode).toBe(401)
    expect((await attempt(PASSWORD, '10.0.0.99')).statusCode).toBe(429)
    await app.close()
  }, 20_000)
})

describe('oidc mode', () => {
  it('has no password login', async () => {
    const { app } = await start({ AUTH_MODE: 'oidc' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'A', email: 'a@example.com', password: PASSWORD },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
