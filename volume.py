"""Mass-weighted, coarse 3-D particle-bin estimates for visualization only.

Returns center coordinates (km east/north, meters up) and kg/km2 for floating
oil or mg/L for chemicals and plastics. These are uncalibrated estimates, not
observed concentrations. Full active particles are included before render subsampling.
"""
import numpy as np
from collections import defaultdict
from itertools import product


def particle_voxels(x, y, z, mass_kg, kind, xy_m=350.0, z_m=8.0, limit=1600, smooth=False, terrain=None):
    x=np.asarray(x, dtype=float); y=np.asarray(y, dtype=float)
    z=np.asarray(z, dtype=float); mass_kg=np.asarray(mass_kg,dtype=float)
    if not len(x):
        return [], 0.0
    if not (len(x)==len(y)==len(z)==len(mass_kg)):
        raise ValueError('Particle positions and masses must have equal lengths')
    if not all(np.all(np.isfinite(q)) for q in (x,y,z,mass_kg)):
        raise ValueError('Nonfinite particle coordinate or mass')
    ix=np.floor(x*1000/xy_m).astype('int64')
    iy=np.floor(y*1000/xy_m).astype('int64')
    iz=np.zeros(len(z),dtype='int64') if kind=='oil' else np.floor(np.asarray(z)/z_m).astype('int64')
    unique, inverse = np.unique(np.column_stack((ix,iy,iz)),axis=0,return_inverse=True)
    bmass=np.bincount(inverse,weights=mass_kg)
    if smooth:
        # Conservative 3x3 (oil) / 3x3x3 (subsurface) kernel: mass is
        # spread only between valid water voxels, without changing particles.
        # This is a VISUAL estimate, not an advection/diffusion solver.
        blended=defaultdict(float)
        dzs=(0,) if kind=='oil' else (-1,0,1)
        offsets=list(product((-1,0,1),(-1,0,1),dzs))
        for cell,m in zip(unique,bmass):
            weighted=[]
            for dx,dy,dz in offsets:
                c=(int(cell[0]+dx),int(cell[1]+dy),int(cell[2]+dz))
                px=(c[0]+.5)*xy_m/1000; py=(c[1]+.5)*xy_m/1000
                pz=-.2 if kind=='oil' else (c[2]+.5)*z_m
                if pz>=0 or (terrain is not None and
                    (abs(px)>=terrain.width_km/2 or abs(py)>=terrain.height_km/2 or
                     float(terrain.height(px,py))>=pz)):
                    continue
                w=(2 if dx==0 else 1)*(2 if dy==0 else 1)*(2 if dz==0 else 1)
                weighted.append((c,w))
            normal=sum(w for _,w in weighted)
            for c,w in weighted:
                blended[c]+=float(m)*w/normal if normal else 0
        if blended:
            unique=np.asarray(list(blended),dtype='int64')
            bmass=np.asarray(list(blended.values()),dtype=float)
    area_km2=(xy_m/1000)**2
    concentration=bmass/area_km2 if kind=='oil' else bmass*1000/(xy_m*xy_m*z_m)
    peak=float(np.max(concentration))
    order=np.argsort(concentration)[::-1][:limit]
    output=[[round(float((unique[i,0]+.5)*xy_m/1000),4),
             round(float((unique[i,1]+.5)*xy_m/1000),4),
             -0.2 if kind=='oil' else round(float((unique[i,2]+.5)*z_m),2),
             round(float(concentration[i]),9)] for i in order if concentration[i]>0]
    return output, peak
