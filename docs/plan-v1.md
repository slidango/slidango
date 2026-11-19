# Slidango – Umsetzungsplan v1 (damals „Slidev Collab“)

Stand: 2026-11-04 · Gabriel Lipnik

## Ziel & Scope

Die App ist eine selbst gehostete Web-Plattform, auf der mehrere Personen Slidev-Decks gleichzeitig bearbeiten, mit Live-Preview, einem hochladbaren Firmen-Template und einem LLM-Assistenten, der erste Versionen schreibt und Änderungen vorschlägt.

**Grundsatz:** Ein Service, eine Datenbank. Neue Infrastruktur (Queue, Cache, weitere Services) kommt erst, wenn ein konkretes Problem sie erzwingt.

**Kernfunktionen v1**

- Decks anlegen, umbenennen, archivieren
- Echtzeit-Co-Editing von `slides.md` mit Cursorn der anderen
- Live-Preview: pro Deck ein Slidev-Dev-Server
- Globales Template: Slidev-Theme hochladen, Decks pinnen eine Version
- LLM-Assistent: Erstentwurf aus einem Briefing, danach Chat mit Änderungsvorschlägen als Diff
- Versionen speichern (Git pro Deck), Export als PDF und PPTX (bildbasiert)
- SSO-Login

**Nicht in v1**

- Rollen pro Deck (technisch vorbereitet, siehe Auth & Rechte)
- WYSIWYG-Folieneditor, Mehrdatei-Decks, eigene Vue-Komponenten pro Deck
- Inline-LLM-Befehle (Cmd+K), MCP-Endpoint, GitLab-Mirror, Kommentare, Thumbnails
- Mehrere App-Instanzen

## Architektur

Ein Node-Service enthält API, Collab-Server, LLM-Agent und Runner; davor stehen nur Caddy und oauth2-proxy, dahinter Postgres und ein Datenverzeichnis.

```
Browser: Editor (CodeMirror + Yjs) · Live-Preview (iframe) · Assistent (Briefing, Chat)
   │ WebSocket (Yjs)        │ HTTP + HMR              │ REST + SSE
   ▼                        ▼                         ▼
Caddy + oauth2-proxy: TLS, SSO-Login, App und Deck-Subdomains
   │ mit User-Header
   ▼
App (ein Node-Prozess)
   ├── API (Fastify, can())          ──SQL──────────────▶ Postgres (Decks, Yjs-State, Chats, Proposals)
   ├── LLM-Agent (openai-SDK)        ──Chat Completions─▶ LLM-Endpoint (OpenAI-kompatibel)
   ├── Hocuspocus (Yjs, Disk-Sync)   ──schreibt─────────▶ /data (slides.md + Git, Theme-Versionen)
   └── Runner (Prozesse, Proxy)      ──startet, proxyt──▶ Slidev-Instanzen (Dev-Server je Deck, lesen slides.md)
```

Previews laufen über dieselbe App: Caddy leitet `*.slides.intern` an die App weiter, die anhand des Hostnamens zur Slidev-Instanz des Decks proxyt, inklusive HMR-WebSocket. Subdomains statt Subpfade, weil Slidevs Dev-Server mit einem `base`-Pfad Assets und HMR bricht.

## Tech-Stack

| Schicht | Wahl |
| --- | --- |
| Frontend | Vue 3 + Vite + TypeScript |
| Editor | CodeMirror 6 + `@codemirror/lang-markdown` + `y-codemirror.next` |
| Server | Node 22 + Fastify + TypeScript |
| Collab | Yjs + Hocuspocus, im selben Prozess als WebSocket-Route |
| Datenbank | PostgreSQL + Drizzle ORM |
| Preview-Proxy | `http-proxy` (HTTP + WebSocket) in Fastify |
| Versionierung | `simple-git` |
| LLM | `openai`-npm-SDK mit konfigurierbarer `baseURL` (jeder OpenAI-kompatible Endpoint) |
| PDF-Text | `unpdf` |
| Auth | oauth2-proxy (OIDC) vor der App |
| Reverse Proxy | Caddy mit Wildcard-Zertifikat |

pnpm-Monorepo: `apps/web` (Vue), `apps/server` (Fastify, Hocuspocus, LLM, Runner), `packages/shared` (Zod-Schemas, Folien-Parser), `theme/` (Firmen-Theme als Quelle für den Upload).

**Warum dieser Stack**

