# Plan: Accounts, Deck-Rechte, API-Tokens und MCP-Server

Stand: 2026-11-19 · Status: **umgesetzt** (A–D), Entscheidungen 1–6 nach Empfehlung (siehe unten)

## Ziel

Slidango soll von außen ansprechbar werden: Claude Code, Claude Desktop, Cursor oder eigene Skripte lesen Decks und schreiben über einen MCP-Server mit, als weitere Stimme im selben `slides.md`. Dafür braucht jeder Zugriff eine verlässliche Identität und Rechte. Heute fehlt beides. Deshalb kommen vier Bausteine in fester Reihenfolge:

| Phase | Baustein | Warum vorher |
| --- | --- | --- |
| A | Echte Einzel-Accounts und Nutzerverwaltung | Ohne verlässliche Identität kann sich jeder ein Token für eine fremde E-Mail ausstellen. |
| B | Rechte pro Deck | Ein Token soll nur das können, was sein Besitzer darf, und nicht pauschal alles. |
| C | Persönliche API-Tokens | MCP-Clients können weder SSO-Header noch Cookies. |
| D | MCP-Server | Nutzt A–C, dazu die vorhandenen Folien-Werkzeuge und Vorschläge. |

## Ausgangslage (Code-Stand heute)

- **Identität:** `identityFromHeaders()` in `apps/server/src/auth.ts`.
  - `oidc`: Die E-Mail und der Name kommen aus den `X-Auth-Request-*`-Headern (oauth2-proxy über Caddy `forward_auth`). Admin ist, wer in `ADMIN_EMAILS` steht.
  - `password`: Es gibt ein gemeinsames Passwort. Name und E-Mail tippt jede Person selbst ein, und mit `AUTH_ADMIN_PASSWORD` wird man Admin. Die Sitzung ist ein HMAC-Cookie ohne Server-Zustand.
- **Users-Tabelle:** `Users.fromHeaders()` macht bei jedem Request einen Upsert über die E-Mail und überschreibt dabei Name und `isAdmin`. Es gibt keinen Status, keine Sperre und keine Liste in der UI.
- **Rechte:** `can()` in `auth.ts` gibt `user !== null` zurück. Die Aufrufe sind aber schon überall nach `view`, `edit` und `manage` unterschieden (REST über `loadDeck()`, Hocuspocus in `onAuthenticate` mit `readOnly`, Preview-Proxy). Die Tabelle `deck_members` (owner/editor/viewer) existiert, wird aber nicht benutzt.
- **Schwachstelle im Passwort-Modus:** Wer das Passwort kennt und eine fremde E-Mail eintippt, wird zu diesem Datensatz. Er sieht dann z. B. dessen Slidango-AI-Verlauf, den die UI als „Only you can see this history“ beschreibt.
- **Bausteine für MCP:** Die Folien-Werkzeuge (`replace_slide`, `insert_slides`, `delete_slides`, `move_slide`) sind vorhanden, ebenso die Prüfung mit `validateSlide()`/`applyOps()` und der Schutz von Folie 1. Vorschläge (`proposals`) haben eine Hash-Prüfung und Undo und hängen an `createdBy`, nicht an einer Chat-Session. Schreibzugriffe gehen über Yjs (`collab.replaceContent`).

---

## Phase A · Einzel-Accounts und Nutzerverwaltung

### A1 · Login-Modi

- **`oidc` bleibt, wie er ist.** Die Identität liefert der IdP, die App verwaltet zusätzlich Status und Admin-Rechte.
- **`password` wird zu `local`: ein Account pro Person.** Das gemeinsame Passwort entfällt.
  - **Einladung statt Registrierung:** Ein Admin lädt per E-Mail-Adresse ein und bekommt einen Einmal-Link (`/invite/<token>`, 7 Tage gültig). Den Link gibt der Admin selbst weiter. **Es braucht keinen Mailserver.** Wer ihn öffnet, setzt Namen und Passwort.
  - **Passwort-Hash:** `scrypt` aus `node:crypto`, ohne zusätzliche Abhängigkeit, mit Parametern im gespeicherten String, damit sie später angehoben werden können.
  - **Passwort vergessen:** Der Admin erzeugt einen Reset-Link, nach demselben Mechanismus wie die Einladung. Ein Self-Service per Mail kommt erst, wenn es SMTP gibt (siehe offene Entscheidungen).
  - Die Sperre nach Fehlversuchen (`LoginLimiter`) bleibt, sie zählt künftig pro E-Mail **und** pro Client.
