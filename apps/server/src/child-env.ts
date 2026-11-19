// Slidev and pnpm run deck and theme code; they get no app secrets (DATABASE_URL, API keys).
const PASSTHROUGH = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'npm_config_registry',
]

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { FORCE_COLOR: '0' }
  for (const key of PASSTHROUGH) if (process.env[key] !== undefined) env[key] = process.env[key]
  return { ...env, ...extra }
}
