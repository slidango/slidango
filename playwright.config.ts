import { defineConfig } from '@playwright/test'

const appPort = 3100
const proxyPort = 3101
const llmPort = 3102
// Like slides.intern and *.slides.intern: one domain cookie covers the app and all previews.
// (Playwright's Chromium disables storage partitioning, so cross-site preview iframes would
// also lose localStorage there; real browsers partition it instead.)
export const baseURL = `http://slides.localhost:${proxyPort}`
export const dataDir = './e2e/.data'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  // Every test starts Slidev dev servers and Chromium; in parallel they starve small machines.
  workers: 1,
  use: {
    baseURL,
    launchOptions: {
      args: ['--disable-dev-shm-usage'],
      // Optional system Chromium instead of Playwright's download.
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    },
  },
  webServer: [
    {
      command: `rm -rf ${dataDir} && pnpm --filter @slidango/web build && pnpm --filter @slidango/server start`,
      url: `http://127.0.0.1:${appPort}/healthz`,
      timeout: 120_000,
      env: {
        PORT: String(appPort),
        HOST: '127.0.0.1',
        DATABASE_URL: 'pglite:memory',
        DATA_DIR: `../../${dataDir}`,
        WEB_DIST: '../web/dist',
        PREVIEW_URL: `http://{slug}.slides.localhost:${proxyPort}`,
        LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
        LLM_MODEL: 'mock',
        LOG_LEVEL: 'warn',
      },
    },
    { command: `tsx e2e/mock-llm.ts ${llmPort}`, port: llmPort },
    // Stands in for Caddy + oauth2-proxy.
    { command: `tsx e2e/auth-proxy.ts ${proxyPort} ${appPort}`, port: proxyPort },
  ],
})
