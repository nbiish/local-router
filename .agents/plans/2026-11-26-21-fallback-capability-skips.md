---
plan_format: ainish/plan/v1
slug: fallback-capability-skips
date: 2026-11-26
status: done
branch: fix/fallback-capability-skips
worktree: /Volumes/1tb-sandisk/code-external/local-router-worktrees/fix-fallback-capability-skips
task_record: .agents/tasks/2026-11-26-21-fallback-capability-skips.md
operator: omp
---

# Plan: Capability-aware fallback planning and a chain-faithful models view

## 1. Problem

Two halves of one promise: the `fallback-models` entry a harness reads (`context_length`,
`max_output_tokens`, `capabilities.toolCalling`, `capabilities.imageInput`) must track the user's
current chain composition, and a chat that needs **vision or tools** must never be planned onto a
member that cannot serve it. Today the models view's limits are floors and its capability flags are
unions (dynamic, but unproven and with inconsistent unknown-spec handling), while the **planner has
no tools filter at all**: a tool-using chat can be planned onto a tool-less member, which then either
fails (wasted attempt, cascading) or answers with the tools silently ignored. The desired behavior:
skip incapable members in the fallback lineup, intelligently and observably.

## 2. Anchor Facts

- `filterEligibleFallbackModels` (`src/routing-capabilities.ts:229`) filters multimodal
  (`no_multimodal_support`) and context, and partitions reasoning-dial members into a `degraded`
  list; it maps only `contextLength`/`supportsImages`/`reasoningLevelCount` per candidate. There is
  no `requestRequiresTools` and no tools step — established by reading the function.
- Both call sites already pass `supportsTools` into the spec callback and discard it:
  `fallbackExecutionPlan` (`src/index.ts:8427`) and the request executor (`src/index.ts:9078`),
  whose `chainSnapshot` already records `excludedTargets[].reason` into trajectories.
- `requestRequiresMultimodal` (`src/routing-capabilities.ts:162`) scans the **whole message
  history** (root `images`, per-message `images`, content parts), so a session that starts with
  vision stays sticky — established from source. `estimateRequestContext` (`:70`) likewise covers
  history and tool-definition overhead.
- The request field gate (`dropUnsupportedRequestFields`, `src/provider-policy.ts:735`) is a
  provider-schema contract; it never touches `tools` — so tool-less members receive `tools` today.
