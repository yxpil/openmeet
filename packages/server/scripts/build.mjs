import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['ws', 'node-turn', 'bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire as __openmeetCreateRequire } from 'node:module'; const require = __openmeetCreateRequire(import.meta.url);"
  }
});
