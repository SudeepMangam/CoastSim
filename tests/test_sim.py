import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]))
import numpy as np
import pytest
from sim import run_member, ensemble, settling_stokes, summarize_bins
from terrain import demo_terrain, Terrain


def scenario(**changes):
    r=dict(pollutant='chemical', release_x=0.,release_y=3.,depth_m=4.,
        rate_kg_s=.125,duration_h=.5,hours=1.,kh=0.,kz=0.,half_life_h=0.,
        beach_probability=0.,settling_ms=0.,windage=0.,ensemble_current_sd=0.,
        ensemble_wind_sd=0.,dt_s=60.,particles_per_step=2,members=3,seed=5)
    r.update(changes)
    return r


def currents(t,x,y,z):
    return 0.12,0.03,0.0


def wind(t):
    return (1.,0.)


def test_mass_conserved_without_decay():
    r=run_member(scenario(),demo_terrain(),currents,wind,5)
    m=r['final']
    assert m['released_kg']==225
    assert abs(sum(m[k] for k in ('water_kg','beached_kg','exited_kg','decayed_kg'))-m['released_kg'])<0.001
    assert m['decayed_kg']==0


def test_mass_decreases_from_decay():
    baseline=run_member(scenario(),demo_terrain(),currents,wind,5)['final']
    decaying=run_member(scenario(half_life_h=.2),demo_terrain(),currents,wind,5)['final']
    assert decaying['water_kg']<baseline['water_kg']
    assert decaying['decayed_kg']>0
    assert abs(sum(decaying[k] for k in ('water_kg','beached_kg','exited_kg','decayed_kg'))-225)<0.002


def test_dense_plastics_sink_light_plastics_rise():
    assert settling_stokes(.2,1100)<0
    assert settling_stokes(.2,900)>0
    assert settling_stokes(.2,1025)==pytest.approx(0)


def test_current_moves_east_and_north():
    water=Terrain(np.full((81,81),-200.),'test bathy')
    r=run_member(scenario(hours=.1,duration_h=.1,rate_kg_s=1.),water,
                 lambda t,x,y,z:(1.,0.,0.),lambda t:(0,0),5)
    xvalues=[p[0] for p in r['frames'][-1]['points']]
    assert np.mean(xvalues)>0.15


def test_chemical_concentration_units():
    # 1kg in a 400m x 400m x 5m grid cell = 0.00125 mg/L.
    bins,peak=summarize_bins(np.array([1.]),np.array([1.]),np.array([-5.]),np.array([1.]),'chemical')
    assert peak==pytest.approx(.00125)
    assert bins[0]==pytest.approx(peak)


def test_oil_concentration_units():
    _,peak=summarize_bins(np.array([1.]),np.array([1.]),np.array([0.]),np.array([1.]),'oil')
    assert peak==pytest.approx(6.25)  # kg/km2


def test_ensemble_reproducibility():
    p=scenario(hours=.15,duration_h=.1)
    a=ensemble(p,demo_terrain(),currents,wind)
    b=ensemble(p,demo_terrain(),currents,wind)
    assert a==b
    assert a['members']==3


def test_bottom_and_surface_reflection_with_large_diffusion():
    h=Terrain(np.full((81,81),-20.),'flat')
    r=run_member(scenario(hours=.5,kz=.4,kh=0,dt_s=60,release_y=0.,rate_kg_s=.1),h,currents,wind,6)
    zs=[p[2] for f in r['frames'] for p in f['points']]
    assert all(-20 <= z <= 0 for z in zs)


def test_first_nonzero_snapshot_is_captured():
    # The UI should not wait 10% of the simulation horizon before it can show
    # released pollutant. Frame zero remains physically empty.
    water=Terrain(np.full((81,81),-200.),'flat depth')
    r=run_member(scenario(hours=24,duration_h=.5,release_y=0.,kh=0.,kz=0.,rate_kg_s=.01,dt_s=300),
                 water,lambda t,x,y,z:(0.,0.,0.),lambda t:(0.,0.),5)
    frames=r['frames']
    assert frames[0]['hour']==0
    assert frames[0]['active_particles']==0
    assert frames[1]['hour']==pytest.approx(300/3600,abs=.01)
    assert frames[1]['active_particles']>0
    assert frames[1]['budget']['water_kg']>0
    assert len(frames)>=40
