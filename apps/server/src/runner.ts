import { type ChildProcess, spawn } from 'node:child_process'
import { lstat, mkdir, readdir, readlink, rm, symlink, unlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import type { PreviewStatus } from '@slidango/shared'
import { childEnv } from './child-env'

export interface RunnerOptions {
  portRange: [number, number]
  maxInstances: number
  idleMs: number
  startTimeoutMs: number
  /** Directory of a deck. */
  deckDir: (deckId: string) => string
  /** node_modules directory of the Slidev runtime for a theme version (null = builtin). */
  runtimeModules: (themeVersion: string | null) => string
  /** Live collab connections; a deck with connections is never idle. */
  connectionCount: (deckId: string) => number
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void }
}

interface Instance {
  deckId: string
  themeVersion: string | null
  port: number
  /** Loopback address Slidev actually listens on (its `localhost` resolves per system). */
  origin: string
  status: PreviewStatus['status']
  logs: string[]
  process: ChildProcess | null
  ready: Promise<void>
  restarts: number
  lastActive: number
  stopping: boolean
}

const MAX_LOG_LINES = 200

/** Starts one `slidev` dev server per open deck and stops idle ones. */
export class Runner {
  private instances = new Map<string, Instance>()
  private pendingStarts = new Map<string, Promise<Instance>>()
  private sweepTimer: NodeJS.Timeout

  constructor(private opts: RunnerOptions) {
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(60_000, opts.idleMs))
    this.sweepTimer.unref()
  }

  /** Ensures a running instance; resolves once it serves HTTP (or failed). */
  async ensure(deckId: string, themeVersion: string | null): Promise<PreviewStatus> {
    let instance = this.instances.get(deckId)
    if (instance && instance.themeVersion !== themeVersion) {
      await this.stop(deckId)
      instance = undefined
    }
    if (instance?.status === 'error') {
      await this.stop(deckId)
      instance = undefined
    }
    if (!instance) {
      // Concurrent callers (two editors opening the deck) share one start.
      let pending = this.pendingStarts.get(deckId)
      if (!pending) {
        pending = this.start(deckId, themeVersion).finally(() => this.pendingStarts.delete(deckId))
        this.pendingStarts.set(deckId, pending)
      }
      instance = await pending
    }
    instance.lastActive = Date.now()
    await instance.ready.catch(() => {})
    return this.status(deckId)
  }

  status(deckId: string): PreviewStatus {
    const instance = this.instances.get(deckId)
    if (!instance) return { status: 'stopped', logs: [] }
    return { status: instance.status, logs: instance.status === 'error' ? instance.logs : [] }
  }

  /** Origin (e.g. `http://[::1]:4000`) of a ready instance, for the preview proxy. Counts as activity. */
  target(deckId: string): string | null {
    const instance = this.instances.get(deckId)
    if (!instance || instance.status !== 'ready') return null
    instance.lastActive = Date.now()
    return instance.origin
  }

  list() {
    return [...this.instances.values()].map((i) => ({
      deckId: i.deckId,
      themeVersion: i.themeVersion,
      port: i.port,
      status: i.status,
      lastActive: new Date(i.lastActive).toISOString(),
    }))
  }

  async restart(deckId: string, themeVersion: string | null) {
    if (!this.instances.has(deckId)) return
    await this.stop(deckId)
    await this.ensure(deckId, themeVersion)
  }

  async stop(deckId: string) {
    const instance = this.instances.get(deckId)
    if (!instance) return
    instance.stopping = true
    this.instances.delete(deckId)
    await killProcess(instance.process)
  }

  async stopAll() {
    clearInterval(this.sweepTimer)
    await Promise.all([...this.instances.keys()].map((id) => this.stop(id)))
  }

  /** Links the deck to its runtime without starting a preview. */
  prepare(deckId: string, themeVersion: string | null) {
    return linkModules(this.opts.deckDir(deckId), this.opts.runtimeModules(themeVersion))
  }

  private async start(deckId: string, themeVersion: string | null): Promise<Instance> {
    await this.makeRoom()
    await this.prepare(deckId, themeVersion)
    const port = await this.freePort()
    const instance: Instance = {
      deckId,
      themeVersion,
      port,
      origin: '',
      status: 'starting',
      logs: [],
      process: null,
      ready: Promise.resolve(),
      restarts: 0,
      lastActive: Date.now(),
      stopping: false,
    }
    this.instances.set(deckId, instance)
    instance.ready = this.spawn(instance)
    return instance
  }

  private spawn(instance: Instance): Promise<void> {
    const deckDir = this.opts.deckDir(instance.deckId)
    const child = spawn(
      process.execPath,
      [
        join(deckDir, 'node_modules/@slidev/cli/bin/slidev.mjs'),
        'slides.md',
        '--port',
        String(instance.port),
      ],
      {
        cwd: deckDir,
        env: childEnv({ NODE_ENV: 'development' }),
        // Slidev always listens on localhost (its --bind only applies with --remote).
        stdio: ['ignore', 'pipe', 'pipe'],
        // Not detached: if the app dies, its process group (and Slidev) goes with it.
      },
    )
    instance.process = child
    instance.status = 'starting'
    const append = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line.trim()) instance.logs.push(line)
      if (instance.logs.length > MAX_LOG_LINES) instance.logs.splice(0, instance.logs.length - MAX_LOG_LINES)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    this.opts.log.info({ deckId: instance.deckId, port: instance.port }, 'starting slidev')

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.once('exit', (code, signal) => {
      if (instance.stopping || this.instances.get(instance.deckId) !== instance) return
      this.opts.log.warn({ deckId: instance.deckId, code, signal }, 'slidev exited')
      if (instance.restarts < 1) {
        instance.restarts++
        instance.ready = this.spawn(instance)
      } else {
        instance.status = 'error'
      }
    })

    return waitForHttp(instance.port, this.opts.startTimeoutMs, exited).then(
      (origin) => {
        if (instance.process !== child) return
        instance.origin = origin
        instance.status = 'ready'
      },
      (err: Error) => {
        if (instance.process !== child) return
        instance.logs.push(`[slidango] ${err.message}`)
        instance.status = 'error'
        instance.stopping = true
        void killProcess(child)
        throw err
      },
    )
  }

  /** Stops idle instances: no collab connection for longer than idleMs. */
  sweep() {
    const now = Date.now()
    for (const instance of this.instances.values()) {
      if (this.opts.connectionCount(instance.deckId) > 0) instance.lastActive = now
      else if (now - instance.lastActive > this.opts.idleMs) {
        this.opts.log.info({ deckId: instance.deckId }, 'stopping idle slidev')
        void this.stop(instance.deckId)
      }
    }
  }

  private async makeRoom() {
    while (this.instances.size >= this.opts.maxInstances) {
      for (const instance of this.instances.values()) {
        if (this.opts.connectionCount(instance.deckId) > 0) instance.lastActive = Date.now()
      }
      const oldest = [...this.instances.values()].sort((a, b) => a.lastActive - b.lastActive)[0]!
      this.opts.log.info({ deckId: oldest.deckId }, 'instance limit reached, stopping least recently used')
      await this.stop(oldest.deckId)
    }
  }

  private async freePort(): Promise<number> {
    const used = new Set([...this.instances.values()].map((i) => i.port))
    const [from, to] = this.opts.portRange
    for (let port = from; port <= to; port++) {
      if (!used.has(port) && (await isPortFree(port))) return port
    }
    throw new Error('no free preview port')
  }
}

