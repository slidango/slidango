type Scalar = string | number | boolean

function yamlScalar(value: Scalar): string {
  if (typeof value !== 'string') return String(value)
  return /^[A-Za-z0-9][\w./-]*$/.test(value) && !/^(true|false|null|yes|no|on|off|~)$/i.test(value)
    ? value
    : JSON.stringify(value)
}

/**
 * Sets top-level scalar keys in the deck headmatter (the first frontmatter
 * block), keeping every other line untouched. Creates the block if missing.
 */
export function setHeadmatter(markdown: string, values: Record<string, Scalar>): string {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.split(/\r?\n/)
  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  const entries = Object.entries(values)

  if (close === -1) {
    const block = ['---', ...entries.map(([k, v]) => `${k}: ${yamlScalar(v)}`), '---']
    return markdown ? [...block, '', markdown].join(eol) : block.join(eol) + eol
  }

  const head = lines.slice(1, close)
  for (const [key, value] of entries) {
    const line = `${key}: ${yamlScalar(value)}`
    const index = head.findIndex((l) => l.startsWith(`${key}:`))
    if (index === -1) head.push(line)
    else head[index] = line
  }
  return ['---', ...head, ...lines.slice(close)].join(eol)
}
