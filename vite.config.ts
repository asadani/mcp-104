import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        tutorial: resolve(import.meta.dirname, 'index.html'),
        app: resolve(import.meta.dirname, 'app.html'),
      },
    },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:3102', '/dev': 'http://127.0.0.1:3102', '/.well-known': 'http://127.0.0.1:3102', '/authorize': 'http://127.0.0.1:3102', '/token': 'http://127.0.0.1:3102', '/mcp': 'http://127.0.0.1:3102' } },
});