- **Node/TypeScript durchgehend:** Slidev, Vite, Yjs und Hocuspocus sind JavaScript-Ökosystem. Ein Service in einer Sprache heißt: keine interne API zwischen Backend und Collab-Server, ein Folien-Parser (`@slidev/parser` gibt es nur in JS), gemeinsame Typen für Frontend und Backend.
- **Yjs + Hocuspocus:** Yjs ist der De-facto-Standard für CRDT-Co-Editing und hat eine offizielle CodeMirror-Bindung. Hocuspocus bringt Persistenz, Auth-Hooks und serverseitige Änderungen (`openDirectConnection`) fertig mit; eigene Sync-Logik wäre das größte Projektrisiko.
- **CodeMirror 6 statt Monaco:** leichter, läuft auf Mobilgeräten, Diff-Markierungen über Decorations sind einfach.
- **Vue statt React:** Slidev-Themes und -Layouts sind Vue-Komponenten; ein Framework für App und Theme.
- **Fastify:** schlank, gute TypeScript-Typen, fertige Plugins für WebSocket und Proxy.
- **Postgres + Drizzle:** eine Datenbank für alles inklusive Yjs-State; Drizzle ist typsicher, leichtgewichtig und nah an SQL.
- **oauth2-proxy:** SSO ohne eigenen Auth-Code, schützt App und Preview-Subdomains gleich mit.
- **Caddy:** automatisches TLS und Wildcard-Routing in wenigen Zeilen Konfiguration; dynamisches Routing (Traefik) ist nicht nötig, weil die App selbst zur richtigen Slidev-Instanz proxyt.
- **openai-SDK:** Die OpenAI-API ist der gemeinsame Nenner; Azure, vLLM, Ollama, LiteLLM und viele Cloud-Anbieter sprechen sie.
- **Git pro Deck:** Historie, Diffs und Wiederherstellen ohne eigene Versionslogik; ein späterer GitLab-Mirror ist nur ein `push`.
- **Verworfen:** Django (zweite Runtime plus interne API), Redis und Job-Queue (kein Bedarf bei einer Instanz), Traefik und eigener Runner-Service (erst bei mehr Last).

## Datenmodell

| Tabelle | Felder |
| --- | --- |
| `users` | id, email, name, is_admin; angelegt beim ersten Request aus den oauth2-proxy-Headern |
| `decks` | id, slug, title, owner_id, theme_version, archived, created_at, updated_at |
| `deck_members` | deck_id, user_id, role; in v1 nur der Owner-Eintrag, für Rollen vorbereitet |
| `yjs_documents` | deck_id, state (bytea), updated_at |
| `themes` | version, changelog, status (`installing` / `ready` / `failed`), is_default, uploaded_by, uploaded_at |
| `briefings` | deck_id, fields (jsonb), files (jsonb: Name, Typ, extrahierter Text) |
| `llm_messages` | id, deck_id, user_id, role, content (jsonb), created_at |
| `proposals` | id, deck_id, ops (jsonb), base_hashes (jsonb), previous (jsonb, für Undo), status, created_by |
| `settings` | key, value (jsonb): LLM-Base-URL, Modell, API-Key |

**Dateisystem**

```
/data/decks/<deck-id>/
├── .git/
├── slides.md        ← nur von Hocuspocus geschrieben
├── public/          ← Bild-Uploads
├── .briefing/       ← Briefing-Dateien
└── node_modules     → Symlink auf /data/themes/<version>/runtime/node_modules
/data/themes/<version>/
├── package/         ← entpacktes Upload-Paket
└── runtime/         ← installierte Abhängigkeiten (einmal pro Version)
```

## Kollaboratives Editieren

Jedes Deck ist ein Yjs-Dokument mit einem `Y.Text` namens `slides`. Hocuspocus läuft im App-Prozess und ist der einzige Schreiber von `slides.md`.

1. Der Client verbindet sich per WebSocket mit `/collab`, Dokumentname `deck:<id>`. oauth2-proxy hängt die User-Header auch an den WebSocket.
2. `onAuthenticate`: User aus Header, `can(user, deck, 'edit')`, sonst `readOnly`.
3. `onLoadDocument`: Zustand aus `yjs_documents`; fehlt er, `slides.md` einlesen.
4. `onChange` → Debounce 400 ms → `slides.md` atomar schreiben (Temp-Datei + `rename`).
5. `onStoreDocument` (Debounce 2 s): Yjs-State nach Postgres.
6. Git-Commit nur über den Button „Version speichern“.

