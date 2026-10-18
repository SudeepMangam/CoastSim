# Local Three.js 3D update

Removed Cesium Ion and all globe-specific UI/dependencies. The scene is a free-orbiting, fullscreen, 16.5 × 16.5 × 16.5 km wireframe block with clipped water, shaded elevation-derived textures, generic buildings/trees, and animated pollutant data from FastAPI.

**Camera**: left mouse = orbit, right mouse = pan, wheel = zoom. Buttons **Focus coast** and **Full block** reset to different freely rotatable perspectives.

**Layers**: toggle seabed, water, physical boundary, buildings, vegetation and current direction; change display-only vertical exaggeration.

**Scientific honesty**: only elevation and particle positions are data-driven. Building locations, grass/beach visual categories and fine-grained textures are generated visual context and are not derived from cadastral, land-use or aerial imagery. The 16.5 km vertical reference frame is not a claim about ocean depth.

**Install**: extract full project or apply updated source files into the existing git checkout. `npm install && npm run build && npm run dev`; run FastAPI separately. No Cesium token required.
