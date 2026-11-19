import { describe, expect, it } from 'vitest'
import { applyOps, hashSlide, isDeckEmpty, joinSegments, parseDeck, undoOps } from './deck'

const deck = [
  '---',
  'title: Test',
  'theme: default',
  '---',
  '',
  '# Eins',
  '',
  '---',
  'layout: center',
  '---',
  '',
  '# Zwei',
  '',
  '<!-- Notiz zu zwei -->',
  '',
  '---',
  '',
  '# Drei',
  '',
  '```yaml',
  '---',
  'a: 1',
  '---',
  '```',
  '',
  '---',
  '',
  '',
  '---',
  '',
  '# Fünf',
  '',
].join('\n')

describe('parseDeck', () => {
  it('splits like Slidev and round-trips losslessly', () => {
    const slides = parseDeck(deck)
    expect(slides.map((s) => s.index)).toEqual([1, 2, 3, 4, 5])
    expect(slides.map((s) => [s.startLine, s.endLine])).toEqual([[0, 6], [7, 14], [15, 24], [25, 27], [28, 31]])
    expect(joinSegments(slides.map((s) => s.segment))).toBe(deck)
  })

  it('exposes content without separators, keeping frontmatter blocks', () => {
    const [one, two, three, four, five] = parseDeck(deck)
    expect(one!.content).toBe('---\ntitle: Test\ntheme: default\n---\n\n# Eins')
    expect(two!.content).toBe('---\nlayout: center\n---\n\n# Zwei\n\n<!-- Notiz zu zwei -->')
    expect(two!.layout).toBe('center')
    expect(two!.title).toBe('Zwei')
    expect(three!.content).toBe('# Drei\n\n```yaml\n---\na: 1\n---\n```')
    expect(four!.content).toBe('')
    expect(five!.content).toBe('# Fünf')
  })

  it('handles decks without headmatter, empty input and CRLF', () => {
    expect(parseDeck('# A\n\n---\n\n# B\n').map((s) => s.content)).toEqual(['# A', '# B'])
    expect(parseDeck('')).toHaveLength(1)
    const crlf = '---\r\ntitle: X\r\n---\r\n\r\n# A\r\n\r\n---\r\n\r\n# B\r\n'
    expect(joinSegments(parseDeck(crlf).map((s) => s.segment))).toBe(crlf)
  })

  it('hashes content, not position', () => {
    const slides = parseDeck('# A\n\n---\n\n# A\n')
    expect(slides[0]!.hash).toBe(slides[1]!.hash)
    expect(hashSlide('# A')).toBe(slides[0]!.hash)
  })
})

describe('isDeckEmpty', () => {
  it('is true for headmatter only', () => {
    expect(isDeckEmpty('---\ntitle: X\neditor: false\n---\n')).toBe(true)
    expect(isDeckEmpty('')).toBe(true)
    expect(isDeckEmpty('---\ntitle: X\n---\n\n# A\n')).toBe(false)
  })
})

