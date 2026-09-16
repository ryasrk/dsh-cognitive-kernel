/**
 * Detecting a promise of work that was never done.
 *
 * Two directions matter, and the false-positive direction matters more: a detector
 * that continues turns the model had genuinely finished wastes a step on every
 * conversational reply, which is how a feature gets switched off.
 */

import { describe, expect, it } from 'vitest'
import { findPending, looksAbandoned, promisesAction } from '../src/pending.ts'
import type { Observation } from '../src/evidence.ts'

/** An observation with defaults. */
function obs(over: Partial<Observation> = {}): Observation {
  return { tool: 'bash', ok: true, mutating: true, sequence: 1, ...over }
}

describe('promisesAction', () => {
  it('catches the intent forms a model actually writes', () => {
    expect(promisesAction('Now I will run the tests.')).toBe(true)
    expect(promisesAction("I'll check the output.")).toBe(true)
    expect(promisesAction('Let me read that file first.')).toBe(true)
    expect(promisesAction('Next, I need to update the config.')).toBe(true)
    expect(promisesAction('I am going to apply the patch.')).toBe(true)
    expect(promisesAction('We need to verify the build.')).toBe(true)
  })

  it('ignores an offer rather than a pending action', () => {
    // The cost of a false positive is a wasted step on an ordinary reply.
    expect(promisesAction('Let me know if you want more detail.')).toBe(false)
    expect(promisesAction('I can explain the tradeoff further.')).toBe(false)
    expect(promisesAction('I should mention one caveat.')).toBe(false)
    expect(promisesAction("I'll summarize what changed.")).toBe(false)
  })

  it('requires a concrete action, not just a forward-looking sentence', () => {
    // Discussion about the work is not the work.
    expect(promisesAction('I will consider the alternatives.')).toBe(false)
    expect(promisesAction('We will see how this behaves.')).toBe(false)
  })

  it('says nothing about empty text', () => {
    expect(promisesAction('')).toBe(false)
  })
})

describe('findPending', () => {
  it('takes the last promise, which is the one left undone', () => {
    const text = "I'll read the file. Now I will run the tests."
    expect(findPending(text)).toContain('run the tests')
  })

  it('finds a promise in a longer message', () => {
    const text = [
      'I looked at the config and the default is wrong.',
      '',
      'Next, I will update it and re-run the suite.',
    ].join('\n')
    expect(findPending(text)).toContain('update it')
  })

  it('returns nothing for a plain report of finished work', () => {
    expect(findPending('I created the file and all tests pass.')).toBeUndefined()
  })
})

describe('looksAbandoned', () => {
  it('continues a turn that used a tool and then only narrated', () => {
    // The failure this exists for: the model acted, then described its next act
    // and stopped, and the loop read the text and no tool call as finished.
    expect(looksAbandoned([obs()], 'Now I will run the tests.')).toBe(true)
  })

  it('leaves a one-shot answer alone', () => {
    // Gate 2, and the most common turn shape in practice: no tool was ever called,
    // so a forward-looking sentence is ordinary prose, not a dropped action.
    expect(looksAbandoned([], "I'll explain how this works.")).toBe(false)
  })

  it('promises nothing means there is nothing to continue', () => {
    expect(looksAbandoned([obs()], 'The file is created.')).toBe(false)
  })
})
