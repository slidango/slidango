import { parse as parseYaml } from 'yaml'

/** Problems that would break the slide or the preview; empty when fine. */
export function validateSlide(content: string, layouts: string[]): string[] {
  const errors: string[] = []
  const text = content.replace(/\r\n/g, '\n').trim()
  const fm = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
  if (fm) {
    let data: unknown
    try {
      data = parseYaml(fm[1]!)
    } catch (err) {
      errors.push(`Frontmatter is not valid YAML: ${(err as Error).message.split('\n')[0]}`)
    }
    if (data !== undefined && data !== null && (typeof data !== 'object' || Array.isArray(data))) {
      errors.push('Frontmatter must consist of key-value pairs.')
    }
    const layout = (data as { layout?: unknown } | null)?.layout
    if (layout !== undefined && (typeof layout !== 'string' || !layouts.includes(layout))) {
      errors.push(`Layout "${String(layout)}" doesn’t exist. Allowed: ${layouts.join(', ')}`)
    }
  }
  const body = fm ? text.slice(fm[0].length) : text
  if (/^---\s*$/m.test(body.replace(/```[\s\S]*?```/g, ''))) {
    errors.push('The slide contains a `---` separator; write exactly one slide.')
  }
  return errors
}
