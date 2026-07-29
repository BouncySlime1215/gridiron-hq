import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.dirname(new URL(import.meta.url).pathname),
  plugins: [react()],
  server: {
    port: 5178,
    proxy: {
      '/api': 'http://localhost:5177'
    }
  }
});
