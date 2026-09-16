# dsh-cognitive-kernel

Verification, memory, and feedback for DeepSeek Harness — enforced by the harness
rather than requested in a prompt.

## The problem

A model said a task was complete while the artifact did not exist. Trusting the
claim was wrong; checking it was right. That is the failure this plugin closes, and
the research on it is consistent enough to rule out the obvious fix: asking a model
to check its own work **degrades** measured performance, because the problem is not
that a model cannot revise but that it cannot tell whether a revision was needed.

So the harness does the checking, from what it observed, and tells the model what is
missing. `docs/research-findings.md` records the evidence, including the findings
that contradicted the first design — most notably that **memory is a cost feature,
not an accuracy feature**, and `retrieved memory must be treated as untrusted data`.

## What it does

**Verification of completion claims.** The harness watches tool results. When a
message reads as a completion claim, it is graded by what it asserts and checked
against what was observed:

| Claim | Requires | Example |
|---|---|---|
| existence | a successful change | "I created X" |
| content | a successful change **and** a read-back | "X now contains Y" |
| behaviour | a command that ran and **exited zero** | "tests pass", "the bug is fixed" |

A claim with insufficient evidence is answered with a factual statement of the gap —
not with a critique, and not by asking the model whether it is sure. The research is
why: generate-and-select beats critique-and-revise, and ungrounded self-critique is
worse than none.

At most **one** such demand is made per agent. More rounds make outcomes worse, and
the harness cannot distinguish a genuine second attempt from a restated claim.

**Narration.** A separate failure from a false claim: the model calls a tool, then
says what it will do next, and the loop reads text with no tool call as a finished
turn. Nothing is untrue, so a false-claim check sees nothing. Three deterministic
gates catch it — the last step called no tool, an earlier step did, and the trailing
text promises a concrete action. Detection is fully deterministic, with no judge call:
whether a step called a tool is a fact the harness holds, and asking a model to confirm
a fact it already has adds a failure mode for nothing.

**Memory.** Only observations are stored, never model assertions. Failures and
verified commands are the valuable entries, because procedural knowledge is the one
category with demonstrated cross-task transfer. Retrieval is relevance-gated and
capped, because a single plausible-looking irrelevant document measurably degrades
performance. Memories are injected as prior context, never as instructions.

**Secrets.** The store records the first line of every failed command, and commands
carry credentials — a bearer token in a `curl` header, a password in a database URL,
a key exported before a test run. Every entry passes through redaction in
`MemoryStore.append`, which is the only write path and cannot be bypassed by a
caller. Recognised credentials are replaced and the rest of the command is kept, so
`curl -H 'Authorization: Bearer [redacted]' https://api.example.com/v1/x` still
records which endpoint failed. Text that still carries an unrecognised high-variety
token after redaction is dropped rather than stored partially: a lost memory costs a
lesson the next session can re-derive, while a leaked key costs a rotation, so the
tie breaks toward dropping. Ordinary commands, paths and git SHAs are unaffected.

**Feedback.** DSH records message feedback and documents that it never enters model
history. This surfaces the most recent corrections — corrections first, because
approval only says to keep doing what was already done — capped, and explicitly
framed as untrusted input with the statement that a missing rating is not approval.

## Settings

Settings → Verification. The mode is the only control:

| Mode | Effect |
|---|---|
| `nudge` (default) | Answer an unverified claim with a statement of the gap; the turn continues |
| `strict` | Refuse the step instead |
| `off` | Do not check claims; observations are still recorded |

At most one intervention per **turn**, not per session. A single grounded retry is the
whole intervention, because more rounds of ungrounded critique measurably make results
worse; but the cap is spent per turn and restored for the next one. Keyed by agent it
would fire once and stay silent afterwards, so a long session's tenth unsupported claim
would pass because its first was challenged — the check going quiet exactly as context
accumulates and drift becomes likelier.

`semanticRecall` (default **false**) enables embedding-based retrieval using a bundled
22MB model. It is off because it was measured and lost: 3 of 4 on queries sharing no
words with their target against lexical's 4 of 4, at 193.5ms per recall against 1.1ms.
See `docs/retrieval-measurement.md`. The `gloss` field it prompted is kept and does
most of the work for free.

## Install

```
cd ~/deepseek-harness && unset DSH_HOME
dsh plugin --profile web add /path/to/dsh-cognitive-kernel
```

`dsh plugin add` requires the **checkout** as the working directory; `DSH_HOME` must
not be set, or the command fails with "no harness checkout". It forwards to `pnpm add`
and merges `cordis.patch.yml`'s `insert:` rows into the profile's bundle list.

### Dependencies

The harness's own packages are **peer dependencies**, not `dependencies`:

```
@deepseek-ai/dsh-tools, @deepseek-ai/dsh-agent, @deepseek-ai/dsh-llm,
@deepseek-ai/dsh-typert-protocol, @deepseek-ai/schemastery, react …
```

A plugin cannot own the harness it extends: declaring those as `dependencies`
installs a second copy of `dsh-tools` beside the running one, which means two
registries, two service instances, and a plugin that mounts without effect.
Peers turn a version mismatch into an install-time message instead of a subtle
incompatibility later. All are `optional` except `react`, which the client half
imports unconditionally, so installing in a bare checkout still succeeds.