- **Erster Admin:**
  - Ist beim Start kein Admin in der Datenbank und `ADMIN_EMAILS` gesetzt, schreibt der Server einmalig einen Einladungslink für diese Adresse ins Log.
  - Alternativ gibt es ein CLI-Kommando `pnpm --filter @slidango/server admin:invite <email>`, das im Container per `docker compose exec app …` läuft.
- **`DEV_USER_EMAIL`** bleibt für die lokale Entwicklung unverändert.

### A2 · Sitzungen

- Das Cookie bleibt HMAC-signiert und ohne Server-Zustand, enthält aber künftig `userId` und `sessionVersion` statt Name, E-Mail und Admin-Flag.
- `users.session_version` wird bei Passwortwechsel, Sperre und „überall abmelden“ hochgezählt. Ältere Cookies sind dann ungültig.
- Den Schlüssel für die Signatur liefert nur noch `AUTH_SECRET`. Er hängt nicht mehr an einem Passwort.

### A3 · Datenmodell (Migration)

```
users              + password_hash text null      -- nur local
                   + status text 'active'|'disabled' default 'active'
                   + session_version int default 0
                   + last_seen_at timestamptz null
invites            id, email, token_hash, purpose 'invite'|'reset',
                   created_by → users, expires_at, used_at
```

- **Admin-Rechte:** `isAdmin` wird nicht mehr bei jedem Request überschrieben. Die Datenbank ist die Quelle der Wahrheit. `ADMIN_EMAILS` **befördert** beim Login, entzieht aber nie Rechte.
- **Bestehende Instanzen im Passwort-Modus:** Die User-Datensätze bleiben erhalten, weil die E-Mail der Schlüssel ist. Der Admin verschickt für jede bekannte Adresse einen Einladungslink. Wer ihn nutzt, behält seine Decks und seinen Verlauf. Für die Übergangszeit kann man den alten Modus über `AUTH_MODE=password` noch eine Version lang mit Warnung im Log laufen lassen.

### A4 · Nutzerverwaltung in der UI

Neuer Tab **Settings → People** (nur für Admins):

| Spalte / Aktion | `local` | `oidc` |
| --- | --- | --- |
| Name, E-Mail, zuletzt aktiv, Rolle, Status | ✓ | ✓ |
| Einladen (Link kopieren) | ✓ | – (der IdP entscheidet) |
| Reset-Link erzeugen | ✓ | – |
| Sperren / entsperren | ✓ | ✓ |
| Admin ja/nein | ✓ | ✓ |
| Überall abmelden | ✓ | ✓ |

- **Gesperrte Nutzer:** `Users.fromHeaders()` liefert für sie `null`. REST antwortet mit 401, laufende Collab-Verbindungen werden geschlossen und neue abgewiesen.
- **Optional für `oidc`:** Mit `ALLOWED_EMAIL_DOMAINS` lässt sich einschränken, wer sich überhaupt anmelden darf. Sonst kann jeder mit einem Konto beim IdP rein.
- **Eigenes Konto:** Im Account-Menü stehen Name ändern (`local`), Passwort ändern (`local`), API-Tokens (Phase C) und Abmelden.

---

## Phase B · Rechte pro Deck

### B1 · Modell

Jedes Deck bekommt eine Grund-Sichtbarkeit und optional Mitglieder mit Rolle:

```
decks         + access text 'team-edit' | 'team-view' | 'members'  default 'team-edit'
deck_members  (vorhanden) deck_id, user_id, role 'owner'|'editor'|'viewer'
```

- **`team-edit`:** Jeder angemeldete Nutzer darf das Deck sehen und bearbeiten. Das entspricht dem heutigen Verhalten und ist deshalb der Default, damit sich für bestehende Instanzen nichts ändert.
- **`team-view`:** Alle dürfen das Deck sehen, bearbeiten dürfen nur Mitglieder mit Rolle `editor` oder `owner`.
- **`members`:** Nur Mitglieder sehen das Deck überhaupt.

### B2 · `can(user, deck, action)`

```
admin                         → alles
role owner                    → view, edit, manage
role editor                   → view, edit
role viewer                   → view
sonst nach deck.access:
  team-edit  → view, edit
  team-view  → view
  members    → nichts
```

- **Was die Aktionen umfassen:**
  - `view`: Deck, Vorschau, Präsentation, Versionsliste, eigener AI-Verlauf lesen.
  - `edit`: tippen, Version speichern, wiederherstellen, Bilder, Briefing, Slidango AI fragen, Vorschläge anwenden.
  - `manage`: umbenennen, archivieren, Template wechseln, teilen, Sichtbarkeit ändern.
