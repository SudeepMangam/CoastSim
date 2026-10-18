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
from study_area import StudyArea

class Terrain:
    def __init__(self, h, source, status='measured_topography', warnings=None, area=None):
        self.h=np.asarray(h,dtype=float)
        self.n=self.h.shape[0]
        assert self.h.shape == (self.n, self.n)
        self.area=area or StudyArea()
        self.width_km=self.area.width_km; self.height_km=self.area.height_km
        self.L=self.width_km  # compatibility with older consumers
        self.source=source
        self.status=status
        self.warnings=warnings or []
        self.max_depth=float(max(5,-np.min(self.h)))

    def height(self,x,y):
        x=np.asarray(x);y=np.asarray(y)
        i=np.clip((x/self.width_km+0.5)*(self.n-1),0,self.n-1-1e-8)
        j=np.clip((y/self.height_km+0.5)*(self.n-1),0,self.n-1-1e-8)
        i0=i.astype(int); j0=j.astype(int)
        tx=i-i0;ty=j-j0
        return (self.h[j0,i0]*(1-tx)*(1-ty)+self.h[j0,i0+1]*tx*(1-ty)+
                self.h[j0+1,i0]*(1-tx)*ty+self.h[j0+1,i0+1]*tx*ty)

    def json(self):
        return {'L':self.L,'width_km':self.width_km,'height_km':self.height_km,
                'area':self.area.json(),'n':self.n,'h':np.around(self.h,1).ravel().tolist(),
                'max_depth':round(self.max_depth,1),'source':self.source,'status':self.status,
                'warnings':self.warnings,'center':{'lat':self.area.center_lat,'lon':self.area.center_lon},'bounds':self.area.bounds()}


def demo_terrain(n=81, area=None):
    area=area or StudyArea()
    """Explicit synthetic fallback. Never claim this represents the true coastline."""
    x=np.linspace(-area.width_km/2,area.width_km/2,n)
    y=np.linspace(-area.height_km/2,area.height_km/2,n)
    X,Y=np.meshgrid(x,y)
    coast=-2.8+0.5*np.sin(X*0.6)+0.3*np.sin(X*1.3)
    h=np.where(Y<coast, 4 + 25*np.power(np.maximum(0,coast-Y),1.2),
               -np.minimum(1500,8+130*np.power(np.maximum(Y-coast,0),1.6)))
    return Terrain(h,'Synthetic demonstration seabed','synthetic',
                   ['Synthetic terrain: not actual San Juan bathymetry.'],area=area)


def local_dem(path,n=81,area=None):
    area=area or StudyArea()
    import rasterio
    from rasterio.warp import transform as warp_coords
    from rasterio.enums import Resampling
    x=np.linspace(-area.width_km/2,area.width_km/2,n)
    y=np.linspace(-area.height_km/2,area.height_km/2,n)
    X,Y=np.meshgrid(x,y)
    lat=area.center_lat+Y/KY;lon=area.center_lon+X/area.kx
    with rasterio.open(path) as f:
        if f.crs is None:
            raise ValueError('GeoTIFF needs an explicit spatial reference (CRS).')
        xs,ys=warp_coords('EPSG:4326',f.crs,lon.ravel().tolist(),lat.ravel().tolist())
        vals=list(f.sample(zip(xs,ys), indexes=1, masked=True))
        arr=np.asarray([float(v[0]) if not np.ma.is_masked(v[0]) else np.nan for v in vals]).reshape(n,n)
        if np.any(~np.isfinite(arr)):
            raise ValueError('DEM does not fully cover the simulation square / includes nodata.')
        return Terrain(arr,f'Local GeoTIFF: {Path(path).name}','measured_topography',
                       ['Check GeoTIFF vertical datum and units (assumed meters) before interpreting sea level.'],area=area)


