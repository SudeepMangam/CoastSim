import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

// Cesium is a georeferenced VISUALIZATION. Dispersion still runs in FastAPI.
// x/y are km east/north of ocean.LON0/LAT0; z is meters above sea level.
const CENTER_LON = -66.08
const CENTER_LAT = 18.49
// Pitch is measured below the local horizon: -38° is visibly oblique;
// -90° would look like the flat, top-down map reported by the user.
const VIEW_HEADING = Cesium.Math.toRadians(24)
const VIEW_PITCH = Cesium.Math.toRadians(-38)
const VIEW_RANGE_M = 29000
const VIEW_CENTER = Cesium.Cartesian3.fromDegrees(CENTER_LON, CENTER_LAT, 0)

function restore3DView(viewer) {
  if (viewer.isDestroyed()) return
  // Ion terrain is still a 3D globe, even where ocean bathymetry is shown
  // separately as a transparent NOAA-derived mesh.
  viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(VIEW_CENTER, 8000),
    { duration: 0, offset: new Cesium.HeadingPitchRange(VIEW_HEADING, VIEW_PITCH, VIEW_RANGE_M) }
  )
  viewer.scene.requestRender()
}

function localPoint(x, y, z, exaggeration = 1) {
  return new Cesium.Cartesian3(x * 1000, y * 1000, z * exaggeration)
}

function buildBathymetry(terrain, modelMatrix, exaggeration) {
  if (!terrain?.h || !terrain.n || terrain.h.length !== terrain.n * terrain.n) return null
  const n = terrain.n
  // 41x41 samples (for n=81), with no mesh beyond the study area.
  const step = Math.max(1, Math.ceil((n - 1) / 40))
  const indicesAt = []
  for (let i = 0; i < n; i += step) indicesAt.push(i)
  if (indicesAt.at(-1) !== n - 1) indicesAt.push(n - 1)
  const sz = indicesAt.length
  const verts = []
  const tri = []
  for (let iy = 0; iy < sz; iy++) {
    for (let ix = 0; ix < sz; ix++) {
      const gx = indicesAt[ix], gy = indicesAt[iy]
      const east = (gx / (n - 1) - 0.5) * terrain.L
      const north = (gy / (n - 1) - 0.5) * terrain.L
      const h = Number(terrain.h[gy * n + gx])
      const point = Cesium.Matrix4.multiplyByPoint(modelMatrix, localPoint(east, north, h, exaggeration), new Cesium.Cartesian3())
      verts.push(point.x, point.y, point.z)
    }
  }
  for (let iy = 0; iy < sz - 1; iy++) {
    for (let ix = 0; ix < sz - 1; ix++) {
      const a = iy * sz + ix, b = a + 1, c = a + sz, d = c + 1
      tri.push(a, b, c, b, d, c)
    }
  }
  const positions = new Float64Array(verts)
  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: positions,
      }),
    },
    indices: positions.length / 3 > 65535 ? new Uint32Array(tri) : new Uint16Array(tri),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
  })
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry,
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString('#126487').withAlpha(.6)) },
    }),
    appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
    asynchronous: false,
  })
}