- Registry flags are sparse but assembly defaults make served specs honest: `supportsTools` is
  defaulted `true` at assembly (`src/index.ts:1612,1639,2668,2770`), 799/1349 registry rows carry
  an explicit `supportsTools: true`; `supportsImages` 587/1349. The route presentation
  (`fallbackModelPresentation`, `src/index.ts:3838`) reads the same served specs per request:
  limits are floors (PR #31), `supportsTools`/`supportsImages` are unions over members — dynamic
  with chain membership by construction.
- A route needs two unique members at authoring (`POST /api/fallback-models`); request-time
  eligibility may narrow the lineup to one or zero — the zero case today reports
  `no_multimodal_models`/`chain_empty`; a tools analogue is the consistent extension.
- Trajectory schema v3 records `chain.excludedTargets`/`eligibleTargets` and per-stage
  `skipReason`; skip reasons are the observability contract ("which chain member is being silently
  skipped, and why", `docs/trajectories.md`).

## 3. Plan

### Goals

- A chat that needs tools or vision is planned only onto members that can serve it; incapable
  members are skipped **with a recorded reason**, visible in the trajectory chain snapshot.
- The `fallback-models` models-view entry tracks the user's chain choice dynamically for all four
  advertised fields, with unknown-spec handling consistent between advertisement and planner.

### Non-goals

- No change to the union semantics of the advertisement (the route advertises a capability when a
  member has it — consumers ask "can I?", not "can every member?").
- No change to shedding order, quarantine/recovery, or the reasoning-dial `degraded` mechanism.
- No new capability inference from model families (flags only; a policy layer is a separate task).

### Constraints and invariants

- Session-sticky detection: a requirement triggered anywhere in the chat history (images, tool
  calls, tool results) applies to the whole session — the scan covers the full body.
- Skip, never silent downgrade: a known tool-less member must not receive a tool chat (today's
  failure mode is an ignored tool call served as success).
- Zero-capable chains fail closed with an explicit error (`no_tools_models`), the exact shape of
  the existing `no_multimodal_models`.
- Unknown `supportsTools` on a resolved member is treated as the assembly default (true);
  unresolved members stay eligible and fail-and-cascade, matching `activeFallbackModels` doctrine.

### Proposed architecture

```
request body ──► requestRequiresTools / requestRequiresMultimodal / estimateRequestContext
                        │
filterEligibleFallbackModels(active, body, getSpecs)
   step 1: skip no_multimodal_support        (existing)
   step 2: skip no_tools_support             (new — same shape, recorded reason)
   step 3: reasoning-dial partition          (existing, degrade not skip)
   step 4: context-window filter             (existing)
                        │
        eligible[] + degraded[] + skipped[]  ──► trajectory chain snapshot (already wired)
```

And the models view: `fallbackModelPresentation` keeps deriving per request from the live chain
(store read per call — no cache), now proven by tests that edit the chain and re-read `/v1/models`.

### Interfaces and data

- `src/routing-capabilities.ts`: new exported `requestRequiresTools(body)`; `ModelCapabilitySpecs`
  gains `supportsTools`; `SkippedCandidate.reason` gains `'no_tools_support'` (+ `supportsTools`);
  `FallbackFilterResult` gains `requiresTools` and error `'no_tools_models'`.
- `tests/fallback-capability-skips.test.mjs` (new, listed in `test:integration`): deterministic
  unit tests with an injected `getSpecs`, covering tools skip, vision skip, history stickiness for
  both, the zero-capable error, and the no-requirements no-regression case.
- `tests/fallback-route-floor-limits.test.mjs` gains a dynamism test: chain edits move all four
  advertised fields (`context_length`, `max_output_tokens`, `capabilities.toolCalling`,
  `capabilities.imageInput`) on the next `/v1/models` read.

### Files and symbols

- `src/routing-capabilities.ts` — `requestRequiresTools`, `filterEligibleFallbackModels`, the
  result/candidate types.
- `tests/fallback-capability-skips.test.mjs` — new.
- `tests/fallback-route-floor-limits.test.mjs` — one added test.
- `package.json` — `test:integration` gains the new test file.

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| Strip `tools` and serve tool-less members anyway | The silent downgrade the user is reporting; the turn "succeeds" without tools |
| Put tool-less members in a `degraded` last-pass list (reasoning-dial pattern) | A tool-less model cannot honour a tool request at all — unlike a dial-less model answering at its own depth; skipping is the honest shape, with a recorded reason |
| Infer tool support from families/policy | New invention surface; the served `supportsTools` flag (assembly-defaulted true) already carries the fact |
| Shrink the advertisement to "all members" semantics | Consumers ask "can this route take tools/images?" — union is the truthful answer; the planner is what must narrow |

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| A chain whose members are all explicitly tool-less stops serving tool chats (worked "by accident" before, with tools ignored) | That turn never worked; it now fails closed with `no_tools_models`, and the models view already told the truth (`toolCalling: false`) |
| Requirement false-positives shrink eligibility | Detection keys on explicit signals only (tools arrays, tool role/messages, tool_use parts); the no-requirement path is unchanged and tested |
| Advertisement/planner disagree on unknown specs | Both read the same served `supportsTools` (assembly default true); the dynamism test pins the advertised fields to chain membership |

## 4. Clarifications

### 4.1 Zero-capable chains

- **Question:** When a tools/vision requirement leaves no eligible member, fail or serve degraded?
- **Options:** 1. (Recommended) Fail closed with `no_tools_models` / `no_multimodal_models`, skipped members recorded; 2. Serve with tools stripped (silent downgrade); 3. Degrade to incapable members as a recorded last pass.
- **Selected:** 1 — resolved from code: `no_multimodal_models` already sets the precedent in the same function, and a silently tool-less answer is the failure being fixed.
- **Trade-off accepted:** Chains that "worked" by ignoring tools now surface the real gap.
- **asked:** resolved from code
- **resolved by:** `src/routing-capabilities.ts` (`no_multimodal_models` branch), user's "intelligently skip" requirement

### 4.2 Unknown capability flags

- **Question:** How do unknown `supportsTools` flags count?
- **Selected:** resolved-from-code: served specs default `supportsTools` to true at assembly; unresolved members stay eligible and fail-and-cascade (the `activeFallbackModels` doctrine). Symmetric with how the advertisement unions them.
- **asked:** resolved from code
- **resolved by:** `src/index.ts:1612,1639,2668,2770`, `src/index.ts:8402` comment

## 5. Todos

- [x] **T1** Add `requestRequiresTools` and the tools skip step to `filterEligibleFallbackModels` (types updated: `ModelCapabilitySpecs.supportsTools`, `SkippedCandidate.reason 'no_tools_support'`, `FallbackFilterResult.requiresTools`/`'no_tools_models'`).
  - from: §3 | done when: a tools chat plans only onto tool-capable members and the skip is recorded | verify: `node --test tests/fallback-capability-skips.test.mjs`
- [x] **T2** Add `tests/fallback-capability-skips.test.mjs` (unit, injected specs) and list it in `test:integration`.
  - from: §3 | done when: tools skip, vision skip, history stickiness, zero-capable error and the no-requirement case are covered | verify: the test file passes and fails without T1
- [x] **T3** Extend `tests/fallback-route-floor-limits.test.mjs` with the dynamism test (chain edits move all four advertised fields).
  - from: §1 | done when: editing the chain changes `/v1/models` output on the next read | verify: `node --test tests/fallback-route-floor-limits.test.mjs`
- [x] **T4** Task record, COMMS and memory; neighbors re-run (`fallback-chain-toggle`, `execution-plan`, `self-healing-fallback`, `app-update-ui`).
  - from: contract | done when: records committed on the branch, neighbors green | verify: `git status` clean

## 6. Verification

- `npm run build` then `node --test tests/fallback-capability-skips.test.mjs tests/fallback-route-floor-limits.test.mjs` — all pass.
- Neighbor suites (`fallback-chain-toggle`, `fallback-disabled-execution-plan`, `self-healing-fallback`, `app-update-ui`) — unchanged and green.
- Live read-back after merge: a tools request against a mixed chain plans only tool-capable members (trajectory `chain.excludedTargets` carries `no_tools_support`).

## 7. Open Decisions

- _(empty)_
