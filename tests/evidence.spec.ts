// @vitest-environment node
/**
 * The claim detector and the evidence assessor.
 *
 * These are pure functions, so the tests are exhaustive rather than illustrative.
 * The detector is the part most likely to be wrong in a way that matters: a false
 * positive accuses a model that did nothing wrong, and a false negative lets a
 * bare claim through. Both are covered deliberately.
 */

import { describe, expect, it } from 'vitest'
import { assess, findClaim, isExecuting, isMutating, subjectOf } from '../src/evidence.ts'
import type { Observation } from '../src/evidence.ts'

/** Build an observation with sensible defaults. */
function obs(over: Partial<Observation> = {}): Observation {
  return { tool: 'write', ok: true, mutating: true, sequence: 1, ...over }
}

describe('findClaim', () => {
  it('detects the explicit completions a model actually writes', () => {
    expect(findClaim('I have completed the task.')?.claim).toBe('I have completed the task.')
    expect(findClaim('I completed the refactor.')).toBeDefined()
    expect(findClaim('The task is complete.')).toBeDefined()
    expect(findClaim('I have created the file.')).toBeDefined()
  })

  it('grades a claim by its strength, strongest first', () => {
    // The grading is what decides how much evidence is required, so it must not
    // let a behavioural claim through on the strength of a mere edit.
    expect(findClaim('All tests pass now.')?.tier).toBe('behavior')
    expect(findClaim('I have fixed the bug.')?.tier).toBe('behavior')
    expect(findClaim('The config now contains the new key.')?.tier).toBe('content')
    expect(findClaim('I have created the file.')?.tier).toBe('existence')
  })

  it('does not fire on a negated claim', () => {
    // Missing these would make the check accuse a careful model, which is how a
    // verification feature gets turned off.
    expect(findClaim('The task is not complete.')).toBeUndefined()
    expect(findClaim('I have not completed the task.')).toBeUndefined()
  })

  it('does not fire on a hedged or future claim', () => {
    expect(findClaim('The task should be complete once tests pass.')).toBeUndefined()
    expect(findClaim('I will complete this shortly.')).toBeUndefined()
    expect(findClaim('I was unable to fix the parser.')).toBeUndefined()
    expect(findClaim('This needs more work to be complete.')).toBeUndefined()
  })

  it('returns nothing for text that makes no claim', () => {
    expect(findClaim('Here is the current state of the repository.')).toBeUndefined()
    expect(findClaim('')).toBeUndefined()
    expect(findClaim('   ')).toBeUndefined()
  })

  it('catches the completion phrasings a model actually uses', () => {
    // A probe over real phrasings found these four slipping through entirely, which
    // would have left the checker silent on the most common way to claim success.
    // Failing open is the acceptable direction, but only for phrasings nobody uses.
    expect(findClaim('We are all set here.')).toBeDefined()
    expect(findClaim('The build shows no errors.')).toBeDefined()
    expect(findClaim('The output looks correct.')).toBeDefined()
    // A linter is a check that ran, so the claim is behavioural: a linter passing is
    // explicitly not evidence that the compiler or the tests agree.
    expect(findClaim('The linter passed.')?.tier).toBe('behavior')
    expect(findClaim('The linter is clean.')?.tier).toBe('behavior')
  })

  it('does not fire on a claim about work still to come', () => {
    expect(findClaim('The tests are not passing yet.')).toBeUndefined()
    expect(findClaim('The remaining work is the parser.')).toBeUndefined()
  })

  it('finds a claim inside a longer message', () => {
    const message = [
      'I looked at the failing test.',
      'The root cause was an off-by-one in the loop bound.',
      'I have fixed the loop bound.',
      'The remaining failures are unrelated.',
    ].join('\n')
    expect(findClaim(message)?.claim).toBe('I have fixed the loop bound.')
  })
})

describe('subjectOf', () => {
  it('reads a filesystem path', () => {
    expect(subjectOf('write', { file_path: '/tmp/a.txt', content: 'x' })).toBe('/tmp/a.txt')
    expect(subjectOf('edit', { path: 'src/a.ts' })).toBe('src/a.ts')
  })

  it('reads a shell command, truncated to its first line', () => {
    expect(subjectOf('bash', { command: 'pnpm test\npnpm build' })).toBe('pnpm test')
  })

  it('refuses to guess when the arguments identify no target', () => {
    // Returning undefined is correct: a guessed subject would manufacture
    // evidence that does not exist.
    expect(subjectOf('write', {})).toBeUndefined()
    expect(subjectOf('write', null)).toBeUndefined()
    expect(subjectOf('write', 'a string')).toBeUndefined()
    expect(subjectOf('write', { file_path: '   ' })).toBeUndefined()
  })
})

