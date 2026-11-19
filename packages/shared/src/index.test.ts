import { describe, expect, it } from 'vitest'
import { collabDocumentName, createDeckSchema, deckIdFromDocumentName, slugify } from './index'

describe('slugify', () => {
  it('produces DNS-safe labels', () => {
    expect(slugify('Q4 Größenänderung – Übersicht!')).toBe('q4-grossenanderung-ubersicht')
    expect(slugify('  ---  ')).toBe('deck')
    expect(slugify('a'.repeat(100))).toHaveLength(48)
  })
})

describe('document names', () => {
  it('round-trips', () => {
    expect(deckIdFromDocumentName(collabDocumentName('abc'))).toBe('abc')
    expect(deckIdFromDocumentName('other:abc')).toBeNull()
  })
})

describe('createDeckSchema', () => {
  it('trims and defaults', () => {
    expect(createDeckSchema.parse({ title: ' Hi ' })).toEqual({ title: 'Hi', mode: 'empty' })
    expect(() => createDeckSchema.parse({ title: '  ' })).toThrow()
  })
})
