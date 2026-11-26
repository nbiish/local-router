# Task: Advertise the fallback-models route at the chain's minimum limits

- lane: now
- branch: `fix/fallback-min-limits`
- worktree: `/Volumes/1tb-sandisk/code-external/local-router-worktrees/fix-fallback-min-limits`
- status: done
- plan: `.agents/plans/2026-11-26-19-fallback-min-limits.md`
- scope: `src/index.ts` (`fallbackModelPresentation`), `tests/fallback-route-floor-limits.test.mjs` (new), `package.json` (`test:integration`)
- compat: additive; only the route's *advertised* limits change (they were ceilings over members, now floors). Shedding, eligibility filtering, per-target output clamping and capability unions are untouched.
- objective: A harness calling `local-router/fallback-models` as a provider sees context/output limits that fit every chain member, so long chat sessions are fed data that never interrupts a turn.

## Why (2026-11-26)

The route advertised the **largest** member's limits (`context_length: 1050000`,
`max_output_tokens: 1048576` from the 1M-context member) while a shed can land on a 64k member. A
harness sized to that advertisement is guaranteed to hit a member that cannot take the turn
mid-session. The requirement: advertise the minimum of all models in the chain.

## Verification (2026-11-26)

- **Any-length chat sessions through the trajectory logs** (the operator's requirement): a
  12-turn growing chat plus one 161KB-payload turn through `local-router/fallback-models` on the
  live router — 13/13 requests answered (`result.status == 200`), `chain.requiredContext` tracked
  growth 1,533 → 67,676, 53 stages fully accounted (13 answered, 1 failed-and-cascaded, 39
  skipped), and all 42 receipts byte-retrievable from content-addressed spill. The first checker
  run reported `outcome.status` misses; the record field is `result.status` (schema v3) — corrected
  without a rerun.
- `npm run build` (`tsc`) clean.
- `node --test tests/fallback-route-floor-limits.test.mjs` — 3/3:
  - a route advertises the chain minimum on `/v1/models` (`context_length`, `max_input_tokens`) and `/api/tags`;
  - unknown member specs floor at the planner default (64000 / 4096), matching `filterEligibleFallbackModels`;
  - an operator-disabled member does not constrain the floor (it cannot serve).
- Neighbors unaffected: `fallback-chain-toggle` + `fallback-topology` + `app-update-ui` — 32/32.

## Not done

- Live read-back of the floored advertisement awaits the next deploy/release of the router.
- The two-machines + cloud/hermes verification is the operator's step once the release ships.
