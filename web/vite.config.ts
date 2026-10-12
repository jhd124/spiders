import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const API = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: here('./client'),
  plugins: [react()],
  build: { outDir: here('./dist'), emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: API, changeOrigin: false } },
  },
});
