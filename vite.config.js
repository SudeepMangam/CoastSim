import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Keep /api.js as a frontend module; proxy only true API routes.
const backend = process.env.VITE_API || 'http://127.0.0.1:8000'
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api/': backend, '/health': backend } },
})
