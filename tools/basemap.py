"""Cut a small OpenStreetMap basemap for the seven-county region.

The basemap is a single PMTiles file stored beside the page, so the map
needs no outside tile service. It is cut from the public daily build of
the Protomaps basemap (OpenStreetMap data, Open Database License) by
reading only the tiles that cover the region.

The basemap changes rarely. update.py calls this only when the file is
missing or when it is run with --refresh-basemap.
"""

import datetime
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import requests
import gzip
import threading

from pmtiles.tile import (
    Compression,
    deserialize_directory,
    deserialize_header,
    find_tile,
    zxy_to_tileid,
)
from pmtiles.writer import Writer

BUILD_URL = "https://build.protomaps.com/{date}.pmtiles"
USER_AGENT = "Mozilla/5.0 (compatible; data-fetch)"


def _tile_range(bbox, z):
    """Return the x and y tile ranges that cover a lon/lat box at zoom z."""
    west, south, east, north = bbox
    n = 2 ** z

    def tx(lon):
        return int((lon + 180.0) / 360.0 * n)

    def ty(lat):
        r = math.radians(lat)
        return int((1.0 - math.asinh(math.tan(r)) / math.pi) / 2.0 * n)

    return range(tx(west), tx(east) + 1), range(ty(north), ty(south) + 1)


def find_build(session, days_back=10):
    """Find the most recent daily build that exists."""
    today = datetime.date.today()
    for back in range(days_back):
        date = (today - datetime.timedelta(days=back)).strftime("%Y%m%d")
        url = BUILD_URL.format(date=date)
        resp = session.head(url, timeout=30)
        if resp.status_code == 200:
            return url, date
    raise RuntimeError("No Protomaps daily build found in the last %d days" % days_back)


def cut(out_path, bbox, max_zoom=12, url=None):
    """Write a PMTiles file holding every tile over bbox from zoom 0 to max_zoom."""
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    date = None
    if url is None:
        url, date = find_build(session)

    local = threading.local()

    def get_bytes(offset, length):
        if not hasattr(local, "session"):
            local.session = requests.Session()
            local.session.headers["User-Agent"] = USER_AGENT
        for attempt in range(4):
            try:
                resp = local.session.get(
                    url,
                    headers={"Range": "bytes=%d-%d" % (offset, offset + length - 1)},
                    timeout=60,
                )
                resp.raise_for_status()
                return resp.content
            except requests.RequestException:
                if attempt == 3:
                    raise

    header = deserialize_header(get_bytes(0, 127))
    meta_raw = get_bytes(header["metadata_offset"], header["metadata_length"])
    if header["internal_compression"] == Compression.GZIP:
        meta_raw = gzip.decompress(meta_raw)
    metadata = json.loads(meta_raw)

    lock = threading.Lock()

    @lru_cache(maxsize=None)
    def directory(offset, length):
        # Parsed directories are kept, so each is read and decoded once.
        return deserialize_directory(get_bytes(offset, length))

    def locate(tile_id):
        offset, length = header["root_offset"], header["root_length"]
        for _ in range(4):
            with lock:
                entries = directory(offset, length)
            entry = find_tile(entries, tile_id)
            if entry is None:
                return None
            if entry.run_length > 0:
                return header["tile_data_offset"] + entry.offset, entry.length
            offset = header["leaf_directory_offset"] + entry.offset
            length = entry.length
        return None

    wanted = []
    for z in range(0, max_zoom + 1):
        xs, ys = _tile_range(bbox, z)
        for x in xs:
            for y in ys:
                wanted.append(zxy_to_tileid(z, x, y))
    wanted.sort()

    def fetch(tile_id):
        where = locate(tile_id)
        return tile_id, (get_bytes(*where) if where else None)

    with ThreadPoolExecutor(max_workers=12) as pool:
        tiles = list(pool.map(fetch, wanted))

    with open(out_path, "wb") as f:
        writer = Writer(f)
        count = 0
        for tileid, data in tiles:
            if data:
                writer.write_tile(tileid, data)
                count += 1
        header["min_lon_e7"] = int(bbox[0] * 1e7)
        header["min_lat_e7"] = int(bbox[1] * 1e7)
        header["max_lon_e7"] = int(bbox[2] * 1e7)
        header["max_lat_e7"] = int(bbox[3] * 1e7)
        header["center_zoom"] = 9
        header["center_lon_e7"] = int((bbox[0] + bbox[2]) / 2 * 1e7)
        header["center_lat_e7"] = int((bbox[1] + bbox[3]) / 2 * 1e7)
        metadata["source_build"] = url
        writer.finalize(header, metadata)
    return {"url": url, "build": date, "tiles": count, "max_zoom": max_zoom}


if __name__ == "__main__":
    print(cut(sys.argv[1], (-94.1, 44.4, -92.6, 45.5), int(sys.argv[2]) if len(sys.argv) > 2 else 13))
