import { describe, expect, it } from 'vitest'
import { setHeadmatter } from './headmatter'

describe('setHeadmatter', () => {
  it('replaces an existing key', () => {
    expect(setHeadmatter('---\ntheme: old\ntitle: X\n---\n\n# A\n', { theme: 'acme' })).toBe(
      '---\ntheme: acme\ntitle: X\n---\n\n# A\n',
    )
  })

  it('adds missing keys at the end of the headmatter', () => {
    expect(setHeadmatter('---\ntitle: X\n---\n# A\n', { theme: '@acme/slidev-theme', editor: false })).toBe(
      '---\ntitle: X\ntheme: "@acme/slidev-theme"\neditor: false\n---\n# A\n',
    )
  })

  it('creates headmatter when there is none', () => {
    expect(setHeadmatter('# A\n', { theme: 'acme' })).toBe('---\ntheme: acme\n---\n\n# A\n')
    expect(setHeadmatter('', { theme: 'acme' })).toBe('---\ntheme: acme\n---\n')
  })

  it('leaves nested values and later slides alone', () => {
    const md = '---\ntheme: a\nfonts:\n  theme: keep\n---\n\n# A\n\n---\ntheme: b\n---\n'
    expect(setHeadmatter(md, { theme: 'c' })).toBe('---\ntheme: c\nfonts:\n  theme: keep\n---\n\n# A\n\n---\ntheme: b\n---\n')
  })

  it('handles CRLF line endings', () => {
    expect(setHeadmatter('---\r\ntheme: a\r\n---\r\n# A', { theme: 'b' })).toBe('---\r\ntheme: b\r\n---\r\n# A')
  })
})
