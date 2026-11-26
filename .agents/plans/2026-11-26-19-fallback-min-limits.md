---
plan_format: ainish/plan/v1
slug: fallback-min-limits
date: 2026-11-26
status: done
branch: fix/fallback-min-limits
worktree: /Volumes/1tb-sandisk/code-external/local-router-worktrees/fix-fallback-min-limits
task_record: .agents/tasks/2026-11-26-19-fallback-min-limits.md
operator: omp
---

# Plan: Advertise the fallback-models route at the chain's minimum limits

## 1. Problem

An agent harness that calls `local-router/fallback-models` as a provider sizes its context usage from
what `/v1/models` advertises for the route. Today the route advertises the **largest** member's
limits (`context_length: 1050000`, `max_output_tokens: 1048576` — inherited from the 1M-context
member), while a shed can land on a member with 64k. A long chat session sized to the advertisement
is therefore guaranteed to hit a member that cannot take it mid-session. The route must advertise the
**minimum** across its members so the harness feeds the router data that fits every member and no
turn is interrupted.

## 2. Anchor Facts

- `fallbackModelPresentation` (`src/index.ts:3838`) aggregates with `Math.max` over member `contextLength`/`outputTokens`; every surface (`/v1/models` `context_length`/`max_output_tokens`, `/api/tags`) derives from it — live probe and source read.
- `filterEligibleFallbackModels` (`src/routing-capabilities.ts:229`) treats an unknown member spec as `64000`, matching `DEFAULT_CONTEXT_LENGTH` (`src/index.ts:293`); `DEFAULT_OUTPUT_TOKENS` is 4096 (`src/index.ts:295`).
- `activeFallbackModels` (`src/index.ts:8402`) returns operator-enabled members (unknown/unresolvable entries stay in the plan and fail-and-cascade at execution), and `fallbackModelPresentation` already scopes aggregation to `active` (falling back to `model.models`).
- Member eligibility is filtered per request (`filterEligibleFallbackModels`, multimodal and reasoning-dial checks) and output budgets are clamped per resolved target at request time — capabilities stay a union; only the advertised limits lack a floor.
- Trajectory logging proved it can carry an any-length session on this host: a 13-request growing chat (1,533 → 67,676 required-context) answered 13/13 with `result.status == 200`, 53 stages fully accounted, 42 receipts byte-retrievable from spill.

## 3. Plan

### Goals

- `local-router/fallback-models` (and every fallback route) advertises `context_length`, `max_input_tokens` and `max_output_tokens` as the minimum across its chain members, so a harness sized to the advertisement never exceeds any member.
- The floor and the execution planner agree on unknown member specs.

### Non-goals

- No change to shedding, eligibility filtering, per-target output clamping, or the union semantics of `supportsImages`/`supportsTools`/`supportsCache`/`supportsReasoning` (those gate members per request; they are not limits).
- No change to `DEFAULT_CONTEXT_LENGTH`/`DEFAULT_OUTPUT_TOKENS` themselves.

### Constraints and invariants

- Unknown member specs use 64000 (context) — the same value `filterEligibleFallbackModels` plans with — so advertisement and planning cannot disagree.
- Operator-disabled members do not constrain the floor (they cannot serve); unknown/unresolvable members do (they remain in the plan).
- A request bigger than some member's limits is still served: the execution plan filters per request and the chain cascades — the floor minimizes churn, it does not cap the router.

### Proposed architecture

One change at the single aggregation point (`fallbackModelPresentation`): replace the `Math.max`
ceilings with `Math.min` floors over the same member set, defaulting unknown specs to the planner's
values. Every wire surface follows automatically because all of them read the presentation.

### Interfaces and data

- `src/index.ts` `fallbackModelPresentation`: `contextLength`/`outputTokens` become minima over
  member specs (unknown context → 64000, unknown output → 4096), falling back to
  `DEFAULT_CONTEXT_LENGTH`/`DEFAULT_OUTPUT_TOKENS` only when no member resolves.
- New `tests/fallback-route-floor-limits.test.mjs` (listed in `test:integration`): builds a chain
  from two catalog members with known distinct limits and asserts the route entry's
  `context_length`/`max_output_tokens` equal the smaller member's values.

### Files and symbols

- `src/index.ts` — `fallbackModelPresentation` (aggregation block).
- `tests/fallback-route-floor-limits.test.mjs` — new; server-spawn harness in the shape of
  `tests/fallback-chain-toggle.test.mjs`.
- `package.json` — `test:integration` gains the new test file.

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| Advertise the maximum but filter members per request (today) | The harness still sizes to the advertisement; churn and clamping happen on every turn |
| Floor over all configured members including operator-disabled | A disabled member can never serve; it would shrink the advertisement for nothing |
| Per-request negotiated limits (advertise per member) | The route is one model id to the harness; there is no per-turn negotiation on the wire |

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| A tiny-context member shrinks the advertised window for the whole chain | That is the point (non-interrupting sessions); the operator can disable the member to raise the floor |
| Unknown member specs understate the floor's safety | Both advertisement and planner treat unknown as 64000; per-request filtering and cascading still protect the turn |
| A test that pins an exact number breaks when the registry changes | The test computes the expected floor from the members' own advertised entries at runtime |

## 4. Clarifications

### 4.1 Floor scope and unknown specs

- **Question:** Over which members is the minimum taken, and what does a member with unknown specs contribute?
- **Options:** 1. (Recommended) Enabled members, unknown specs counted as the planner's defaults (64000 / 4096); 2. All configured members including disabled; 3. Only members with known specs.
- **Selected:** 1 — resolved from code: `activeFallbackModels` already decides who can serve, `filterEligibleFallbackModels` already plans unknown specs as 64000, and the user's requirement is "the minimum of all the models in the fallback-models model".
- **Trade-off accepted:** An unknown member whose real limits are below 64000 can still fail once per turn; the chain cascades and the trajectory records it.
- **asked:** resolved from code
- **resolved by:** `src/index.ts:8402`, `src/routing-capabilities.ts:254`, `src/index.ts:293-295`

## 5. Todos

- [x] **T1** Change `fallbackModelPresentation` to floor `contextLength`/`outputTokens` over the resolved member specs.
  - from: §3 | done when: a route entry advertises the smallest member's limits | verify: `node --test tests/fallback-route-floor-limits.test.mjs`
- [x] **T2** Add `tests/fallback-route-floor-limits.test.mjs` and list it in `test:integration`.
  - from: §3 | done when: the test fails on the max-aggregation and passes on the floor | verify: `node --test tests/fallback-route-floor-limits.test.mjs`
- [x] **T3** Task record, COMMS and memory for this work.
  - from: contract | done when: files exist and are committed on the branch | verify: `git status` clean

## 6. Verification

- `npm run build` then `node --test tests/fallback-route-floor-limits.test.mjs` — passes against the new behavior.
- `node --test tests/fallback-chain-toggle.test.mjs tests/fallback-topology.test.mjs tests/app-update-ui.test.mjs` — unaffected.
- Live read-back after the next deploy: `/v1/models` shows `local-router/fallback-models` with the chain's smallest limits.

## 7. Open Decisions

- _(empty)_
