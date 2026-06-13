/* ==========================================================================
   Smoke-Tests der Datenschicht (parse.js) — laufen mit `node --test test/`.

   Getestet wird gegen synthetische Fixtures, die die bekannten Schemata
   beider Portale nachbilden (München: MONATSZAHL/AUSPRAEGUNG/JAHR/MONAT/WERT;
   Südtirol: breites Jahres- und langes Monatsformat, deutsch/italienisch).
   Liegen echte Snapshots unter data/ (muenchen-tourismus.csv,
   suedtirol-tourismus.csv), werden sie zusätzlich geprüft; fehlen sie,
   werden diese Tests übersprungen.
   ========================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const P = require(join(here, "..", "assets", "js", "parse.js"));

const CURRENT_YEAR = new Date().getFullYear();

/* ------------------------------------------------------------------ *
 *  Basis-Helfer
 * ------------------------------------------------------------------ */

test("parseNumber: deutsche Formate und Platzhalter", () => {
  assert.equal(P.parseNumber("1.234.567"), 1234567);
  assert.equal(P.parseNumber("1.234,5"), 1234.5);
  assert.equal(P.parseNumber("12,3"), 12.3);
  assert.equal(P.parseNumber("1234"), 1234);
  assert.equal(P.parseNumber(" 815 "), 815);
  assert.equal(P.parseNumber("k.A."), null);
  assert.equal(P.parseNumber("–"), null);
  assert.equal(P.parseNumber(""), null);
  assert.equal(P.parseNumber(null), null);
});

test("parsePeriod: JJJJMM, ISO, Monatsnamen (de/it), Summenzeilen", () => {
  assert.deepEqual(P.parsePeriod("201909"), { year: 2019, month: 9 });
  assert.deepEqual(P.parsePeriod("2019-09"), { year: 2019, month: 9 });
  assert.deepEqual(P.parsePeriod("09/2019"), { year: 2019, month: 9 });
  assert.deepEqual(P.parsePeriod("2019"), { year: 2019, month: null });
  assert.deepEqual(P.parsePeriod("September 2019"), { year: 2019, month: 9 });
  assert.deepEqual(P.parsePeriod("settembre"), { year: null, month: 9 });
  assert.deepEqual(P.parsePeriod("Jänner 2020"), { year: 2020, month: 1 });
  assert.equal(P.parsePeriod("Summe"), null);
  assert.equal(P.parsePeriod(""), null);
});

test("parseDsv: Anführungszeichen und eingebettete Trennzeichen", () => {
  const rows = P.parseDsv('a;b\n"x;y";"er sagte ""hi"""\n', ";");
  assert.deepEqual(rows, [["a", "b"], ["x;y", 'er sagte "hi"']]);
});

test("sniffDelimiter: Semikolon vs. Komma", () => {
  assert.equal(P.sniffDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(P.sniffDelimiter("a,b,c\n1,2,3"), ",");
});

/* ------------------------------------------------------------------ *
 *  Fixture: Münchner Schema (monatlich, lang, mit Summenzeilen)
 * ------------------------------------------------------------------ */

function munichFixture() {
  const lines = ["MONATSZAHL,AUSPRAEGUNG,JAHR,MONAT,WERT,VORJAHRESWERT"];
  for (const year of [2018, 2019, 2022, 2023]) {
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0");
      // saisonaler Verlauf mit September-Spitze (Wiesn)
      const season = m === 9 ? 1.5 : 1;
      lines.push(`Gäste,Inland,${year},${year}${mm},${Math.round(400000 * season)},`);
      lines.push(`Gäste,Ausland,${year},${year}${mm},${Math.round(250000 * season)},`);
      lines.push(`Übernachtungen,Inland,${year},${year}${mm},${Math.round(800000 * season)},`);
      lines.push(`Übernachtungen,Ausland,${year},${year}${mm},${Math.round(600000 * season)},`);
    }
    // Jahressummen-Zeilen wie im Original — müssen verworfen werden
    lines.push(`Gäste,Inland,${year},Summe,99999999,`);
    lines.push(`Übernachtungen,Ausland,${year},Summe,99999999,`);
  }
  // Schmutz: leere Werte, Platzhalter
  lines.push("Gäste,Inland,2023,202313,123,");
  lines.push("Übernachtungen,Inland,2023,202301,k.A.,");
  return lines.join("\n");
}

