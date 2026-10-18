"""Vectorized illustrative Lagrangian transport and mass-budget accounting.

Coordinate convention: x/y km (east/north), z meters (up; water negative).
An Euler-Maruyama random walk approximates advection + isotropic-horizontal,
vertical diffusion. This is a screening model, not a verified spill model.
"""
from __future__ import annotations
import math
import numpy as np

KINDS=('oil','chemical','microplastic')
PRESETS={
 'oil':dict(depth_m=0.2,half_life_h=72,kh=2.0,kz=0.0,windage=0.025,settling_ms=0.0,beach_probability=0.7),
 'chemical':dict(depth_m=4.0,half_life_h=72,kh=0.8,kz=0.005,windage=0.0,settling_ms=0.0,beach_probability=0.0),
 'microplastic':dict(depth_m=2.0,half_life_h=0.0,kh=0.8,kz=0.003,windage=0.0,settling_ms=0.0,beach_probability=0.25),
}


def settling_stokes(diameter_mm,density_kg_m3):
    """Low-Re spherical Stokes estimate (+upward, -downward), clipped."""
    radius=diameter_mm*1e-3/2
    return float(np.clip(-(2/9)*(density_kg_m3-1025)*9.81*radius**2/0.001,-0.03,0.03))


def interp_at(seconds, series, key, start_utc):
    if not series:
        raise ValueError(f'No valid {key} forecast series available')
    from datetime import datetime, timezone
    times=[]; values=[]
    for r in series:
        v=r.get(key)
        if v is None or not math.isfinite(float(v)):
            continue
        tm=datetime.fromisoformat(r['time'].replace('Z','+00:00')).timestamp()
        times.append(tm)
        values.append(float(v))
    if not values:
        raise ValueError(f'No valid {key} in forecast')
    target=start_utc+seconds
    if target>times[-1]+3600:
        raise ValueError(f'{key} forecast does not cover full simulation horizon')
    return float(np.interp(target,times,values))


def summarize_bins(x,y,z,mass,kind,cell_xy=400,cell_z=5.0):
    """Concentration is an *uncalibrated histogram estimate* with mass-conserving units.

    Oil surface loading: kg/km²; chemicals/plastics water: mg/L.
    """
    if not len(x):
        return np.zeros(0),0.0
    ix=np.floor(x*1000/cell_xy).astype(int)
    iy=np.floor(y*1000/cell_xy).astype(int)
    iz=np.zeros(len(z),dtype=int) if kind=='oil' else np.floor(z/cell_z).astype(int)
    bins=np.column_stack((ix,iy,iz))
    _, inv=np.unique(bins,axis=0,return_inverse=True)
    bmass=np.bincount(inv,weights=mass)
    vol=cell_xy*cell_xy*cell_z
    # mg/L: kg * (1e6 mg/kg) / (m3 * 1000 L/m3) = kg*1000/m3
    conc=bmass/(cell_xy/1000)**2 if kind=='oil' else bmass*1000/vol
    return conc[inv],float(np.max(conc))