**Regeln**

- Die App ist Single Source of Truth. Neue Decks bekommen `editor: false` im Headmatter, damit Slidevs eigener Editor aus ist.
- Serverseitige Änderungen (LLM, Erstentwurf, Restore, Template-Wechsel) laufen über `hocuspocus.openDirectConnection(deckId)` und eine Transaktion. Alle Clients sehen sie live, es gibt keinen zweiten Schreibweg.
- Ungültiges Headmatter wird trotzdem geschrieben (kein Datenverlust), die UI zeigt eine Warnung.

## Slidev-Runner

Der Runner ist ein Modul im App-Prozess, das pro geöffnetem Deck einen `slidev`-Dev-Server als Kindprozess startet.

- **Start:** Beim Öffnen eines Decks freien Port aus 4000–4999 nehmen, `slidev slides.md --port <p>` starten, auf HTTP 200 warten (Timeout 60 s), Zuordnung Slug → Port im Speicher.
- **Stopp:** Hat das Deck 10 min keine Collab-Verbindung mehr (Hocuspocus kennt die Verbindungen), Prozess beenden. Ist das Limit erreicht (Default 15), die am längsten ungenutzte Instanz beenden.
- **Fehler:** Bei Absturz einmal neu starten, sonst Status `error` und die letzten 200 Log-Zeilen im Editor anzeigen.
- **Preview-Proxy:** Request auf `<slug>.slides.intern` → `can(user, deck, 'view')` → Weiterleitung an `localhost:<p>`, inklusive WebSocket.
- **Theme-Wechsel** eines Decks startet die Instanz neu.

## Globales Template

Das Template ist ein Slidev-Theme-Paket, das Admins hochladen. Die App speichert jede Version, neue Decks bekommen die Default-Version, bestehende Decks bleiben auf ihrer Version, bis jemand aktualisiert.

**Inhalt des Pakets:** `layouts/`, `components/`, `styles/`, `public/` (Logos, Schriften), `package.json` mit Slidev-Version und Defaults, `starter.md` (Startdeck) und `guide.md` (Pflicht: Layouts mit Zweck, Slots und Beispiel; Kontext für das LLM).

**Upload-Ablauf**

1. Admin lädt `.zip` oder `.tgz` hoch, mit Version und Changelog.
2. Validierung: `package.json` mit Name und Version, `guide.md` vorhanden, Größe ≤ 50 MB, Version noch nicht vorhanden.
3. `pnpm install --ignore-scripts --prod` nach `runtime/`, dann Smoke-Test mit `slidev build starter.md`.
4. Erst bei Erfolg Status `ready`; Fehler und Log sieht der Admin.

**Deck aktualisieren:** Button „Template aktualisieren“ zeigt den Changelog, setzt die Version, startet die Instanz neu und committet. Farben und Logo ändert man über ein neues Paket.

## LLM-Anbindung

Der Assistent läuft im App-Prozess gegen einen OpenAI-kompatiblen Endpoint, den der Admin konfiguriert. Er arbeitet mit Folien-Operationen, die als Vorschlag gezeigt und erst nach Bestätigung angewendet werden.

**Interfaces in v1:** Briefing-Panel für leere Decks (siehe nächster Abschnitt) und Chat-Panel neben dem Editor.

**Kontext pro Anfrage:** System-Prompt mit Slidev-Syntax, `guide.md` des Deck-Themes, der vollständige Deck-Text mit nummerierten Folien, das Briefing und die Cursor-Folie des Users. Decks sind klein genug, um sie komplett mitzugeben.

**Tools des Agents**

| Tool | Zweck |
| --- | --- |
| `replace_slide(index, content)` | Folie ersetzen |
| `insert_slides(after_index, contents[])` | Folien einfügen |
| `delete_slides(indexes)` | Folien löschen |
| `move_slide(from, to)` | Reihenfolge ändern |

Die Tools ändern nichts direkt, sondern sammeln Operationen in einem Proposal. Zu jeder betroffenen Folie wird ein Hash ihres Inhalts gespeichert.

**Folien erkennen:** Der Parser in `packages/shared` nutzt `@slidev/parser`, damit die Trennung exakt der von Slidev entspricht. Eine Folie ist Index + Inhalts-Hash, es gibt keine stabilen IDs.

**Proposal → Review → Anwenden**

