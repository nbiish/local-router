# TASK.2026-11-18-09 — Decision engine choice: code it out vs. Cactus/Needle

- Machine: mac (darwin arm64), checkout `/Volumes/1tb-sandisk/code-external/local-router`
- Branch: `main` (docs/coordination only — this task is planning, no repo code changed)
- Plan produced: `.agents/plans/2026-11-18-09-decision-engine-choice.md` (status: designing)
- Status: done (plan authoring); implementation is a separate operator go-ahead

## Objective

Review the whole system and decide whether the decision layer can be solidly coded out or should use
the Cactus small-model system (https://github.com/cactus-compute/cactus) as its decision model. The
operator's premise was "now that we have the proper logging" — verifying that premise was part of the
task.

## Findings

**The logging premise is false for decisions.** Trajectory capture has exactly two call sites, both
chat/embedding (`src/index.ts:8189`, `:7994`). Nothing under `src/decisions/` references
`TrajectoryTracker`, and `grep -c "typesafe\|jev"` over the live `trajectories.jsonl` returns 0.
Decision observability is a 25-entry in-memory ring with transport metadata only — no answers, no
probabilities, no question ids, and no persistence. It is lost on restart.

**The architecture question is already answered; the model question is not.** AGENTS.md
non-negotiable 6 requires thresholds/allowlists/refusals to be deterministic code. ainish-rag already
honours this: Jev returns probabilities and `derive_retrieval_strategy` (Rust, `decision.rs:124`)
applies a hard-coded threshold table. So "code vs. model" is not open — only "is this classifier good
enough, and can we prove it" is.

**Cactus is a different shape, not a smaller Jev.** Needle 3 is a 29–121M grammar-constrained
tool-caller: JSON tool call out, no free text, no option probability distribution, one calibrated
`confidence` in [0,1], and refusals are an empty `function_calls` list. Mapping our three primitives
(`noul`/`choice`/`score`) onto it is possible but lossy: a `score` answer becomes a discrete choice,
and the confidence is one scalar rather than a distribution.

**Cactus cannot serve on this host via its documented HTTP path.** `cactus-mlx server` needs Apple
silicon + macOS 26+ + Python 3.12+, and its adapter supports only Nemotron-H CQ checkpoints (the
example is 120B). This host has 18 GB RAM. Needle/Whistle/Mirage run on a native engine with no HTTP
server, so integration would require a Python sidecar behind an HTTP shim. Smaller checkpoints do
exist (LFM2 family, Qwen3-0.6B, gemma-3-270m, functiongemma-270m), so Cactus is not excluded — only
its documented convenience path is.

**The provider layer is genuinely pluggable.** One catalog entry plus a dialect, with per-provider
URL/model overrides and a `LOCAL_ROUTER_DECISION_ORDER` pin already present — so an A/B needs no new
plumbing.

**No evaluation substrate exists.** There is no labelled corpus, no accuracy or calibration metric,
and `route_local` (the coded-out fallback) is keyword matching (`starts_with("hello")`,
`contains("pqc")`) that has never been measured.

## Recommendation

Build measurement before choosing. Phase 1 (decision records in the trajectory log) and Phase 2
(committed label corpus) are worth doing even if the verdict is "keep Jev forever", which is the most
likely outcome. The Cactus spike (Phase 4) should be conditional on Phase 3 showing a *specific*
question class where Jev is weak — not undertaken speculatively. The plan states this with the
numbers each phase must produce.

## Deliberately not done

- No code changed; no dependency installed; `cactus-compute` was not pip-installed.
- No router restart, no config edit, no chain change — the live router was only read.
- The plan was left at `status: designing` because §7 has four open operator decisions (corpus
  provenance, question scope, sidecar acceptability, and the numeric "good enough" bar) that must be
  settled before implementation starts.

## Verification

- Every anchor fact names its source (file:line, live command, or the fetched upstream `llms.txt`).
- Host constraints were measured (`sw_vers`, `uname -m`, `python3 --version`, `sysctl hw.memsize`),
  not assumed.
- The claim that decisions are unlogged was verified three ways: source grep for tracker
  construction, absence of `fs.` writes in the decision service, and a zero count in the live log.

## First failure to expect if this is wrong

If decision calls already reach the trajectory log through a path I did not find, P1.1 is already
done and the corpus/eval phases become the real work. The evidence says otherwise: two construction
sites, both chat/embedding, and a zero grep count over the live log.
