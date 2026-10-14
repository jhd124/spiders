/** Student app (/s/): separate entry, no admin code. Built with base /s/ so every asset lives under /s/assets/ (nginx: expose /s/ and /api/public/ only). */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const API = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: here('./student'),
  base: '/s/',
  plugins: [react()],
  build: { outDir: here('./dist/s'), emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5174, proxy: { '/api/public': { target: API, changeOrigin: false } } },
});
