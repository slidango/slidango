import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import type { User } from '@slidango/shared'

export interface Version {
  sha: string
  message: string
  author: string
  date: string
}

// Briefing uploads (possibly large PDFs) stay out of the deck history.
const GITIGNORE = 'node_modules\n.slidev\ndist\n*.tmp\n.briefing\n'

/** One Git repository per deck; commits only happen on explicit actions. */
export class Versions {
  constructor(
    private deckDir: (id: string) => string,
    /** Called after every new commit (e.g. to refresh the deck's thumbnail). */
    private onCommit: (deckId: string) => void = () => {},
  ) {}

  private async repo(deckId: string): Promise<SimpleGit> {
    const dir = this.deckDir(deckId)
    const git = simpleGit(dir)
    if (!existsSync(join(dir, '.git'))) {
      await git.init(['--initial-branch=main'])
      await git.addConfig('user.name', 'Slidango')
      await git.addConfig('user.email', 'slidango@localhost')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, '.gitignore'), GITIGNORE)
    }
    return git
  }

  /**
   * Commits the current working tree. Returns null when nothing changed, unless
   * allowEmpty (events like a template switch that live outside the files).
   */
  async commit(
    deckId: string,
    message: string,
    user: Pick<User, 'name' | 'email'> | null,
    opts: { allowEmpty?: boolean } = {},
  ): Promise<Version | null> {
    const git = await this.repo(deckId)
    await git.add(['-A'])
    const status = await git.status()
    if (status.isClean() && !opts.allowEmpty) return null
    const author = user ? `${user.name.replace(/[<>]/g, '')} <${user.email}>` : undefined
    await git.commit(message, undefined, {
      ...(author ? { '--author': author } : {}),
      ...(status.isClean() ? { '--allow-empty': null } : {}),
    })
    this.onCommit(deckId)
    return (await this.list(deckId, 1))[0] ?? null
  }

  async list(deckId: string, limit = 100): Promise<Version[]> {
    const git = await this.repo(deckId)
    const head = await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')
    if (!head.trim()) return []
    const log = await git.log({ maxCount: limit })
    return log.all.map((c) => ({ sha: c.hash, message: c.message, author: c.author_name, date: c.date }))
  }

  /** File content at a version; null if the sha is unknown. */
  async show(deckId: string, sha: string, file = 'slides.md'): Promise<string | null> {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return null
    const git = await this.repo(deckId)
    return git.show([`${sha}:${file}`]).catch(() => null)
  }
}
