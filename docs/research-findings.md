# What the research changed

This document records the findings that altered the design, including the ones
that contradicted the design I started with. It is written to be read before the
code, because several of its conclusions are counter-intuitive and the code looks
odd without them.

## 1. A model cannot detect its own errors, so the harness must

The motivating measurement was local: a model claimed success while the artifact
did not exist. The literature on that failure is unusually consistent, and it rules
out the obvious fix.

Intrinsic self-correction — asking a model to check its own work, with no new
information — **degrades** performance. Huang et al. (ICLR 2024, arXiv 2310.01798)
measure it on four models across three benchmarks: GPT-3.5 on CommonSenseQA goes
75.8 → 38.1 → 41.8, and Llama-2-70B on GSM8K goes 62.0 → 43.5 → 36.5. Their
conclusion is that the problem is not that a model cannot revise; it is that it
cannot *tell whether a revision was needed*. The same paper's oracle-stop ablation
shows the revision machinery works fine when an external signal says "that is
wrong": GPT-3.5 on GSM8K goes 75.9 → 84.3.

So the rule this plugin is built on is that a completion claim is not a statement
to be believed or disbelieved, but a request to be adjudicated against something
outside the model.

## 2. A second model opinion is not an external signal

The tempting reading of §1 is "then get a second opinion." That fails too, and for
a specific reason: a verifier that shares the doer's context inherits its errors.

Zheng et al. (arXiv 2306.05685) grade math answers and find the judge makes *the
same mistake* as the answer it is judging; chain-of-thought does not fix it
(14/20 → 6/20 → 3/20 as the prompt improves). Panickssery et al. (arXiv 2404.13076)
find self-recognition and self-preference rise together across fine-tuning
(Kendall τ 0.41 → 0.74), which explains the mechanism rather than just observing it.

**Honest gap:** no published ablation isolates fresh-versus-shared context as the
causal variable. The argument above is inference from two adjacent results, not a
direct measurement. DSH is well placed to run that ablation, and this plugin is
instrumented so it can.

## 3. Where a sound check exists, select rather than critique

Stechly et al. (ICLR 2025, arXiv 2402.08115) compare self-critique against a *sound
external verifier* on the same model and instance count:

| Domain | Baseline | Self-critique | Sound verifier |
|---|---|---|---|
| Game of 24 | 5% | **3%** | 42% |
| Graph Coloring | 16% | **2%** | 44% |
| Blocksworld | 40% | 55% | 87% |
| Mystery Blocksworld | 4% | **0%** | 14% |

The load-bearing detail is what happens when the critique text is **removed**
entirely and the model merely re-samples: the gain is mostly retained (42% vs 36%,
44% vs 38%) at roughly quadratically lower token cost. Their conclusion is to treat
the model as an idea generator and spend the marginal token on a second candidate
plus a check, not on critique prose.

**Consequence for this plugin:** it does not generate critique text for the model to
ponder. It reports a factual gap — what was claimed, and what kind of evidence is
missing — and lets the model act.

## 4. Memory is a cost feature, not an accuracy feature

This is the finding that most changed the design, because it contradicts the
intuition that a memory layer makes an agent smarter.

Mem0's own paper (arXiv 2504.19413) Table 2 reports its **full-context baseline
beating it**:

| Method | Memory tokens | LLM-as-Judge |
|---|---|---|
| Full-context | 26,031 | **72.90%** |
| Mem0 | 1,764 | 66.88% |
| Zep | 3,911 | 65.99% |

The widely-quoted "26% improvement" is against ChatGPT's memory feature (52.90%),
not against full context. The real, defensible win is 91% lower p95 latency and
>90% token savings on unbounded history.

**Design consequence, stated as a constraint:** the memory in this plugin is not
justified by accuracy and must not be measured as though it were. It is justified by
two narrower claims — that a failure observed once need not be repeated blind, and
that context otherwise re-derived is available cheaply. Its acceptance test is
explicitly *beat full-context plus plain grep over the existing session log*, because
a filesystem-and-grep agent has scored well on this benchmark. If it cannot beat
grep, it is not worth its tokens.

## 5. Retrieval that is not adversarially filtered makes things worse

- **The Power of Noise** (arXiv 2401.14887): one plausible-looking non-answer
  distractor costs up to 25%; accumulated distractors, 67%.
