import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The manager's port for the dev proxy; matches the manager's default and AGENT_MANAGER_PORT.
const managerPort = process.env.AGENT_MANAGER_PORT ?? '4317';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  // highlight.js ships its common languages; fine for a local tool.
  build: { outDir: '../dist/ui', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://127.0.0.1:${managerPort}`, changeOrigin: true } },
  },
});
