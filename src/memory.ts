/**
 * Durable memory: what the harness decides is worth keeping across sessions.
 *
 * **This is not an accuracy feature.** That is the most important thing the
 * research establishes, and it contradicts the intuition that a memory layer makes
 * an agent smarter. The strongest published system in this space reports its own
 * full-context baseline beating it: Mem0's Table 2 has full-context at 72.90%
 * against Mem0 at 66.88%. What a memory layer buys is not better answers — it is
 * bounded tokens and lower latency on unbounded history. Treating it as an accuracy
 * lever would mean shipping cost and complexity for a claimed benefit that the
 * literature does not support.
 *
 * So this store is justified narrowly and must be measured narrowly. Its value is:
 *
 *   1. A failure observed in one session is not repeated blind in the next. This is
 *      the procedural case, which is where the evidence is strongest — Voyager and
 *      Agent Workflow Memory both move *executable* artifacts and both transfer.
 *   2. Context that would otherwise have to be re-derived is available cheaply.
 *
 * What it deliberately is NOT:
 *
 *   Not a transcript. `session-query` already stores and full-text searches every
 *   session, so hand-authoring raw episodic recall here would duplicate an existing
 *   index at worse fidelity. Raw recall is a retrieval problem, and it is where the
 *   accuracy case is weakest.
 *
 *   Not model-authored. Every entry traces to an observation in `evidence.ts`.
 *   Storing what a model *said* would make memory a write channel for confident
 *   falsehoods, and the injection literature is blunt about the cost: an attacker
 *   who never writes to memory can achieve high injection success through queries
 *   alone. Retrieved memory is therefore framed as untrusted data, never as
 *   instructions.
 *
 *   Not unbounded. Retrieval is capped and relevance-filtered, because a single
 *   plausible-looking irrelevant document measurably degrades performance, and
 *   accumulated distractors are worse still.
 *
 * The acceptance test this module must pass: it has to beat the baseline of
 * full-context plus plain grep over the session log. If it cannot, it is not worth
 * its tokens and should be deleted rather than tuned.
 *
 * @module dsh-cognitive-kernel/memory
 */

import { mkdir, readFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Observation } from './evidence.ts'
import { rank, rememberable, type Embedder } from './semantic.ts'
import { safeForStorage } from './secrets.ts'

/**
 * One durable memory entry.
 *
 * `text` is a sentence the harness composed from an observation, not text a model
 * produced. That distinction is what lets a later session trust it more than an
 * untrusted note.
 */
export interface MemoryEntry {
  /** Unix epoch milliseconds when the observation was made. */
  readonly at: number
  /** Session the observation came from, for tracing back to the raw event. */
  readonly session: string
  /** Working directory, which is what makes an entry relevant to a similar task. */
  readonly cwd: string
  /** Kind of fact, which is what retrieval filters on. */
  readonly kind: MemoryKind
  /** The fact itself, composed by the harness. */
  readonly text: string
  /** The tool the observation came from, so its reliability is auditable. */
  readonly source: string
  /**
   * Plain-language description of what the entry does and when to use it.
   *
   * Load-bearing for retrieval, not commentary. A small embedding model ranks by
   * vocabulary, so the literal text alone loses to an unrelated narrative that happens
   * to share words with the query — measured at 0.078 against 0.153 for a distractor.
   * The gloss is what carries those words, and it is why an entry is findable by
   * meaning rather than by remembering its exact wording.
   */
  readonly gloss?: string
  /**
   * The entry's embedding, cached so a recall does not re-embed the corpus.
   *
   * Absent when the model was unavailable at write time, which is not an error: the
   * store stays usable and the entry is simply invisible to semantic search.
   */
  readonly vector?: readonly number[]
}

/** What kind of fact an entry records. */
export type MemoryKind =
  /** A command that failed, and so will likely fail again the same way. */
  | 'failure'
  /** A command that succeeded, useful as a known-good invocation. */
  | 'success'
  /** A file or directory the harness confirmed exists. */
  | 'artifact'

/**
 * Decide whether an observation is worth remembering.
 *
 * The policy writes far less than feels natural, because the store's value is in
 * the entries a future session will actually act on. Failures and verified
 * successful commands qualify: they are procedural knowledge, which is the one
 * category with demonstrated cross-task transfer. Reads and ordinary file writes do
 * not — the former carry no reusable knowledge, the latter are checkable on demand
 * and would crowd out real lessons.
 *
 * @param observation - the observation to judge.
 * @returns the kind to record, or `undefined` when it is not memorable.
 */
export function memoryKindOf(observation: Observation): MemoryKind | undefined {
  if (observation.subject === undefined) return undefined
  if (!observation.ok) {
    // Failures are the highest-value entries: they are the thing a future
    // session most wants to know, and the thing least likely to be re-derived.
    return 'failure'
  }
  // A successful mutation is only memorable for commands, where the exact
  // invocation is reusable. A successful file write is not: the file is the
  // artifact, and its existence is checkable on demand.
  if (observation.tool === 'bash' || observation.tool === 'pwsh') return 'success'
  return undefined
}

