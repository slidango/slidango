import { parseSync } from '@slidev/parser/core'

/** One slide; `index` is 1-based like Slidev's slide numbers. */
export interface DeckSlide {
  index: number
  /** 0-based first and last line of the segment in the file. */
  startLine: number
  endLine: number
  /** Lines of the file belonging to this slide, including its leading `---` separator. */
  segment: string
  /** The slide as an author writes it: optional frontmatter block plus body, without separator. */
  content: string
  hash: string
  title?: string
  layout?: string
  hidden: boolean
}

export type SlideOp =
  | { type: 'replace'; index: number; content: string }
  | { type: 'insert'; after: number; contents: string[] }
  | { type: 'delete'; indexes: number[] }
  | { type: 'move'; from: number; to: number }

export interface UndoInfo {
  /** Segments of the deck before the proposal was applied. */
  before: string[]
  /** Slides after applying: where each came from, and whether the proposal touched it. */
  result: { orig: number | null; affected: boolean; hash: string }[]
}

/** Fast, stable content hash (cyrb53); only used to detect concurrent edits. */
export function hashSlide(content: string): string {
  const text = content.replace(/\r\n/g, '\n').trim()
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')

/**
 * Splits a deck into slides with Slidev's own parser. Joining the segments
 * gives back the exact input, so unchanged slides keep their formatting.
 */
export function parseDeck(markdown: string): DeckSlide[] {
  const eol = eolOf(markdown)
  const lines = markdown.split(/\r?\n/)
  let parsed: ReturnType<typeof parseSync>['slides'] = []
  try {
    parsed = parseSync(lines.join('\n'), 'slides.md').slides
  } catch {
    parsed = []
  }
  if (parsed.length === 0) {
    return [
      { index: 1, startLine: 0, endLine: Math.max(0, lines.length - 1), segment: markdown, content: markdown.trim(), hash: hashSlide(markdown), hidden: false },
    ]
  }

  // A slide with its own frontmatter starts at its `---` line; otherwise the separator is the line before.
  const starts = parsed.map((slide, i) => {
    if (i === 0) return 0
    return slide.frontmatterRaw !== undefined && lines[slide.start] === '---' ? slide.start : slide.start - 1
  })

  return parsed.map((slide, i) => {
    const end = i + 1 < parsed.length ? starts[i + 1]! : lines.length
    const segmentLines = lines.slice(starts[i], end)
    const hasOwnFrontmatter = i > 0 && starts[i] === slide.start
    const contentLines = i === 0 || hasOwnFrontmatter ? segmentLines : segmentLines.slice(1)
    const content = contentLines.join('\n').trim()
    const frontmatter = (slide.frontmatter ?? {}) as Record<string, unknown>
    return {
      index: i + 1,
      startLine: starts[i]!,
      endLine: Math.max(starts[i]!, end - 1),
      segment: segmentLines.join(eol),
      content,
      hash: hashSlide(content),
      title: plainTitle(slide.title ?? /^#{1,6}\s+(.+)$/m.exec(slide.content)?.[1]),
      layout: typeof frontmatter.layout === 'string' ? frontmatter.layout : undefined,
      hidden: Boolean(frontmatter.hide || frontmatter.disabled),
    }
  })
}

export function joinSegments(segments: string[]): string {
  return segments.join(eolOf(segments.join('')))
}

/** True when the deck has nothing but headmatter. */
export function isDeckEmpty(markdown: string): boolean {
  const slides = parseDeck(markdown)
  if (slides.length > 1) return false
  return slides[0]!.content.replace(/^---\n[\s\S]*?\n---(\n|$)/, '').trim() === ''
}

const FRONTMATTER = /^---\n(?:[\w-]+\s*:.*\n|\s+.*\n|#.*\n|\s*\n)*?---\s*(?:\n|$)/

/** Turns author content into a file segment at a given position. */
function toSegment(content: string, first: boolean, eol: string): string {
  const body = content.replace(/\r\n/g, '\n').trim()
  const segment = first || FRONTMATTER.test(body) ? body : `---\n\n${body}`
  return `${segment}\n`.replace(/\n/g, eol)
}

export function referencedIndexes(ops: SlideOp[]): number[] {
  const indexes = new Set<number>()
  for (const op of ops) {
    if (op.type === 'replace') indexes.add(op.index)
    else if (op.type === 'insert') indexes.add(op.after)
    else if (op.type === 'delete') op.indexes.forEach((i) => indexes.add(i))
    else indexes.add(op.from)
  }
  return [...indexes].sort((a, b) => a - b)
}

export class InvalidOpError extends Error {}

function validate(ops: SlideOp[]) {
  for (const op of ops) {
    const touchesFirst =
      (op.type === 'delete' && op.indexes.includes(1)) ||
      (op.type === 'move' && (op.from === 1 || op.to <= 1)) ||
      (op.type === 'insert' && op.after < 1)
    if (touchesFirst) {
      throw new InvalidOpError('Slide 1 holds the deck settings: it can be replaced, but not deleted or moved, and nothing can go before it.')
    }
  }
}

/**
 * Applies operations that all refer to the deck's numbering when they were
 * proposed. `baseHashes` are the slide hashes at that time; if a referenced
 * slide changed since, the proposal is stale.
 */
export function applyOps(
  markdown: string,
  ops: SlideOp[],
  baseHashes: Record<number, string>,
): { ok: true; text: string; undo: UndoInfo } | { ok: false; stale: number[] } {
  validate(ops)
  const slides = parseDeck(markdown)
  const stale = referencedIndexes(ops).filter((i) => {
    const slide = slides[i - 1]
    return !slide || (baseHashes[i] !== undefined && baseHashes[i] !== slide.hash)
  })
  if (stale.length) return { ok: false, stale }

  interface Item {
    orig: number | null
    content: string
    segment: string | null
    affected: boolean
  }
  const items: Item[] = slides.map((s) => ({ orig: s.index, content: s.content, segment: s.segment, affected: false }))
  const deleted = new Set<number>()
  const inserts = new Map<number, string[]>()
  for (const op of ops) {
    if (op.type === 'replace') Object.assign(items[op.index - 1]!, { content: op.content, segment: null, affected: true })
    else if (op.type === 'insert') inserts.set(op.after, [...(inserts.get(op.after) ?? []), ...op.contents])
    else if (op.type === 'delete') op.indexes.forEach((i) => deleted.add(i))
  }

  let result: Item[] = []
  for (const item of items) {
    if (!deleted.has(item.orig!)) result.push(item)
    for (const content of inserts.get(item.orig!) ?? []) result.push({ orig: null, content, segment: null, affected: true })
  }
  for (const op of ops) {
    if (op.type !== 'move') continue
    const position = result.findIndex((item) => item.orig === op.from)
    if (position === -1) continue
    const [moved] = result.splice(position, 1)
    const target = Math.min(Math.max(op.to - 1, 1), result.length)
    result = [...result.slice(0, target), { ...moved!, affected: true }, ...result.slice(target)]
  }

  const eol = eolOf(markdown)
  const segments = result.map((item, position) =>
    item.segment !== null && (position > 0) === (item.orig !== 1) ? item.segment : toSegment(item.content, position === 0, eol),
  )
  return {
    ok: true,
    text: joinSegments(segments),
    undo: {
      before: slides.map((s) => s.segment),
      result: result.map((item) => ({ orig: item.orig, affected: item.affected, hash: hashSlide(item.content) })),
    },
  }
}

/**
 * Restores the slides a proposal changed, as long as those slides are still as
 * the proposal left them. Later edits to other slides are kept.
 */
export function undoOps(markdown: string, undo: UndoInfo): { ok: true; text: string } | { ok: false } {
  const current = parseDeck(markdown)
  if (current.length !== undo.result.length) return { ok: false }
  if (undo.result.some((r, i) => r.affected && current[i]!.hash !== r.hash)) return { ok: false }
  const restored = [...undo.before]
  undo.result.forEach((r, i) => {
    if (!r.affected && r.orig !== null && current[i]!.hash !== r.hash) restored[r.orig - 1] = current[i]!.segment
  })
  return { ok: true, text: joinSegments(restored) }
}

/** A heading as plain text: `Where we *are*` → `Where we are` (emphasis, code and link markup removed). */
export function plainTitle(title: string | undefined): string | undefined {
  if (!title) return undefined
  const plain = title
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|\*|~~|`)(\S(?:.*?\S)?)\1/g, '$2')
    // Underscores only count as emphasis at word boundaries (snake_case stays).
    .replace(/(^|[^\w])(__|_)(\S(?:.*?\S)?)\2(?![\w])/g, '$1$3')
    .replace(/<[^>]+>/g, '')
    .trim()
  return plain || undefined
}
