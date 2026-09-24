import { defineConfig } from 'vite';

// COOP/COEP make the page "cross-origin isolated", which unlocks
// multi-threaded WASM and SharedArrayBuffer. On GitHub Pages the service
// worker (public/sw.js) adds the same headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  clearScreen: false,
  server: { headers: isolation, port: 5173, strictPort: true },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 30000 },
});
