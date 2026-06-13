# Daten-Snapshots

Die Seite lädt die Daten beim Aufruf **live** von den beiden Open-Data-Portalen.
Die Dateien in diesem Ordner sind Ausweich-Snapshots, falls ein Portal nicht
erreichbar ist oder keine CORS-Header liefert.

| Datei | Quelle | Herausgeber |
|---|---|---|
| `muenchen-tourismus.csv` | [„Monatszahlen Tourismus“](https://opendata.muenchen.de/dataset/monatszahlen-tourismus) | Statistisches Amt der Landeshauptstadt München |
| `suedtirol-tourismus.csv` | Tourismus-Datensatz auf [data.civis.bz.it](https://data.civis.bz.it/de/dataset?q=tourismus) | Landesinstitut für Statistik (ASTAT), Autonome Provinz Bozen – Südtirol |

Lizenz: jeweils gemäß den Angaben auf der Datensatzseite des Portals.

## Status

**Die Snapshots fehlen noch.** Sie konnten aus der Entwicklungsumgebung heraus
nicht heruntergeladen werden (Netz-Allowlist); die Seite funktioniert trotzdem,
weil sie die Daten live im Browser lädt. Sobald die Snapshots vorliegen,
laufen auch die beiden Snapshot-Tests in `test/smoke.test.mjs` mit (sie werden
bis dahin übersprungen).

## Aktualisieren / Nachrüsten

1. **München:** Auf der [Datensatzseite](https://opendata.muenchen.de/dataset/monatszahlen-tourismus)
   die jüngste CSV-Ressource (`monatszahlenJJMM_tourismus.csv`) herunterladen
   und hier als `muenchen-tourismus.csv` ablegen.
2. **Südtirol:** Auf [data.civis.bz.it](https://data.civis.bz.it/de/dataset?q=tourismus)
   den Tourismus-Datensatz mit Ankünften/Übernachtungen öffnen, die
   CSV-Ressource herunterladen und hier als `suedtirol-tourismus.csv` ablegen.
   (Liegt die Ressource nur als XLSX vor, einmalig als CSV exportieren und das
   hier vermerken.)
3. Prüfen: `node --test test/smoke.test.mjs` im Projektordner – die beiden
   Snapshot-Tests validieren Schema und Plausibilität.
