import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('dist/main', { recursive: true });
await build({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts'],
  outdir: 'dist/main', bundle: true, platform: 'node', format: 'cjs',
  external: ['electron', 'exceljs'], target: 'node24',
});
await copyFile('database/schema.sql', 'dist/main/schema.sql');
