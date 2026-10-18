import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

// Distances are km on the scene axes. The backend sends terrain and particle z in metres.
// The block has configurable width/length and fits its vertical size to the data: deepest seabed to highest land (plus a margin).
// Updated whenever terrain or vertical exaggeration changes.
const BOX = { top: 1, bottom: -2 }
function fitBox(terrain, vex) {
  let lo = 0, hi = 0
  for (const v of terrain.h) { if (v < lo) lo = v; if (v > hi) hi = v }
  BOX.top = (Math.max(hi, 60) * vex) / 1000 + .15
  BOX.bottom = (lo * vex) / 1000 - .15
  return { minH: lo, maxH: hi }
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

function disposeContents(group) {
  const materials = new Set(), geometries = new Set(), textures = new Set()
  for (const child of [...group.children]) {
    child.traverse(o => {
      if (o.geometry) geometries.add(o.geometry)
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => materials.add(m))
    })
    group.remove(child)
  }
  for (const m of materials) {
    if (m.map) textures.add(m.map)
    m.dispose()
  }
  for (const tex of textures) tex.dispose()
  for (const geo of geometries) geo.dispose()
}
function randomGenerator(seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}
function labelSprite(text, color = '#d9e7e9') {
  const canvas = document.createElement('canvas')
  canvas.width = 512; canvas.height = 80
  const c = canvas.getContext('2d')
  c.fillStyle = 'rgba(7, 23, 32, .78)'; c.fillRect(0, 0, 512, 80)
  c.font = '600 34px system-ui'; c.fillStyle = color
  c.fillText(text, 24, 51)
  const texture = new THREE.CanvasTexture(canvas)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }))
  sprite.scale.set(4.2, .66, 1)
  return sprite
}
function sampleGrid(terrain, x, y) {
  const { n, h } = terrain
  const W = terrain.width_km || terrain.L, H = terrain.height_km || terrain.L
  const fx = clamp((x / W + .5) * (n - 1), 0, n - 1.00001)
  const fy = clamp((y / H + .5) * (n - 1), 0, n - 1.00001)
  const ix = Math.floor(fx), iy = Math.floor(fy), a = fx - ix, b = fy - iy
  const v00 = h[iy * n + ix], v10 = h[iy * n + ix + 1]
  const v01 = h[(iy + 1) * n + ix], v11 = h[(iy + 1) * n + ix + 1]
  return (v00 * (1 - a) + v10 * a) * (1 - b) + (v01 * (1 - a) + v11 * a) * b
}
function terrainTexture(terrain, geo) {
  const size = 768
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const pixels = ctx.createImageData(size, size)
  const rng = randomGenerator(58734)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = ((i + .5) / size - .5) * (terrain.width_km || terrain.L)
      const y = (.5 - (j + .5) / size) * (terrain.height_km || terrain.L)
      const h = sampleGrid(terrain, x, y)
      const noise = (rng() - .5) * 25 + Math.sin(x * 35 + Math.cos(y * 25)) * 6
      let rgb
      if (h < -350) rgb = [35, 68, 76]
      else if (h < -35) rgb = [73, 101, 104]
      else if (h < -2) rgb = [147, 158, 131]
      else if (h < 18) rgb = [217, 193, 141] // georeferenced beach-zone approximation
      else if (h < 100) rgb = [80, 123, 72]
      else rgb = [68, 103, 64]
      const idx = (j * size + i) * 4
      for (let k = 0; k < 3; k++) pixels.data[idx + k] = clamp(rgb[k] + noise, 0, 255)
      pixels.data[idx + 3] = 255
    }
  }
  ctx.putImageData(pixels, 0, 0)
  if (geo?.status === 'osm') paintLandcover(ctx, size, terrain.width_km || terrain.L, terrain.height_km || terrain.L, geo)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}
function buildingTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 256
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#aab6bd'; ctx.fillRect(0, 0, 128, 256)
  for (let row = 0; row < 9; row++) for (let col = 0; col < 4; col++) {
    ctx.fillStyle = (row + col) % 9 === 0 ? '#e9d6ad' : '#4b6778'
    ctx.fillRect(10 + col * 30, 12 + row * 27, 18, 17)
    ctx.fillStyle = '#c1d0d4'; ctx.fillRect(18 + col * 30, 12 + row * 27, 2, 17)
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// ---- Depth-aware water ------------------------------------------------------------
const waterClock = { value: 0 }
function waterMaterial(maxD, curtain) {
  // Colour encodes true water depth (square-root scale): turquoise shallows -> deep navy.
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { time: waterClock, maxD: { value: maxD }, aMin: { value: curtain ? .38 : .3 }, aMax: { value: curtain ? .92 : .8 },
      contours: { value: 1 }, surface: { value: curtain ? 0 : 1 } },
    vertexShader: `attribute float depth; varying float vD; varying vec3 vW;
      void main(){ vD = depth; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float time, maxD, aMin, aMax, contours, surface; varying float vD; varying vec3 vW;
      float ln(float v, float w){ return 1. - smoothstep(0., w, abs(vD - v)); }
      void main(){
        float t = sqrt(clamp(vD / maxD, 0., 1.));
        vec3 c = mix(vec3(.24,.78,.80), vec3(.05,.42,.68), smoothstep(0., .45, t));
        c = mix(c, vec3(.02,.10,.28), smoothstep(.35, 1., t));
        float a = mix(aMin, aMax, t);
        if (surface > .5) {
          c += sin(vW.x * 9. + time * 1.3) * sin(vW.y * 8. - time * 1.1) * .035;
          float f = pow(1. - abs(normalize(cameraPosition - vW).z), 3.);
          c = mix(c, vec3(.75,.92,1.), f * .28); a = min(1., a + f * .12);
          if (contours > .5) {
            float w = fwidth(vD) * 1.1 + 1e-4;
            float l = max(max(ln(10.,w), ln(25.,w)), max(max(ln(50.,w), ln(100.,w)), max(ln(250.,w), max(ln(500.,w), ln(1000.,w)))));
            c = mix(c, vec3(.88,.97,1.), l * .7); a = max(a, l * .75);
          }
        }
        gl_FragColor = vec4(c, a);
      }`,
  })
}
function waterCurtains(terrain, vex) {
  // Vertical cross-sections on the four block faces: the water column from surface down to the seabed.
  const { n, h } = terrain, pos = [], dep = []
  const W = terrain.width_km || terrain.L, H = terrain.height_km || terrain.L
  const at = (ix, iy) => ({ x: (ix / (n - 1) - .5) * W, y: (iy / (n - 1) - .5) * H, h: h[iy * n + ix] })
  const sides = [k => at(k, 0), k => at(k, n - 1), k => at(0, k), k => at(n - 1, k)]
  for (const side of sides) for (let k = 0; k < n - 1; k++) {
    const a = side(k), b = side(k + 1)
    if (a.h >= 0 && b.h >= 0) continue
    const za = clamp(Math.min(a.h, 0) * vex / 1000, BOX.bottom + .015, 0)
    const zb = clamp(Math.min(b.h, 0) * vex / 1000, BOX.bottom + .015, 0)
    pos.push(a.x, a.y, .003, b.x, b.y, .003, a.x, a.y, za, b.x, b.y, .003, b.x, b.y, zb, a.x, a.y, za)
    dep.push(0, 0, Math.max(0, -a.h), 0, Math.max(0, -b.h), Math.max(0, -a.h))
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('depth', new THREE.Float32BufferAttribute(dep, 1))
  return geo
}

const LAND_COLORS = { forest: '#3f7a46', scrub: '#5f8a4c', grass: '#6c9a55', wetland: '#4d7f6a', beach: '#dcc994', water: '#1f6f91', industrial: '#8d8f90', farm: '#97a25a' }
function pointInRing(x, y, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function paintLandcover(ctx, size, W, H, geo) {
  // Real OSM polygons painted over the elevation colours, in a fixed order so small features stay visible.
  const order = ['farm', 'industrial', 'grass', 'scrub', 'forest', 'wetland', 'beach', 'water']
  const polys = [...(geo?.landcover || [])].sort((a, b) => order.indexOf(a.k) - order.indexOf(b.k))
  for (const p of polys) {
    ctx.beginPath()
    p.r.forEach(([x, y], i) => { const px = (x / W + .5) * size, py = (.5 - y / H) * size; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py) })
    ctx.closePath(); ctx.fillStyle = LAND_COLORS[p.k] || '#6c9a55'; ctx.globalAlpha = p.k === 'water' ? .55 : .9; ctx.fill()
  }
  ctx.globalAlpha = 1
}
function buildRealCity(terrain, vex, geo, buildingGroup, vegetationGroup) {
  const dummy = new THREE.Object3D()
  const list = (geo.buildings || []).filter(([x, y]) => sampleGrid(terrain, x, y) > .5)
  const faces = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#c9d2d6', roughness: .9 }), Math.max(1, list.length))
  list.forEach(([x, y, w, d, hm], i) => {
    const ht = Math.max(hm / 1000 * vex, .004), z = sampleGrid(terrain, x, y) / 1000 * vex
    dummy.rotation.set(0, 0, 0); dummy.scale.set(Math.max(w, .008), Math.max(d, .008), ht)
    dummy.position.set(x, y, z + ht / 2); dummy.updateMatrix(); faces.setMatrixAt(i, dummy.matrix)
  })
  faces.count = list.length; faces.instanceMatrix.needsUpdate = true; faces.frustumCulled = false
  buildingGroup.add(faces)
  // Trees only inside mapped forest / scrub / wetland polygons.
  const rng = randomGenerator(7)
  const spots = []
  for (const p of geo.landcover || []) {
    if (!['forest', 'scrub', 'wetland'].includes(p.k)) continue
    const xs = p.r.map(q => q[0]), ys = p.r.map(q => q[1])
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    const want = Math.min(60, Math.ceil(((x1 - x0) * (y1 - y0)) * 40))
    for (let t = 0; t < want * 3 && spots.length < 4000; t++) {
      const x = x0 + rng() * (x1 - x0), y = y0 + rng() * (y1 - y0)
      if (pointInRing(x, y, p.r) && sampleGrid(terrain, x, y) > 1) spots.push([x, y])
    }
  }
  const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(.02, 1, 7).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#2f6b3d' }), Math.max(1, spots.length))
  spots.forEach(([x, y], i) => {
    const ht = .02 + rng() * .018
    dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, ht)
    dummy.position.set(x, y, sampleGrid(terrain, x, y) / 1000 * vex + ht / 2); dummy.updateMatrix(); crowns.setMatrixAt(i, dummy.matrix)
  })
  crowns.count = spots.length; crowns.instanceMatrix.needsUpdate = true; crowns.frustumCulled = false
  vegetationGroup.add(crowns)
  return { buildings: list.length, trees: spots.length }
}
function clippedWaterMesh(terrain) {
  // Triangles clipped against the zero-elevation shoreline, so water never covers land.
  const { n, h } = terrain
  const W = terrain.width_km || terrain.L, H = terrain.height_km || terrain.L
  const positions = [], normals = [], depths = []
  const corner = (ix, iy) => ({ x: (ix / (n - 1) - .5) * W, y: (iy / (n - 1) - .5) * H, h: h[iy * n + ix] })
  function triangle(a, b, c) {
    const original = [a, b, c], inside = []
    for (let k = 0; k < 3; k++) {
      const p = original[k], q = original[(k + 1) % 3]
      if (p.h <= 0) inside.push(p)
      if ((p.h < 0 && q.h > 0) || (p.h > 0 && q.h < 0)) {
        const t = p.h / (p.h - q.h)
        inside.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
      }
    }
    for (let k = 1; k < inside.length - 1; k++) {
      for (const v of [inside[0], inside[k], inside[k + 1]]) { positions.push(v.x, v.y, .003); normals.push(0, 0, 1); depths.push(Math.max(0, -(v.h || 0))) }
    }
  }
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = corner(i, j), b = corner(i + 1, j), c = corner(i, j + 1), d = corner(i + 1, j + 1)
    triangle(a, b, c); triangle(b, d, c)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setAttribute('depth', new THREE.Float32BufferAttribute(depths, 1))
  return geo
}
function buildIllustrativeCity(terrain, vex, buildingGroup, vegetationGroup) {
  // Procedural structures for spatial context. They are NOT San Juan building records.
  const rng = randomGenerator(20261017)
  const buildings = [], trees = []
  for (let trial = 0; trial < 6500 && (buildings.length < 220 || trees.length < 420); trial++) {
    const x = (rng() - .5) * ((terrain.width_km || terrain.L) - .35)
    const y = (rng() - .5) * ((terrain.height_km || terrain.L) - .35)
    const elev = sampleGrid(terrain, x, y)
    if (elev < 12 || elev > 360) continue
    const sx = Math.abs(sampleGrid(terrain, x + .08, y) - sampleGrid(terrain, x - .08, y))
    const sy = Math.abs(sampleGrid(terrain, x, y + .08) - sampleGrid(terrain, x, y - .08))
    if (Math.max(sx, sy) > 38) continue
    const z = elev / 1000 * vex
    if (rng() < .55 && buildings.length < 220) {
      const w = .035 + rng() * .09, d = .04 + rng() * .1
      const ht = (.014 + rng() ** 2 * .065) * 1.4 // visually exaggerated, not surveyed
      buildings.push({ x, y, z, w, d, ht, rotation: (rng() - .5) * .16 })
    } else if (trees.length < 420) trees.push({ x, y, z, ht: .02 + rng() * .028 })
  }
  const dummy = new THREE.Object3D()
  const box = new THREE.BoxGeometry(1, 1, 1)
  const wall = new THREE.MeshStandardMaterial({ map: buildingTexture(), roughness: .85 })
  const roofMat = new THREE.MeshStandardMaterial({ color: '#8998a0', roughness: .85 })
  const faces = new THREE.InstancedMesh(box, wall, buildings.length)
  const roofs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), roofMat, buildings.length)
  buildings.forEach(({ x, y, z, w, d, ht, rotation }, i) => {
    dummy.rotation.set(0, 0, rotation); dummy.scale.set(w, d, ht)
    dummy.position.set(x, y, z + ht / 2); dummy.updateMatrix(); faces.setMatrixAt(i, dummy.matrix)
    dummy.scale.set(w * 1.05, d * 1.05, .003)
    dummy.position.z = z + ht + .001; dummy.updateMatrix(); roofs.setMatrixAt(i, dummy.matrix)
  })
  faces.instanceMatrix.needsUpdate = true; roofs.instanceMatrix.needsUpdate = true
  faces.frustumCulled = false; roofs.frustumCulled = false
  buildingGroup.add(faces, roofs)
  const trunkGeo = new THREE.CylinderGeometry(.007, .009, 1, 6); trunkGeo.rotateX(Math.PI / 2)
  const canopyGeo = new THREE.ConeGeometry(.022, 1, 7); canopyGeo.rotateX(Math.PI / 2)
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#66543c' }), trees.length)
  const crowns = new THREE.InstancedMesh(canopyGeo, new THREE.MeshStandardMaterial({ color: '#386f43' }), trees.length)
  trees.forEach(({ x, y, z, ht }, i) => {
    dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, ht * .6)
    dummy.position.set(x, y, z + ht * .3); dummy.updateMatrix(); trunks.setMatrixAt(i, dummy.matrix)
    dummy.scale.set(1, 1, ht)
    dummy.position.z = z + ht * .75; dummy.updateMatrix(); crowns.setMatrixAt(i, dummy.matrix)
  })
  trunks.instanceMatrix.needsUpdate = true; crowns.instanceMatrix.needsUpdate = true
  trunks.frustumCulled = false; crowns.frustumCulled = false
  vegetationGroup.add(trunks, crowns)
  return { buildings: buildings.length, trees: trees.length }
}

