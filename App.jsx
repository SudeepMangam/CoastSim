import { useEffect, useMemo, useState } from 'react'
import Scene from './Scene.jsx'
import { api } from './api.js'

const PRESETS = {
  oil: { depth_m: '0.2', half_life_h: '72', kh: '2', kz: '0', windage: '0.025', beach_probability: '0.7' },
  chemical: { depth_m: '4', half_life_h: '72', kh: '0.8', kz: '0.005', windage: '0', beach_probability: '0' },
  microplastic: { depth_m: '2', half_life_h: '0', kh: '0.8', kz: '0.003', windage: '0', beach_probability: '0.25' },
}
const POLLUTANTS = [
  ['oil', 'Oil'], ['chemical', 'Dissolved'], ['microplastic', 'Microplastics'],
]
const format = (n, d = 2) => typeof n === 'number' && Number.isFinite(n)
  ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : '—'
const localDate = (s) => {
  if (!s) return '—'
  const d = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(s) ? s : `${s}Z`)
  return Number.isNaN(+d) ? s : d.toLocaleString()
}
function save(name, value, mime = 'application/json') {
  const blob = new Blob([value], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 500)
}
function NumberField({ label, value, onChange, min, max, step, unit, title }) {
  return <label className="field" title={title || ''}>
    <span>{label}</span>
    <div className="fieldControl">
      <input type="number" step={step || 'any'} min={min} max={max} value={value} onChange={e => onChange(e.target.value)} />
      {unit && <em>{unit}</em>}
    </div>
  </label>
}
function Status({ label, detail, mode = 'off', help }) {
  return <div className="statusRow" title={help || ''}>
    <span className={`statusDot ${mode}`} aria-hidden="true" />
    <div className="statusBody"><strong>{label}</strong><small>{detail}</small></div>
  </div>
}
function Spark({ values, label }) {
  const nums = values || []
  const high = Math.max(1, ...nums.map(v => v || 0))
  const points = nums.map((v, i) => `${i * 100 / Math.max(1, nums.length - 1)},${38 - (v || 0) / high * 36}`).join(' ')
  return <div className="spark">
    <div className="sectionCaption">{label}</div>
    <svg viewBox="0 0 100 42" preserveAspectRatio="none" role="img" aria-label={label}>
      <path d="M0 39 H100" stroke="#33566b" strokeWidth=".6" />
      <polyline points={points} fill="none" stroke="#74d7ef" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  </div>
}
function Metric({ label, value, unit }) {
  return <div className="metric"><span>{label}</span><strong>{value} {unit && <small>{unit}</small>}</strong></div>
}