/**
 * Gives the deck its own node_modules directory whose entries link to the
 * runtime's packages. Vite's dependency cache (node_modules/.vite) and Slidev's
 * generated modules (node_modules/.slidev) then live per deck: Vite keys the
 * cache on the project root, so a shared one would be rebuilt by every deck in turn.
 */
export async function linkModules(deckDir: string, runtimeModules: string) {
  const dir = join(deckDir, 'node_modules')
  const stat = await lstat(dir).catch(() => null)
  if (stat?.isSymbolicLink()) await unlink(dir)
  await mkdir(dir, { recursive: true })

  const wanted = new Map<string, string>()
  for (const entry of await readdir(runtimeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      for (const pkg of await readdir(join(runtimeModules, entry.name))) {
        wanted.set(join(entry.name, pkg), join(runtimeModules, entry.name, pkg))
      }
    } else {
      wanted.set(entry.name, join(runtimeModules, entry.name))
    }
  }

  // Drop links into another runtime (template switch), keep caches and dot directories.
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const names = entry.name.startsWith('@') && entry.isDirectory()
      ? (await readdir(join(dir, entry.name))).map((pkg) => join(entry.name, pkg))
      : [entry.name]
    for (const name of names) {
      const target = await readlink(join(dir, name)).catch(() => null)
      if (target !== wanted.get(name)) await rm(join(dir, name), { recursive: true, force: true })
    }
  }
  for (const [name, target] of wanted) {
    const link = join(dir, name)
    if ((await readlink(link).catch(() => null)) === target) continue
    await mkdir(dirname(link), { recursive: true })
    await symlink(target, link, 'dir')
  }
}

async function isPortFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1']) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRNOTAVAIL'))
      server.listen(port, host, () => server.close(() => resolve(true)))
    })
    if (!free) return false
  }
  return true
}

async function waitForHttp(port: number, timeoutMs: number, exited: Promise<void>): Promise<string> {
  let hasExited = false
  void exited.then(() => (hasExited = true))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasExited) throw new Error('slidev exited during startup')
    for (const origin of [`http://127.0.0.1:${port}`, `http://[::1]:${port}`]) {
      const ok = await fetch(`${origin}/`, { signal: AbortSignal.timeout(5000) })
        .then((r) => r.ok)
        .catch(() => false)
      if (ok) {
        await checkRenders(origin)
        return origin
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`slidev did not respond within ${Math.round(timeoutMs / 1000)} s`)
}

/**
 * Slidev answers `/` even when its generated modules fail (e.g. node_modules/.slidev
 * not writable), which renders a blank page. These modules must load too.
 */
const RENDER_CHECKS = ['/@slidev/setups/main', '/@slidev/setups/root', '/@slidev/slides']

async function checkRenders(origin: string) {
  for (const path of RENDER_CHECKS) {
    const res = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) {
      const body = await res.text()
      // Vite answers with an HTML error page that embeds the error as JSON.
      const message = /"message":"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? body.replace(/\s+/g, ' ').slice(0, 500)
      throw new Error(`${path} failed with ${res.status}: ${message}`)
    }
  }
}

async function killProcess(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
}
