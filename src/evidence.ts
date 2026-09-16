/**
 * The evidence ladder: how strong a claim the harness is willing to credit.
 *
 * The measured fact this encodes was established on this checkout: a model
 * claimed success while the artifact did not exist, and a harness that checked was
 * right where one that trusted the claim was wrong. The research is unanimous that
 * the fix cannot be a prompt asking a model to judge itself — intrinsic
 * self-correction measurably *degrades* performance on every benchmark where it
 * has been tried — so the strength of a claim has to be decided from what the
 * harness observed.
 *
 * The ladder is deliberately not a yes/no. "I created the file" and "the tests
 * pass" are different claims, and a checker that treats them alike is either too
 * strict to be usable or too loose to be useful. Each tier names the evidence that
 * would satisfy it.
 *
 * @module dsh-cognitive-kernel/evidence
 */

/** A thing the harness observed happen, independent of any model assertion. */
export interface Observation {
  /** Tool that produced the observation, as the registry names it. */
  readonly tool: string
  /** Whether the tool reported success. A failed tool is evidence *against*. */
  readonly ok: boolean
  /** Whether the call mutated anything, as opposed to only reading. */
  readonly mutating: boolean
  /** Monotone ordering within one agent's turn sequence. */
  readonly sequence: number
  /**
   * What the observation is *about*, normalized.
   *
   * A path for filesystem work, a command for shell work. Absent when the tool's
   * target cannot be determined from its arguments, which is the honest answer
   * rather than a guess.
   */
  readonly subject?: string
  /**
   * Exit code, when the tool reported one.
   *
   * The single most load-bearing field for behavioural claims: "the tests pass" is
   * only checkable against a zero exit, and a claim resting on output the harness
   * never read is the failure this module exists to catch.
   */
  readonly exitCode?: number
}

/**
 * How strong a claim is, which decides what evidence it needs.
 *
 * Ordered weakest to strongest. A caller never picks a tier directly; the tier
 * falls out of what the sentence claims to have done.
 */
export type ClaimTier =
  /** "I created/added/deleted X" — needs only that the change happened. */
  | 'existence'
  /** "X contains Y" — needs the content to have been read back. */
  | 'content'
  /** "Tests pass" / "the bug is fixed" — needs a run that exited zero. */
  | 'behavior'

/** A completion claim extracted from assistant text, with its verdict. */
export interface ClaimAssessment {
  /** The sentence that reads as a completion claim. */
  readonly claim: string
  /** The strength the sentence asserts. */
  readonly tier: ClaimTier
  /** Observations recorded before the claim was made. */
  readonly observations: readonly Observation[]
  /** Observations that mutated state and succeeded. */
  readonly productive: readonly Observation[]
  /** Observations that failed, which no claim can be satisfied over. */
  readonly failures: readonly Observation[]
  /** Whether the harness can point at evidence of the required strength. */
  readonly supported: boolean
  /** What was missing, phrased for a model to act on. Empty when supported. */
  readonly missing: string
}

/**
 * Patterns that mark a claim as behavioural.
 *
 * These assert a property of the system rather than the existence of an edit, so
 * they require a run that exited zero. Checked before the weaker patterns, because
 * "I have fixed the tests" must not be graded as merely having edited a file.
 */
const BEHAVIOR_PATTERNS: readonly RegExp[] = [
  /\btests?\s+(?:now\s+)?pass(?:es|ing)?\b/i,
  /\bno\s+(?:more\s+)?(?:errors?|failures?|issues?)\b/i,
  /\b(?:the\s+)?linter\s+(?:passed|passes|is\s+clean|is\s+green)\b/i,
  /\b(?:passed|passes)\s+the\s+linter\b/i,
  /\b(?:zero|no)\s+(?:test\s+)?failures?\b/i,
  /\ball\s+tests?\s+pass\b/i,
  /\b(?:the\s+)?(?:bug|issue|problem|error)\s+(?:is\s+)?(?:fixed|resolved|solved)\b/i,
  /\b(?:fixed|resolved|solved)\s+(?:the|this|that)\s+(?:bug|issue|problem|error)\b/i,
  /\b(?:now\s+)?(?:working|works)\s+correctly\b/i,
  /\bthe\s+build\s+(?:succeeds?|passes?|is\s+green)\b/i,
]

