# Minimal UI update

CoastSim now gives the Three.js water-column visualization the entire viewport.

- **Configure** opens a slide-over workspace for pollutant, release, mode, and advanced physics.
- **Data** shows NOAA/CARICOOS source status and validation notes.
- **Layers** shows seabed, surface, bounds, current arrows, and depth exaggeration.
- **Results** includes peak concentration, budget, spread chart, provenance, and export actions.
- The bottom overlay contains the playback timeline and core mass/spread metrics.
- All emoji labels were removed.
- The Vite dev proxy uses `/api/` to avoid proxying `api.js`.
- Vite is set to `^6.4.3`, in line with the earlier vulnerability fix.

## Update an existing project

Replace `App.jsx`, `styles.css`, and `vite.config.js` in your existing `san_juan_coastsim` folder. Run `npm run dev` and reload the browser. Your `main.py`, `sim.py`, and data adapters do not need changes.

## Full project

You can also use this whole folder as a fresh installation. See README.md for running the FastAPI backend and Vite frontend.
