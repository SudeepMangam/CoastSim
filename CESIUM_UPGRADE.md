# CoastSim: Cesium Ion, multiple releases, and API diagnostics

This builds on the fullscreen/minimal-interface CoastSim project. The FastAPI data-source architecture is unchanged; the simulator has additional source-count and particle-density controls.

## Prerequisites

- Node.js 20.19+ or 22.12+ recommended for current Vite/Cesium dependencies
- Python 3.11+
- A **Cesium ion account**: https://ion.cesium.com/tokens

## Create a browser-safe Ion token

In the Cesium ion Tokens page, create a **new token for this app**. It only needs access to the imagery/terrain assets and the public `assets:read` scope. Do **not** grant private/write or asset-management scopes. For deployment, restrict the token to your website URL. For local development, add your Vite origin (typically `http://localhost:5173` and optionally `http://127.0.0.1:5173`) as allowed origins.

Create a file named **`.env.local`** next to `package.json`:

```text
VITE_CESIUM_ION_TOKEN=your_public_assets_read_token_here
```

Vite embeds all `VITE_` values in frontend code. The token is visible to site users; the security boundary is to restrict its scopes, assets and allowed URLs. Do not place a private Ion write token there or commit `.env.local`.

## Installation / upgrade

Replace the project files with this package, preserving your existing `.env.local` and your local downloaded bathymetry/NetCDF files. In the project folder:

```powershell
npm install
npm run build
npm run dev
```

In a second PowerShell terminal:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

After creating or changing `.env.local`, restart `npm run dev`.

No Cesium ion token is required for FastAPI/NOAA/Open-Meteo endpoints. With no Ion token, the app automatically opens its original local 3D viewer. Open **Layers → 3D view** to switch between the two renderers.

## Using the multiple-release controls

1. Open **Configure → Scenario → Release conditions**.
2. `Release rate` sets the injected **mass per second** for the primary source.
3. `Particles per emission step` controls **numerical sampling** per source every five simulated minutes. It does **not** change injected pollutant mass.
4. `Visible particle limit` sets the playback sampling cap (100 to 10,000). It does not change the total simulated mass or physical dynamics.
5. Select **Add source** to add up to four secondary release points, for up to **five sources of the currently selected pollutant type**. Each has its own latitude, longitude, depth, mass rate and release duration.
6. Click **Run simulation**. For performance, scenarios above 250,000 total emitted particles across ensemble members are rejected with a clear validation error.

The primary source is always the selected pollutant type. Mixing oil, chemicals and microplastics in one shared run is **not** implemented, because those require separate transport/fate rules and cannot share the same mass-concentration unit. Run the different types as separate scenarios for now.

## API diagnostics

Open **Data → API diagnostics** and choose **Export log** for a JSON snapshot of reported failures. This includes:

- Frontend/backend failed HTTP requests (status + endpoint)
- NOAA bathymetry fallback warning if real elevation was unavailable
- NOAA CO-OPS water-level errors returned inside successful `/api/conditions` responses
- Open-Meteo marine-current and wind forecast provider errors
- CARICOOS radar errors after pressing **Check radar**
- Cesium Ion imagery or renderer errors, if they occur

A successful **HTTP 200** for `/api/conditions` does **not** guarantee that every downstream provider returned data. NOAA water levels and current forecasts may be independently missing or stale.

### Errors actually observed from previously shared logs

| HTTP request | Historical result | Meaning |
|---|---|---|
| `GET /api.js` | 404 | Former Vite prefix-proxy bug; fixed by using `/api/` instead of `/api` |
| `GET /json/version` | 404 | Unrelated browser/DevTools probe, not a CoastSim route |
| `GET /docs` | 200 | FastAPI docs worked |
| `GET /openapi.json` | 200 | OpenAPI schema worked |
| `GET /api/terrain?n=81` | 200 | API responded, but may still have used synthetic fallback |

We do not have access to your current PowerShell or browser network log. The diagnostics panel reports errors observed by the newly loaded app session, not all historical or external logs.

## Visualization caveats

Cesium ion supplies **basemap imagery and general global terrain**, not water-column flow, pollutant concentrations or reliable underwater bathymetry. The optional shaded subsurface overlay is sampled from the FastAPI terrain grid and may be synthetic if NOAA is unavailable. Always check the **Ocean data** source statuses.

Geographic mapping uses a local east/north/up reference frame centered on San Juan; horizontal simulation coordinates are in kilometers, depth is in meters, and height exaggeration affects *display only*.

The ocean-current forecast used in default mode is still coarse surface data. For depth-resolved predictions, provide an appropriately resolved CF NetCDF grid using `OCEAN_NETCDF_PATH`. The results are a research prototype, not a validated spill-forecast system.

## Test status

`python -m pytest -q tests` passes locally, including multiple-release mass, particle-count changes and validation. Frontend source passes TypeScript JSX syntax transpilation. We could not run `npm install` and a complete Cesium Ion render/HTTP network test in the build environment; run `npm run build` and verify your scoped token on your network-enabled machine.
