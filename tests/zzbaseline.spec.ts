import { describe, it } from 'vitest'
import { MemoryStore } from '../src/memory.ts'

describe('baseline', () => {
  it('measures recall against plain grep over the same corpus', async () => {
    const dir = `/tmp/ck-baseline-${process.pid}`
    const store = new MemoryStore(dir)
    const entries = [
      ['failure', 'bash failed: pnpm test --filter @deepseek-ai/dsh-tool-fs | exit 1'],
      ['success', 'bash succeeded: pnpm install --filter @deepseek-ai/dsh-experimental-expert-agents-ui'],
      ['failure', 'write failed: ENOENT /tmp/missing-dir/out.txt'],
      ['success', 'bash succeeded: npx vitest run tests/evidence.spec.ts'],
    ] as const
    for (const [kind, text] of entries) {
      await store.append({ at: Date.now(), session: 's1', cwd: dir, kind: kind as never, text, source: 'test' })
    }
    const lexical = await store.recall(dir, 'vitest', 3)
    const semantic = await store.recall(dir, 'how do I check my code is correct?', 3)
    console.log('LEXICAL "vitest" ->', JSON.stringify(lexical.map(e => e.text.slice(0, 42))))
    console.log('SEMANTIC "how do I check my code is correct?" ->', JSON.stringify(semantic.map(e => e.text.slice(0, 42))))
  })
})
