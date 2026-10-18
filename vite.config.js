import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy /api/ and /health only. Never proxy the frontend api.js module.
const backend = process.env.VITE_API || 'http://127.0.0.1:8000'
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api/': backend, '/health': backend } },
})
