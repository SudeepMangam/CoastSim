"""Optional 3-D hydrodynamic field from a local CF-style NetCDF file.

This adapter reads rectangular lat/lon/depth/time grids from CARICOOS or
Copernicus exports. It deliberately rejects incompatible grids rather than
silently collapsing them to a single surface-current vector.

Expected configurable variables: uo/vo/wo (m/s); time, depth, latitude,
longitude. Depth is positive downward. Rectilinear grids only.
"""
from __future__ import annotations
import math
import os
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
import numpy as np
from scipy.interpolate import RegularGridInterpolator
from ocean import LAT0, LON0, L_KM, KX, KY


def var(ds, env, choices):
    explicit=os.getenv(env,'').strip()
    if explicit:
        if explicit not in ds.variables and explicit not in ds.coords:
            raise ValueError(f'{env}={explicit} not found in NetCDF file')
        return explicit
    for name in choices:
        if name in ds.variables or name in ds.coords:
            return name
    raise ValueError(f'Missing variable: set {env} to a NetCDF variable name (tried {choices})')


class VelocityField3D:
    def __init__(self, path):
        import xarray as xr
        self.path=Path(path)
        if not self.path.is_file(): raise ValueError(f'3D model file not found: {self.path}')
        with xr.open_dataset(self.path) as ds:
            tname=var(ds,'OCEAN_TIME_VAR',['time','ocean_time'])
            dname=var(ds,'OCEAN_DEPTH_VAR',['depth','depthu','lev','deptht'])
            latname=var(ds,'OCEAN_LAT_VAR',['latitude','lat'])
            lonname=var(ds,'OCEAN_LON_VAR',['longitude','lon'])
            uname=var(ds,'OCEAN_U_VAR',['uo','u','eastward_sea_water_velocity'])
            vname=var(ds,'OCEAN_V_VAR',['vo','v','northward_sea_water_velocity'])
            # Vertical velocity optional; setting zero is explicit in metadata.
            wname=next((k for k in [os.getenv('OCEAN_W_VAR','').strip(),'wo','w','upward_sea_water_velocity'] if k and k in ds),None)
            names=[tname,dname,latname,lonname]
            arrays=[np.asarray(ds[k].values) for k in names]
            if any(x.ndim != 1 for x in arrays):
                raise ValueError('Only rectilinear 1D time/depth/latitude/longitude axes supported. Curvilinear FVCOM meshes require regridding.')
            rawtime=np.asarray(ds[tname].values)
            if not np.issubdtype(rawtime.dtype,np.datetime64):
                raise ValueError('NetCDF time must decode to UTC-compatible datetime64')
            self.times=rawtime.astype('datetime64[s]').astype('int64').astype(float)
            self.depths=np.asarray(ds[dname].values,dtype=float)
            self.lats=np.asarray(ds[latname].values,dtype=float)
            self.lons=np.asarray(ds[lonname].values,dtype=float)
            if np.nanmedian(self.lons)>180: self.lons=self.lons-360
            if np.nanmin(self.depths)<0:
                if np.nanmax(self.depths)<=0: self.depths=-self.depths
                else: raise ValueError('Mixed-sign depth coordinates require a custom adapter.')
            order=(tname,dname,latname,lonname)
            # Load only the local geographic tile and near-term forecast window.
            # Avoid accidentally materializing an entire global multi-year ocean model.
            utc=datetime.now(timezone.utc).timestamp()
            limits={latname:(LAT0-L_KM/(2*KY),LAT0+L_KM/(2*KY)),
                    lonname:(LON0-L_KM/(2*KX),LON0+L_KM/(2*KX)),
                    tname:(utc-86400,utc+7*86400)}
            subset={}
            for name in (latname,lonname,tname):
                axisvals=np.asarray(ds[name].values)
                if name==tname:
                    axisvals=axisvals.astype('datetime64[s]').astype('int64').astype(float)
                else:
                    axisvals=np.asarray(axisvals,dtype=float)
                    if name==lonname and np.nanmedian(axisvals)>180: axisvals=axisvals-360
                lo,hi=limits[name]
                if name!=tname and (lo<np.nanmin(axisvals) or hi>np.nanmax(axisvals)):
                    raise ValueError(f'NetCDF {name} axis does not cover the entire San Juan region')
                if name==tname and (np.nanmax(axisvals)<utc-3600 or np.nanmin(axisvals)>utc+3600):
                    raise ValueError('NetCDF time axis does not overlap the present hour')
                selected=np.where((axisvals>=lo)&(axisvals<=hi))[0]
                # Include neighboring samples for linear interpolation.
                if len(selected):
                    imin=max(0,int(selected.min())-1);imax=min(len(axisvals),int(selected.max())+2)
                else:
                    close=np.argsort(np.abs(axisvals-(lo+hi)/2))[:2]
                    imin=max(0,int(close.min())-1);imax=min(len(axisvals),int(close.max())+2)
                subset[name]=slice(imin,imax)
            depthvals=np.asarray(ds[dname].values,dtype=float)
            if np.nanmax(depthvals)<=0:depthvals=-depthvals
            valid_depths=np.where(depthvals<=2500)[0]
            if len(valid_depths)>=2:
                subset[dname]=slice(0,min(len(depthvals),int(valid_depths.max())+2))
            rawtime=np.asarray(ds[tname].isel({tname:subset[tname]}).values)
            self.times=rawtime.astype('datetime64[s]').astype('int64').astype(float)
            self.depths=np.asarray(ds[dname].isel({dname:subset.get(dname,slice(None))}).values,dtype=float)
            self.lats=np.asarray(ds[latname].isel({latname:subset[latname]}).values,dtype=float)
            self.lons=np.asarray(ds[lonname].isel({lonname:subset[lonname]}).values,dtype=float)
            if np.nanmedian(self.lons)>180:self.lons=self.lons-360
            if np.nanmax(self.depths)<=0:self.depths=-self.depths
            def load(k):
                da=ds[k].isel(subset)
                if set(da.dims)!=set(order):
                    raise ValueError(f'{k} axes {da.dims} do not match time/depth/lat/lon; regrid before loading')
                unit=str(da.attrs.get('units','m/s')).replace(' ','').lower()
                if unit not in ('m/s','ms-1','m.s-1','metersecond-1','meterssecond-1'):
                    raise ValueError(f'{k} must be m/s, found {unit}')
                arr=np.asarray(da.transpose(*order).values,dtype=np.float32)
                if not np.all(np.isfinite(arr)):
                    # Common ocean model fill values are NaN on land: handled later
                    pass
                return arr
            arrays=[load(uname),load(vname),load(wname) if wname else None]
        coords=[self.times,self.depths,self.lats,self.lons]
        # Force ascending coordinate order along all dimensions.
        for axis,axis_values in enumerate(coords):
            if len(axis_values)<2 or np.any(np.diff(axis_values)==0) or not np.all(np.isfinite(axis_values)):
                raise ValueError('NetCDF coordinates must contain >=2 finite unique samples on each axis')
            sort=np.argsort(axis_values)
            coords[axis]=axis_values[sort]
            for i,a in enumerate(arrays):
                if a is not None: arrays[i]=np.take(a,sort,axis=axis)
        self.times,self.depths,self.lats,self.lons=coords
        south=LAT0-L_KM/(2*KY);north=LAT0+L_KM/(2*KY)
        west=LON0-L_KM/(2*KX);east=LON0+L_KM/(2*KX)
        if south<self.lats[0] or north>self.lats[-1] or west<self.lons[0] or east>self.lons[-1]:
            raise ValueError('3D current grid does not cover entire San Juan domain')
        self.have_w=wname is not None
        self.interps=[RegularGridInterpolator(coords,a,bounds_error=False,fill_value=np.nan) if a is not None else None for a in arrays]
        self.start=float(self.times[0]); self.end=float(self.times[-1])
        self.max_depth=float(self.depths[-1])
        self.source=f'Local hydrodynamic NetCDF: {self.path.name}'
        self.warning=('Vertical velocity comes from NetCDF model.' if self.have_w else 'Vertical current W is set to zero; only U/V are provided.')

    def velocity(self,t_utc,x,y,z):
        x=np.asarray(x,dtype=float);y=np.asarray(y,dtype=float);z=np.asarray(z,dtype=float)
        t=np.broadcast_to(float(t_utc),x.shape)
        depths=np.maximum(0,-z)
        # Beyond the deepest modeled layer, use deepest currents but do not
        # mislabel these as resolved 3D flow.
        pts=np.column_stack((t.ravel(),np.clip(depths,0,self.max_depth).ravel(),
                             (LAT0+y/KY).ravel(),(LON0+x/KX).ravel()))
        if np.any((t<self.start)|(t>self.end)):
            raise ValueError('3D ocean-current model does not cover the requested timestamp')
        out=[f(pts).reshape(x.shape) if f is not None else np.zeros(x.shape) for f in self.interps]
        if not all(np.all(np.isfinite(r)) for r in out):
            raise ValueError('Missing hydrodynamic current cells (land/missing data); use a different model/grid')
        return out


@lru_cache(maxsize=2)
def load_field(path):
    return VelocityField3D(path)
