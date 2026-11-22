import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { unzipSync } from 'fflate'
import * as tar from 'tar'
import { type Theme, setHeadmatter, themeVersionSchema } from '@slidango/shared'
import { type Db, schema } from './db'
import { childEnv } from './child-env'

export const MAX_THEME_BYTES = 50 * 1024 * 1024
/** Templates installed in the built-in runtime (apps/server/runtime/package.json). */
const BUILTIN_TEMPLATES = ['slidev-theme-slidango']
const MAX_LOG_CHARS = 20_000

export class ThemeError extends Error {}

type ThemeRow = typeof schema.themes.$inferSelect

function toTheme(row: ThemeRow): Theme {
  return {
    id: row.id,
    label: row.label || labelFor(row.name),
    version: row.version,
    name: row.name,
    changelog: row.changelog,
    status: row.status,
    log: row.log,
    isDefault: row.isDefault,
    builtin: row.builtin,
    uploadedAt: row.uploadedAt.toISOString(),
  }
}

interface ThemePackageJson {
  name?: string
  version?: string
  displayName?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  engines?: Record<string, string>
}

/** `slidev-theme-acme-corp` → "Acme Corp"; scopes and the slidev-theme prefix are dropped. */
export function labelFor(name: string): string {
  const base = name.replace(/^@[^/]+\//, '').replace(/^slidev-theme-/, '') || name
  return base
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

/** Directory name for an installed template: the id with anything unusual replaced. */
export function dirName(id: string) {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Uploaded Slidev themes ("templates"). A template is a package name; each uploaded version gets
 * its own row (id `<package>@<version>`) and installed runtime under <data>/themes/<dir>/runtime.
 * Decks pin one installed version.
 */
export class Themes {
  /** Built-in templates: id → package name. They live in the built-in runtime. */
  private builtin = new Map<string, string>()

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

  dir(id: string) {
    return join(this.opts.dataDir, 'themes', dirName(id))
  }

  private get builtinModules() {
    return join(this.opts.builtinRuntimeDir, 'node_modules')
  }

  runtimeModules(id: string) {
    return this.builtin.has(id) ? this.builtinModules : join(this.dir(id), 'runtime', 'node_modules')
  }

  /** Where the template's files (guide.md, starter.md) are. */
  private packageDir(id: string) {
    const name = this.builtin.get(id)
    return name ? join(this.builtinModules, name) : join(this.dir(id), 'package')
  }

  /**
   * Registers the templates shipped in the built-in runtime (the Slidango template). It becomes the
   * default when nothing else is. After an upgrade, decks on an older built-in version move to the new one.
   */
  async ensureBuiltin() {
    for (const name of BUILTIN_TEMPLATES) {
      const pkg = JSON.parse(
        await readFile(join(this.builtinModules, name, 'package.json'), 'utf8').catch(() => '{}'),
      ) as ThemePackageJson
      if (!pkg.version) continue
      const id = `${name}@${pkg.version}`
      this.builtin.set(id, name)
      await this.db.transaction(async (tx) => {
        const old = await tx
          .select()
          .from(schema.themes)
          .where(and(eq(schema.themes.name, name), eq(schema.themes.builtin, true)))
        const outdated = old.filter((r) => r.id !== id)
        await tx
          .insert(schema.themes)
          .values({
            id,
            name,
            label: pkg.displayName?.trim() || labelFor(name),
            version: pkg.version!,
            changelog: 'Shipped with Slidango.',
            status: 'ready',
            builtin: true,
            isDefault: outdated.some((r) => r.isDefault),
          })
          .onConflictDoNothing()
        for (const row of outdated) {
          await tx.update(schema.decks).set({ themeId: id }).where(eq(schema.decks.themeId, row.id))
          await tx.delete(schema.themes).where(eq(schema.themes.id, row.id))
        }
      })
    }
    if (!(await this.defaultTheme())) {
      const first = [...this.builtin.keys()][0]
      if (first) await this.setDefault(first)
    }
  }

  /** Before multiple templates, installs lived in themes/<version>; move them to their id's directory. */
  async migrateDirs() {
    for (const row of await this.db.select().from(schema.themes)) {
      const target = this.dir(row.id)
      const legacy = join(this.opts.dataDir, 'themes', row.version)
      if (!existsSync(target) && legacy !== target && existsSync(legacy)) await rename(legacy, target)
    }
  }

  async list(): Promise<Theme[]> {
    const rows = await this.db.select().from(schema.themes).orderBy(desc(schema.themes.uploadedAt))
    return rows.map(toTheme)
  }

  async get(id: string): Promise<Theme | null> {
    const [row] = await this.db.select().from(schema.themes).where(eq(schema.themes.id, id))
    return row ? toTheme(row) : null
  }

  async defaultTheme(): Promise<Theme | null> {
    const [row] = await this.db
      .select()
      .from(schema.themes)
      .where(and(eq(schema.themes.isDefault, true), eq(schema.themes.status, 'ready')))
    return row ? toTheme(row) : null
  }

  /** The template new decks get unless someone picks another one. One across all templates. */
  async setDefault(id: string): Promise<void> {
    const theme = await this.get(id)
    if (!theme) throw new ThemeError('Template not found')
    if (theme.status !== 'ready') throw new ThemeError('Only installed templates can be the default')
    await this.db.transaction(async (tx) => {
      await tx.update(schema.themes).set({ isDefault: false }).where(eq(schema.themes.isDefault, true))
      await tx.update(schema.themes).set({ isDefault: true }).where(eq(schema.themes.id, id))
    })
  }

  /** Decks (archived ones too) that use an installed template version. */
  async usage(id: string): Promise<{ id: string; title: string; archived: boolean }[]> {
    return this.db
      .select({ id: schema.decks.id, title: schema.decks.title, archived: schema.decks.archived })
      .from(schema.decks)
      .where(eq(schema.decks.themeId, id))
      .orderBy(schema.decks.title)
  }

  /**
   * Deletes an installed template version: its row and its files. Not the built-in template, not the
   * default (pick another one first), and not while decks still use it (move them first).
   */
  async remove(id: string): Promise<void> {
    const theme = await this.get(id)
    if (!theme) throw new ThemeError('Template not found')
    if (theme.builtin) throw new ThemeError('The built-in template cannot be deleted')
    if (theme.isDefault) throw new ThemeError('Make another template the default first')
    if (theme.status === 'installing') throw new ThemeError('Wait until the installation has finished')
    const decks = await this.usage(id)
    if (decks.length) throw new ThemeError(`Still used by ${decks.length} deck${decks.length === 1 ? '' : 's'}`)
    await this.db.delete(schema.themes).where(eq(schema.themes.id, id))
    await rm(this.dir(id), { recursive: true, force: true })
  }

  /** Starter deck of a theme, with the theme set and Slidev's editor off. */
  async starter(id: string, name: string, title: string): Promise<string | null> {
    const content = await readFile(join(this.packageDir(id), 'starter.md'), 'utf8').catch(() => null)
    if (content === null) return null
    return setHeadmatter(content, { theme: name, title, editor: false })
  }

  async guide(id: string): Promise<string | null> {
    return readFile(join(this.packageDir(id), 'guide.md'), 'utf8').catch(() => null)
  }

  /**
   * Validates and unpacks an upload, then installs it in the background.
   * Returns once the package is accepted; status moves to ready or failed.
   */
  async upload(
    input: { version?: string; changelog: string; filename: string; data: Buffer },
    uploadedBy: string,
  ): Promise<{ theme: Theme; installed: Promise<void> }> {
    if (input.data.length > MAX_THEME_BYTES) throw new ThemeError('Package is larger than 50 MB')

    const staging = await mkdtemp(join(tmpdir(), 'theme-upload-'))
    try {
      await extract(input.filename, input.data, staging)
      const root = await packageRoot(staging)
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8').catch(() => '{}')) as ThemePackageJson
      if (!pkg.name || !pkg.version) throw new ThemeError('package.json with name and version is missing')
      if (!existsSync(join(root, 'guide.md'))) throw new ThemeError('guide.md is missing')
      // The version typed at upload wins; without one, the package's own version is used.
      const version = themeVersionSchema.parse(input.version || pkg.version)
      const id = `${pkg.name}@${version}`
      if (await this.get(id)) throw new ThemeError(`${labelFor(pkg.name)} ${version} already exists`)

      const dir = this.dir(id)
      await mkdir(dir, { recursive: true })
      await rm(join(dir, 'package'), { recursive: true, force: true })
      await rename(root, join(dir, 'package')).catch(() => cp(root, join(dir, 'package'), { recursive: true }))

      const [row] = await this.db
        .insert(schema.themes)
        .values({
          id,
          name: pkg.name,
          label: pkg.displayName?.trim().slice(0, 80) || labelFor(pkg.name),
          version,
          changelog: input.changelog,
          status: 'installing',
          uploadedBy,
        })
        .returning()
      const installed = this.install(id, pkg)
      return { theme: toTheme(row!), installed }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  private async install(id: string, pkg: ThemePackageJson): Promise<void> {
    const dir = this.dir(id)
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
            name: `slidev-runtime-${dirName(id).toLowerCase()}`,
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
        (await this.starter(id, pkg.name!, 'Smoke-Test')) ?? setHeadmatter('# Smoke-Test\n', { theme: pkg.name! })
      await writeFile(join(smoke, 'slides.md'), starter)
      await run(
        process.execPath,
        [join(smoke, 'node_modules/@slidev/cli/bin/slidev.mjs'), 'build', 'slides.md', '--out', join(smoke, 'dist')],
        smoke,
      )
      await rm(smoke, { recursive: true, force: true })
      await this.finish(id, 'ready', log)
    } catch (err) {
      log.push(`[slidango] ${(err as Error).message}`)
      await this.finish(id, 'failed', log)
    }
  }

  private async finish(id: string, status: 'ready' | 'failed', log: string[]) {
    const text = log.join('\n')
    await this.db
      .update(schema.themes)
      .set({ status, log: text.length > MAX_LOG_CHARS ? `…\n${text.slice(-MAX_LOG_CHARS)}` : text })
      .where(eq(schema.themes.id, id))
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
