/**
 * The bundled embedding model, loaded once per host process.
 *
 * Loading is asynchronous and can fail, and both facts shape the interface. A recall
 * may be requested before the model is ready, and a deployment may ship without it, so
 * every caller has to cope with "no vectors available" without the store breaking. The
 * loader therefore never rejects: it resolves to a backend that reports itself
 * unavailable, so the lexical path stays in charge rather than a recall throwing inside
 * a step a model is waiting on.
 *
 * @module dsh-cognitive-kernel/model
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Embedder } from './semantic.ts'

/** Where the bundled model lives, relative to this module's directory. */
const MODEL_DIRECTORY = 'model'

/** A retrieval backend, which may be unavailable. */
export interface EmbeddingBackend {
  /** Whether this backend can produce vectors. */
  readonly available: boolean
  /** Why it is unavailable, for a diagnostic that names the real cause. */
  readonly reason?: string
  /** Embed one text, or return nothing when unavailable. */
  readonly embed?: Embedder
}

/** The single process-wide backend, so the model is loaded at most once. */
let pending: Promise<EmbeddingBackend> | undefined

/**
 * Resolve the directory containing the bundled model.
 *
 * Walked up from this module rather than assumed to be one level up, because the
 * module lives in `src/` when a test imports the TypeScript directly and in `lib/`
 * after a build. Taking `import.meta.dirname` plus one is therefore correct in exactly
 * one of the two, and the failure is silent: the model is simply reported absent and
 * every recall quietly stays lexical. Searching upward is correct in both.
 *
 * @returns the absolute model directory, or `undefined` when the package root cannot be
 * found.
 */
function modelDirectory(): string | undefined {
  let directory = import.meta.dirname
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(directory, MODEL_DIRECTORY)
    if (existsSync(join(candidate, 'config.json'))) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * Load the model, or report why it could not be loaded.
 *
 * The failure is returned rather than thrown because an absent model is a supported
 * deployment. A store that refused to work without it would turn an optional retrieval
 * upgrade into a hard dependency for every user.
 *
 * @returns the backend, never rejecting.
 */
async function load(): Promise<EmbeddingBackend> {
  const directory = modelDirectory()
  if (directory === undefined) {
    return { available: false, reason: `no bundled model found above ${import.meta.dirname}` }
  }
  try {
    // Required lazily and by name: the runtime is a large optional dependency, and a
    // deployment without it must still start.
    const require = createRequire(import.meta.url)
    const transformers = require('@huggingface/transformers') as {
      env: { allowRemoteModels: boolean; backends: { onnx: { wasm: { numThreads: number } } } }
      pipeline: (task: string, path: string, options: unknown) => Promise<
        (texts: string[], options: unknown) => Promise<{ data: Float32Array }>
      >
    }
    // Offline and single-threaded on purpose: the model is bundled, and a recall must
    // never wait on the network or contend for worker threads inside a step.
    transformers.env.allowRemoteModels = false
    transformers.env.backends.onnx.wasm.numThreads = 1
    const extract = await transformers.pipeline('feature-extraction', directory, { dtype: 'q8' })
    const embed: Embedder = async (text: string) => {
      const output = await extract([text], { pooling: 'mean', normalize: true })
      return Array.from(output.data)
    }
    // One warm-up call, so the first real recall does not pay the graph-compile cost
    // while a model is waiting on it.
    await embed('warm up')
    return { available: true, embed }
  } catch (cause) {
    return {
      available: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/**
 * Get the process-wide backend, loading it on first use.
 *
 * The in-flight promise is memoised rather than the result, so concurrent callers share
 * one load instead of racing to start several.
 *
 * @returns the backend, never rejecting.
 */
export function embeddingBackend(): Promise<EmbeddingBackend> {
  pending ??= load()
  return pending
}

/**
 * Reset the memoised backend.
 *
 * Exists for tests, which need a load attempt to happen again after they arrange the
 * conditions for one. Production code never calls it.
 */
export function resetEmbeddingBackend(): void {
  pending = undefined
}