export default function CesiumScene({ token, terrain, result, frame, vex, showTerrain, showBounds, showSurface, currentArrow, onError, cameraResetKey }) {
  const host = useRef(null)
  const refs = useRef(null)
  const [initializationError, setInitializationError] = useState('')

  useEffect(() => {
    let viewer
    try {
      Cesium.Ion.defaultAccessToken = token
      // Cesium's imagery layer and terrain are from ion; errors are reported, never treated as real NOAA currents.
      viewer = new Cesium.Viewer(host.current, {
        animation: false, timeline: false, baseLayerPicker: false,
        fullscreenButton: false, geocoder: false, homeButton: false,
        infoBox: false, sceneModePicker: false, selectionIndicator: false,
        navigationHelpButton: false, sceneMode: Cesium.SceneMode.SCENE3D,
        scene3DOnly: true, requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
        baseLayer: Cesium.ImageryLayer.fromWorldImagery(),
        terrain: Cesium.Terrain.fromWorldTerrain(),
      })
      viewer.scene.globe.depthTestAgainstTerrain = false
      // Keep the globe translucent so particles below sea level remain visible.
      viewer.scene.globe.translucency.enabled = true
      viewer.scene.globe.translucency.frontFaceAlpha = 0.65
      viewer.scene.globe.translucency.backFaceAlpha = 0.30
      viewer.scene.fog.enabled = false
      viewer.scene.screenSpaceCameraController.enableTilt = true
      viewer.scene.screenSpaceCameraController.enableRotate = true
      restore3DView(viewer)
      viewer.scene.renderError.addEventListener((_scene, error) => {
        onError(`Cesium renderer: ${error?.message || String(error)}`)
      })
      const baseLayer = viewer.imageryLayers.get(0)
      if (baseLayer) {
        baseLayer.errorEvent.addEventListener(error => onError(`Cesium Ion imagery: ${error?.message || String(error)}`))
      }
      viewer.scene.globe.tileLoadProgressEvent.addEventListener(() => viewer.scene.requestRender())
      const matrix = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(CENTER_LON, CENTER_LAT, 0))
      const points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection({ modelMatrix: matrix }))
      const bathy = viewer.scene.primitives.add(new Cesium.PrimitiveCollection())
      refs.current = { viewer, matrix, points, bathy, currentLine: null, bounds: [], surface: null, markers: [] }
      setInitializationError('')
      viewer.scene.requestRender()
    } catch (err) {
      const message = `Could not initialize Cesium Ion: ${err?.message || String(err)}`
      setInitializationError(message)
      onError(message)
    }
    return () => {
      refs.current = null
      if (viewer && !viewer.isDestroyed()) viewer.destroy()
    }
  }, [token, onError])

  useEffect(() => {
    const viewer = refs.current?.viewer
    if (viewer) restore3DView(viewer)
  }, [cameraResetKey])

  useEffect(() => {
    const state = refs.current
    if (!state) return
    const { viewer, bathy, matrix } = state
    bathy.removeAll()
    if (terrain && showTerrain) {
      try {
        const mesh = buildBathymetry(terrain, matrix, vex)
        if (mesh) bathy.add(mesh)
      } catch (err) {
        onError(`Local bathymetry overlay: ${err.message}`)
      }
    }
    // World satellite imagery remains visible. The NOAA grid is a separate geometric overlay.
    const imagery = viewer.imageryLayers.get(0)
    if (imagery) imagery.show = true
    viewer.scene.requestRender()
  }, [terrain, vex, showTerrain, onError])

  useEffect(() => {
    const state = refs.current
    if (!state) return
    const { viewer, matrix } = state
    for (const entity of state.bounds) viewer.entities.remove(entity)
    state.bounds = []
    if (state.surface) viewer.entities.remove(state.surface)
    state.surface = null
    const L = terrain?.L || 16.09344
    const z = 4
    if (showBounds) {
      const perimeter = [[-L/2,-L/2],[L/2,-L/2],[L/2,L/2],[-L/2,L/2],[-L/2,-L/2]]
      const coords = perimeter.map(([x,y]) => Cesium.Matrix4.multiplyByPoint(matrix, localPoint(x,y,z), new Cesium.Cartesian3()))
      state.bounds.push(viewer.entities.add({ polyline: { positions: coords, width: 2, material: Cesium.Color.CYAN.withAlpha(.75) } }))
    }
    if (showSurface) {
      const corners = [[-L/2,-L/2],[L/2,-L/2],[L/2,L/2],[-L/2,L/2]]
      state.surface = viewer.entities.add({ polygon: {
        hierarchy: corners.map(([x,y]) => Cesium.Matrix4.multiplyByPoint(matrix, localPoint(x,y,0), new Cesium.Cartesian3())),
        material: Cesium.Color.fromCssColorString('#2383b4').withAlpha(.055),
        perPositionHeight: true,
      } })
    }
    viewer.scene.requestRender()
  }, [terrain, showBounds, showSurface])

  useEffect(() => {
    const state = refs.current
    if (!state) return
    const { viewer, matrix } = state
    if (state.currentLine) viewer.entities.remove(state.currentLine)
    state.currentLine = null
    if (currentArrow && Number.isFinite(currentArrow[0]) && Number.isFinite(currentArrow[1])) {
      const [u,v] = currentArrow
      const size = Math.hypot(u,v)
      if (size > 0.0001) {
        const start = Cesium.Matrix4.multiplyByPoint(matrix, localPoint(-6,6,20), new Cesium.Cartesian3())
        // Both ends are in a consistent local ENU reference frame.
        const second = Cesium.Matrix4.multiplyByPoint(matrix, localPoint(-6+u/size*2,6+v/size*2,20), new Cesium.Cartesian3())
        state.currentLine = viewer.entities.add({ polyline: { positions: [start,second], width: 5, material: new Cesium.PolylineArrowMaterialProperty(Cesium.Color.CYAN) } })
      }
    }
    viewer.scene.requestRender()
  }, [currentArrow?.[0], currentArrow?.[1]])

  useEffect(() => {
    const state = refs.current
    if (!state) return
    const { viewer, points } = state
    points.removeAll()
    for (const item of state.markers) viewer.entities.remove(item)
    state.markers = []
    if (!result) { viewer.scene.requestRender(); return }
    const releases = [result.inputs.release_km, ...(result.inputs.additional_release_km || [])]
    releases.forEach(([x,y], i) => {
      const position = Cesium.Matrix4.multiplyByPoint(state.matrix,
        localPoint(x,y,-(i === 0 ? result.inputs.depth_m : (result.inputs.additional_release_depth_m || [])[i-1] || 0),vex),new Cesium.Cartesian3())
      state.markers.push(viewer.entities.add({position,
        point:{pixelSize:11,color: Cesium.Color.YELLOW,outlineWidth:2,
          outlineColor:Cesium.Color.BLACK,disableDepthTestDistance:Number.POSITIVE_INFINITY},
        label:{text:`Release ${i+1}`,font:'12px sans-serif',pixelOffset:new Cesium.Cartesian2(0,-19),
          fillColor:Cesium.Color.WHITE,style:Cesium.LabelStyle.FILL_AND_OUTLINE,outlineWidth:2,
          disableDepthTestDistance:Number.POSITIVE_INFINITY}}))
    })
    if (frame) {
      for (const [x,y,z,intensity] of frame.points || []) {
        const c = Cesium.Color.fromHsl(.52-.52*Math.pow(Math.max(0,Math.min(1,intensity)),.65),.95,.58,.94)
        points.add({
          position: localPoint(x,y,z,vex),
          pixelSize: 7 + 3 * Math.max(0, Math.min(1, intensity)),
          color: c, outlineColor: Cesium.Color.BLACK.withAlpha(.75),
          outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        })
      }
      for (const [x,y,z] of frame.beached || []) {
        points.add({position:localPoint(x,y,z,vex),pixelSize:6,color:Cesium.Color.WHITE,disableDepthTestDistance:Number.POSITIVE_INFINITY})
      }
    }
    viewer.scene.requestRender()
  }, [result, frame, vex])

  return <div ref={host} className="cesiumHost" aria-label="Cesium Ion San Juan 3D globe">
    {initializationError && <div className="cesiumError">{initializationError} — Switch to Local bathymetry in Layers.</div>}
  </div>
}
