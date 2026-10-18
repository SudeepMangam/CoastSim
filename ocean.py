"""External ocean-data adapters. Missing data are explicit, never silently invented."""
from __future__ import annotations
import asyncio
import csv
import io
import math
import os
import time
from datetime import datetime, timedelta, timezone
import httpx
import numpy as np

LAT0, LON0 = 18.49, -66.08
L_KM = 16.5  # 16.5 km by 16.5 km local horizontal domain
KY = 111.195
KX = KY * math.cos(math.radians(LAT0))
STATION = '9755371'
ETOPO = 'https://oceanwatch.pifsc.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.csv'
HFR = 'https://dm3.caricoos.org/erddap/griddap/noaa_ndbc_59c1_a442_736e.csv'
WX = 'https://api.open-meteo.com/v1/forecast'
MARINE = 'https://marine-api.open-meteo.com/v1/marine'
TIDES = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
_cache = {}


def bounds():
    return dict(west=LON0-L_KM/(2*KX), east=LON0+L_KM/(2*KX), south=LAT0-L_KM/(2*KY), north=LAT0+L_KM/(2*KY))


def to_xy(lat, lon):
    return (lon-LON0)*KX, (lat-LAT0)*KY


def to_latlon(x, y):
    return LAT0+y/KY, LON0+x/KX


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


async def get_json(url, params=None, timeout=22):
    async with httpx.AsyncClient(follow_redirects=True, timeout=timeout, headers={'User-Agent': 'CoastSim-Educational/1.0'}) as c:
        r = await c.get(url, params=params)
        r.raise_for_status()
        d = r.json()
        if 'error' in d or d.get('reason'):
            raise ValueError(str(d.get('error') or d.get('reason')))
        return d


async def get_text(url, params=None, timeout=30):
    async with httpx.AsyncClient(follow_redirects=True, timeout=timeout, headers={'User-Agent': 'CoastSim-Educational/1.0'}) as c:
        r = await c.get(url, params=params)
        r.raise_for_status()
        return r.text


async def cached(key, ttl, fn):
    hit = _cache.get(key)
    if hit and time.monotonic()-hit[0] < ttl:
        return hit[1]
    result = await fn()
    _cache[key] = (time.monotonic(), result)
    return result


def csv_rows(raw):
    """ERDDAP csv header + units row, tolerant to variable whitespace / non-numeric nulls."""
    rows = list(csv.DictReader(io.StringIO(raw)))
    return [row for row in rows if str(row.get('latitude', '')).strip() not in ('degrees_north', 'degrees_north ') and str(row.get('longitude', '')).strip() != 'degrees_east']


def as_float(v):
    try:
        r = float(v)
        return r if math.isfinite(r) else None
    except (TypeError, ValueError):
        return None


def current_components(speed, direction):
    """Direction is BEARING TOWARDS: 0 north, 90 east."""
    if speed is None or direction is None:
        return None
    theta = math.radians(direction)
    return [speed*math.sin(theta), speed*math.cos(theta)]


def wind_components(speed, direction_from):
    """Meteorological bearing FROM: 0 from north, 90 from east."""
    if speed is None or direction_from is None:
        return None
    u, v = current_components(speed, direction_from)
    return [-u, -v]


def velocity_m_s(value, unit):
    if value is None:
        return None
    u = str(unit).lower().strip()
    if u in ('m/s', 'ms-1', 'm s-1'):
        return value
    if u in ('km/h', 'kmh'):
        return value/3.6
    if u in ('cm/s', 'cm s-1'):
        return value/100
    if u in ('kn', 'knot', 'knots'):
        return value*0.514444
    raise ValueError(f'Unsupported current velocity unit: {unit}')


def series_from_hourly(hourly, keys, units=None, converter=None):
    units = units or {}
    out = []
    for idx, value in enumerate(hourly.get('time', [])):
        t = str(value)
        if t.endswith('Z'):
            t = t[:-1]
        values = {k: as_float(hourly.get(k, [])[idx]) if idx < len(hourly.get(k, [])) else None for k in keys}
        if converter:
            values = converter(values, units)
        out.append(dict(time=t+'Z', **values))
    return out


