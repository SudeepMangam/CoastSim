import os
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]))
import numpy as np
import pytest
import xarray as xr
from datetime import datetime, timezone
from velocity_field import VelocityField3D
from ocean import LAT0,LON0


def test_local_net_cdf_3d(tmp_path):
    # This tiny export uses the same rectilinear CF shape as supported real ocean models.
    now=np.datetime64(datetime.now(timezone.utc).replace(tzinfo=None),'s')
    times=now+np.array([0,3600,7200],dtype='timedelta64[s]')
    depth=[0,5,100]
    lat=[18.2,18.49,18.8]
    lon=[-66.4,-66.08,-65.75]
    shape=(3,3,3,3)
    ds=xr.Dataset(data_vars={
      'uo':(('time','depth','latitude','longitude'),np.ones(shape,dtype='f4')*.1,{'units':'m/s'}),
      'vo':(('time','depth','latitude','longitude'),np.ones(shape,dtype='f4')*.3,{'units':'m/s'}),
      'wo':(('time','depth','latitude','longitude'),np.ones(shape,dtype='f4')*(-.01),{'units':'m/s'})},
      coords={'time':times,'depth':depth,'latitude':lat,'longitude':lon})
    path=tmp_path/'ocean.nc'
    ds.to_netcdf(path,engine='scipy')
    field=VelocityField3D(path)
    u,v,w=field.velocity(field.start+1000,np.array([0.,1.]),np.array([0.,1.]),np.array([-2.,-20.]))
    assert np.allclose(u,.1)
    assert np.allclose(v,.3)
    assert np.allclose(w,-.01)
    with pytest.raises(ValueError):field.velocity(field.end+100,np.array([0.]),np.array([0.]),np.array([-2.]))
