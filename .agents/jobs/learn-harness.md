---
name: learn-harness
status: active
harness: ainish-coder
profile: pi (local-router/fallback-models), role elephant
cadence: 6h, and only when at least one new commit landed
prompt: >
  Read the retrieved evidence for the newest task, propose at most one bounded change to the retrieval
  graph or a single learned skill, and accept it only if an external outcome referent is available.
tooling: ainish-context context-learn, .agents/context-harness/
purpose: The context engine's own retrieval tuning improves from this repository's history.
owner: operator
---

# learn-harness

## What it does

One propose → gate cycle. The improver reads what retrieval returned for a real task and may propose
**only** two things: bounded numbers (`max_wiki_pages`, `hop_bonus`, `recency_floor`, …) or one skill.
Acceptance is code, not judgement: no external outcome referent means refusal, and the coverage guard
refuses any change that would narrow the corpus.

## How to run it by hand

```bash
ainish-context context-status                 # generation, tuning, staged skills, recent refusals
ainish-context context-learn --dry-run        # see the proposal and the gate verdict; writes nothing
ainish-context context-learn --outcome ok     # assert the outcome so the gate has a referent
ainish-context context-rollback 0             # restore a prior generation
```

## What it has gotten wrong

- **Could not accept anything.** Its only referent was commit-subject word overlap, which 5 of 10 real
  task objectives could never satisfy. A task record at `status: done` is now the primary referent.
- **Proposed narrowing the corpus.** It read `max_wiki_pages: 0` as "index nothing" and proposed a cap.
  The evidence now states that 0 means all, and a guard refuses any narrowing.
- **Never actually ran here.** The throttle keyed on a stale commit count, so the background pass went
  days without firing while the record accumulated.

## What to check when it fails

1. `ainish-context context-status` — `source: absent` means no generation exists; run `context-seed`.
2. `.agents/context-harness/rejected/` — every refusal is recorded with its reason. A wall of refusals
   saying "no outcome signal" means the task records are not being marked done.
3. `provenance.harness.autolearn` in any prime — it says whether the pass spawned and why not.