async def noaa_terrain(n=81,area=None):
    area=area or StudyArea()
    b=area.bounds()
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
    x=np.linspace(-area.width_km/2,area.width_km/2,n)
    y=np.linspace(-area.height_km/2,area.height_km/2,n)
    X,Y=np.meshgrid(x,y)
    coords=np.column_stack([area.center_lat+Y.ravel()/KY,360+area.center_lon+X.ravel()/area.kx])
    h=inter(coords).reshape(n,n)
    return Terrain(h,'NOAA NCEI ETOPO 2022 (15 arc-second)','measured_topography',
                   ['ETOPO is a coarse global DEM (~450 m here); narrow harbor entrances may be unresolved.',
                    'ETOPO uses an EGM2008 height datum; not directly interchangeable with station MLLW water levels.'],area=area)


NCEI_DEM='https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/exportImage'


async def ncei_terrain(n=201, px=1100, area=None):
    """Fetch NCEI GeoTIFF and reproject onto the selected area's exact grid."""
    area=area or StudyArea()
    import httpx
    from rasterio.io import MemoryFile
    from rasterio.transform import from_bounds
    from rasterio.warp import reproject, Resampling
    b=area.bounds()
    params={'bbox':f"{b['west']:.7f},{b['south']:.7f},{b['east']:.7f},{b['north']:.7f}",
            'bboxSR':'4326','imageSR':'4326','size':f'{px},{px}',
            'format':'tiff','pixelType':'F32','interpolation':'RSP_BilinearInterpolation','f':'image'}
    async with httpx.AsyncClient(follow_redirects=True, timeout=90,
                                 headers={'User-Agent':'CoastSim-Educational/1.0'}) as client:
        response=await client.get(NCEI_DEM,params=params)
        response.raise_for_status()
    if response.content[:4] not in (b'II*\x00',b'MM\x00*'):
        raise ValueError('NOAA NCEI service returned no GeoTIFF: '+response.text[:160])
    with MemoryFile(response.content) as mem:
        with mem.open() as ds:
            if ds.crs is None:
                raise ValueError('NOAA GeoTIFF has no CRS')
            src=ds.read(1,masked=True).filled(np.nan).astype('float32')
            src[(src < -11000)|(src > 3000)]=np.nan
            if np.mean(~np.isfinite(src)) > .02:
                raise ValueError('NOAA DEM has more than 2% missing pixels')
            dx=(b['east']-b['west'])/(n-1)
            dy=(b['north']-b['south'])/(n-1)
            tr=from_bounds(b['west']-dx/2,b['south']-dy/2,b['east']+dx/2,b['north']+dy/2,n,n)
            output=np.full((n,n),np.nan,dtype='float32')
            reproject(source=src,destination=output,src_transform=ds.transform,
                      src_crs=ds.crs,dst_transform=tr,dst_crs='EPSG:4326',
                      src_nodata=np.nan,dst_nodata=np.nan,resampling=Resampling.bilinear)
    if not np.isfinite(output).all():
        raise ValueError('NOAA DEM does not fully cover the selected study area')
    return Terrain(np.flipud(output),'NOAA NCEI DEM Global Mosaic','measured_topography',
                   ['Coastal DEM resolution and vertical datums vary; zero elevation is an approximate shoreline.',
                    'Verify bathymetry, datum and coverage before scientific use.'],area=area)


async def _etopo_after_failure(n, why, area):
    t=await noaa_terrain(n,area)
    t.warnings.insert(0,f'High-resolution NCEI DEM unavailable ({why}); using coarse ETOPO.')
    return t


async def load_terrain(n=81,area=None):
    area=area or StudyArea()
    path=os.getenv('DEM_PATH','').strip()
    if path:
        try:
            return local_dem(path,n,area)
        except Exception as ex:
            t=demo_terrain(n,area)
            t.warnings.insert(0,'Local DEM failed: '+str(ex))
            return t
    try:
        return await cached(('ncei',n,area.key()),7*86400,lambda:ncei_terrain(n,area=area))
    except Exception as ex:
        why=str(ex)[:160] or type(ex).__name__
    try:
        return await cached(('etopo-fb',n,area.key()),3600,lambda:_etopo_after_failure(n,why,area))
    except Exception as ex:
        t=demo_terrain(n,area)
        t.warnings.insert(0,'NOAA bathymetry unavailable: '+(why+' | '+str(ex))[:240])
        return t
