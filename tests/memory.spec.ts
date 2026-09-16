// @vitest-environment node
/**
 * The write policy and the durable store.
 *
 * The policy is the part with judgement in it, so it is tested against the cases
 * where the judgement could go wrong: remembering too much (noise) or too little
 * (silence). The store is tested for the failure that would matter in practice,
 * a torn write taking the whole file with it.
 */

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore, composeText, memoryKindOf } from '../src/memory.ts'
import type { MemoryEntry } from '../src/memory.ts'
import type { Observation } from '../src/evidence.ts'

/** Directories created by the cases below, removed in `afterEach`. */
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A throwaway directory. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ck-mem-'))
  dirs.push(dir)
  return dir
}

/** Build an observation with defaults. */
function obs(over: Partial<Observation> = {}): Observation {
  return { tool: 'bash', ok: true, mutating: true, sequence: 1, subject: 'pnpm test', ...over }
}

describe('memoryKindOf: what is worth keeping', () => {
  it('keeps a failure, which is the highest-value entry', () => {
    expect(memoryKindOf(obs({ ok: false }))).toBe('failure')
  })

  it('keeps a successful command, whose invocation is reusable', () => {
    expect(memoryKindOf(obs({ ok: true, tool: 'bash' }))).toBe('success')
  })

  it('does not keep a successful file write', () => {
    // The file is the artifact; its existence is checkable on demand, so storing
    // "I wrote a file" is noise that would crowd out real lessons.
    expect(memoryKindOf(obs({ ok: true, tool: 'write', subject: '/tmp/a.txt' }))).toBeUndefined()
  })

  it('does not keep a read', () => {
    expect(memoryKindOf(obs({ tool: 'read', mutating: false }))).toBeUndefined()
  })

  it('refuses to keep anything it cannot name', () => {
    // Without a subject there is no sentence to store, and inventing one would
    // record a fact that was never observed.
    expect(memoryKindOf(obs({ subject: undefined }))).toBeUndefined()
  })
})

describe('composeText', () => {
  it('writes a fact about the world, not a narration', () => {
    const text = composeText('failure', obs({ ok: false }), '/repo')
    expect(text).toContain('/repo')
    expect(text).toContain('pnpm test')
    // Naming the past agent invites reasoning about a session rather than the code.
    expect(text).not.toContain('I ')
    expect(text).not.toMatch(/\bwe\b/i)
  })
})

describe('MemoryStore', () => {
  it('round-trips an entry', async () => {
    const root = await scratch()
    const store = new MemoryStore(root)
    const entry: MemoryEntry = {
      at: 1, session: 's', cwd: '/repo', kind: 'failure', text: 'x failed', source: 'bash',
    }
    await store.append(entry)
    expect(await store.read('/repo')).toEqual([entry])
  })

  it('separates workspaces, so a lesson does not leak across repositories', async () => {
    const root = await scratch()
    const store = new MemoryStore(root)
    await store.append({ at: 1, session: 's', cwd: '/repo-a', kind: 'failure', text: 'a', source: 'bash' })
    await store.append({ at: 2, session: 's', cwd: '/repo-b', kind: 'failure', text: 'b', source: 'bash' })
    expect((await store.read('/repo-a')).map(e => e.text)).toEqual(['a'])
    expect((await store.read('/repo-b')).map(e => e.text)).toEqual(['b'])
  })

  it('returns nothing for an unknown workspace rather than throwing', async () => {
    const store = new MemoryStore(await scratch())
    expect(await store.read('/never-seen')).toEqual([])
  })

  it('survives a torn final line', async () => {
    // The case that decides whether the store is usable: a crash mid-append must
    // cost one entry, not the file. A store that throws on read has no repair path.
    const root = await scratch()
    const store = new MemoryStore(root)
    await store.append({ at: 1, session: 's', cwd: '/repo', kind: 'failure', text: 'kept', source: 'bash' })
    await writeFile(store.fileFor('/repo'), `${await readFile(store.fileFor('/repo'), 'utf8')}{"at":2,"tru`, 'utf8')
    const entries = await store.read('/repo')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toBe('kept')
  })

  it('skips a well-formed line that is not an entry', async () => {
    // The file is plain text a human may edit; a stray value must not reach the
    // model as a malformed memory.
    const root = await scratch()
    const store = new MemoryStore(root)
    await store.append({ at: 1, session: 's', cwd: '/repo', kind: 'failure', text: 'kept', source: 'bash' })
    const existing = await readFile(store.fileFor('/repo'), 'utf8')
    await writeFile(store.fileFor('/repo'), `${existing}{"note":"hand edited"}\n`, 'utf8')
    expect((await store.read('/repo')).map(e => e.text)).toEqual(['kept'])
  })

  it('maps any path to a safe single-segment filename', async () => {
    const store = new MemoryStore('/root')
    const file = store.fileFor('/very/long/path/with/slashes/and spaces')
    expect(file.startsWith('/root/')).toBe(true)
    expect(file).not.toContain(' ')
    expect(file.split('/').at(-1)).toMatch(/^[0-9a-f]{8}\.jsonl$/)
  })
})

describe('MemoryStore.recall', () => {
  it('ranks a matching failure above a matching success', async () => {
    const store = new MemoryStore(await scratch())
    await store.append({ at: 1, session: 's', cwd: '/r', kind: 'success', text: 'the command `pnpm test` succeeded.', source: 'bash' })
    await store.append({ at: 2, session: 's', cwd: '/r', kind: 'failure', text: 'the command `pnpm test` failed.', source: 'bash' })
    const found = await store.recall('/r', 'run pnpm test')
    expect(found[0]?.kind).toBe('failure')
  })

  it('filters out entries with no overlap', async () => {
    const store = new MemoryStore(await scratch())
    await store.append({ at: 1, session: 's', cwd: '/r', kind: 'failure', text: 'about database migrations', source: 'bash' })
    await store.append({ at: 2, session: 's', cwd: '/r', kind: 'failure', text: 'about css layout', source: 'bash' })
    const found = await store.recall('/r', 'css layout problem')
    expect(found.map(e => e.text)).toEqual(['about css layout'])
  })

  it('returns the newest entries when the query has no usable terms', async () => {
    const store = new MemoryStore(await scratch())
    await store.append({ at: 1, session: 's', cwd: '/r', kind: 'failure', text: 'old', source: 'bash' })
    await store.append({ at: 2, session: 's', cwd: '/r', kind: 'failure', text: 'new', source: 'bash' })
    expect((await store.recall('/r', 'a')).map(e => e.text)).toEqual(['new', 'old'])
  })

  it('returns nothing from an empty store', async () => {
    const store = new MemoryStore(await scratch())
    expect(await store.recall('/r', 'anything')).toEqual([])
  })

  it('bounds the number of entries returned', async () => {
    const store = new MemoryStore(await scratch())
    for (let index = 0; index < 20; index += 1) {
      await store.append({ at: index, session: 's', cwd: '/r', kind: 'failure', text: `build error ${index}`, source: 'bash' })
    }
    expect(await store.recall('/r', 'build error', 3)).toHaveLength(3)
  })
})
