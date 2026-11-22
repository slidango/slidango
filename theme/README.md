# slidev-theme-slidango

The Slidango look for [Slidev](https://sli.dev): warm paper, bold Geist headlines with one Instrument Serif punchline in tango, mono labels, a dot grid on cover, section and end slides. Fonts are bundled (OFL). Light and dark: a deck follows the viewer's theme by default; `colorSchema: light` or `colorSchema: dark` in its settings fixes it to one variant.

Layouts: `cover`, `default`, `section`, `two-cols`, `center`, `statement`, `fact`, `quote`, `end`. Writing rules and examples: [`guide.md`](guide.md). Every layout in one deck: [`starter.md`](starter.md).

## In Slidango

The template ships with the app (it is part of the built-in Slidev runtime in `apps/server/runtime`) and is the default template until an admin picks another one. After changing files here, reinstall the runtime so the app picks them up:

```bash
pnpm --dir apps/server/runtime install --ignore-workspace
```

`pnpm theme:pack` builds an uploadable package (`theme/dist/slidev-theme-slidango-<version>.tgz`) if you want to ship a newer version to an existing installation without updating the app.
