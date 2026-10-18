# CoastSim: quiet UI refresh

Based on the exact App.jsx and styles.css blobs from the Non-Cesium GitHub branch checked on 2026-10-18.
This is a **frontend-only presentation update**. No change to Scene.jsx or any simulation API/physics.

## Main changes
- Retains the CoastSim identity and release placement toolbar in the top-left (the former delete-top-left change is NOT applied).
- Flat dark surfaces with restrained single blue-grey accent; removes neon gradients, glow styling, and decorative glass effects from application chrome.
- Removes redundant always-visible orbit hints, camera button overlays, empty-state prompt, and source badge. Source information remains accessible in Configure > Ocean data and Layers > Data sources. Camera presets remain in Layers > Camera & scale.
- Reorganizes Layers as small expandable sections for visibility, camera/scale, geographic study area, and data sources.
- Water depth legend is optional via Layers > Visible layers > Depth legend; particle/cloud legends show when a simulation runs.
- Playback dock shows water mass, shore mass, and spread; removed/decayed mass remains in Configure > Results.

## Apply to your working Git checkout (recommended)
1. Make sure `git branch --show-current` returns `Non-Cesium` and `git status` is understood.
2. Extract `clean_ui.patch` into your project root. Run:

    git apply --check clean_ui.patch
    git apply clean_ui.patch

3. Run `npm run build` and `npm run dev` to check the interface on desktop and mobile.
4. If satisfied, `git add App.jsx styles.css && git commit -m "Simplify CoastSim UI" && git push origin Non-Cesium`.

## Alternative: direct replacement
The included `App.jsx` and `styles.css` can replace the matching project-root files if they match your checkout.
**Do not overwrite newer local edits;** prefer the patch if you have made additional changes.

## Validation notes
- Python suite: 32 passed (simulation and backend unchanged).
- JSX / JS source: TypeScript AST parse had no parse diagnostics for App.jsx, Scene.jsx, main.jsx, api.js.
- CSS: tinycss2 stylesheet parsed with no errors.
- Live browser behavior and `npm run build` require local test; package install is unavailable in the authoring environment.
