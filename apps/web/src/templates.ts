import type { Theme } from '@slidango/shared'

/** A template (one theme package) with its installed versions, newest first. */
export interface TemplateGroup {
  name: string
  label: string
  builtin: boolean
  versions: Theme[]
  /** The newest ready version: what you get when you pick this template. */
  latest: Theme | null
}

export function groupTemplates(themes: Theme[]): TemplateGroup[] {
  const groups = new Map<string, TemplateGroup>()
  for (const theme of themes) {
    let group = groups.get(theme.name)
    if (!group) {
      group = { name: theme.name, label: theme.label, builtin: false, versions: [], latest: null }
      groups.set(theme.name, group)
    }
    group.versions.push(theme)
    group.builtin ||= theme.builtin
  }
  for (const group of groups.values()) {
    group.versions.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    group.latest = group.versions.find((v) => v.status === 'ready') ?? null
    group.label = group.latest?.label ?? group.versions[0]!.label
  }
  // Built-in first, then by name.
  return [...groups.values()].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.label.localeCompare(b.label))
}

/** "Slidango 1.0.0", or the Slidev default theme for decks without a template. */
export function templateLabel(themes: Theme[], themeId: string | null): string {
  if (!themeId) return 'Slidev default'
  const theme = themes.find((t) => t.id === themeId)
  return theme ? `${theme.label} ${theme.version}` : themeId
}
