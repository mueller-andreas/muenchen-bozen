/* ==========================================================================
   Zwei Heimaten in Zahlen — München ↔ Südtirol
   --------------------------------------------------------------------------
   Lädt die offenen Tourismusdaten beider Heimatregionen direkt im Browser
   und rendert daraus eine interaktive Datengeschichte mit D3.js.

   Quellen:
   - München: „Monatszahlen Tourismus“ (Open Data Portal München)
     https://opendata.muenchen.de/dataset/monatszahlen-tourismus
   - Südtirol: Tourismusdaten vom Open Data Portal Südtirol
     https://data.civis.bz.it – der konkrete Datensatz wird zur Laufzeit über
     die CKAN-Suche ermittelt (Kandidaten-IDs zuerst, dann package_search),
     weil das Portal seine Datensätze umbenennen/erneuern kann.

   Die Lade-Kette je Quelle folgt den CKAN-API-Regeln (wie im Schwester-
   projekt messe-muenchen): package_show → Original-CSV → lokaler Snapshot →
   Datastore-API → JSONP → CORS-Proxys. Jede Quelle wird nach dem Laden
   gegen das erwartete Schema validiert; die Geschichte degradiert
   kapitelweise, wenn eine Region weniger Detail liefert (z. B. nur
   Jahres- statt Monatswerte).
   ========================================================================== */