describe('isMutating', () => {
  it('separates productive tools from read-only ones', () => {
    expect(isMutating('write')).toBe(true)
    expect(isMutating('bash')).toBe(true)
    // A read cannot support a claim that something was created.
    expect(isMutating('read')).toBe(false)
    expect(isMutating('grep')).toBe(false)
    expect(isMutating('glob')).toBe(false)
  })
})

describe('assess: the evidence ladder', () => {
  it('accepts an existence claim on a successful change', () => {
    const result = assess('I have created the file.', 'existence', [obs({ tool: 'write', ok: true })])
    expect(result.supported).toBe(true)
    expect(result.productive).toHaveLength(1)
  })

  it('marks a claim bare when nothing was observed', () => {
    const result = assess('I have created the file.', 'existence', [])
    expect(result.supported).toBe(false)
    expect(result.missing).toContain('No successful change')
  })

  it('does not let a read-only call support a claim', () => {
    // The measured failure mode: the model asserted completion and nothing had
    // been changed. A read is not evidence of a write.
    const result = assess('I have created the file.', 'existence', [
      obs({ tool: 'read', ok: true, mutating: false }),
      obs({ tool: 'grep', ok: true, mutating: false }),
    ])
    expect(result.supported).toBe(false)
    expect(result.productive).toHaveLength(0)
  })

  it('does not let a failure be covered by an earlier success', () => {
    // The harness watched the work fail. A claim of completion contradicts what it
    // saw, and no earlier success undoes that.
    const result = assess('I have fixed the bug.', 'behavior', [
      obs({ tool: 'write', ok: true, sequence: 1 }),
      obs({ tool: 'bash', ok: false, sequence: 2, subject: 'pnpm test' }),
    ])
    expect(result.supported).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.missing).toContain('pnpm test')
  })

  it('never claims more than it can show', () => {
    // `supported` at existence means an edit happened, nothing about whether the
    // result is right. The assessment carries the observations, so a caller can see
    // how thin the support is rather than trusting a boolean.
    const result = assess('I have written a correct implementation.', 'existence', [
      obs({ tool: 'write', ok: true }),
    ])
    expect(result.supported).toBe(true)
    expect(result.productive[0]?.tool).toBe('write')
  })

  it('refuses a content claim when nothing was read back', () => {
    // A write proves a write happened. It says nothing about what the file now
    // contains, which is what a content claim asserts.
    const result = assess('The config now contains the key.', 'content', [
      obs({ tool: 'write', ok: true }),
    ])
    expect(result.supported).toBe(false)
    expect(result.missing).toContain('read back')
  })

  it('accepts a content claim once the content was read back', () => {
    const result = assess('The config now contains the key.', 'content', [
      obs({ tool: 'write', ok: true, sequence: 1 }),
      obs({ tool: 'read', ok: true, mutating: false, sequence: 2 }),
    ])
    expect(result.supported).toBe(true)
  })

  it('refuses a behavioural claim when nothing was executed', () => {
    // This is the failure the whole module exists for: "tests pass" with no run.
    const result = assess('All tests pass.', 'behavior', [obs({ tool: 'write', ok: true })])
    expect(result.supported).toBe(false)
    expect(result.missing).toContain('nothing was executed')
  })

  it('refuses a behavioural claim when no zero exit code was seen', () => {
    // A run without an observed exit code is not evidence: a command can print
    // "0 failures" and still exit non-zero.
    const result = assess('All tests pass.', 'behavior', [
      obs({ tool: 'bash', ok: true, sequence: 1, subject: 'pnpm test' }),
    ])
    expect(result.supported).toBe(false)
    expect(result.missing).toContain('zero exit code')
  })

  it('accepts a behavioural claim only on a zero exit', () => {
    const result = assess('All tests pass.', 'behavior', [
      obs({ tool: 'bash', ok: true, sequence: 1, subject: 'pnpm test', exitCode: 0 }),
    ])
    expect(result.supported).toBe(true)
  })

  it('does not accept a non-zero exit as behavioural evidence', () => {
    const result = assess('All tests pass.', 'behavior', [
      obs({ tool: 'bash', ok: true, sequence: 1, subject: 'pnpm test', exitCode: 1 }),
    ])
    expect(result.supported).toBe(false)
  })

  it('separates executing tools from merely mutating ones', () => {
    // A `write` mutates but proves no behaviour, so it can never satisfy a
    // behavioural claim.
    expect(isExecuting('bash')).toBe(true)
    expect(isExecuting('write')).toBe(false)
    expect(isMutating('write')).toBe(true)
  })
})
