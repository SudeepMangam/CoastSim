import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]))
import pytest
from fastapi.testclient import TestClient
from main import app,SimRequest
import ocean
import main
from terrain import demo_terrain

client=TestClient(app)


def test_health():
    r=client.get('/health')
    assert r.status_code==200 and r.json()['ok']


def test_manual_requires_velocity():
    r=client.post('/api/simulate',json={'mode':'manual','pollutant':'chemical'})
    assert r.status_code==422


def test_input_validation():
    for changes in ({'hours':0},{'members':100},{'pollutant':'unlisted'},{'kh':-1}):
        r=client.post('/api/simulate',json={'mode':'demo',**changes})
        assert r.status_code==422


def test_demo_endpoint(monkeypatch):
    async def fake_dem(n):return demo_terrain(n)
    monkeypatch.setattr(main,'load_terrain',fake_dem)
    req={'mode':'demo','pollutant':'chemical','lat':18.49+.03,'lon':-66.08,
        'hours':.2,'duration_h':.1,'members':2,'rate_kg_s':.001,'kh':.01}
    r=client.post('/api/simulate',json=req)
    assert r.status_code==200,r.text
    data=r.json()
    assert data['source_status']['current_type']=='synthetic'
    assert data['members']==2
    assert data['frames']
    assert data['frames'][-1]['budget']['released_kg']>0


def test_forecast_never_uses_fake_bathymetry(monkeypatch):
    async def fake_dem(n):return demo_terrain(n)
    monkeypatch.setattr(main,'load_terrain',fake_dem)
    r=client.post('/api/simulate',json={'mode':'forecast'})
    assert r.status_code==503
    assert 'bathymetry unavailable' in r.text


def test_vector_conversion():
    assert ocean.current_components(2,90)[0]==pytest.approx(2)
    assert ocean.wind_components(2,90)[0]==pytest.approx(-2)
    assert ocean.velocity_m_s(3.6,'km/h')==pytest.approx(1)
    assert ocean.velocity_m_s(100,'cm/s')==pytest.approx(1)