(function () {
  "use strict";

  const P = window.MB; // Datenschicht aus parse.js

  /* ------------------------------------------------------------------ *
   *  Konfiguration der beiden Quellen
   * ------------------------------------------------------------------ */

  const MUC_DATASET_PAGE = "https://opendata.muenchen.de/dataset/monatszahlen-tourismus";
  const ST_PORTAL = "https://data.civis.bz.it";
  const ST_DATASET_PAGE = ST_PORTAL + "/de/dataset?q=tourismus";

  // Bekannte CSV-URL als letzte Reserve (Datenstand 12/2021) – die aktuelle
  // Ressource wird immer zuerst über package_show aufgelöst, weil das Portal
  // monatlich eine neue Datei anlegt (monatszahlenJJMM_tourismus.csv).
  const MUC_KNOWN_CSV =
    "https://opendata.muenchen.de/dataset/3621ad08-aa97-4c2b-b0b0-82780375743c/" +
    "resource/4f00274a-ef75-41e5-b5c1-15f22c9f8a12/download/monatszahlen2112_tourismus.csv";

  const SOURCES = {
    muc: {
      id: "muc",
      label: "München",
      datasetPage: MUC_DATASET_PAGE,
      apiRoots: [
        "https://www.opengov-muenchen.de/api/action",
        "https://opendata.muenchen.de/api/3/action",
      ],
      datasetIds: ["monatszahlen-tourismus"],
      searchQueries: [], // Datensatz-ID ist stabil und bekannt
      knownCsv: MUC_KNOWN_CSV,
      snapshot: "data/muenchen-tourismus.csv",
      validate: P.validateMunich,
      normalize: P.normalizeMunich,
      minYears: 5,
      // jüngste Monatszahlen-Ressource wählen (Dateiname monatszahlenJJMM_…)
      scoreResource: function (res) {
        const name = ((res.name || "") + " " + (res.url || "")).toLowerCase();
        let score = 0;
        if (/csv/i.test(res.format || "")) score += 10;
        const m = name.match(/monatszahlen(\d{4})_tourismus/);
        if (m) score += 100 + (+m[1] % 100) / 100 + Math.floor(+m[1] / 100);
        if (/tourismus/.test(name)) score += 5;
        return score;
      },
    },
    st: {
      id: "st",
      label: "Südtirol",
      datasetPage: ST_DATASET_PAGE,
      apiRoots: [ST_PORTAL + "/api/3/action"],
      // Kandidaten zuerst; greift keiner, sucht discoverDataset per
      // package_search nach passenden Tourismus-Datensätzen.
      datasetIds: [
        "tourismus-ankunfte-und-ubernachtungen",
        "turismo-arrivi-e-presenze",
        "turismo-barometro-congiunturale",
      ],
      searchQueries: ["tourismus", "turismo"],
      knownCsv: null,
      snapshot: "data/suedtirol-tourismus.csv",
      validate: P.validateSouthTyrol,
      normalize: P.normalizeSouthTyrol,
      minYears: 3,
      scoreResource: function (res) {
        const name = ((res.name || "") + " " + (res.description || "") + " " + (res.url || "")).toLowerCase();
        let score = 0;
        if (/csv/i.test(res.format || "")) score += 10;
        else if (/json/i.test(res.format || "")) score += 4;
        if (/arriv|ank(ü|u)nft|presenze|pernott|(ü|u)bernacht|n(ä|a)chtigung/.test(name)) score += 8;
        if (/turis|touris/.test(name)) score += 4;
        if (/mensil|monat|month/.test(name)) score += 3;
        if (/grafik|chart|grafici|pdf|bild|image/.test(name)) score -= 6;
        return score;
      },
    },
  };

  function scoreDataset(pkg) {
    const text = ((pkg.title || "") + " " + (pkg.name || "")).toLowerCase();
    let score = 0;
    if (/turis|touris/.test(text)) score += 5;
    if (/arriv|ank(ü|u)nft|presenze|pernott|(ü|u)bernacht|n(ä|a)chtigung/.test(text)) score += 8;
    if (/mensil|monat/.test(text)) score += 3;
    if (/barometro|barometer/.test(text)) score += 1;
    if ((pkg.resources || []).some(function (r) { return /csv/i.test(r.format || ""); })) score += 4;
    return score;
  }

  const COLORS = {
    muc: "#0a6ebd",      // München-Blau (wie im Schwesterprojekt)
    st: "#c4452e",       // Südtirol-Rot (Terrakotta)
    mucSoft: "#7fb2dd",
    stSoft: "#e0937f",
    neutral: "#9aa3b5",
  };
  const REGION_LABELS = { muc: "München", st: "Südtirol" };
  const REGIONS = ["muc", "st"];
  const MONTH_LABELS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

  const fmtInt = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
  const fmt1 = new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  function fmtCompact(n) {
    if (n == null || !isFinite(n)) return "–";
    if (Math.abs(n) >= 1e6) return fmt1.format(n / 1e6) + " Mio.";
    if (Math.abs(n) >= 1e4) return fmtInt.format(Math.round(n / 1e3)) + " Tsd.";
    return fmtInt.format(n);
  }

  function fmtPct(x) {
    return fmtInt.format(Math.round(x * 100)) + " %";
  }

  const CURRENT_YEAR = new Date().getFullYear();
  const COVID_YEARS = [2020, 2021];

  /* ------------------------------------------------------------------ *
   *  Laden (CKAN): Discovery, CSV, Snapshot, Datastore, JSONP, Proxys
   * ------------------------------------------------------------------ */

  const FETCH_TIMEOUT_MS = 9000;

  async function fetchWithTimeout(url, opts) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl && setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {}));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchJson(url) {
    const resp = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) throw new Error("HTTP " + resp.status + " für " + url);
    return resp.json();
  }

  async function fetchCsvRows(url) {
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) throw new Error("HTTP " + resp.status + " für " + url);
    return P.parseCsv(await resp.arrayBuffer());
  }

  // JSONP-Fallback: CKAN beantwortet GET-Anfragen mit ?callback=… auch ohne
  // CORS-Header, da die Antwort als <script> geladen wird.
  function fetchJsonp(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const cb = "__ckanCb" + Math.random().toString(36).slice(2);
      const script = document.createElement("script");
      const timer = setTimeout(function () {
        cleanup();
        reject(new Error("JSONP-Timeout"));
      }, timeoutMs || FETCH_TIMEOUT_MS);
      function cleanup() {
        clearTimeout(timer);
        delete window[cb];
        script.remove();
      }
      window[cb] = function (data) { cleanup(); resolve(data); };
      script.onerror = function () { cleanup(); reject(new Error("JSONP-Fehler")); };
      script.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
      document.head.appendChild(script);
    });
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return url; }
  }

  function proxyUrls(csvUrl) {
    return [
      "https://api.allorigins.win/raw?url=" + encodeURIComponent(csvUrl),
      "https://corsproxy.io/?url=" + encodeURIComponent(csvUrl),
    ];
  }

  // Schritt 1: Datensatz finden. Erst bekannte IDs (package_show), dann –
  // nur für Südtirol nötig – package_search mit Stichwort-Bewertung.
  async function discoverDataset(src, attempts) {
    for (const root of src.apiRoots) {
      for (const id of src.datasetIds) {
        try {
          const json = await fetchJson(root + "/package_show?id=" + id);
          if (json && json.success && json.result) return { pkg: json.result, root: root };
        } catch (e) {
          attempts.push("package_show " + id + " (" + hostOf(root) + "): " + e.message);
        }
      }
    }
    for (const root of src.apiRoots) {
      for (const q of src.searchQueries) {
        try {
          const json = await fetchJson(root + "/package_search?q=" + encodeURIComponent(q) + "&rows=40");
          if (json && json.success && json.result && json.result.results) {
            const ranked = json.result.results
              .map(function (pkg) { return { pkg: pkg, score: scoreDataset(pkg) }; })
              .filter(function (d) { return d.score >= 9; })
              .sort(function (a, b) { return b.score - a.score; });
            if (ranked.length) return { pkg: ranked[0].pkg, root: root, alternatives: ranked.slice(1, 3) };
          }
        } catch (e) {
          attempts.push("package_search „" + q + "“ (" + hostOf(root) + "): " + e.message);
        }
      }
    }
    return null;
  }

  function rankedResources(src, pkg) {
    return (pkg && pkg.resources ? pkg.resources.slice() : [])
      .map(function (r) { return { res: r, score: src.scoreResource(r) }; })
      .filter(function (d) { return d.score > 0 && d.res.url; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 4);
  }

  function unpackDatastore(json) {
    if (!json || !json.success || !json.result) {
      throw new Error("API-Antwort ohne Ergebnis");
    }
    const records = json.result.records || [];
    const headers = json.result.fields
      ? json.result.fields.map(function (f) { return f.id; })
      : records.length
        ? Object.keys(records[0])
        : [];
    const total = typeof json.result.total === "number" ? json.result.total : null;
    return { records: records, headers: headers, total: total };
  }

  async function fetchDatastore(root, resourceId) {
    const all = [];
    let headers = null;
    let offset = 0;
    let total = Infinity;
    while (offset < total && offset < 100000) {
      const url = root + "/datastore_search?resource_id=" + resourceId +
        "&limit=10000&offset=" + offset;
      const page = unpackDatastore(await fetchJson(url));
      if (!headers) headers = page.headers;
      all.push.apply(all, page.records);
      total = page.total != null ? page.total : all.length;
      if (!page.records.length) break;
      offset = all.length;
    }
    if (!all.length) throw new Error("keine Datensätze");
    return { rows: all, headers: headers };
  }

  // Lädt eine Quelle über die komplette Fallback-Kette und liefert
  // { model, origin: "live"|"snapshot", via, pkg, attempts }.
  async function loadSource(src) {
    const attempts = [];

    function finish(rows, headers, origin, via, pkg) {
      const cols = src.validate(headers);
      if (!cols) {
        attempts.push(via + ": Kernspalten fehlen (Schema weicht ab) – übersprungen");
        return null;
      }
      const records = src.normalize(rows, cols);
      const model = P.buildRegionModel(records, CURRENT_YEAR);
      if (!P.validateModel(model, src.minYears)) {
        attempts.push(via + ": zu wenige plausible Jahreswerte – übersprungen");
        return null;
      }
      return { model: model, origin: origin, via: via, pkg: pkg || null, attempts: attempts };
    }

    // 1) Metadaten-Discovery
    const discovery = await discoverDataset(src, attempts);
    const pkg = discovery && discovery.pkg;
    const root = discovery && discovery.root;
    const candidates = pkg ? rankedResources(src, pkg) : [];

    // 2) Original-CSV/JSON-Ressourcen (aktuelle URLs aus den Metadaten)
    for (const cand of candidates) {
      try {
        const rows = await fetchCsvRows(cand.res.url);
        const result = finish(rows, rows.columns, "live", "CSV-Download", pkg);
        if (result) return result;
      } catch (e) {
        attempts.push("CSV " + hostOf(cand.res.url) + ": " + e.message);
      }
    }
    if (src.knownCsv && !candidates.some(function (c) { return c.res.url === src.knownCsv; })) {
      try {
        const rows = await fetchCsvRows(src.knownCsv);
        const result = finish(rows, rows.columns, "live", "CSV-Download (bekannte URL)", pkg);
        if (result) return result;
      } catch (e) {
        attempts.push("CSV (bekannte URL): " + e.message);
      }
    }

    // 3) gebündelter Snapshot aus diesem Repository
    try {
      const rows = await fetchCsvRows(src.snapshot);
      const result = finish(rows, rows.columns, "snapshot", "lokaler Snapshot", pkg);
      if (result) return result;
    } catch (e) {
      attempts.push("Snapshot: " + e.message);
    }

    // 4) Datastore-API – nur für Ressourcen, deren Metadaten sie erlauben
    for (const cand of candidates) {
      if (cand.res.datastore_active !== true || !root) continue;
      try {
        const ds = await fetchDatastore(root, cand.res.id);
        const result = finish(ds.rows, ds.headers, "live", "Datastore-API", pkg);
        if (result) return result;
      } catch (e) {
        attempts.push("Datastore (" + hostOf(root) + "): " + e.message);
      }
    }

    // 5) Datastore per JSONP (umgeht fehlende CORS-Header)
    for (const cand of candidates) {
      if (cand.res.datastore_active !== true || !root) continue;
      try {
        const url = root + "/datastore_search?resource_id=" + cand.res.id + "&limit=10000";
        const page = unpackDatastore(await fetchJsonp(url));
        if (!page.records.length) throw new Error("keine Datensätze");
        const result = finish(page.records, page.headers, "live", "Datastore-API (JSONP)", pkg);
        if (result) return result;
      } catch (e) {
        attempts.push("JSONP (" + hostOf(root) + "): " + e.message);
      }
    }

    // 6) CORS-Proxys auf die beste CSV-URL
    const proxyTargets = candidates.length
      ? [candidates[0].res.url]
      : src.knownCsv ? [src.knownCsv] : [];
    for (const target of proxyTargets) {
      for (const proxyUrl of proxyUrls(target)) {
        try {
          const rows = await fetchCsvRows(proxyUrl);
          const result = finish(rows, rows.columns, "live", "CSV via Proxy", pkg);
          if (result) return result;
        } catch (e) {
          attempts.push("Proxy (" + hostOf(proxyUrl) + "): " + e.message);
        }
      }
    }

    const err = new Error("Alle Datenquellen fehlgeschlagen");
    err.attempts = attempts;
    throw err;
  }

  /* ------------------------------------------------------------------ *
   *  Tooltip & kleine UI-Helfer
   * ------------------------------------------------------------------ */

  const tooltip = document.getElementById("tooltip");

  function showTooltip(html, event) {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    moveTooltip(event);
  }

  function moveTooltip(event) {
    const pad = 14;
    const rect = tooltip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
    tooltip.style.left = Math.max(8, x) + "px";
    tooltip.style.top = Math.max(8, y) + "px";
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function bindTooltip(selection, htmlOf) {
    selection
      .on("pointerenter", function (event, d) { showTooltip(htmlOf(d), event); })
      .on("pointermove", function (event) { moveTooltip(event); })
      .on("pointerleave", hideTooltip)
      .on("click", function (event, d) {
        showTooltip(htmlOf(d), event);
        event.stopPropagation();
      });
  }
  document.addEventListener("click", hideTooltip);

  function renderLegend(containerId, items) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = items
      .map(function (it) {
        return '<span class="legend-item"><span class="legend-swatch" style="background:' +
          it.color + '"></span>' + escapeHtml(it.label) + "</span>";
      })
      .join("");
  }

  function chartSize(container, aspect, minH, maxH) {
    const w = container.clientWidth || 600;
    const h = Math.max(minH, Math.min(maxH, Math.round(w * aspect)));
    return { w: w, h: h };
  }

  function svgIn(container, w, h) {
    d3.select(container).selectAll("svg").remove();
    return d3
      .select(container)
      .append("svg")
      .attr("viewBox", "0 0 " + w + " " + h)
      .attr("width", "100%")
      .attr("preserveAspectRatio", "xMidYMid meet");
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function appendFact(id, sentence) {
    const el = document.getElementById(id);
    if (!el || el.dataset.factDone) return;
    el.dataset.factDone = "1";
    const strong = document.createElement("strong");
    strong.className = "narrative-fact";
    strong.textContent = " " + sentence;
    el.appendChild(strong);
  }

  /* ------------------------------------------------------------------ *
   *  Modell-Zugriffe
   * ------------------------------------------------------------------ */

  const MODELS = { muc: null, st: null };
  const META = { muc: null, st: null };
  const STATUS = { muc: null, st: null };

  function regionsLoaded() {
    return REGIONS.filter(function (r) { return MODELS[r]; });
  }

  // [{year, value}] – nur vollständige Jahre
  function annualSeries(region, metric) {
    const model = MODELS[region];
    if (!model) return [];
    const out = [];
    for (const entry of model.annual[metric]) {
      if (entry[1].complete) out.push({ region: region, year: entry[0], value: entry[1].value });
    }
    return out.sort(function (a, b) { return a.year - b.year; });
  }

  function annualValue(region, metric, year) {
    const model = MODELS[region];
    if (!model) return null;
    const e = model.annual[metric].get(year);
    return e && e.complete ? e.value : null;
  }

  // [{date, year, month, value}]
  function monthlySeries(region, metric, fromYear) {
    const model = MODELS[region];
    if (!model || !model.hasMonthly) return [];
    const out = [];
    for (const entry of model.monthly[metric]) {
      const parts = entry[0].split("-");
      const y = +parts[0];
      const m = +parts[1];
      if (fromYear != null && y < fromYear) continue;
      out.push({ region: region, year: y, month: m, value: entry[1], date: new Date(y, m - 1, 15) });
    }
    return out.sort(function (a, b) { return a.date - b.date; });
  }

  // letztes Jahr, für das beide (bzw. alle geladenen) Regionen einen
  // vollständigen Jahreswert haben
  function latestCommonYear(metric) {
    const loaded = regionsLoaded();
    if (!loaded.length) return null;
    const sets = loaded.map(function (r) {
      return new Set(annualSeries(r, metric).map(function (d) { return d.year; }));
    });
    let best = null;
    for (const y of sets[0]) {
      if (sets.every(function (s) { return s.has(y); }) && (best == null || y > best)) best = y;
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   *  Gemeinsame Linien-Chart-Basis (Jahre auf der x-Achse)
   * ------------------------------------------------------------------ */

  function drawCovidBand(svg, x, margin, h, label) {
    const x0 = x(COVID_YEARS[0] - 0.5);
    const x1 = x(COVID_YEARS[1] + 0.5);
    if (!isFinite(x0) || !isFinite(x1) || x1 <= x0) return;
    svg.append("rect")
      .attr("class", "annotation-band")
      .attr("x", x0).attr("width", x1 - x0)
      .attr("y", margin.top - 16).attr("height", h - margin.top - margin.bottom + 16);
    svg.append("text")
      .attr("class", "annotation-label")
      .attr("x", (x0 + x1) / 2)
      .attr("y", margin.top - 2)
      .attr("text-anchor", "middle")
      .text(label || "Corona");
  }

  function lineChart(container, seriesList, opts) {
    const isMobile = container.clientWidth < 560;
    const { w, h } = chartSize(container, opts.aspect || 0.52, opts.minH || 300, opts.maxH || 430);
    const margin = Object.assign({ top: 30, right: 14, bottom: 34, left: 52 }, opts.margin);
    const svg = svgIn(container, w, h);

    const allPoints = seriesList.reduce(function (acc, s) { return acc.concat(s.values); }, []);
    if (!allPoints.length) return null;

    const x = d3.scaleLinear()
      .domain(d3.extent(allPoints, function (d) { return d.year; }))
      .range([margin.left, w - margin.right]);
    const yMax = opts.yMax != null ? opts.yMax : d3.max(allPoints, function (d) { return d.value; });
    const yMin = opts.yMin != null ? opts.yMin : 0;
    const y = d3.scaleLinear().domain([yMin, yMax]).nice().range([h - margin.bottom, margin.top]);

    if (opts.covidBand) drawCovidBand(svg, x, margin, h, opts.covidLabel);

    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(0," + (h - margin.bottom) + ")")
      .call(d3.axisBottom(x).ticks(isMobile ? 5 : 9).tickFormat(d3.format("d")).tickSizeOuter(0));

    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(" + margin.left + ",0)")
      .call(d3.axisLeft(y).ticks(5).tickFormat(opts.tickFormat || fmtCompact)
        .tickSize(-(w - margin.left - margin.right)))
      .call(function (g) { g.selectAll(".tick line").attr("class", "grid-line"); })
      .call(function (g) { g.select(".domain").remove(); });

    const line = d3.line()
      .x(function (d) { return x(d.year); })
      .y(function (d) { return y(d.value); });

    for (const s of seriesList) {
      if (!s.values.length) continue;
      svg.append("path")
        .datum(s.values)
        .attr("fill", "none")
        .attr("stroke", s.color)
        .attr("stroke-width", 2.5)
        .attr("stroke-dasharray", s.dashed ? "5 5" : null)
        .attr("d", line);
      svg.append("g")
        .selectAll("circle")
        .data(s.values)
        .join("circle")
        .attr("cx", function (d) { return x(d.year); })
        .attr("cy", function (d) { return y(d.value); })
        .attr("r", isMobile ? 3 : 3.5)
        .attr("fill", s.color)
        .call(bindTooltip, opts.tooltipOf);
    }
    return { svg: svg, x: x, y: y, w: w, h: h, margin: margin };
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 1 — Zwei Jahrzehnte (Jahreswerte beider Regionen)
   * ------------------------------------------------------------------ */

  let DECADES_METRIC = "overnights";
  const METRIC_LABELS = { overnights: "Übernachtungen", arrivals: "Gästeankünfte" };

  function renderDecades() {
    const container = document.getElementById("chartDecades");
    const seriesList = regionsLoaded()
      .map(function (r) {
        return {
          region: r,
          color: COLORS[r],
          values: annualSeries(r, DECADES_METRIC),
        };
      })
      .filter(function (s) { return s.values.length; });
    if (!seriesList.length) {
      container.textContent = "Keine Jahreswerte verfügbar.";
      return;
    }

    lineChart(container, seriesList, {
      covidBand: true,
      tooltipOf: function (d) {
        const rows = REGIONS.map(function (r) {
          const v = annualValue(r, DECADES_METRIC, d.year);
          return v == null ? "" :
            "<tr><td>" + REGION_LABELS[r] + "</td><td>" + fmtCompact(v) + "</td></tr>";
        }).join("");
        return "<h4>" + d.year + " · " + METRIC_LABELS[DECADES_METRIC] + "</h4><table>" + rows + "</table>";
      },
    });

    renderLegend("legendDecades", seriesList.map(function (s) {
      return { color: s.color, label: REGION_LABELS[s.region] };
    }));

    const years = seriesList[0].values;
    setText("subDecades",
      years[0].year + "–" + years[years.length - 1].year + " · " +
      METRIC_LABELS[DECADES_METRIC] + " pro Jahr · nur vollständige Jahre");

    const y = latestCommonYear("overnights");
    const st = y != null ? annualValue("st", "overnights", y) : null;
    const muc = y != null ? annualValue("muc", "overnights", y) : null;
    if (st != null && muc != null && muc > 0) {
      appendFact("narrativeDecades",
        "Im Jahr " + y + " zählte Südtirol " + fmtCompact(st) +
        " Übernachtungen – das " + fmt1.format(st / muc) +
        "-Fache der Stadt München (" + fmtCompact(muc) + ").");
    }
    const note = MODELS.st && !MODELS.st.hasMonthly
      ? "Südtirol liegt in dieser Quelle nur mit Jahreswerten vor."
      : "";
    setText("noteDecades", note);
  }

  function setupMetricToggle() {
    const wrap = document.getElementById("metricToggle");
    if (!wrap) return;
    wrap.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        DECADES_METRIC = btn.dataset.metric;
        wrap.querySelectorAll("button").forEach(function (b) {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        renderDecades();
      });
    });
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 2 — Saisonprofil (mittlerer Monatsanteil an der Jahressumme)
   * ------------------------------------------------------------------ */

  function seasonProfile(region, metric) {
    const model = MODELS[region];
    if (!model || !model.hasMonthly) return null;
    const perMonth = new Array(12).fill(0);
    const counts = new Array(12).fill(0);
    for (const year of model.years) {
      if (COVID_YEARS.includes(year)) continue; // verzerrte Jahre ausklammern
      let sum = 0;
      const vals = [];
      for (let m = 1; m <= 12; m++) {
        const v = model.monthly[metric].get(year + "-" + m);
        if (v == null) { vals.length = 0; break; }
        vals.push(v);
        sum += v;
      }
      if (!vals.length || sum <= 0) continue;
      for (let m = 0; m < 12; m++) {
        perMonth[m] += vals[m] / sum;
        counts[m] += 1;
      }
    }
    if (!counts[0]) return null;
    return perMonth.map(function (v, i) { return v / counts[i]; });
  }

  function renderSeason() {
    const container = document.getElementById("chartSeason");
    const metric = "overnights";
    const profiles = regionsLoaded()
      .map(function (r) { return { region: r, profile: seasonProfile(r, metric) }; })
      .filter(function (d) { return d.profile; });

    if (!profiles.length) {
      container.textContent = "Für keine der beiden Regionen liegen Monatswerte vor.";
      return;
    }

    const isMobile = container.clientWidth < 560;
    const { w, h } = chartSize(container, 0.52, 300, 430);
    const margin = { top: 18, right: 14, bottom: 34, left: 44 };
    const svg = svgIn(container, w, h);

    const x = d3.scalePoint().domain(d3.range(12)).range([margin.left, w - margin.right]);
    const maxShare = d3.max(profiles, function (p) { return d3.max(p.profile); });
    const y = d3.scaleLinear().domain([0, maxShare]).nice().range([h - margin.bottom, margin.top]);

    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(0," + (h - margin.bottom) + ")")
      .call(d3.axisBottom(x)
        .tickValues(isMobile ? [0, 2, 4, 6, 8, 10] : d3.range(12))
        .tickFormat(function (i) { return MONTH_LABELS[i]; })
        .tickSizeOuter(0));

    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(" + margin.left + ",0)")
      .call(d3.axisLeft(y).ticks(5).tickFormat(function (v) { return Math.round(v * 100) + " %"; })
        .tickSize(-(w - margin.left - margin.right)))
      .call(function (g) { g.selectAll(".tick line").attr("class", "grid-line"); })
      .call(function (g) { g.select(".domain").remove(); });

    // Referenz: gleichverteilte Monate (1/12)
    svg.append("line")
      .attr("x1", margin.left).attr("x2", w - margin.right)
      .attr("y1", y(1 / 12)).attr("y2", y(1 / 12))
      .attr("stroke", "#cdd5e0").attr("stroke-dasharray", "3 5");
    svg.append("text")
      .attr("x", w - margin.right - 4).attr("y", y(1 / 12) - 5)
      .attr("text-anchor", "end").attr("font-size", 10).attr("fill", "#8a93a6")
      .text("gleichmäßig (1/12)");

    const line = d3.line()
      .x(function (d, i) { return x(i); })
      .y(function (d) { return y(d); })
      .curve(d3.curveMonotoneX);

    for (const p of profiles) {
      svg.append("path")
        .datum(p.profile)
        .attr("fill", "none")
        .attr("stroke", COLORS[p.region])
        .attr("stroke-width", 2.5)
        .attr("d", line);
      svg.append("g")
        .selectAll("circle")
        .data(p.profile.map(function (v, i) { return { region: p.region, month: i, share: v }; }))
        .join("circle")
        .attr("cx", function (d) { return x(d.month); })
        .attr("cy", function (d) { return y(d.share); })
        .attr("r", isMobile ? 3 : 3.5)
        .attr("fill", COLORS[p.region])
        .call(bindTooltip, function (d) {
          const rows = profiles.map(function (pp) {
            return "<tr><td>" + REGION_LABELS[pp.region] + "</td><td>" +
              fmt1.format(pp.profile[d.month] * 100) + " %</td></tr>";
          }).join("");
          return "<h4>" + MONTH_LABELS[d.month] + " · Anteil an der Jahressumme</h4><table>" + rows + "</table>";
        });
    }

    renderLegend("legendSeason", profiles.map(function (p) {
      return { color: COLORS[p.region], label: REGION_LABELS[p.region] };
    }));

    const missing = regionsLoaded().filter(function (r) {
      return !profiles.some(function (p) { return p.region === r; });
    });
    setText("noteSeason", missing.length
      ? "Für " + missing.map(function (r) { return REGION_LABELS[r]; }).join(" und ") +
        " liegen in der geladenen Quelle keine Monatswerte vor."
      : "Corona-Jahre (2020/21) sind im Mittelwert ausgeklammert.");
    setText("subSeason", "Mittlerer Anteil je Monat an den Übernachtungen eines Jahres");

    const stP = profiles.find(function (p) { return p.region === "st"; });
    const mucP = profiles.find(function (p) { return p.region === "muc"; });
    if (mucP) {
      const mucPeak = mucP.profile.indexOf(d3.max(mucP.profile));
      let sentence = "Münchens stärkster Monat ist der " + ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"][mucPeak] + ".";
      if (stP) {
        const stPeak = stP.profile.indexOf(d3.max(stP.profile));
        sentence = "Münchens stärkster Monat ist der " +
          ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"][mucPeak] +
          " – Südtirols der " +
          ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"][stPeak] + ".";
      }
      appendFact("narrativeSeason", sentence);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 3 — Corona: Absturz und Erholung (Index, Basis 2019)
   * ------------------------------------------------------------------ */

  function renderCorona() {
    const container = document.getElementById("chartCorona");
    const metric = "overnights";
    const BASE_YEAR = 2019;
    const FROM_YEAR = 2019;

    const seriesList = [];
    for (const r of regionsLoaded()) {
      const model = MODELS[r];
      if (model.hasMonthly) {
        const base = new Map();
        for (let m = 1; m <= 12; m++) {
          const v = model.monthly[metric].get(BASE_YEAR + "-" + m);
          if (v != null && v > 0) base.set(m, v);
        }
        if (base.size < 10) continue;
        const values = monthlySeries(r, metric, FROM_YEAR)
          .filter(function (d) { return base.has(d.month); })
          .map(function (d) {
            return { region: r, date: d.date, year: d.year, month: d.month, value: (d.value / base.get(d.month)) * 100 };
          });
        if (values.length) seriesList.push({ region: r, color: COLORS[r], values: values, monthly: true });
      } else {
        const baseEntry = model.annual[metric].get(BASE_YEAR);
        if (!baseEntry || !baseEntry.complete || baseEntry.value <= 0) continue;
        const values = annualSeries(r, metric)
          .filter(function (d) { return d.year >= FROM_YEAR; })
          .map(function (d) {
            return { region: r, date: new Date(d.year, 6, 1), year: d.year, month: null, value: (d.value / baseEntry.value) * 100 };
          });
        if (values.length) seriesList.push({ region: r, color: COLORS[r], values: values, monthly: false });
      }
    }

    if (!seriesList.length) {
      container.textContent = "Für den Vergleich mit 2019 fehlen Daten.";
      return;
    }

    const isMobile = container.clientWidth < 560;
    const { w, h } = chartSize(container, 0.56, 320, 460);
    const margin = { top: 26, right: 14, bottom: 34, left: 44 };
    const svg = svgIn(container, w, h);

    const allPoints = seriesList.reduce(function (acc, s) { return acc.concat(s.values); }, []);
    const x = d3.scaleTime()
      .domain(d3.extent(allPoints, function (d) { return d.date; }))
      .range([margin.left, w - margin.right]);
    const y = d3.scaleLinear()
      .domain([0, Math.max(120, d3.max(allPoints, function (d) { return d.value; }))]).nice()
      .range([h - margin.bottom, margin.top]);

    // Band: erster Lockdown bis Ende der Beherbergungsverbote
    const band0 = new Date(2020, 2, 1);
    const band1 = new Date(2021, 5, 1);
    if (x(band1) > x(band0)) {
      svg.append("rect")
        .attr("class", "annotation-band")
        .attr("x", x(band0)).attr("width", x(band1) - x(band0))
        .attr("y", margin.top - 14).attr("height", h - margin.top - margin.bottom + 14);
      svg.append("text")
        .attr("class", "annotation-label")
        .attr("x", (x(band0) + x(band1)) / 2)
        .attr("y", margin.top - 2)
        .attr("text-anchor", "middle")
        .text("Lockdowns & Reisebeschränkungen");
    }

    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(0," + (h - margin.bottom) + ")")
      .call(d3.axisBottom(x).ticks(isMobile ? 4 : 7).tickSizeOuter(0));

    svg.append("g")
      .attr("class", "axis")
      .attr("transform", "translate(" + margin.left + ",0)")
      .call(d3.axisLeft(y).ticks(5).tickFormat(function (v) { return v + " %"; })
        .tickSize(-(w - margin.left - margin.right)))
      .call(function (g) { g.selectAll(".tick line").attr("class", "grid-line"); })
      .call(function (g) { g.select(".domain").remove(); });

    // 100-%-Referenz (Niveau von 2019)
    svg.append("line")
      .attr("x1", margin.left).attr("x2", w - margin.right)
      .attr("y1", y(100)).attr("y2", y(100))
      .attr("stroke", "#9aa3b5").attr("stroke-width", 1).attr("stroke-dasharray", "4 4");
    svg.append("text")
      .attr("x", w - margin.right - 4).attr("y", y(100) - 5)
      .attr("text-anchor", "end").attr("font-size", 10).attr("fill", "#8a93a6")
      .text("Niveau 2019");

    const line = d3.line()
      .x(function (d) { return x(d.date); })
      .y(function (d) { return y(d.value); });

    for (const s of seriesList) {
      svg.append("path")
        .datum(s.values)
        .attr("fill", "none")
        .attr("stroke", s.color)
        .attr("stroke-width", 2.2)
        .attr("stroke-dasharray", s.monthly ? null : "5 5")
        .attr("d", line);
      svg.append("g")
        .selectAll("circle")
        .data(s.monthly && isMobile ? [] : s.values)
        .join("circle")
        .attr("cx", function (d) { return x(d.date); })
        .attr("cy", function (d) { return y(d.value); })
        .attr("r", s.monthly ? 2.4 : 3.5)
        .attr("fill", s.color)
        .call(bindTooltip, function (d) {
          const when = d.month != null ? MONTH_LABELS[d.month - 1] + " " + d.year : "Jahr " + d.year;
          return "<h4>" + REGION_LABELS[d.region] + " · " + when + "</h4><table>" +
            "<tr><td>Übernachtungen</td><td>" + fmtInt.format(Math.round(d.value)) +
            " % des 2019-Niveaus</td></tr></table>";
        });
    }

    renderLegend("legendCorona", seriesList.map(function (s) {
      return {
        color: s.color,
        label: REGION_LABELS[s.region] + (s.monthly ? "" : " (Jahreswerte)"),
      };
    }));
    setText("subCorona", "Übernachtungen relativ zum jeweiligen Monat bzw. Jahr 2019 (= 100 %)");

    // Tiefpunkte als Fakt
    const facts = [];
    for (const s of seriesList) {
      if (!s.monthly) continue;
      const low = s.values.reduce(function (a, b) { return b.value < a.value ? b : a; });
      facts.push(REGION_LABELS[s.region] + " fiel im " + MONTH_LABELS[low.month - 1] + " " + low.year +
        " auf " + fmtInt.format(Math.round(low.value)) + " % des Vorkrisenniveaus");
    }
    if (facts.length) appendFact("narrativeCorona", facts.join("; ") + ".");
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 4 — Herkunft: Inland vs. Ausland
   * ------------------------------------------------------------------ */

  function foreignShareSeries(region, metric) {
    const model = MODELS[region];
    if (!model || !model.hasOrigin) return [];
    const out = [];
    const dom = model.annualByOrigin[metric].domestic;
    const for_ = model.annualByOrigin[metric].foreign;
    for (const entry of dom) {
      const year = entry[0];
      const d = entry[1];
      const f = for_.get(year);
      if (!f || !d.complete || !f.complete) continue;
      const total = d.value + f.value;
      if (total <= 0) continue;
      out.push({ region: region, year: year, value: f.value / total });
    }
    return out.sort(function (a, b) { return a.year - b.year; });
  }

  function renderOrigin() {
    const container = document.getElementById("chartOrigin");
    const metric = "overnights";
    const seriesList = regionsLoaded()
      .map(function (r) {
        return { region: r, color: COLORS[r], values: foreignShareSeries(r, metric) };
      })
      .filter(function (s) { return s.values.length >= 3; });

    if (!seriesList.length) {
      container.textContent = "Die geladenen Quellen enthalten keine Inland/Ausland-Aufschlüsselung.";
      setText("subOrigin", "");
      return;
    }

    lineChart(container, seriesList, {
      covidBand: true,
      yMax: Math.min(1, (d3.max(seriesList, function (s) {
        return d3.max(s.values, function (d) { return d.value; });
      }) || 0.5) * 1.15),
      tickFormat: function (v) { return Math.round(v * 100) + " %"; },
      tooltipOf: function (d) {
        return "<h4>" + REGION_LABELS[d.region] + " · " + d.year + "</h4><table>" +
          "<tr><td>Übernachtungen von Gästen aus dem Ausland</td><td>" + fmtPct(d.value) + "</td></tr></table>";
      },
    });

    renderLegend("legendOrigin", seriesList.map(function (s) {
      return { color: s.color, label: REGION_LABELS[s.region] };
    }));

    const missing = regionsLoaded().filter(function (r) {
      return !seriesList.some(function (s) { return s.region === r; });
    });
    setText("noteOrigin", missing.length
      ? "Für " + missing.map(function (r) { return REGION_LABELS[r]; }).join(" und ") +
        " enthält die geladene Quelle keine Herkunfts-Aufschlüsselung."
      : "");
    setText("subOrigin", "Auslandsanteil an den Übernachtungen pro Jahr");

    const last = seriesList.map(function (s) {
      const d = s.values[s.values.length - 1];
      return REGION_LABELS[s.region] + " " + fmtPct(d.value) + " (" + d.year + ")";
    });
    appendFact("narrativeOrigin", "Zuletzt kam aus dem Ausland: " + last.join(", ") + ".");
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 5 — Aufenthaltsdauer (Übernachtungen je Ankunft)
   * ------------------------------------------------------------------ */

  function staySeries(region) {
    const arrivals = annualSeries(region, "arrivals");
    const out = [];
    for (const a of arrivals) {
      const o = annualValue(region, "overnights", a.year);
      if (o == null || a.value <= 0) continue;
      out.push({ region: region, year: a.year, value: o / a.value });
    }
    return out;
  }

  function renderStay() {
    const container = document.getElementById("chartStay");
    const seriesList = regionsLoaded()
      .map(function (r) { return { region: r, color: COLORS[r], values: staySeries(r) }; })
      .filter(function (s) { return s.values.length >= 3; });

    if (!seriesList.length) {
      container.textContent = "Für die Aufenthaltsdauer fehlen Ankunfts- oder Übernachtungszahlen.";
      setText("subStay", "");
      return;
    }

    lineChart(container, seriesList, {
      covidBand: true,
      yMin: 0,
      yMax: (d3.max(seriesList, function (s) {
        return d3.max(s.values, function (d) { return d.value; });
      }) || 4) * 1.15,
      tickFormat: function (v) { return fmt1.format(v); },
      tooltipOf: function (d) {
        return "<h4>" + REGION_LABELS[d.region] + " · " + d.year + "</h4><table>" +
          "<tr><td>Übernachtungen je Gast</td><td>" + fmt1.format(d.value) + " Nächte</td></tr></table>";
      },
    });

    renderLegend("legendStay", seriesList.map(function (s) {
      return { color: s.color, label: REGION_LABELS[s.region] };
    }));
    setText("subStay", "Übernachtungen ÷ Ankünfte = mittlere Aufenthaltsdauer in Nächten");

    const parts = seriesList.map(function (s) {
      const d = s.values[s.values.length - 1];
      return REGION_LABELS[s.region] + " " + fmt1.format(d.value) + " Nächte";
    });
    appendFact("narrativeStay", "Zuletzt blieben Gäste im Schnitt: " + parts.join(", ") + ".");
  }

  /* ------------------------------------------------------------------ *
   *  Kapitel 6 — Explorer-Tabelle (Jahreswerte beider Regionen)
   * ------------------------------------------------------------------ */

  function renderTable() {
    const rows = [];
    for (const r of regionsLoaded()) {
      const arr = new Map(annualSeries(r, "arrivals").map(function (d) { return [d.year, d.value]; }));
      const ov = new Map(annualSeries(r, "overnights").map(function (d) { return [d.year, d.value]; }));
      const fs = new Map(foreignShareSeries(r, "overnights").map(function (d) { return [d.year, d.value]; }));
      const years = new Set();
      for (const y of arr.keys()) years.add(y);
      for (const y of ov.keys()) years.add(y);
      for (const year of years) {
        const a = arr.get(year);
        const o = ov.get(year);
        rows.push({
          year: year,
          region: REGION_LABELS[r],
          arrivals: a != null ? a : null,
          overnights: o != null ? o : null,
          stay: a > 0 && o != null ? o / a : null,
          foreign: fs.has(year) ? fs.get(year) : null,
        });
      }
    }
    if (!rows.length) return;

    const columns = [
      { key: "year", label: "Jahr", num: true },
      { key: "region", label: "Region", num: false },
      { key: "arrivals", label: "Ankünfte", num: true },
      { key: "overnights", label: "Übernachtungen", num: true },
      { key: "stay", label: "Ø Nächte/Gast", num: true, fmt: function (v) { return fmt1.format(v); } },
      { key: "foreign", label: "Auslandsanteil", num: true, fmt: function (v) { return fmtPct(v); } },
    ];
    const visible = columns.filter(function (c) {
      return rows.some(function (d) { return d[c.key] != null && d[c.key] !== ""; });
    });

    const thead = document.querySelector("#dataTable thead");
    const tbody = document.querySelector("#dataTable tbody");
    const search = document.getElementById("tableSearch");
    const countEl = document.getElementById("tableCount");

    let sortKey = "year";
    let sortDir = -1;

    function draw() {
      const q = (search.value || "").toLowerCase();
      let shown = rows.filter(function (d) {
        return !q ||
          String(d.year).includes(q) ||
          d.region.toLowerCase().includes(q);
      });
      shown = shown.slice().sort(function (a, b) {
        const va = a[sortKey], vb = b[sortKey];
        if (va == null || va === "") return 1;
        if (vb == null || vb === "") return -1;
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * sortDir;
        return String(va).localeCompare(String(vb), "de") * sortDir;
      });

      thead.innerHTML =
        "<tr>" +
        visible.map(function (c) {
          return "<th data-key=\"" + c.key + "\">" + c.label +
            (c.key === sortKey
              ? '<span class="sort-ind">' + (sortDir > 0 ? "▲" : "▼") + "</span>"
              : "") +
            "</th>";
        }).join("") +
        "</tr>";

      tbody.innerHTML = shown.map(function (d) {
        return "<tr>" +
          visible.map(function (c) {
            const v = d[c.key];
            if (v == null || v === "") return '<td class="' + (c.num ? "num" : "") + '">–</td>';
            let text;
            if (c.fmt && typeof v === "number") text = c.fmt(v);
            else if (c.num && typeof v === "number" && c.key !== "year") text = fmtInt.format(v);
            else text = escapeHtml(String(v));
            return '<td class="' + (c.num ? "num" : "") + '">' + text + "</td>";
          }).join("") +
          "</tr>";
      }).join("");

      countEl.textContent =
        fmtInt.format(shown.length) + " von " + fmtInt.format(rows.length) + " Jahreszeilen";

      thead.querySelectorAll("th").forEach(function (th) {
        th.addEventListener("click", function () {
          const key = th.dataset.key;
          if (key === sortKey) sortDir *= -1;
          else {
            sortKey = key;
            sortDir = visible.find(function (c) { return c.key === key; }).num ? -1 : 1;
          }
          draw();
        });
      });
    }

    search.addEventListener("input", draw);
    draw();
  }

  /* ------------------------------------------------------------------ *
   *  KPIs
   * ------------------------------------------------------------------ */

  function animateKpi(el, target, format) {
    if (target == null) { el.textContent = "–"; return; }
    const dur = 1300;
    const start = performance.now();
    const ease = d3.easeCubicOut;
    function tick(now) {
      const t = Math.min(1, (now - start) / dur);
      el.textContent = format(target * ease(t));
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = format(target);
    }
    requestAnimationFrame(tick);
  }

  function renderKpis() {
    const y = latestCommonYear("overnights");
    const st = y != null ? annualValue("st", "overnights", y) : null;
    const muc = y != null ? annualValue("muc", "overnights", y) : null;
    let yearSpan = null;
    const allYears = regionsLoaded().reduce(function (acc, r) {
      return acc.concat(MODELS[r].years);
    }, []);
    if (allYears.length) {
      yearSpan = Math.max.apply(null, allYears) - Math.min.apply(null, allYears) + 1;
    }
    const kpis = {
      stOvernights: [st, fmtCompact],
      mucOvernights: [muc, fmtCompact],
      factor: [st != null && muc > 0 ? st / muc : null, function (v) { return fmt1.format(v) + "×"; }],
      years: [yearSpan, function (v) { return fmtInt.format(Math.round(v)); }],
    };
    document.querySelectorAll("[data-kpi]").forEach(function (el) {
      const pair = kpis[el.dataset.kpi] || [null, fmtInt.format];
      animateKpi(el, pair[0], pair[1]);
    });
    if (y != null) {
      setText("kpiFootnote", "* Übernachtungen im Jahr " + y +
        " – dem letzten Jahr mit vollständigen Werten für beide Regionen.");
    }
  }

  /* ------------------------------------------------------------------ *
   *  Metadaten (Lizenz, Stand) je Portal — best effort
   * ------------------------------------------------------------------ */

  function renderMetadata(region) {
    const pkg = META[region];
    if (!pkg) return;
    const suffix = region === "muc" ? "Muc" : "St";
    const src = SOURCES[region];
    const titleEl = document.getElementById("datasetTitle" + suffix);
    if (titleEl && pkg.title) titleEl.textContent = "„" + pkg.title + "“";
    if (pkg.license_title || pkg.license_id) {
      const licenseEl = document.getElementById("licenseInfo" + suffix);
      if (licenseEl) {
        const name = escapeHtml(pkg.license_title || pkg.license_id);
        const url = pkg.license_url
          ? ' (<a href="' + escapeHtml(pkg.license_url) + '" rel="noopener">Lizenztext</a>)'
          : "";
        licenseEl.innerHTML = "Lizenz: <strong>" + name + "</strong>" + url +
          ' · Quelle: <a href="' + escapeHtml(src.datasetPage) + '" rel="noopener">Datensatzseite</a>';
      }
    }
    const modified = pkg.metadata_modified || pkg.metadata_created;
    if (modified) {
      const d = new Date(modified);
      if (!isNaN(+d)) {
        setText("freshnessInfo" + suffix,
          "Metadaten zuletzt aktualisiert am " +
          d.toLocaleDateString("de-DE", { year: "numeric", month: "long", day: "numeric" }) + ".");
      }
    }
  }

  /* ------------------------------------------------------------------ *
   *  Scroll-Reveal & Resize
   * ------------------------------------------------------------------ */

  function setupReveal() {
    const els = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("visible"); });
      return;
    }
    const io = new IntersectionObserver(
      function (entries) {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("visible");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12 }
    );
    els.forEach(function (el) { io.observe(el); });
  }

  function renderAllCharts() {
    if (!regionsLoaded().length) return;
    renderDecades();
    renderSeason();
    renderCorona();
    renderOrigin();
    renderStay();
  }

  function setupResize() {
    let raf = null;
    let lastW = window.innerWidth;
    window.addEventListener("resize", function () {
      if (window.innerWidth === lastW) return; // mobile Adressleiste ignorieren
      lastW = window.innerWidth;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () { setTimeout(renderAllCharts, 120); });
    });

    // Charts neu zeichnen, wenn sich die Containerbreite nachträglich ändert
    // (Fonts/Layout auf Mobilgeräten, Gerätedrehung). Nur Breitenänderungen
    // lösen aus, damit das Neuzeichnen selbst keine Schleife erzeugt.
    if ("ResizeObserver" in window) {
      const widths = new Map();
      let pending = null;
      const containers = document.querySelectorAll(".chart");
      containers.forEach(function (c) {
        widths.set(c, Math.round(c.getBoundingClientRect().width));
      });
      const ro = new ResizeObserver(function (entries) {
        let changed = false;
        for (const e of entries) {
          const w = Math.round(e.contentRect.width);
          if (widths.get(e.target) !== w) {
            widths.set(e.target, w);
            changed = true;
          }
        }
        if (changed) {
          clearTimeout(pending);
          pending = setTimeout(renderAllCharts, 150);
        }
      });
      containers.forEach(function (c) { ro.observe(c); });
    }
  }

  /* ------------------------------------------------------------------ *
   *  Bootstrap
   * ------------------------------------------------------------------ */

  function statusLabel(region) {
    const s = STATUS[region];
    if (!s) return REGION_LABELS[region] + ": nicht erreichbar";
    return REGION_LABELS[region] + ": " +
      (s.origin === "live" ? "Live (" + s.via + ")" : "Snapshot");
  }

  async function main() {
    setupReveal();
    setupMetricToggle();
    const statusEl = document.getElementById("dataStatus");

    const results = await Promise.allSettled([loadSource(SOURCES.muc), loadSource(SOURCES.st)]);
    const failures = [];
    REGIONS.forEach(function (r, i) {
      const res = results[i];
      if (res.status === "fulfilled") {
        MODELS[r] = res.value.model;
        META[r] = res.value.pkg;
        STATUS[r] = res.value;
      } else {
        failures.push(REGION_LABELS[r] + ": " +
          ((res.reason && res.reason.attempts) || [res.reason && res.reason.message || "Fehler"]).join(" · "));
      }
    });

    const loaded = regionsLoaded();
    if (!loaded.length) {
      statusEl.textContent = "Daten konnten nicht geladen werden.";
      statusEl.classList.add("warn");
      document.getElementById("storyRoot").hidden = true;
      const panel = document.getElementById("errorPanel");
      panel.hidden = false;
      document.getElementById("errorDetail").textContent = failures.join(" — ");
      return;
    }

    statusEl.textContent = REGIONS.map(statusLabel).join(" · ");
    statusEl.classList.add(
      loaded.length === 2 && REGIONS.every(function (r) { return STATUS[r] && STATUS[r].origin === "live"; })
        ? "ok" : "warn");

    if (loaded.length < 2) {
      const note = document.getElementById("partialNote");
      if (note) {
        note.hidden = false;
        const missing = REGIONS.filter(function (r) { return !MODELS[r]; })
          .map(function (r) { return REGION_LABELS[r]; }).join(" und ");
        note.querySelector("p").textContent =
          "Die Daten für " + missing + " sind gerade nicht erreichbar – die Geschichte " +
          "zeigt vorerst nur die verfügbare Region. Ein erneutes Laden der Seite versucht es noch einmal.";
      }
    }

    renderKpis();
    renderAllCharts();
    renderTable();
    setupResize();
    REGIONS.forEach(renderMetadata);
  }

  main();
})();
