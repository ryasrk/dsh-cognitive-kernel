# Retrieval: what was measured, and why semantic search ships off

This records an experiment that did not produce the expected answer. The semantic
retrieval path is built, tested, and reachable — but it is **off by default**, and this
document is the reason. Anyone tempted to turn it on should read the numbers first.

## The question

The store's retrieval was lexical. A query and the entry answering it often share no
words — "how do I check my code is correct?" contains nothing from
`npx vitest run tests/evidence.spec.ts`. Does a bundled embedding model close that gap
enough to justify its cost?

Setup: quantized MiniLM, 384 dimensions, run by ONNX WASM in-process. 22MB, no API key,
no native binary. Measured 157ms to load once and ~3.2ms per text.

## Result 1: the lexical baseline was weaker than assumed

On a six-entry corpus of realistic entries with natural queries, lexical retrieval
answered **1 of 6**, confirming the gap.

But adding a **gloss** — a plain-language description of what each entry is for — took
lexical to **5 of 6** on its own. Most of the apparent semantic gap was a missing-words
problem that a `gloss` field fixes for free.

## Result 2: the embedding model ranked narratives above the answers

On the corpus that motivated the work, the query "how do I typecheck the project"
scored:

| Embedded text | Similarity |
|---|---|
| `npx tsc --noEmit` (the answer) | 0.078 |
| An unrelated failure narrative | **0.153** |
| `npx tsc --noEmit` + a gloss | **0.258** |

The correct command **lost to an unrelated distractor**, because the distractor shared
vocabulary with the query and the command shared none. This reproduces the published
"Power of Noise" finding locally: a plausible non-answer outranks the answer.

This is a property of embedding the *wrong text*, not of embeddings. Giving the entry a
gloss fixed it — the same fix that helped lexical. Which means the win came from the
gloss, not from the model.

## Result 3: including the readable prose actively hurt

The store composes prose for a human reader: `In /repo, the command \`npx tsc\` succeeded.`
That boilerplate is identical across every entry in a workspace and therefore separates
none of them. Measured against a distractor:

| Embedded representation | vs distractor |
|---|---|
| prose + gloss | 0.145 vs 0.131 — a 0.014 margin, and the wrong entry won |
| command + gloss | **0.190** vs 0.131 — a clear win |

So the vector is built from the command and the gloss, never the prose. `rememberable()`
does this and a test pins it.

## Result 4: the model did not beat lexical

On six natural queries: semantic **6 of 6**, lexical **6 of 6** — after the gloss fix,
a tie.

On four queries deliberately phrased to share **no** content words with their target:
semantic **3 of 4**, lexical **4 of 4**. Lexical won.

One caveat cuts the other way: the gloss was written by the same author as the queries,
so lexical's strength there is partly a stacked deck. The honest summary is *no measured
advantage either way*, not *lexical is better*.

## Result 5: the cost is real and the benefit is not

| Path | 40 entries, per recall |
|---|---|
| lexical | **1.1ms** |
| with the model | **193.5ms** |

A **175× slowdown**, in the path a model waits on, for no measured accuracy gain.

Note this is *with query-only embedding* — the entry vectors were already computed at
write time, so 193ms is the floor, not the worst case: a corpus written before the model
was enabled re-embeds every entry on the first recall.

## Decision

`semanticRecall` defaults to **false**. The code stays, tested and reachable, because
the case is not closed — the same model won 6 of 6 on the phrased-in-your-own-words
corpus, and the losing result is four entries. A larger, more realistic benchmark could
overturn this. What would not be defensible is turning it on because it sounds better.

## What to do instead

The `gloss` field does most of the work at no cost. It is written for every entry
regardless of this setting, matched by the lexical path, and it is what carries the
words a query will use. That is the change worth keeping from this experiment.

## Acceptance test, for whoever revisits this

Before enabling `semanticRecall`, measure both paths on your own corpus and require the
model to win by more than the noise. Anything else is preferring a 175× cost on faith.
