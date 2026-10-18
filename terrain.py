"""Terrain from NOAA ETOPO ERDDAP or optional local higher-resolution GeoTIFF."""
from __future__ import annotations
import csv
import io
import math
import os
from pathlib import Path
import numpy as np
from scipy.interpolate import RegularGridInterpolator
from ocean import LAT0, LON0, L_KM, KX, KY, bounds, ETOPO, get_text, cached

class Terrain:
    def __init__(self, h, source, status='measured_topography', warnings=None):
        self.h=np.asarray(h,dtype=float)
        self.n=self.h.shape[0]
        assert self.h.shape == (self.n, self.n)
        self.L=L_KM
        self.source=source
        self.status=status
        self.warnings=warnings or []
        self.max_depth=float(max(5,-np.min(self.h)))

    def height(self,x,y):
        x=np.asarray(x);y=np.asarray(y)
        i=np.clip((x/self.L+0.5)*(self.n-1),0,self.n-1-1e-8)
        j=np.clip((y/self.L+0.5)*(self.n-1),0,self.n-1-1e-8)
        i0=i.astype(int); j0=j.astype(int)
        tx=i-i0;ty=j-j0
        return (self.h[j0,i0]*(1-tx)*(1-ty)+self.h[j0,i0+1]*tx*(1-ty)+
                self.h[j0+1,i0]*(1-tx)*ty+self.h[j0+1,i0+1]*tx*ty)

    def json(self):
        return {'L':self.L,'n':self.n,'h':np.around(self.h,1).ravel().tolist(),
                'max_depth':round(self.max_depth,1),'source':self.source,'status':self.status,
                'warnings':self.warnings,'center':{'lat':LAT0,'lon':LON0},'bounds':bounds()}


def demo_terrain(n=81):
    """Explicit synthetic fallback. Never claim this represents the true coastline."""
    x=np.linspace(-L_KM/2,L_KM/2,n)
    X,Y=np.meshgrid(x,x)
    coast=-2.8+0.5*np.sin(X*0.6)+0.3*np.sin(X*1.3)
    h=np.where(Y<coast, 4 + 25*np.power(np.maximum(0,coast-Y),1.2),
               -np.minimum(1500,8+130*np.power(np.maximum(Y-coast,0),1.6)))
    return Terrain(h,'Synthetic demonstration seabed','synthetic',
                   ['Synthetic terrain: not actual San Juan bathymetry.'])


def local_dem(path,n=81):
    import rasterio
    from rasterio.warp import transform as warp_coords
    from rasterio.enums import Resampling
    x=np.linspace(-L_KM/2,L_KM/2,n)
    X,Y=np.meshgrid(x,x)
    lat=LAT0+Y/KY;lon=LON0+X/KX
    with rasterio.open(path) as f:
        if f.crs is None:
            raise ValueError('GeoTIFF needs an explicit spatial reference (CRS).')
        xs,ys=warp_coords('EPSG:4326',f.crs,lon.ravel().tolist(),lat.ravel().tolist())
        vals=list(f.sample(zip(xs,ys), indexes=1, masked=True))
        arr=np.asarray([float(v[0]) if not np.ma.is_masked(v[0]) else np.nan for v in vals]).reshape(n,n)
        if np.any(~np.isfinite(arr)):
            raise ValueError('DEM does not fully cover the simulation square / includes nodata.')
        return Terrain(arr,f'Local GeoTIFF: {Path(path).name}','measured_topography',
                       ['Check GeoTIFF vertical datum and units (assumed meters) before interpreting sea level.'])


async def noaa_terrain(n=81):
    b=bounds()
    # ETOPO uses 0..360° longitude coordinates. Query with a slight outside margin.
    lat0=b['south']-0.006;lat1=b['north']+0.006
    lon0=b['west']+360-0.006;lon1=b['east']+360+0.006
    url=ETOPO+f'?z[({lat0:.6f}):1:({lat1:.6f})][({lon0:.6f}):1:({lon1:.6f})]'
    raw=await get_text(url,timeout=35)
    rows=list(csv.DictReader(io.StringIO(raw)))
    grid={}
    for r in rows:
        try:
            lat=float(r['latitude']);lon=float(r['longitude']);h=float(r['z'])
            if np.isfinite(h):grid[(lat,lon)]=h
        except (KeyError,ValueError):
            continue
    lats=sorted({k[0] for k in grid});lons=sorted({k[1] for k in grid})
    if len(lats)<3 or len(lons)<3:
        raise ValueError('No bathymetry grid returned by NOAA ETOPO.')
    vals=np.array([[grid.get((la,lo),np.nan) for lo in lons] for la in lats])
    if not np.isfinite(vals).all():
        raise ValueError('NOAA terrain grid contains missing values.')
    inter=RegularGridInterpolator((lats,lons),vals,bounds_error=True)
    x=np.linspace(-L_KM/2,L_KM/2,n)
    X,Y=np.meshgrid(x,x)
    coords=np.column_stack([LAT0+Y.ravel()/KY,360+LON0+X.ravel()/KX])
    h=inter(coords).reshape(n,n)
    return Terrain(h,'NOAA NCEI ETOPO 2022 (15 arc-second)','measured_topography',
                   ['ETOPO is a coarse global DEM (~450 m here); narrow harbor entrances may be unresolved.',
                    'ETOPO uses an EGM2008 height datum; not directly interchangeable with station MLLW water levels.'])


async def load_terrain(n=81):
    path=os.getenv('DEM_PATH','').strip()
    if path:
        try:
            return local_dem(path,n)
        except Exception as ex:
            t=demo_terrain(n)
            t.warnings.insert(0,'Local DEM failed: '+str(ex))
            return t
    try:
        return await cached(('etopo',n),86400,lambda:noaa_terrain(n))
    except Exception as ex:
        t=demo_terrain(n)
        t.warnings.insert(0,'NOAA bathymetry unavailable: '+str(ex)[:200])
        return t
