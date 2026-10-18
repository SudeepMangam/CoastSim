import asyncio
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]))
import pytest
import ocean
import terrain


def test_open_meteo_forecast_unit_and_direction(monkeypatch):
    async def fake_get(url,params=None,timeout=22):
        if 'marine-api' in url:
            return {'hourly_units':{'ocean_current_velocity':'km/h'},'hourly':{
                'time':['2026-10-17T12:00','2026-10-17T13:00'],
                'ocean_current_velocity':[3.6,7.2],
                'ocean_current_direction':[90.,0.],
                'wave_height':[1.,2.], 'sea_surface_temperature':[28.,28.1]}}
        return {'hourly':{'time':['2026-10-17T12:00','2026-10-17T13:00'],
              'wind_speed_10m':[4.,5.], 'wind_direction_10m':[270.,0.]}}
    monkeypatch.setattr(ocean,'get_json',fake_get)
    ocean._cache.clear()
    f=asyncio.run(ocean.forecast())
    assert f['currents'][0]['u']==pytest.approx(1)
    assert f['currents'][0]['v']==pytest.approx(0,abs=1e-10)
    assert f['currents'][1]['v']==pytest.approx(2)
    assert f['wind'][0]['wind_speed_10m']==4
    ocean._cache.clear()


def test_noaa_terrain_csv_adapter(monkeypatch):
    bounds=ocean.bounds()
    lats=[bounds['south']-.01,ocean.LAT0,bounds['north']+.01]
    lons=[bounds['west']+360-.01,ocean.LON0+360,bounds['east']+360+.01]
    raw='latitude,longitude,z\ndegrees_north,degrees_east,m\n'
    for a in lats:
      for b in lons:
        raw+=f'{a},{b},-60\n'
    async def fake_text(url,params=None,timeout=30):return raw
    monkeypatch.setattr(terrain,'get_text',fake_text)
    result=asyncio.run(terrain.noaa_terrain(41))
    assert result.status=='measured_topography'
    assert result.h.shape==(41,41)
    assert result.height(0,0)==pytest.approx(-60)


def test_tides_observation_and_datum(monkeypatch):
    async def fake_get(url,params=None,timeout=22):
        if params['product']=='water_level':
            return {'data':[{'t':'2026-10-17 13:00','v':'0.35'}]}
        return {'predictions':[{'t':'2026-10-17 14:00','v':'0.40'}]}
    monkeypatch.setattr(ocean,'get_json',fake_get)
    ocean._cache.clear()
    res=asyncio.run(ocean.tides())
    assert res['station']=='9755371'
    assert res['datum']=='MLLW'
    assert res['observed']['height_m']==pytest.approx(.35)
    assert res['predictions'][0]['height_m']==pytest.approx(.4)
    ocean._cache.clear()