/**
 * Patterns that mark a claim as being about content.
 *
 * "The config now contains X" asserts something about what was written, which only
 * a read-back can support.
 */
const CONTENT_PATTERNS: readonly RegExp[] = [
  /\bcontains?\b/i,
  /\bnow\s+(?:includes?|has|reads?|outputs?)\b/i,
  /\bupdated\s+\w+\s+to\s+\w/i,
  /\bset\s+\w+\s+to\b/i,
]

/**
 * Patterns that mark a claim as being about existence.
 *
 * The weakest tier: an edit happened. That says nothing about whether the result is
 * correct, and the message must not be read as though it did.
 */
const EXISTENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:created|added|written|wrote|generated|made)\b/i,
  /\b(?:deleted|removed)\b/i,
  /\b(?:implemented|updated|changed|modified|refactored|fixed)\b/i,
  /\b(?:completed|finished|done)\b/i,
  /\btask\s+(?:is\s+)?complete\b/i,
  /\b(?:all|everything)\s+(?:is\s+)?(?:done|complete|set)\b/i,
  /\b(?:we|it|that)(?:'s| is| are)?\s+(?:all\s+)?set\b/i,
  // "looks correct" / "seems fine" are completion claims in disguise: the model is
  // asserting an outcome from inspection rather than from a check. Treating them as
  // claims is the point — inspection is exactly what the harness found unreliable.
  /\b(?:looks?|seems?)\s+(?:good|fine|correct|right|ok|okay|done)\b/i,
  /\b(?:the\s+)?linter\s+(?:passed|passes|is\s+clean|is\s+green)\b/i,
  /\b(?:passed|passes)\s+the\s+linter\b/i,
]

/**
 * Hedges and negations that disqualify a match.
 *
 * A claim under uncertainty is not a completion claim, and a negated one is the
 * opposite. Missing these would make the check accuse a careful model, which is how
 * a verification feature gets switched off and stays off.
 */
const HEDGE_PATTERNS: readonly RegExp[] = [
  /\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished|fixed|passing)\b/i,
  /\b(?:should|might|may|could|would)\s+be\b/i,
  /\b(?:unable|failed|can't|cannot|couldn't)\s+to\b/i,
  /\b(?:need|needs|requires?)\s+(?:to|more)\b/i,
  /\b(?:will|going\s+to|plan\s+to|intend\s+to|trying\s+to)\b/i,
  /\b(?:not|isn't|aren't|don't|doesn't)\s+(?:pass|passing|work|working)\b/i,
  /\bremaining\b/i,
]

/**
 * Tools whose success can support a claim about the world.
 *
 * A read-only tool cannot support a claim that something was created, so its
 * results are recorded as context but never as support.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'str_replace_editor',
  'bash',
  'pwsh',
  'terminal',
  'run_code',
  'present',
  'notebook_edit',
])

/** Tools that can produce behavioural evidence, because they run something. */
const EXECUTING_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'pwsh',
  'terminal',
  'run_code',
])

/**
 * Extract the subject a tool was acting on, when its arguments make that clear.
 *
 * Returning nothing is the correct answer when the arguments do not identify a
 * target. Guessing would manufacture evidence, which is worse than having none.
 *
 * @param tool - the tool name as the registry reports it.
 * @param args - the decoded arguments, if they could be decoded.
 * @returns a normalized subject string, or `undefined` when indeterminate.
 */
export function subjectOf(tool: string, args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  for (const key of ['command', 'cmd', 'script', 'code']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim().split('\n')[0]?.slice(0, 200)
    }
  }
  void tool
  return undefined
}

/**
 * Whether a tool's success counts as evidence that something was done.
 *
 * @param tool - the tool name as the registry reports it.
 * @returns true when the tool mutates state.
 */
export function isMutating(tool: string): boolean {
  return MUTATING_TOOLS.has(tool)
}

/**
 * Whether a tool's success can support a behavioural claim.
 *
 * @param tool - the tool name as the registry reports it.
 * @returns true when the tool runs something.
 */
export function isExecuting(tool: string): boolean {
  return EXECUTING_TOOLS.has(tool)
}

