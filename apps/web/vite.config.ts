import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const api = process.env.API_URL ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/collab': { target: api, ws: true },
    },
  },
})
