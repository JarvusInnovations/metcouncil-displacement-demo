"""Rebuild the demonstration site from its public sources.

Run it with:

    python update.py

What it does, in order:

1. Reads four layers from the Metropolitan Council's public TOD map
   service and checks the record counts.
2. Draws a half-mile area around each station (the station areas).
3. Reads Census tract boundaries and two American Community Survey tables
   for each period in YEARS, for the seven-county region.
4. Shares each tract's counts among the station areas and corridor areas
   it overlaps, in proportion to the overlapping land area.
5. Writes finished files (GeoJSON and CSV) into dist/data/ and copies the
   page from site/ into dist/.
6. Prints a short report: record counts, areas with no data, and any
   period that could not be read.

Everything it reads is public and needs no account or key. Downloads are
kept in .cache/ so a second run is quick; pass --fresh to read everything
again. The basemap is a separate, larger file that changes rarely; pass
--refresh-basemap to cut a new one.

To add a new year, add it to YEARS below and run the script again.
"""

import argparse
import csv
import datetime
import hashlib
import io
import json
import os
import re
import shutil
import sys
import time
import zipfile

import requests
import shapefile
from pyproj import Transformer
from shapely.geometry import mapping, shape
import shapely
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, "site")
DIST = os.path.join(ROOT, "dist")
CACHE = os.path.join(ROOT, ".cache")
BASEMAP = os.path.join(SITE, "basemap", "region.pmtiles")

USER_AGENT = "Mozilla/5.0 (compatible; data-fetch)"

# ---------------------------------------------------------------------------
# Settings a staff member might change
# ---------------------------------------------------------------------------

# The Council's public map service with the TOD layers.
SERVICE = (
    "https://gis.metc.state.mn.us/arcgis/rest/services/transit/"
    "PublicParcels_MetroCTUs_TOD/FeatureServer"
)

# Layer id, output file name, and a plain name for the report.
LAYERS = [
    (0, "stations", "DTAT Stations"),
    (2, "alignments", "DTAT Alignments"),
    (3, "high_frequency_network", "High Frequency Network"),
    (5, "corridor_areas", "DTAT Areas"),
]

# Station area size, in miles, by transit mode.
STATION_AREA_MILES = {"LRT": 0.5, "BRT": 0.5}

# The seven counties of the Council's region (Minnesota is state 27).
STATE = "27"

# The area the basemap covers (west, south, east, north), a little wider
# than the seven counties.
REGION_BBOX = (-94.1, 44.4, -92.6, 45.5)
COUNTIES = {
    "003": "Anoka",
    "019": "Carver",
    "037": "Dakota",
    "053": "Hennepin",
    "123": "Ramsey",
    "139": "Scott",
    "163": "Washington",
}

# American Community Survey five-year periods, named by their last year.
# They do not overlap: 2010 to 2014, 2015 to 2019, 2020 to 2024.
YEARS = [2014, 2019, 2024]

# The line the three statements on the page describe.
STORY_LINE = "Green Line"

# A station area's figures are withheld when the Census estimates place
# fewer than this many households in it. A withheld figure is shown as
# "withheld" on the page and is never drawn as zero.
MIN_HOUSEHOLDS = 100

# Census tables and the cells used from each. Cell numbers follow the
# Census Bureau's table shells; the script checks the table titles.
TABLES = {
    "B25003": {
        "title": "TENURE",
        "cells": {1: "households", 3: "renter_households"},
    },
    "B07003": {
        "title": "GEOGRAPHICAL MOBILITY IN THE PAST YEAR BY SEX",
        "cells": {1: "residents_1yr", 4: "same_house_1yr"},
    },
}

ACS = "https://www2.census.gov/programs-surveys/acs/summary_file/{year}"
TRACTS = "https://www2.census.gov/geo/tiger/GENZ{year}/shp/cb_{year}_{state}_tract_500k.zip"

# Projected coordinates for area and distance (UTM zone 15N, meters).
TO_METERS = Transformer.from_crs("EPSG:4326", "EPSG:26915", always_xy=True).transform
TO_LONLAT = Transformer.from_crs("EPSG:26915", "EPSG:4326", always_xy=True).transform


def transform(func, geom):
    """Reproject a geometry and repair any self-crossing outlines."""
    return shapely.make_valid(shapely.transform(geom, func, interleaved=False))

# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

session = requests.Session()
session.headers["User-Agent"] = USER_AGENT
FRESH = False
SOURCES = []


