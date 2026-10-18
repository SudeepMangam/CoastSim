"""Real San Juan buildings and land cover from OpenStreetMap (Overpass API).

Buildings use bounding boxes only (`out bb`), which keeps the download small for a dense city.
Land cover uses full outlines. Multipolygon relations (large lagoons) are not fetched; the water
body shapes come from the DEM instead. Failures return an empty, clearly labelled payload.
"""
from __future__ import annotations
import json
import os
import time
from pathlib import Path
import httpx
from ocean import bounds, to_xy, cached, now_iso

OVERPASS = os.getenv('OVERPASS_URL', 'https://overpass-api.de/api/interpreter')
CACHE = Path(os.getenv('GEO_CACHE', 'data/osm_san_juan.json'))
MAX_BUILDINGS = int(os.getenv('MAX_BUILDINGS', '15000'))
DEFAULT_HEIGHT_M = 8.0
KINDS = {('natural', 'wood'): 'forest', ('landuse', 'forest'): 'forest', ('natural', 'scrub'): 'scrub',
         ('natural', 'grassland'): 'grass', ('landuse', 'grass'): 'grass', ('landuse', 'meadow'): 'grass',
         ('landuse', 'recreation_ground'): 'grass', ('leisure', 'park'): 'grass', ('leisure', 'golf_course'): 'grass',
         ('leisure', 'pitch'): 'grass', ('landuse', 'cemetery'): 'grass', ('natural', 'wetland'): 'wetland',
         ('natural', 'beach'): 'beach', ('natural', 'sand'): 'beach', ('natural', 'water'): 'water',
         ('landuse', 'industrial'): 'industrial', ('landuse', 'port'): 'industrial', ('landuse', 'farmland'): 'farm'}


def query():
    b = bounds()
    bb = f"{b['south']:.5f},{b['west']:.5f},{b['north']:.5f},{b['east']:.5f}"
    return f'''[out:json][timeout:90];
way["building"]({bb});
out tags bb qt;
(way["natural"~"^(wood|scrub|grassland|wetland|beach|sand|water)$"]({bb});
 way["landuse"~"^(forest|grass|meadow|recreation_ground|cemetery|industrial|port|farmland)$"]({bb});
 way["leisure"~"^(park|golf_course|pitch)$"]({bb}););
out tags geom qt;'''


def height_m(tags):
    try:
        if tags.get('height'):
            return max(2.0, float(str(tags['height']).lower().replace('m', '').strip()))
        if tags.get('building:levels'):
            return max(2.5, float(tags['building:levels']) * 3.2)
    except ValueError:
        pass
    return DEFAULT_HEIGHT_M


def parse(data):
    buildings, cover = [], []
    for e in data.get('elements', []):
        if e.get('type') != 'way':
            continue
        t = e.get('tags', {})
        if 'building' in t and e.get('bounds'):
            bb = e['bounds']
            x0, y0 = to_xy(bb['minlat'], bb['minlon'])
            x1, y1 = to_xy(bb['maxlat'], bb['maxlon'])
            w, d = abs(x1 - x0), abs(y1 - y0)
            if w > 0 and d > 0:
                buildings.append([round((x0 + x1) / 2, 4), round((y0 + y1) / 2, 4), round(w, 4), round(d, 4), round(height_m(t), 1)])
        elif e.get('geometry'):
            kind = next((v for (k, val), v in KINDS.items() if t.get(k) == val), None)
            pts = [to_xy(g['lat'], g['lon']) for g in e['geometry']]
            if kind and len(pts) >= 4:
                step = max(1, len(pts) // 150)
                cover.append({'k': kind, 'r': [[round(x, 3), round(y, 3)] for x, y in pts[::step]]})
    buildings.sort(key=lambda b: -b[2] * b[3])
    total = len(buildings)
    return {'status': 'osm', 'source': 'OpenStreetMap contributors (ODbL) via Overpass API', 'fetched_at': now_iso(),
            'buildings': buildings[:MAX_BUILDINGS], 'building_count_total': total, 'landcover': cover,
            'warnings': ['OSM coverage is volunteer-mapped; building heights are mostly untagged and default to 8 m.',
                         f'Showing the {min(total, MAX_BUILDINGS)} largest of {total} mapped building footprints as axis-aligned boxes.']}


async def fetch_geo():
    if CACHE.exists() and time.time() - CACHE.stat().st_mtime < 30 * 86400:
        return json.loads(CACHE.read_text())
    async with httpx.AsyncClient(timeout=120, headers={'User-Agent': 'CoastSim-Educational/1.0'}) as c:
        r = await c.post(OVERPASS, data={'data': query()})
        r.raise_for_status()
    payload = r.json()
    if not isinstance(payload, dict) or 'elements' not in payload:
        raise ValueError('Overpass did not return an elements collection')
    out = parse(payload)
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(out))
    except OSError:
        pass
    return out


async def geo_payload():
    try:
        return await cached('osm', 7 * 86400, fetch_geo)
    except Exception as ex:
        return {'status': 'unavailable', 'source': 'OpenStreetMap (unreachable)', 'buildings': [], 'landcover': [],
                'building_count_total': 0, 'warnings': ['OpenStreetMap data unavailable: ' + (str(ex)[:200] or type(ex).__name__)]}
