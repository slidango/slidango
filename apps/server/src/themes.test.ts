import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import * as tar from 'tar'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Deck, Preview, Theme } from '@slidango/shared'
import { buildApp } from './app'
import { loadConfig } from './config'
import type { Db } from './db'
import { openTestDb } from './test-db'

const admin = { 'x-auth-request-email': 'admin@example.com' }
const user = { 'x-auth-request-email': 'user@example.com' }

const themeFiles = (version: string, name = 'slidev-theme-acme'): Record<string, string> => ({
  'package.json': JSON.stringify({ name, version, keywords: ['slidev-theme'] }),
  'layouts/acme-cover.vue': '<template><div class="acme-cover"><slot /></div></template>\n',
  'guide.md': '# ACME\n\n## Layouts\n\n- `acme-cover`: Titelfolie\n',
  'starter.md': '---\ntheme: slidev-theme-acme\n---\n\n---\nlayout: acme-cover\n---\n\n# ACME Starter\n',
})

const zip = (files: Record<string, string>, prefix = '') =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [prefix + k, strToU8(v)]))))

async function tgz(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'theme-src-'))
  const { mkdir } = await import('node:fs/promises')
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, 'package', name, '..'), { recursive: true })
    await writeFile(join(dir, 'package', name), content)
  }
  const out = join(dir, 'theme.tgz')
  await tar.c({ gzip: true, file: out, cwd: dir }, ['package'])
  return readFile(out)
}

