"""San Juan CoastSim API, with provenance-aware live data and explicit demo mode."""
from __future__ import annotations
import asyncio
import math
import os
from datetime import datetime, timezone
from typing import Literal, Optional
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator
import ocean
import sim
from terrain import load_terrain
from geodata import geo_payload
from velocity_field import load_field
from study_area import StudyArea

app=FastAPI(title='San Juan CoastSim',version='1.0.0',description='Educational Lagrangian dispersion simulator with NOAA and Open-Meteo data.')
app.add_middleware(CORSMiddleware,allow_origins=['http://localhost:5173','http://127.0.0.1:5173'],allow_methods=['GET','POST'],allow_headers=['Content-Type'])


@app.get('/health')
def health():
    return {'ok':True,'version':'1.1.0','server_utc':ocean.now_iso(),
            'local_dem':bool(os.getenv('DEM_PATH')),'model3d_configured':bool(os.getenv('OCEAN_NETCDF_PATH'))}


def query_area(center_lat:float=Query(18.49,ge=18.40,le=18.56),
               center_lon:float=Query(-66.08,ge=-66.17,le=-65.99),
               width_km:float=Query(16.5,ge=5,le=24),
               height_km:float=Query(16.5,ge=5,le=24)):
    return StudyArea(center_lat, center_lon, width_km, height_km)


from fastapi import Depends


@app.get('/api/terrain')
async def terrain_grid(n:int=Query(201,ge=41,le=401), area:StudyArea=Depends(query_area)):
    return (await load_terrain(n,area)).json()


@app.get('/api/geo')
async def geo(area:StudyArea=Depends(query_area)):
    """OpenStreetMap building outlines and land cover for selected study area."""
    return await geo_payload(area)


@app.get('/api/conditions')
async def conditions():
    # Distinguish providers even if one fails.
    responses=await asyncio.gather(ocean.forecast(),ocean.tides(),return_exceptions=True)
    f,t=responses
    return {'forecast':{'error':str(f)} if isinstance(f,Exception) else f,
            'tides':{'error':str(t)} if isinstance(t,Exception) else t,
            'center':{'lat':ocean.LAT0,'lon':ocean.LON0},'retrieved_at':ocean.now_iso()}


@app.get('/api/radar')
async def radar():
    try:return await ocean.radar_recent()
    except Exception as ex:
        # A 503 is truthful about current data coverage; no synthetic values.
        raise HTTPException(503,'HF radar not currently available: '+str(ex)[:350])


class AdditionalRelease(BaseModel):
    lat:float=Field(...,ge=18.3,le=18.7)
    lon:float=Field(...,ge=-66.3,le=-65.85)
    depth_m:float=Field(...,ge=0.05,le=2000)
    rate_kg_s:float=Field(...,gt=0,le=1000)
    duration_h:float=Field(...,gt=0,le=72)


class SimRequest(BaseModel):
    pollutant:Literal['oil','chemical','microplastic']='chemical'
    mode:Literal['forecast','demo','manual','model3d']='forecast'
    lat:float=Field(18.49,ge=18.3,le=18.7)
    lon:float=Field(-66.08,ge=-66.3,le=-65.85)
    depth_m:float=Field(2.0,ge=0.05,le=2000)
    rate_kg_s:float=Field(0.5,gt=0,le=1000)
    duration_h:float=Field(2,gt=0,le=72)
    hours:float=Field(24,gt=0,le=96)
    members:int=Field(8,ge=1,le=24)
    particles_per_step:int=Field(2,ge=1,le=20)
    render_limit:int=Field(1750,ge=100,le=10000)
    additional_releases:list[AdditionalRelease]=Field(default_factory=list,max_length=4)
    kh:float=Field(1,ge=0,le=1000)
    kz:float=Field(.002,ge=0,le=10)
    half_life_h:float=Field(0,ge=0,le=100000)
    windage:float=Field(0,ge=0,le=0.15)
    beach_probability:float=Field(0.2,ge=0,le=1)
    diameter_mm:float=Field(0.5,gt=0,le=10)
    density_kg_m3:float=Field(1050,ge=100,le=2500)
    settling_ms:Optional[float]=Field(None,ge=-.1,le=.1)
    manual_u:Optional[float]=Field(None,ge=-5,le=5)
    manual_v:Optional[float]=Field(None,ge=-5,le=5)
    manual_wind_u:Optional[float]=Field(None,ge=-40,le=40)
    manual_wind_v:Optional[float]=Field(None,ge=-40,le=40)
    ensemble_current_sd:float=Field(0.02,ge=0,le=.5)
    ensemble_wind_sd:float=Field(0.2,ge=0,le=5)
    seed:int=Field(42,ge=0,le=2147483647)
    center_lat:float=Field(18.49,ge=18.40,le=18.56)
    center_lon:float=Field(-66.08,ge=-66.17,le=-65.99)
    width_km:float=Field(16.5,ge=5,le=24)
    height_km:float=Field(16.5,ge=5,le=24)

    @model_validator(mode='after')
    def check_manual(self):
        if self.mode=='manual' and (self.manual_u is None or self.manual_v is None):
            raise ValueError('Manual mode requires current U and V in m/s.')
        return self


