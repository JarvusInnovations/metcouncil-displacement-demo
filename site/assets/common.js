/* Shared by the explorer, the print page, and the build notes page.
   Reads only the finished files in data/. */
(function () {
  "use strict";

  const METRICS = {
    renter_share: {
      label: "Renter households",
      long: "Share of households that rent their home",
      table: "B25003",
      count: "renter_households",
      base: "households",
      breaks: [0.2, 0.4, 0.6, 0.8],
      legend: ["Under 20%", "20 to 39%", "40 to 59%", "60 to 79%", "80% or more"],
    },
    moved_share: {
      label: "Moved in past year",
      long: "Share of residents (age 1 and over) who lived in a different home a year earlier",
      table: "B07003",
      count: "moved_in_past_year",
      base: "residents_1yr",
      breaks: [0.1, 0.15, 0.2, 0.3],
      legend: ["Under 10%", "10 to 14%", "15 to 19%", "20 to 29%", "30% or more"],
    },
  };

  // One blue, light to dark (validated sequential ramp).
  const RAMP = ["#b7d3f6", "#6da7ec", "#2a78d6", "#1c5cab", "#0d366b"];
  const WITHHELD = "#9b9a94";

  const pct = (v) => (v === null || v === undefined || v === "" || isNaN(v) ? "" : Math.round(v * 100) + "%");
  const pct1 = (v) => (v === null || v === undefined || v === "" || isNaN(v) ? "" : (v * 100).toFixed(1) + "%");
  const num = (v) => (v === null || v === undefined || v === "" || isNaN(v) ? "" : d3.format(",")(Math.round(v / 10) * 10));
  const periodLabel = (y) => (y - 4) + " to " + y;
  const shortPeriod = (y) => (y - 4) + "-" + String(y).slice(2);

  async function loadJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(path + " " + r.status);
    return r.json();
  }

  async function loadData() {
    const [meta, stations, alignments, hfn, areas, corridors] = await Promise.all([
      loadJSON("data/meta.json"),
      loadJSON("data/stations.geojson"),
      loadJSON("data/alignments.geojson"),
      loadJSON("data/high_frequency_network.geojson"),
      loadJSON("data/station_areas.geojson"),
      loadJSON("data/corridor_areas.geojson"),
    ]);
    let figures = [];
    if (meta.years && meta.years.length) {
      figures = await d3.csv("data/figures.csv", (r) => {
        const n = (k) => (r[k] === "" ? null : +r[k]);
        return {
          type: r.geography_type,
          id: r.geography_id,
          name: r.geography_name,
          year: +r.year,
          households: n("households"),
          renter_households: n("renter_households"),
          renter_share: n("renter_share"),
          residents_1yr: n("residents_1yr"),
          moved_in_past_year: n("moved_in_past_year"),
          moved_share: n("moved_share"),
          withheld: r.withheld || "",
        };
      });
    }
    const index = new Map();
    for (const f of figures) index.set(f.type + "|" + f.id + "|" + f.year, f);
    const fig = (type, id, year) => index.get(type + "|" + id + "|" + year) || null;
    return { meta, stations, alignments, hfn, areas, corridors, figures, fig };
  }

  function binColor(metric, v) {
    if (v === null || v === undefined) return WITHHELD;
    const b = METRICS[metric].breaks;
    let i = 0;
    while (i < b.length && v >= b[i]) i++;
    return RAMP[i];
  }

  /* Small grouped bar chart: one or two series across the census periods.
     series: [{name, values: [{year, value, withheld}] , cls}] */
  function barChart(container, series, opts) {
    opts = opts || {};
    const years = series[0].values.map((d) => d.year);
    const W = opts.width || 320, H = opts.height || 150;
    const m = { t: 18, r: 8, b: 26, l: 8 };
    const max = opts.max || d3.max(series.flatMap((s) => s.values.map((d) => d.value || 0))) || 1;
    const x0 = d3.scaleBand().domain(years).range([m.l, W - m.r]).paddingInner(0.28).paddingOuter(0.08);
    const x1 = d3.scaleBand().domain(series.map((s) => s.name)).range([0, x0.bandwidth()]).padding(0.08);
    const y = d3.scaleLinear().domain([0, max * 1.12]).range([H - m.b, m.t]);
    const fmt = opts.format || pct;

    const svg = d3
      .select(container)
      .append("svg")
      .attr("viewBox", "0 0 " + W + " " + H)
      .attr("class", "chart")
      .attr("role", "img")
      .attr("aria-label", opts.label || "Chart");
    svg.append("line").attr("class", "baseline").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(0)).attr("y2", y(0));

    series.forEach((s, si) => {
      const g = svg.append("g").attr("class", "series s" + (s.cls || si + 1));
      s.values.forEach((d) => {
        const x = x0(d.year) + x1(s.name);
        const w = x1.bandwidth();
        if (d.value === null || d.value === undefined) {
          g.append("rect").attr("class", "withheld-bar").attr("x", x).attr("y", y(0) - 3).attr("width", w).attr("height", 3);
          g.append("text").attr("class", "val muted").attr("transform", "translate(" + (x + w / 2 + 4) + "," + (y(0) - 8) + ") rotate(-90)").text(d.withheld ? "withheld" : "no data");
          return;
        }
        const top = y(d.value), h = Math.max(1, y(0) - top), r = Math.min(4, w / 2, h);
        g.append("path")
          .attr("class", "bar")
          .attr("d", "M" + x + "," + y(0) + "V" + (top + r) + "Q" + x + "," + top + " " + (x + r) + "," + top + "H" + (x + w - r) + "Q" + (x + w) + "," + top + " " + (x + w) + "," + (top + r) + "V" + y(0) + "Z")
          .append("title")
          .text(s.name + ", " + periodLabel(d.year) + ": " + fmt(d.value));
        g.append("text").attr("class", "val").attr("x", x + w / 2).attr("y", top - 5).attr("text-anchor", "middle").text(fmt(d.value));
      });
    });
    svg
      .append("g")
      .selectAll("text")
      .data(years)
      .join("text")
      .attr("class", "tick")
      .attr("x", (d) => x0(d) + x0.bandwidth() / 2)
      .attr("y", H - 8)
      .attr("text-anchor", "middle")
      .text((d) => shortPeriod(d));

    if (series.length > 1) {
      const lg = d3.select(container).append("ul").attr("class", "chart-legend");
      series.forEach((s, si) => {
        const li = lg.append("li");
        li.append("span").attr("class", "key s" + (s.cls || si + 1)).attr("aria-hidden", "true");
        li.append("span").text(s.name);
      });
    }
  }

  function dataTable(container, caption, columns, rows) {
    const t = d3.select(container).append("table").attr("class", "data");
    t.append("caption").text(caption);
    t.append("thead").append("tr").selectAll("th").data(columns).join("th").attr("scope", "col").text((c) => c.label);
    const tb = t.append("tbody");
    rows.forEach((r) => {
      const tr = tb.append("tr");
      columns.forEach((c, i) => {
        (i === 0 ? tr.append("th").attr("scope", "row") : tr.append("td")).text(c.value(r));
      });
    });
  }

  /* The three statements, computed from figures.csv. Each returns null when
     the figures it needs are missing, so nothing is shown in their place. */
  function statements(data) {
    const { meta, fig } = data;
    const years = meta.years || [];
    if (!years.length) return [];
    const lineName = meta.story_line;
    const lineId = lineName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const first = years[0], last = years[years.length - 1];
    const L = (y) => fig("corridor_area", lineId, y);
    const R = (y) => fig("region", "region", y);
    const out = [];
    const series = (key) => [
      { name: lineName + " station areas", cls: 1, values: years.map((y) => ({ year: y, value: L(y) ? L(y)[key] : null })) },
      { name: "Seven-county region", cls: 2, values: years.map((y) => ({ year: y, value: R(y) ? R(y)[key] : null })) },
    ];

    if (L(last) && R(last) && L(last).renter_share !== null) {
      out.push({
        id: "renters",
        title: "Renters",
        text:
          "In the " + periodLabel(last) + " estimates, " + pct(L(last).renter_share) + " of households in " + lineName +
          " station areas rented their home. Across the seven-county region the share was " + pct(R(last).renter_share) + ".",
        series: series("renter_share"),
        format: pct,
        source: "Census Bureau, American Community Survey five-year estimates, table B25003 (Tenure).",
        tableCols: ["renter_share", "households"],
      });
    }
    if (L(first) && L(last) && L(first).households && L(last).households) {
      const vals = years.map((y) => ({ year: y, value: L(y) ? L(y).households : null }));
      out.push({
        id: "households",
        title: "Households",
        text:
          "The estimates place about " + num(L(first).households) + " households in " + lineName + " station areas in " +
          periodLabel(first) + " and about " + num(L(last).households) + " in " + periodLabel(last) + ".",
        series: [{ name: lineName + " station areas", cls: 1, values: vals }],
        format: num,
        source: "Census Bureau, American Community Survey five-year estimates, table B25003 (Tenure), total occupied housing units.",
        tableCols: ["households"],
      });
    }
    if (L(last) && R(last) && L(last).moved_share !== null) {
      out.push({
        id: "moved",
        title: "Recent moves",
        text:
          "In the " + periodLabel(last) + " estimates, " + pct(L(last).moved_share) + " of residents of " + lineName +
          " station areas had lived in a different home one year earlier, compared with " + pct(R(last).moved_share) + " across the region.",
        series: series("moved_share"),
        format: pct,
        source: "Census Bureau, American Community Survey five-year estimates, table B07003 (Geographical mobility in the past year).",
        tableCols: ["moved_share", "residents_1yr"],
      });
    }
    return out;
  }

  const COLS = {
    renter_share: { label: "Renter households (share)", value: (r) => (r ? (r.withheld ? "withheld" : pct1(r.renter_share)) : "no data") },
    households: { label: "Households (estimate)", value: (r) => (r ? (r.withheld ? "withheld" : num(r.households)) : "no data") },
    moved_share: { label: "Moved in past year (share)", value: (r) => (r ? (r.withheld ? "withheld" : pct1(r.moved_share)) : "no data") },
    residents_1yr: { label: "Residents age 1 and over (estimate)", value: (r) => (r ? (r.withheld ? "withheld" : num(r.residents_1yr)) : "no data") },
  };

  function slug(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function dateText(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Chicago" });
  }

  /* Bounding box [[w, s], [e, n]] of any GeoJSON feature, without D3's
     spherical winding rules. */
  function bbox(f) {
    let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
    const walk = (c) => {
      if (typeof c[0] === "number") { w = Math.min(w, c[0]); e = Math.max(e, c[0]); so = Math.min(so, c[1]); n = Math.max(n, c[1]); }
      else c.forEach(walk);
    };
    walk(f.geometry.coordinates);
    return [[w, so], [e, n]];
  }

  /* D3 expects outer rings clockwise, the reverse of GeoJSON files. */
  function forD3(f) {
    const g = f.geometry;
    const rev = (poly) => poly.map((ring) => ring.slice().reverse());
    const coords = g.type === "Polygon" ? rev(g.coordinates) : g.type === "MultiPolygon" ? g.coordinates.map(rev) : g.coordinates;
    return { type: "Feature", properties: f.properties, geometry: { type: g.type, coordinates: coords } };
  }

  window.SAX = { bbox, forD3, METRICS, RAMP, WITHHELD, pct, pct1, num, periodLabel, loadData, binColor, barChart, dataTable, statements, COLS, slug, dateText };
})();