1. Der Chat zeigt eine Karte mit Zusammenfassung, der Editor einen Diff an den betroffenen Folien.
2. „Übernehmen“: Deck neu parsen, Hashes vergleichen. Passen alle, werden die Operationen in einer Transaktion angewendet und die alten Folientexte im Proposal gespeichert. Passt einer nicht, ist das Proposal `stale` und der User kann es mit aktuellem Stand neu erzeugen lassen.
3. „Verwerfen“ setzt den Status, sonst passiert nichts.
4. „Rückgängig“ schreibt die gespeicherten alten Folientexte zurück, sofern die Folien seither unverändert sind.

**Direkt anwenden:** optional pro User, Default aus. Überspringt Schritt 1, Rückgängig bleibt verfügbar.

**Provider:** Base-URL, Modell und API-Key in den Admin-Einstellungen (Defaults per Env). Streaming an den Browser per Server-Sent Events. Prompts liegen als Dateien in `apps/server/src/llm/prompts/`.

## Neues Deck & Erstentwurf

Ein neues Deck startet leer mit einem Briefing. Das LLM schlägt eine Gliederung vor, der User passt sie an, dann schreibt das LLM die erste Version direkt ins Deck.

**1. Anlegen:** Dialog mit Titel und Startmodus: **Mit Assistent** (Default), **Starter** (`starter.md` des Themes) oder **Leer**.

**2. Briefing:** Solange das Deck leer ist, steht an Stelle der Preview ein Formular:

- Thema und Ziel (Pflicht)
- Zielgruppe, Sprache, Tonalität
- Umfang: Minuten oder Folienanzahl
- Notizen und Stichpunkte
- Dateien: MD, TXT, PDF (Text per `unpdf`), Bilder (gehen als Bild ans Modell, wenn es das kann)

Das Briefing wird pro Deck gespeichert und ist auch später Teil des Chat-Kontexts.

**3. Gliederung:** Erster LLM-Lauf liefert pro Folie Titel, Kernaussage und Layout. Die UI zeigt sie als editierbare Liste (umbenennen, löschen, verschieben, ergänzen) mit Feld für Anmerkungen.

**4. Erstversion:** Zweiter Lauf schreibt Folie für Folie samt Sprechernotizen. Weil das Deck leer ist, wird jede fertige Folie ohne Review per Transaktion angehängt; alle sehen das Deck wachsen. Jede Folie wird vorher validiert (YAML, nur Layouts aus `guide.md`), bei Fehlern korrigiert das LLM sie einmal, sonst bekommt sie einen Warnhinweis. Abbrechen behält fertige Folien, „Verwerfen“ leert das Deck. Am Ende Git-Commit „Erstentwurf (LLM)“.

**Akzeptanz:** Aus Thema, Zielgruppe und einem 10-seitigen PDF entsteht in unter 2 Minuten ein Deck mit der gewünschten Folienzahl (±1), nur Theme-Layouts, Sprechernotizen auf jeder Folie und fehlerfreier Preview.

## UI-Layout

```
┌───────────────────────────────────────────────────────────────────┐
│ Deck-Titel · Anwesende · Template v1.4 · Version speichern · Export │
├────────┬───────────────────────┬──────────────────────┬───────────┤
│ Folien │ Markdown-Editor       │ Live-Preview         │ Assistent │
│ 1      │ CodeMirror + Yjs,     │ folgt dem Cursor     │ Chat,     │
│ 2      │ Diff bei Proposals    │ (leeres Deck:        │ Proposal- │
│ …      │                       │  Briefing-Formular)  │ Karten    │
└────────┴───────────────────────┴──────────────────────┴───────────┘
```

**Weitere Screens:** Deck-Liste (Titel, zuletzt bearbeitet, Neues Deck), Deck-Einstellungen (Titel, Template-Version, Versionen wiederherstellen), Admin (Theme-Upload und Versionen, LLM-Einstellungen, laufende Previews).

## Auth & Rechte

- **SSO:** oauth2-proxy steht vor der App und den Preview-Subdomains (Cookie-Domain `.slides.intern`) und erledigt den OIDC-Login. Die App liest User und E-Mail aus den Headern, legt User beim ersten Request an und ist nur über den Proxy erreichbar.
- **Admins:** per Env `ADMIN_EMAILS`.
- **Rechte:** eine Funktion `can(user, deck, action)` mit `view`, `edit`, `manage`. Aufgerufen in der API-Middleware, in Hocuspocus `onAuthenticate`, im Preview-Proxy und beim Übernehmen von Proposals. In v1 gibt sie für eingeloggte User `true` zurück.
- **Rollen nachrüsten:** `can()` gegen `deck_members` prüfen und eine Mitglieder-UI bauen, etwa 1–2 Tage.