def closest_start(series):
    now=datetime.now(timezone.utc).timestamp()
    valid=[]
    for item in series:
        try:
            t=datetime.fromisoformat(item['time'].replace('Z','+00:00')).timestamp()
            valid.append(t)
        except Exception: pass
    if not valid:raise ValueError('No valid forecast timestamps.')
    # Choose an actual forecast timestamp nearest current UTC, starting no earlier than 1h in the past.
    later=[t for t in valid if t>=now-3600]
    if not later:raise ValueError('Forecast has no currently usable timestamps.')
    return min(later,key=lambda t:abs(t-now))


@app.post('/api/simulate')
async def simulate(r:SimRequest):
    area=StudyArea(r.center_lat,r.center_lon,r.width_km,r.height_km)
    if r.mode=='model3d' and area!=StudyArea():
        raise HTTPException(422,'The current optional 3D NetCDF adapter covers the default domain only; restore the 16.5 km San Juan preset or supply a regridded model adapter.')
    terrain=await load_terrain(161) if area==StudyArea() else await load_terrain(161,area)
    x,y=area.to_xy(r.lat,r.lon)
    release_defs = [{'x':x, 'y':y, 'depth_m':r.depth_m,
                     'rate_kg_s':r.rate_kg_s, 'duration_h':r.duration_h}]
    for release in r.additional_releases:
        px, py = area.to_xy(release.lat, release.lon)
        release_defs.append({'x':px,'y':py,'depth_m':release.depth_m,
                             'rate_kg_s':release.rate_kg_s,'duration_h':release.duration_h})
    if any(not area.contains_xy(a['x'],a['y']) for a in release_defs):
        raise HTTPException(422,'All release positions must be inside the selected study-area bounds.')
    projected_particles = math.ceil(r.hours * 3600 / 300) * r.particles_per_step * len(release_defs) * r.members
    if projected_particles > 250000:
        raise HTTPException(422, f'Too many particles across ensemble ({projected_particles:,} > 250,000). Reduce particles, members, hours or sources.')
    if terrain.status=='synthetic' and r.mode in ('forecast','model3d'):
        raise HTTPException(503,'Real NOAA bathymetry unavailable. Load a real DEM or choose DEMO mode explicitly.')
    try:
        if r.mode=='forecast':
            fc=await ocean.forecast()
            current=fc.get('currents') or []
            wind=fc.get('wind') or []
            if not any(row.get('u') is not None and row.get('v') is not None for row in current):
                raise ValueError('Current forecast not available; switch to manual or demo mode.')
            start=closest_start(current)
            if start+r.hours*3600>datetime.fromisoformat(current[-1]['time'].replace('Z','+00:00')).timestamp()+3600:
                raise ValueError('Forecast ends before your simulation horizon. Shorten duration or select manual mode.')
            current_fn=lambda s,x,y,z:(sim.interp_at(s,current,'u',start),sim.interp_at(s,current,'v',start),0.)
            if r.windage>0:
                if not wind:raise ValueError('Wind forecast unavailable for selected pollutant; use manual mode.')
                wind_fn=lambda s:tuple(ocean.wind_components(sim.interp_at(s,wind,'wind_speed_10m',start),sim.interp_at(s,wind,'wind_direction_10m',start)))
            else:wind_fn=lambda s:(0.,0.)
            sources={'currents':'Open-Meteo surface ocean forecast (~8 km)','wind':'Open-Meteo forecast' if r.windage>0 else 'Not applied',
                     'terrain':terrain.source,'current_type':'forecast',
                     'warnings':['The single representative surface-current forecast is coarse and does not resolve the selected study area.'],
                     'forecast_start':datetime.fromtimestamp(start,timezone.utc).isoformat()}
        elif r.mode=='model3d':
            path=os.getenv('OCEAN_NETCDF_PATH','').strip()
            if not path:raise ValueError('Set OCEAN_NETCDF_PATH to a local CF NetCDF model file and restart the API.')
            field=await asyncio.to_thread(load_field,path)
            utc=datetime.now(timezone.utc).timestamp()
            if utc<field.start-3600 or utc+r.hours*3600>field.end:
                raise ValueError('3D current data must cover the present time and full simulation horizon.')
            start=max(utc,field.start)
            current_fn=lambda s,x,y,z:field.velocity(start+s,x,y,z)
            if r.windage>0:
                fc=await ocean.forecast()
                wind=fc.get('wind') or []
                if not wind:raise ValueError('Wind forecast unavailable for floating pollutant.')
                wind_fn=lambda s:tuple(ocean.wind_components(sim.interp_at(s,wind,'wind_speed_10m',start),sim.interp_at(s,wind,'wind_direction_10m',start)))
            else:wind_fn=lambda s:(0.,0.)
            sources={'currents':field.source,'wind':'Open-Meteo forecast' if r.windage>0 else 'Not applied',
                     'terrain':terrain.source,'current_type':'3D hydrodynamic model','forecast_start':datetime.fromtimestamp(start,timezone.utc).isoformat(),
                     'warnings':[field.warning,'3D model grid and temporal resolution must be validated before interpreting results.']}
        elif r.mode=='manual':
            current_fn=lambda s,x,y,z:(r.manual_u,r.manual_v,0.)
            if r.windage>0 and (r.manual_wind_u is None or r.manual_wind_v is None):
                raise ValueError('Manual mode with windage requires both wind components.')
            wind_fn=lambda s:(r.manual_wind_u or 0.,r.manual_wind_v or 0.)
            sources={'currents':'User-entered constant velocities','wind':'User-entered / zero','terrain':terrain.source,'current_type':'manual'}
        else:
            current_fn=lambda s,x,y,z:(0.14+0.09*math.cos(2*math.pi*s/44712),0.045,0.)
            wind_fn=lambda s:(2.0,-3.0)
            sources={'currents':'Synthetic sinusoidal demonstration','wind':'Synthetic demonstration','terrain':terrain.source,'current_type':'synthetic'}
        settling = (r.settling_ms if r.settling_ms is not None else sim.settling_stokes(r.diameter_mm,r.density_kg_m3)) if r.pollutant=='microplastic' else 0.0
        p=r.model_dump()
        p.update(release_x=x,release_y=y,release_specs=release_defs,settling_ms=settling,dt_s=300)
        if r.pollutant=='oil':p.update(depth_m=0.2,kz=0.0,settling_ms=0)
        if r.pollutant == 'oil':
            for release in release_defs: release['depth_m'] = 0.2
        for idx, release in enumerate(release_defs, start=1):
            if float(terrain.height(release['x'],release['y'])) >= -release['depth_m']:
                raise ValueError(f'Release source {idx} is on land or shallower than release depth. Move it offshore or reduce depth.')
        results=await asyncio.to_thread(sim.ensemble,p,terrain,current_fn,wind_fn)
        return {'source_status':sources,'mode':r.mode,'pollutant':r.pollutant,
                'inputs':{'lat':r.lat,'lon':r.lon,'release_km':[round(x,3),round(y,3)],
                          'depth_m':p['depth_m'],
                          'additional_release_km':[[round(item['x'],3),round(item['y'],3)] for item in release_defs[1:]],
                          'additional_release_depth_m':[item['depth_m'] for item in release_defs[1:]],
                          'release_count':len(release_defs), 'particles_per_step':r.particles_per_step,
                          'render_limit':r.render_limit,
                          'settling_ms':settling,'horizontal_km':area.width_km,'study_area':area.json()},
                'terrain_warning':terrain.warnings,**results}
    except (ValueError,FloatingPointError) as ex:
        raise HTTPException(422,str(ex)) from ex


@app.get('/api/spec')
def spec():
    return {'pollutants':sim.KINDS,'presets':sim.PRESETS,'bounds':ocean.bounds(),
            'sources':{'topography':'NOAA ETOPO 2022 or optional local GeoTIFF',
                       'tide':'NOAA CO-OPS station 9755371',
                       'currents':'Open-Meteo ocean-current forecast; HF radar separate observational cross-check; optional OCEAN_NETCDF_PATH 3D grid',
                       'wind':'Open-Meteo Weather API'},
            'limitations':['Default forecast uses one representative surface velocity for the entire domain; model3d mode requires an external 3D file', 'Coarse bathymetry when local DEM absent',
                           'Simplified pollutant fate and shoreline interaction; no validation against observed plume']}
