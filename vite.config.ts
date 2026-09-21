import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const apiOrigin = process.env.API_ORIGIN ?? 'http://127.0.0.1:3102';

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
  server: { proxy: { '/api': apiOrigin, '/dev': apiOrigin, '/.well-known': apiOrigin, '/authorize': apiOrigin, '/token': apiOrigin, '/mcp': apiOrigin } },
});
