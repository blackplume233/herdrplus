import * as esbuild from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV !== 'production';
const watch = process.argv.includes('--watch');

/** Extension host bundle (Node, CommonJS — `vscode` is provided by the host). */
const hostOptions = {
  entryPoints: [resolve(root, 'src/extension.ts')],
  outfile: resolve(root, 'dist/extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: isDev,
  minify: !isDev,
  logLevel: 'info',
};

/** Sidebar webview bundle (browser IIFE + CSS). */
const webviewOptions = {
  entryPoints: {
    sidebar: resolve(root, 'src/webview/main.ts'),
    style: resolve(root, 'src/webview/style.css'),
  },
  outdir: resolve(root, 'media'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: isDev,
  minify: !isDev,
  logLevel: 'info',
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(hostOptions), esbuild.context(webviewOptions)]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[herdrplus] watching…');
} else {
  await Promise.all([esbuild.build(hostOptions), esbuild.build(webviewOptions)]);
}
