import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: path.dirname(fileURLToPath(import.meta.url)),
  plugins: [react()],
  server: {
    // Overridable so a second dev instance (e.g. a background verification
    // session) can run alongside the usual one without a port clash.
    port: Number(process.env.VITE_CLIENT_PORT) || 5178,
    proxy: {
      '/api': process.env.VITE_API_PROXY || 'http://localhost:5177'
    }
  }
});
