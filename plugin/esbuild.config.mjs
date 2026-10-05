// Bundles src/main.ts into dist/main.js, the file Obsidian loads, and puts
// manifest.json (kept at the repository root, where Obsidian's plugin
// directory reads it) and styles.css next to it, so dist/ is the plugin
// folder: copy it to <vault>/.obsidian/plugins/obsync/.
//   node esbuild.config.mjs            one development build (inline source map)
//   node esbuild.config.mjs production a release build (no source map)
//   node esbuild.config.mjs watch      rebuild on every change
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const mode = process.argv[2] ?? 'development';

/** The options the bundle test also uses, so what it checks is what ships. */
export const options = {
  entryPoints: [here('./src/main.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  // BigInt literals (protobuf) need ES2020; Obsidian runs on Chromium and recent WebKit.
  target: 'es2020',
  // Provided by Obsidian at run time.
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  outfile: here('./dist/main.js'),
  sourcemap: mode === 'production' ? false : 'inline',
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
};

export function copyStatic() {
  mkdirSync(here('./dist'), { recursive: true });
  copyFileSync(here('../manifest.json'), here('./dist/manifest.json'));
  copyFileSync(here('./styles.css'), here('./dist/styles.css'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (mode === 'watch') {
    const ctx = await esbuild.context(options);
    copyStatic();
    await ctx.watch();
  } else {
    await esbuild.build(options);
    copyStatic();
  }
}
