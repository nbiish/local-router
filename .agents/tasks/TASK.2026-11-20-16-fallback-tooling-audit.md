# TASK 2026-11-20-16 — Fallback tooling audit

- **Plan:** `.agents/plans/2026-11-20-16-fallback-tooling-audit.plan.md`
- **Branch:** `feat/fallback-tooling-audit`
- **Worktree:** `/Volumes/1tb-sandisk/code-external/local-router-fallback-audit`
- **Status:** done
- **Operator:** question-me (three decisions in §4 of the plan)

## Objective

Review how the fallback tooling actually behaves, maximise each model before advancing, and make the
trajectory log a self-correcting evidence loop rather than a passive record — so the operator can
factually know the chain is doing what it claims.

## What was wrong

An audit of 353 live trajectory records (2384 stages) found that at least 63 of 573 failed stages were
the router corrupting a valid client request. Those failures were booked against innocent providers and
quarantined — `key_rejected` costs one strike — so the diagnostic log was itself the thing lying.

Six distinct classes, each measured:

| # | Defect | Live evidence |
|---|---|---|
| 1 | `AUTH_RE` matched the bare word `auth` in completion prose | 45 stages: HTTP-200 completions booked as `upstream_http_auth` |
| 2 | Failover appended a trailing `system` message | 21 failures; Z.ai `{"code":1214,"Incorrect role information"}` |
| 3 | `max_tokens` never clamped to the target's ceiling | 30 failures: `943718 … at most 131072` |
| 4 | `prompt_cache_key` / `store` sent to Google surfaces | ~40 failures: `Unknown name "prompt_cache_key"` / `"store"` |
| 5 | `estimateRequestContext` folded raw `max_tokens` into the context requirement | 30 records: `requiredContext 945635` from a 2-message prompt |
| 6 | No-dial models hard-excluded when a level was requested | 167 of 200 records: two paid subscriptions unreachable |

## What changed

- **Classifier** (`src/index.ts`): status-first, with `bodyIsCompletion` so a 2xx completion is never
  auth/limit evidence while a 2xx *error payload* is still classified from its body. `AUTH_RE` requires
  specific auth phrasing.
- **Failover body**: marker appended as a `user` note, preserving strict system-first ordering.
- **Output ceiling**: new `clampOutputTokens`, applied after dialect sanitising, recorded as
  `clampedTokens`. It only ever lowers.
- **Strict-schema gate**: `CachingPolicy.requestFields` plus `dropUnsupportedRequestFields`. Antigravity
  declares `strict` and stops receiving `prompt_cache_key`; `store` is not in the chat core.
- **Context estimate**: output headroom bounded at `MAX_OUTPUT_HEADROOM_TOKENS` (32768).
- **Tier-2 reasoning tail**: `filterEligibleFallbackModels` now returns `degraded`; the plan is
  `tier1 ++ tier2`, and every tier-2 stage carries `reasoningDialDowngraded` and `requestedLevel`.
- **Stream failover**: `isStreamErrorFrame` is finally called — a first-frame peek lets the chain retry a
  200-with-error-stream, and a mid-stream observer produces `mid_stream_error` once content has flowed.
- **Decisions** (`src/decisions/routes.ts`): every decision call appends a trajectory.
- **Advisory recommendations** (`GET /api/chain/recommendations`): exposes `planAutoDisable`'s reasoning
  and never writes `disabledModels`.
- **Single config source**: `persistFallbackModels` writes only `router-settings.json`; the machine copy
  is read once for migration; boot warns loudly when the authoritative file is absent.
- **Trajectory schema 3**: `stages[i].outbound` (the exact body sent), `clampedTokens`, `droppedFields`,
  `reasoningDialDowngraded`, `requestedLevel`, `chain.degradedTargets`. `storeReceipt` now spills whenever
  the preview is truncated, closing a real hole where a 422-byte body was neither inline nor spilled.
  New `?part=outbound&stage=N` so an agent can read any stage's request body.

## Verification (what was actually run)

- `npm run test:integration` — **450 tests, 437 pass, 12 skipped, 1 fail.** The single failure
  (`detectLocalCursorSession`) reproduces identically on untouched `main` at `f7a5cb8`; it is a
  host-environment assertion, not a regression.
- All 114 live 2xx-completion misfires replayed through the new classifier → **0** still classified as
  `auth`/`invalid_request`.
- Live smoke on `:11477` with `max_tokens: 943718`, `store`, `prompt_cache_key`, `reasoning_effort: high`
  → HTTP 200 in 3.5 s; the record shows `clamp=943718->131072`, roles `system, user`, and a retrievable
  outbound body via `?part=outbound&stage=2`.
- A direct antigravity call records `droppedFields: ["store","prompt_cache_key"]`.
- `?part=outbound&stage=N` returns the exact upstream JSON; every recorded receipt round-trips through
  `readReceiptPayload`.

## Not done, deliberately

- `src/tiers.ts` left in place (zero importers). Removal vs. adoption is an operator decision; recorded
  in `.agents/suggestions/2026-11-20-tiers-and-index-decomposition.txt`.
- Five configured providers remain absent from the chain. That is chain authoring, not a code defect;
  `scripts/verify-fallback-chain.mjs` already reports it.
- No automatic chain edits. `planAutoDisable` is exposed as advice only, per the operator's decision.

## Expected first failure if this is wrong

The tier-2 ordering. If `filterEligibleFallbackModels` ever put a no-dial member ahead of a dial-capable
one, every thinking request would be silently downgraded while returning 200. Three independent checks
guard it: the `degraded` set is disjoint from `eligible` (unit test), the plan is concatenated in tier
order (construction), and `verify-fallback-chain.mjs` fails if any dial-capable attempt follows a
tier-2 attempt in a real trajectory.
