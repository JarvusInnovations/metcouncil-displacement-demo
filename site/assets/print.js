/* The printable one-page summary for the selected station area or corridor. */
(async function () {
  "use strict";
  const { pct, pct1, num, periodLabel, barChart, dataTable, statements, COLS, slug, dateText } = window.SAX;
  const data = await SAX.loadData();
  const p = new URLSearchParams(location.hash.slice(1));
  document.getElementById("back").href = "./" + location.hash;
  document.getElementById("print-btn").addEventListener("click", () => window.print());

  const years = data.meta.years || [];
  let sel = p.get("sel") || "line:" + slug(data.meta.story_line);
  let [kind, id] = [sel.split(":")[0], sel.split(":").slice(1).join(":")];
  let feature, type, title, subtitle;
  if (kind === "station") {
    feature = data.areas.features.find((f) => f.properties.id === id);
  }
  if (feature) {
    const q = feature.properties;
    type = "station_area";
    title = q.name;
    subtitle = q.line + " · " + (q.mode === "LRT" ? "light rail" : "bus rapid transit") + (q.status !== "Existing" ? " · planned" : "") + (q.city ? " · " + q.city : "") + " · land within half a mile of the station";
  } else {
    feature = data.corridors.features.find((f) => f.properties.id === id) || data.corridors.features.find((f) => f.properties.id === slug(data.meta.story_line));
    id = feature.properties.id;
    type = "corridor_area";
    title = feature.properties.name + (feature.properties.kind === "line" ? " corridor" : "");
    subtitle = "Area of the whole line, as drawn in the Council's DTAT Areas layer";
  }
  document.getElementById("title").textContent = title;
  document.getElementById("subtitle").textContent = subtitle;
  document.title = title + " · Station Area Summary";

  /* Outline map drawn from the same GeoJSON files, no basemap needed. */
  const svg = d3.select("#mini");
  const W = 360, H = 300;
  const focus = kind === "station" && feature.properties.lon
    ? d3.geoCircle().center([feature.properties.lon, feature.properties.lat]).radius(0.035)()
    : SAX.forD3(feature);
  const proj = d3.geoMercator().fitExtent([[10, 10], [W - 10, H - 10]], focus);
  const path = d3.geoPath(proj);
  svg.append("rect").attr("width", W).attr("height", H).attr("class", "mini-county");
  svg.append("defs").append("clipPath").attr("id", "clip").append("rect").attr("width", W).attr("height", H);
  const g = svg.append("g").attr("clip-path", "url(#clip)");
  g.append("path").datum(SAX.forD3(feature)).attr("class", "mini-area").attr("d", path);
  g.selectAll(".mini-hfn").data(data.hfn.features).join("path").attr("class", "mini-hfn").attr("d", path);
  g.selectAll(".al").data(data.alignments.features).join("path")
    .attr("class", (d) => (d.properties.MODE === "LRT" ? "mini-lrt" : "mini-brt") + (d.properties.RT_STATUS !== "Existing" ? " mini-planned" : ""))
    .attr("d", path);
  g.selectAll(".pt").data(data.areas.features).join("circle")
    .attr("class", (d) => (d.properties.id === id ? "mini-sel" : "mini-pt"))
    .attr("r", (d) => (d.properties.id === id ? 5 : 2.6))
    .attr("cx", (d) => proj([d.properties.lon, d.properties.lat])[0])
    .attr("cy", (d) => proj([d.properties.lon, d.properties.lat])[1]);
  document.getElementById("map-cap").textContent =
    "Shaded: " + (type === "station_area" ? "the station area" : "the corridor area") + ". Black lines are light rail, purple lines bus rapid transit, dashed lines planned, thin orange lines the high frequency network. Geography from the Metropolitan Council's public TOD map service.";
  svg.attr("aria-label", "Outline map of " + title + " with nearby transit lines and stations.");

  /* Figures */
  const F = d3.select("#figs");
  if (!years.length) {
    F.append("h2").text("Stations");
    F.append("p").attr("class", "note").text("This build shows geography only. No figures are included.");
  } else {
    const lastY = years[years.length - 1];
    const r = data.fig(type, id, lastY);
    F.append("h2").text("Census estimates, " + (years[0] - 4) + " to " + lastY);
    const held = years.filter((y) => { const x = data.fig(type, id, y); return x && x.withheld; });
    if (held.length) {
      F.append("p").attr("class", "withheld").text("Figures withheld for " + (held.length === years.length ? "every period" : held.map(periodLabel).join(" and ")) + ": the estimates place fewer than " + data.meta.min_households + " households in this area. A withheld figure is not zero.");
    }
    const ch = F.append("div");
    ch.append("h3").text("Renter households by period");
    barChart(ch.node(), [
      { name: type === "station_area" ? "This station area" : "This corridor", cls: 1, values: years.map((y) => { const x = data.fig(type, id, y); return { year: y, value: x && !x.withheld ? x.renter_share : null, withheld: x && x.withheld }; }) },
      { name: "Seven-county region", cls: 2, values: years.map((y) => { const x = data.fig("region", "region", y); return { year: y, value: x ? x.renter_share : null }; }) },
    ], { width: 420, height: 130, label: "Share of renter households by period, this area and the region. The table lists the same figures." });
    dataTable(F.node(), title + " and the region",
      [{ label: "Period", value: (y) => periodLabel(y) }]
        .concat(["renter_share", "moved_share", "households"].map((k) => ({ label: COLS[k].label, value: (y) => COLS[k].value(data.fig(type, id, y)) })))
        .concat([{ label: "Region renter share", value: (y) => pct1((data.fig("region", "region", y) || {}).renter_share) }]),
      years);
  }

  /* The three statements */
  const S = d3.select("#sheet-story");
  const st = statements(data);
  if (!st.length) S.remove();
  st.forEach((s) => {
    const c = S.append("div");
    c.append("h2").text(s.title);
    c.append("p").attr("class", "statement").text(s.text);
    barChart(c.node(), s.series, { format: s.format, height: 125, width: 300, label: s.title + " chart." });
  });

  const foot = d3.select("#foot");
  foot.append("p").text("Placeholder figures: U.S. Census Bureau, American Community Survey five-year estimates, tables B25003 and B07003, shared from tracts to areas by land area. They describe tenure and recent moves and are not a measure of displacement.");
  foot.append("p").text("Council layers as published on " + dateText(data.meta.snapshot_taken) + ". Basemap data © OpenStreetMap contributors. Built " + dateText(data.meta.built) + " by Jarvus Innovations as a demonstration for Metropolitan Council RFP 26P232.");
  foot.append("p").text("Online: " + location.href.replace(/print\.html/, ""));
  document.body.dataset.ready = "1";
})();
