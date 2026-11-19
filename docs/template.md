# Template-Paket

Ein Template ist ein Slidev-Theme als `.zip` oder `.tgz` (max. 50 MB), z. B. erzeugt mit `npm pack`. Admins laden es unter *Einstellungen → Templates* (Zahnrad in der Übersicht) mit Version und Changelog hoch.

```
package.json   Pflicht: name, version. Optional @slidev/cli als Abhängigkeit (Slidev-Version pinnen)
guide.md       Pflicht: Leitfaden für Menschen und den Assistenten
starter.md     Optional: Startdeck für den Modus „Starter“
layouts/       Vue-Layouts (Dateiname = Layout-Name)
components/    Vue-Komponenten
styles/        CSS/UnoCSS
public/        Logos, Schriften, Bilder
```

`package.json` (Beispiel):

```json
{
  "name": "slidev-theme-acme",
  "version": "1.4.0",
  "keywords": ["slidev-theme", "slidev"],
  "dependencies": { "@slidev/cli": "53.0.0" }
}
```

`guide.md` geht bei jeder Assistenten-Anfrage als Kontext mit. Gut ist pro Layout: Zweck, Slots, ein kurzes Beispiel.

````md
## Layouts

### acme-cover
Titelfolie. Titel als `#`, Untertitel als Absatz.

```md
---
layout: acme-cover
---

# Quartalsbericht Q4
Vertrieb Österreich
```
````

Ablauf nach dem Upload:

1. Prüfen: `package.json` mit Name und Version, `guide.md` vorhanden, Version noch nicht vergeben, keine Pfade außerhalb des Pakets.
2. Installieren: `pnpm install --prod --ignore-scripts` in eine eigene Laufzeit je Version (`/data/themes/<version>/runtime`).
3. Smoke-Test: `slidev build` mit `starter.md` (oder einer Minimalfolie).
4. Erst bei Erfolg Status „Bereit“; sonst „Fehlgeschlagen“ mit Log.

Der Assistent akzeptiert nur Layouts aus `layouts/` des Templates und Slidevs eingebaute Layouts.
