import { eq } from 'drizzle-orm'
import OpenAI from 'openai'
import type { LlmSettings } from '@slidango/shared'
import { type Db, schema } from '../db'

interface StoredSettings {
  baseUrl: string
  model: string
  apiKey: string
  /** Whether the model accepts images (briefing images are sent along). */
  vision: boolean
}

const KEY = 'llm'

/** Endpoint settings: admin overrides in the DB, defaults from the environment. */
export class LlmConfig {
  constructor(
    private db: Db,
    private defaults: StoredSettings,
  ) {}

  async get(): Promise<StoredSettings> {
    const [row] = await this.db.select().from(schema.settings).where(eq(schema.settings.key, KEY))
    return { ...this.defaults, ...((row?.value as Partial<StoredSettings>) ?? {}) }
  }

  async public(): Promise<LlmSettings & { vision: boolean }> {
    const s = await this.get()
    return { baseUrl: s.baseUrl, model: s.model, hasApiKey: Boolean(s.apiKey), vision: s.vision }
  }

  async update(patch: { baseUrl: string; model: string; apiKey?: string; vision?: boolean }) {
    const current = await this.get()
    const value: StoredSettings = {
      baseUrl: patch.baseUrl,
      model: patch.model,
      apiKey: patch.apiKey ? patch.apiKey : current.apiKey,
      vision: patch.vision ?? current.vision,
    }
    await this.db
      .insert(schema.settings)
      .values({ key: KEY, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
  }

  async client(): Promise<{ client: OpenAI; model: string; vision: boolean }> {
    const s = await this.get()
    if (!s.baseUrl || !s.model) throw new LlmNotConfiguredError()
    // Many self-hosted endpoints need no key; the SDK insists on a non-empty one.
    const client = new OpenAI({ baseURL: s.baseUrl, apiKey: s.apiKey || 'none', maxRetries: 1, timeout: 120_000 })
    return { client, model: s.model, vision: s.vision }
  }
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super('No LLM configured (Settings → Slidango AI).')
  }
}