test("München: validate → normalize → Modell", () => {
  const rows = P.parseCsv(munichFixture());
  const cols = P.validateMunich(rows.columns);
  assert.ok(cols, "Kernspalten wurden nicht erkannt");

  const records = P.normalizeMunich(rows, cols);
  const model = P.buildRegionModel(records, CURRENT_YEAR);

  assert.ok(model.hasMonthly, "Monatswerte erwartet");
  assert.ok(model.hasOrigin, "Inland/Ausland-Aufschlüsselung erwartet");
  assert.deepEqual(model.years, [2018, 2019, 2022, 2023]);

  // Jahressumme 2019 Übernachtungen: 11 × (800k+600k) + September × 1,5
  const expected = 11 * 1400000 + Math.round(800000 * 1.5) + Math.round(600000 * 1.5);
  const y2019 = model.annual.overnights.get(2019);
  assert.ok(y2019 && y2019.complete);
  assert.equal(y2019.value, expected);

  // „Summe“-Zeilen (99999999) dürfen nicht eingeflossen sein
  assert.ok(y2019.value < 99999999);

  // Auslandsanteil 2019 = 600/1400
  const f = model.annualByOrigin.overnights.foreign.get(2019);
  const d = model.annualByOrigin.overnights.domestic.get(2019);
  assert.ok(Math.abs(f.value / (f.value + d.value) - 600 / 1400) < 1e-9);
});

test("München: Modell-Validierung lehnt zu dünne Daten ab", () => {
  const rows = P.parseCsv("MONATSZAHL,AUSPRAEGUNG,JAHR,MONAT,WERT\nGäste,Inland,2023,202301,1000");
  const cols = P.validateMunich(rows.columns);
  assert.ok(cols);
  const model = P.buildRegionModel(P.normalizeMunich(rows, cols), CURRENT_YEAR);
  assert.equal(P.validateModel(model, 5), false);
});

/* ------------------------------------------------------------------ *
 *  Fixture: Südtirol breit/jährlich, deutsch, je Gemeinde
 * ------------------------------------------------------------------ */

function stWideFixture() {
  const lines = ["Jahr;Gemeinde;Ankünfte;Übernachtungen"];
  for (const year of [2017, 2018, 2019, 2022, 2023]) {
    lines.push(`${year};Bozen;100.000;220.000`);
    lines.push(`${year};Meran;150.000;500.000`);
    lines.push(`${year};Kastelruth;80.000;400.000`);
  }
  return lines.join("\n");
}

test("Südtirol breit: Gemeinde-Zeilen werden je Jahr summiert", () => {
  const rows = P.parseCsv(stWideFixture());
  const cols = P.validateSouthTyrol(rows.columns);
  assert.ok(cols, "Kernspalten wurden nicht erkannt");

  const records = P.normalizeSouthTyrol(rows, cols);
  const model = P.buildRegionModel(records, CURRENT_YEAR);

  assert.equal(model.hasMonthly, false);
  assert.deepEqual(model.years, [2017, 2018, 2019, 2022, 2023]);
  const y2019 = model.annual.overnights.get(2019);
  assert.equal(y2019.value, 220000 + 500000 + 400000);
  assert.equal(model.annual.arrivals.get(2023).value, 330000);
  assert.ok(P.validateModel(model, 3));
});

test("Südtirol breit: Landeszeile hat Vorrang vor Gemeinden", () => {
  const csv = [
    "Jahr;Gebiet;Übernachtungen",
    "2019;Bozen;220000",
    "2019;Südtirol insgesamt;34000000",
    "2020;Bozen;100000",
    "2020;Südtirol insgesamt;20000000",
    "2021;Südtirol insgesamt;25000000",
    "2022;Südtirol insgesamt;33000000",
  ].join("\n");
  const rows = P.parseCsv(csv);
  const cols = P.validateSouthTyrol(rows.columns);
  const model = P.buildRegionModel(P.normalizeSouthTyrol(rows, cols), CURRENT_YEAR);
  assert.equal(model.annual.overnights.get(2019).value, 34000000);
});

/* ------------------------------------------------------------------ *
 *  Fixture: Südtirol lang/monatlich, italienisch, mit Herkunft
 * ------------------------------------------------------------------ */

