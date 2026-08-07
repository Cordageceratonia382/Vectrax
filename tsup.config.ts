import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { vectrax: 'src/bin/vectrax.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    dts: true,
    sourcemap: true,
  },
]);
