# CoastSim — release placement, 3D cloud, study area

This is a **non-pushed working copy** based on GitHub `SudeepMangam/CoastSim`, branch `Non-Cesium` (frontend blob SHAs App `f6892031...`, Scene `7f314dd...`, styles `e986811...`), plus the NOAA/OSM backend patch discussed previously.

## Features implemented

1. **Move release markers:** A yellow marker is shown on the study area even before a run. Drag the yellow marker, or use **Move source → Click water to place** to select a valid water-surface point. The selected source's latitude/longitude updates the corresponding scenario control. Extra sources are selectable. A red marker denotes an invalid current location (land or too shallow). Location changes clear old simulation results.
2. **Particle or 3D cloud view:** Go to **Layers → Plume display**. Both modes use the same Lagrangian simulation. The cloud view uses *all active particles before display subsampling*, aggregates their masses into 350×350×8 m spatial bins (for surface oil, area bins), then applies a conservative 3×3×3 neighbor kernel for visualization. A soft transparent Three.js point-sprite display grades from dark blue to bright red. The legend indicates the **per-frame** maximum in kg/km² (oil) or mg/L (dissolved/plastic) and clearly identifies this as an uncalibrated, smoothed model estimate. It is not a true fluid/volumetric radiative-transfer solution or a validated environmental exposure product.
3. **Rectangular study bounds:** Go to **Layers → Study area**. Set center (18.40–18.56 N, −66.17 to −65.99 W) and width and length (5–24 km each), then Apply. Both terrain and OSM queries, cache keys, coordinate conversion, physics boundaries, and release validation use the selected domain. Default is 16.5×16.5 km centered at 18.49, −66.08. The vertical block fits each DEM, with optional display-only exaggeration. The optional external `model3d` NetCDF adapter is intentionally restricted to the original preset until spatial regridding is implemented. Default Open-Meteo currents remain geographically coarse and use a representative point near the original region.

## Install safely in Codex / Cursor

For the **drop-in ZIP**, copy its file contents over a fresh `Non-Cesium` checkout. Use a new test branch, not `main`:

```powershell
git switch Non-Cesium
git pull
git switch -c interactive-release-cloud-bounds
```

Then copy patch files to your repository root (new files `study_area.py`, `volume.py`, `geodata.py`, `tests/test_interactive.py`, and `tests/test_geodata.py`; replace the matching existing files). Do **not** overwrite `.env`, `.venv`, `node_modules`, or uncommitted work.

```powershell
python -m pip install -r requirements.txt
python -m pip install -r requirements-dev.txt
python -m pytest -q
npm install
npm run build
```

In two terminals:

```powershell
python -m uvicorn main:app --reload --port 8000
```

```powershell
npm run dev
```

Visit `http://localhost:5173`. You can test the API at:

- `http://localhost:8000/api/terrain?n=201&center_lat=18.52&center_lon=-66.08&width_km=9&height_km=13`
- `http://localhost:8000/api/geo?center_lat=18.52&center_lon=-66.08&width_km=9&height_km=13`

Data providers are external; NOAA DEM requests may fall back to ETOPO, then labeled synthetic terrain. Overpass may time out. For smoke tests without remote weather/current data choose **Synthetic demonstration** under Ocean forcing; it is not real-world prediction.

## Browser acceptance checklist

- Before running: yellow release marker appears. Drag marker on water. Scenario latitude/longitude change. Try land or water too shallow for the selected release depth: the drop is rejected.
- Add a second source, select it in the **Move source** dropdown, place on water, and verify **only that source** changes.
- Run in demo mode; switch **Particles ↔ 3D cloud** during playback. Frame time, simulated mass, and spread must be unchanged. The cloud legend is a model estimate, not measured ground truth.
- Change domain to 9 × 13 km with a slightly shifted center. Terrain block becomes rectangular, labels update, old results clear, data source provenance appears in Layers, and a new run rejects points outside the new boundary.
- Change back to default. Try 1× and 3× exaggeration. The simulation outputs should not depend on visualization exaggeration.
- When live data is available, visually check OSM building alignment against shoreline and validate NOAA source attribution. Mock tests alone **cannot** establish geographic accuracy.

## Verification in this authoring environment

- `python -m pytest -q`: **32 passed**.
- Parsed `App.jsx`, `Scene.jsx`, and `api.js` with the TypeScript JSX parser: **no syntax diagnostics**.
- A 24-hour 8-member demo simulation on a non-square synthetic area produced 50 frames including cloud voxels, without errors.
- **Not performed**: npm/Vite build, interactive WebGL browser test, or live NOAA/OSM network validation (dependency downloads and upstream access are unavailable here).

## Files changed

- `App.jsx`, `Scene.jsx`, `styles.css`, `api.js`: controls, placement, cloud display, geographic requests.
- `study_area.py` (new): validated per-request geographic area object.
- `terrain.py`, `geodata.py`, `main.py`: area-sensitive DEM and OSM, API, and simulation coordinate conversion.
- `sim.py`, `volume.py` (new): domain-aware particle boundaries, full-particle cloud aggregation.
- `tests/test_geodata.py`, `tests/test_interactive.py` (new): regression tests.

No remote branch or repository was modified.
