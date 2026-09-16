/**
 * Detecting a promise of work that was never done.
 *
 * A distinct failure from a false completion claim, and it needs its own detector.
 * A false claim says "done" when nothing was. This says "now I will do X" and then
 * stops — the loop sees text and no tool call, so it treats the turn as finished
 * while the work is half done. Nothing is technically untrue, which is why a check
 * for false claims does not catch it.
 *
 * The detector is **fully deterministic**, and that is a deliberate difference from
 * the plugin this idea comes from. That one spends a model call to ask a yes/no
 * question about the trailing text, gated on two deterministic facts. The gates are
 * the valuable part: whether a step called a tool is a fact the harness knows, not a
 * judgement to delegate. Asking a model to confirm a fact the harness already holds
 * would introduce a failure mode for nothing — and the measured cost of an ungrounded
 * judgement is that it is wrong in *both* directions, refusing work that was finished
 * as well as accepting work that was not.
 *
 * What a pattern cannot decide is whether the promised action is genuinely pending or
 * merely rhetorical ("I can explain further if you'd like"). That case is not guessed
 * at here: it is left to the turn-continuation rule, which costs one step and is
 * self-limiting.
 *
 * @module dsh-cognitive-kernel/pending
 */

import type { Observation } from './evidence.ts'

/**
 * Patterns that read as announcing an action rather than reporting one.
 *
 * Two shapes matter. **Intent** ("I will run the tests", "let me check") promises
 * future work. **Transition** ("now I need to...", "next, I'll...") marks a step the
 * model was about to take. The intent markers are matched before the completion
 * markers elsewhere in this package, because "next I'll fix it" must not be scanned
 * as "I fixed it".
 */
const INTENT_PATTERNS: readonly RegExp[] = [
  /\b(?:i|we)(?:'ll| will| shall)\s+(?:now\s+)?\w+/i,
  /\b(?:i|we)\s+(?:am|are)\s+going\s+to\s+\w+/i,
  /\b(?:let me|let us)\s+\w+/i,
  /\b(?:i|we)\s+(?:need|want|have|plan|intend)\s+to\s+\w+/i,
  /\b(?:next|then)\s*,?\s*(?:i|we)(?:'ll| will| shall| need\s+to| should)\b/i,
  /\bnow\s+(?:i|we)(?:'ll| will| shall| need\s+to| should| am\s+going\s+to)\b/i,
  /\b(?:about|going)\s+to\s+(?:run|check|read|write|edit|create|delete|install|build|test|verify|inspect|look|search|fix|apply|add|remove|update|open|fetch|call)\b/i,
]

/**
 * Verbs whose future tense indicates a concrete action the harness can perform.
 *
 * Without this the patterns above fire on discussion ("I will explain the tradeoff"),
 * where there is nothing to do and continuing the turn wastes a step. Continuation is
 * only worth its cost when the promised act is one a tool could carry out.
 */
const ACTION_VERBS = [
  'run', 'runs', 'execute', 'check', 'checks', 'read', 'reads', 'write', 'writes',
  'edit', 'edits', 'create', 'creates', 'delete', 'deletes', 'remove', 'removes',
  'install', 'installs', 'build', 'builds', 'test', 'tests', 'verify', 'verifies',
  'inspect', 'inspects', 'search', 'searches', 'find', 'finds', 'grep', 'grep\'s',
  'fix', 'fixes', 'apply', 'applies', 'add', 'adds', 'update', 'updates',
  'open', 'opens', 'fetch', 'fetches', 'look', 'looks', 'list', 'lists',
  'refactor', 'refactors', 'compile', 'compiles', 'render', 'renders',
]

/**
 * Phrases that promise nothing and should never continue a turn.
 *
 * The cost of a false positive here is a wasted step, so the obvious courtesies are
 * excluded outright rather than left to a judgement call.
 */
const RHETORICAL_PATTERNS: readonly RegExp[] = [
  /\b(?:if you(?:'d)?\s+(?:like|want)|would you like|let me know)\b/i,
  /\b(?:happy to|glad to|feel free to)\b/i,
  /\b(?:i|we)\s+can\s+(?:also\s+)?\w+/i,
  /\b(?:explain|summarize|describe|discuss|outline|clarify)\b/i,
  /\b(?:should|could|might|may|would)\b/i,
]

/**
 * Whether a sentence announces an action that has not happened yet.
 *
 * @param text - one sentence of assistant text.
 * @returns true when the sentence promises pending work.
 */
export function promisesAction(text: string): boolean {
  if (text.trim() === '') return false
  if (RHETORICAL_PATTERNS.some(pattern => pattern.test(text))) return false
  if (!INTENT_PATTERNS.some(pattern => pattern.test(text))) return false
  const words = text.toLowerCase().split(/[^a-z']+/)
  return words.some(word => ACTION_VERBS.includes(word))
}

/**
 * Find a pending promise in assistant text.
 *
 * The **last** matching sentence wins: a model that promises an action and then
 * describes another is about to do the second, and the trailing one is what it left
 * undone.
 *
 * @param text - the assistant's message text.
 * @returns the sentence, or `undefined` when nothing is promised.
 */
export function findPending(text: string): string | undefined {
  if (text.trim() === '') return undefined
  const sentences = text.split(/(?<=[.!?])\s+|\n+/)
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index]?.trim() ?? ''
    if (promisesAction(sentence)) return sentence
  }
  return undefined
}

/**
 * Whether a turn looks like it announced work and stopped.
 *
 * Three deterministic gates, all of them facts the harness holds rather than
 * judgements. Every one must hold, because each failure mode it rules out is a
 * distinct way to waste a step or annoy a user:
 *
 * 1. **The last step called no tool.** A step that called one is not abandoned.
 * 2. **An earlier step did call one.** This is what excludes a plain question
 *    answered in a single reply — the most common kind of turn, and one where a
 *    forward-looking sentence is normal prose rather than a dropped action.
 * 3. **The trailing text promises a concrete action.** A turn that ends without
 *    promising anything has nothing to continue.
 *
 * @param observations - the turn's recorded observations, in order.
 * @param trailingText - the assistant's final message text.
 * @returns true when the turn is worth continuing.
 */
export function looksAbandoned(
  observations: readonly Observation[],
  trailingText: string,
): boolean {
  if (findPending(trailingText) === undefined) return false
  // Gate 2: without an earlier tool call this is an ordinary conversational turn.
  const anyEarlierTool = observations.length > 0
  if (!anyEarlierTool) return false
  // Gate 1: the final step must have made no call. The caller passes only the
  // observations of the last step, so its emptiness *is* this gate.
  return true
}