**Sicherheit:** Slidev-Markdown kann Vue-Code enthalten; die Slidev-Prozesse laufen unter eigenem Unix-User mit Schreibrecht nur aufs eigene Deck, für ein internes Tool ausreichend. Der LLM-Agent hat nur die vier Folien-Tools. Uploads werden nach Typ und Größe geprüft. Wohin Deck-Inhalte zum LLM gehen, legt der Admin über die Endpoint-Konfiguration fest.

## API

REST unter `/api`, Collab über `/collab` (WebSocket), LLM-Antworten per Server-Sent Events. Schemas als Zod in `packages/shared`.

| Methode | Pfad | Zweck |
| --- | --- | --- |
| GET | `/api/me` | aktueller User |
| GET / POST | `/api/decks` | Decks auflisten / anlegen (`{title, mode}`) |
| PATCH / DELETE | `/api/decks/:id` | umbenennen / archivieren |
| POST | `/api/decks/:id/preview` | Slidev-Instanz sicherstellen → `{url, status}` |
| GET / POST | `/api/decks/:id/versions` | Git-Historie / Version speichern |
| POST | `/api/decks/:id/restore` | Version wiederherstellen (`{sha}`) |
| POST | `/api/decks/:id/assets` | Bild-Upload |
| GET | `/api/decks/:id/export?format=pdf\|pptx` | Export, synchron als Download |
| POST | `/api/decks/:id/theme` | Template-Version setzen |
| GET / PUT | `/api/decks/:id/briefing` | Briefing lesen / speichern |
| POST | `/api/decks/:id/briefing/files` | Briefing-Datei hochladen |
| POST | `/api/decks/:id/llm/outline` | Gliederung erzeugen (SSE) |
| POST | `/api/decks/:id/llm/draft` | Erstversion erzeugen (SSE), mit Abbrechen |
| POST | `/api/decks/:id/llm/chat` | Chat-Nachricht (SSE), endet mit Proposal |
| POST | `/api/proposals/:id/apply` \| `/reject` \| `/undo` | Proposal anwenden, verwerfen, rückgängig |
| GET / POST | `/api/admin/themes` | Versionen / Upload |
| PUT | `/api/admin/themes/:version/default` | Default setzen |
| GET / PUT | `/api/admin/settings` | LLM-Einstellungen |

## Deployment

Ein VM-Host mit docker-compose und vier Containern:

| Container | Inhalt | Richtwert |
| --- | --- | --- |
| `caddy` | TLS, Wildcard `*.slides.intern` | klein |
| `oauth2-proxy` | OIDC-Login | klein |
| `app` | Node 22, App, Slidev-CLI, Playwright Chromium (Export) | 2–4 vCPU, 8 GB |
| `postgres` | Postgres 16 | 1 GB |

**Volumes:** `/data` und Postgres-Daten. Backup nächtlich: `pg_dump` + Archiv von `/data/decks`.

**Konfiguration** per `.env`: `PUBLIC_URL`, `PREVIEW_DOMAIN`, `OIDC_*` (für oauth2-proxy), `ADMIN_EMAILS`, `DATABASE_URL`, `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` (Defaults), `RUNNER_MAX_INSTANCES`, `RUNNER_IDLE_MINUTES`.

**CI/CD:** GitLab-Pipeline mit Lint, Typecheck, Unit- und E2E-Tests, Image bauen, Deploy per `docker compose pull && up -d`.

**Bewusst weggelassen, mit Auslöser:** Redis (erst bei mehreren App-Instanzen, dann Hocuspocus-Redis-Extension), Job-Queue (erst wenn Exporte oder Entwürfe die App spürbar blockieren), eigener Runner-Service (erst bei mehr als ca. 15 parallel offenen Decks).

## Meilensteine

Status: Offen · WIP · Review · Done · Blockiert