def run_member(req, terrain, current_fn, wind_fn, seed, keep_frames=True):
    rng=np.random.default_rng(seed)
    hours=float(req['hours']);duration=float(req['duration_h']);dt=float(req.get('dt_s',300))
    steps=int(math.ceil(hours*3600/dt));pps=int(req.get('particles_per_step',2))
    max_n=steps*pps+8
    x=np.zeros(max_n);y=np.zeros(max_n);z=np.zeros(max_n);mass=np.zeros(max_n)
    state=np.zeros(max_n,dtype=np.int8) # 0 water, 1 beached, 2 outside
    n=0
    kind=req['pollutant']
    released=0.0
    lon0=req['release_x'];lat0=req['release_y']
    depth=req['depth_m']
    if float(terrain.height(lon0,lat0)) >= -max(depth,1):
        raise ValueError('Release must be in water deeper than release depth. Try moving offshore or using shallower release depth.')
    half_life=float(req['half_life_h'])
    windage=float(req['windage'])
    kh=float(req['kh']);kv=float(req['kz']);settle=float(req['settling_ms'])
    surf=kind=='oil'
    frames=[]
    snap_ix={round(k*steps/10) for k in range(11)}
    current_jitter=rng.normal(0,req['ensemble_current_sd'],2) if req.get('ensemble_current_sd',0)>0 else np.zeros(2)
    wind_jitter=rng.normal(0,req['ensemble_wind_sd'],2) if req.get('ensemble_wind_sd',0)>0 else np.zeros(2)

    def mass_budget():
        m_water=float(mass[:n][state[:n]==0].sum())
        m_beached=float(mass[:n][state[:n]==1].sum())
        m_out=float(mass[:n][state[:n]==2].sum())
        decayed=max(0,released-m_water-m_beached-m_out)
        return {'released_kg':round(released,4),'water_kg':round(m_water,4),'beached_kg':round(m_beached,4),
                'exited_kg':round(m_out,4),'decayed_kg':round(decayed,4)}

    def make_frame(t):
        active=np.where(state[:n]==0)[0]
        vals,peak=summarize_bins(x[active],y[active],z[active],mass[active],kind)
        # Uniformly subsample render particles, without changing the mass budget.
        if len(active)>1750:
            use=rng.choice(len(active),1750,replace=False)
        else:use=np.arange(len(active))
        pts=[[round(float(x[active[k]]),3),round(float(y[active[k]]),3),round(float(z[active[k]]),2),
              round(float(vals[k]/peak),3) if peak>0 else 0.0] for k in use]
        stranded=np.where(state[:n]==1)[0]
        if len(stranded)>350: stranded=rng.choice(stranded,350,replace=False)
        beaches=[[round(float(x[k]),3),round(float(y[k]),3),round(float(z[k]),2),0.0] for k in stranded]
        extent=float(np.max(np.hypot(x[active]-lon0,y[active]-lat0))) if len(active) else 0.0
        return {'hour':round(t/3600,2),'points':pts,'beached':beaches,'peak':round(peak,7),
                'spread_km':round(extent,3),'active_particles':len(active),'budget':mass_budget()}

    if keep_frames:frames.append(make_frame(0))
    for i in range(steps):
        t=i*dt
        actual_dt=min(dt,3600*hours-t)
        if actual_dt<=0:break
        seconds_of_release=max(0,min((t+actual_dt),duration*3600)-t)
        if seconds_of_release>0:
            count=pps
            x[n:n+count]=lon0+rng.normal(0,0.01,count)
            y[n:n+count]=lat0+rng.normal(0,0.01,count)
            z[n:n+count]= -0.2 if surf else -depth
            injected=req['rate_kg_s']*seconds_of_release
            mass[n:n+count]=injected/count
            released+=injected;n+=count
        ids=np.where(state[:n]==0)[0]
        if len(ids):
            try:
                u,v,w=current_fn(t+actual_dt/2,x[ids],y[ids],z[ids])
                wu,wv=wind_fn(t+actual_dt/2)
            except Exception as ex:
                raise ValueError('Environmental velocity unavailable: '+str(ex)) from ex
            # Environmental velocities are surface means, not 3D currents.
            # No arbitrary vertical profile is asserted as real-world measured.
            velu=u+current_jitter[0]+windage*(wu+wind_jitter[0])
            velv=v+current_jitter[1]+windage*(wv+wind_jitter[1])
            oldx=x[ids].copy();oldy=y[ids].copy()
            x[ids]+=(velu*actual_dt + rng.normal(0,math.sqrt(2*kh*actual_dt),len(ids)))/1000
            y[ids]+=(velv*actual_dt + rng.normal(0,math.sqrt(2*kh*actual_dt),len(ids)))/1000
            if surf:
                z[ids]=-0.2
            else:
                z[ids]+=np.asarray(w)*actual_dt+settle*actual_dt + rng.normal(0,math.sqrt(2*kv*actual_dt),len(ids))
                z[ids]=-np.abs(z[ids]) # reflect free surface
            d=-terrain.height(np.clip(x[ids],-terrain.L/2,terrain.L/2),np.clip(y[ids],-terrain.L/2,terrain.L/2))
            land=d<=max(0.01,0.2 if surf else 0.01)
            if np.any(land):
                beach=land&(rng.random(len(ids))<req['beach_probability'])
                state[ids[beach]]=1
                reflect=land & ~beach
                x[ids[reflect]]=oldx[reflect]
                y[ids[reflect]]=oldy[reflect]
                z[ids[reflect]]=np.minimum(z[ids[reflect]],-0.2)
            wet=~land
            if not surf:
                deep=wet & (z[ids]<-d)
                # Reflect across seabed; robust for large stochastic excursions.
                z[ids[deep]]=-d[deep]+np.abs(-d[deep]-z[ids[deep]])
                z[ids[deep]]=np.minimum(-0.02,z[ids[deep]])
            outside=(abs(x[ids])>terrain.L/2)|(abs(y[ids])>terrain.L/2)
            state[ids[outside]]=2
            if half_life>0:
                still=state[ids]==0
                mass[ids[still]]*=math.exp(-math.log(2)*actual_dt/(half_life*3600))
        if keep_frames and ((i+1) in snap_ix or i==steps-1):
            frames.append(make_frame((t+actual_dt)))
    return {'final':mass_budget(), 'frames':frames,'final_spread_km':frames[-1]['spread_km'] if frames else None,
            'final_peak':frames[-1]['peak'] if frames else None}


def ensemble(req,terrain,current_fn,wind_fn):
    members=int(req['members']);first=None;results=[]
    for k in range(members):
        r=run_member(req,terrain,current_fn,wind_fn,int(req['seed'])+k,keep_frames=(k==0))
        if first is None:first=r
        results.append(r['final'])
    mass_keys=['water_kg','beached_kg','exited_kg','decayed_kg']
    summary={k:{'mean':round(float(np.mean([r[k] for r in results])),3),
                'p10':round(float(np.quantile([r[k] for r in results],.1)),3),
                'p90':round(float(np.quantile([r[k] for r in results],.9)),3)} for k in mass_keys}
    return {'frames':first['frames'],'ensemble':summary,'members':members,
            'concentration_unit':'kg/km²' if req['pollutant']=='oil' else 'mg/L',
            'concentration_warning':'Uncalibrated particle-bin estimate, not a validated exposure concentration.',
            'notes':[
              'One ensemble member animates; summary statistics use all selected members.',
              'Surface current forecast/observations do not give a full 3D flow field.',
              'Oil modeled as floating material with windage and bulk decay; no chemical weathering or emulsification.',
              'Microplastic settling uses user properties / simplified Stokes approximation; no biofouling or resuspension.',
              'Reflective bottom and simple shoreline contact are numerical approximations.'
            ]}
