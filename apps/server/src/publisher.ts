import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PublicState } from '@slidango/shared'
import { childEnv } from './child-env'
import { linkModules } from './runner'

export interface PublisherOptions {
  enabled: boolean
  dataDir: string
  /** Deck directory (a Git repository). */
  deckDir: (deckId: string) => string
  /** node_modules of the Slidev runtime for a template (null = built-in). */
  runtimeModules: (themeId: string | null) => string
  /** Current slug and template of a deck, null if it is gone, not public or archived. */
  lookup: (deckId: string) => Promise<{ slug: string; themeId: string | null } | null>
  /** Called after a successful build (e.g. to render the public thumbnail). */
  onBuilt?: (deckId: string, slug: string) => void
  buildTimeoutMs?: number
  delayMs?: number
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void }
}

/**
 * Public decks are static Slidev builds of the last saved version (Git HEAD), without speaker
 * notes. Anonymous visitors never reach a deck's Slidev dev server: it accepts writes to
 * slides.md and serves the notes.
 */
export class Publisher {
  private timers = new Map<string, NodeJS.Timeout>()
  private queue: string[] = []
  private running: string | null = null
  private errors = new Map<string, string>()

  constructor(private opts: PublisherOptions) {}

  /** Built site of a deck. */
  siteDir(deckId: string) {
    return join(this.opts.dataDir, 'public', deckId)
  }

  private workDir(deckId: string) {
    return join(this.opts.dataDir, 'builds', deckId)
  }

  async builtAt(deckId: string): Promise<Date | null> {
    try {
      return (await stat(join(this.siteDir(deckId), 'index.html'))).mtime
    } catch {
      return null
    }
  }

  async state(deckId: string, isPublic: boolean, url: string): Promise<PublicState> {
    const builtAt = await this.builtAt(deckId)
    const building = this.running === deckId || this.queue.includes(deckId) || this.timers.has(deckId)
    const error = this.errors.get(deckId) ?? null
    return {
      public: isPublic,
      allowed: this.opts.enabled,
      status: !isPublic ? 'off' : building ? 'building' : error ? 'error' : builtAt ? 'ready' : 'building',
      url: isPublic && builtAt ? url : null,
      builtAt: builtAt?.toISOString() ?? null,
      error: isPublic ? error : null,
    }
  }

  /** Builds the deck's public site soon (after it was made public or a version was saved). */
  schedule(deckId: string) {
    if (!this.opts.enabled) return
    clearTimeout(this.timers.get(deckId))
    const timer = setTimeout(() => {
      this.timers.delete(deckId)
      if (!this.queue.includes(deckId)) this.queue.push(deckId)
      void this.drain()
    }, this.opts.delayMs ?? 500)
    timer.unref()
    this.timers.set(deckId, timer)
  }

  /** Takes the deck offline right away; a running build of it is discarded when it ends. */
  async unpublish(deckId: string) {
    clearTimeout(this.timers.get(deckId))
    this.timers.delete(deckId)
    this.queue = this.queue.filter((id) => id !== deckId)
    this.errors.delete(deckId)
    await rm(this.siteDir(deckId), { recursive: true, force: true })
  }

  async close() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.queue = []
  }

  /** Waits until nothing is queued or building (tests). */
  async idle() {
    while (this.running || this.queue.length || this.timers.size) await new Promise((r) => setTimeout(r, 100))
  }

  private async drain() {
    if (this.running) return
    for (let deckId = this.queue.shift(); deckId; deckId = this.queue.shift()) {
      this.running = deckId
      try {
        await this.build(deckId)
        this.errors.delete(deckId)
      } catch (err) {
        const message = (err as Error).message
        this.errors.set(deckId, message)
        this.opts.log.warn({ deckId, err: message.slice(-2000) }, 'public build failed')
      } finally {
        this.running = null
      }
    }
  }

  private async build(deckId: string) {
    const deck = await this.opts.lookup(deckId)
    if (!deck) return
    const work = this.workDir(deckId)
    const src = join(work, 'src')
    const out = join(work, 'out')
    await mkdir(src, { recursive: true })
    // Fresh copy of the saved version; node_modules (links and Vite's cache) stays.
    for (const entry of await readdir(src)) if (entry !== 'node_modules') await rm(join(src, entry), { recursive: true, force: true })
    await exportHead(this.opts.deckDir(deckId), src)
    await linkModules(src, this.opts.runtimeModules(deck.themeId))
    await rm(out, { recursive: true, force: true })
    await run(
      process.execPath,
      [join(src, 'node_modules/@slidev/cli/bin/slidev.mjs'), 'build', 'slides.md', '--out', out, '--base', `/p/${deck.slug}/`, '--without-notes'],
      src,
      this.opts.buildTimeoutMs ?? 5 * 60_000,
    )
    if (!existsSync(join(out, 'index.html'))) throw new Error('Slidev build produced no index.html')
    // Made private (or archived) while building: throw the result away.
    if (!(await this.opts.lookup(deckId))) return
    const site = this.siteDir(deckId)
    await mkdir(join(this.opts.dataDir, 'public'), { recursive: true })
    const old = `${site}.old`
    await rm(old, { recursive: true, force: true })
    if (existsSync(site)) await rename(site, old)
    await rename(out, site)
    await rm(old, { recursive: true, force: true })
    this.opts.log.info({ deckId }, 'public version built')
    this.opts.onBuilt?.(deckId, deck.slug)
  }
}

/** Writes the files of the last commit (not the working tree) into `target`. */
async function exportHead(repo: string, target: string) {
  await new Promise<void>((resolve, reject) => {
    const git = spawn('git', ['-C', repo, 'archive', '--format=tar', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const tar = spawn('tar', ['-x', '-C', target], { stdio: ['pipe', 'ignore', 'pipe'] })
    let errors = ''
    git.stderr.on('data', (d: Buffer) => (errors += d.toString()))
    tar.stderr.on('data', (d: Buffer) => (errors += d.toString()))
    git.stdout.pipe(tar.stdin)
    let pending = 2
    const done = (code: number | null) => {
      if (code !== 0) return reject(new Error(`exporting the saved version failed: ${errors.trim()}`))
      if (--pending === 0) resolve()
    }
    git.once('exit', done)
    tar.once('exit', done)
  })
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: childEnv({ NODE_ENV: 'production' }), stdio: ['ignore', 'pipe', 'pipe'] })
    const lines: string[] = []
    const keep = (d: Buffer) => {
      lines.push(...d.toString().split('\n').filter((l) => l.trim()))
      if (lines.length > 40) lines.splice(0, lines.length - 40)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`slidev build failed (${signal ?? code}):\n${lines.join('\n')}`))
    })
  })
}
