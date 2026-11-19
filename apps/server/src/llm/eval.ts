// Eval suite with real model calls (not part of `pnpm test`).
// Usage: LLM_BASE_URL=… LLM_MODEL=… [LLM_API_KEY=…] pnpm --filter @slidango/server eval
// Checks the acceptance criteria of "Neues Deck & Erstentwurf" and two chat cases.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Deck, type LlmEvent, type OutlineItem, type Proposal, parseDeck } from '@slidango/shared'
import { buildApp } from '../app'
import { childEnv } from '../child-env'
import { loadConfig } from '../config'
import { openDb } from '../db'
import { availableLayouts, validateSlide } from './validate'

const SLIDES = Number(process.env.EVAL_SLIDES ?? 8)
const headers = { 'x-auth-request-email': 'eval@example.com', 'x-auth-request-preferred-username': 'Eval' }

interface Check {
  name: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` – ${detail}` : ''}`)
}

const config = loadConfig({ ...process.env, DATABASE_URL: 'pglite:memory', DEV_USER_EMAIL: '' })
if (!config.llm.baseUrl || !config.llm.model) {
  console.error('LLM_BASE_URL und LLM_MODEL setzen.')
  process.exit(2)
}
const dataDir = await mkdtemp(join(tmpdir(), 'slidango-eval-'))
const { db, close } = await openDb('pglite:memory')
const server = await buildApp({ ...config, dataDir }, db)
server.app.log.level = 'warn'
await server.app.listen({ port: 0, host: '127.0.0.1' })
const address = server.app.server.address()
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

async function stream(path: string, body: unknown): Promise<LlmEvent[]> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  return text.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)) as LlmEvent)
}
const errorOf = (events: LlmEvent[]) => (events.find((e) => e.type === 'error') as { message: string } | undefined)?.message

try {
  const deck = (await server.app.inject({ method: 'POST', url: '/api/decks', headers, payload: { title: 'Eval: Remote Work', mode: 'assistant' } })).json<Deck>()
  await server.app.inject({
    method: 'PUT',
    url: `/api/decks/${deck.id}/briefing`,
    headers,
    payload: {
      topic: 'Hybride Zusammenarbeit im Team',
      goal: 'Das Team einigt sich auf drei Regeln für Meetings und Erreichbarkeit',
      audience: 'Entwicklungsteam, 12 Personen',
      language: 'Deutsch',
      tone: 'sachlich, freundlich',
      slideCount: SLIDES,
      notes: 'Bezug auf die Umfrage aus dem PDF nehmen.',
    },
  })
  const form = new FormData()
  form.append('file', new Blob([tenPagePdf()], { type: 'application/pdf' }), 'umfrage.pdf')
  const upload = await fetch(`${base}/api/decks/${deck.id}/briefing/files`, { method: 'POST', headers, body: form })
  check('PDF-Briefing (10 Seiten) wird gelesen', upload.status === 201)

  const started = Date.now()
  const outlineEvents = await stream(`/api/decks/${deck.id}/llm/outline`, {})
  const outline = (outlineEvents.find((e) => e.type === 'outline') as { items: OutlineItem[] } | undefined)?.items ?? []
  check('Gliederung', outline.length > 0, errorOf(outlineEvents) ?? `${outline.length} Folien`)

  const draftEvents = await stream(`/api/decks/${deck.id}/llm/draft`, { outline, remarks: '' })
  const seconds = (Date.now() - started) / 1000
  check('Erstentwurf ohne Fehler', !errorOf(draftEvents), errorOf(draftEvents) ?? '')
  check('Dauer unter 2 Minuten', seconds < 120, `${seconds.toFixed(1)} s`)

  const markdown = await server.collab.readContent(deck.id)
  const slides = parseDeck(markdown)
  check(`Folienzahl ${SLIDES} ± 1`, Math.abs(slides.length - SLIDES) <= 1, `${slides.length} Folien`)
  const layouts = await availableLayouts(config.builtinRuntime, null)
  const invalid = slides.flatMap((s) => validateSlide(s.content, layouts).map((e) => `Folie ${s.index}: ${e}`))
  const flagged = slides.filter((s) => s.content.includes('<!-- Hinweis: automatisch geprüft')).map((s) => s.index)
  check('Nur erlaubte Layouts, gültiges Frontmatter', invalid.length === 0 && flagged.length === 0, [...invalid, ...flagged.map((i) => `Folie ${i} mit Warnhinweis`)].join('; '))
  const withoutNotes = slides.filter((s) => !/<!--[\s\S]*?-->\s*$/.test(s.content)).map((s) => s.index)
  check('Sprechernotizen auf jeder Folie', withoutNotes.length === 0, withoutNotes.length ? `fehlen auf ${withoutNotes.join(', ')}` : '')

  await server.runner.prepare(deck.id, null)
  const build = await run(process.execPath, [join(server.decks.dir(deck.id), 'node_modules/@slidev/cli/bin/slidev.mjs'), 'build', 'slides.md', '--out', join(dataDir, 'build')], server.decks.dir(deck.id))
  check('Slidev-Build fehlerfrei (Preview)', build.code === 0, build.code === 0 ? '' : build.log.slice(-5).join(' | '))

  const shorten = await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'Kürze Folie 2 auf höchstens drei Stichpunkte.', cursorSlide: 2 })
  const proposal = (shorten.find((e) => e.type === 'proposal') as { proposal: Proposal } | undefined)?.proposal
  const replaces2 = proposal?.ops.some((op) => op.type === 'replace' && op.index === 2) ?? false
  check('Chat „Folie 2 kürzen“ ergibt Vorschlag für Folie 2', replaces2, errorOf(shorten) ?? JSON.stringify(proposal?.ops.map((o) => o.type)))
  if (proposal) {
    const applied = (await server.app.inject({ method: 'POST', url: `/api/proposals/${proposal.id}/apply`, headers })).json<Proposal>()
    const second = parseDeck(await server.collab.readContent(deck.id))[1]
    const bullets = second?.content.split('\n').filter((l) => /^\s*[-*]\s/.test(l)).length ?? 99
    check('Vorschlag lässt sich anwenden, höchstens drei Stichpunkte', applied.status === 'applied' && bullets <= 3, `${applied.status}, ${bullets} Stichpunkte`)
  }

  const question = await stream(`/api/decks/${deck.id}/llm/chat`, { message: 'Wie viele Folien hat das Deck? Bitte nichts ändern.' })
  check('Frage ohne Änderungswunsch erzeugt keinen Vorschlag', !question.some((e) => e.type === 'proposal') && !errorOf(question), errorOf(question) ?? '')
} finally {
  await server.app.close()
  await close()
  await rm(dataDir, { recursive: true, force: true })
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} Checks bestanden (Modell: ${config.llm.model})`)
process.exit(failed.length ? 1 : 0)

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; log: string[] }> {
  return new Promise((resolve) => {
    const log: string[] = []
    const child = spawn(cmd, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    const onData = (c: Buffer) => log.push(...c.toString().split('\n').filter(Boolean))
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => resolve({ code, log }))
  })
}

/** Ten pages of survey results, generated so the eval needs no fixture files. */
function tenPagePdf(): Uint8Array<ArrayBuffer> {
  const topics = ['Meetings', 'Erreichbarkeit', 'Fokuszeit', 'Tools', 'Onboarding', 'Feedback', 'Buero', 'Homeoffice', 'Kommunikation', 'Fazit']
  // Objects: 1 catalog, 2 page tree, 3 font, then per page its page object and content stream.
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids: string[] = []
  topics.forEach((topic, i) => {
    const page = objects.length + 1
    const text = `BT /F1 14 Tf 72 720 Td (Umfrage Seite ${i + 1}: ${topic}) Tj 0 -24 Td (${60 + i * 3} Prozent wuenschen klarere Regeln zu ${topic}.) Tj ET`
    kids.push(`${page} 0 R`)
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`)
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  })
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${topics.length} >>`
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf) as Uint8Array<ArrayBuffer>
}
