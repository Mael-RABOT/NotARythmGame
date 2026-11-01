/// <reference types="vitest" />
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { strFromU8, unzipSync } from 'fflate';

/**
 * Every `charts/*.narg` becomes a built-in song. The chart JSON is inlined into the
 * bundle (so the song list needs no download); the package itself is emitted as a
 * hashed asset and fetched only when its audio is needed.
 */
const bundledCharts = (): Plugin => {
  const ID = 'virtual:bundled-charts';
  const RESOLVED = '\0' + ID;
  const dir = fileURLToPath(new URL('./charts', import.meta.url));
  const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.narg')).sort() : []);
  return {
    name: 'bundled-charts',
    resolveId: (id) => (id === ID ? RESOLVED : undefined),
    load(id) {
      if (id !== RESOLVED) return;
      const imports: string[] = [];
      const entries: string[] = [];
      files().forEach((file, i) => {
        const full = path.join(dir, file);
        this.addWatchFile(full);
        const json = unzipSync(new Uint8Array(fs.readFileSync(full)), { filter: (f) => f.name === 'chart.json' })['chart.json'];
        if (!json) throw new Error(`charts/${file}: no chart.json inside`);
        imports.push(`import url${i} from ${JSON.stringify(full.replace(/\\/g, '/') + '?url')};`);
        entries.push(`{ file: ${JSON.stringify(file)}, url: url${i}, chart: ${strFromU8(json)} }`);
      });
      return `${imports.join('\n')}\nexport default [${entries.join(',\n')}];`;
    },
    configureServer(server) {
      server.watcher.add(dir);
      const reload = (f: string) => {
        if (!f.endsWith('.narg')) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', reload).on('unlink', reload).on('change', reload);
    },
  };
};

export default defineConfig({
  // relative base: the build can be hosted under any path (e.g. /narg/ on the portfolio)
  base: './',
  plugins: [react(), bundledCharts()],
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
