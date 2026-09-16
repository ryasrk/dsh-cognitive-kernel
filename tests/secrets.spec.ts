import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REDACTED, hasResidualSecret, redact, safeForStorage } from '../src/secrets.ts'
import { MemoryStore, composeText, memoryKindOf } from '../src/memory.ts'
import { subjectOf } from '../src/evidence.ts'
import type { Observation } from '../src/evidence.ts'

describe('redact', () => {
  it('removes a bearer token from a curl header', () => {
    const out = redact('curl -H "Authorization: Bearer sk-proj-abcdEFGH1234567890xyz" https://api.example.com')
    expect(out).not.toContain('sk-proj-abcdEFGH1234567890xyz')
    expect(out).toContain(REDACTED)
  })

  it('removes a password from a database URL while keeping the host', () => {
    const out = redact('psql postgres://admin:hunter2@db.internal:5432/prod -c "select 1"')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('db.internal:5432/prod')
  })

  it('removes an exported key but keeps the variable name', () => {
    const out = redact('export DEEPSEEK_API_KEY=sk-abc123def456ghi789jkl && pnpm test')
    expect(out).not.toContain('sk-abc123def456ghi789jkl')
    expect(out).toContain('DEEPSEEK_API_KEY')
    expect(out).toContain('pnpm test')
  })

  it('removes a GitHub token passed by heredoc', () => {
    const out = redact('gh auth login --with-token <<< ghp_SOMETOKENVALUE0000abcd')
    expect(out).not.toContain('ghp_SOMETOKENVALUE0000abcd')
  })

  it('removes AWS, Slack, Stripe and Google credentials', () => {
    const out = redact(
      'AKIAIOSFODNN7EXAMPLE xoxb-1234567890-abcdefghij sk_live_abcdEFGH1234567890 AIzaSyA1234567890abcdefghijklmnopqrstuv',
    )
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(out).not.toContain('xoxb-1234567890-abcdefghij')
    expect(out).not.toContain('sk_live_abcdEFGH1234567890')
    expect(out).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrstuv')
  })

  it('removes a JSON web token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'
    expect(redact(`curl -H "X-Auth: ${jwt}"`)).not.toContain(jwt)
  })

  it('leaves an ordinary command untouched', () => {
    const command = 'pnpm run build && npx tsc --noEmit -p tsconfig.json'
    expect(redact(command)).toBe(command)
  })

  it('leaves a git SHA untouched', () => {
    const command = 'git cherry-pick 3f2a91b4c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3'
    expect(redact(command)).toBe(command)
  })
})

describe('hasResidualSecret', () => {
  it('accepts a fully redacted command', () => {
    expect(hasResidualSecret(`curl -H "Authorization: Bearer ${REDACTED}"`)).toBe(false)
  })

  it('accepts ordinary paths and flags', () => {
    expect(hasResidualSecret('npx vitest run tests/memory.spec.ts --reporter verbose')).toBe(false)
  })

  it('accepts a lowercase hexadecimal SHA', () => {
    expect(hasResidualSecret('git show 3f2a91b4c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3')).toBe(false)
  })

  it('flags an unrecognised high-variety blob', () => {
    expect(hasResidualSecret('deploy --credential Zm9vYmFyQmF6MTIzNDU2Nzg5MFF1dXg')).toBe(true)
  })
})

describe('safeForStorage', () => {
  it('returns redacted text for a recognised credential', () => {
    const out = safeForStorage('export API_TOKEN=sk-abcdEFGH1234567890xyz && make deploy')
    expect(out).toBeDefined()
    expect(out).not.toContain('sk-abcdEFGH1234567890xyz')
  })

  it('refuses text whose secret it cannot recognise', () => {
    expect(safeForStorage('auth --blob Zm9vYmFyQmF6MTIzNDU2Nzg5MFF1dXg')).toBeUndefined()
  })
})

describe('MemoryStore.append', () => {
  const observe = (command: string): Observation => ({
    tool: 'bash',
    ok: false,
    mutating: true,
    sequence: 1,
    subject: subjectOf('bash', { command }),
  })

  it('never writes a credential to disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kernel-secrets-'))
    const store = new MemoryStore(root)
    const cwd = '/home/user/project'
    const leaky = [
      'curl -H "Authorization: Bearer sk-proj-abcdEFGH1234567890xyz" https://api.example.com/v1/x',
      'psql postgres://admin:hunter2@db.internal:5432/prod -c "select 1"',
      'export DEEPSEEK_API_KEY=sk-abc123def456ghi789jkl && pnpm test',
      'gh auth login --with-token <<< ghp_SOMETOKENVALUE0000abcd',
    ]
    for (const command of leaky) {
      const observation = observe(command)
      const kind = memoryKindOf(observation)
      expect(kind).toBeDefined()
      await store.append({
        at: Date.now(),
        session: 's1',
        cwd,
        kind: kind as 'failure',
        text: composeText(kind as 'failure', observation, cwd),
        source: 'observation',
      })
    }
    const written = await readFile(store.fileFor(cwd), 'utf8').catch(() => '')
    for (const secret of [
      'sk-proj-abcdEFGH1234567890xyz',
      'hunter2',
      'sk-abc123def456ghi789jkl',
      'ghp_SOMETOKENVALUE0000abcd',
    ]) {
      expect(written).not.toContain(secret)
    }
  })

  it('still records the lesson for an ordinary failing command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kernel-secrets-'))
    const store = new MemoryStore(root)
    const cwd = '/home/user/project'
    const observation = observe('pnpm run typecheck')
    const kind = memoryKindOf(observation)
    await store.append({
      at: Date.now(),
      session: 's1',
      cwd,
      kind: kind as 'failure',
      text: composeText(kind as 'failure', observation, cwd),
      source: 'observation',
    })
    const written = await readFile(store.fileFor(cwd), 'utf8')
    expect(written).toContain('pnpm run typecheck')
  })
})
