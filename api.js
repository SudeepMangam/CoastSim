const json = async (path, options) => {
  const r = await fetch(path, options)
  if (!r.ok) {
    let error = `${r.status} ${r.statusText}`
    try { const body = await r.json(); error = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail) } catch {}
    throw new Error(`${path} — HTTP ${r.status}: ${error}`)
  }
  return r.json()
}
export const api = {
  health: () => json('/health'),
  terrain: () => json('/api/terrain?n=81'),
  conditions: () => json('/api/conditions'),
  radar: () => json('/api/radar'),
  spec: () => json('/api/spec'),
  simulate: (body) => json('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
}
