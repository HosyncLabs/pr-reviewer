import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/content.tsx'], outfile: 'dist/content.js', bundle: true,
  format: 'iife', target: 'chrome120', minify: true, legalComments: 'eof',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'text' },
});
await build({
  entryPoints: ['src/background.ts', 'src/options.ts'], outdir: 'dist', bundle: true,
  format: 'iife', target: 'chrome120', minify: true, legalComments: 'eof',
});
await copyFile('public/manifest.json', 'dist/manifest.json');
await copyFile('public/options.html', 'dist/options.html');
await copyFile('public/options.css', 'dist/options.css');
console.log('Extension ready in dist/');
