# Template packages

A template is a Slidev theme packed as `.zip` or `.tgz` (50 MB at most), for example with `npm pack`. Admins upload it in **Settings → Templates** with a version and a changelog. Slidango ships its own in [`theme/`](../theme) (`pnpm theme:pack`); use it as a starting point for yours.

```
package.json   Required: name, version. Optionally @slidev/cli as a dependency (pins the Slidev version)
guide.md       Required: the writing guide for people and Slidango AI
starter.md     Optional: the starter deck for "Start with: The template's starter deck"
layouts/       Vue layouts (file name = layout name)
components/    Vue components
styles/        CSS / UnoCSS
fonts/, public/  Fonts, logos, images
```

`package.json`, for example:

```json
{
  "name": "slidev-theme-acme",
  "version": "1.4.0",
  "keywords": ["slidev-theme", "slidev"],
  "dependencies": { "@slidev/cli": "53.0.0" },
  "slidev": {
    "colorSchema": "auto",
    "defaults": { "aspectRatio": "16/9" }
  }
}
```

## guide.md

`guide.md` goes along as context with every Slidango AI request (chat, outline, first draft) and every MCP `get_template_guide` call. Describe each layout: what it is for, its slots, a short example. Writing rules (headline style, bullet length, speaker notes) belong here too.

````md
## Layouts

### acme-cover
Title slide. Title as `#`, subtitle as a paragraph.

```md
---
layout: acme-cover
---

# Quarterly report Q4
Sales, Austria
```
````

## Light and dark

If your theme has a dark variant (styles under `html.dark`), set `"colorSchema": "auto"` in `package.json`: Slidango's preview then follows the app theme of the person editing, and presenting follows the presenter's setting. A deck fixes one variant for everyone with `colorSchema: light` or `colorSchema: dark` in its headmatter. Themes without a dark variant should set `"colorSchema": "light"`. The Slidango template uses `auto`.

## What happens after the upload

1. **Check:** `package.json` with name and version, `guide.md` present, version not taken yet, no paths outside the package.
2. **Install:** `pnpm install --prod --ignore-scripts` into a runtime of its own per version (`/data/themes/<version>/runtime`).
3. **Smoke test:** `slidev build` with `starter.md` (or a minimal slide).
4. **Ready** only if that succeeds; otherwise **Failed**, with the log.

Slidango AI and MCP clients only accept layouts from the template's `layouts/` and Slidev's built-in layouts.
