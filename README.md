# CoastSim — San Juan (Puerto Rico) pollution dispersion simulator

React + Three.js and FastAPI. Educational, physics-based **virtual** pollutant transport across a fixed **10 × 10 mile (16.093 × 16.093 km)** coastal square centered at **18.49° N, 66.08° W**. Actual water-column depth follows bathymetry, not a fictional 10-mile-deep cube.

### Current capabilities

- 3 pollutant presets: **surface oil**, **dissolved tracer**, **microplastic particles**, each with editable release rates, mass/decay and transport coefficients.
- Time-stepped Lagrangian stochastic transport, horizontal/vertical diffusion, windage for surface oil, density-dependent rise/sink for plastic, shoreline contact, reflective water boundaries, and open lateral borders.
- Mass accounting for remaining in water, shoreline-contacted, exited, and decayed pollutant mass; approximate particle-bin concentration and 3D playback with JSON and CSV export.
- Ensemble sensitivity runs with editable uncertainty and random seed; one member displayed, all members summarized.
- Real NOAA NCEI ETOPO 2022 bathymetry via ERDDAP (or higher-resolution local GeoTIFF), NOAA CO-OPS tides (San Juan 9755371), Open-Meteo marine current and meteorological wind forecasts, plus observational HF-radar status through CARICOOS ERDDAP.
- Optional **3D hydrodynamic NetCDF** current input (see below). Unlike a surface-only forecast, it provides particle-dependent space/depth/time velocities.
- Data-source labeling, warnings and explicit synthetic/manual modes. Live predictions **never silently substitute synthetic bathymetry**.

## Run locally (Windows PowerShell)

Install **Python 3.11+** and **Node.js 20+**.

**Terminal 1** — from this extracted project folder:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

On macOS/Linux: `python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && uvicorn main:app --reload --port 8000`.

**Terminal 2** — same folder:

```powershell
npm install
npm run dev
```

Open **http://localhost:5173/**. The frontend development server proxies `/api` and `/health` to port 8000. API docs: **http://127.0.0.1:8000/docs**.

If you can't reach public data APIs, change **Data source mode** to **Synthetic demonstration**. That mode is intentionally **not** a live prediction. **Manual mode** lets you enter assumed current components.

### Real-data sources and credentials

| Service | Role | Key required? | Access |
|---|---|---|---|
| NOAA NCEI ETOPO 2022 ERDDAP | Coarse (~450m) real seabed and coastline | **No** | https://oceanwatch.pifsc.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.html |
| NOAA CO-OPS | Observed water levels + tide predictions at station **9755371** | **No** | https://api.tidesandcurrents.noaa.gov/api/prod/ |
| CARICOOS HF radar via ERDDAP | Upper-water current observations for comparison, **not future forecasts** | **No** | https://dm3.caricoos.org/erddap/info/noaa_ndbc_59c1_a442_736e/index.html |
| Open-Meteo Marine | Time-varying **surface** current and wave forecasts | **No** for eligible noncommercial use; commercial access has licensing/keys | https://open-meteo.com/en/docs/marine-weather-api |
| Open-Meteo Weather | Forecast wind | **No** for eligible noncommercial use; commercial terms apply | https://open-meteo.com/en/docs |
| Copernicus Marine | More complete 3D forecast model data, **optional** | **Free account required** for authenticated toolbox / downloading | https://data.marine.copernicus.eu/ |
| NOAA NCEI coastal DEM | Optional higher-resolution terrain GeoTIFF | **No** | https://www.ncei.noaa.gov/products/coastal-dem |

**You don't need to buy or paste any keys to run the default app.** The provided project doesn't directly download authenticated Copernicus files; use the Copernicus Marine Toolbox/portal to subset an ocean-physics NetCDF dataset to the region and time window, then provide its path to the backend. Verify provider terms if you want to deploy the service commercially.

### Optional high-resolution coastal bathymetry

NOAA ETOPO is too coarse to resolve San Juan Bay's channels; use a locally downloaded higher-resolution DEM **that covers the entire bounding box**. Set `DEM_PATH` in the server environment to an absolute path for a georeferenced GeoTIFF with elevations in meters:

```powershell
$env:DEM_PATH = 'C:\data\san_juan_coast.tif'
uvicorn main:app --reload --port 8000
```

**Vertical datums matter:** ETOPO uses an EGM2008-based geoid datum, while the NOAA gauge uses MLLW; the app **displays** tide gauge values and does not apply them to alter terrain depth without a validated datum transformation. See `.env.example`.

### Optional 3D currents (best scientific improvement)

Prepare a CF-style **rectilinear** NetCDF export with dimensions `time × depth × latitude × longitude`, valid forecast times, depths positive downward, and components `uo`, `vo` (optionally `wo`) in **m/s**. Download/crop in space/time using your data provider first; the Python reader further subsets the file. Curvilinear or **unstructured** FVCOM meshes require regridding before this adapter can use them.