export default function Scene({ terrain, result, frame, vex = 1, showSurface = true, showBounds = true,
  showTerrain = true, showBuildings = true, showVegetation = true, showContours = true, showCurtains = true, geo = null, currentArrow, cameraMode = 'coast', cameraResetKey = 0,
  plumeMode = 'particles', releasePoints = [], placingRelease = false, selectedRelease = 0,
  onReleaseChange = () => {}, onReleasePlacementDone = () => {} }) {
  const host = useRef(null)
  const objects = useRef(null)
  const terrainGroupRef = useRef(null)
  const cityRef = useRef(null)
  const canopyRef = useRef(null)
  const waterUniforms = useRef(null)
  const [probe, setProbe] = useState(null)
  const eventData = useRef({})
  eventData.current = { releasePoints, placingRelease, selectedRelease, onReleaseChange, onReleasePlacementDone, terrain }
  const releaseMeshes = useRef([])

  useEffect(() => {
    const el = host.current
    if (!el) return
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#0a1f2e')
    scene.fog = new THREE.Fog('#0a1f2e', 40, 110)
    const camera = new THREE.PerspectiveCamera(52, 1, .008, 160)
    camera.up.set(0, 0, 1)
    camera.position.set(13, -18, 10)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableRotate = true; controls.enablePan = true; controls.enableZoom = true
    controls.enableDamping = true; controls.dampingFactor = .075
    controls.minDistance = .2; controls.maxDistance = 105
    controls.target.set(0, -.8, -.35)
    controls.update()
    scene.add(new THREE.HemisphereLight('#f6faff', '#6f8b7d', 2.1))
    const sun = new THREE.DirectionalLight('#fff0d4', 2.3)
    sun.position.set(-6, -10, 16); scene.add(sun)
    const base = new THREE.Group(), plume = new THREE.Group(), extras = new THREE.Group()
    const releasesGroup = new THREE.Group()
    scene.add(base, plume, extras, releasesGroup)
    const resize = () => {
      const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight)
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el); resize()
    objects.current = { scene, renderer, camera, controls, base, plume, extras, releasesGroup }
    const xyPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    let interaction = null
    const canvasPos = e => {
      const bounds = renderer.domElement.getBoundingClientRect()
      ndc.set(((e.clientX - bounds.left) / bounds.width) * 2 - 1,
              -((e.clientY - bounds.top) / bounds.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
    }
    const placeAt = (e, index) => {
      const terrain = eventData.current.terrain
      if (!terrain) return false
      canvasPos(e)
      const hit = new THREE.Vector3()
      if (!ray.ray.intersectPlane(xyPlane, hit)) return false
      const W = terrain.width_km || terrain.L, H = terrain.height_km || terrain.L
      if (Math.abs(hit.x) >= W / 2 || Math.abs(hit.y) >= H / 2) return false
      const source = eventData.current.releasePoints[index]
      if (!source || sampleGrid(terrain, hit.x, hit.y) >= -Math.max(.2, Number(source.depth_m) || .2)) return false
      const a = terrain.area || {center_lat:18.49,center_lon:-66.08}
      const KY = 111.195, KX = KY * Math.cos(a.center_lat * Math.PI / 180)
      eventData.current.onReleaseChange(index, a.center_lat + hit.y / KY, a.center_lon + hit.x / KX)
      return true
    }
    const onDown = e => {
      if (e.button !== 0 || !eventData.current.terrain) return
      canvasPos(e)
      const hits = ray.intersectObjects(releaseMeshes.current, false)
      if (hits.length) {
        interaction = hits[0].object.userData.releaseIndex
      } else if (eventData.current.placingRelease) {
        interaction = eventData.current.selectedRelease
      } else return
      controls.enabled = false
      e.stopImmediatePropagation()
      e.preventDefault()
      renderer.domElement.setPointerCapture(e.pointerId)
      placeAt(e, interaction)
    }
    const onDrag = e => { if (interaction !== null) placeAt(e, interaction) }
    const onUp = e => {
      if (interaction === null) return
      placeAt(e, interaction)
      interaction = null
      controls.enabled = true
      if (eventData.current.placingRelease) eventData.current.onReleasePlacementDone()
      if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId)
    }
    renderer.domElement.addEventListener('pointerdown', onDown, true)
    renderer.domElement.addEventListener('pointermove', onDrag)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onUp)
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2()
    let lastProbe = 0
    const onMove = (e) => {
      const now = performance.now(); if (now - lastProbe < 45) return; lastProbe = now
      const o = objects.current
      if (!o || !o.terrainMesh || !o.terrainMesh.visible) { setProbe(null); return }
      const r = renderer.domElement.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      const hit = ray.intersectObject(o.terrainMesh, false)[0]
      if (!hit) { setProbe(null); return }
      setProbe({ z: Math.round(sampleGrid(o.terrainData, hit.point.x, hit.point.y)), px: e.clientX - r.left, py: e.clientY - r.top })
    }
    const onLeave = () => setProbe(null)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerleave', onLeave)
    let raf
    const render = () => { raf = requestAnimationFrame(render); waterClock.value = performance.now() / 1000; controls.update(); renderer.render(scene, camera) }
    render()
    return () => {
      renderer.domElement.removeEventListener('pointermove', onMove); renderer.domElement.removeEventListener('pointerleave', onLeave)
      renderer.domElement.removeEventListener('pointerdown', onDown, true)
      renderer.domElement.removeEventListener('pointermove', onDrag)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointercancel', onUp)
      releaseMeshes.current = []
      disposeContents(releasesGroup)
      cancelAnimationFrame(raf); observer.disconnect(); controls.dispose()
      disposeContents(base); disposeContents(plume); disposeContents(extras)
      renderer.dispose()
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement)
      objects.current = null
    }
  }, [])

  useEffect(() => {
    const obj = objects.current
    if (!obj) return
    const { camera, controls } = obj
    const cameraScale = Math.max(terrain?.width_km || 16.5, terrain?.height_km || 16.5) / 16.5
    if (cameraMode === 'block') {
      controls.target.set(0, 0, (BOX.top + BOX.bottom) / 2)
      camera.position.set(22 * cameraScale, -27 * cameraScale, (BOX.top + BOX.bottom) / 2 + 9 * cameraScale)
    } else {
      controls.target.set(0, -.8, -.30)
      camera.position.set(13 * cameraScale, -17 * cameraScale, 10 * cameraScale)
    }
    controls.update()
  }, [cameraResetKey, cameraMode, terrain])

  useEffect(() => {
    const obj = objects.current
    if (!obj || !terrain) return
    const { base } = obj
    disposeContents(base)
    const { n, h } = terrain
    const W = terrain.width_km || terrain.L, H = terrain.height_km || terrain.L
    const { minH, maxH } = fitBox(terrain, vex)
    const landscape = new THREE.Group(), buildingGroup = new THREE.Group(), vegetationGroup = new THREE.Group()
    base.add(landscape, buildingGroup, vegetationGroup)
    terrainGroupRef.current = landscape
    cityRef.current = buildingGroup
    canopyRef.current = vegetationGroup

    // Rectangular horizontal domain; vertical height fitted to bathymetry.
    if (showBounds) {
      const geometry = new THREE.BoxGeometry(W, H, BOX.top - BOX.bottom)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color: '#326a7d', transparent: true, opacity: .54, depthTest: false }))
      edges.position.z = (BOX.top + BOX.bottom) / 2
      base.add(edges)
      const labels = [
        [`${W} km E–W`, 0, -H / 2, BOX.top + .35],
        [`${H} km N–S`, W / 2, 0, BOX.top + .35],
        [`${Math.round(-minH).toLocaleString()} m deep${vex > 1 ? ` · ${vex}× vertical` : ''}`, W / 2, H / 2, (BOX.top + BOX.bottom) / 2],
      ]
      for (const [label, x, y, z] of labels) {
        const sprite = labelSprite(label); sprite.position.set(x, y, z); base.add(sprite)
      }
    }

    const plane = new THREE.PlaneGeometry(W, H, n - 1, n - 1)
    const coords = plane.getAttribute('position')
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const idx = j * n + i
      // Three.js PlaneGeometry starts at NORTH; backend height rows start at SOUTH.
      const terrainIndex = (n - 1 - j) * n + i
      coords.setZ(idx, clamp(h[terrainIndex] * vex / 1000, BOX.bottom + .015, BOX.top + 1.5))
    }
    coords.needsUpdate = true; plane.computeVertexNormals()
    const texture = terrainTexture(terrain, geo)
    const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: .99, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(plane, mat)
    mesh.visible = showTerrain; mesh.receiveShadow = true
    landscape.add(mesh)

    const maxD = Math.max(50, -minH)
    const water = new THREE.Mesh(clippedWaterMesh(terrain), waterMaterial(maxD, false))
    water.visible = showSurface; water.renderOrder = 2
    landscape.add(water)
    const curtains = new THREE.Mesh(waterCurtains(terrain, vex), waterMaterial(maxD, true))
    curtains.visible = showSurface && showCurtains; curtains.renderOrder = 1
    landscape.add(curtains)
    waterUniforms.current = water.material.uniforms
    obj.terrainMesh = mesh; obj.terrainData = terrain
    if (geo?.status === 'osm' && geo.buildings?.length) buildRealCity(terrain, vex, geo, buildingGroup, vegetationGroup)
    else buildIllustrativeCity(terrain, vex, buildingGroup, vegetationGroup)
    buildingGroup.visible = showBuildings
    vegetationGroup.visible = showVegetation
    return () => {
      // Old geometry and material are disposed by the next effect run or unmount.
      terrainGroupRef.current = null; cityRef.current = null; canopyRef.current = null; waterUniforms.current = null
    }
  }, [terrain, vex, showBounds, geo])

  useEffect(() => {
    if (terrainGroupRef.current) {
      // The terrain group contains mesh first and water second.
      terrainGroupRef.current.children[0].visible = showTerrain
      terrainGroupRef.current.children[1].visible = showSurface
      terrainGroupRef.current.children[2].visible = showSurface && showCurtains
    }
  }, [showTerrain, showSurface, showCurtains, terrain, vex, showBounds])
  useEffect(() => { if (waterUniforms.current) waterUniforms.current.contours.value = showContours ? 1 : 0 }, [showContours, terrain, vex, showBounds])
  useEffect(() => { if (cityRef.current) cityRef.current.visible = showBuildings }, [showBuildings, terrain, vex, showBounds, geo])
  useEffect(() => { if (canopyRef.current) canopyRef.current.visible = showVegetation }, [showVegetation, terrain, vex, showBounds, geo])

  useEffect(() => {
    const obj = objects.current
    if (!obj) return
    disposeContents(obj.releasesGroup)
    const terrainData = terrain
    releaseMeshes.current = []
    if (!terrainData) return
    const area = terrainData.area || {center_lat:18.49,center_lon:-66.08}
    const KY = 111.195, KX = KY * Math.cos(area.center_lat * Math.PI / 180)
    for (const [index, pt] of releasePoints.entries()) {
      const x = (Number(pt.lon) - area.center_lon) * KX
      const y = (Number(pt.lat) - area.center_lat) * KY
      const W = terrainData.width_km || terrainData.L, H = terrainData.height_km || terrainData.L
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) >= W/2 || Math.abs(y) >= H/2) continue
      const safe = sampleGrid(terrainData,x,y) < -Math.max(.2, Number(pt.depth_m) || .2)
      const material = new THREE.MeshBasicMaterial({color:safe ? '#ffe35a' : '#ff7f7f'})
      const marker = new THREE.Mesh(new THREE.SphereGeometry(.105, 16, 12), material)
      marker.position.set(x,y,.10)
      marker.userData.releaseIndex=index
      marker.renderOrder=8
      obj.releasesGroup.add(marker)
      releaseMeshes.current.push(marker)
    }
  }, [terrain, releasePoints.map(p => [p.lat,p.lon,p.depth_m].join(':')).join('|')])

  useEffect(() => {
    const obj = objects.current
    if (!obj) return
    const { plume, extras } = obj
    disposeContents(plume); disposeContents(extras)
    if (currentArrow && Number.isFinite(currentArrow[0]) && Number.isFinite(currentArrow[1])) {
      const [u, v] = currentArrow
      if (Math.hypot(u, v) > .0001) {
        const arrow = new THREE.ArrowHelper(new THREE.Vector3(u, v, 0).normalize(),
          new THREE.Vector3(-Math.min(6, (terrain?.width_km || 16.5)*.35), Math.min(5.9,(terrain?.height_km || 16.5)*.35), .4), 1.7, '#f9dc8e', .45, .24)
        extras.add(arrow)
      }
    }
    if (!result) return
    if (!frame) return
    if (plumeMode === 'cloud') {
      const voxels = frame.voxels || []
      const max = Math.max(frame.cloud_peak || 0, 1e-15)
      const positions=[], colors=[], strengths=[]
      const blue = new THREE.Color('#071a87'), cyan = new THREE.Color('#37c7ed'), yellow = new THREE.Color('#ffe45c'), red = new THREE.Color('#f01327')
      for (const [x,y,z,value] of voxels) {
        const t = Math.pow(clamp(value/max, 0, 1), .42)
        const c = t < .33 ? blue.clone().lerp(cyan,t/.33) : t < .67 ? cyan.clone().lerp(yellow,(t-.33)/.34) : yellow.clone().lerp(red,(t-.67)/.33)
        positions.push(x,y,clamp(z/1000*vex,BOX.bottom,BOX.top))
        colors.push(c.r,c.g,c.b); strengths.push(.38+.62*t)
      }
      if (positions.length) {
        const geom=new THREE.BufferGeometry()
        geom.setAttribute('position',new THREE.Float32BufferAttribute(positions,3))
        geom.setAttribute('color',new THREE.Float32BufferAttribute(colors,3))
        geom.setAttribute('strength',new THREE.Float32BufferAttribute(strengths,1))
        const material=new THREE.ShaderMaterial({
          transparent:true, depthWrite:false, vertexColors:true, blending:THREE.NormalBlending,
          vertexShader:`attribute float strength; varying vec3 col; varying float alphaV;
            void main(){ col=color; alphaV=strength; vec4 v=modelViewMatrix*vec4(position,1.);
              gl_PointSize=clamp(140.0/-v.z,14.0,65.0); gl_Position=projectionMatrix*v; }`,
          fragmentShader:`varying vec3 col; varying float alphaV;
            void main(){float d=length(gl_PointCoord-vec2(.5))*2.0;
              float a=pow(max(0.0,1.0-smoothstep(.12,1.0,d)),1.4)*alphaV*.46;
              if(a<.015)discard; gl_FragColor=vec4(col,a);}`,
        })
        const clouds=new THREE.Points(geom,material)
        clouds.frustumCulled=false; clouds.renderOrder=5; plume.add(clouds)
      }
      return
    }
    const positions = [], colors = []
    for (const p of frame.points || []) {
      const [x, y, z, intensity, sourceId = 0] = p
      positions.push(x, y, clamp(z / 1000 * vex, BOX.bottom, BOX.top))
      const c = new THREE.Color().setHSL(.55 - .48 * clamp(intensity, 0, 1), .98, .60)
      if (sourceId > 0) c.lerp(new THREE.Color('#fdd17d'), .20 * Math.min(sourceId, 4))
      colors.push(c.r, c.g, c.b)
    }
    for (const [x, y, z] of frame.beached || []) {
      positions.push(x, y, clamp(z / 1000 * vex, BOX.bottom, BOX.top))
      colors.push(1, .96, .82)
    }
    if (positions.length) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
      const points = new THREE.Points(geom, new THREE.PointsMaterial({
        size: 7, sizeAttenuation: false, vertexColors: true, depthWrite: false,
        transparent: true, opacity: .96, depthTest: true,
      }))
      points.frustumCulled = false
      points.renderOrder = 3
      plume.add(points)
    }
  }, [result, frame, vex, plumeMode, currentArrow?.[0], currentArrow?.[1]])

  return <>
    <div ref={host} className="threeHost" aria-label="Freely rotatable three-dimensional coastal simulation with draggable pollutant release markers" />
    {probe && <div className="depthProbe" style={{ left: probe.px + 16, top: probe.py + 16 }}>
      {probe.z < 0 ? <><strong>{(-probe.z).toLocaleString()} m</strong> water depth</> : <><strong>{probe.z.toLocaleString()} m</strong> above sea level</>}
    </div>}
  </>
}
