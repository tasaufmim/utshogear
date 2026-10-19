import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client talks to the Express API. In dev, Vite proxies /api so the
// browser only ever talks to one origin (no CORS surprises, cookies simple).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/uploads': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
