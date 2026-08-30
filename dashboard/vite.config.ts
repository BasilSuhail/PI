import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    // The server serves this directory directly.
    outDir: '../dist/public',
    emptyOutDir: true,
  },
  server: {
    // In dev the client runs on Vite and proxies the API to the real server.
    proxy: { '/api': 'http://localhost:8080' },
  },
});
