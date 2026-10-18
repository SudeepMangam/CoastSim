import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'

// Only /api/ routes are proxied; /api.js stays a frontend module.
const backend = process.env.VITE_API || 'http://127.0.0.1:8000'
export default defineConfig({
  plugins: [react(), cesium()],
  server: { proxy: { '/api/': backend, '/health': backend } },
})
