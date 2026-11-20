import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function previewUrl(env: NodeJS.ProcessEnv, port: number) {
  if (env.PREVIEW_URL) return env.PREVIEW_URL
  if (env.PREVIEW_DOMAIN && env.PUBLIC_URL) {
    const publicUrl = new URL(env.PUBLIC_URL)
    return `${publicUrl.protocol}//{slug}.${env.PREVIEW_DOMAIN}${publicUrl.port ? `:${publicUrl.port}` : ''}`
  }
  // Browsers resolve *.localhost to the loopback address. slides.localhost mirrors the
  // production layout (slides.intern, *.slides.intern); the app also works on plain localhost.
  return `http://{slug}.slides.localhost:${port}`
}

/**
 * `oidc`: identity comes from oauth2-proxy headers (Caddy forward_auth).
 * `local`: one account per person (invite link + password), checked by the app; identity comes from a signed cookie.
 */
export type AuthConfig =
  | {
      mode: 'oidc'
      /** Only these email domains may sign in; empty: anyone the IdP lets through. */
      allowedDomains: string[]
    }
  | {
      mode: 'local'
      /** Signs the session cookie. */
      secret: string
      /** Cookie domain shared by the app and all preview hosts, e.g. `slides.intern`. */
      cookieDomain: string | null
      secure: boolean
      sessionDays: number
    }

function authConfig(env: NodeJS.ProcessEnv, publicUrl: string, previewUrlTemplate: string, warnings: string[]): AuthConfig {
  const raw = (env.AUTH_MODE ?? 'oidc').trim().toLowerCase()
  if (raw === 'oidc') {
    const allowedDomains = (env.ALLOWED_EMAIL_DOMAINS ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean)
    return { mode: 'oidc', allowedDomains }
  }
  if (raw !== 'local' && raw !== 'password') throw new Error(`AUTH_MODE must be "oidc" or "local", got "${env.AUTH_MODE}"`)
  if (raw === 'password') {
    warnings.push('AUTH_MODE=password is deprecated: it now means AUTH_MODE=local (one account per person, invited by an admin).')
  }
  if (env.AUTH_PASSWORD || env.AUTH_ADMIN_PASSWORD) {
    warnings.push('AUTH_PASSWORD and AUTH_ADMIN_PASSWORD are ignored: people sign in with their own accounts now.')
  }
  const secret = env.AUTH_SECRET ?? ''
  if (secret.length < 32) throw new Error('AUTH_MODE=local needs AUTH_SECRET (at least 32 characters)')
  // `https://{slug}.slides.intern` -> `slides.intern`: the cookie must reach every preview host.
  const previewHost = /^[a-z]+:\/\/\{slug\}\.([^/:]+)/i.exec(previewUrlTemplate)?.[1] ?? null
  return {
    mode: 'local',
    secret,
    cookieDomain: env.AUTH_COOKIE_DOMAIN?.trim() || previewHost,
    secure: publicUrl.startsWith('https:'),
    sessionDays: Number(env.AUTH_SESSION_DAYS ?? 30),
  }
}

export interface Config {
  port: number
  host: string
  publicUrl: string
  databaseUrl: string
  dataDir: string
  /** Promoted to admin when they sign in (never demoted); in `local` mode they also get a setup link on start. */
  adminEmails: string[]
  /** Configuration problems worth logging at start (deprecated variables etc.). */
  warnings: string[]
  auth: AuthConfig
  /** Fallback user when no proxy headers are present. Only for local development. */
  devUser: { email: string; name: string } | null
  /** Built frontend to serve; null in development (Vite serves it). */
  webDist: string | null
  diskSyncDebounceMs: number
  storeDebounceMs: number
  /** Preview URL template, e.g. `https://{slug}.slides.intern`. */
  previewUrl: string
  /** node_modules of the Slidev runtime used by decks without an uploaded template. */
  builtinRuntime: string
  /** Defaults for the LLM endpoint; admins can override them in the UI. */
  llm: { baseUrl: string; model: string; apiKey: string; vision: boolean }
  /** pnpm binary for installing uploaded templates. */
  pnpm: string
  runner: { maxInstances: number; idleMs: number; portRange: [number, number]; startTimeoutMs: number }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const devEmail = env.DEV_USER_EMAIL?.trim()
  if (devEmail && env.NODE_ENV === 'production') {
    throw new Error('DEV_USER_EMAIL must not be set in production')
  }
  const port = Number(env.PORT ?? 3000)
  const publicUrl = env.PUBLIC_URL ?? 'http://localhost:5173'
  const preview = previewUrl(env, port)
  const warnings: string[] = []
  return {
    warnings,
    port,
    host: env.HOST ?? '0.0.0.0',
    publicUrl,
    auth: authConfig(env, publicUrl, preview, warnings),
    databaseUrl: env.DATABASE_URL ?? 'pglite:./data/pglite',
    dataDir: resolve(env.DATA_DIR ?? './data'),
    adminEmails: (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    devUser: devEmail ? { email: devEmail, name: env.DEV_USER_NAME ?? devEmail } : null,
    webDist: env.WEB_DIST ? resolve(env.WEB_DIST) : null,
    diskSyncDebounceMs: 400,
    storeDebounceMs: 2000,
    previewUrl: preview,
    builtinRuntime: resolve(
      env.SLIDEV_RUNTIME ?? resolve(dirname(fileURLToPath(import.meta.url)), '../runtime'),
      'node_modules',
    ),
    pnpm: env.PNPM_BIN ?? 'pnpm',
    llm: {
      baseUrl: env.LLM_BASE_URL ?? '',
      model: env.LLM_MODEL ?? '',
      apiKey: env.LLM_API_KEY ?? '',
      vision: env.LLM_VISION === 'true',
    },
    runner: {
      maxInstances: Number(env.RUNNER_MAX_INSTANCES ?? 15),
      idleMs: Number(env.RUNNER_IDLE_MINUTES ?? 10) * 60_000,
      portRange: [4000, 4999],
      startTimeoutMs: 60_000,
    },
  }
}
