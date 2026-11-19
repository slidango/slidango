import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'prompts')
const cache = new Map<string, string>()

/** Loads `prompts/<name>.md` and fills `{{key}}` placeholders. */
export async function prompt(name: string, values: Record<string, string> = {}): Promise<string> {
  let template = cache.get(name)
  if (template === undefined) {
    template = await readFile(join(dir, `${name}.md`), 'utf8')
    cache.set(name, template)
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '').trim()
}
