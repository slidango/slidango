import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { unzipSync } from 'fflate'
import * as tar from 'tar'
import { type Theme, setHeadmatter } from '@slidango/shared'
import { type Db, schema } from './db'
import { childEnv } from './child-env'

export const MAX_THEME_BYTES = 50 * 1024 * 1024
const MAX_LOG_CHARS = 20_000

export class ThemeError extends Error {}

type ThemeRow = typeof schema.themes.$inferSelect

function toTheme(row: ThemeRow): Theme {
  return {
    version: row.version,
    name: row.name,
    changelog: row.changelog,
    status: row.status,
    log: row.log,
    isDefault: row.isDefault,
    uploadedAt: row.uploadedAt.toISOString(),
  }
}

interface ThemePackageJson {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  engines?: Record<string, string>
}

/**
 * Uploaded Slidev themes. Each version gets its own installed runtime under
 * <data>/themes/<version>/runtime; decks pin a version.
 */
export class Themes {
  constructor(
    private db: Db,
    private opts: {
      dataDir: string
      /** package.json of the builtin runtime: the Slidev version to fall back to. */
      builtinRuntimeDir: string
      pnpm: string
      installTimeoutMs: number
    },
  ) {}

  dir(version: string) {
    return join(this.opts.dataDir, 'themes', version)
  }

  runtimeModules(version: string) {
    return join(this.dir(version), 'runtime', 'node_modules')
  }

  async list(): Promise<Theme[]> {
    const rows = await this.db.select().from(schema.themes).orderBy(desc(schema.themes.uploadedAt))
    return rows.map(toTheme)
  }

  async get(version: string): Promise<Theme | null> {
    const [row] = await this.db.select().from(schema.themes).where(eq(schema.themes.version, version))
    return row ? toTheme(row) : null
  }

  async defaultTheme(): Promise<Theme | null> {
    const [row] = await this.db
      .select()
      .from(schema.themes)
      .where(and(eq(schema.themes.isDefault, true), eq(schema.themes.status, 'ready')))
    return row ? toTheme(row) : null
  }

  async setDefault(version: string): Promise<void> {
    const theme = await this.get(version)
    if (!theme) throw new ThemeError('Version not found')
    if (theme.status !== 'ready') throw new ThemeError('Only installed versions can be the default')
    await this.db.transaction(async (tx) => {
      await tx.update(schema.themes).set({ isDefault: false }).where(eq(schema.themes.isDefault, true))
      await tx.update(schema.themes).set({ isDefault: true }).where(eq(schema.themes.version, version))
    })
  }

  /** Starter deck of a theme, with the theme set and Slidev's editor off. */
  async starter(version: string, name: string, title: string): Promise<string | null> {
    const content = await readFile(join(this.dir(version), 'package', 'starter.md'), 'utf8').catch(() => null)
    if (content === null) return null
    return setHeadmatter(content, { theme: name, title, editor: false })
  }

  async guide(version: string): Promise<string | null> {
    return readFile(join(this.dir(version), 'package', 'guide.md'), 'utf8').catch(() => null)
  }

