/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // relative base: the build can be hosted under any path (e.g. /narg/ on the portfolio)
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    // pixi is one cacheable vendor chunk (~166 kB gz); the editor is lazy-loaded
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: { pixi: ['pixi.js'], react: ['react', 'react-dom'] },
      },
    },
  },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
