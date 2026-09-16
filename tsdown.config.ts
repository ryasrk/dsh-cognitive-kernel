/**
 * Build config for the cognitive-kernel plugin.
 *
 * Three artifacts, two runtimes:
 *
 *   `lib/index.js`    the Host half, plain ESM for Node 22.
 *   `lib/remote.js`   the Host Remote service, plain ESM for Node 22.
 *   `lib/client.js`   the browser half, emitted as a CJS closure-factory so the
 *                     shell's module loader can serve it. `react` stays an
 *                     import because the shell owns the single React instance.
 *
 * The two faces externalize different sets. The Host half imports every
 * `@deepseek-ai/*` name because Node resolves those for real. The browser half
 * must not: the loader's module table holds a fixed set of seed words, and a
 * `require()` the table cannot answer throws inside the factory, so the entry
 * never activates and boot dies. Anything the client reaches that is not a seed
 * word is therefore inlined, even where the Host half imports the same name.
 */

import { defineConfig } from 'tsdown'

/** Runtime-provided by the DSH Node host, so the Host halves keep them as imports. */
const PROVIDED = /^(@deepseek-ai\/|react$|react-dom$|node:)/

/** Seed words of the shell's frozen browser module table. Everything else is bundled. */
const BROWSER_SEED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

export default defineConfig([
  {
    name: 'dsh-cognitive-kernel',
    entry: { index: 'src/index.ts', remote: 'src/remote.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: (specifier) => PROVIDED.test(specifier),
      alwaysBundle: (specifier) => !PROVIDED.test(specifier),
    },
  },
  {
    name: 'dsh-cognitive-kernel/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: (specifier) => BROWSER_SEED.has(specifier),
      alwaysBundle: (specifier) => !BROWSER_SEED.has(specifier),
    },
    tsconfig: 'tsconfig.client.json',
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-cognitive-kernel", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