```powershell
$env:OCEAN_NETCDF_PATH = 'C:\data\san_juan_3d_currents.nc'
uvicorn main:app --reload --port 8000
```

Choose **3D NetCDF ocean-current model** in the UI. Alternate coordinate and variable names can be selected using the `OCEAN_*_VAR` variables in `.env.example`. The app rejects files that do not cover the region and entire forecast horizon. If vertical velocity (`wo`) isn't available it is explicitly assumed zero. **The 3D model and its quality depend on the external file you provide.**

### API endpoints

- `GET /health` — connectivity and optional-model configuration.
- `GET /api/spec` — spatial domain, physics presets, source notes.
- `GET /api/conditions` — forecast current and wind time series + NOAA tide observations.
- `GET /api/terrain?n=81` — real or synthetic seabed mesh (source status included).
- `GET /api/radar` — recent HF-radar observations, HTTP 503 if not available.
- `POST /api/simulate` — ensemble simulation. Pydantic validates all input fields. See the interactive API docs.

Example:

```bash
curl -X POST http://localhost:8000/api/simulate -H 'Content-Type: application/json' -d '{"pollutant":"chemical","mode":"demo","lat":18.52,"lon":-66.08,"depth_m":2,"rate_kg_s":0.1,"duration_h":0.5,"hours":3,"members":3,"kh":0.8,"kz":0.002}'
```

### Tests

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

Tests cover mass conservation, pollutant decay, Stokes settling direction, concentration units, water boundaries, ensemble reproducibility, FastAPI input validation, fake-bathymetry rejection, and local 3D NetCDF interpolation. Integration tests requiring **live internet** must be run on your machine; they have not been verified in this environment.

### Scientific limitations and disclosure

**Not suitable for environmental emergency decisions, public health decisions, regulatory use, or navigation.** This is a numerical teaching/research prototype, not a calibrated transport model.

1. Default forecast mode uses a representative **surface-current vector** at one marine forecast grid cell (~8 km resolution) across the entire local region; this is not a resolved 3D hydrodynamic forecast, and inaccurate near harbor channels.
2. The radar endpoint is a separate measurement check, **not** a source of future 3D flow. The displayed San Juan station water level is **not** a spatial hydrodynamic solver.
3. Oil fate is simplified (no emulsification, evaporation, droplet formation, oil-type chemistry). Microplastic motion uses a limited low-Re Stokes approximation (invalid for many sizes/flows) and lacks biofouling, aggregation or deposition/resuspension.
4. `kh` and `kz` are **scenario assumptions**, not inferred from sensor data; a mass-in-bin estimate depends on 400m × 400m × 5m bins and particle count. Oil uses **kg/km²** surface loading; dissolved and suspended substances use **mg/L**. These numbers are **not validated risk/exposure concentrations**.
5. Reflecting seabed and simplistic beaching are computational approximations. No biogeochemical reaction network, river inflow boundary, wave-driven Stokes drift, atmospheric deposition or pollutant measurement assimilation yet.
6. Full scientific use requires finer-resolution calibrated 3D hydrodynamics, a pollutant-specific fate model, time-varying turbulence, independent observations and validation.

Project credits: public NOAA NCEI, NOAA CO-OPS, CARICOOS and Open-Meteo API documentation. Model code is custom Python/NumPy.

### Optional Docker run

With Docker Desktop installed, from the project directory:

```bash
docker compose up --build
```

Open **http://localhost:5173/**. The web container serves the Vite production build through Nginx and proxies API calls to the backend. Store optional large local DEM/NetCDF files in `data/` and use container paths `/app/data/<filename>` in the environment.

Docker builds weren't executed in this offline environment; local Python tests and JavaScript parsing passed.

## Minimal interface update

The front-end now opens with a full-screen Three.js ocean view. The floating **Configure** control opens scenario settings, with separate **Ocean data** and **Results** tabs. **Layers** changes seabed, surface, domain box, currents, and depth exaggeration. The bottom dock provides compact playback controls and a mass/spread summary. All pollutant models and FastAPI endpoints are unchanged.

To use only the UI update in an existing local checkout, replace `App.jsx` and `styles.css` and (if your copy still uses the old proxy) `vite.config.js`, then run `npm run dev`. The new proxy configuration intentionally matches `/api/` instead of `/api` so that the frontend `api.js` file is not sent to FastAPI.

## Cesium Ion and multiple release update

See **[CESIUM_UPGRADE.md](CESIUM_UPGRADE.md)** for Cesium setup, secure public access-token restrictions, the added pollutant release/particle controls, the API diagnostics panel, known HTTP errors, and validation limitations.
