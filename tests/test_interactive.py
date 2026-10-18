"""Regression tests for movable source, adjustable area and mass-weighted cloud."""
import asyncio
import numpy as np
import pytest
from fastapi.testclient import TestClient
import main
from study_area import StudyArea
from terrain import Terrain, demo_terrain
from volume import particle_voxels


def test_area_and_xy_roundtrip_and_validation():
    a=StudyArea(18.51,-66.06,10,19)
    assert a.contains_xy(4.99,9.49)
    assert not a.contains_xy(5.01,0)
    x,y=a.to_xy(18.52,-66.03)
    lat,lon=a.to_latlon(x,y)
    assert lat==pytest.approx(18.52)
    assert lon==pytest.approx(-66.03)
    assert a.bounds()['west']<a.center_lon<a.bounds()['east']
    with pytest.raises(ValueError): StudyArea(width_km=25)
    with pytest.raises(ValueError): StudyArea(center_lat=18.61)
    with pytest.raises(ValueError): StudyArea(height_km=float('nan'))


def test_rectangular_grid_interpolation():
    a=StudyArea(width_km=8,height_km=20)
    grid=np.array([[-90.,-80.,-70.],[-60.,-50.,-40.],[-30.,-20.,-10.]])
    t=Terrain(grid,'fixture',area=a)
    assert t.height(-4,-10)==pytest.approx(-90.)
    assert t.height(0,0)==pytest.approx(-50.)
    assert t.height(3.999,9.999)==pytest.approx(-10.,abs=.02)
    assert t.json()['width_km']==8
    assert t.json()['height_km']==20
    assert t.json()['area']['center_lat']==pytest.approx(18.49)


def test_cloud_mass_weighted_units():
    v,peak=particle_voxels(np.array([.01,.02]),np.array([.01,.02]),np.array([-2.,-2.]),
                          np.array([.4,.6]),'chemical')
    assert len(v)==1
    assert peak==pytest.approx(1000/(350*350*8))
    assert v[0][3]==pytest.approx(peak,abs=1e-8)
    oil,peak2=particle_voxels([.01],[.01],[-.2],[1.],'oil')
    assert len(oil)==1
    assert peak2==pytest.approx(1/(.35*.35))
    assert particle_voxels([],[],[],[],'chemical')==([],0.)


def test_dynamic_api_terrain_and_geo_queries(monkeypatch):
    async def fake_terrain(n,area=None):
        return Terrain(np.full((n,n),-120.),'fake fixture',area=area)
    async def fake_geo(area=None):
        return {'status':'osm','bounds':area.bounds(),'buildings':[],'landcover':[]}
    monkeypatch.setattr(main,'load_terrain',fake_terrain)
    monkeypatch.setattr(main,'geo_payload',fake_geo)
    client=TestClient(main.app)
    params={'center_lat':18.52,'center_lon':-66.07,'width_km':9,'height_km':13}
    t=client.get('/api/terrain',params={**params,'n':41})
    assert t.status_code==200
    assert t.json()['width_km']==9
    assert t.json()['height_km']==13
    assert t.json()['n']==41
    g=client.get('/api/geo',params=params)
    assert g.status_code==200
    assert g.json()['bounds']['north']==pytest.approx(18.52+6.5/111.195)
    invalid=client.get('/api/terrain',params={'width_km':40})
    assert invalid.status_code==422


def test_dynamic_simulation_uses_selected_area(monkeypatch):
    async def flat(n,area=None):
        return Terrain(np.full((n,n),-100.),'fixture',area=area)
    monkeypatch.setattr(main,'load_terrain',flat)
    request=main.SimRequest(mode='demo',center_lat=18.52,center_lon=-66.06,
                            width_km=8,height_km=10,lat=18.52,lon=-66.06,
                            hours=.15,duration_h=.1,particles_per_step=1,members=1)
    out=asyncio.run(main.simulate(request))
    assert out['inputs']['study_area']['height_km']==10
    assert out['inputs']['horizontal_km']==8
    assert len(out['frames'])>1
    assert out['frames'][-1]['cloud_peak']>0
    assert out['frames'][-1]['voxels']
    # A point 5 km east is outside the 8 km-wide region.
    lon_east=-66.06+5/StudyArea(18.52,-66.06,8,10).kx
    request2=request.model_copy(update={'lon':lon_east})
    with pytest.raises(Exception,match='selected study-area bounds'):
        asyncio.run(main.simulate(request2))


def test_different_areas_have_different_cache_keys():
    assert StudyArea(width_km=8).key()!=StudyArea(width_km=16).key()
