# Task: Capability-aware fallback planning and a chain-faithful models view

- lane: now
- branch: `fix/fallback-capability-skips`
- worktree: `/Volumes/1tb-sandisk/code-external/local-router-worktrees/fix-fallback-capability-skips`
- status: done
- plan: `.agents/plans/2026-11-26-21-fallback-capability-skips.md`
- scope: `src/routing-capabilities.ts`, `src/trajectories.ts`, `src/index.ts` (chain-snapshot fields), `tests/fallback-capability-skips.test.mjs` (new), `tests/fallback-route-floor-limits.test.mjs`, `package.json`
- compat: additive; planning narrows only where a member is **known** to lack the capability (today those turns fail or are answered with the caller's tools silently ignored). The advertised unions are unchanged; the trajectory chain gains an optional `requiresTools`.
- objective: A chat that needs tools or vision is planned only onto members that can serve it, and the models view's `context`/`output`/`tools`/`vision` track the user's chain choice.

## What was wrong (2026-11-26)

- The planner had **no tools filter**: `requestRequiresTools` did not exist and `filterEligibleFallbackModels`
  discarded the `supportsTools` spec both call sites already computed. A tool chat could be planned onto a
  tool-less member, which upstream either errors (wasted attempt) or answers without the tools — a turn
  that "succeeds" while silently dropping the caller's tool.
- The models view was already dynamic in code (limits = floors, tools/vision = unions, all per request)
  but unproven and with unknown-spec handling that disagreed between advertisement and planner.

## What changed

- `requestRequiresTools(body)` — session-sticky like the vision detector: scans the full history for
  tool declarations, `tools`/`functions` arrays, tool/function roles, `tool_calls`/`function_call`,
  and `tool_use`/`tool_result`-shaped content parts. Typed `unknown` with `in`-narrowing.
- `filterEligibleFallbackModels` gains a Step 1.5 tools gate, same hard-skip shape as the multimodal
  gate: incapable members are skipped with reason `no_tools_support`, and a chain with nobody left
  fails closed with `no_tools_models` (the `no_multimodal_models` precedent). Gates run in sequence
  and record the first failing reason per member.
- Trajectory chain snapshots carry `requiresTools` beside `requiresMultimodal`, so a recorded
  `no_tools_support` skip is explainable from the log alone.

## Verification (2026-11-26)

- `npm run build` clean (0 TS errors).
- `tests/fallback-capability-skips.test.mjs` 7/7: tools-only, vision-only, both, history stickiness
  (image in message 0 / tool traffic in history with a plain last turn), zero-capable `no_tools_models`
  with recorded skips, plain chat untouched, detectors key on explicit signals only.
- `tests/fallback-route-floor-limits.test.mjs` 4/4, including the new dynamism test: editing the chain
  (disabling/re-enabling a member) moves all four advertised fields on the next `/v1/models` read —
  `context_length`/`max_output_tokens` floors and `capabilities.toolCalling`/`imageInput` unions.
- Neighbors 66/66: `fallback-chain-toggle`, `fallback-disabled-execution-plan`, `execution-plan`,
  `self-healing-fallback`, `fallback-topology`, `trajectories`, `app-update-ui`.

## Not done

- A live mixed-chain tools request against a running router (trajectory `chain.excludedTargets` with
  `no_tools_support`) is the post-merge read-back in plan §6.
- Capability inference from model families (for rows with no flags) is a separate task; this change
  trusts the served `supportsTools` flag (assembly-defaulted true).