async def forecast():
    async def load():
        parms = dict(latitude=LAT0+0.05, longitude=LON0, timezone='GMT', forecast_days=5, cell_selection='sea')
        winds, marine = await asyncio.gather(
            get_json(WX, dict(latitude=parms['latitude'], longitude=parms['longitude'], timezone='GMT', forecast_days=5,
                              hourly='wind_speed_10m,wind_direction_10m', wind_speed_unit='ms')),
            get_json(MARINE, dict(**parms, hourly='ocean_current_velocity,ocean_current_direction,wave_height,sea_surface_temperature')),
            return_exceptions=True)
        result = {'source': 'Open-Meteo model forecast', 'retrieved_at': now_iso(), 'wind': None, 'currents': None, 'waves': None, 'errors': [],
                  'resolution_note': 'Marine currents ~8 km grid, surface only; not harbor-resolving or 3D.'}
        if isinstance(winds, Exception):
            result['errors'].append('Wind forecast: '+str(winds)[:220])
        else:
            result['wind'] = series_from_hourly(winds.get('hourly',{}), ['wind_speed_10m','wind_direction_10m'])
        if isinstance(marine, Exception):
            result['errors'].append('Marine forecast: '+str(marine)[:220])
        else:
            h = marine.get('hourly',{})
            units = marine.get('hourly_units',{})
            def conv(d,u):
                speed = velocity_m_s(d['ocean_current_velocity'], u.get('ocean_current_velocity', 'km/h'))
                uv = current_components(speed, d['ocean_current_direction'])
                return {'u':uv[0] if uv else None, 'v':uv[1] if uv else None,
                        'speed_m_s':speed, 'direction_to_deg': d['ocean_current_direction'],
                        'wave_height_m':d['wave_height'], 'sst_c':d['sea_surface_temperature']}
            result['currents'] = series_from_hourly(h, ['ocean_current_velocity','ocean_current_direction','wave_height','sea_surface_temperature'], units, conv)
        return result
    return await cached('forecast', 1200, load)


async def tides():
    async def one(product, extra=None):
        parms = dict(station=STATION, product=product, datum='MLLW', units='metric', time_zone='gmt', format='json', application='CoastSim')
        parms.update(extra or {})
        return await get_json(TIDES, parms)
    async def load():
        d = datetime.now(timezone.utc)
        today = d.strftime('%Y%m%d')
        tomorrow = (d + timedelta(days=2)).strftime('%Y%m%d')
        obs, pred = await asyncio.gather(one('water_level', {'date':'latest'}),
                                         one('predictions', {'begin_date':today, 'end_date':tomorrow, 'interval':'h'}),
                                         return_exceptions=True)
        result = {'station':STATION, 'datum':'MLLW', 'observed':None, 'predictions':[], 'errors':[], 'retrieved_at':now_iso()}
        if isinstance(obs, Exception):
            result['errors'].append('Station observation: '+str(obs)[:180])
        else:
            d = obs.get('data', [])
            if d:
                result['observed'] = {'time':d[-1].get('t'), 'height_m':as_float(d[-1].get('v'))}
        if isinstance(pred, Exception):
            result['errors'].append('Tide predictions: '+str(pred)[:180])
        else:
            result['predictions'] = [{'time':r.get('t'), 'height_m':as_float(r.get('v'))} for r in pred.get('predictions', [])][:150]
        return result
    return await cached('tides', 900, load)


async def radar_recent():
    """Near-real-time HF-radar (observations ONLY). Reject stale measurements."""
    async def load():
        end = datetime.now(timezone.utc)
        start = end-timedelta(hours=12)
        bbox=bounds()
        # Slightly wider than domain: few 6-km cells for a representative measurement.
        lat0,lat1=bbox['south']-0.09,bbox['north']+0.09
        lon0,lon1=bbox['west']-0.09,bbox['east']+0.09
        ax = f'[("{start.strftime("%Y-%m-%dT%H:%M:%SZ")}"):1:("{end.strftime("%Y-%m-%dT%H:%M:%SZ")}")][({lat0:.4f}):1:({lat1:.4f})][({lon0:.4f}):1:({lon1:.4f})]'
        raw = await get_text(HFR, params=None if False else {'query': 'ignored'}) if False else await get_text(HFR+'?u'+ax+',v'+ax)
        parsed = list(csv.DictReader(io.StringIO(raw)))
        cells=[]
        for r in parsed:
            u,v=as_float(r.get('u')),as_float(r.get('v'))
            if u is None or v is None or abs(u)>5 or abs(v)>5:
                continue
            cells.append({'time':r.get('time'), 'lat':as_float(r.get('latitude')), 'lon':as_float(r.get('longitude')), 'u':u, 'v':v})
        if not cells:
            raise ValueError('No valid HF-radar measurements in the last 12h (station/data may be stale).')
        cells.sort(key=lambda c: str(c['time']))
        latest=max(str(c['time']) for c in cells)
        mean_u=float(np.mean([c['u'] for c in cells[-100:]]))
        mean_v=float(np.mean([c['v'] for c in cells[-100:]]))
        return {'source':'CARICOOS / NOAA HF radar, observed surface currents (~6 km)', 'latest_time':latest,
                'mean_u':mean_u,'mean_v':mean_v,'sample_count':len(cells), 'cells':cells[-400:],
                'note':'Recent radar observations are not a forecast and must not be extrapolated as future 3D velocities.'}
    return await cached('radar', 900, load)
