# CoastSim — changes for Cursor

Use **the full ZIP** for a fresh folder, or **the patch-only ZIP** to replace files in your existing `Non-Cesium` branch.

Changed files:

1. `Scene.jsx` — full Three.js renderer, `OrbitControls`, 16.5 km cubical boundary, elevation-derived procedural seabed/sand/grass texture, shoreline-clipped transparent water, instanced generic buildings and vegetation, high-visibility pollutant particle sprites, 2 camera presets.
2. `App.jsx` — remove Cesium imports, tokens, toggles and diagnostics; add camera presets and building/vegetation switches, keep existing FastAPI scenarios, multiple releases and results.
3. `styles.css` — small camera button overlays and updated layer panel; scene stays full-screen.
4. `package.json` — remove `cesium` and `vite-plugin-cesium` packages.
5. `vite.config.js` — remove Cesium plugin; preserve precise `/api/` proxy (does not proxy the JavaScript module `api.js`).
6. `ocean.py` — change `L_KM` to exactly `16.5` so bounds and input validation match the display.
7. `main.py` — update out-of-bounds validation error label to 16.5 km.
8. `.env.example` — no Ion token needed.
9. `README.md`, `UI_UPDATE.md` — setup and scientific disclosure.
10. Delete old `CesiumScene.jsx` and old Cesium-specific instructions.

**PowerShell from C:\Users\sudee\OneDrive\Documents\CoastSim-development (Non-Cesium branch):**

```powershell
git switch Non-Cesium
# Extract PATCH_ONLY.zip into this folder and replace existing files.
# Delete CesiumScene.jsx if present.
npm install
npm run build
npm run dev
```

In another terminal:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

To publish this branch after verifying:

```powershell
git add -A
git commit -m "Replace Cesium with rotatable 3D coastal block"
git push -u origin Non-Cesium
```

**Limitations**: NOAA input freshness cannot be tested without external network access; terrain data may fall back to clearly labeled synthetic elevations. Buildings and vegetation are procedural, not geospatial ground truth. Frontend could not be npm-built in the creation environment because npm registry DNS resolution was blocked. Backend tests and JS parser checks passed.