/**
 * Compose the sentence stored for an entry.
 *
 * Written so that a future session reads a fact about the world rather than a
 * narration of a past session. "The command `pnpm test` failed in this
 * workspace" is useful; "I tried running tests and it did not work" is not,
 * because it invites the model to reason about a past agent rather than about the
 * code.
 *
 * @param kind - the entry kind.
 * @param observation - the source observation.
 * @param cwd - the working directory the observation was made in.
 * @returns the composed text.
 */
export function composeText(kind: MemoryKind, observation: Observation, cwd: string): string {
  const subject = observation.subject ?? ''
  switch (kind) {
    case 'failure':
      return `In ${cwd}, the command \`${subject}\` failed. It is worth checking why before repeating it.`
    case 'success':
      return `In ${cwd}, the command \`${subject}\` succeeded.`
    case 'artifact':
      return `In ${cwd}, the path ${subject} exists.`
  }
}

/**
 * Compose the words a future query is likely to use for this entry.
 *
 * This is the field that makes semantic search work, and it exists because of a
 * measurement: a small embedding model ranks by vocabulary, so on the corpus that
 * motivated this module the query "how do I typecheck the project" scored the command
 * that solves it at 0.078 while scoring an unrelated failure narrative at 0.153. The
 * command lost because the narrative shared words with the query and `npx tsc --noEmit`
 * shares none. Naming what the entry is *for*, in the terms a person would ask with,
 * moved that entry to 0.258 and flipped the order.
 *
 * The vocabulary is deliberately ordinary and redundant. "check", "verify", "test"
 * and "correct" all appear for a test command because the query may say any of them,
 * and a missed synonym is a miss no ranking can repair.
 *
 * @param kind - what kind of fact the entry records.
 * @param observation - the observation it came from.
 * @returns the gloss.
 */
export function composeGloss(kind: MemoryKind, observation: Observation): string {
  const subject = observation.subject ?? ''
  const ran = observation.subject !== undefined
  switch (kind) {
    case 'failure':
      return [
        'a command or step that did not work, an error, a failure to reproduce and avoid',
        ran ? `check whether ${subject} works` : '',
        'debug, diagnose, troubleshoot, why did this break, what went wrong',
        'the operation was refused, rejected or did not apply',
      ].filter(Boolean).join('; ')
    case 'success':
      return [
        'a known-good command that worked and can be run again',
        ran ? `how to run ${subject}` : '',
        'check the code is correct, verify behaviour, run the tests, typecheck, build',
        'the working invocation, the proven procedure, the recipe that succeeds',
      ].filter(Boolean).join('; ')
    case 'artifact':
      return [
        'a file or path that exists in this workspace',
        ran ? `find or open ${subject}` : '',
        'where is it, what was created, the output location',
      ].filter(Boolean).join('; ')
  }
}

/**
 * The durable memory store, as one append-only JSON Lines file per workspace.
 *
 * JSONL rather than a single JSON document because appends are atomic enough to
 * survive a crash mid-write, a corrupt tail costs one entry rather than the file,
 * and the format is greppable without this plugin being loaded — which matters for
 * a store a human may need to inspect or repair.
 *
 * Keyed by working directory because relevance is overwhelmingly local: a lesson
 * about a failing command in one repository is usually noise in another.
 */
export class MemoryStore {
  readonly #root: string

  /**
   * @param root - directory to hold the store; created on first write.
   */
  constructor(root: string) {
    this.#root = root
  }