describe('templates', () => {
  let dataDir: string
  let db: Db
  let closeDb: () => Promise<void>
  let server: Awaited<ReturnType<typeof buildApp>>
  let base: string

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'slidango-'))
    ;({ db, close: closeDb } = await openTestDb())
    server = await buildApp(
      loadConfig({ DATA_DIR: dataDir, ADMIN_EMAILS: 'admin@example.com', PREVIEW_URL: 'http://{slug}.slides.localhost:3000' }),
      db,
    )
    server.app.log.level = 'warn'
    await server.app.listen({ port: 0, host: '127.0.0.1' })
    const address = server.app.server.address()
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterAll(async () => {
    await server.app.close()
    await closeDb()
    await rm(dataDir, { recursive: true, force: true })
  })

  async function upload(version: string, data: Buffer, filename: string, headers = admin) {
    const form = new FormData()
    if (version) form.append('version', version)
    form.append('changelog', `Version ${version}`)
    form.append('file', new Blob([new Uint8Array(data)]), filename)
    const res = await fetch(`${base}/api/admin/themes`, { method: 'POST', headers, body: form })
    return { status: res.status, body: (await res.json()) as Theme & { error?: string } }
  }

  async function waitInstalled(id: string) {
    for (;;) {
      const theme = (await server.themes.get(id))!
      if (theme.status !== 'installing') return theme
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  it('rejects bad uploads', async () => {
    expect((await upload('1.0.0', zip(themeFiles('1.0.0')), 'theme.zip', user)).status).toBe(403)
    expect((await upload('bad version', zip(themeFiles('1.0.0')), 'theme.zip')).status).toBe(400)
    expect((await upload('1.0.0', Buffer.from('x'), 'theme.rar')).body.error).toBe('Only .zip or .tgz')

    const withoutGuide = themeFiles('1.0.0')
    delete withoutGuide['guide.md']
    expect((await upload('1.0.0', zip(withoutGuide), 'theme.zip')).body.error).toBe('guide.md is missing')

    const traversal = await upload('1.0.0', zip({ ...themeFiles('1.0.0'), '../../evil.txt': 'x' }), 'theme.zip')
    expect(traversal.body.error).toMatch(/Invalid path/)
    // Only the template shipped with Slidango is there.
    expect((await server.themes.list()).filter((t) => !t.builtin)).toEqual([])
  })

  it('ships the Slidango template as the default', async () => {
    const builtin = (await server.themes.list()).find((t) => t.builtin)
    expect(builtin).toMatchObject({ name: 'slidev-theme-slidango', label: 'Slidango', status: 'ready', isDefault: true })
    expect(await server.themes.guide(builtin!.id)).toMatch(/Slidango template/)
    const deck = (
      await server.app.inject({ method: 'POST', url: '/api/decks', headers: user, payload: { title: 'Default', mode: 'starter' } })
    ).json<Deck>()
    expect(deck.themeId).toBe(builtin!.id)
    expect(await readFile(join(dataDir, 'decks', deck.id, 'slides.md'), 'utf8')).toMatch(/theme: slidev-theme-slidango[\s\S]*layout: cover/)
    // Explicitly without a template: Slidev's default theme.
    const plain = (
      await server.app.inject({ method: 'POST', url: '/api/decks', headers: user, payload: { title: 'Plain', themeId: null } })
    ).json<Deck>()
    expect(plain.themeId).toBeNull()
  })

  it('installs a theme, uses it for new decks and switches decks to newer versions', { timeout: 600_000 }, async () => {
    // Without a typed version, the package.json version is used.
    const first = await upload('', zip(themeFiles('1.0.0'), 'acme/'), 'acme.zip')
    expect(first).toMatchObject({
      status: 202,
      body: { id: 'slidev-theme-acme@1.0.0', label: 'Acme', version: '1.0.0', status: 'installing', name: 'slidev-theme-acme' },
    })
    const installed = await waitInstalled('slidev-theme-acme@1.0.0')
    if (installed.status !== 'ready') console.log(installed.log)
    expect(installed.status).toBe('ready')
    expect((await upload('1.0.0', zip(themeFiles('1.0.0')), 'acme.zip')).body.error).toMatch(/Acme 1.0.0 already exists/)

    // A second template may have the same version number.
    const beta = await upload('1.0.0', zip(themeFiles('1.0.0', 'slidev-theme-beta')), 'beta.zip')
    expect(beta.body.id).toBe('slidev-theme-beta@1.0.0')
    expect((await waitInstalled('slidev-theme-beta@1.0.0')).status).toBe('ready')

    await fetch(`${base}/api/admin/themes/${encodeURIComponent('slidev-theme-acme@1.0.0')}/default`, { method: 'PUT', headers: admin })
    const create = async (mode: string) =>
      (
        await server.app.inject({ method: 'POST', url: '/api/decks', headers: user, payload: { title: `Acme ${mode}`, mode } })
      ).json<Deck>()

    const starter = await create('starter')
    expect(starter.themeId).toBe('slidev-theme-acme@1.0.0')
    const starterSlides = await readFile(join(dataDir, 'decks', starter.id, 'slides.md'), 'utf8')
    expect(starterSlides).toContain('layout: acme-cover')
    expect(starterSlides).toMatch(/^---\ntheme: slidev-theme-acme\ntitle: "?Acme starter"?\neditor: false\n---/)

    const empty = await create('empty')
    expect(await readFile(join(dataDir, 'decks', empty.id, 'slides.md'), 'utf8')).toContain('theme: slidev-theme-acme')

    // Picking another template when creating.
    const picked = (
      await server.app.inject({
        method: 'POST',
        url: '/api/decks',
        headers: user,
        payload: { title: 'Beta deck', themeId: 'slidev-theme-beta@1.0.0' },
      })
    ).json<Deck>()
    expect(picked.themeId).toBe('slidev-theme-beta@1.0.0')
    expect(await readFile(join(dataDir, 'decks', picked.id, 'slides.md'), 'utf8')).toContain('theme: slidev-theme-beta')

    const preview = (
      await server.app.inject({ method: 'POST', url: `/api/decks/${starter.id}/preview`, headers: user })
    ).json<Preview>()
    expect(preview.status).toBe('ready')

    const second = await upload('1.1.0', await tgz(themeFiles('1.1.0')), 'acme-1.1.0.tgz')
    expect(second.status).toBe(202)
    expect((await waitInstalled('slidev-theme-acme@1.1.0')).status).toBe('ready')

    // Switch to a newer version of the same template …
    const switched = await server.app.inject({
      method: 'POST',
      url: `/api/decks/${starter.id}/theme`,
      headers: user,
      payload: { themeId: 'slidev-theme-acme@1.1.0' },
    })
    expect(switched.json()).toMatchObject({ themeId: 'slidev-theme-acme@1.1.0' })
    expect(server.runner.list().find((i) => i.deckId === starter.id)?.themeId).toBe('slidev-theme-acme@1.1.0')
    expect((await server.versions.list(starter.id))[0]!.message).toBe('Template: Acme 1.1.0')

    // … or to another template: the headmatter follows.
    await server.app.inject({
      method: 'POST',
      url: `/api/decks/${starter.id}/theme`,
      headers: user,
      payload: { themeId: 'slidev-theme-beta@1.0.0' },
    })
    await server.collab.flushDeck(starter.id)
    expect(await readFile(join(dataDir, 'decks', starter.id, 'slides.md'), 'utf8')).toMatch(/^---\ntheme: slidev-theme-beta/)
    // Only managers switch templates.
    const other = await server.app.inject({
      method: 'POST',
      url: `/api/decks/${starter.id}/theme`,
      headers: { 'x-auth-request-email': 'someone@example.com' },
      payload: { themeId: 'slidev-theme-acme@1.0.0' },
    })
    expect(other.statusCode).toBe(403)

    // Deleting versions: never the built-in one or the default, and decks in use move first.
    const del = (id: string, moveTo?: string) =>
      server.app.inject({
        method: 'DELETE',
        url: `/api/admin/themes/${encodeURIComponent(id)}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ''}`,
        headers: admin,
      })
    const builtinId = (await server.themes.list()).find((t) => t.builtin)!.id
    expect((await del(builtinId)).json().error).toMatch(/built-in/)
    expect((await del('slidev-theme-acme@1.0.0')).json().error).toMatch(/default first/)
    expect((await server.app.inject({ method: 'DELETE', url: '/api/admin/themes/x', headers: user })).statusCode).toBe(403)

    const usedBy = (
      await server.app.inject({ url: `/api/admin/themes/${encodeURIComponent('slidev-theme-beta@1.0.0')}/decks`, headers: admin })
    ).json<{ id: string }[]>()
    expect(usedBy.map((d) => d.id).sort()).toEqual([starter.id, picked.id].sort())
    const refused = await del('slidev-theme-beta@1.0.0')
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/Still used by 2 decks/)

    const deleted = await del('slidev-theme-beta@1.0.0', 'slidev-theme-acme@1.1.0')
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json<Theme[]>().map((t) => t.id)).not.toContain('slidev-theme-beta@1.0.0')
    for (const id of [starter.id, picked.id]) {
      expect((await server.app.inject({ url: `/api/decks/${id}`, headers: user })).json()).toMatchObject({ themeId: 'slidev-theme-acme@1.1.0' })
      await server.collab.flushDeck(id)
      expect(await readFile(join(dataDir, 'decks', id, 'slides.md'), 'utf8')).toMatch(/^---\n(?:.*\n)*?theme: slidev-theme-acme\n/)
    }
    expect(existsSync(server.themes.dir('slidev-theme-beta@1.0.0'))).toBe(false)
  })
})
