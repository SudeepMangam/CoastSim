"""Validated, request-local San Juan study area in a km east/north coordinate system.

This keeps geographic geometry out of mutable module globals so two users can
request different areas concurrently without mixing terrain or OSM caches.
"""
from dataclasses import dataclass
import math

DEFAULT_LAT, DEFAULT_LON = 18.49, -66.08
DEFAULT_SIZE = 16.5
KY = 111.195


@dataclass(frozen=True)
class StudyArea:
    center_lat: float = DEFAULT_LAT
    center_lon: float = DEFAULT_LON
    width_km: float = DEFAULT_SIZE
    height_km: float = DEFAULT_SIZE

    def __post_init__(self):
        v = (self.center_lat, self.center_lon, self.width_km, self.height_km)
        if not all(math.isfinite(float(z)) for z in v):
            raise ValueError('Study area coordinates and dimensions must be finite.')
        if not (18.40 <= self.center_lat <= 18.56 and -66.17 <= self.center_lon <= -65.99):
            raise ValueError('Study-area center must stay in the San Juan coastal region (18.40–18.56 N, 66.17–65.99 W).')
        if not (5 <= self.width_km <= 24 and 5 <= self.height_km <= 24):
            raise ValueError('Study-area width and height must each be between 5 and 24 km.')

    @property
    def kx(self):
        return KY * math.cos(math.radians(self.center_lat))

    def bounds(self):
        return dict(west=self.center_lon-self.width_km/(2*self.kx),
                    east=self.center_lon+self.width_km/(2*self.kx),
                    south=self.center_lat-self.height_km/(2*KY),
                    north=self.center_lat+self.height_km/(2*KY))

    def to_xy(self, lat, lon):
        return (lon-self.center_lon)*self.kx, (lat-self.center_lat)*KY

    def to_latlon(self, x, y):
        return self.center_lat+y/KY, self.center_lon+x/self.kx

    def contains_xy(self, x, y):
        return abs(x) < self.width_km/2 and abs(y) < self.height_km/2

    def key(self):
        return tuple(round(z, 5) for z in (self.center_lat, self.center_lon, self.width_km, self.height_km))

    def json(self):
        return dict(center_lat=self.center_lat, center_lon=self.center_lon,
                    width_km=self.width_km, height_km=self.height_km)
