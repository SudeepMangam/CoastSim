"""Verify multiple pollutant releases and adjustable simulation particle density."""
from fastapi.testclient import TestClient
import main
from main import app
from terrain import demo_terrain
import pytest

client=TestClient(app)


def test_multiple_release_mass_and_particle_count(monkeypatch):
    async def terrain(n): return demo_terrain(n)
    monkeypatch.setattr(main,'load_terrain',terrain)
    data={
        'mode':'demo', 'pollutant':'chemical', 'lat':18.52, 'lon':-66.08,
        'hours':.2,'duration_h':.2, 'rate_kg_s':.01,'members':1,
        'particles_per_step':5,'render_limit':1000,
        'half_life_h':0,'kh':0.01,'kz':0,
        'additional_releases':[
            {'lat':18.525,'lon':-66.078,'depth_m':2,'rate_kg_s':.02,'duration_h':.1},
        ],
    }
    res=client.post('/api/simulate',json=data)
    assert res.status_code == 200,res.text
    obj=res.json()
    assert obj['inputs']['release_count']==2
    assert obj['inputs']['particles_per_step']==5
    assert len(obj['inputs']['additional_release_km'])==1
    last=obj['frames'][-1]
    assert last['budget']['released_kg']==pytest.approx(.01*720+.02*360, abs=.001)
    assert last['active_particles']>10
    # Points carry their contributing source ID, for later per-source coloring/filtering.
    assert all(len(point)==5 for point in last['points'])
    assert {point[4] for point in last['points']} == {0,1}


def test_reject_excessive_total_particles(monkeypatch):
    async def terrain(n): return demo_terrain(n)
    monkeypatch.setattr(main,'load_terrain',terrain)
    r=client.post('/api/simulate',json={
        'mode':'demo','hours':96,'members':24,'particles_per_step':20,
    })
    assert r.status_code==422
    assert 'Too many particles' in r.text


def test_reject_release_outside_domain(monkeypatch):
    async def terrain(n): return demo_terrain(n)
    monkeypatch.setattr(main,'load_terrain',terrain)
    r=client.post('/api/simulate',json={
        'mode':'demo', 'additional_releases':[
            {'lat':18.69,'lon':-66.08,'depth_m':1,'rate_kg_s':.02,'duration_h':.1},
        ],
    })
    assert r.status_code==422
