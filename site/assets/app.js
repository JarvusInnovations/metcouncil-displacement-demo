/* The explorer page: map, controls, selection panel, statements. */
(function () {
  "use strict";
  const { METRICS, RAMP, WITHHELD, pct, pct1, num, periodLabel, binColor, barChart, dataTable, statements, COLS, slug, dateText } = window.SAX;

  const state = { mode: "all", year: null, metric: "renter_share", planned: true, sel: null, line: "" };
  let data, map;
  const $ = (id) => document.getElementById(id);
  const base = new URL(window.SAX.ROOT || ".", location.href).href;

  /* ---------- URL state: every selection has its own address ---------- */
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get("mode")) state.mode = p.get("mode");
    if (p.get("year")) state.year = +p.get("year");
    if (p.get("metric") && METRICS[p.get("metric")]) state.metric = p.get("metric");
    if (p.get("planned") === "0") state.planned = false;
    if (p.get("line")) state.line = p.get("line");
    const s = p.get("sel");
    if (s && s.includes(":")) state.sel = { kind: s.split(":")[0], id: s.split(":").slice(1).join(":") };
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (state.sel) p.set("sel", state.sel.kind + ":" + state.sel.id);
    if (state.line) p.set("line", state.line);
    if (state.mode !== "all") p.set("mode", state.mode);
    if (state.year && data.meta.years.length && state.year !== last(data.meta.years)) p.set("year", state.year);
    if (state.metric !== "renter_share") p.set("metric", state.metric);
    if (!state.planned) p.set("planned", "0");
    const h = p.toString();
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
    $("print-link").href = SAX.ROOT + "print.html" + (h ? "#" + h : "");
  }
  const last = (a) => a[a.length - 1];
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  /* ---------- Map ---------- */
  function basemapStyle(layers) {
    const dark = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
    return {
      version: 8,
      glyphs: base + "basemap/fonts/{fontstack}/{range}.pbf",
      sources: {
        protomaps: {
          type: "vector",
          tiles: [base + "basemap/tiles/{z}/{x}/{y}.pbf"],
          minzoom: 0,
          maxzoom: 13,
          bounds: [-94.1, 44.4, -92.6, 45.5],
          attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>, <a href="https://protomaps.com">Protomaps</a>',
        },
      },
      layers: dark ? layers.dark : layers.light,
    };
  }

  function lineFilter() {
    const f = ["all"];
    if (state.mode !== "all") f.push(["==", ["get", "MODE"], state.mode]);
    if (!state.planned) f.push(["==", ["get", "RT_STATUS"], "Existing"]);
    if (state.line) f.push(["==", ["get", "RT_NAME"], state.line]);
    return f;
  }
  function areaFilter() {
    const f = ["all"];
    if (state.mode !== "all") f.push(["==", ["get", "mode"], state.mode]);
    if (!state.planned) f.push(["==", ["get", "status"], "Existing"]);
    if (state.line) f.push(["==", ["get", "line"], state.line]);
    return f;
  }

  function colorAreas() {
    const src = map.getSource("points");
    if (!src) return;
    for (const f of data.areas.features) {
      const r = state.year ? data.fig("station_area", f.properties.id, state.year) : null;
      const v = r && !r.withheld ? r[state.metric] : null;
      map.setFeatureState({ source: "points", id: f.id }, { color: state.year ? binColor(state.metric, v) : "#ffffff", withheld: !!(r && r.withheld) });
    }
  }

  function addLayers() {
    map.addSource("corridors", { type: "geojson", data: data.corridors });
    map.addSource("hfn", { type: "geojson", data: data.hfn });
    map.addSource("alignments", { type: "geojson", data: data.alignments });
    map.addSource("areas", { type: "geojson", data: data.areas });
    const points = {
      type: "FeatureCollection",
      features: data.areas.features.map((f) => ({ type: "Feature", id: f.id, properties: f.properties, geometry: { type: "Point", coordinates: [f.properties.lon, f.properties.lat] } })),
    };
    map.addSource("points", { type: "geojson", data: points });

    map.addLayer({ id: "corridor-sel-fill", type: "fill", source: "corridors", filter: ["==", ["get", "id"], ""], paint: { "fill-color": "#6250d6", "fill-opacity": 0.08 } });
    map.addLayer({ id: "corridor-sel-line", type: "line", source: "corridors", filter: ["==", ["get", "id"], ""], paint: { "line-color": "#6250d6", "line-width": 1.5, "line-dasharray": [2, 1] } });
    map.addLayer({ id: "hfn", type: "line", source: "hfn", paint: { "line-color": css("--hfn"), "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 14, 2.5], "line-opacity": 0.75 } });
    map.addLayer({ id: "align-casing", type: "line", source: "alignments", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": css("--bg"), "line-width": ["interpolate", ["linear"], ["zoom"], 9, 4, 14, 9] } });
    for (const planned of [false, true]) {
      map.addLayer({
        id: planned ? "align-planned" : "align",
        type: "line",
        source: "alignments",
        layout: { "line-cap": planned ? "butt" : "round", "line-join": "round" },
        paint: {
          "line-color": ["match", ["get", "MODE"], "LRT", css("--lrt"), css("--brt")],
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2, 14, 5],
          ...(planned ? { "line-dasharray": [1.6, 1.2] } : {}),
        },
      });
    }
    map.addLayer({ id: "area-sel-fill", type: "fill", source: "areas", filter: ["==", ["get", "id"], ""], paint: { "fill-color": "#2a78d6", "fill-opacity": 0.12 } });
    map.addLayer({ id: "area-sel-line", type: "line", source: "areas", filter: ["==", ["get", "id"], ""], paint: { "line-color": "#0d366b", "line-width": 2 } });
    map.addLayer({ id: "area-hover", type: "line", source: "areas", filter: ["==", ["get", "id"], ""], paint: { "line-color": "#0d366b", "line-width": 1, "line-dasharray": [2, 2] } });
    map.addLayer({
      id: "points",
      type: "circle",
      source: "points",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3.5, 12, 6, 15, 9],
        "circle-color": ["coalesce", ["feature-state", "color"], "#ffffff"],
        "circle-stroke-color": ["case", ["boolean", ["feature-state", "withheld"], false], "#52514e", css("--pt-stroke")],
        "circle-stroke-width": ["case", ["boolean", ["feature-state", "withheld"], false], 2, 1.25],
      },
    });
    map.addLayer({ id: "points-sel", type: "circle", source: "points", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 7, 15, 13], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#d97706", "circle-stroke-width": 3 } });

    const pick = (e) => {
      const f = e.features && e.features[0];
      if (f) select({ kind: "station", id: f.properties.id }, true);
    };
    map.on("click", "points", pick);
    map.on("mousemove", "points", (e) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features[0];
      map.setFilter("area-hover", ["==", ["get", "id"], f.properties.id]);
      showTip(e.point, f.properties);
    });
    map.on("mouseleave", "points", () => {
      map.getCanvas().style.cursor = "";
      map.setFilter("area-hover", ["==", ["get", "id"], ""]);
      hideTip();
    });
    applyFilters();
    colorAreas();
  }

  let tip;
  function showTip(pt, p) {
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "tip";
      tip.setAttribute("aria-hidden", "true");
      $("map").appendChild(tip);
    }
    const r = state.year ? data.fig("station_area", p.id, state.year) : null;
    let v = "";
    if (state.year) v = r ? (r.withheld ? "Figure withheld" : METRICS[state.metric].label + ": " + pct(r[state.metric])) : "No figure";
    tip.innerHTML = "<strong></strong><span></span><em></em>";
    tip.children[0].textContent = p.name;
    tip.children[1].textContent = p.line + (p.status !== "Existing" ? " (planned)" : "");
    tip.children[2].textContent = v;
    tip.style.left = pt.x + 12 + "px";
    tip.style.top = pt.y + 12 + "px";
    tip.hidden = false;
  }
  function hideTip() {
    if (tip) tip.hidden = true;
  }

  function applyFilters() {
    if (!map || !map.getLayer("align")) return;
    const lf = lineFilter(), af = areaFilter();
    map.setFilter("align-casing", lf);
    map.setFilter("align", lf.concat([["==", ["get", "RT_STATUS"], "Existing"]]));
    map.setFilter("align-planned", lf.concat([["!=", ["get", "RT_STATUS"], "Existing"]]));
    map.setFilter("points", af);
    map.setLayoutProperty("hfn", "visibility", state.mode === "LRT" ? "none" : "visible");
  }

  /* ---------- Selection ---------- */
  function areaById(id) {
    return data.areas.features.find((f) => f.properties.id === id);
  }
  function corridorById(id) {
    return data.corridors.features.find((f) => f.properties.id === id);
  }

  function select(sel, fromMap) {
    state.sel = sel;
    // A chosen station is always shown, so clear any filter that hides it.
    const a = sel && sel.kind === "station" ? areaById(sel.id) : null;
    if (a) {
      const p = a.properties;
      let changed = false;
      if (state.line && state.line !== p.line) { state.line = ""; changed = true; }
      if (state.mode !== "all" && state.mode !== p.mode) { state.mode = "all"; changed = true; }
      if (!state.planned && p.status !== "Existing") { state.planned = true; changed = true; }
      if (changed) { syncControls(); applyFilters(); }
    }
    writeHash();
    renderPanel();
    if (!map || !map.getLayer("points")) return;
    const sid = sel && sel.kind === "station" ? sel.id : "";
    const cid = sel && sel.kind === "line" ? sel.id : "";
    map.setFilter("area-sel-fill", ["==", ["get", "id"], sid]);
    map.setFilter("area-sel-line", ["==", ["get", "id"], sid]);
    map.setFilter("points-sel", ["==", ["get", "id"], sid]);
    map.setFilter("corridor-sel-fill", ["==", ["get", "id"], cid]);
    map.setFilter("corridor-sel-line", ["==", ["get", "id"], cid]);
    if (fromMap) return;
    const f = sid ? areaById(sid) : cid ? corridorById(cid) : null;
    if (f) {
      const b = SAX.bbox(f);
      map.fitBounds(b, { padding: 60, maxZoom: sid ? 14 : 12.5, duration: reduceMotion() ? 0 : 900 });
    }
    if (sid) $("station").value = sid;
  }
  const reduceMotion = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function renderPanel() {
    const el = $("panel");
    el.innerHTML = "";
    const sel = state.sel;
    const years = data.meta.years || [];
    const P = d3.select(el);

    if (!sel) {
      P.append("h2").text("Choose a station area");
      P.append("p").text(
        "Pick a station on the map, or use the search and the lists above. Each station area is the land within half a mile of the station's platforms."
      );
      if (!years.length) P.append("p").attr("class", "note").text("This build shows geography only. No figures are included.");
      else {
        const story = data.meta.story_line;
        P.append("p").html("").append("button").attr("type", "button").attr("class", "linkish").text("Or see the whole " + story + " corridor").on("click", () => {
          state.line = "";
          syncControls();
          select({ kind: "line", id: slug(story) });
        });
      }
      return;
    }

    let title, sub, type, id;
    if (sel.kind === "station") {
      const f = areaById(sel.id);
      if (!f) return select(null);
      const p = f.properties;
      title = p.name;
      sub = p.line + " · " + (p.mode === "LRT" ? "light rail" : "bus rapid transit") + (p.status !== "Existing" ? " · planned" : "") + (p.city ? " · " + p.city : "");
      type = "station_area";
      id = p.id;
    } else {
      const f = corridorById(sel.id);
      if (!f) return select(null);
      title = f.properties.name + (f.properties.kind === "line" ? " corridor" : "");
      sub = "Station area of the whole line, as drawn in the Council's DTAT Areas layer";
      type = "corridor_area";
      id = f.properties.id;
    }
    const head = P.append("div").attr("class", "panel-head");
    head.append("h2").text(title);
    head.append("button").attr("type", "button").attr("class", "close").attr("aria-label", "Clear the selection").text("×").on("click", () => select(null));
    P.append("p").attr("class", "meta").text(sub);

    if (!years.length) {
      P.append("p").attr("class", "note").text("This build shows geography only. No figures are included.");
      return;
    }
    const y = state.year;
    const r = data.fig(type, id, y);
    const reg = data.fig("region", "region", y);
    const corr = type === "station_area" ? data.fig("corridor_area", slug(areaById(id).properties.line), y) : null;

    if (r && r.withheld) {
      P.append("div")
        .attr("class", "withheld")
        .html("<strong>Figures withheld for " + periodLabel(y) + ".</strong> ")
        .append("span")
        .text("The estimates place fewer than " + data.meta.min_households + " households in this station area, so its figures are not shown. A withheld figure is not zero.");
    }

    const stats = P.append("dl").attr("class", "stats");
    const stat = (label, value, compare) => {
      const d = stats.append("div");
      d.append("dt").text(label);
      d.append("dd").attr("class", /^(withheld|no data)$/.test(value) ? "na" : null).text(value);
      if (compare) d.append("dd").attr("class", "cmp").text(compare);
    };
    const show = (row, k, f) => (!row ? "no data" : row.withheld ? "withheld" : f(row[k]));
    stat("Renter households", show(r, "renter_share", pct), "Region " + pct(reg && reg.renter_share) + (corr && !corr.withheld ? " · line " + pct(corr.renter_share) : ""));
    stat("Moved in past year", show(r, "moved_share", pct), "Region " + pct(reg && reg.moved_share) + (corr && !corr.withheld ? " · line " + pct(corr.moved_share) : ""));
    stat("Households", show(r, "households", num), periodLabel(y) + " estimate");

    const c = P.append("div").attr("class", "panel-chart");
    c.append("h3").text("Renter households by period");
    barChart(
      c.node(),
      [
        { name: type === "station_area" ? "This station area" : "This corridor", cls: 1, values: years.map((yy) => { const rr = data.fig(type, id, yy); return { year: yy, value: rr && !rr.withheld ? rr.renter_share : null, withheld: rr && rr.withheld }; }) },
        { name: "Seven-county region", cls: 2, values: years.map((yy) => { const rr = data.fig("region", "region", yy); return { year: yy, value: rr ? rr.renter_share : null }; }) },
      ],
      { label: "Bar chart of the share of renter households by Census period for " + title + " and the region. The table below lists the same figures.", height: 140 }
    );

    const det = P.append("details").attr("class", "table-wrap");
    det.append("summary").text("Data table for " + title);
    dataTable(
      det.node(),
      title + ", Census five-year estimates",
      [{ label: "Period", value: (yy) => periodLabel(yy) }].concat(
        ["renter_share", "moved_share", "households", "residents_1yr"].map((k) => ({ label: COLS[k].label, value: (yy) => COLS[k].value(data.fig(type, id, yy)) }))
      ),
      years
    );
    P.append("p").attr("class", "src").text("Placeholder figures: American Community Survey five-year estimates, tables B25003 and B07003, shared from tracts to this area by land area. Not a measure of displacement.");
    P.append("p").attr("class", "share").append("a").attr("href", location.href).text("Link to this view");
  }

  /* ---------- Legend ---------- */
  function renderLegend() {
    const L = d3.select("#legend");
    L.html("");
    const lines = L.append("ul").attr("class", "lg-lines");
    const add = (cls, text) => { const li = lines.append("li"); li.append("span").attr("class", "sw " + cls).attr("aria-hidden", "true"); li.append("span").text(text); };
    add("lrt", "Light rail");
    add("brt", "Bus rapid transit");
    add("planned", "Planned (dashed)");
    add("hfn", "High frequency network");
    if (state.year) {
      const m = METRICS[state.metric];
      L.append("p").attr("class", "lg-title").text(m.label + ", " + periodLabel(state.year));
      const ul = L.append("ul").attr("class", "lg-ramp");
      m.legend.forEach((t, i) => { const li = ul.append("li"); li.append("span").attr("class", "dot").style("background", RAMP[i]).attr("aria-hidden", "true"); li.append("span").text(t); });
      const li = ul.append("li");
      li.append("span").attr("class", "dot withheld-dot").attr("aria-hidden", "true");
      li.append("span").text("Withheld");
    } else {
      const ul = L.append("ul").attr("class", "lg-ramp");
      const li = ul.append("li");
      li.append("span").attr("class", "dot").style("background", "#fff").attr("aria-hidden", "true");
      li.append("span").text("Station");
    }
  }

  /* ---------- Controls ---------- */
  function syncControls() {
    for (const i of document.querySelectorAll('input[name="mode"]')) i.checked = i.value === state.mode;
    for (const i of document.querySelectorAll('input[name="year"]')) i.checked = +i.value === state.year;
    for (const i of document.querySelectorAll('input[name="metric"]')) i.checked = i.value === state.metric;
    $("planned").checked = state.planned;
    $("line").value = state.line;
    fillStations();
  }

  function visibleAreas() {
    return data.areas.features.filter((f) => {
      const p = f.properties;
      if (state.mode !== "all" && p.mode !== state.mode) return false;
      if (!state.planned && p.status !== "Existing") return false;
      if (state.line && p.line !== state.line) return false;
      return true;
    });
  }

  function fillStations() {
    const s = $("station");
    const cur = state.sel && state.sel.kind === "station" ? state.sel.id : "";
    s.innerHTML = '<option value="">Choose a station</option>';
    const list = visibleAreas().slice().sort((a, b) => (a.properties.line + a.properties.name).localeCompare(b.properties.line + b.properties.name));
    let group = null, og;
    for (const f of list) {
      if (f.properties.line !== group) {
        group = f.properties.line;
        og = document.createElement("optgroup");
        og.label = group;
        s.appendChild(og);
      }
      const o = document.createElement("option");
      o.value = f.properties.id;
      o.textContent = f.properties.name;
      og.appendChild(o);
    }
    s.value = cur;
  }

  function setupControls() {
    const lines = [...new Set(data.alignments.features.map((f) => f.properties.RT_NAME))].sort();
    const ls = $("line");
    for (const l of lines) {
      const st = data.alignments.features.find((f) => f.properties.RT_NAME === l).properties.RT_STATUS;
      const o = document.createElement("option");
      o.value = l;
      o.textContent = l + (st !== "Existing" ? " (planned)" : "");
      ls.appendChild(o);
    }
    const dl = $("station-list");
    for (const f of data.areas.features) {
      const o = document.createElement("option");
      o.value = f.properties.name + " (" + f.properties.line + ")";
      dl.appendChild(o);
    }
    const years = data.meta.years || [];
    if (years.length) {
      const yf = $("year-field");
      for (const y of years) {
        const lab = document.createElement("label");
        lab.innerHTML = '<input type="radio" name="year"><span></span>';
        lab.firstChild.value = y;
        lab.lastChild.textContent = periodLabel(y);
        yf.appendChild(lab);
      }
      yf.hidden = false;
      $("metric-field").hidden = false;
    }

    $("controls").addEventListener("change", (e) => {
      const t = e.target;
      if (t.name === "mode") state.mode = t.value;
      else if (t.name === "year") state.year = +t.value;
      else if (t.name === "metric") state.metric = t.value;
      else if (t.id === "planned") state.planned = t.checked;
      else if (t.id === "line") {
        state.line = t.value;
        fillStations();
        if (t.value) {
          const c = corridorById(slug(t.value));
          if (c) return select({ kind: "line", id: c.properties.id }), applyFilters();
        }
      } else if (t.id === "station") {
        if (t.value) select({ kind: "station", id: t.value });
        return;
      } else if (t.id === "search") {
        const f = data.areas.features.find((f) => f.properties.name + " (" + f.properties.line + ")" === t.value);
        if (f) {
          select({ kind: "station", id: f.properties.id });
          t.value = "";
        }
        return;
      }
      fillStations();
      applyFilters();
      colorAreas();
      renderLegend();
      renderPanel();
      writeHash();
    });
    $("search").addEventListener("input", (e) => {
      const f = data.areas.features.find((f) => f.properties.name + " (" + f.properties.line + ")" === e.target.value);
      if (f) {
        select({ kind: "station", id: f.properties.id });
        e.target.value = "";
      }
    });
  }

  /* ---------- Statements ---------- */
  function renderStory() {
    const st = statements(data);
    if (!st.length) return;
    $("story").hidden = false;
    $("story-intro").textContent =
      "Each statement describes Census Bureau estimates for the " + data.meta.story_line +
      " station areas, as drawn in the Council's DTAT Areas layer, and for the region. They are placeholder figures to show how statements and charts would sit together. They say nothing about displacement.";
    const cards = d3.select("#cards");
    st.forEach((s, i) => {
      const c = cards.append("article").attr("class", "card").attr("aria-labelledby", "st-" + s.id);
      c.append("p").attr("class", "num").attr("aria-hidden", "true").text(i + 1);
      c.append("h3").attr("id", "st-" + s.id).text(s.title);
      c.append("p").attr("class", "statement").text(s.text);
      const ch = c.append("div").attr("class", "card-chart");
      barChart(ch.node(), s.series, { format: s.format, label: s.title + " chart. The data table below lists the same figures." });
      const det = c.append("details").attr("class", "table-wrap");
      det.append("summary").text("Data table");
      const years = data.meta.years;
      const cols = [{ label: "Period", value: (y) => periodLabel(y) }];
      s.series.forEach((se) => cols.push({ label: se.name, value: (y) => { const v = se.values.find((d) => d.year === y).value; return v === null ? "no data" : s.format === pct ? pct1(v) : num(v); } }));
      dataTable(det.node(), s.title + ": " + s.text, cols, years);
      c.append("p").attr("class", "src").text("Source: " + s.source);
    });
  }

  function renderFooter() {
    const files = ["stations.geojson", "alignments.geojson", "high_frequency_network.geojson", "corridor_areas.geojson", "station_areas.geojson"];
    if ((data.meta.years || []).length) files.push("figures.csv");
    files.push("datapackage.json", "meta.json", "update-report.txt");
    const ul = d3.select("#files");
    files.forEach((f) => ul.append("li").append("a").attr("href", SAX.ROOT + "data/" + f).text(f));
    $("snapshot").textContent = "Council layers as published on " + dateText(data.meta.snapshot_taken) + ". The map works from that saved copy.";
  }

  /* ---------- Start ---------- */
  async function start() {
    readHash();
    let layers;
    try {
      [data, layers] = await Promise.all([SAX.loadData(), fetch(SAX.ROOT + "basemap/layers.json").then((r) => r.json())]);
    } catch (err) {
      $("panel").textContent = "The data files could not be loaded (" + err.message + ").";
      return;
    }
    const years = data.meta.years || [];
    if (!years.includes(state.year)) state.year = years.length ? last(years) : null;
    setupControls();
    syncControls();
    renderLegend();
    renderFooter();
    renderStory();

    map = new maplibregl.Map({
      container: "map",
      style: basemapStyle(layers),
      bounds: [[-93.75, 44.72], [-92.85, 45.2]],
      maxBounds: [[-94.6, 44.1], [-92.1, 45.8]],
      minZoom: 8,
      maxZoom: 16,
      attributionControl: { compact: false },
      cooperativeGestures: false,
      preserveDrawingBuffer: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      addLayers();
      if (state.sel) select(state.sel);
      document.body.dataset.ready = "1";
    });
    if (state.sel) renderPanel();
    else renderPanel();
    window.addEventListener("hashchange", () => {
      readHash();
      syncControls();
      applyFilters();
      colorAreas();
      renderLegend();
      select(state.sel);
    });
  }
  start();
})();
