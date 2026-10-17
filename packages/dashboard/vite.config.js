import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the dashboard runs on :5173 and proxies /api to the server, so cookies stay same-origin.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': process.env.VITE_RESYNC_SERVER_URL || 'http://localhost:8787' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