  /**
   * Validates and unpacks an upload, then installs it in the background.
   * Returns once the package is accepted; status moves to ready or failed.
   */
  async upload(
    input: { version: string; changelog: string; filename: string; data: Buffer },
    uploadedBy: string,
  ): Promise<{ theme: Theme; installed: Promise<void> }> {
    if (input.data.length > MAX_THEME_BYTES) throw new ThemeError('Package is larger than 50 MB')
    if (await this.get(input.version)) throw new ThemeError(`Version ${input.version} already exists`)

    const staging = await mkdtemp(join(tmpdir(), 'theme-upload-'))
    try {
      await extract(input.filename, input.data, staging)
      const root = await packageRoot(staging)
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8').catch(() => '{}')) as ThemePackageJson
      if (!pkg.name || !pkg.version) throw new ThemeError('package.json with name and version is missing')
      if (!existsSync(join(root, 'guide.md'))) throw new ThemeError('guide.md is missing')

      const dir = this.dir(input.version)
      await mkdir(dir, { recursive: true })
      await rm(join(dir, 'package'), { recursive: true, force: true })
      await rename(root, join(dir, 'package')).catch(() => cp(root, join(dir, 'package'), { recursive: true }))

      const [row] = await this.db
        .insert(schema.themes)
        .values({ version: input.version, name: pkg.name, changelog: input.changelog, status: 'installing', uploadedBy })
        .returning()
      const installed = this.install(input.version, pkg)
      return { theme: toTheme(row!), installed }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  private async install(version: string, pkg: ThemePackageJson): Promise<void> {
    const dir = this.dir(version)
    const log: string[] = []
    const run = async (cmd: string, args: string[], cwd: string) => {
      log.push(`$ ${[cmd, ...args].join(' ')}`)
      await runCommand(cmd, args, cwd, this.opts.installTimeoutMs, (line) => log.push(line))
    }
    try {
      const builtin = JSON.parse(await readFile(join(this.opts.builtinRuntimeDir, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
        pnpm?: unknown
      }
      const slidevVersion =
        pkg.dependencies?.['@slidev/cli'] ?? pkg.peerDependencies?.['@slidev/cli'] ?? builtin.dependencies['@slidev/cli']!
      const runtimeDir = join(dir, 'runtime')
      await rm(runtimeDir, { recursive: true, force: true })
      await mkdir(runtimeDir, { recursive: true })
      await writeFile(
        join(runtimeDir, 'package.json'),
        JSON.stringify(
          {
            name: `slidev-runtime-${version}`,
            private: true,
            dependencies: {
              [pkg.name!]: 'file:../package',
              '@slidev/cli': slidevVersion,
            },
            pnpm: builtin.pnpm,
          },
          null,
          2,
        ),
      )
      await run(this.opts.pnpm, ['install', '--ignore-workspace', '--prod', '--ignore-scripts'], runtimeDir)

      // Smoke test: the starter deck must build with this runtime.
      const smoke = join(dir, 'smoke')
      await rm(smoke, { recursive: true, force: true })
      await mkdir(smoke)
      await symlink(join(runtimeDir, 'node_modules'), join(smoke, 'node_modules'), 'dir')
      const starter =
        (await this.starter(version, pkg.name!, 'Smoke-Test')) ?? setHeadmatter('# Smoke-Test\n', { theme: pkg.name! })
      await writeFile(join(smoke, 'slides.md'), starter)
      await run(
        process.execPath,
        [join(smoke, 'node_modules/@slidev/cli/bin/slidev.mjs'), 'build', 'slides.md', '--out', join(smoke, 'dist')],
        smoke,
      )
      await rm(smoke, { recursive: true, force: true })
      await this.finish(version, 'ready', log)
    } catch (err) {
      log.push(`[slidango] ${(err as Error).message}`)
      await this.finish(version, 'failed', log)
    }
  }

  private async finish(version: string, status: 'ready' | 'failed', log: string[]) {
    const text = log.join('\n')
    await this.db
      .update(schema.themes)
      .set({ status, log: text.length > MAX_LOG_CHARS ? `…\n${text.slice(-MAX_LOG_CHARS)}` : text })
      .where(eq(schema.themes.version, version))
  }
}

async function extract(filename: string, data: Buffer, target: string) {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.zip')) {
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(new Uint8Array(data))
    } catch {
      throw new ThemeError('ZIP file is corrupt')
    }
    let total = 0
    for (const [name, content] of Object.entries(entries)) {
      total += content.length
      if (total > MAX_THEME_BYTES * 4) throw new ThemeError('Unpacked package is too large')
      const path = safeJoin(target, name)
      if (name.endsWith('/')) {
        await mkdir(path, { recursive: true })
        continue
      }
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }
  } else if (lower.endsWith('.tgz') || lower.endsWith('.tar.gz')) {
    const archive = join(target, '.upload.tgz')
    await writeFile(archive, data)
    try {
      // tar strips absolute paths and `..` segments by default.
      await tar.x({ file: archive, cwd: target, filter: (_path, entry) => !('type' in entry) || ['File', 'Directory'].includes(entry.type) })
    } catch {
      throw new ThemeError('TGZ file is corrupt')
    } finally {
      await rm(archive, { force: true })
    }
  } else {
    throw new ThemeError('Only .zip or .tgz')
  }
}

function safeJoin(root: string, name: string) {
  const path = resolve(root, normalize(name))
  if (path !== root && !path.startsWith(root + sep)) throw new ThemeError(`Invalid path in archive: ${name}`)
  return path
}

/** The directory holding package.json: the archive root or its only top-level folder (npm pack uses `package/`). */
async function packageRoot(dir: string): Promise<string> {
  if (existsSync(join(dir, 'package.json'))) return dir
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX')
  if (entries.length === 1 && entries[0]!.isDirectory()) return join(dir, entries[0]!.name)
  return dir
}

function runCommand(cmd: string, args: string[], cwd: string, timeoutMs: number, onLine: (line: string) => void) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env: childEnv({ CI: '1' }), stdio: ['ignore', 'pipe', 'pipe'] })
    const onData = (chunk: Buffer) => chunk.toString().split('\n').filter((l) => l.trim()).forEach(onLine)
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`${cmd} ${args[0]} failed (${signal ?? `exit ${code}`})`))
    })
  })
}
