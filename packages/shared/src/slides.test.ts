import { describe, expect, it } from 'vitest'
import { slideAtLine } from './slides'

const deck = [
  '---', // 0 headmatter
  'title: Test',
  '---',
  '',
  '# Eins', // 4
  '',
  '---', // 6
  '',
  '# Zwei',
  '',
  '```yaml', // 10
  '---',
  'a: 1',
  '---',
  '```',
  '',
  '---', // 16
  'layout: center',
  'hide: true',
  '---',
  '',
  '# Versteckt', // 21
  '',
  '---', // 23
  '',
  '# Drei', // 25
  '',
  '<!-- Notiz -->',
].join('\n')

describe('slideAtLine', () => {
  it('maps lines to Slidev slide numbers', () => {
    expect(slideAtLine(deck, 0)).toBe(1)
    expect(slideAtLine(deck, 4)).toBe(1)
    expect(slideAtLine(deck, 8)).toBe(2)
  })

  it('ignores --- inside code blocks', () => {
    expect(slideAtLine(deck, 12)).toBe(2)
    expect(slideAtLine(deck, 14)).toBe(2)
  })

  it('skips hidden slides in the numbering', () => {
    expect(slideAtLine(deck, 21)).toBe(2)
    expect(slideAtLine(deck, 25)).toBe(3)
    expect(slideAtLine(deck, 27)).toBe(3)
  })

  it('handles empty and invalid input', () => {
    expect(slideAtLine('', 0)).toBe(1)
    expect(slideAtLine('---\ntitle: [unclosed\n---\n# A', 3)).toBe(1)
  })
})