| # | Meilenstein | Inhalt | Akzeptanzkriterien | Status |
| --- | --- | --- | --- | --- |
| M1 | Co-Editing | Monorepo, CI, compose mit Caddy und oauth2-proxy, Postgres, Hocuspocus + CodeMirror, Disk-Sync, Deck-Liste und Anlegen | Login per SSO; zwei Browser editieren gleichzeitig; `slides.md` ist < 1 s aktuell; Neustart verliert nichts | Review |
| M2 | Preview, Template, Versionen | Runner, Preview-Proxy, Idle-Shutdown, Theme-Upload mit Smoke-Test, Template pro Deck, Git speichern und wiederherstellen, Bild-Upload, PDF/PPTX-Export | Preview < 2 s nach Tippen; hochgeladenes Theme wird von neuen Decks genutzt; Wiederherstellen ist bei allen live sichtbar; PDF eines 30-Folien-Decks < 60 s | Review |
| M3 | LLM | Parser, Admin-Einstellungen, Briefing, Gliederung, Erstversion, Chat mit Proposals, Diff, Übernehmen / Stale / Rückgängig, Direkt-anwenden-Option, kleine Eval-Suite | Akzeptanz aus „Neues Deck & Erstentwurf“; parallele Änderung macht Proposal `stale`; Rückgängig stellt den alten Stand her | Review |
| M4 | Pilot | Fehleranzeigen, Backups, README, Pilot mit 3–5 Personen | Backup-Restore auf frischem Host getestet; Pilot-Feedback eingearbeitet | WIP |
| – | Nach v1 | Rollen-UI, Inline-Befehle, MCP-Endpoint, GitLab-Mirror, Kommentare, Thumbnails | je Feature | Offen |

## Risiken & Entscheidungen

| Risiko | Gegenmaßnahme |
| --- | --- |
| RAM-Bedarf vieler Slidev-Dev-Server | Instanz-Limit, Idle-Shutdown, gemeinsame `node_modules`; früh mit 15 Decks messen |
| Halb getipptes Markdown bricht die Preview | Debounce, Warnung in der Statusleiste statt Fehler-Overlay |
| Parser weicht von Slidev ab | `@slidev/parser` verwenden, Fixtures mit `---` in Code-Blöcken |
| LLM erfindet Layouts | `guide.md` im Kontext, Validierung vor Anzeige, Eval-Suite |
| Slidev-Breaking-Changes | Slidev-Version im Theme-Paket pinnen |
| Ein Prozess = ein Ausfallpunkt | für ein internes Tool akzeptabel; Restart-Policy, Yjs-State in Postgres, Backups |

| Frage | Entscheidung |
| --- | --- |
| Backend | Ein Node/TS-Service, kein Django |
| LLM-Provider | Frei konfigurierbar, Voraussetzung OpenAI-kompatible API |
| Hosting | VM mit docker-compose |
| Theme | Upload durch Admins, keine Registry, kein Formular für Variablen |
| SSO / Rollen | oauth2-proxy; Rollen über `can()` vorbereitet, Ausbau nach v1 |
| „Direkt anwenden“ | optional pro User, Default aus |
| PPTX | bildbasierter Slidev-Export reicht |
| GitLab-Mirror | optional, nach v1 |
| Export | PDF/PPTX über Slidevs Browser-Exporter in der Preview; kein serverseitiger Export, kein Chromium im Image |
| Folie 1 | enthält das Headmatter; der Assistent darf sie ersetzen, aber nicht löschen oder verschieben |
| Preview-Caches | jedes Deck hat ein eigenes `node_modules` mit Links in die Template-Laufzeit; Vite- und Slidev-Caches liegen pro Deck |

## Hinweise für den Coding-Agent

- Meilenstein für Meilenstein arbeiten; jeder endet mit grüner CI, aktualisiertem Status oben und einer Demo-Anleitung im README.
- Vor dem Coden die aktuelle Doku von Hocuspocus, `y-codemirror.next`, Slidev und dem `openai`-SDK lesen; Versionen pinnen.
- Den Folien-Parser test-first bauen (Code-Blöcke mit `---`, Frontmatter pro Folie, Notizen, leere Folien).
- LLM-Tests gegen einen Mock mit aufgezeichneten Antworten; echte Modell-Calls nur in der Eval-Suite.
- E2E-Test: zwei Playwright-Kontexte tippen gleichzeitig, danach identischer Text in beiden und auf Disk.
- Keine eigene Sync-Logik; jede serverseitige Inhaltsänderung über `openDirectConnection` und eine Transaktion.
- Keine neue Infrastruktur ohne konkreten Anlass; falls doch, im Merge Request begründen.
- Geheimnisse nur über Env oder Admin-Einstellungen, nie im Repo.
