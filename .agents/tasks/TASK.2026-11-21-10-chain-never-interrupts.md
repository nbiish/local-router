# TASK.2026-11-21-10 — Make `local-router/fallback-models` never interrupt an agent

- Machine: mac (darwin arm64), checkout `/Volumes/1tb-sandisk/code-external/local-router`
- Branch: `fix/chain-never-interrupts` (not yet cut — plan is `ready`, execution not started)
- Plan: `.agents/plans/2026-11-21-10-chain-never-interrupts.plan.md`
- Status: ready (plan authored 2026-11-21 from a live audit; no todos started)

## Objective

Point a single agent harness at `local-router/fallback-models` and have it never be interrupted,
regardless of which provider or model fails, with local-router as the sole configuration source and
key holder.

## Why this record exists

The plan was authored with a `task_record` pointing at a filename that was never created, which made
it a dangling reference — `plans-doctor` flagged it on 2026-11-22. This record closes that gap and
carries the plan's evidence so the work can start without re-deriving it.

## Anchor facts carried from the plan (2026-11-21 audit)

- Saving a new key does NOT clear an existing auth quarantine: `POST /api/keys` never touches
  `healthRegistry`, and `key_rejected` is an immediate-quarantine class with a 30-minute cooldown.
- Only 3 of the configured chain members had ever answered at audit time; twenty showed
  `ans=0 fail=0 skip=0`.
- `github-copilot-auto` and `cursor-auto` were skipped on every request with
  `context_window_too_small` (52 skips each).
- `executeFallbackRoute` returns 502 when `eligible.length === 0` — a terminal path that attempts
  nothing.
- Terminal exhaustion returns the last upstream status, so a 401-shaped failure reaches the agent as
  a 401 even though the router holds all keys.
- A 404 on a model is not auth; booking it as `key_rejected` quarantined a healthy provider for a
  catalog mistake.

## Related finding (2026-11-22, this session)

`empty_completion` now exists as its own non-evidence class (shipped 2026-11-18). Measured this
session: 114 of 3733 recorded stages (3.1%), affecting 7 requests with ≥3 occurrences. It is caused
by reasoning models given a very small `max_tokens` — they spend the budget thinking and return
empty content, so the chain walks several passes before a non-reasoning member answers. Real agent
turns use a large budget and are unaffected (a realistic alias request answered first-step in 2.7s).
Evidence refined later the same day, over 996 recorded requests: only **16** contained any
`empty_completion` stage, and **15 of those 16 still returned 200**. The single failure was a
deliberate tiny-`max_tokens` probe. By client, the occurrences are `curl` 112, `chain-probe` 40,
`tinycap` 14, `bigctx` 2, and `claude` 1 — and that one Claude request succeeded in 4 stages
(answered by kilo) after the starved member returned empty. So `empty_completion` is behaving as
designed: it routes past a starved model and the request still completes. This is a sizing
consideration for T4, NOT a blocker and not evidence of chain fragility.

## Todos

Unchanged from the plan: T1 clear quarantine on key save/resync, T2 probe every chain member,
T3 honest `chain_exhausted` status, T4 ensure a member fits the largest realistic context, T5 tests
and live verification.