/**
 * Classify how strong a claim a sentence makes.
 *
 * Behavioural first, then content, then existence: the weaker patterns are broad
 * enough to match a behavioural sentence, so grading "the tests pass" as a mere
 * existence claim would let it through on the strength of an edit.
 *
 * @param sentence - one sentence of assistant text.
 * @returns the tier, or `undefined` when the sentence claims nothing.
 */
export function tierOf(sentence: string): ClaimTier | undefined {
  if (BEHAVIOR_PATTERNS.some(pattern => pattern.test(sentence))) return 'behavior'
  if (CONTENT_PATTERNS.some(pattern => pattern.test(sentence))) return 'content'
  if (EXISTENCE_PATTERNS.some(pattern => pattern.test(sentence))) return 'existence'
  return undefined
}

/**
 * Find a completion claim in assistant text, with its strength.
 *
 * @param text - the assistant's message text.
 * @returns the claim and its tier, or `undefined` when the text makes no claim.
 */
export function findClaim(text: string): { claim: string; tier: ClaimTier } | undefined {
  if (text.trim() === '') return undefined
  const sentences = text.split(/(?<=[.!?])\s+|\n+/)
  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (trimmed === '') continue
    if (HEDGE_PATTERNS.some(pattern => pattern.test(trimmed))) continue
    const tier = tierOf(trimmed)
    if (tier !== undefined) return { claim: trimmed, tier }
  }
  return undefined
}

/**
 * Decide whether the recorded observations support a claim of the given tier.
 *
 * The verdict is intentionally narrow. `supported` means evidence of the required
 * strength exists; it does NOT mean the claim is true. An observation that a write
 * succeeded is evidence that a file was written, not that its contents are right.
 * Claiming more would replace blind trust in the model with blind trust in the
 * harness, which is the same mistake wearing a different hat.
 *
 * @param claim - the claim text.
 * @param tier - the strength the claim asserts.
 * @param observations - observations recorded so far, in order.
 * @returns the assessment.
 */
export function assess(
  claim: string,
  tier: ClaimTier,
  observations: readonly Observation[],
): ClaimAssessment {
  const productive = observations.filter(o => o.ok && o.mutating)
  const failures = observations.filter(o => !o.ok)
  const base = { claim, tier, observations, productive, failures }

  // A failure the harness watched is disqualifying at every tier: the work was seen
  // to fail, so a claim of success contradicts what was observed. No earlier success
  // undoes a later failure.
  if (failures.length > 0) {
    return {
      ...base,
      supported: false,
      missing: 'A tool call failed, so this cannot be complete. Failed: '
        + `${failures.map(f => f.subject ?? f.tool).join(', ')}.`,
    }
  }

  if (productive.length === 0) {
    return {
      ...base,
      supported: false,
      missing: 'No successful change was observed in this turn. If the work is done, '
        + 'do the thing that proves it. If it is not, say so.',
    }
  }

  if (tier === 'existence') {
    return { ...base, supported: true, missing: '' }
  }

  if (tier === 'content') {
    // Something was written, but nothing was read back, so the harness cannot tell
    // whether the content is what was claimed.
    const readBack = observations.filter(o => !o.mutating && o.ok)
    if (readBack.length === 0) {
      return {
        ...base,
        supported: false,
        missing: 'Something was changed, but nothing was read back, so the claimed '
          + 'content is unverified. Read the result and show it.',
      }
    }
    return { ...base, supported: true, missing: '' }
  }

  // Behavioural: needs a run that exited zero. Output alone is not enough — a
  // command can print "0 failures" and still exit non-zero, and a claim resting on
  // output the harness never read is precisely the failure being caught.
  const ran = observations.filter(o => o.ok && isExecuting(o.tool))
  if (ran.length === 0) {
    return {
      ...base,
      supported: false,
      missing: 'This claims a result only a run can show, but nothing was executed. '
        + 'Run the check that would fail if the claim were false.',
    }
  }
  if (!ran.some(o => o.exitCode === 0)) {
    return {
      ...base,
      supported: false,
      missing: 'A command ran, but no zero exit code was observed, so the result is '
        + 'unconfirmed. Run the check again and read the exit code.',
    }
  }
  return { ...base, supported: true, missing: '' }
}
