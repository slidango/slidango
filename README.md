# Slidango

Selbst gehostete Plattform, auf der mehrere Personen Slidev-Decks gleichzeitig bearbeiten: Echtzeit-Editor mit Live-Preview, hochladbares Firmen-Template, Versionen per Git und ein LLM-Assistent, der Erstentwürfe schreibt und Änderungen als prüfbare Vorschläge macht. Plan und Architektur: [`docs/plan-v1.md`](docs/plan-v1.md).

## Aufbau

```
apps/server         Fastify-API, Hocuspocus (/collab), Slidev-Runner + Preview-Proxy, Templates, LLM-Agent
apps/server/runtime Slidev-Installation für Decks ohne hochgeladenes Template (eigenes pnpm-Projekt)
apps/web            Vue 3 + CodeMirror 6 + y-codemirror.next
packages/shared     Zod-Schemas, Folien-Parser und -Operationen (auf Basis von @slidev/parser)
e2e/                Playwright-Tests, Auth-Proxy- und LLM-Attrappe
deploy/             Caddyfile, Backup- und Restore-Skript
docs/               Pilot-Leitfaden, Template-Format
```

## Lokal entwickeln

Voraussetzungen: Node 22, pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm --dir apps/server/runtime install --ignore-workspace   # Slidev für die Previews
DEV_USER_EMAIL=ich@example.com ADMIN_EMAILS=ich@example.com pnpm dev
```

- App: http://slides.localhost:5173. Vite proxyt `/api` und `/collab` auf den Server (Port 3000).
- Previews laufen unter `http://<deck-slug>.slides.localhost:3000` (Chrome und Firefox lösen `*.localhost` selbst auf).
- Ohne `DATABASE_URL` nutzt der Server PGlite (eingebettetes Postgres) unter `apps/server/data/pglite`; Decks liegen unter `apps/server/data/decks`. Für echtes Postgres `DATABASE_URL=postgres://…` setzen; Migrationen laufen beim Start.
- `DEV_USER_EMAIL` ersetzt lokal den SSO-Proxy. In Produktion verweigert der Server den Start, wenn die Variable gesetzt ist.
- Assistent: `LLM_BASE_URL`, `LLM_MODEL`, optional `LLM_API_KEY` setzen oder als Admin unter *Einstellungen (Zahnrad in der Übersicht) → Assistent* eintragen.

