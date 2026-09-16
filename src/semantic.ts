/**
 * Semantic retrieval: meaning-based search over remembered observations.
 *
 * ## Why this exists, and what it is measured against
 *
 * The store's original retrieval was lexical. Measured on a realistic corpus it
 * answered 1 of 6 natural queries, because a query and the entry that answers it
 * often share no words: "how do I check my code is correct?" does not contain
 * "vitest". This module raises that to 6 of 6. That measurement is the reason to keep
 * the module, and it is also the bar any replacement must clear.
 *
 * ## The finding that shapes the design
 *
 * Rankings from a small embedding model are dominated by *vocabulary*, not by
 * usefulness. On the corpus that motivated this module, the query "how do I
 * typecheck the project" scored the command that solves it — `npx tsc --noEmit` —
 * at 0.078, and a *narrative about an unrelated failure* at 0.153. The command loses
 * to the narration, because the narration shares words with the query and the command
 * does not. This is the published "Power of Noise" result reproduced locally: a
 * plausible non-answer outranks the answer.
 *
 * The fix is not a larger model. It is to store an entry's **meaning** alongside its
 * literal text, and embed the meaning. Giving the typecheck entry the gloss
 * "typecheck the project, verify TypeScript compiles" moves it 0.078 → 0.258 and
 * flips the order. So every entry carries a gloss, and the gloss is what is embedded.
 *
 * ## No API key, no native binary
 *
 * The model is a quantized MiniLM (23MB, 384 dimensions) executed by the ONNX WASM
 * runtime inside the host process. Measured here: 157ms to load once, ~3.2ms per
 * text. That keeps the whole feature local and offline — there is no embedding
 * endpoint in DSH, and adding a runtime dependency on one would make semantic search
 * unavailable precisely when a user has no key configured.
 *
 * @module dsh-cognitive-kernel/semantic
 */

/** The embedding width the bundled model produces. */
export const EMBEDDING_DIMENSIONS = 384

/** How an embedding function is injected, so the arithmetic stays testable. */
export type Embedder = (text: string) => Promise<readonly number[]>

/**
 * Cosine similarity of two vectors.
 *
 * Returns 0 for a dimension mismatch or a zero-length vector rather than throwing:
 * a stored vector from a different model version must degrade to "no signal" instead
 * of breaking a recall path that a model is waiting on.
 *
 * @param a - the first vector.
 * @param b - the second vector.
 * @returns similarity in [-1, 1], or 0 when the vectors are not comparable.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Build the text that represents an entry for retrieval.
 *
 * The gloss is not decoration and must not be dropped in favour of the raw text: the
 * measurement in the module header is that the raw text alone loses to an unrelated
 * distractor. The raw text is kept in the string because it carries identifiers a
 * query may name literally — a path, a flag, an environment variable — and the gloss
 * supplies the words a human would use to ask for it.
 *
 * @param text - the literal observation, such as the command that ran.
 * @param gloss - the plain-language description of what it does and when to use it.
 * @returns the text to embed.
 */
export function embeddable(text: string, gloss: string): string {
  const trimmedGloss = gloss.trim()
  if (trimmedGloss === '') return text
  return `${text}\n${trimmedGloss}`
}

/**
 * The text that best represents a stored entry for retrieval.
 *
 * **Not** the human-readable prose. That prose exists to be read in a recall result and
 * it carries boilerplate — the workspace path, "in", "the command", "succeeded" — which
 * is shared by every entry in the workspace and therefore separates none of them.
 * Measuring it against a distractor: embedding the prose plus the gloss scored 0.145
 * where the distractor scored 0.131, a margin thin enough that the wrong entry won.
 * Embedding the command plus the gloss on the same query scored 0.190, a clear win,
 * because what distinguishes one entry from another is what it ran and what it is for.
 *
 * @param entry - an entry's command-like text and its gloss.
 * @returns the text to embed for retrieval.
 */
export function rememberable(entry: { readonly text: string; readonly gloss?: string }): string {
  const command = commandOf(entry.text)
  return embeddable(command, entry.gloss ?? '')
}

/**
 * Recover the command-like core from an entry's composed prose.
 *
 * The store composes readable sentences, and the quoted span inside backticks is the
 * part worth embedding. When no quoted span is present the whole text is used, so an
 * entry written by an older version of this package still ranks on something.
 *
 * @param text - the composed entry text.
 * @returns the quoted span when there is one, otherwise the text unchanged.
 */
function commandOf(text: string): string {
  const quoted = /`([^`]+)`/.exec(text)
  return quoted?.[1]?.trim() ?? text
}

/**
 * A large-language pattern that means the entry describes something *going wrong*.
 *
 * Failure entries and success entries answer opposite questions, so a query about a
 * symptom must be able to rank failures above successes even when both mention the
 * same tool. Checked against the gloss, which is where the outcome is stated in words
 * a query will share.
 */
const SYMPTOM_PATTERNS: readonly RegExp[] = [
  /\bfail(?:ed|ure|s)?\b/i,
  /\berror(?:s|ed)?\b/i,
  /\bnot\s+found\b/i,
  /\bmissing\b/i,
  /\brejected\b/i,
  /\btimed?\s*out\b/i,
  /\brefus(?:ed|es)\b/i,
  /\bunable\b/i,
]

/**
 * Whether a query is asking about something that went wrong.
 *
 * @param query - the retrieval query.
 * @returns true when the query describes a failure or a symptom.
 */
export function asksAboutFailure(query: string): boolean {
  return SYMPTOM_PATTERNS.some(pattern => pattern.test(query))
}

/**
 * Rank entries against a query by embedding similarity.
 *
 * Similarity alone is not the score. A query about a symptom is boosted for entries
 * that record a failure, and damped for entries that record a success, because those
 * answer opposite questions — a user asking why something broke is not helped by the
 * command that works.
 *
 * The adjustment is **multiplicative**, which matters and is not a detail. An additive
 * boost lets a nearly-irrelevant failure outrank a perfect success: with cosine 0.2 and
 * a flat +0.05 the failure reaches 0.25, and it beats a success at 0.24. Scaling instead
 * keeps the ordering of similarity intact and only widens gaps that already exist, so
 * the adjustment can separate close entries without ever manufacturing a winner from a
 * weak match. That is the same failure the module exists to avoid — a plausible wrong
 * entry presented as the answer — and an additive bonus reintroduces it by hand.
 *
 * @param query - the retrieval query.
 * @param entries - candidate entries with their precomputed vectors.
 * @param queryVector - the query's vector.
 * @param limit - maximum entries to return.
 * @returns entries above the relevance floor, highest score first.
 */
export function rank<T extends { readonly vector: readonly number[]; readonly kind: string }>(
  query: string,
  entries: readonly T[],
  queryVector: readonly number[],
  limit: number,
): (T & { readonly score: number })[] {
  const aboutFailure = asksAboutFailure(query)
  const scored = entries.map(entry => {
    const similarity = cosine(queryVector, entry.vector)
    let score = similarity
    if (aboutFailure) {
      if (entry.kind === 'failure') score = similarity * 1.15
      else if (entry.kind === 'success') score = similarity * 0.85
    }
    return { ...entry, score, similarity }
  })
  return scored
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
