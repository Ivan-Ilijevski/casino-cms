import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    // Tunnelled in so the POS can be tested on the Android tablet it ships on:
    // Web NFC needs a secure context, which localhost-over-LAN can't give it.
    allowedHosts: ['unobliviously-untaped-johanna.ngrok-free.dev'],
    // `npm run dev:web` talks to the real CMS staff API.
    proxy: { '/api': 'http://localhost:8090' }
  }
})

