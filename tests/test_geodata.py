import asyncio
import io
import numpy as np
import pytest
import geodata
import terrain
from ocean import bounds


def test_osm_parse_buildings_and_cover():
    b = bounds(); lat, lon = (b['south'] + b['north']) / 2, (b['west'] + b['east']) / 2
    data = {'elements': [
        {'type': 'way', 'tags': {'building': 'yes', 'building:levels': '10'},
         'bounds': {'minlat': lat, 'minlon': lon, 'maxlat': lat + .0003, 'maxlon': lon + .0003}},
        {'type': 'way', 'tags': {'natural': 'wood'},
         'geometry': [{'lat': lat + i * 1e-4, 'lon': lon + (i % 2) * 1e-4} for i in range(6)]},
        {'type': 'way', 'tags': {'highway': 'residential'}, 'geometry': [{'lat': lat, 'lon': lon}] * 6}]}
    out = geodata.parse(data)
    assert out['status'] == 'osm' and len(out['buildings']) == 1 and out['buildings'][0][4] == 32.0
    assert [c['k'] for c in out['landcover']] == ['forest']


def test_geo_payload_failure_is_labelled(monkeypatch):
    async def boom():
        raise RuntimeError('offline')
    monkeypatch.setattr(geodata, 'fetch_geo', boom)
    geodata._cache = None
    import ocean; ocean._cache.pop('osm', None)
    out = asyncio.run(geodata.geo_payload())
    assert out['status'] == 'unavailable' and out['buildings'] == []


def test_ncei_terrain_parses_geotiff(monkeypatch):
    rasterio = pytest.importorskip('rasterio')
    from rasterio.io import MemoryFile
    from rasterio.transform import from_bounds
    arr = np.tile(np.linspace(-50, 30, 64, dtype='float32'), (64, 1))  # west sea -> east land
    with MemoryFile() as mf:
        with mf.open(driver='GTiff', height=64, width=64, count=1, dtype='float32', crs='EPSG:4326',
                     transform=from_bounds(-66.2, 18.4, -66.0, 18.6, 64, 64)) as ds:
            ds.write(arr, 1)
        blob = mf.read()

    class R:
        content = blob; text = ''
        headers = {}
        def raise_for_status(self): pass

    class C:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, *a, **k): return R()
    import httpx
    monkeypatch.setattr(httpx, 'AsyncClient', C)
    t = asyncio.run(terrain.ncei_terrain(n=41, px=64))
    assert t.h.shape == (41, 41) and t.h.min() < -30 and t.h.max() > 20 and t.status == 'measured_topography'
