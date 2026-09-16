/**
 * Clear `lib/` before a build.
 *
 * Two tsdown configs write into `lib/`: the Host half emits `index.js` and
 * `remote.js`, the Client half emits `client.js`. Neither can set `clean: true`,
 * because whichever runs second would delete the first one's output.
 *
 * With cleaning off entirely, the content-hashed chunk names accumulate: every
 * source change produces a new `contract-<hash>.js` while the previous one stays
 * behind, unreferenced by any entrypoint. Those orphans are dead weight in the
 * package and end up in a published tarball or a git commit. Measured before
 * this script existed: three of four chunks in `lib/` were orphans.
 *
 * Cleaning once, here, before either config runs, gets both properties — a
 * complete build and no accumulation.
 *
 * `node:path` and `fileURLToPath` throughout so this behaves the same on
 * Windows, where a hand-joined path would use backslashes.
 */

import { readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

let removed = 0
try {
  for (const entry of await readdir(libDir)) {
    await rm(join(libDir, entry), { recursive: true, force: true })
    removed += 1
  }
} catch (error) {
  // A missing directory is the normal first-build case, not a failure.
  if (error.code !== 'ENOENT') throw error
}

console.log(`lib/ cleared (${String(removed)} entr${removed === 1 ? 'y' : 'ies'} removed)`)