- **Deck-Liste:** `decks.list()` filtert über einen Join auf `deck_members` plus `access`. Ein Deck, das man nicht sehen darf, beantwortet die API mit 404, nicht mit 403, damit seine Existenz nicht verraten wird. So handhabt es der Preview-Proxy schon heute.
- **Collab und Preview:** Die vorhandenen Aufrufe von `can()` greifen automatisch. Viewer bekommen `readOnly` und sehen die Vorschau.
- **Rechte im Speicher halten:** Für die Collab-Verbindung werden die Rechte beim Verbinden geprüft. Ändert jemand sie während einer laufenden Sitzung, schließt der Server die betroffenen Verbindungen. Sie bauen sich danach mit den neuen Rechten wieder auf.

### B3 · Migration

- Für jedes Deck wird `deck_members(deck_id, owner_id, 'owner')` aus `decks.owner_id` nachgetragen.
- Alle bestehenden Decks bekommen `access = 'team-edit'`.

### B4 · UI

- **Share-Dialog** im Editor (⋯ → Share, für `manage`):
  - Sichtbarkeit mit drei Optionen, jeweils mit einem Satz Erklärung.
  - Mitglieder hinzufügen (Suche über bekannte Nutzer), Rolle ändern, entfernen.
  - Den Owner übertragen.
- **Deck-Liste:** Ein Badge zeigt `members` oder `team-view`. Neue Decks sind standardmäßig `team-edit`. Optional legt eine Instanz-Einstellung den Default fest.
- **Archivieren:** Wer kein `manage` hat, sieht die Aktion nicht.

---

## Phase C · Persönliche API-Tokens

### C1 · Modell

```
api_tokens  id, user_id → users (cascade), name, prefix, token_hash,
            scope 'read'|'write', created_at, last_used_at, expires_at null, revoked_at null
```

- **Format:** `sld_` + 32 zufällige Bytes in base64url. In der Datenbank liegt nur der SHA-256-Hash. Die ersten 8 Zeichen (`prefix`) werden zur Wiedererkennung angezeigt. Das Token wird nur ein einziges Mal angezeigt.
- **Rechte:** Ein Token kann **nie mehr als sein Besitzer**. `read` beschränkt zusätzlich auf `view`. Ist der Besitzer gesperrt oder hat er Rechte verloren, gilt das sofort auch für seine Tokens.
- **Admin-Rechte bekommt ein Token nie.** `/api/admin/*` lehnt Tokens grundsätzlich ab.

### C2 · Auth-Pfad

- `identityFromHeaders()` prüft zuerst `Authorization: Bearer sld_…`, danach Cookie bzw. Header wie bisher.
- `last_used_at` wird höchstens einmal pro Minute geschrieben.
- **Rate-Limit pro Token**, z. B. 60 Schreibaufrufe pro Minute.
- **Caddy im OIDC-Modus:** Für `/mcp*` und `/api/*` mit Bearer-Header wird `forward_auth` übersprungen. Die `X-Auth-Request-*`-Header werden trotzdem zuerst entfernt, sodass die App solche Requests nur über das Token authentifiziert:

```caddy
@token {
	path /mcp* /api/*
	header Authorization "Bearer sld_*"
}
route @token {
	request_header -X-Auth-Request-User
	request_header -X-Auth-Request-Email
	request_header -X-Auth-Request-Preferred-Username
	reverse_proxy app:3000
}
```

### C3 · UI

- **Account-Menü → API tokens:** Liste mit Name, Prefix, Scope, zuletzt benutzt und Ablauf. Daneben „New token“ (Name, Scope, Ablauf: 30/90 Tage oder nie) und „Revoke“.
- Nach dem Erzeugen zeigt die UI das Token einmalig an, dazu fertige Snippets für Claude Code und Claude Desktop (siehe D5).
- **Settings → People** zeigt pro Nutzer, wie viele Tokens aktiv sind, und hat „Revoke all“.

---

## Phase D · MCP-Server

### D1 · Technik

- Das offizielle TypeScript-SDK `@modelcontextprotocol/sdk` in fester Version, mit Transport **Streamable HTTP** und Endpoint `POST /mcp` im bestehenden Fastify-Server.
- **Stateless:** Jeder Aufruf wird über sein Bearer-Token authentifiziert. Es braucht keine Session-Verwaltung und keine weitere Instanz.
- Ein stdio-Wrapper für lokale Clients entfällt, weil Claude Code und Claude Desktop HTTP-Server direkt einbinden können.

### D2 · Tools

