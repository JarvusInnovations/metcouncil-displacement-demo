# Station Area Explorer (demonstration)

A demonstration built by Jarvus Innovations as a work sample for Metropolitan Council RFP 26P232. It draws the Council's published transit stations, transitway alignments, high frequency network, and station areas on an open-source map, with Census Bureau figures used as placeholders.

This is not the Council's product, and its figures are not a measure of displacement. Every page says so in a banner.

## The update is one command

You need Python 3.11, 3.12, or 3.13 (ArcGIS Pro installs one). The packages are pure Python or come as ready-built wheels for Windows, macOS, and Linux, so no compiler or system library is needed. Install the packages once per computer, then run the update:

```
python -m pip install -r requirements.txt
python update.py
```

The script:

1. reads the four layers from the Council's public TOD map service and checks the record counts,
2. draws a half-mile station area around each station on each line,
3. reads Census tract boundaries and two American Community Survey tables (B25003 and B07003) for three five-year periods,
4. shares each tract's counts among the areas it overlaps by land area,
5. writes the finished site to `dist/`, with the data files in `dist/data/`,
6. prints a short report and saves it as `dist/data/update-report.txt`.

Downloads are kept in `.cache/`, so a second run is quick. `python update.py --fresh` reads every source again. `python update.py --geography-only` skips the Census figures.

To add a year, add it to `YEARS` near the top of `update.py` and run it again.

## Look at it locally

```
python serve.py
```

Then open http://localhost:8000/ for the landing page; the explorer is at /explore/. Any static file server works; `python -m http.server -d dist` does too.

## Publish it

Copy the `dist/` folder to any static web host. Every path is relative, so it works at a domain root or under a subfolder. Nothing runs on the server.

This repository publishes itself to GitHub Pages: `.github/workflows/pages.yml` runs `python update.py` on each push to `main` and deploys `dist/`.

## What is in the repository

| Path | What it is |
| --- | --- |
| `update.py` | The update script. Settings a staff member might change are at the top. |
| `site/` | The page source: HTML, CSS, and JavaScript, with the map and chart libraries in `site/vendor/` at fixed versions. |
| `site/basemap/` | The basemap: a folder of OpenStreetMap map tiles for the region (`tiles/{z}/{x}/{y}.pbf`), its style, and the label fonts. Plain files, so any static host serves them; a single PMTiles file was tried and dropped because GitHub Pages compresses partial responses. |
| `tools/basemap.py` | Cuts new basemap tiles. `python update.py --refresh-basemap` runs it. |
| `tools/basemap-style.cjs` | Regenerates `site/basemap/layers.json` from the Protomaps style package. Needs Node.js; only for changing the basemap's look. |
| `serve.py` | The local preview server. |

## Sources

All public, read without an account or a key:

- Metropolitan Council, `PublicParcels_MetroCTUs_TOD` feature service, layers 0 (DTAT Stations), 2 (DTAT Alignments), 3 (High Frequency Network), and 5 (DTAT Areas): https://gis.metc.state.mn.us/arcgis/rest/services/transit/PublicParcels_MetroCTUs_TOD/FeatureServer
- U.S. Census Bureau, American Community Survey five-year summary files, tables B25003 and B07003, for 2010 to 2014, 2015 to 2019, and 2020 to 2024: https://www2.census.gov/programs-surveys/acs/summary_file/
- U.S. Census Bureau, cartographic boundary files for Minnesota census tracts, 2014, 2019, and 2024: https://www2.census.gov/geo/tiger/
- OpenStreetMap data through the Protomaps daily build: https://build.protomaps.com/

The Census Bureau's data API refused requests made without a key when this was built, so the script reads the same tables from the public summary files.

## Licenses

- MapLibre GL JS 4.7.1: BSD 3-Clause (`site/vendor/maplibre-gl.LICENSE.txt`)
- D3 7.9.0: ISC (`site/vendor/d3.LICENSE.txt`)
- Noto Sans fonts: SIL Open Font License 1.1
- Basemap data: © OpenStreetMap contributors, Open Database License
- Python packages: requests (Apache 2.0), shapely (BSD 3-Clause), pyproj (MIT), pyshp (MIT), pmtiles (BSD 3-Clause, used only to cut the basemap)
