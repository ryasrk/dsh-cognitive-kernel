/**
 * The similarity arithmetic and the ranking policy.
 *
 * The embedder is injected, so these run without loading the model and hold the
 * parts that must not drift: the score must be comparable across entries, a
 * degenerate vector must not throw, and the failure-versus-success adjustment must
 * reorder without overriding.
 */

import { describe, expect, it } from 'vitest'
import { asksAboutFailure, cosine, embeddable, rank, rememberable } from '../src/semantic.ts'

/** A unit vector along one axis, for hand-checkable similarities. */
function axis(dimensions: number, index: number): number[] {
  const v = new Array<number>(dimensions).fill(0)
  v[index] = 1
  return v
}

describe('cosine', () => {
  it('is 1 for a vector and itself', () => {
    expect(cosine(axis(4, 0), axis(4, 0))).toBeCloseTo(1)
  })

  it('is 0 for orthogonal vectors', () => {
    expect(cosine(axis(4, 0), axis(4, 1))).toBeCloseTo(0)
  })

  it('is scale-invariant, so vector length cannot skew a ranking', () => {
    const a = [1, 2, 3]
    const b = [10, 20, 30]
    expect(cosine(a, b)).toBeCloseTo(1)
  })

  it('returns 0 rather than throwing on a dimension mismatch', () => {
    // A stored vector from a different model version must degrade to no signal, not
    // break a recall a model is waiting on.
    expect(cosine([1, 2], [1, 2, 3])).toBe(0)
  })

  it('returns 0 for an empty or zero vector', () => {
    expect(cosine([], [])).toBe(0)
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })
})

describe('rememberable', () => {
  it('embeds the command and the gloss, not the readable prose', () => {
    // Measured: the prose carries boilerplate shared by every entry in a workspace —
    // the path, "the command", "succeeded" — which separates nothing. Embedding it
    // narrowed the margin over a distractor to 0.145 vs 0.131; the command plus the
    // gloss scored 0.190.
    const text = 'In /repo, the command `npx tsc --noEmit` succeeded.'
    const out = rememberable({ text, gloss: 'typecheck the project' })
    expect(out).toContain('npx tsc --noEmit')
    expect(out).toContain('typecheck the project')
    expect(out).not.toContain('In /repo')
    expect(out).not.toContain('succeeded')
  })

  it('falls back to the whole text when there is no quoted command', () => {
    // An entry written by an older version of this package has no backticked span.
    const out = rememberable({ text: 'the build broke', gloss: 'a failure' })
    expect(out).toContain('the build broke')
  })
})

describe('embeddable', () => {
  it('keeps the literal text and adds the gloss', () => {
    const text = embeddable('npx tsc --noEmit', 'typecheck the project')
    expect(text).toContain('npx tsc --noEmit')
    expect(text).toContain('typecheck the project')
  })

  it('does not append an empty gloss', () => {
    expect(embeddable('npx tsc --noEmit', '   ')).toBe('npx tsc --noEmit')
  })
})

describe('asksAboutFailure', () => {
  it('recognises a symptom query', () => {
    expect(asksAboutFailure('the request was rejected')).toBe(true)
    expect(asksAboutFailure('my edit did not apply and the string was not found')).toBe(true)
    expect(asksAboutFailure('a test timed out')).toBe(true)
  })

  it('does not fire on a neutral or positive query', () => {
    expect(asksAboutFailure('how do I run the tests')).toBe(false)
    expect(asksAboutFailure('show me the project layout')).toBe(false)
  })
})

describe('rank', () => {
  /** An entry with a vector and a kind. */
  const entry = (kind: string, index: number) => ({ kind, vector: axis(8, index) })

  it('orders by similarity, highest first', () => {
    // Two distinct directions, so the order is meaningful rather than a tie.
    const near = { kind: 'success', vector: [1, 0, 0, 0, 0, 0, 0, 0] }
    const far = { kind: 'success', vector: [0.5, 0.5, 0, 0, 0, 0, 0, 0] }
    const ranked = rank('anything', [far, near], [1, 0, 0, 0, 0, 0, 0, 0], 5)
    expect(ranked).toHaveLength(2)
    expect(ranked[0]?.score).toBeCloseTo(1)
    expect(ranked[1]?.score).toBeLessThan(ranked[0]?.score ?? 0)
  })

  it('drops entries with no positive similarity', () => {
    // Everything below zero is noise; returning it would be the distractor problem.
    expect(rank(1 as never ? 'x' : 'x', [entry('success', 3)], axis(8, 0), 5)).toHaveLength(0)
  })

  it('caps the result at the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => entry('success', i % 7))
    const capped = rank('a', many, axis(8, 0), 3)
    expect(capped.length).toBeLessThanOrEqual(3)
  })

  it('lifts a failure entry for a symptom query', () => {
    // Both entries sit on the same similarity, so only the adjustment can order them.
    const sim = [1, 0.5, 0, 0, 0, 0, 0, 0]
    const failure = { kind: 'failure', vector: sim }
    const success = { kind: 'success', vector: sim }
    const ranked = rank('the build failed', [success, failure], sim, 5)
    expect(ranked[0]?.kind).toBe('failure')
  })

  it('never lets the adjustment override a clear match', () => {
    // This is why the adjustment is multiplicative. An additive boost let a failure at
    // cosine 0.2 reach 0.25 and beat a success at 0.24 — manufacturing a winner from a
    // weak match, which is the exact distractor failure this module prevents.
    // Cosine measures DIRECTION, so a weak match needs a different direction, not a
    // smaller magnitude: [0.2, 0, ...] points the same way as [1, 0, ...] and scores a
    // perfect 1.0.
    const strongSuccess = { kind: 'success', vector: axis(8, 0) }
    const weakFailure = { kind: 'failure', vector: [0.2, 0.98, 0, 0, 0, 0, 0, 0] }
    const ranked = rank('something failed', [weakFailure, strongSuccess], axis(8, 0), 5)
    expect(ranked[0]?.kind).toBe('success')
  })

  it('separates two entries that are otherwise close', () => {
    // The adjustment still does its job: at equal similarity the failure wins.
    const sim = [1, 0, 0, 0, 0, 0, 0, 0]
    const ranked = rank('it failed', [
      { kind: 'success', vector: sim },
      { kind: 'failure', vector: sim },
    ], sim, 5)
    expect(ranked[0]?.kind).toBe('failure')
  })
})