| Tool | Scope | Recht | Inhalt |
| --- | --- | --- | --- |
| `list_decks` | read | view | Titel, ID, Template, zuletzt bearbeitet, Rolle |
| `read_deck` | read | view | alle Folien mit Nummer, Titel, Layout und Markdown, dazu Base-Hashes für spätere Änderungen |
| `get_template_guide` | read | view | erlaubte Layouts und `guide.md` des Templates |
| `propose_changes` | write | edit | Liste aus `replace`/`insert`/`delete`/`move` und eine kurze Zusammenfassung; erzeugt einen Vorschlag |
| `apply_proposal` / `undo_proposal` | write | edit | nur für eigene Vorschläge, nur wenn der Besitzer `autoApply` erlaubt |
| `save_version` | write | edit | Version mit Nachricht speichern |
| `create_deck` | write | – | neues Deck, leer oder als Starter-Deck |

- Alle Tools nutzen dieselben Prüfungen wie Slidango AI: `validateSlide`, `applyOps`, Folie-1-Schutz, Hash-Prüfung. Fehlertexte gehen als Tool-Ergebnis zurück, damit der Client sich korrigieren kann.
- **Standard ist „nur vorschlagen“.** Der Mensch klickt im Editor auf Apply. Direkt anwenden geht nur, wenn der Token-Besitzer „Apply directly“ eingeschaltet hat. Undo ist immer möglich.

### D3 · Vorschläge von außen

- `proposals` bekommt `source text 'assistant'|'mcp'` und `client text null` (Token-Name, z. B. „Claude Code“).
- **Anzeige:** Die Vorschläge erscheinen wie heute farbig im Editor und mit Punkt in der Folienliste. Zusätzlich gibt es eine Karte im Slidango-AI-Panel: „Claude Code (via Gabriel) suggested changes to slide 3“.
- **Farbe:** Teal bleibt für KI reserviert, also bekommen auch MCP-Vorschläge Teal.

### D4 · Präsenz

- Während ein MCP-Client arbeitet, setzt der Server für das Deck einen Eintrag in der Yjs-Awareness: Name `Claude Code · Gabriel`, Farbe `cursor-ai`, Cursor auf der zuletzt berührten Folie. Der Eintrag verschwindet nach 30 Sekunden ohne Aufruf.
- So wird der externe Agent sichtbar „eine Stimme unter mehreren“.

### D5 · Einrichtung (für die Doku)

```bash
# Claude Code
claude mcp add --transport http slidango https://slides.example.com/mcp \
  --header "Authorization: Bearer sld_…"
```

Für Claude Desktop und andere Clients kommt ein entsprechender JSON-Block in die Doku, und die UI zeigt ihn nach dem Erzeugen eines Tokens an.

### D6 · Später, nicht in dieser Runde

- **OAuth 2.1 nach der MCP-Autorisierungs-Spezifikation:** Anmeldung im Browser statt Token-Kopieren. Lohnt sich erst, wenn viele Nutzer MCP verwenden.
- **Resources und Prompts:** Decks als MCP-Resources, vorgefertigte Prompts wie „Shorten slide“.
- **Öffentliche Präsentationslinks** ohne Login.

---

## Sicherheit

- Tokens werden nur gehasht gespeichert, nur einmal angezeigt, sind widerrufbar, optional mit Ablauf, und haben nie Admin-Rechte.
- Jeder Request prüft frisch, ob der Besitzer aktiv ist und welche Rechte er hat. Nichts davon wird im Token selbst festgeschrieben.
- **Prompt-Injection:** Deck-Inhalte können Anweisungen an den externen Agenten enthalten. Das Risiko trägt der Client. Slidango begrenzt den Schaden durch „nur vorschlagen“ als Standard, Undo und die Versionen.
- Slidevs eigener `/__mcp`-Endpoint bleibt blockiert (`preview.ts`).
- Die Caddy-Regel für Tokens entfernt Identitäts-Header, bevor sie zur App gehen. Dafür kommt ein Test dazu.
- Ein Audit-Log ist optional, aber günstig: `last_used_at` am Token, `createdBy`/`source` am Vorschlag, Autor am Git-Commit.

## Tests

- **Unit:**
  - `can()`: Rollen-Matrix × Sichtbarkeit × Admin × gesperrt.
  - Tokens: Hashing, Scope, Ablauf, Widerruf, gesperrter Besitzer.
  - Sitzungen: `sessionVersion`.
  - Einladungen: Ablauf, Einmal-Nutzung.
- **Integration:**
  - Deck-Liste gefiltert nach Rechten.
  - 404 statt 403 für unsichtbare Decks.
  - Collab `readOnly` für Viewer.
  - Rechte ändern schließt laufende Verbindungen.
- **MCP:**
  - Mit dem SDK-Client in Vitest gegen den echten Server: alle Tools, Fehlerfälle (falsches Layout, Folie 1, veralteter Hash, fehlende Rechte, `read`-Token schreibt).