def note_source(name, url, rows, fetched=None):
    SOURCES.append(
        {
            "name": name,
            "url": url,
            "rows": rows,
            "fetched": fetched or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        }
    )


def download(url, stream_to=None):
    """Fetch a URL, keeping a copy in .cache/. Returns the cached file path."""
    os.makedirs(CACHE, exist_ok=True)
    name = hashlib.sha1(url.encode()).hexdigest()[:12] + "-" + os.path.basename(url.split("?")[0])
    path = os.path.join(CACHE, name)
    if FRESH or not os.path.exists(path):
        with session.get(url, stream=True, timeout=300) as resp:
            resp.raise_for_status()
            tmp = path + ".part"
            with open(tmp, "wb") as f:
                for chunk in resp.iter_content(1 << 20):
                    f.write(chunk)
            os.replace(tmp, path)
        with open(path + ".fetched", "w") as f:
            f.write(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"))
    with open(path + ".fetched") as f:
        fetched = f.read().strip()
    return path, fetched


def fetch_layer(layer_id):
    """Read every record of one layer as GeoJSON, a page at a time."""
    base = "%s/%d/query" % (SERVICE, layer_id)
    count = session.get(
        base, params={"where": "1=1", "returnCountOnly": "true", "f": "json"}, timeout=60
    ).json()["count"]
    features = []
    while len(features) < count:
        page = session.get(
            base,
            params={
                "where": "1=1",
                "outFields": "*",
                "outSR": "4326",
                "f": "geojson",
                "resultOffset": len(features),
                "orderByFields": "OBJECTID",
            },
            timeout=120,
        ).json()
        if not page.get("features"):
            break
        features.extend(page["features"])
    if len(features) != count:
        raise RuntimeError("Layer %d: service reports %d records, read %d" % (layer_id, count, len(features)))
    return {"type": "FeatureCollection", "features": features}, base


# ---------------------------------------------------------------------------
# Census figures
# ---------------------------------------------------------------------------


def tract_geoid_ok(geoid):
    return geoid[:2] == STATE and geoid[2:5] in COUNTIES


def acs_table_based(year):
    """Tables from the table-based summary file (2021 and later)."""
    out = {}
    for table, spec in TABLES.items():
        url = "%s/table-based-SF/data/5YRData/acsdt5y%d-%s.dat" % (ACS.format(year=year), year, table.lower())
        path, fetched = download(url)
        rows = 0
        with open(path, encoding="utf-8") as f:
            header = f.readline().rstrip("\n").split("|")
            cols = {cell: header.index("%s_E%03d" % (table, cell)) for cell in spec["cells"]}
            for line in f:
                if not line.startswith("1400000US" + STATE):
                    continue
                parts = line.rstrip("\n").split("|")
                geoid = parts[0][9:]
                if not tract_geoid_ok(geoid):
                    continue
                rec = out.setdefault(geoid, {})
                for cell, name in spec["cells"].items():
                    rec[name] = _num(parts[cols[cell]])
                rows += 1
        note_source("ACS 5-year %d-%d, table %s (tracts in the seven counties)" % (year - 4, year, table), url, rows, fetched)
    return out


def acs_sequence_based(year):
    """Tables from the older sequence-based summary file (2020 and earlier)."""
    base = ACS.format(year=year)
    lookup_path, _ = download("%s/documentation/user_tools/ACS_5yr_Seq_Table_Number_Lookup.txt" % base)
    where = {}
    with open(lookup_path, encoding="latin-1") as f:
        for r in csv.reader(f):
            r = [c.strip() for c in r]
            if len(r) > 7 and r[1] in TABLES and r[4] and not r[3]:
                if not r[7].upper().startswith(TABLES[r[1]]["title"]):
                    raise RuntimeError("%d: table %s is titled %r" % (year, r[1], r[7]))
                where[r[1]] = (int(r[2]), int(r[4]))
    missing = set(TABLES) - set(where)
    if missing:
        raise RuntimeError("%d: tables not found in lookup: %s" % (year, ", ".join(sorted(missing))))

    folder = "%s/data/5_year_seq_by_state/Minnesota/Tracts_Block_Groups_Only" % base
    geo_url = "%s/g%d5mn.csv" % (folder, year)
    geo_path, geo_fetched = download(geo_url)
    logrec = {}
    with open(geo_path, encoding="latin-1") as f:
        for r in csv.reader(f):
            for cell in r:
                if cell.startswith("14000US"):
                    geoid = cell[7:]
                    if tract_geoid_ok(geoid):
                        logrec[r[4]] = geoid
                    break
    note_source("ACS 5-year %d-%d, geography file for Minnesota" % (year - 4, year), geo_url, len(logrec), geo_fetched)

    out = {}
    for table, (seq, start) in where.items():
        url = "%s/%d5mn%04d000.zip" % (folder, year, seq)
        path, fetched = download(url)
        rows = 0
        with zipfile.ZipFile(path) as z:
            name = "e%d5mn%04d000.txt" % (year, seq)
            with z.open(name) as f:
                for r in csv.reader(io.TextIOWrapper(f, encoding="latin-1")):
                    geoid = logrec.get(r[5])
                    if not geoid:
                        continue
                    rec = out.setdefault(geoid, {})
                    for cell, field in TABLES[table]["cells"].items():
                        rec[field] = _num(r[start - 1 + cell - 1])
                    rows += 1
        note_source("ACS 5-year %d-%d, table %s (tracts in the seven counties)" % (year - 4, year, table), url, rows, fetched)
    return out


def _num(text):
    try:
        value = float(text)
    except ValueError:
        return None
    # The Census Bureau marks unavailable values with large negative codes.
    return value if value >= 0 else None


def tract_shapes(year):
    url = TRACTS.format(year=year, state=STATE)
    path, fetched = download(url)
    with zipfile.ZipFile(path) as z:
        stem = os.path.basename(url)[:-4]
        reader = shapefile.Reader(
            shp=io.BytesIO(z.read(stem + ".shp")),
            dbf=io.BytesIO(z.read(stem + ".dbf")),
            shx=io.BytesIO(z.read(stem + ".shx")),
        )
        fields = [f[0] for f in reader.fields[1:]]
        out = {}
        for rec, shp in zip(reader.records(), reader.shapes()):
            row = dict(zip(fields, rec))
            geoid = row.get("GEOID") or (row["STATEFP"] + row["COUNTYFP"] + row["TRACTCE"])
            if tract_geoid_ok(geoid):
                out[geoid] = transform(TO_METERS, shape(shp.__geo_interface__))
    note_source("Census cartographic boundary file, tracts, %d" % year, url, len(out), fetched)
    return out


# ---------------------------------------------------------------------------
# Building
# ---------------------------------------------------------------------------


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def lonlat(geom):
    """Back to longitude and latitude, outer rings counterclockwise (RFC 7946)."""
    return shapely.orient_polygons(transform(TO_LONLAT, geom), exterior_cw=False)


def round_coords(geom, places=5):
    def r(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            return [round(c[0], places), round(c[1], places)]
        return [r(x) for x in c]

    g = dict(geom)
    g["coordinates"] = r(geom["coordinates"])
    return g


def build_station_areas(stations, alignments):
    """One half-mile area per station on each line, from the platform points."""
    line_info = {}
    for f in alignments["features"]:
        p = f["properties"]
        line_info[p["RT_NAME"]] = {"mode": p["MODE"], "status": p["RT_STATUS"]}

    groups = {}
    for f in stations["features"]:
        p = f["properties"]
        key = (p["RT_NAME"], p["STATION"])
        groups.setdefault(key, {"cities": set(), "points": []})
        groups[key]["cities"].add(p["CITY"])
        groups[key]["points"].append(transform(TO_METERS, shape(f["geometry"])))

    areas = []
    for (line, station), g in sorted(groups.items()):
        info = line_info.get(line, {"mode": "", "status": ""})
        miles = STATION_AREA_MILES.get(info["mode"], 0.5)
        geom = unary_union([pt.buffer(miles * 1609.344, 48) for pt in g["points"]])
        name = re.sub(r"\s+Station$", "", station.strip())
        areas.append(
            {
                "id": slug(line + " " + name),
                "name": name,
                "line": line,
                "mode": info["mode"],
                "status": info["status"],
                "city": ", ".join(sorted(c for c in g["cities"] if c)),
                "geom": geom,
                "point": unary_union(g["points"]).centroid,
            }
        )
    return areas


def apportion(targets, tracts, figures):
    """Share tract counts among target areas by overlapping area."""
    ids = list(tracts)
    geoms = [tracts[i] for i in ids]
    tree = STRtree(geoms)
    fields = sorted({f for spec in TABLES.values() for f in spec["cells"].values()})
    results = {}
    for t in targets:
        sums = {f: 0.0 for f in fields}
        missing = 0
        for idx in tree.query(t["geom"], predicate="intersects"):
            tract = geoms[idx]
            share = tract.intersection(t["geom"]).area / tract.area if tract.area else 0
            if share <= 0:
                continue
            rec = figures.get(ids[idx])
            if rec is None:
                missing += 1
                continue
            for f in fields:
                if rec.get(f) is not None:
                    sums[f] += rec[f] * share
        results[t["id"]] = (sums, missing)
    return results


def finish_row(kind, area_id, name, year, sums):
    hh = sums["households"]
    row = {
        "geography_type": kind,
        "geography_id": area_id,
        "geography_name": name,
        "period": "%d-%d" % (year - 4, year),
        "year": year,
        "households": round(hh),
        "renter_households": round(sums["renter_households"]),
        "renter_share": "",
        "residents_1yr": round(sums["residents_1yr"]),
        "moved_in_past_year": round(sums["residents_1yr"] - sums["same_house_1yr"]),
        "moved_share": "",
        "withheld": "",
    }
    if kind == "station_area" and hh < MIN_HOUSEHOLDS:
        row.update(
            {
                "households": "",
                "renter_households": "",
                "residents_1yr": "",
                "moved_in_past_year": "",
                "withheld": "fewer than %d households" % MIN_HOUSEHOLDS,
            }
        )
        return row
    if hh > 0:
        row["renter_share"] = round(sums["renter_households"] / hh, 4)
    if sums["residents_1yr"] > 0:
        row["moved_share"] = round(1 - sums["same_house_1yr"] / sums["residents_1yr"], 4)
    return row


def write_geojson(path, features):
    with open(path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, separators=(",", ":"))


def dir_stats(path):
    count, size = 0, 0
    for base, _, files in os.walk(path):
        for name in files:
            count += 1
            size += os.path.getsize(os.path.join(base, name))
    return count, size


def main():
    global FRESH
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--fresh", action="store_true", help="read every source again instead of using .cache/")
    parser.add_argument("--refresh-basemap", action="store_true", help="cut a new basemap file")
    parser.add_argument("--geography-only", action="store_true", help="skip the Census figures")
    args = parser.parse_args()
    FRESH = args.fresh
    started = time.time()
    report = []
    say = lambda line="": (print(line), report.append(line))

    say("Rebuilding the demonstration site")
    say()

    # 1. Council layers -------------------------------------------------
    layers = {}
    say("Council map service layers")
    for layer_id, name, label in LAYERS:
        data, url = fetch_layer(layer_id)
        layers[name] = data
        note_source("Metropolitan Council, %s (layer %d)" % (label, layer_id), url, len(data["features"]))
        say("  %-24s %4d records" % (label, len(data["features"])))

    # 2. Station areas --------------------------------------------------
    areas = build_station_areas(layers["stations"], layers["alignments"])
    say("  %-24s %4d areas (half mile around each station on each line)" % ("Station areas", len(areas)))

    corridors = []
    for f in layers["corridor_areas"]["features"]:
        p = f["properties"]
        name = p["AREA_NAME"]
        corridors.append(
            {
                "id": slug(name),
                "name": name,
                "geom": transform(TO_METERS, shape(f["geometry"])),
                "kind": "summary" if name.startswith("All ") else ("downtown" if name.startswith("Downtown") else "line"),
            }
        )

    # 3 and 4. Census figures ---------------------------------------------
    rows = []
    problems = []
    years_done = []
    if not args.geography_only:
        say()
        say("Census figures (American Community Survey, five-year estimates)")
        region_geom = None
        for year in YEARS:
            try:
                figures = acs_table_based(year) if year >= 2021 else acs_sequence_based(year)
                tracts = tract_shapes(year)
            except Exception as exc:  # report and carry on with the other years
                problems.append("%d-%d: could not be read (%s)" % (year - 4, year, exc))
                continue
            no_data = [g for g in tracts if g not in figures]
            totals = {f: sum((r.get(f) or 0) for r in figures.values()) for spec in TABLES.values() for f in spec["cells"].values()}
            rows.append(finish_row("region", "region", "Seven-county region", year, totals))

            for kind, targets in (("station_area", areas), ("corridor_area", corridors)):
                for area_id, (sums, missing) in apportion(targets, tracts, figures).items():
                    name = next(t["name"] for t in targets if t["id"] == area_id)
                    rows.append(finish_row(kind, area_id, name, year, sums))
            withheld = sum(1 for r in rows if r["year"] == year and r["withheld"])
            say(
                "  %d-%d  %4d tracts with figures, %d tracts without, %d station areas withheld"
                % (year - 4, year, len(figures), len(no_data), withheld)
            )
            years_done.append(year)
        for p in problems:
            say("  PROBLEM " + p)

    # 5. Write the site -------------------------------------------------
    if os.path.exists(DIST):
        shutil.rmtree(DIST)
    if not os.path.exists(BASEMAP) or args.refresh_basemap:
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        import basemap

        os.makedirs(os.path.dirname(BASEMAP), exist_ok=True)
        info = basemap.cut(BASEMAP, REGION_BBOX, max_zoom=13)
        say("  Basemap cut from %s (%d tiles)" % (info["url"], info["tiles"]))
    shutil.copytree(SITE, DIST)
    data_dir = os.path.join(DIST, "data")
    os.makedirs(data_dir, exist_ok=True)

    keep = {
        "stations": ["STATION", "RT_NAME", "CITY", "DIRECTION"],
        "alignments": ["RT_NAME", "RT_STATUS", "MODE", "LENGTH_MI"],
        "high_frequency_network": ["LINE_ID", "DIRECTION"],
    }
    modes = {f["properties"]["RT_NAME"]: f["properties"]["MODE"] for f in layers["alignments"]["features"]}
    status = {f["properties"]["RT_NAME"]: f["properties"]["RT_STATUS"] for f in layers["alignments"]["features"]}
    for name, fields in keep.items():
        feats = []
        for f in layers[name]["features"]:
            props = {k: f["properties"].get(k) for k in fields}
            if name == "stations":
                props["MODE"] = modes.get(props["RT_NAME"], "")
                props["RT_STATUS"] = status.get(props["RT_NAME"], "")
            feats.append({"type": "Feature", "properties": props, "geometry": round_coords(f["geometry"])})
        write_geojson(os.path.join(data_dir, name + ".geojson"), feats)

    write_geojson(
        os.path.join(data_dir, "station_areas.geojson"),
        [
            {
                "type": "Feature",
                "id": i,
                "properties": {
                    "id": a["id"],
                    "name": a["name"],
                    "line": a["line"],
                    "mode": a["mode"],
                    "status": a["status"],
                    "city": a["city"],
                    "lon": round(transform(TO_LONLAT, a["point"]).x, 5),
                    "lat": round(transform(TO_LONLAT, a["point"]).y, 5),
                },
                "geometry": round_coords(mapping(lonlat(a["geom"].simplify(1)))),
            }
            for i, a in enumerate(areas)
        ],
    )
    write_geojson(
        os.path.join(data_dir, "corridor_areas.geojson"),
        [
            {
                "type": "Feature",
                "id": i,
                "properties": {"id": c["id"], "name": c["name"], "kind": c["kind"], "mode": modes.get(c["name"], ""), "status": status.get(c["name"], "")},
                "geometry": round_coords(mapping(lonlat(c["geom"].simplify(5)))),
            }
            for i, c in enumerate(corridors)
        ],
    )

    if rows:
        with open(os.path.join(data_dir, "figures.csv"), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    # Areas with no households in any period are listed for staff.
    if rows:
        empty = sorted({r["geography_name"] for r in rows if r["geography_type"] == "station_area" and r["withheld"]})
        say()
        say("Station areas withheld in at least one period (%d): %s" % (len(empty), "; ".join(empty) if empty else "none"))

    elapsed = time.time() - started
    meta = {
        "built": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "snapshot_taken": min((s["fetched"] for s in SOURCES if "Metropolitan" in s["name"]), default=None),
        "years": years_done,
        "story_line": STORY_LINE,
        "min_households": MIN_HOUSEHOLDS,
        "station_area_miles": STATION_AREA_MILES,
        "counts": {name: len(layers[name]["features"]) for name in layers} | {"station_areas": len(areas)},
        "sources": SOURCES,
        "problems": problems,
        "update_seconds": round(elapsed, 1),
        "basemap_bytes": os.path.getsize(BASEMAP),
        "command": "python update.py",
    }
    meta_path = os.path.join(data_dir, "meta.json")
    for _ in range(2):  # the file's own size is part of the total
        files, size = dir_stats(DIST)
        meta["site_files"] = files
        meta["site_bytes"] = size
        with open(meta_path, "w") as f:
            json.dump(meta, f, indent=1)
    files, size = dir_stats(DIST)

    say()
    say("Wrote %d files, %.1f MB, to dist/ in %.0f seconds" % (files, size / 1e6, elapsed))
    if problems:
        say("Finished with problems; read the lines marked PROBLEM above.")
    with open(os.path.join(data_dir, "update-report.txt"), "w") as f:
        f.write("\n".join(report) + "\n")


if __name__ == "__main__":
    main()