Schema ändern: `apps/server/src/db/schema.ts` anpassen, dann `pnpm --filter @slidango/server db:generate`.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test        # Unit + Integration: Server gegen PGlite (oder TEST_DATABASE_URL), echte Slidev-Prozesse, LLM gegen Attrappe
pnpm test:e2e    # Playwright; einmalig: pnpm exec playwright install --with-deps chromium
pnpm --filter @slidango/server eval   # echte Modell-Calls, braucht LLM_BASE_URL/LLM_MODEL/LLM_API_KEY
```

Die Eval-Suite prüft die Akzeptanzkriterien des Erstentwurfs (Briefing mit 10-seitigem PDF, Folienzahl ±1, nur Theme-Layouts, Sprechernotizen auf jeder Folie, fehlerfreier Slidev-Build, unter 2 Minuten) und zwei Chat-Fälle.

## Demo

**Co-Editing (M1)**

1. Deck anlegen (Startmodus „Leer“), dieselbe URL in einem zweiten Fenster öffnen: Oben stehen zwei Anwesende, Cursor des anderen sind farbig.
2. In beiden Fenstern gleichzeitig tippen; `slides.md` im Deck-Ordner ist nach ~0,4 s aktuell.
3. Server neu starten: Die Fenster verbinden sich neu, nichts geht verloren.

**Editor, Preview, Template, Versionen (M2)**

1. Der Editor hat drei Spalten: Folienliste | Markdown-Editor | Preview, darunter der Assistent. Die Trennlinien lassen sich ziehen (Doppelklick setzt zurück), Folienliste und Assistent einklappen. Die Einstellungen merkt sich der Browser. Auf schmalen Bildschirmen gibt es Tabs.
2. Die Preview (ein Slidev-Dev-Server pro Deck) folgt dem Cursor ohne Neuladen. Blättert man in der Preview (‹ ›, Pfeiltasten), springt der Editor mit. Unter der Preview: Präsentieren, Vollbild, Presenter-Ansicht, Export (PDF, PPTX, PNG über Slidevs Exporter), Folienübersicht.
3. Die Folienliste zeigt Layout, offene Vorschläge, Fehler und wer gerade auf welcher Folie ist; Folien lassen sich per Drag & Drop verschieben (Folie 1 bleibt vorne, `Strg+Z` macht es rückgängig). Ungültiges Frontmatter und unbekannte Layouts werden im Editor markiert und in der Statusleiste genannt.
4. „Version speichern“ (`Strg+S`) committet ins Deck-Repository; über „⋯ → Versionen“ lässt sich ein Stand wiederherstellen, live für alle. „⋯ → Bild einfügen“ lädt ein Bild hoch.
5. In der Deck-Übersicht öffnet „Präsentieren“ nur die Präsentation in einem neuen Tab, ohne Editor. Offene Präsentationen halten die Preview am Laufen, auch ohne Editor.
6. Als Admin unter *Einstellungen → Templates* ein Template hochladen (Format: [`docs/template.md`](docs/template.md)), nach dem Smoke-Test als Default setzen. Neue Decks nutzen es; bestehende wechseln über „⋯ → Template“, das den Changelog zeigt.

**Assistent (M3)**

1. Neues Deck mit Startmodus „Mit Assistent“: Statt der Preview erscheint das Briefing (Thema, Ziel, Zielgruppe, Umfang, Notizen, Dateien: MD, TXT, PDF, Bilder).
2. „Gliederung erstellen“: Titel, Kernaussage und Layout je Folie, frei bearbeitbar. „Erstversion schreiben“ füllt das Deck Folie für Folie; alle sehen es wachsen. „Verwerfen“ leert das Deck wieder.
3. Im Assistenten-Panel (unter der Preview) um Änderungen bitten; jede Person hat ihren eigenen Verlauf. Jeder neue Browser-Tab beginnt eine neue Unterhaltung (Neuladen behält sie), „+“ startet bewusst eine neue, frühere Unterhaltungen lassen sich über das Uhr-Symbol wieder öffnen und fortsetzen. Vorschläge erscheinen als Karte mit Diff und farbig im Editor; „Übernehmen“ wendet sie in einer Transaktion an, „Rückgängig“ stellt die alten Folien wieder her. Hat jemand die betroffenen Folien inzwischen geändert, ist der Vorschlag „veraltet“.
4. „Direkt anwenden“ (pro Person) überspringt die Bestätigung; Rückgängig bleibt möglich.

## Betrieb

**Lokal mit Docker ausprobieren (ohne SSO):**

```bash
docker compose -f docker-compose.local.yml up --build    # http://slides.localhost:3000
```

Nur App + Postgres, alle Requests laufen als `DEV_USER_EMAIL`. Nicht im Netz erreichbar machen.

**Produktion:** ein Host mit docker-compose: `caddy`, `app`, `postgres`, bei SSO zusätzlich `oauth2-proxy`.

```bash
cp .env.example .env              # Domains, Login-Modus, Secrets, optional LLM ausfüllen
# Wildcard-Zertifikat für APP_DOMAIN und *.PREVIEW_DOMAIN nach $TLS_DIR (fullchain.pem, privkey.pem)
docker compose up -d --build
```

Fehlt eine Pflichtvariable in `.env`, bricht `docker compose` sofort mit Hinweis ab.

- **Login-Modus** (`AUTH_MODE`, Pflicht):
  - `oidc` – SSO über oauth2-proxy. In `.env` muss `COMPOSE_FILE=docker-compose.yml:docker-compose.oidc.yml` stehen, damit oauth2-proxy mitläuft. Caddy fragt per `forward_auth` bei oauth2-proxy nach und reicht `X-Auth-Request-Email`/`-Preferred-Username` an die App weiter. Vorher entfernt Caddy vom Client mitgeschickte Kopien dieser Header, weil `forward_auth` nur Header überschreibt, die die Auth-Antwort tatsächlich setzt. **Die App vertraut diesen Headern** und darf nur über Caddy erreichbar sein; im Compose-File ist kein Port der App veröffentlicht.
  - `password` – ein gemeinsames Passwort (`AUTH_PASSWORD`), kein oauth2-proxy und keine `OIDC_*`-Variablen nötig (`COMPOSE_FILE`-Zeile weglassen). Die App zeigt selbst ein Anmeldeformular (Name, E-Mail, Passwort) und setzt ein mit `AUTH_SECRET` signiertes Cookie (30 Tage, `AUTH_SESSION_DAYS`) für die App-Domain und alle Preview-Subdomains. `X-Auth-Request-*`-Header werden in diesem Modus ignoriert. Name und E-Mail gibt jede Person selbst an – wer das Passwort kennt, kann sich als beliebige Person ausgeben. Nach 10 Fehlversuchen pro Client ist der Login 15 Minuten gesperrt. Ein Passwortwechsel meldet alle ab.
- **Admins:** bei `oidc` über `ADMIN_EMAILS` (kommagetrennt); bei `password` ist Admin, wer sich mit `AUTH_ADMIN_PASSWORD` statt `AUTH_PASSWORD` anmeldet (ohne `AUTH_ADMIN_PASSWORD` gibt es keine Admins, der Assistent läuft dann nur mit den `LLM_*`-Werten aus `.env`). Admins sehen in der Übersicht ein Zahnrad für die *Einstellungen*: Templates, Assistent (LLM), laufende Previews.
- **Previews:** höchstens `RUNNER_MAX_INSTANCES` Slidev-Prozesse (Default 15), Stopp nach `RUNNER_IDLE_MINUTES` ohne Editor-Verbindung (Default 10). Bricht Slidev ab, wird es einmal neu gestartet; danach zeigt die Preview die letzten Log-Zeilen. Den RAM-Bedarf pro Prozess vor dem Pilot messen (siehe `docs/pilot.md`).
- **Neustart:** Bei `SIGTERM` schreibt die App alle offenen Yjs-Stände nach Postgres und `slides.md`, bevor sie beendet (`stop_grace_period: 30s`).
- **LLM:** Base-URL, Modell und Key aus `.env` sind Defaults; Admins können sie in der UI ändern (der Key wird dann in der Datenbank gespeichert und nie an den Browser ausgeliefert). Deck-Inhalte und Briefings gehen an diesen Endpoint.

### Backup und Wiederherstellung

```bash
deploy/backup.sh                  # → backups/<zeitstempel>/{db.dump,data.tgz}, behält die neuesten 14
deploy/restore.sh backups/<zeitstempel>
```

Nächtlich per Cron auf dem Host, z. B. `0 2 * * * cd /opt/slidango && deploy/backup.sh >> backups/backup.log 2>&1`. Die Sicherung enthält die Datenbank (Decks, Yjs-Stände, Chats, Vorschläge, Einstellungen) und `/data` (Deck-Dateien mit Git-Historie, Briefing-Dateien, installierte Templates). Beim Wiederherstellen ist der Yjs-Stand aus der Datenbank maßgeblich und schreibt `slides.md` neu.

Getestet: Backup eines Hosts mit Decks, Versionen, ungespeicherten Änderungen und Briefing; Restore auf eine leere Datenbank (anderer Postgres-Cluster) und ein leeres Datenverzeichnis; danach stimmten Live-Text, `slides.md`, Versionen und Briefing, und die Preview startete. Docker wurde dabei durch eine Attrappe ersetzt, die dieselben `pg_dump`/`pg_restore`/`tar`-Befehle lokal ausführt. **Vor dem Pilot einmal mit echtem Docker auf einem frischen Host wiederholen.**

### CI/CD

`.gitlab-ci.yml`: Lint, Typecheck, Unit-/Integrationstests gegen Postgres 16 und E2E im Playwright-Image (mit installiertem Slidev-Runtime), Eval-Suite manuell (wenn `LLM_*` gesetzt), Image-Build auf dem Default-Branch, Deploy manuell per SSH (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, `SSH_PRIVATE_KEY`).

## Sicherheit

- Slidev-Markdown kann Vue-Code enthalten, der in der Preview läuft. Previews laufen auf eigenen Subdomains; die Slidev-Prozesse bekommen keine App-Geheimnisse (`DATABASE_URL`, API-Keys) in die Umgebung, und Slidevs MCP-Endpoint (`/__mcp`, könnte Folien schreiben) wird nicht durchgereicht.
- Slidev-Prozesse laufen als derselbe Unix-User wie die App (der Plan sieht einen eigenen User vor). Für ein internes Tool vertretbar, solange nur Mitarbeitende Decks bearbeiten.
- Template-Uploads werden ohne Install-Skripte (`--ignore-scripts`) installiert; Pfade im Archiv werden geprüft.
- Der LLM-Agent ändert das Deck nur über vier Folien-Werkzeuge; jede Änderung ist ein Vorschlag mit Hash-Prüfung. Folie 1 (Deck-Einstellungen) kann er ersetzen, aber nicht löschen oder verschieben.

## Bekannte Grenzen

- Rollen pro Deck sind vorbereitet (`can()`, `deck_members`), aber in v1 darf jede angemeldete Person alles.
- Der erste Start einer Preview pro Deck dauert einige Sekunden länger: Vite bündelt die Abhängigkeiten einmal je Deck und lädt die Seite dabei neu.
- In der eingebetteten Preview blendet Slidev beim Überfahren mit der Maus noch eigene Pfeile ein; sie tun dasselbe wie die Leiste darunter.