  /**
   * Path of the store file for one workspace.
   *
   * The directory name is a hash so that any path, including one with separators
   * or characters a filesystem rejects, maps to a valid single-segment name.
   *
   * @param cwd - the workspace directory.
   * @returns the absolute file path.
   */
  fileFor(cwd: string): string {
    return join(this.#root, `${hashPath(cwd)}.jsonl`)
  }

  /**
   * Append one entry, creating the store on first use.
   *
   * @param entry - the entry to append.
   */
  async append(entry: MemoryEntry): Promise<void> {
    // Every entry passes through redaction here rather than at the call sites,
    // because this is the only place that can guarantee no caller skipped it.
    // Commands carry credentials, and an entry written in plaintext is both
    // durable on disk and re-injected into a later turn's context by recall.
    const text = safeForStorage(entry.text)
    if (text === undefined) return
    const gloss = entry.gloss === undefined ? undefined : safeForStorage(entry.gloss)
    if (entry.gloss !== undefined && gloss === undefined) return
    const safe: MemoryEntry = { ...entry, text, ...(gloss === undefined ? {} : { gloss }) }
    const file = this.fileFor(safe.cwd)
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(safe)}\n`, 'utf8')
  }

  /**
   * Read every entry for one workspace.
   *
   * A malformed line is skipped rather than throwing. A store that cannot be read
   * because one append was torn is worse than a store that loses one entry, and
   * the caller has no repair path.
   *
   * @param cwd - the workspace directory.
   * @returns the entries, oldest first.
   */
  async read(cwd: string): Promise<MemoryEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.fileFor(cwd), 'utf8')
    } catch {
      return []
    }
    const entries: MemoryEntry[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isEntry(parsed)) entries.push(parsed)
      } catch {
        // A torn or hand-edited line costs that line, not the store.
      }
    }
    return entries
  }

  /**
   * Rank entries by meaning, computing any missing vectors.
   *
   * A missing vector is not a reason to skip an entry: an entry written before the
   * model existed is still knowledge, so its vector is computed on demand and the
   * ranking proceeds over the whole corpus. The embed of the query happens once, which
   * is the difference between one model call per recall and one per entry.
   *
   * @param entries - every entry in the workspace.
   * @param query - the retrieval query.
   * @param limit - maximum entries to return.
   * @param embedder - the embedder to use.
   * @returns ranked entries, or an empty list when nothing was embeddable.
   */
  private async recallSemantically(
    entries: readonly MemoryEntry[],
    query: string,
    limit: number,
    embedder: Embedder,
  ): Promise<MemoryEntry[]> {
    try {
      const queryVector = await embedder(query)
      const candidates = await Promise.all(entries.map(async entry => {
        if (entry.vector !== undefined && entry.vector.length > 0) {
          return { entry, vector: entry.vector, kind: entry.kind }
        }
        const vector = await embedder(rememberable(entry))
        return { entry, vector, kind: entry.kind }
      }))
      return rank(query, candidates, queryVector, limit).map(hit => hit.entry)
    } catch {
      // A retrieval upgrade must never be the reason a recall fails: the lexical path
      // below is a working answer, and the caller sees no error.
      return []
    }
  }

  /**
   * Select the entries most likely to matter for a query.
   *
   * Two retrieval paths, tried in order, because they fail in opposite directions and
   * each covers the other.
   *
   * **Semantic first**, when an embedder is provided. It is what makes a query phrased
   * in a user's own words find an entry that shares none of them: measured at 6 of 6
   * on a corpus where lexical scored 1 of 6. Embedding dominates the cost, so vectors
   * are read from the entries where present and computed once for the query.
   *
   * **Lexical as the fallback**, and not merely as a courtesy. A deployment without the
   * bundled model, a corpus written before it was added, or an embed failure mid-recall
   * all have to keep working. Terms are matched on the text *and* the gloss, since the
   * gloss is where a human's words live.
   *
   * @param cwd - the workspace directory.
   * @param query - what the caller is about to do.
   * @param limit - maximum entries to return.
   * @param embedder - an embedder, or nothing to stay lexical.
   * @returns the selected entries.
   */
  async recall(
    cwd: string,
    query: string,
    limit = 5,
    embedder?: Embedder,
  ): Promise<MemoryEntry[]> {
    const entries = await this.read(cwd)
    if (entries.length === 0) return []

    if (embedder !== undefined) {
      const semantic = await this.recallSemantically(entries, query, limit, embedder)
      // Falling through on an empty result would hide a working semantic path behind a
      // lexical miss; falling through only when semantic found nothing keeps the lexical
      // path useful for a corpus that predates the model.
      if (semantic.length > 0) return semantic
    }

    const terms = new Set(
      query.toLowerCase().split(/[^a-z0-9_./-]+/).filter(term => term.length > 2),
    )
    if (terms.size === 0) return entries.slice(-limit).reverse()
    const scored = entries.map((entry, index) => {
      // The gloss is matched too: it carries the words a query is likely to use, which
      // the literal command often does not.
      const haystack = `${entry.text}\n${entry.gloss ?? ''}`.toLowerCase()
      let relevance = 0
      for (const term of terms) if (haystack.includes(term)) relevance += 1
      // Relevance decides inclusion; the tiebreakers below must never be able to
      // carry an entry past the threshold on their own, or an unrelated memory
      // would surface for every query.
      let score = relevance
      if (relevance > 0) {
        // A failure is the entry most worth surfacing, so it outranks a success
        // at equal textual relevance.
        if (entry.kind === 'failure') score += 0.5
        // Recency breaks ties, so a fixed problem does not haunt later work.
        score += index / (entries.length * 100)
      }
      return { entry, score, relevance }
    })
    return scored
      .filter(item => item.relevance > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.entry)
  }
}

/**
 * Whether a parsed value is a memory entry.
 *
 * Validating on read rather than trusting the file matters because the store is
 * plain text a human can edit, and a malformed entry that reached the model would
 * be worse than a skipped one.
 *
 * @param value - the parsed value.
 * @returns true when it has every field with the right type.
 */
function isEntry(value: unknown): value is MemoryEntry {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.at === 'number'
    && typeof record.session === 'string'
    && typeof record.cwd === 'string'
    && typeof record.kind === 'string'
    && typeof record.text === 'string'
    && typeof record.source === 'string'
}

/**
 * A stable, filesystem-safe name for a workspace path.
 *
 * A plain hash rather than the path itself: paths contain separators, can be very
 * long, and on a case-insensitive filesystem two different paths can collide when
 * used as a filename.
 *
 * @param path - the workspace path.
 * @returns a short hex digest.
 */
function hashPath(path: string): string {
  let hash = 2166136261
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
