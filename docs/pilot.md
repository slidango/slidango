# Pilot (M4)

Ziel: drei bis fünf Personen nutzen Slidango zwei Wochen lang für echte Präsentationen. Danach Feedback einarbeiten und über den Regelbetrieb entscheiden.

## Vorher

- [ ] Produktion nach README aufsetzen (Caddy, oauth2-proxy, Wildcard-Zertifikat, `.env`).
- [ ] Login mit zwei verschiedenen SSO-Konten prüfen; ein manipulierter Header `X-Auth-Request-Email` ohne Login muss zur Anmeldung umleiten.
- [ ] Firmen-Template hochladen (siehe `docs/template.md`), Smoke-Test grün, als Default setzen.
- [ ] LLM-Endpoint eintragen und `pnpm --filter @slidango/server eval` gegen das echte Modell laufen lassen.
- [ ] `deploy/backup.sh` per Cron einrichten; einmal `deploy/restore.sh` auf einem frischen Host durchspielen.
- [ ] Mit 15 gleichzeitig offenen Decks den RAM messen (Admin → Laufende Previews, `docker stats`).

## Aufgaben für die Pilotgruppe

1. Ein Deck gemeinsam zu zweit bearbeiten, gleichzeitig.
2. Ein Deck mit dem Assistenten aus einem Briefing (inkl. PDF) erstellen und nachbearbeiten.
3. Mindestens drei Änderungen per Chat anfordern; einen Vorschlag übernehmen, einen verwerfen, einen rückgängig machen.
4. Eine Version speichern und wiederherstellen.
5. Das Deck aus der Preview als PDF exportieren und präsentieren.

## Feedback-Fragen

- Wofür hast du das Tool genutzt, wofür nicht – und warum?
- Wo bist du hängen geblieben? (Screenshot, Deck, ungefähre Uhrzeit)
- Wie gut waren Gliederung, Erstentwurf und Chat-Vorschläge? Was hast du am häufigsten nachgebessert?
- War die Preview schnell genug? Gab es Abstürze oder weiße Flächen?
- Fehlt etwas, das du sonst in PowerPoint/Google Slides machst?

## Danach

- Fehlerberichte und Wünsche als Issues erfassen, nach Häufigkeit priorisieren.
- Status M4 im Plan auf „Done“ setzen, wenn Backup-Restore auf frischem Host getestet und das Feedback eingearbeitet ist.