describe('applyOps', () => {
  const base = '---\ntitle: T\n---\n\n# Eins\n\n---\n\n# Zwei\n\n---\n\n# Drei\n'
  const hashes = (md: string) => Object.fromEntries(parseDeck(md).map((s) => [s.index, s.hash]))
  const contents = (md: string) => parseDeck(md).map((s) => s.content)

  it('replaces, inserts, deletes and moves by original numbering', () => {
    const result = applyOps(base, [
      { type: 'replace', index: 2, content: '---\nlayout: center\n---\n\n# Zwei neu' },
      { type: 'insert', after: 3, contents: ['# Vier', '# Fünf'] },
      { type: 'insert', after: 1, contents: ['# Eins b'] },
      { type: 'delete', indexes: [3] },
    ], hashes(base))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(contents(result.text)).toEqual([
      '---\ntitle: T\n---\n\n# Eins',
      '# Eins b',
      '---\nlayout: center\n---\n\n# Zwei neu',
      '# Vier',
      '# Fünf',
    ])
    expect(parseDeck(result.text)[2]!.layout).toBe('center')
  })

  it('moves a slide to a position in the result', () => {
    const result = applyOps(base, [{ type: 'move', from: 3, to: 2 }], hashes(base))
    expect(result.ok && contents(result.text).map((c) => c.split('\n').at(-1))).toEqual(['# Eins', '# Drei', '# Zwei'])
  })

  it('is stale when a referenced slide changed', () => {
    const changed = base.replace('# Zwei', '# Zwei (bearbeitet)')
    const result = applyOps(changed, [{ type: 'replace', index: 2, content: '# X' }], hashes(base))
    expect(result).toEqual({ ok: false, stale: [2] })
  })

  it('ignores changes to slides the proposal does not touch', () => {
    const changed = base.replace('# Drei', '# Drei (bearbeitet)')
    const result = applyOps(changed, [{ type: 'replace', index: 2, content: '# X' }], hashes(base))
    expect(result.ok && contents(result.text)[2]).toBe('# Drei (bearbeitet)')
  })

  it('rejects unknown indexes', () => {
    expect(applyOps(base, [{ type: 'delete', indexes: [9] }], {})).toEqual({ ok: false, stale: [9] })
  })

  it('keeps slide 1 (deck headmatter) in place', () => {
    expect(() => applyOps(base, [{ type: 'delete', indexes: [1] }], {})).toThrow(/Slide 1/)
    expect(() => applyOps(base, [{ type: 'move', from: 1, to: 3 }], {})).toThrow(/Slide 1/)
    expect(() => applyOps(base, [{ type: 'move', from: 3, to: 1 }], {})).toThrow(/Slide 1/)
    expect(() => applyOps(base, [{ type: 'insert', after: 0, contents: ['# X'] }], {})).toThrow(/Slide 1/)
  })

  it('keeps CRLF line endings', () => {
    const crlf = base.replaceAll('\n', '\r\n')
    const result = applyOps(crlf, [{ type: 'insert', after: 3, contents: ['# Vier\n\nText'] }], {})
    expect(result.ok && result.text).toBe(crlf + '\r\n---\r\n\r\n# Vier\r\n\r\nText\r\n')
  })
})

describe('undoOps', () => {
  const base = '---\ntitle: T\n---\n\n# Eins\n\n---\n\n# Zwei\n\n---\n\n# Drei\n'
  const hashes = (md: string) => Object.fromEntries(parseDeck(md).map((s) => [s.index, s.hash]))
  const ops = [
    { type: 'replace' as const, index: 2, content: '# Zwei neu' },
    { type: 'insert' as const, after: 3, contents: ['# Vier'] },
    { type: 'delete' as const, indexes: [3] },
  ]

  it('restores the previous slides', () => {
    const applied = applyOps(base, ops, hashes(base))
    if (!applied.ok) throw new Error('stale')
    const undone = undoOps(applied.text, applied.undo)
    expect(undone.ok && undone.text).toBe(base)
  })

  it('keeps later edits to untouched slides', () => {
    const applied = applyOps(base, ops, hashes(base))
    if (!applied.ok) throw new Error('stale')
    const edited = applied.text.replace('# Eins', '# Eins (später)')
    const undone = undoOps(edited, applied.undo)
    expect(undone.ok && undone.text).toBe(base.replace('# Eins', '# Eins (später)'))
  })

  it('refuses when a changed slide was edited afterwards', () => {
    const applied = applyOps(base, ops, hashes(base))
    if (!applied.ok) throw new Error('stale')
    expect(undoOps(applied.text.replace('# Zwei neu', '# Zwei neu!'), applied.undo).ok).toBe(false)
    expect(undoOps(applied.text + '\n---\n\n# Extra\n', applied.undo).ok).toBe(false)
  })
})
