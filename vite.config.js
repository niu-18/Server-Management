import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_PORT = process.env.API_PORT || 8787
const target = `http://127.0.0.1:${API_PORT}`

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      // 容器终端是 WebSocket，必须带 ws: true，否则 upgrade 会被 vite 自己吃掉
      '/ws': { target, ws: true },
    },
  },
})
