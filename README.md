# Zwei Heimaten in Zahlen 🏔️📊

**München ↔ Südtirol:** Eine interaktive Datengeschichte über den Tourismus der
beiden Heimaten – Übernachtungen und Ankünfte im Langzeitvergleich, der
Oktoberfest-Gipfel gegen die alpine Doppelsaison, der Corona-Einbruch und zwei
verschiedene Erholungen, Gästeherkunft und Aufenthaltsdauer. Visualisiert mit
[D3.js](https://d3js.org).

**Live-Seite:** <https://mueller-andreas.github.io/muenchen-bozen/>

## Datenquellen

| | München | Südtirol |
|---|---|---|
| Datensatz | [„Monatszahlen Tourismus“](https://opendata.muenchen.de/dataset/monatszahlen-tourismus) | Tourismus-Datensatz (ASTAT), wird beim Laden über die CKAN-Suche des Portals ermittelt |
| Portal | [Open Data Portal München](https://opendata.muenchen.de) | [Open Data Portal Südtirol](https://data.civis.bz.it) |
| Herausgeber | Statistisches Amt der Landeshauptstadt München | Landesinstitut für Statistik ASTAT, Autonome Provinz Bozen – Südtirol |
| Granularität | monatlich (Gäste & Übernachtungen, Inland/Ausland), ab ca. 2000 | je nach Datensatz monatlich oder jährlich – die Seite degradiert kapitelweise |
| Lizenz | siehe Datensatzseite (wird zusätzlich live aus den Portal-Metadaten angezeigt) | siehe Datensatzseite (dito) |

Die Seite lädt die Daten **beim Aufruf direkt im Browser** von beiden Portalen –
je Quelle über die Kette CKAN-`package_show` → Original-CSV → Daten-Snapshot →
Datastore-API → JSONP → CORS-Proxy. Es findet keine serverseitige Verarbeitung
statt. Jede geladene Quelle wird gegen das erwartete Schema validiert
(keyword-basierte, zweisprachige Spaltenerkennung); liefert die Südtiroler
Quelle z.&nbsp;B. nur Jahres- statt Monatswerte, weisen die betroffenen Kapitel
das aus und zeigen den möglichen Teil.

### Daten-Snapshots

Falls ein Portal nicht erreichbar ist (oder keine CORS-Header liefert), fällt
die Seite auf die Snapshots in [`data/`](data/) zurück – Details und
Update-Anleitung in [`data/README.md`](data/README.md).

## Veröffentlichung (GitHub Pages)

Der Workflow [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)
deployt bei jedem Push auf `main` über die offiziellen Pages-Actions
(`configure-pages` → `upload-pages-artifact` → `deploy-pages`); ein Build-Schritt
ist nicht nötig. `enablement: true` aktiviert Pages beim ersten Lauf automatisch.

Falls die Aktivierung fehlschlägt, einmalig manuell:
Repo-Einstellungen → **Pages** → Source: **GitHub Actions**.

## Lokal ansehen

```bash
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

## Tests

```bash
node --check assets/js/parse.js assets/js/app.js
node --test test/smoke.test.mjs
```

Die Smoke-Tests prüfen die Datenschicht (`assets/js/parse.js`) gegen
synthetische Fixtures beider Portal-Schemata; liegen echte Snapshots in
`data/`, werden auch diese validiert.

## Technik

- Statische Seite ohne Build-Schritt (HTML + CSS + Vanilla JS)
- [D3.js v7](https://d3js.org) (ISC-Lizenz), lokal eingebunden unter `assets/vendor/`
- Datenschicht `parse.js` ist DOM- und D3-frei und läuft identisch in Browser und Node
- Robustes Parsen: Trennzeichen-Erkennung, deutsche Zahlenformate,
  Windows-1252-Fallback, zweisprachige (de/it) Spalten- und Begriffserkennung,
  Plausibilitäts-Validierung je Quelle
- Responsiv (mobile-first), `prefers-reduced-motion` wird respektiert

## Hinweis

Dieses Projekt ist ein unabhängiges Open-Data-Projekt und steht in keiner
Verbindung zur Landeshauptstadt München, zur Autonomen Provinz Bozen – Südtirol,
zu ASTAT oder zu IDM Südtirol. Verglichen wird die **Stadt** München mit dem
**Land** Südtirol – es geht um die unterschiedlichen Muster von Städte- und
Ferientourismus, nicht um eine Rangliste.

Ein Schwesterprojekt erzählt die Geschichte der
[Messe München in Zahlen](https://mueller-andreas.github.io/messe-muenchen/).