export default function App() {
  const [f, setF] = useState({
    pollutant: 'chemical', mode: 'forecast', lat: '18.49', lon: '-66.08',
    rate_kg_s: '0.5', duration_h: '2', hours: '24', members: '8', particles_per_step: '2', render_limit: '1750', ...PRESETS.chemical,
    diameter_mm: '0.5', density_kg_m3: '1050', settling_ms: '',
    manual_u: '0.15', manual_v: '0.03', manual_wind_u: '2', manual_wind_v: '-3',
    ensemble_current_sd: '0.02', ensemble_wind_sd: '0.2', seed: '42',
  })
  const [terrain, setTerrain] = useState(null)
  const [geo, setGeo] = useState(null)
  const [conditions, setConditions] = useState(null)
  const [health, setHealth] = useState(null)
  const [radar, setRadar] = useState(null)
  const [radarError, setRadarError] = useState('')
  const [result, setResult] = useState(null)
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [vex, setVex] = useState(3)
  const [showSurface, setShowSurface] = useState(true)
  const [showBounds, setShowBounds] = useState(true)
  const [showTerrain, setShowTerrain] = useState(true)
  const [currentArrow, setCurrentArrow] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [tab, setTab] = useState('scenario')
  const [layersOpen, setLayersOpen] = useState(false)
  const [edited, setEdited] = useState(false)
  const [cameraMode, setCameraMode] = useState('coast')
  const [cameraResetKey, setCameraResetKey] = useState(0)
  const [showBuildings, setShowBuildings] = useState(true)
  const [showVegetation, setShowVegetation] = useState(true)
  const [showContours, setShowContours] = useState(true)
  const [showCurtains, setShowCurtains] = useState(true)
  const maxDepth = useMemo(() => { if (!terrain?.h) return 0; let m = 0; for (const v of terrain.h) if (v < m) m = v; return Math.max(50, -m) }, [terrain])
  const [releases, setReleases] = useState([])


  const set = (key, value) => { setF(old => ({ ...old, [key]: value })); setEdited(true) }
  const changePollutant = value => {
    setF(old => ({ ...old, pollutant: value, ...PRESETS[value] }))
    setEdited(true)
  }
  const openTab = (nextTab) => { setTab(nextTab); setDrawerOpen(true); setLayersOpen(false) }
  useEffect(() => {
    const handleKey = e => {
      if (e.key === 'Escape') { setDrawerOpen(false); setLayersOpen(false) }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  const load = async () => {
    setLoading(true); setError('')
    const [t, c, h] = await Promise.allSettled([api.terrain(), api.conditions(), api.health()])
    if (t.status === 'fulfilled') setTerrain(t.value)
    else setError(`Terrain request failed: ${t.reason.message}`)
    if (h.status === 'fulfilled') setHealth(h.value)
    else setError(old => [old, `Backend health check failed: ${h.reason.message}`].filter(Boolean).join('\n'))
    if (c.status === 'fulfilled') setConditions(c.value)
    else setError(old => [old, `Ocean conditions request failed: ${c.reason.message}`].filter(Boolean).join('\n'))
    api.geo().then(setGeo).catch(e => setGeo({ status: 'unavailable', buildings: [], landcover: [], warnings: [e.message] }))
    setLoading(false)
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!playing || !result?.frames?.length) return
    const timer = setInterval(() => setFrame(old => {
      if (old >= result.frames.length - 1) { setPlaying(false); return old }
      return old + 1
    }), 400)
    return () => clearInterval(timer)
  }, [playing, result])

  const run = async () => {
    if (busy || !terrain) return
    setBusy(true); setError(''); setPlaying(false)
    try {
      const payload = Object.fromEntries(Object.entries(f).map(([k, v]) => [
        k, ['mode', 'pollutant'].includes(k) ? v : (v === '' ? null : Number(v)),
      ]))
      payload.additional_releases = releases.map(item => ({
        lat: Number(item.lat), lon: Number(item.lon), depth_m: Number(item.depth_m),
        rate_kg_s: Number(item.rate_kg_s), duration_h: Number(item.duration_h),
      }))
      const next = await api.simulate(payload)
      // Hour zero has no emitted mass in a continuous-release model.
      // Display the first frame with real particles immediately, then animate.
      const firstVisible = next.frames.findIndex(f => (f.points?.length || 0) + (f.beached?.length || 0) > 0)
      const startAt = Math.max(0, firstVisible)
      setResult(next); setFrame(startAt); setEdited(false)
      setPlaying(firstVisible >= 0 && startAt < next.frames.length - 1)
      setDrawerOpen(false)
    } catch (e) { setError(e.message); setDrawerOpen(true); setTab('scenario') }
    finally { setBusy(false) }
  }
  const searchRadar = async () => {
    setRadarError(''); setRadar(null)
    try { setRadar(await api.radar()) } catch (e) { setRadarError(e.message) }
  }

  const sceneFrame = result?.frames?.[frame]
  const firstParticleFrame = result?.frames?.findIndex(
    item => (item.points?.length || 0) + (item.beached?.length || 0) > 0
  ) ?? -1
  const series = conditions?.forecast?.currents?.filter(v => v.u != null && v.v != null) || []
  const wind = conditions?.forecast?.wind?.filter(v => v.wind_speed_10m != null) || []
  const lastWater = conditions?.tides?.observed
  const future = series.find(x => new Date(x.time) >= new Date()) || null
  const forecastReady = !!series.length && (f.pollutant !== 'oil' || !!wind.length)
  const releaseAmount = (+f.rate_kg_s) * Math.min(+f.hours, +f.duration_h) * 3600 +
    releases.reduce((acc, item) => acc + Number(item.rate_kg_s) * Math.min(Number(f.hours), Number(item.duration_h)) * 3600, 0)
  const addRelease = () => {
    if (releases.length >= 4) return
    const base = releases.length + 1
    setReleases(old => [...old, { id: `${Date.now()}-${base}`, lat: (Number(f.lat) + 0.006 * base).toFixed(4), lon: (Number(f.lon) + 0.005 * base).toFixed(4), depth_m: f.depth_m, rate_kg_s: f.rate_kg_s, duration_h: f.duration_h }])
    setEdited(true)
  }
  const updateRelease = (id, key, value) => { setReleases(old => old.map(item => item.id === id ? {...item, [key]: value} : item)); setEdited(true) }
  const removeRelease = id => { setReleases(old => old.filter(item => item.id !== id)); setEdited(true) }
  // Each upstream failure is reported separately. A 200 from /api/conditions does not mean all providers succeeded.
  const dataErrors = [
    ...(error ? [{source:'Application/API request',message:error}] : []),
    ...(conditions?.forecast?.errors || []).map(message => ({source:'Ocean/wind forecast',message:String(message)})),
    ...(conditions?.tides?.errors || []).map(message => ({source:'NOAA CO-OPS',message:String(message)})),
    ...(conditions?.forecast?.error ? [{source:'Forecast endpoint',message:String(conditions.forecast.error)}] : []),
    ...(conditions?.tides?.error ? [{source:'Water-level endpoint',message:String(conditions.tides.error)}] : []),
    ...(radarError ? [{source:'CARICOOS HF radar',message:radarError}] : []),
    ...(terrain?.status === 'synthetic' ? [{source:'NOAA bathymetry',message:'Real bathymetry unavailable. Fallback synthetic terrain is in use.'}] : []),
  ]

  const sources = result?.source_status
  const help = f.pollutant === 'oil'
    ? 'Floating surface oil with wind-driven transport and potential shoreline contact.'
    : f.pollutant === 'chemical'
      ? 'Dissolved contaminant with 3D mixing and optional first-order decay.'
      : 'Suspended particles that may rise or settle based on density and diameter.'
  const currentVector = !currentArrow ? null : f.mode === 'forecast' && future
    ? [future.u, future.v] : f.mode === 'manual'
      ? [Number(f.manual_u), Number(f.manual_v)] : null
  const topSource = loading ? 'Loading ocean data' : terrain?.status === 'synthetic'
    ? 'Synthetic seabed' : terrain ? 'NOAA seabed' : 'Seabed unavailable'

  return <div className="app">
    <div className="sceneStage">
      <Scene terrain={terrain} result={result} frame={sceneFrame} vex={vex}
        showSurface={showSurface} showBounds={showBounds} showTerrain={showTerrain}
        showBuildings={showBuildings} showVegetation={showVegetation} showContours={showContours} showCurtains={showCurtains} geo={geo}
        currentArrow={currentVector} cameraMode={cameraMode} cameraResetKey={cameraResetKey} />
    </div>

    <header className="floatingHeader" aria-label="Simulation toolbar">
      <div className="brandPanel">
        <span className="brandGlyph" aria-hidden="true">C</span>
        <div className="brandText"><strong>CoastSim</strong><span>San Juan, Puerto Rico</span></div>
        <div className="headerDivider" />
        <span className="domainSize">16.5 × 16.5 km{maxDepth ? ` · ${Math.round(maxDepth).toLocaleString()} m deep` : ''}</span>
      </div>
      <nav className="headerActions" aria-label="Application controls">
        <span className={`sourceBadge ${terrain?.status === 'synthetic' || !terrain ? 'sourceWarn' : 'sourceOk'}`} title="Seafloor data source">
          <span className="statusDot" />{topSource}
        </span>
        <button type="button" className="toolbarButton" onClick={() => openTab('data')}>Data</button>
        <button type="button" className="toolbarButton" aria-expanded={layersOpen} onClick={() => { setLayersOpen(x => !x); setDrawerOpen(false) }}>Layers</button>
        <button type="button" className="toolbarButton" aria-expanded={drawerOpen} onClick={() => { setDrawerOpen(x => !x); setTab('scenario'); setLayersOpen(false) }}>Configure</button>
        <button type="button" className="toolbarButton primaryToolbar" disabled={busy || !terrain} onClick={run}>{busy ? 'Simulating…' : 'Run simulation'}</button>
      </nav>
    </header>

    {layersOpen && <section className="layersPopover" aria-label="3D scene layers">
      <div className="popoverTitle"><strong>Scene layers</strong><button type="button" onClick={() => setLayersOpen(false)} aria-label="Close layers">Close</button></div>
      <div className="cameraChoice" role="group" aria-label="Camera presets">
        <button type="button" onClick={() => {setCameraMode('coast');setCameraResetKey(x=>x+1);setLayersOpen(false)}}>Focus coast</button>
        <button type="button" onClick={() => {setCameraMode('block');setCameraResetKey(x=>x+1);setLayersOpen(false)}}>Full block</button>
      </div>
      <label><input type="checkbox" checked={showTerrain} onChange={e => setShowTerrain(e.target.checked)} /> Seabed and coastline</label>
      <label><input type="checkbox" checked={showBuildings} onChange={e => setShowBuildings(e.target.checked)} /> {geo?.status === 'osm' ? 'Buildings (OpenStreetMap)' : 'Illustrative buildings'}</label>
      <label><input type="checkbox" checked={showVegetation} onChange={e => setShowVegetation(e.target.checked)} /> Vegetation</label>
      <label><input type="checkbox" checked={showSurface} onChange={e => setShowSurface(e.target.checked)} /> Water surface</label>
      <label><input type="checkbox" checked={showContours} onChange={e => setShowContours(e.target.checked)} /> Depth contours</label>
      <label><input type="checkbox" checked={showCurtains} onChange={e => setShowCurtains(e.target.checked)} /> Water column sides</label>
      <label><input type="checkbox" checked={showBounds} onChange={e => setShowBounds(e.target.checked)} /> Study boundaries</label>
      <label><input type="checkbox" checked={currentArrow} onChange={e => setCurrentArrow(e.target.checked)} /> Current direction</label>
      <div className="layerNote">Seabed &amp; land: {terrain?.source || 'loading'}.<br />Buildings &amp; land cover: {geo?.status === 'osm' ? `OpenStreetMap, ${geo.buildings.length.toLocaleString()} of ${geo.building_count_total.toLocaleString()} footprints` : geo ? 'OpenStreetMap unavailable, so buildings are illustrative only' : 'loading'}.</div>
      <label className="depthSelect">Visual depth exaggeration
        <select value={vex} onChange={e => setVex(+e.target.value)}><option value="1">1×</option><option value="3">3×</option><option value="4">4×</option><option value="8">8×</option></select>
      </label>
    </section>}

    {showSurface && terrain && !drawerOpen && <div className="depthLegend" aria-label="Water depth legend">
      <span>Water depth</span>
      <div className="depthBar">{[50, 250, 1000].filter(d => d < maxDepth).map(d => <i key={d} style={{ left: `${Math.sqrt(d / maxDepth) * 100}%` }}><b>{d >= 1000 ? `${d / 1000} km` : `${d} m`}</b></i>)}</div>
      <div className="legendEnds"><span>0 m</span><span>{Math.round(maxDepth).toLocaleString()} m</span></div>
      <small>Colour scale is compressed so nearshore depth stays readable. Lines at 10, 25, 50, 100, 250, 500 and 1,000 m. Hover the seabed to read depth.</small>
    </div>}

    <div className="orbitHint">Drag to rotate · Right-drag to pan · Scroll to zoom</div>
    <div className="cameraQuick" aria-label="Camera controls">
      <button type="button" title="Zoom to San Juan coast" onClick={() => {setCameraMode('coast');setCameraResetKey(x=>x+1)}}>Focus coast</button>
      <button type="button" title="Show the whole block" onClick={() => {setCameraMode('block');setCameraResetKey(x=>x+1)}}>Full block</button>
    </div>
    {!result && <div className="canvasHint"><strong>Ready to simulate</strong><span>Choose a pollutant and configure its release.</span><button onClick={() => openTab('scenario')}>Open setup</button></div>}
    {result && <div className="miniLegend" aria-label="Particle concentration legend"><span>Relative bin concentration</span><div className="legendGradient"/><div className="legendEnds"><span>Low</span><span>High</span></div><small className="shoreLegend">Pale particles: shoreline contact</small></div>}

    {drawerOpen && <>
      <button type="button" className="drawerScrim" aria-label="Close panel" onClick={() => setDrawerOpen(false)}/>
      <aside className="controlDrawer" aria-label="Simulation controls">
        <div className="drawerTitle"><div><span className="panelEyebrow">COASTSIM</span><h2>Workspace</h2></div><button className="closeButton" type="button" onClick={() => setDrawerOpen(false)}>Close</button></div>
        <div className="drawerTabs" role="tablist" aria-label="Workspace sections">
          {[['scenario', 'Scenario'], ['data', 'Ocean data'], ['analysis', 'Results']].map(([key, label]) =>
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{label}</button>
          )}
        </div>
        <div className="drawerBody">
          {tab === 'scenario' && <>
            <section className="drawerSection firstSection"><h3>Pollutant</h3>
              <div className="choice">{POLLUTANTS.map(([key, label]) => <button key={key} type="button" className={f.pollutant === key ? 'active' : ''} onClick={() => changePollutant(key)}>{label}</button>)}</div>
              <p className="helpText">{help}</p>
            </section>
            <section className="drawerSection"><h3>Ocean forcing</h3>
              <label className="selectLabel" htmlFor="data-mode">Current data source</label>
              <select id="data-mode" className="wideSelect" value={f.mode} onChange={e => set('mode', e.target.value)}>
                <option value="forecast">Public surface-current forecast</option>
                <option value="model3d">3D NetCDF current model</option>
                <option value="manual">Manual current values</option>
                <option value="demo">Synthetic demonstration</option>
              </select>
              {f.mode === 'model3d' && <p className={health?.model3d_configured ? 'helpText' : 'inlineWarning'}>{health?.model3d_configured ? 'A local NetCDF current field is configured.' : '3D model unavailable. Configure OCEAN_NETCDF_PATH in FastAPI.'}</p>}
              {f.mode === 'forecast' && !forecastReady && <p className="inlineWarning">Required forecast fields are unavailable. Try manual or demonstration mode.</p>}
              {f.mode === 'demo' && <p className="inlineWarning">Uses synthetic velocities, not live ocean data.</p>}
              {f.mode === 'manual' && <div className="inputGroup">
                <NumberField label="Eastward current" value={f.manual_u} onChange={v => set('manual_u', v)} unit="m/s"/>
                <NumberField label="Northward current" value={f.manual_v} onChange={v => set('manual_v', v)} unit="m/s"/>
                <NumberField label="Eastward wind" value={f.manual_wind_u} onChange={v => set('manual_wind_u', v)} unit="m/s"/>
                <NumberField label="Northward wind" value={f.manual_wind_v} onChange={v => set('manual_wind_v', v)} unit="m/s"/>
              </div>}
            </section>
            <section className="drawerSection"><h3>Release conditions</h3>
              <NumberField label="Latitude" value={f.lat} onChange={v => set('lat', v)} step="0.001"/>
              <NumberField label="Longitude" value={f.lon} onChange={v => set('lon', v)} step="0.001"/>
              <NumberField label="Release depth" value={f.depth_m} onChange={v => set('depth_m', v)} unit="m" min="0.05"/>
              <NumberField label="Release rate" value={f.rate_kg_s} onChange={v => set('rate_kg_s', v)} unit="kg/s" min="0.0001"/>
              <NumberField label="Duration" value={f.duration_h} onChange={v => set('duration_h', v)} unit="h" min="0.1"/>
              <NumberField label="Simulation horizon" value={f.hours} onChange={v => set('hours', v)} unit="h" min="1" max="96"/>
              <NumberField label="Ensemble members" value={f.members} onChange={v => set('members', v)} unit="runs" min="1" max="24" step="1"/>
              <NumberField label="Particles per emission step" value={f.particles_per_step} onChange={v => set('particles_per_step', v)} unit="/5 min" min="1" max="20" step="1" title="Higher counts produce a smoother plume and a slower backend calculation. Each release contributes this many particles per 5-minute step."/>
              <NumberField label="Visible particle limit" value={f.render_limit} onChange={v => set('render_limit', v)} unit="points" min="100" max="10000" step="100" title="Controls display sampling; the backend keeps all simulated particles."/>
              <div className="releaseHeading"><h3>Additional pollutant sources</h3><button type="button" className="textButton" onClick={addRelease} disabled={releases.length >= 4}>Add source</button></div>
              <p className="helpText">Simulate up to five independent release locations of the selected pollutant type. Each source has its own mass rate and depth.</p>
              {releases.map((item,i) => <div className="releaseCard" key={item.id}>
                <div className="releaseHeading"><strong>Source {i+2}</strong><button type="button" className="textButton" onClick={()=>removeRelease(item.id)}>Remove</button></div>
                <NumberField label="Latitude" value={item.lat} onChange={v=>updateRelease(item.id,'lat',v)} step="0.001" />
                <NumberField label="Longitude" value={item.lon} onChange={v=>updateRelease(item.id,'lon',v)} step="0.001" />
                <NumberField label="Depth" value={item.depth_m} onChange={v=>updateRelease(item.id,'depth_m',v)} unit="m" min="0.05" />
                <NumberField label="Release rate" value={item.rate_kg_s} onChange={v=>updateRelease(item.id,'rate_kg_s',v)} unit="kg/s" min="0.0001" />
                <NumberField label="Duration" value={item.duration_h} onChange={v=>updateRelease(item.id,'duration_h',v)} unit="h" min="0.1" />
              </div>)}
              <div className="inputEstimate"><span>Maximum input mass</span><strong>{format(releaseAmount, 1)} kg</strong></div>
            </section>
            <section className="drawerSection"><details className="advancedSection"><summary>Advanced physics</summary>
              <div className="advancedInner">
                <NumberField label="Horizontal diffusivity" value={f.kh} onChange={v => set('kh', v)} unit="m²/s" min="0"/>
                <NumberField label="Vertical diffusivity" value={f.kz} onChange={v => set('kz', v)} unit="m²/s" min="0"/>
                <NumberField label="Half-life (0 = none)" value={f.half_life_h} onChange={v => set('half_life_h', v)} unit="h" min="0"/>
                <NumberField label="Beach probability" value={f.beach_probability} onChange={v => set('beach_probability', v)} unit="0–1" min="0" max="1" step="0.1"/>
                {f.pollutant === 'oil' && <NumberField label="Surface windage" value={f.windage} onChange={v => set('windage', v)} unit="ratio" min="0" max="0.15" step="0.005"/>}
                {f.pollutant === 'microplastic' && <>
                  <NumberField label="Particle diameter" value={f.diameter_mm} onChange={v => set('diameter_mm', v)} unit="mm" min="0.001"/>
                  <NumberField label="Particle density" value={f.density_kg_m3} onChange={v => set('density_kg_m3', v)} unit="kg/m³"/>
                  <NumberField label="Settling override" value={f.settling_ms} onChange={v => set('settling_ms', v)} unit="m/s" title="Blank = calculated estimate. Positive = rising."/>
                </>}
              </div>
            </details>
            <details className="advancedSection"><summary>Ensemble uncertainty</summary>
              <div className="advancedInner">
                <NumberField label="Current error spread" value={f.ensemble_current_sd} onChange={v => set('ensemble_current_sd', v)} unit="m/s"/>
                <NumberField label="Wind error spread" value={f.ensemble_wind_sd} onChange={v => set('ensemble_wind_sd', v)} unit="m/s"/>
                <NumberField label="Random seed" value={f.seed} onChange={v => set('seed', v)} step="1"/>
              </div>
            </details></section>
            {error && <div className="alert" role="alert">{error}</div>}
            <p className="disclaimer">Research prototype. Not for emergency response or environmental regulation.</p>
          </>}
          {tab === 'data' && <>
            <section className="drawerSection firstSection"><div className="inlineHeading"><h3>Environmental sources</h3><button type="button" className="textButton" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh data'}</button></div>
              <Status label="NOAA seabed" detail={terrain?.source || 'No elevation source'} mode={terrain?.status === 'synthetic' ? 'warn' : terrain ? 'ok' : 'off'} help={terrain?.warnings?.join(' ')} />
              <Status label="Ocean current forecast" detail={series.length ? `${series.length} forecast points · coarse surface grid` : 'Unavailable'} mode={series.length ? 'ok' : 'warn'} />
              <Status label="Wind forecast" detail={wind.length ? `${wind.length} forecast points` : 'Unavailable'} mode={wind.length ? 'ok' : 'warn'} />
              <Status label="NOAA water level" detail={lastWater?.height_m != null ? `${format(lastWater.height_m, 3)} m MLLW · ${localDate(lastWater.time)}` : 'No recent observation'} mode={lastWater?.height_m != null ? 'ok' : 'warn'} help={(conditions?.tides?.errors || []).join(' ')} />
              {error && <div className="alert" role="alert">{error}</div>}
            </section>
            <section className="drawerSection"><div className="inlineHeading"><h3>HF radar observations</h3><button type="button" className="textButton" onClick={searchRadar}>Check radar</button></div>
              {radar ? <p className="sourceDetail">Mean observed current: east {format(radar.mean_u, 3)} m/s, north {format(radar.mean_v, 3)} m/s.</p> : <p className="helpText">Check whether recent regional surface-current observations are available.</p>}
              {radarError && <p className="inlineWarning">{radarError}</p>}
            </section>
            <section className="drawerSection"><h3>Data limitations</h3>
              <p className="sourceDetail">Satellite and forecast surface currents are too coarse to resolve detailed harbor circulation. A compatible 3D current model improves depth-dependent transport.</p>
              <p className="sourceDetail">San Juan water-level measurements use an MLLW datum and are not directly applied to ETOPO EGM2008 elevations.</p>
              {terrain?.warnings?.map((warning, i) => <p key={i} className="inlineWarning">{warning}</p>)}
            </section>
            <section className="drawerSection"><div className="inlineHeading"><h3>API diagnostics ({dataErrors.length})</h3><button type="button" className="textButton" onClick={() => save('coastsim-api-diagnostics.json', JSON.stringify({generated_at:new Date().toISOString(),errors:dataErrors,health,terrain_source:terrain?.source,conditions_retrieved_at:conditions?.retrieved_at},null,2))}>Export log</button></div>
              {dataErrors.length ? dataErrors.map((item,i) => <div key={i} className="apiError"><strong>{item.source}</strong><span>{item.message}</span></div>) : <p className="helpText">No API failures reported by the current session. This does not guarantee the upstream feeds are fresh or scientifically adequate.</p>}
            </section>
          </>}
          {tab === 'analysis' && <>
            {!result ? <div className="noResults"><h3>No simulation loaded</h3><p>Run a scenario to explore plume statistics, data provenance, and exports.</p><button className="textButton" onClick={() => setTab('scenario')}>Open scenario</button></div> : <>
              <section className="drawerSection firstSection"><h3>Current frame</h3>
                <dl className="provenance"><dt>Peak concentration estimate</dt><dd>{format(sceneFrame?.peak, 4)} {result.concentration_unit || '—'}</dd><dt>Pollutant mass in water</dt><dd>{format(sceneFrame?.budget?.water_kg, 2)} kg</dd><dt>On shore</dt><dd>{format(sceneFrame?.budget?.beached_kg, 2)} kg</dd><dt>Removed / decayed</dt><dd>{format(sceneFrame?.budget?.decayed_kg, 2)} kg</dd></dl>
              </section>
              <section className="drawerSection"><h3>Dispersion over time</h3><Spark values={result.frames?.map(a => a.spread_km)} label="Maximum spread from source (km)" /></section>
              <section className="drawerSection"><h3>Model provenance</h3>
                <dl className="provenance"><dt>Currents</dt><dd>{sources?.currents || '—'}</dd><dt>Wind</dt><dd>{sources?.wind || '—'}</dd><dt>Seabed</dt><dd>{sources?.terrain || terrain?.source || '—'}</dd>{sources?.forecast_start && <><dt>Forecast start</dt><dd>{localDate(sources.forecast_start)}</dd></>}</dl>
                {sources?.warnings?.map((w, i) => <p key={i} className="inlineWarning">{w}</p>)}
              </section>
              <section className="drawerSection"><h3>Export results</h3>
                <div className="exportGroup"><button className="toolbarButton" onClick={() => save('san-juan-simulation.json', JSON.stringify({ config: f, result }, null, 2))}>Export JSON</button><button className="toolbarButton" onClick={() => save('plume-frame.csv', ['x_km,y_km,z_m,relative_bin_concentration', ...(sceneFrame?.points || []).map(p => p.join(','))].join('\n'), 'text/csv')}>Export frame CSV</button></div>
              </section>
              <p className="disclaimer">{result.concentration_warning || 'Concentration is an estimated quantity. Validate resolution and data quality before scientific interpretation.'}</p>
            </>}
          </>}
        </div>
        {tab === 'scenario' && <div className="drawerFooter"><button className="runFromDrawer" disabled={busy || !terrain} onClick={run}>{busy ? 'Simulating…' : 'Run simulation'}</button></div>}
      </aside>
    </>}

    <footer className="playbackDock">
      <div className="dockMain">
        <div className="playControls" role="group" aria-label="Simulation playback">
          <button type="button" disabled={!result} title="Go to first frame" onClick={() => { setPlaying(false); setFrame(Math.max(0, firstParticleFrame)) }}>First</button>
          <button type="button" disabled={!result} className="playButton" onClick={() => { if (result && frame === result.frames.length - 1) setFrame(Math.max(0, firstParticleFrame)); setPlaying(!playing) }}>{playing ? 'Pause' : 'Play'}</button>
          <button type="button" disabled={!result} title="Next frame" onClick={() => { setPlaying(false); setFrame(Math.min((result?.frames.length || 1) - 1, frame + 1)) }}>Next</button>
        </div>
        <div className="timeBlock"><strong>{sceneFrame ? `+${format(sceneFrame.hour, 1)} h` : '0.0 h'}</strong><span>{result ? `${result.pollutant} · ${result.mode}${edited ? ' · Inputs changed' : ''}` : 'No simulation loaded'}</span></div>
        <div className="dockMetrics">
          <Metric label="In water" value={format(sceneFrame?.budget?.water_kg, 1)} unit="kg" />
          <Metric label="On shore" value={format(sceneFrame?.budget?.beached_kg, 1)} unit="kg" />
          <Metric label="Removed" value={format(sceneFrame?.budget?.decayed_kg, 1)} unit="kg" />
          <Metric label="Spread" value={format(sceneFrame?.spread_km)} unit="km" />
          <button type="button" className="resultsLink" onClick={() => openTab('analysis')}>Details</button>
        </div>
      </div>
      <div className="scrubRow"><span>0 h</span><input type="range" aria-label="Simulation time" min="0" max={Math.max(0, (result?.frames?.length || 1) - 1)} step="1" value={frame} disabled={!result} onChange={e => { setPlaying(false); setFrame(+e.target.value) }} /><span>{result?.frames?.length ? `${format(result.frames.at(-1).hour, 1)} h` : '—'}</span></div>
    </footer>
  </div>
}
