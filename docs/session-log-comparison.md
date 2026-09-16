---
title: Memory against the session log
kind: reference
---

# Memory against the session log

The acceptance test this plugin owed from the start: the durable store has to earn its
place against the session log DSH already keeps. If grep over that log answers the same
questions, the store is a second copy of data the harness already has, and the right
move is to delete it.

This is that comparison, measured on this machine rather than argued.

## What the harness already stores

Session logs live under `$DSH_HOME/sessions/<slugified-cwd>/<session-id>/session.jsonl.zstd`.
On this machine: **935 files, 480MB compressed**, grouped by working directory — the same
key the memory store uses.

Each log is a full event stream. One sampled session held 2155 events, including 85
`tool/call` and 85 `tool/result` pairs. That is the raw material the memory store derives
its entries from, so the overlap is real and the question is fair.

## Why grep over it is not available here

The `session-query-sqlite` plugin maintains an FTS5 index over these logs, with `cwd` as a
column. In this profile it is configured:

```yaml
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: never
```

`:memory:` makes the index ephemeral — rebuilt per process, never on disk. `openAt: never`
goes further: the service refuses every full-text call with *"session search is disabled:
this deployment configures the session-query index with openAt 'never'"*.

So in this deployment there is no index to grep. The comparison becomes memory against
scanning the raw logs.

## The measurement

For one recall in the `ryasai` working directory, which has 188 session logs:

| approach | data read | latency |
|---|---|---|
| memory store, 5000 entries | 1.7 MB | 11 ms |
| scan session logs for this cwd | 504 MB decompressed | 2560 ms |
| FTS5 index | — | disabled |

Roughly 230× more data and 230× more time, per recall, to answer from the logs.

There is a second cost the numbers do not show. `tool/result` events carry the result
content but no failure flag at that level; deciding whether a call failed requires
correlating `tool/call` and `tool/result` through `callId` and interpreting each result
shape. The memory store does that work once, at observation time, and stores the
conclusion. Doing it at query time means re-deriving it across every session on every
recall.

## What this establishes, and what it does not

The store earns its place **in this deployment**. Not because its design beats an index,
but because the index is switched off and the fallback is a 504MB scan.

It does not establish that the store beats FTS5. A profile with
`path: <file>` and `openAt: startup` would make session search a real competitor, and on
that profile the honest answer is that this comparison has not been run. The store would
still hold two advantages — failure status resolved once at write time rather than
re-derived per query, and a corpus of a few thousand curated entries rather than hundreds
of thousands of raw events — but neither has been measured against a live index.

The finding that motivated this plugin's memory design still stands and is worth keeping
in view: memory is a cost and latency feature, not an accuracy feature. Mem0's own paper
puts full context ahead of every memory system it tests on accuracy, and wins on latency.
Nothing measured here contradicts that. The store is justified by what a recall costs,
which is exactly the claim the table above supports.

## If someone enables the index

Re-run this comparison before assuming either answer. The commands:

```bash
# is the index live in this profile?
dsh --profile <name> --dump-config | grep -A3 session-query-sqlite

# how much raw log exists for one working directory
du -sh "$DSH_HOME/sessions/<slugified-cwd>"
```

With `openAt: startup` and a file-backed path, the right test is a set of real recall
queries answered both ways, scored on whether the returned entry actually helps — not on
latency alone, since at that point both are fast.
