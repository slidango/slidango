import { parseSync } from '@slidev/parser/core'

/**
 * 1-based Slidev route number of the slide containing a 0-based line.
 * Uses Slidev's own parser so separators match exactly; hidden slides are not
 * routable, so a line inside one maps to the previous visible slide.
 */
export function slideAtLine(markdown: string, line: number): number {
  let slides
  try {
    slides = parseSync(markdown, 'slides.md').slides
  } catch {
    return 1
  }
  let number = 0
  for (const slide of slides) {
    const hidden = Boolean(slide.frontmatter?.hide || slide.frontmatter?.disabled)
    if (slide.start > line) break
    if (!hidden) number++
  }
  return Math.max(1, number)
}
