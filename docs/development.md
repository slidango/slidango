# Developing Slidango

Node 22 and pnpm 10.

```bash
pnpm install
pnpm --dir apps/server/runtime install --ignore-workspace   # Slidev for the previews
DEV_USER_EMAIL=me@example.com ADMIN_EMAILS=me@example.com pnpm dev
```

- App: <http://slides.localhost:5173>. Vite proxies `/api`, `/collab` and `/mcp` to the server on port 3000.
- Previews: `http://<deck-slug>.slides.localhost:3000`. Chrome and Firefox resolve `*.localhost` on their own.
- Without `DATABASE_URL` the server uses PGlite (embedded Postgres) in `apps/server/data`; decks live in `apps/server/data/decks`. Set `DATABASE_URL=postgres://…` for real Postgres. Migrations run on start.
- `DEV_USER_EMAIL` stands in for SSO. The server refuses to start with it in production.
- Slidango AI: set `LLM_BASE_URL`, `LLM_MODEL` and optionally `LLM_API_KEY`, or enter them as admin in **Settings → Slidango AI**.
- Schema change: edit `apps/server/src/db/schema.ts`, then `pnpm --filter @slidango/server db:generate`.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test        # server against PGlite (or TEST_DATABASE_URL), real Slidev processes, mocked LLM
pnpm test:e2e    # Playwright; once: pnpm exec playwright install --with-deps chromium
pnpm --filter @slidango/server eval   # real model calls; needs LLM_BASE_URL, LLM_MODEL, LLM_API_KEY
```

The eval suite checks the first-draft acceptance criteria (a briefing with a 10-page PDF, slide count ±1, only template layouts, speaker notes on every slide, a clean Slidev build, under two minutes) and two chat cases.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs lint, typecheck, tests against Postgres 16 and E2E in the Playwright image, then builds the image for `main` and pushes it to `ghcr.io/slidango/slidango`. Actions are pinned to commit SHAs, images to digests.

## Layout

```
apps/server          Fastify API, Hocuspocus (/collab), MCP (/mcp), Slidev runner and preview proxy, templates, LLM agent
apps/server/runtime  Slidev for decks without an uploaded template (own pnpm project)
apps/web             Vue 3, CodeMirror 6, y-codemirror.next
packages/shared      Zod schemas, slide parser and operations (on @slidev/parser)
e2e/                 Playwright tests, stand-ins for the auth proxy and the LLM
deploy/              Caddy configuration, backup and restore
docs/                Self-hosting, plans, template format, pilot guide
```

## A tour for testing by hand

**Co-editing.** Create a deck (*Start with: Empty*) and open the same URL in a second window: two people appear at the top, each cursor in its own colour. Type in both at once; `slides.md` in the deck folder follows within about 0.4 s. Restart the server: both windows reconnect, nothing is lost.

**Editor and preview.** Slide list, Markdown and preview side by side, Slidango AI below. Drag the dividers (double-click resets), collapse the slide list or the editor. The preview (one Slidev dev server per deck) follows the cursor without reloading; paging in the preview moves the editor. Under the preview: present, fullscreen, presenter view, export (PDF, PPTX, PNG), overview. The slide list shows layouts, open suggestions, problems and who is where; drag slides to reorder (`Ctrl+Z` undoes).

**Versions and templates.** *Save version* (`Ctrl+S`) commits to the deck's Git repository; **⋯ → Versions** restores a state, live for everyone. **⋯ → Insert image** uploads an image. As admin, upload a template in **Settings → Templates** and make it the default.

**Slidango AI.** A deck started with *Slidango AI* shows a briefing instead of the preview (topic, goal, audience, length, notes, files). *Create outline*, edit it, then *Write first draft*: the deck fills slide by slide while everyone watches. In the panel, ask for changes; suggestions arrive as a diff card and in the editor; *Apply*, *Discard*, *Undo*. Each person has their own conversations.

**Sharing, accounts, tokens.** **⋯ → Share** sets access and members. **Account → API tokens** creates a token with ready-made snippets for Claude Code and other MCP clients. With `AUTH_MODE=local`, **Settings → People** invites people by link.
