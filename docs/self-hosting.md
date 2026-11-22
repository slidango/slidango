# Self-hosting Slidango

**Your server. *Your decks.*** One `docker compose up` on any server with Docker. Caddy handles HTTPS. No account, no SaaS.

- [Try it locally](#try-it-locally)
- [Production](#production)
- [Sign-in](#sign-in)
- [Deck permissions](#deck-permissions)
- [API tokens and MCP](#api-tokens-and-mcp)
- [More settings](#more-settings)
- [Backups](#backups)
- [Security](#security)
- [Known limits](#known-limits)

## Try it locally

```bash
docker compose -f docker-compose.local.yml up --build
# → http://slides.localhost:3000
```

App and Postgres only; every request runs as `DEV_USER_EMAIL`. Don't expose this to a network.

## Production

One host with `caddy`, `app`, `postgres`, plus `oauth2-proxy` for SSO.

```bash
git clone git@github.com:slidango/slidango.git && cd slidango
cp .env.example .env   # domains, sign-in, secrets, optionally the LLM
docker compose up -d
```

- **Image.** CI pushes every green `main` to `ghcr.io/slidango/slidango`. Pin it in `.env` with the line from the job summary: `APP_IMAGE=ghcr.io/slidango/slidango:<sha>@sha256:…`. Or build on the host with `docker compose up -d --build`. While the repository is private, so is the image: the server needs `docker login ghcr.io` with a token that may only `read:packages`.
- **Domains and certificates.** Each deck's preview runs on its own subdomain, `<deck>.PREVIEW_DOMAIN`. You need wildcard DNS and a certificate for `APP_DOMAIN` and `*.PREVIEW_DOMAIN` in `TLS_DIR` (`fullchain.pem`, `privkey.pem`). The subdomains are a security boundary: code in a deck can't act as the person viewing it.
- **Missing variables** stop `docker compose` with a hint.
- **Shutdown.** On `SIGTERM`, the app writes all open documents to Postgres and `slides.md` before it exits.

## Sign-in

Set `AUTH_MODE` in `.env`.

| | `oidc` | `local` |
| --- | --- | --- |
| Who signs in | Your identity provider, through oauth2-proxy | Accounts invited by an admin |
| Setup | `COMPOSE_FILE=docker-compose.yml:docker-compose.oidc.yml` and the `OIDC_*` values | `AUTH_SECRET` (32+ characters) |
| Restrict | `ALLOWED_EMAIL_DOMAINS` | Only invited people |
| First admin | In `ADMIN_EMAILS`: admin on first sign-in | In `ADMIN_EMAILS`: a setup link appears in the app log on start |

- **Admins** manage people in **Settings → People**: invite by link (passed on by hand, no mail server), reset passwords, grant admin rights, disable accounts, sign people out everywhere, revoke their tokens. `ADMIN_EMAILS` promotes on sign-in and never demotes.
- **Setup link by hand:** `docker compose exec app node_modules/.bin/tsx src/cli.ts invite you@example.com`
- **`local`:** passwords of at least 10 characters, stored as scrypt hashes. A signed session cookie covers the app and all previews (`AUTH_SESSION_DAYS`, default 30). Changing the password, disabling or *Sign out everywhere* ends all sessions at once. 10 failed attempts per client or per email lock sign-in for 15 minutes.
- **`oidc`:** Caddy asks oauth2-proxy (`forward_auth`) and passes `X-Auth-Request-*` on, after dropping client-supplied copies. The app trusts these headers, so it is only reachable through Caddy; the compose file publishes no app port.
- **Upgrading from the shared password:** `AUTH_MODE=password` now means `local`; `AUTH_PASSWORD` and `AUTH_ADMIN_PASSWORD` are ignored. People keep their decks; send each of them an invite link.

## Deck permissions

Each deck has an access setting (**⋯ → Share**) and members with a role.

| | View | Edit | Rename, archive, template, share |
| --- | :---: | :---: | :---: |
| Owner | ✓ | ✓ | ✓ |
| Editor | ✓ | ✓ | |
| Viewer | ✓ | | |
| Everyone else, *Everyone can edit* (default) | ✓ | ✓ | |
| Everyone else, *Everyone can view* | ✓ | | |
| Everyone else, *Members only* | | | |

Admins can do everything and see every deck. Decks you can't see answer `404`. Changing access reconnects open editors, so new rights apply at once.

## API tokens and MCP

Everyone creates personal tokens in **Account → API tokens**: *Read only* or *Read and suggest changes*, optionally expiring. A token (`sld_…`) is shown once and stored as a SHA-256 hash. It never does more than its owner, never admin tasks, and stops working the moment it is revoked or its owner is disabled.

MCP clients talk to `https://<APP_DOMAIN>/mcp` (Streamable HTTP, stateless). Setup for Claude Code, Claude Desktop, Cursor, VS Code, pi, VibePod and others: [`mcp-clients.md`](mcp-clients.md). Quick example:

```bash
claude mcp add --transport http slidango https://slides.example.com/mcp \
  --header "Authorization: Bearer sld_…"
```

Other clients:

```json
{
  "mcpServers": {
    "slidango": {
      "type": "http",
      "url": "https://slides.example.com/mcp",
      "headers": { "Authorization": "Bearer sld_…" }
    }
  }
}
```

| Tool | Does |
| --- | --- |
| `list_decks` | Decks you can see, with your permissions |
| `read_deck` | All slides: number, title, layout, Markdown, hash |
| `get_template_guide` | Allowed layouts and the template's writing guide |
| `propose_changes` | Replace, insert, delete or move slides, as a suggestion |
| `apply_proposal` · `undo_proposal` | Only your own, only with *Apply directly* |
| `save_version` | Commit the current state with a message |
| `create_deck` | A new deck you own, optionally with a template |
| `list_templates` | Templates and versions decks can use, the default one marked |
| `set_deck_template` | Switch a deck's template or version: owners and admins only, not a suggestion (saved as a version); slides with layouts the template lacks are reported first |

Suggestions appear in the editor and in the Slidango AI panel, marked with the client's name. They land without review only if the person turned on *Apply directly*. While a client works, it shows up in the deck as its own presence (`Claude Code · Gabriel`).

In `oidc` mode, Caddy lets requests with `Authorization: Bearer sld_…` to `/mcp` and `/api/*` skip SSO; the app authenticates them by the token alone (`deploy/caddy-auth/oidc.caddy`). At most 120 requests per token and minute.

## More settings

| Variable | Default | |
| --- | --- | --- |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | | Any OpenAI-compatible endpoint. Admins can change it in **Settings → Slidango AI**; the key is never sent to the browser. Deck content and briefings go to this endpoint. |
| `LLM_VISION` | `false` | Send briefing images to the model |
| `RUNNER_MAX_INSTANCES` | `15` | Slidev processes at most. Measure RAM per process before you size the host. |
| `RUNNER_IDLE_MINUTES` | `10` | Stop a preview without editors or open presentations |

**Templates** are Slidev themes. The Slidango template ships with the app and is the default until an admin picks another one. More templates, and new versions of a template, are uploaded as `.zip` or `.tgz` in **Settings → Templates**: a new package name adds a template, the same name adds a version (the version comes from `package.json` unless you type one). New decks pick a template when they are created; existing decks switch template or version in **⋯ → Template**. Templates are installed without install scripts, smoke-tested with their starter deck, then set as default. Format: [`template.md`](template.md).

## Backups

```bash
deploy/backup.sh                     # → backups/<timestamp>/{db.dump,data.tgz}, keeps the newest 14
deploy/restore.sh backups/<timestamp>
```

Run nightly via cron, e.g. `0 2 * * * cd /opt/slidango && deploy/backup.sh >> backups/backup.log 2>&1`. A backup holds the database (decks, live documents, chats, suggestions, accounts, settings) and `/data` (deck files with their Git history, briefing files, templates). On restore, the live document from the database wins and rewrites `slides.md`.

Restore has been tested into an empty database and data directory with a stand-in for Docker. **Repeat it once with real Docker on a fresh host before you rely on it.**

## Security

- Slidev Markdown can contain Vue code that runs in the preview. Previews live on their own subdomains; Slidev processes get no app secrets, and Slidev's own MCP endpoint (`/__mcp`) is not passed through.
- Slidev processes run as the same Unix user as the app. Fine for a team tool where only colleagues edit decks.
- Template uploads are installed with `--ignore-scripts`; paths inside archives are checked.
- Slidango AI and MCP clients change decks only through four slide operations, each checked: allowed layouts, one slide per content, slide 1 (deck settings) replaceable but never deleted or moved, hashes against concurrent edits.
- Deck content can carry instructions for an outside agent (prompt injection). Suggestion-first, undo and versions limit the damage; the server can't prevent it.

## Known limits

- Invite and reset links are not mailed; admins pass them on.
- MCP clients use copied tokens. OAuth sign-in for MCP is not there yet.
- A deck's first preview takes a few seconds longer while Vite bundles its dependencies.
- In the embedded preview, Slidev still shows its own arrows on hover. They do the same as the bar below.
