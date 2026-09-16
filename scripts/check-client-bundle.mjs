/**
 * Regression guard for the browser half's externals.
 *
 * `dsh web` serves `lib/client.js` to the shell's module loader, which answers
 * `require()` from one frozen table: the platform seed words in
 * `packages/client/web/src/platform.ts` plus one row per dynamic bundle. A
 * specifier the bundle leaves external and no row supplies throws inside the
 * factory, cordis records an entry with no fiber, and boot fails with
 * "1 entry did not activate ... import failed" — a message that names neither
 * the specifier nor the plugin's bundling mistake.
 *
 * This check runs the built factory against a realistic table so that mistake
 * fails here, with the specifier in the message, instead of at browser boot.
 *
 * Path handling uses `node:path` and `fileURLToPath` throughout so the check
 * behaves the same on Windows, where a hand-joined path would use backslashes
 * and fail to read the artifact.
 *
 * Usage: node scripts/check-client-bundle.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The frozen platform seed, mirroring packages/client/web/src/platform.ts. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Stand-ins: the check proves resolution, not behavior, so identity is enough. */
const SEED = new Map(PLATFORM_MODULES.map(name => [name, { __seed: name }]))

const here = dirname(fileURLToPath(import.meta.url))
const artifactPath = join(here, '..', 'lib', 'client.js')

let artifact
try {
  artifact = readFileSync(artifactPath, 'utf8')
} catch (error) {
  console.error(
    `cannot read ${artifactPath} — run \`npm run build\` first.\n${error.message}`,
  )
  process.exit(1)
}

/** Collect every specifier the bundle asks the module table for. */
const requested = new Set()
for (const match of artifact.matchAll(/require\("([^"]+)"\)/g)) requested.add(match[1])

const missed = [...requested].filter(specifier => !SEED.has(specifier))
if (missed.length > 0) {
  console.error(
    `lib/client.js requires ${missed.join(', ')} — absent from the platform module table.\n`
    + 'Inline it in tsdown.config.ts (browser face) or seed it in the shell; a bare require throws at boot.',
  )
  process.exit(1)
}

/**
 * Run the factory the way the loader does.
 *
 * The loader is reached through `globalThis.window` rather than a bare
 * assignment so the check runs under Node on every platform without a browser
 * global already present.
 */
let registration
globalThis.window = {
  __ModuleLoader__: {
    load(value) { registration = value },
  },
}
new Function(artifact)()

if (registration === undefined || typeof registration.factory !== 'function') {
  console.error('lib/client.js did not register a factory through window.__ModuleLoader__.load')
  process.exit(1)
}

try {
  const exports = registration.factory((specifier) => {
    const seed = SEED.get(specifier)
    if (seed === undefined) throw new Error(`require("${specifier}") missed the module table`)
    return seed
  })
  if (typeof exports.apply !== 'function') {
    console.error('lib/client.js factory did not export `apply`')
    process.exit(1)
  }
} catch (error) {
  console.error(`lib/client.js factory threw: ${error.message}`)
  process.exit(1)
}

console.log(
  `lib/client.js ok — ${String(requested.size)} external(s), all seeded: ${[...requested].join(', ')}`,
)