- **NoLiMa** (arXiv 2502.05167): GPT-4o falls from 99.3% to 69.7% at 32K.

Hence retrieval here is relevance-gated rather than merely top-k, and the store is
capped. A relevance score that gating ignores is decoration.

## 6. Memory writes are a trust boundary

- **MINJA** (arXiv 2503.03704): an attacker who **never writes to memory** achieves
  98.2% average injection success through queries alone.
- **AgentPoison** (arXiv 2407.12784): >80% attack success at <0.1% poison rate.

An automatically-ingested session log turns every prior session into a write
channel. So: nothing is stored that a model asserted, retrieved memory is framed as
untrusted data rather than instructions, and no prior session is ingested wholesale.

## 7. Grounding decides the value of reflection, so route instead of looping

| Situation | What this plugin does | Why |
|---|---|---|
| A sound check exists | no reflection loop | Generate-and-select beats critique on both quality and cost (§3) |
| A check exists but only post-execution | **one** grounded retry | Self-Debug gains +12% with unit tests against +2–3% without |
| No external check exists | report the gap, do not loop | Ungrounded reflection is *worse than none* (3%, 2%, 0% above) |

The cap of one is not timidity. "More feedback is not better" is measured: richer
critique performed no better than binary, and in two of four domains performed worse.
Compounding a wrong critique across rounds is the mechanism by which reflection
collapses.

## 8. What this plugin deliberately does not do

Each entry is a thing that was considered and rejected on evidence.

| Not built | Reason |
|---|---|
| "Verify your own work" text in the doer's context | Degrades on 4 models × 3 benchmarks (§1) |
| An ungrounded self-critique loop | Measurably worse than no critique (§3) |
| Multi-agent debate as verification | Loses to matched-budget self-consistency |
| Many-round verbal refinement | Degrades as rounds increase |
| Storing model-authored prose as memory | Makes memory a write channel (§6) |
| Auto-ingesting prior sessions | Same, at scale |
| A memory justified by accuracy | Its own baseline beats it (§4) |
| Unbounded top-k retrieval | One distractor costs up to 25% (§5) |
| Trusting an LLM critic's findings wholesale | CriticGPT itself reports hallucinated bugs |
| A token-saving headline metric | Locally, a shipped plugin's such claim was found unsupported |

## 9. The one thing taken from prior art verbatim, and improved

`obra/superpowers` states an "iron law": *no completion claims without fresh
verification evidence*, where "fresh" is **temporal** — a cached earlier run is
disqualified. Its own failure table names the exact anti-pattern that motivated this
work ("Agent completed → VCS diff shows changes → Agent reports success"), and its
rationalization table counters the ways an agent negotiates around a rule
("Linter passed" → "Linter ≠ compiler"; "I'm confident" → "Confidence ≠ evidence").

That material is **prompts only**. It has no enforcement: a model that ignores it
suffers nothing. The upgrade available to DSH is to make the law *structural*, which
is the entire reason this is a host service with event listeners rather than another
section of a system prompt. A prompt can be ignored; a gate cannot.

## 10. Citations found to be wrong

Five references in the material that prompted this work did not survive checking,
and are recorded so they are not reused:

1. arXiv 2407.10671 is the **Qwen2 Technical Report**, not CriticGPT. CriticGPT is
   arXiv 2407.00215.
2. arXiv 2404.10153 is not the knowledge-conflicts survey; that is 2403.08319.
3. arXiv 2503.03704 is MINJA, the memory-injection attack paper.
4. "Do LLM Agents Have Regret?" (2403.16843) is unrelated to memory.
5. Voyager's skill-library ablation **has no scalar figure** — it is qualitative
   ("plateaus"). It should not be quoted as a number; the self-verification ablation
   in the same paper (−73%) is the quantified one.

## 11. What remains unsettled

Recorded so that the design is not read as better-grounded than it is:

- No clean fresh-versus-same-context ablation (§2).
- No primary measurement of information loss under recursive summarization.
- The strongest negative result on reflection is a single-author preprint evaluated
  only at 1.5B–7B params; it has not been replicated at frontier scale.
- A widely-cited claim that simple filesystem grep beats a specialized memory system
  could not be fetched and re-verified. It is treated here as plausible but unproven,
  which is why it appears as an *acceptance test to pass* rather than a fact.
