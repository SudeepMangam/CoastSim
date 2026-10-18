# Camera and particles fix

This patch is based on the **Cesium Ion Upgrade** version of CoastSim.

## What changed

- Cesium starts in `SceneMode.SCENE3D` at an oblique `-38°` pitch and 24° heading, not near-vertical `-68°`.
- A small **3D view** button restores the camera after orbiting or zooming. The same option is under Layers.
- Cesium point particles are slightly larger with contrasting outlines.
- The backend emits up to 48 timeline snapshots plus the first emission step. The physically correct `t=0` frame is still empty.
- After a successful **Run simulation**, playback jumps to the first actual particle frame and starts playing automatically. **First** and replay return to the first particle frame. Manual scrubbing to zero is still possible.

## Install on Windows

Extract the **Patch ZIP** and copy `App.jsx`, `CesiumScene.jsx`, `sim.py`, and `styles.css` into your existing `san_juan_coastsim` folder, replacing the originals. Do not delete `.env.local` or your other project files.

Restart both services:

Terminal 1: `npm run dev`

Terminal 2: `.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000`

Open `http://localhost:5173/`. Press **Run simulation**. If using the **forecast** mode, NOAA bathymetry and a usable ocean forecast must be available. Errors will be shown under **Configure** and **Data**; to test particles without external data, explicitly change **Ocean forcing** to **Synthetic demonstration**.

The simulation does not claim to reproduce a validated pollutant plume: default public data are coarse and pollutant physics are simplified.