The one real dependency is `@huggingface/transformers`, which brings the ONNX
runtime. It pulls in `onnxruntime-node` and `sharp`, whose install scripts
download platform-specific native binaries — and neither is used here: the
embedding path runs on the WASM backend (`onnxruntime-web`) against the model
bundled in `model/`. `pnpm-workspace.yaml` denies both scripts explicitly.
Without that, pnpm 11 ends an otherwise successful install with
`ERR_PNPM_IGNORED_BUILDS`, which reads as a failure. The denial is also what
keeps the package portable: no native binary means no per-platform build step.

## Development

```
npx tsc --noEmit -p tsconfig.json   # host typecheck
npx tsdown                          # build both halves into lib/
                                    # (npm run build also checks the client bundle)
npx vitest run tests/               # 94 unit tests
```

The three pre-existing errors reported by `tsc -p tsconfig.client.json` come from the
vendored `schemastery` source, not from this package; the sibling plugin reports the
same three.

Integration tests live in the harness checkout at
`packages/experimental/expert-agents-ui/tests/cognitive-kernel.host.spec.ts` and run
in the `thread-safe` project:

```
cd ~/deepseek-harness
npx vitest run --project thread-safe \
  packages/experimental/expert-agents-ui/tests/cognitive-kernel.host.spec.ts
```

## What is verified, and what is not

Verified by a test that would fail if the behaviour regressed:

- All three tier transitions: an existence claim is refused with no change; a content
  claim is refused without a read-back; a behavioural claim is refused without a
  zero exit and accepted with one.
- A claim that the observed evidence *does* support is **not** challenged — the
  direction that decides whether the feature is usable or gets turned off.
- A hedged or negated claim is not challenged, so a careful model is not accused.
- Against a real `AgentLoop` with a scripted model: the demand actually reaches the
  model on a subsequent request, the mode setting is honoured, and the memory tool
  reports real counts.

Not verified:

- **That this makes outcomes better.** It makes a false claim *visible*, which is
  strictly better than not, but no end-to-end task success rate has been measured
  here. The harness-effect measurement in the same test package shows the two arms
  differing; it does not show a downstream improvement.
- **The verifier's own correctness on real work.** It is exercised against a
  scripted model on small cases. Its claim detector is a set of English patterns. A
  probe over realistic phrasings found four common ones slipping through silently —
  "the linter passed", "the build shows no errors", "the output looks correct", "we
  are all set" — and those are now caught and pinned by tests (§*catches the
  completion phrasings*). The general caveat stands: a claim phrased in a way the
  patterns do not anticipate is not checked at all. It fails open, which is the
  deliberate direction, but failing open is not the same as being right.
- **That the store beats a live session-query index.** It beats the alternative
  available in this profile, which is not the same claim. `session-query-sqlite` is
  configured `path: ':memory:'` with `openAt: never`, so full-text search over session
  logs is refused outright and the fallback is scanning raw logs: 504MB decompressed and
  2.56s for one working directory, against 1.7MB and 11ms for the store. On a profile
  that enables the index, this has not been measured. See
  `docs/session-log-comparison.md`.
- **The browser render, end to end.** The Settings panel is now rendered through the
  real slot runtime and React in
  `packages/experimental/expert-agents-ui/tests/cognitive-kernel-ui.client.spec.ts`:
  the three modes, the observation counts, a remembered entry, the revision carried on
  a write, and the error path all assert against rendered text. What remains unverified
  is a live browser — a stylesheet that hides the panel, or a gateway that never
  delivers the call, would pass this spec.
- **Fresh-versus-shared verifier context.** The design assumes a fresh context helps;
  no published ablation isolates it, and this plugin does not yet measure it either.

Known and deliberately unfixed:

- **The store is unbounded.** Nothing prunes, rotates, or caps it, and every `recall`
  reads and parses the whole workspace file to return at most `recallLimit` entries.
  Measured: 100 entries is 29KB and 1.1ms, 1000 is 316KB and 1.9ms, 5000 is 1.7MB and
  11.4ms — linear in both. A year of daily use lands near the 5000 mark, so the cost is
  real but distant, and a cap chosen now would be guesswork about which entries matter.
  The fix when it is needed is a read that walks backward from the tail rather than a
  retention policy. Concurrent appends from several sessions are safe: 400 interleaved
  writes produced 400 well-formed lines.

## Layout

```
src/
  index.ts      plugin: observation recording, verification, recall tool
  evidence.ts   the claim ladder: extraction, grading, adjudication
  memory.ts     the observation store: write policy, retrieval, scoring
  feedback.ts   the feedback bridge: selection and composition
  contract.ts   shared schemas and Remote descriptors
  pending.ts    detection of a promised action that was never taken
  secrets.ts    credential redaction applied to every durable write
  semantic.ts   embedding similarity and ranking policy
  model.ts      the bundled embedding model, loaded once
  remote.ts     the Host Remote service
  client/       the Settings section
docs/
  research-findings.md
```
