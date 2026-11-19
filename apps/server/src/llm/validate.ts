import { readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const INTERNAL_LAYOUTS = new Set(['404', 'error'])

/** Layout names available to a deck: Slidev's built-in ones plus the theme's. */
export async function availableLayouts(runtimeModules: string, themeName: string | null): Promise<string[]> {
  const dirs: string[] = []
  const cli = await realpath(join(runtimeModules, '@slidev/cli')).catch(() => null)
  const fromCli = createRequire(join(cli ?? join(runtimeModules, '@slidev/cli'), 'package.json'))
  // @slidev/client does not export package.json; search the paths Node would use from the CLI.
  for (const base of fromCli.resolve.paths('@slidev/client') ?? []) dirs.push(join(base, '@slidev/client/layouts'))
  dirs.push(join(runtimeModules, themeName ?? '@slidev/theme-default', 'layouts'))
  const names = new Set<string>()
  for (const dir of dirs) {
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      if (file.endsWith('.vue') && !INTERNAL_LAYOUTS.has(file.slice(0, -4))) names.add(file.slice(0, -4))
    }
  }
  return [...names].sort()
}

export { validateSlide } from '@slidango/shared'
