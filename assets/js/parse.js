/* ==========================================================================
   Zwei Heimaten in Zahlen — Datenschicht (parse.js)
   --------------------------------------------------------------------------
   Reines Parsen & Normalisieren, ohne DOM und ohne D3 – läuft identisch im
   Browser (window.MB) und in Node (module.exports) und ist dadurch mit
   `node --test` testbar.

   Quellen:
   - München: „Monatszahlen Tourismus“ (Open Data Portal München, CKAN)
     erwartetes Schema: MONATSZAHL; AUSPRAEGUNG; JAHR; MONAT (JJJJMM); WERT; …
   - Südtirol: Tourismus-Datensatz vom Open Data Portal Südtirol
     (data.civis.bz.it, CKAN). Das genaue Schema variiert (deutsch/italienisch,
     lang/breit, monatlich/jährlich) – die Spaltenerkennung arbeitet deshalb
     keyword-basiert und zweisprachig, die Story degradiert bei gröberer
     Granularität.

   Normalisiertes Datenmodell (eine Zeile = eine Beobachtung):
   { region: "muc"|"st", year, month: 1–12|null, metric: "arrivals"|"overnights",
     origin: "domestic"|"foreign"|"total", value }
   ========================================================================== */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.MB = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   *  Zahlen, Header, Encoding, Delimiter
   * ------------------------------------------------------------------ */

  function parseNumber(v) {
    if (v == null) return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    let s = String(v).trim();
    if (!s || /^(k\.?\s?a\.?|n\/?\s?a|-+|–|\.|x)$/i.test(s)) return null;
    s = s.replace(/[^\d,.\-]/g, "");
    if (!s || s === "-") return null;
    const hasComma = s.includes(",");
    const hasDot = s.includes(".");
    if (hasComma && hasDot) {
      s = s.replace(/\./g, "").replace(",", "."); // 1.234.567,8
    } else if (hasComma) {
      const parts = s.split(",");
      if (parts.length === 2 && parts[1].length !== 3) s = parts.join(".");
      else s = parts.join("");
    } else if (hasDot) {
      const parts = s.split(".");
      const thousandish = parts.slice(1).every(function (p) { return p.length === 3; });
      if (parts.length > 1 && thousandish) s = parts.join("");
    }
    const n = Number(s);
    return isFinite(n) ? n : null;
  }

  function normalizeHeader(h) {
    return String(h)
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/à/g, "a").replace(/è|é/g, "e").replace(/ì/g, "i")
      .replace(/ò/g, "o").replace(/ù/g, "u")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function decodeBuffer(buf) {
    let text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("�")) {
      try {
        text = new TextDecoder("windows-1252").decode(buf);
      } catch (e) {
        /* utf-8 behalten */
      }
    }
    return text.replace(/^﻿/, "");
  }

  function sniffDelimiter(text) {
    const firstLine = text.slice(0, text.indexOf("\n") + 1 || 2000);
    const candidates = [";", ",", "\t", "|"];
    let best = ";";
    let bestCount = -1;
    for (const c of candidates) {
      // Trennzeichen in Anführungszeichen nicht mitzählen
      const stripped = firstLine.replace(/"[^"]*"/g, "");
      const count = stripped.split(c).length - 1;
      if (count > bestCount) {
        bestCount = count;
        best = c;
      }
    }
    return best;
  }

  // Kleiner RFC-4180-Parser (Anführungszeichen, eingebettete Trennzeichen
  // und Zeilenumbrüche) – damit die Datenschicht ohne D3 auskommt.
  function parseDsv(text, delim) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    const n = text.length;
    function endField() { row.push(field); field = ""; }
    function endRow() {
      endField();
      if (row.length > 1 || (row.length === 1 && row[0] !== "")) rows.push(row);
      row = [];
    }
    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === "") { inQuotes = true; i++; continue; }
      if (c === delim) { endField(); i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { endRow(); i++; continue; }
      field += c; i++;
    }
    if (field !== "" || row.length) endRow();
    return rows;
  }

  // CSV → Array von Objekten (wie d3.dsvFormat().parse, plus .columns)
  function parseCsv(buf) {
    const text = typeof buf === "string" ? buf : decodeBuffer(buf);
    const delim = sniffDelimiter(text);
    const grid = parseDsv(text, delim);
    if (grid.length < 2 || grid[0].length < 2) {
      throw new Error("CSV konnte nicht interpretiert werden");
    }
    const columns = grid[0].map(function (h) { return String(h).trim(); });
    const rows = [];
    for (let r = 1; r < grid.length; r++) {
      const obj = {};
      for (let c = 0; c < columns.length; c++) obj[columns[c]] = grid[r][c] != null ? grid[r][c] : "";
      rows.push(obj);
    }
    rows.columns = columns;
    return rows;
  }

  function detectColumns(headers, candidates) {
    const norm = new Map();
    headers.forEach(function (h) {
      const key = normalizeHeader(h);
      if (!norm.has(key)) norm.set(key, h);
    });
    const map = {};
    for (const key of Object.keys(candidates)) {
      // 1) exakte Treffer in Kandidaten-Reihenfolge
      for (const c of candidates[key]) {
        if (norm.has(c)) { map[key] = norm.get(c); break; }
      }
      // 2) Teilstring-Treffer als Ausweich (z. B. "uebernachtungen anzahl")
      if (!map[key]) {
        outer:
        for (const c of candidates[key]) {
          for (const entry of norm) {
            if (entry[0].indexOf(c) !== -1) { map[key] = entry[1]; break outer; }
          }
        }
      }
    }
    return map;
  }

  /* ------------------------------------------------------------------ *
   *  Monats- und Begriff-Erkennung (deutsch/italienisch)
   * ------------------------------------------------------------------ */

  const MONTH_NAMES = {
    // deutsch (inkl. österreichisch „Jänner“)
    januar: 1, jaenner: 1, februar: 2, maerz: 3, april: 4, mai: 5, juni: 6,
    juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
    // italienisch
    gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
    luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
    // Abkürzungen
    jan: 1, feb: 2, mar: 3, mae: 3, apr: 4, mag: 5, jun: 6, giu: 6, jul: 7,
    lug: 7, aug: 8, ago: 8, sep: 9, set: 9, okt: 10, ott: 10, nov: 11,
    dez: 12, dic: 12,
  };

  // Liefert {year, month} oder null. Versteht JJJJMM, JJJJ-MM, MM/JJJJ,
  // Monatsnamen und reine Monatsnummern (dann ohne Jahr).
  function parsePeriod(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})(0[1-9]|1[0-2])$/); // 202301
    if (m) return { year: +m[1], month: +m[2] };
    m = s.match(/^(\d{4})[-/.](\d{1,2})/); // 2023-01
    if (m && +m[2] >= 1 && +m[2] <= 12) return { year: +m[1], month: +m[2] };
    m = s.match(/^(\d{1,2})[-/.](\d{4})$/); // 01/2023
    if (m && +m[1] >= 1 && +m[1] <= 12) return { year: +m[2], month: +m[1] };
    m = s.match(/^(\d{4})$/); // nur Jahr
    if (m) return { year: +m[1], month: null };
    m = s.match(/^(\d{1,2})$/); // nur Monatsnummer
    if (m && +m[1] >= 1 && +m[1] <= 12) return { year: null, month: +m[1] };
    const name = normalizeHeader(s).replace(/[^a-z]/g, "");
    for (const key of Object.keys(MONTH_NAMES)) {
      if (name === key || name.indexOf(key) === 0) {
        const y = s.match(/(\d{4})/);
        return { year: y ? +y[1] : null, month: MONTH_NAMES[key] };
      }
    }
    return null;
  }

  // Alle Begriff-Regexes arbeiten auf normalizeHeader()-Text
  // (kleingeschrieben, Umlaute zu ae/oe/ue aufgelöst).
  const RE_ARRIVALS = /ankuenfte|gaeste|arriv|guest/;
  const RE_OVERNIGHTS = /uebernacht|naechtigung|presenze|pernott|overnight|naechte/;
  const RE_TOTAL = /^(insgesamt|gesamt|zusammen|summe|totale?|total|alle)\b/;
  const RE_FOREIGN = /ausland|estero|stranier|foreign/;
  // „Inland“ ist je Region das eigene Land: Deutschland (muc) bzw. Italien (st)
  const DOMESTIC_RES = {
    muc: /inland|domestic|deutschland|germany|germania/,
    st: /inland|domestic|italien|italia|italy|nazionale/,
  };
  const RE_REGION_TOTAL = /suedtirol|alto adige|provincia|landeswert|insgesamt|totale?|gesamt|total/;

  function classifyMetric(raw) {
    const s = normalizeHeader(raw == null ? "" : raw);
    if (RE_OVERNIGHTS.test(s)) return "overnights";
    if (RE_ARRIVALS.test(s)) return "arrivals";
    return null;
  }

  function classifyOrigin(raw, region) {
    const s = normalizeHeader(raw == null ? "" : raw);
    if (!s || RE_TOTAL.test(s)) return "total";
    if (RE_FOREIGN.test(s)) return "foreign";
    const domestic = DOMESTIC_RES[region] || /inland|domestic/;
    if (domestic.test(s)) return "domestic";
    return "country"; // einzelnes Herkunftsland → wird ggf. zu foreign aggregiert
  }

  function plausibleYear(y) {
    return y != null && y >= 1950 && y <= 2100;
  }

  /* ------------------------------------------------------------------ *
   *  München: „Monatszahlen Tourismus“ (langes Format)
   * ------------------------------------------------------------------ */

  const MUC_COLUMNS = {
    metric: ["monatszahl", "kategorie", "kennzahl"],
    origin: ["auspraegung", "herkunft", "merkmal"],
    year: ["jahr"],
    month: ["monat"],
    value: ["wert"],
  };

  function validateMunich(headers) {
    const cols = detectColumns(headers.filter(function (h) { return h !== "_id"; }), MUC_COLUMNS);
    if (cols.metric && cols.year && cols.month && cols.value) return cols;
    return null;
  }

  function normalizeMunich(rows, cols) {
    const records = [];
    for (const r of rows) {
      const metric = classifyMetric(r[cols.metric]);
      if (!metric) continue;
      const period = parsePeriod(r[cols.month]);
      if (!period || period.month == null) continue; // „Summe“-Zeilen verwerfen
      let year = period.year;
      const yearCol = parseNumber(r[cols.year]);
      if (!plausibleYear(year)) year = plausibleYear(yearCol) ? yearCol : null;
      if (!plausibleYear(year)) continue;
      const value = parseNumber(r[cols.value]);
      if (value == null || value < 0) continue;
      const origin = cols.origin ? classifyOrigin(r[cols.origin], "muc") : "total";
      records.push({
        region: "muc",
        year: year,
        month: period.month,
        metric: metric,
        origin: origin,
        value: value,
      });
    }
    return collapseCountries(records);
  }

  /* ------------------------------------------------------------------ *
   *  Südtirol: flexibles Schema (lang oder breit, de/it, mtl. oder jährl.)
   * ------------------------------------------------------------------ */

  const ST_COLUMNS = {
    year: ["jahr", "anno", "year", "jahre"],
    month: ["monat", "mese", "month"],
    period: ["zeitraum", "periodo", "zeitbezug", "datum", "data", "periode", "time"],
    arrivals: ["ankuenfte", "arrivi", "arrivals", "ankuenfte gaeste", "gaeste"],
    overnights: [
      "uebernachtungen", "naechtigungen", "presenze", "pernottamenti",
      "overnight stays", "overnights", "naechte",
    ],
    metric: ["indikator", "indicatore", "kennzahl", "monatszahl", "variabile", "indicator", "voce"],
    value: ["wert", "valore", "value", "anzahl", "numero", "totale"],
    origin: [
      "herkunft", "herkunftsland", "provenienza", "paese di provenienza",
      "gaesteherkunft", "land der herkunft", "paese",
    ],
    territory: ["gebiet", "gemeinde", "comune", "territorio", "bezirk", "comunita", "territory"],
  };

  function validateSouthTyrol(headers) {
    const cols = detectColumns(headers.filter(function (h) { return h !== "_id"; }), ST_COLUMNS);
    const hasTime = cols.year || cols.period || cols.month;
    const hasWide = cols.arrivals || cols.overnights;
    const hasLong = cols.metric && cols.value;
    if (hasTime && (hasWide || hasLong)) return cols;
    return null;
  }

  function stPeriodOf(r, cols) {
    let year = null;
    let month = null;
    if (cols.year) {
      const p = parsePeriod(r[cols.year]);
      if (p) { year = p.year != null ? p.year : year; month = p.month != null ? p.month : month; }
    }
    if (cols.month) {
      const p = parsePeriod(r[cols.month]);
      if (p) {
        if (p.month != null) month = p.month;
        if (p.year != null && year == null) year = p.year;
      }
    }
    if (cols.period && (year == null || month == null)) {
      const p = parsePeriod(r[cols.period]);
      if (p) {
        if (p.year != null && year == null) year = p.year;
        if (p.month != null && month == null) month = p.month;
      }
    }
    if (!plausibleYear(year)) return null;
    return { year: year, month: month };
  }

  function normalizeSouthTyrol(rows, cols) {
    // Gebietsspalte: gibt es eine Landeszeile (Südtirol gesamt), nur diese
    // verwenden; sonst über alle Gebiete (Gemeinden) summieren.
    let territoryFilter = null;
    if (cols.territory) {
      const values = new Set();
      for (const r of rows) {
        const v = String(r[cols.territory] || "").trim();
        if (v) values.add(v);
      }
      for (const v of values) {
        if (RE_REGION_TOTAL.test(normalizeHeader(v))) { territoryFilter = v; break; }
      }
    }

    const raw = [];
    for (const r of rows) {
      if (cols.territory && territoryFilter) {
        if (String(r[cols.territory] || "").trim() !== territoryFilter) continue;
      }
      const period = stPeriodOf(r, cols);
      if (!period) continue;
      const origin = cols.origin ? classifyOrigin(r[cols.origin], "st") : "total";

      if (cols.arrivals || cols.overnights) {
        // breites Format: eigene Spalten je Kennzahl
        for (const metric of ["arrivals", "overnights"]) {
          if (!cols[metric]) continue;
          const value = parseNumber(r[cols[metric]]);
          if (value == null || value < 0) continue;
          raw.push({
            region: "st", year: period.year, month: period.month,
            metric: metric, origin: origin, value: value,
          });
        }
      } else {
        // langes Format: Kennzahl-Spalte + Wert-Spalte
        const metric = classifyMetric(r[cols.metric]);
        if (!metric) continue;
        const value = parseNumber(r[cols.value]);
        if (value == null || value < 0) continue;
        raw.push({
          region: "st", year: period.year, month: period.month,
          metric: metric, origin: origin, value: value,
        });
      }
    }

    // ohne Landeszeile: über Gebiete summieren
    const needsSum = cols.territory && !territoryFilter;
    return collapseCountries(needsSum ? sumDuplicates(raw) : raw);
  }

  // Gleiche Schlüssel (region|metric|origin|jahr|monat) aufsummieren –
  // nötig, wenn Daten je Gemeinde vorliegen.
  function sumDuplicates(records) {
    const acc = new Map();
    for (const r of records) {
      const key = [r.region, r.metric, r.origin, r.year, r.month].join("|");
      const prev = acc.get(key);
      if (prev) prev.value += r.value;
      else acc.set(key, { region: r.region, year: r.year, month: r.month, metric: r.metric, origin: r.origin, value: r.value });
    }
    return Array.from(acc.values());
  }

  // Einzelne Herkunftsländer („country“) zu foreign/domestic zusammenfassen.
  // Liegt bereits eine explizite Ausland-Zeile vor, werden Länderzeilen
  // verworfen (sonst würde doppelt gezählt).
  function collapseCountries(records) {
    const hasExplicitForeign = records.some(function (r) { return r.origin === "foreign"; });
    const out = [];
    const countrySums = new Map();
    for (const r of records) {
      if (r.origin !== "country") { out.push(r); continue; }
      if (hasExplicitForeign) continue;
      const key = [r.region, r.metric, r.year, r.month].join("|");
      const prev = countrySums.get(key);
      if (prev) prev.value += r.value;
      else countrySums.set(key, { region: r.region, year: r.year, month: r.month, metric: r.metric, origin: "foreign", value: r.value });
    }
    for (const r of countrySums.values()) out.push(r);
    return out;
  }

  /* ------------------------------------------------------------------ *
   *  Aggregation zum Chart-Modell
   * ------------------------------------------------------------------ */

  const METRICS = ["arrivals", "overnights"];
  const ORIGINS = ["total", "domestic", "foreign"];

  function monthKey(y, m) { return y + "-" + m; }

  // records → Modell je Region:
  // { hasMonthly, hasOrigin, monthly[metric] (origin=total, Map "y-m"→v),
  //   monthlyByOrigin[metric][origin], annual[metric] (Map y→{value, complete}),
  //   annualByOrigin[metric][origin], years (vollständige Jahre, sortiert) }
  function buildRegionModel(records, currentYear) {
    const byMetricOrigin = {};
    for (const m of METRICS) {
      byMetricOrigin[m] = { total: new Map(), domestic: new Map(), foreign: new Map() };
    }
    const annualDirect = {}; // Jahreswerte aus Zeilen ohne Monat
    for (const m of METRICS) {
      annualDirect[m] = { total: new Map(), domestic: new Map(), foreign: new Map() };
    }

    let sawMonthly = false;
    for (const r of records) {
      if (!METRICS.includes(r.metric) || !ORIGINS.includes(r.origin)) continue;
      if (r.month != null) {
        sawMonthly = true;
        const map = byMetricOrigin[r.metric][r.origin];
        const key = monthKey(r.year, r.month);
        map.set(key, (map.get(key) || 0) + r.value);
      } else {
        const map = annualDirect[r.metric][r.origin];
        map.set(r.year, (map.get(r.year) || 0) + r.value);
      }
    }

    // total ggf. aus domestic+foreign ableiten
    for (const m of METRICS) {
      const g = byMetricOrigin[m];
      if (g.total.size === 0 && g.domestic.size && g.foreign.size) {
        for (const entry of g.domestic) {
          const f = g.foreign.get(entry[0]);
          if (f != null) g.total.set(entry[0], entry[1] + f);
        }
      }
      const a = annualDirect[m];
      if (a.total.size === 0 && a.domestic.size && a.foreign.size) {
        for (const entry of a.domestic) {
          const f = a.foreign.get(entry[0]);
          if (f != null) a.total.set(entry[0], entry[1] + f);
        }
      }
    }

    // Jahreswerte: aus Monaten summieren (complete = 12 Monate),
    // sonst direkte Jahreszeilen übernehmen.
    function annualFrom(monthlyMap, directMap) {
      const perYear = new Map();
      for (const entry of monthlyMap) {
        const parts = entry[0].split("-");
        const y = +parts[0];
        const e = perYear.get(y) || { value: 0, months: 0 };
        e.value += entry[1];
        e.months += 1;
        perYear.set(y, e);
      }
      const out = new Map();
      for (const entry of perYear) {
        out.set(entry[0], {
          value: entry[1].value,
          complete: entry[1].months >= 12,
        });
      }
      for (const entry of directMap) {
        if (!out.has(entry[0])) {
          out.set(entry[0], { value: entry[1], complete: entry[0] < currentYear });
        }
      }
      return out;
    }

    const monthly = {};
    const monthlyByOrigin = {};
    const annual = {};
    const annualByOrigin = {};
    for (const m of METRICS) {
      monthly[m] = byMetricOrigin[m].total;
      monthlyByOrigin[m] = {
        domestic: byMetricOrigin[m].domestic,
        foreign: byMetricOrigin[m].foreign,
      };
      annual[m] = annualFrom(byMetricOrigin[m].total, annualDirect[m].total);
      annualByOrigin[m] = {
        domestic: annualFrom(byMetricOrigin[m].domestic, annualDirect[m].domestic),
        foreign: annualFrom(byMetricOrigin[m].foreign, annualDirect[m].foreign),
      };
    }

    const years = [];
    for (const m of METRICS) {
      for (const entry of annual[m]) {
        if (entry[1].complete && !years.includes(entry[0])) years.push(entry[0]);
      }
    }
    years.sort(function (a, b) { return a - b; });

    const hasOrigin = METRICS.some(function (m) {
      return annualByOrigin[m].domestic.size > 0 && annualByOrigin[m].foreign.size > 0;
    });

    return {
      hasMonthly: sawMonthly,
      hasOrigin: hasOrigin,
      monthly: monthly,
      monthlyByOrigin: monthlyByOrigin,
      annual: annual,
      annualByOrigin: annualByOrigin,
      years: years,
    };
  }

  // Plausibilitätsprüfung nach dem Normalisieren: genug Jahre mit Werten?
  function validateModel(model, minYears) {
    if (!model) return false;
    return model.years.length >= (minYears == null ? 3 : minYears);
  }

  return {
    parseNumber: parseNumber,
    normalizeHeader: normalizeHeader,
    decodeBuffer: decodeBuffer,
    sniffDelimiter: sniffDelimiter,
    parseDsv: parseDsv,
    parseCsv: parseCsv,
    detectColumns: detectColumns,
    parsePeriod: parsePeriod,
    classifyMetric: classifyMetric,
    classifyOrigin: classifyOrigin,
    MUC_COLUMNS: MUC_COLUMNS,
    ST_COLUMNS: ST_COLUMNS,
    validateMunich: validateMunich,
    normalizeMunich: normalizeMunich,
    validateSouthTyrol: validateSouthTyrol,
    normalizeSouthTyrol: normalizeSouthTyrol,
    buildRegionModel: buildRegionModel,
    validateModel: validateModel,
  };
});