function stLongFixture() {
  const lines = ["anno,mese,indicatore,provenienza,valore"];
  for (const year of [2018, 2019, 2022, 2023]) {
    for (let m = 1; m <= 12; m++) {
      const season = m === 2 || m === 8 ? 1.6 : 1; // Doppelsaison
      lines.push(`${year},${m},Presenze,Italia,${Math.round(900000 * season)}`);
      lines.push(`${year},${m},Presenze,Estero,${Math.round(1800000 * season)}`);
      lines.push(`${year},${m},Arrivi,Italia,${Math.round(220000 * season)}`);
      lines.push(`${year},${m},Arrivi,Estero,${Math.round(420000 * season)}`);
    }
  }
  return lines.join("\n");
}

test("Südtirol lang: italienische Begriffe, total aus Inland+Ausland", () => {
  const rows = P.parseCsv(stLongFixture());
  const cols = P.validateSouthTyrol(rows.columns);
  assert.ok(cols, "Kernspalten wurden nicht erkannt");

  const records = P.normalizeSouthTyrol(rows, cols);
  const model = P.buildRegionModel(records, CURRENT_YEAR);

  assert.ok(model.hasMonthly);
  assert.ok(model.hasOrigin);
  assert.deepEqual(model.years, [2018, 2019, 2022, 2023]);
  // Februar 2019: 1,6-fache Saison, total = Italia + Estero
  assert.equal(model.monthly.overnights.get("2019-2"),
    Math.round(900000 * 1.6) + Math.round(1800000 * 1.6));
  // Auslandsanteil = 1800/2700
  const f = model.annualByOrigin.overnights.foreign.get(2019);
  const d = model.annualByOrigin.overnights.domestic.get(2019);
  assert.ok(Math.abs(f.value / (f.value + d.value) - 2 / 3) < 1e-6);
});

test("classifyOrigin: regionsabhängiges Inland", () => {
  // „Inland“ ist je Region das eigene Land
  assert.equal(P.classifyOrigin("Inland", "muc"), "domestic");
  assert.equal(P.classifyOrigin("Italia", "st"), "domestic");
  assert.equal(P.classifyOrigin("Germania", "st"), "country"); // Deutschland ist in Südtirol Ausland
  assert.equal(P.classifyOrigin("Deutschland", "muc"), "domestic");
  assert.equal(P.classifyOrigin("Estero", "st"), "foreign");
  assert.equal(P.classifyOrigin("Ausland", "muc"), "foreign");
  assert.equal(P.classifyOrigin("insgesamt", "muc"), "total");
  assert.equal(P.classifyOrigin("", "st"), "total");
});

/* ------------------------------------------------------------------ *
 *  Echte Snapshots (falls vorhanden)
 * ------------------------------------------------------------------ */

const SNAP_MUC = join(here, "..", "data", "muenchen-tourismus.csv");
const SNAP_ST = join(here, "..", "data", "suedtirol-tourismus.csv");

test("Snapshot München: Schema und Plausibilität", { skip: !existsSync(SNAP_MUC) }, () => {
  const rows = P.parseCsv(readFileSync(SNAP_MUC));
  const cols = P.validateMunich(rows.columns);
  assert.ok(cols, "Kernspalten im Snapshot nicht gefunden");
  const model = P.buildRegionModel(P.normalizeMunich(rows, cols), CURRENT_YEAR);
  assert.ok(P.validateModel(model, 10), "erwartet ≥10 vollständige Jahre");
  assert.ok(model.hasMonthly);
  // Plausibilität: Münchner Übernachtungen je vollständigem Jahr 3–40 Mio.
  for (const year of model.years) {
    const v = model.annual.overnights.get(year);
    if (!v) continue;
    assert.ok(v.value > 3e6 && v.value < 4e7,
      `unplausible Übernachtungen ${year}: ${v.value}`);
  }
});

test("Snapshot Südtirol: Schema und Plausibilität", { skip: !existsSync(SNAP_ST) }, () => {
  const rows = P.parseCsv(readFileSync(SNAP_ST));
  const cols = P.validateSouthTyrol(rows.columns);
  assert.ok(cols, "Kernspalten im Snapshot nicht gefunden");
  const model = P.buildRegionModel(P.normalizeSouthTyrol(rows, cols), CURRENT_YEAR);
  assert.ok(P.validateModel(model, 3), "erwartet ≥3 vollständige Jahre");
  // Plausibilität: Südtiroler Übernachtungen je Jahr 5–60 Mio.
  for (const year of model.years) {
    const v = model.annual.overnights.get(year);
    if (!v) continue;
    assert.ok(v.value > 5e6 && v.value < 6e7,
      `unplausible Übernachtungen ${year}: ${v.value}`);
  }
});
