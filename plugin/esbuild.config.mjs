// Bundles src/main.ts into dist/main.js, the file Obsidian loads, and puts
// manifest.json (kept at the repository root, where Obsidian's plugin
// directory reads it) and styles.css next to it, so dist/ is the plugin
// folder: copy it to <vault>/.obsidian/plugins/obsync/.
//   node esbuild.config.mjs            one development build (inline source map)
//   node esbuild.config.mjs production a release build (no source map)
//   node esbuild.config.mjs watch      rebuild on every change
//   node esbuild.config.mjs cli        dist/obsync-cli.mjs, the headless client
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const mode = process.argv[2] ?? 'development';

/** The build options for a mode; the bundle test uses them too, so what it checks is what ships. */
export function optionsFor(mode) {
  return {
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
    // A release is minified (about half the size to load on a phone); stack
    // traces in bug reports then need a development build to read.
    minify: mode === 'production',
    legalComments: 'none',
    logLevel: 'info',
  };
}

export const options = optionsFor(mode);

const manifest = JSON.parse(readFileSync(here('../manifest.json'), 'utf8'));

/**
 * obsync-cli (plugin/cli/, spec 2026-10-11): one ES module for Node with
 * every dependency inlined, so `node obsync-cli.mjs` is all it takes.
 */
export function cliOptions() {
  return {
    entryPoints: [here('./cli/bin.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: here('./dist/obsync-cli.mjs'),
    // Some dependencies are CommonJS and require() Node built-ins.
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __obsyncCreateRequire } from 'node:module';\nconst require = __obsyncCreateRequire(import.meta.url);" },
    define: { __OBSYNC_VERSION__: JSON.stringify(manifest.version) },
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    logLevel: 'info',
  };
}

export function copyStatic() {
  mkdirSync(here('./dist'), { recursive: true });
  copyFileSync(here('../manifest.json'), here('./dist/manifest.json'));
  copyFileSync(here('./styles.css'), here('./dist/styles.css'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (mode === 'cli') {
    await esbuild.build(cliOptions());
    chmodSync(here('./dist/obsync-cli.mjs'), 0o755);
  } else if (mode === 'watch') {
    const ctx = await esbuild.context(options);
    copyStatic();
    await ctx.watch();
  } else {
    await esbuild.build(options);
    copyStatic();
  }
}
