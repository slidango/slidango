import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  acceptInviteSchema,
  changePasswordSchema,
  createInviteSchema,
  createTokenSchema,
  updateMeSchema,
  updatePersonSchema,
} from '@slidango/shared'
import { LoginLimiter, type Users, createSession, sessionCookie, toUser } from './auth'
import type { Collab } from './collab'
import type { Config } from './config'
import type { Invites } from './invites'
import type { Tokens } from './tokens'

interface Deps {
  config: Config
  users: Users
  invites: Invites
  tokens: Tokens
  collab: Collab
  safeNext: (next: unknown) => string | null
}

/** Sign-in (AUTH_MODE=local), the own account, API tokens and Settings → People. */
export function registerAccountRoutes(app: FastifyInstance, deps: Deps) {
  const { config, users, invites, tokens, collab, safeNext } = deps
  const local = config.auth.mode === 'local' ? config.auth : null

  const requireLocal = () => {
    if (!local) throw app.httpErrors.notFound()
    return local
  }
  const requireAdmin = (req: FastifyRequest) => {
    if (!req.user?.isAdmin || req.auth?.via === 'token') throw app.httpErrors.forbidden()
    return req.user
  }
  const setSession = (reply: FastifyReply, row: { id: string; sessionVersion: number }) => {
    const auth = requireLocal()
    reply.header('set-cookie', sessionCookie(createSession({ userId: row.id, version: row.sessionVersion }, auth), auth))
  }

  // Behind Caddy every request comes from the proxy. The proxy appends the address it saw,
  // so only the right-most entry is trustworthy; anything left of it is client-supplied.
  const clientOf = (req: FastifyRequest) => {
    const forwarded = req.headers['x-forwarded-for']
    return (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)?.split(',').at(-1)?.trim() || req.ip
  }

  app.get('/api/auth/config', async () => ({ mode: config.auth.mode }))

  // --- Sign-in (local) ---

  const loginLimiter = new LoginLimiter()
  const loginSchema = z.object({
    email: z.string().trim().toLowerCase().email().max(200),
    password: z.string().max(200),
    next: z.string().max(2000).optional(),
  })

  app.post('/api/auth/login', async (req, reply) => {
    requireLocal()
    const input = loginSchema.parse(req.body)
    const keys = [`ip:${clientOf(req)}`, `email:${input.email}`]
    if (keys.some((k) => loginLimiter.blocked(k))) {
      return reply.code(429).send({ error: 'Too many failed attempts. Try again in 15 minutes.' })
    }
    const row = await users.checkLogin(input.email, input.password)
    if (!row) {
      keys.forEach((k) => loginLimiter.fail(k))
      await new Promise((r) => setTimeout(r, 300))
      return reply.code(401).send({ error: 'Wrong email or password.' })
    }
    keys.forEach((k) => loginLimiter.reset(k))
    // ADMIN_EMAILS promotes on sign-in, as with SSO.
    const user = config.adminEmails.includes(row.email) && !row.isAdmin
      ? toUser((await users.updatePerson(row.id, { isAdmin: true }))!)
      : toUser(row)
    setSession(reply, row)
    return { user, next: safeNext(input.next) }
  })

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', sessionCookie(null, requireLocal()))
    return { ok: true }
  })

  // --- Invitations and password resets (local) ---

  app.get<{ Params: { token: string } }>('/api/auth/invite/:token', async (req) => {
    requireLocal()
    const invite = await invites.find(req.params.token)
    if (!invite) throw app.httpErrors.notFound('This link is invalid or has expired. Ask an admin for a new one.')
    const existing = await users.byEmail(invite.email)
    return { email: invite.email, purpose: invite.purpose, name: existing?.name ?? '' }
  })

  app.post<{ Params: { token: string } }>('/api/auth/invite/:token', async (req, reply) => {
    requireLocal()
    const input = acceptInviteSchema.parse(req.body)
    const invite = await invites.find(req.params.token)
    if (!invite || !(await invites.consume(invite.id))) {
      throw app.httpErrors.notFound('This link is invalid or has expired. Ask an admin for a new one.')
    }
    let row = await users.byEmail(invite.email)
    if (row?.status === 'disabled') throw app.httpErrors.forbidden('This account is disabled.')
    if (!row) {
      row = await users.create(invite.email, input.name, invite.grantAdmin || config.adminEmails.includes(invite.email))
    } else {
      await users.update(toUser(row), { name: input.name })
      if (invite.grantAdmin && !row.isAdmin) await users.updatePerson(row.id, { isAdmin: true })
    }
    row = await users.setPassword(row.id, input.password)
    collab.disconnect({ userId: row.id })
    setSession(reply, row)
    return { user: toUser(row) }
  })

  // --- Own account ---

  app.get('/api/me', async (req) => req.user)

  app.patch('/api/me', async (req) => {
    const patch = updateMeSchema.parse(req.body)
    // With SSO the name comes from the identity provider on every request.
    if (patch.name !== undefined && !local) delete patch.name
    return users.update(req.user!, patch)
  })

  app.post('/api/me/password', async (req, reply) => {
    requireLocal()
    const input = changePasswordSchema.parse(req.body)
    const row = await users.checkLogin(req.user!.email, input.current)
    if (!row) return reply.code(400).send({ error: 'The current password is wrong.' })
    const updated = await users.setPassword(row.id, input.password)
    // Other sessions end; this one continues with a fresh cookie.
    setSession(reply, updated)
    return { ok: true }
  })

  app.post('/api/me/logout-everywhere', async (req, reply) => {
    await users.endSessions(req.user!.id)
    collab.disconnect({ userId: req.user!.id })
    if (local) reply.header('set-cookie', sessionCookie(null, local))
    return { ok: true }
  })

  // --- API tokens ---

  app.get('/api/me/tokens', async (req) => tokens.list(req.user!.id))

  app.post('/api/me/tokens', async (req, reply) => {
    const input = createTokenSchema.parse(req.body)
    return reply.code(201).send(await tokens.create(req.user!, input))
  })

  app.delete<{ Params: { id: string } }>('/api/me/tokens/:id', async (req) => {
    if (!(await tokens.revoke(req.user!.id, req.params.id))) throw app.httpErrors.notFound()
    return { ok: true }
  })

  // --- Settings → People (admins) ---

  app.get('/api/admin/people', async (req) => {
    requireAdmin(req)
    return { mode: config.auth.mode, people: await users.people(), invites: local ? await invites.pending() : [] }
  })

  app.post('/api/admin/invites', async (req, reply) => {
    requireLocal()
    const admin = requireAdmin(req)
    const input = createInviteSchema.parse(req.body)
    const existing = await users.byEmail(input.email)
    if (existing?.passwordHash) throw app.httpErrors.conflict('This person already has an account. Use “Reset password” instead.')
    return reply.code(201).send(await invites.create({ ...input, purpose: 'invite', createdBy: admin.id }))
  })

  app.delete<{ Params: { id: string } }>('/api/admin/invites/:id', async (req) => {
    requireAdmin(req)
    if (!(await invites.revoke(req.params.id))) throw app.httpErrors.notFound()
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/admin/people/:id/reset', async (req, reply) => {
    requireLocal()
    const admin = requireAdmin(req)
    const person = await users.row(req.params.id)
    if (!person) throw app.httpErrors.notFound()
    return reply.code(201).send(await invites.create({ email: person.email, purpose: 'reset', createdBy: admin.id }))
  })

  app.patch<{ Params: { id: string } }>('/api/admin/people/:id', async (req) => {
    const admin = requireAdmin(req)
    const patch = updatePersonSchema.parse(req.body)
    // Nobody locks themselves (and possibly everyone) out by accident.
    if (req.params.id === admin.id && (patch.status === 'disabled' || patch.isAdmin === false)) {
      throw app.httpErrors.conflict('You cannot disable yourself or remove your own admin rights.')
    }
    const person = await users.updatePerson(req.params.id, patch)
    if (!person) throw app.httpErrors.notFound()
    if (patch.status === 'disabled') collab.disconnect({ userId: person.id })
    return (await users.people()).find((p) => p.id === person.id)
  })

  app.post<{ Params: { id: string } }>('/api/admin/people/:id/logout', async (req) => {
    requireAdmin(req)
    const person = await users.endSessions(req.params.id)
    if (!person) throw app.httpErrors.notFound()
    collab.disconnect({ userId: person.id })
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/admin/people/:id/revoke-tokens', async (req) => {
    requireAdmin(req)
    return { revoked: await tokens.revokeAll(req.params.id) }
  })
}