- **E2E:**
  - Einladung annehmen und anmelden.
  - Share-Dialog: Deck auf `members` stellen, ein zweiter Nutzer sieht es nicht mehr.
  - Token erzeugen, MCP-Vorschlag erscheint im Editor, Apply.

## Reihenfolge und Aufwand

| Schritt | Inhalt | Aufwand (grob) |
| --- | --- | --- |
| A | `local`-Accounts, Einladungen, Sitzungen, People-Tab, Migration | 2–3 Tage |
| B | `can()`, Sichtbarkeit, Share-Dialog, gefilterte Liste | 1,5–2 Tage |
| C | Tokens, Bearer-Auth, Caddy-Regel, Token-UI | 1 Tag |
| D | MCP-Endpoint, Tools, `source` an Vorschlägen, Präsenz, Doku | 1,5–2 Tage |
| | **Gesamt** | **ca. 6–8 Tage** |

Jede Phase lässt sich einzeln ausliefern und hat eigene Tests. C und D gehen technisch auch ohne B, dann aber mit „Token kann alles, was jeder Nutzer kann“.

## Entscheidungen (getroffen 2026-11-19, jeweils Empfehlung)

1. **Passwort-Modus:** ganz durch Einzel-Accounts ersetzen (Empfehlung) oder als einfachsten Modus für Einzelnutzer behalten?
2. **Mail:** Einladungen und Resets vorerst nur als Link zum Kopieren (Empfehlung) oder gleich SMTP einbauen?
3. **Default-Sichtbarkeit neuer Decks:** `team-edit` wie heute (Empfehlung) oder `members`?
4. **Admins und Decks:** Sollen Admins jedes Deck sehen, auch `members`-Decks? Empfehlung: ja, mit Hinweis in der UI.
5. **MCP-Schreibmodus:** nur Vorschläge (Empfehlung) oder direktes Anwenden auch ohne `autoApply` des Besitzers?
6. **Reihenfolge:** A → B → C → D (Empfehlung) oder C/D vorziehen und die Rechte nachziehen?

## Umsetzung (2026-11-19)

Alle Phasen umgesetzt, Entscheidungen 1–6 jeweils wie empfohlen. Abweichungen und Details gegenüber dem Plan:

- **A:** `AUTH_MODE=local` ersetzt den Passwort-Modus; `AUTH_MODE=password` bleibt als Alias mit Warnung im Log (`config.warnings`). Bootstrap über `ADMIN_EMAILS` (Setup-Link im Log) und `src/cli.ts invite <email>`. Login-Sperre zählt pro Client und pro E-Mail. „Sign out everywhere“ für sich selbst unter Account, für andere unter People.
- **B:** Umbenennen ist jetzt `manage` (vorher `edit`). Rechteänderungen trennen die Collab-Verbindungen des Decks; die Clients verbinden sich neu und werden neu geprüft. Viewer bekommen einen schreibgeschützten Editor (Cursor und Vorschau-Folgen funktionieren weiter).
- **C:** Tokens sind auf `/api/auth`, `/api/me/tokens`, `/api/me/password`, `/api/admin` und `/collab` gesperrt. Rate-Limit 120 Requests pro Token und Minute (im Speicher, pro Instanz).
- **D:** MCP-SDK `@modelcontextprotocol/sdk@1.32.2`, zustandslos (`POST /mcp`, JSON-Antworten). Vorschläge von MCP-Clients erscheinen bei ihrer Person im Slidango-AI-Panel (Karte mit Client-Name) und farbig im Editor. Präsenz als Server-Awareness-Eintrag (`<Token-Name> · <Person>`, Teal, 30 s). `apply_proposal` nur bei „Apply directly“ der Person.
- **Tests:** `auth.test.ts` (Accounts, Einladungen, Sitzungen, People, OIDC), `access.test.ts` (Rechte-Matrix, Teilen, Tokens, MCP mit echtem SDK-Client), E2E `sharing.spec.ts` (Members-only + Viewer, Token → MCP-Vorschlag → Apply). Caddy-Konfiguration für `oidc`, `local` und `password` mit `caddy validate` geprüft (Wegwerf-Zertifikate); das Token-Routing selbst nur per Syntaxprüfung, nicht gegen einen echten oauth2-proxy.
- **Offen:** Migration bestehender Instanzen im alten Passwort-Modus braucht Einladungslinks pro Person (Datensätze bleiben, weil die E-Mail der Schlüssel ist). OAuth für MCP, Mailversand und öffentliche Präsentationslinks wie geplant später.
