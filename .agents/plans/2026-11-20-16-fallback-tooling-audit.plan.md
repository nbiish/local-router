---
plan_format: ainish/plan/v1
slug: fallback-tooling-audit
date: 2026-11-20
status: implementing
branch: feat/fallback-tooling-audit
worktree: /Volumes/1tb-sandisk/code-external/local-router-fallback-audit
task_record: .agents/tasks/TASK.2026-11-20-15-fallback-tooling-audit.md
operator: question-me
---

# Plan: Fallback tooling — correctness, maximization, and a verifiable evidence loop

## 1. Problem

The fallback chain never fails outright, which masked the fact that it frequently **caused** the
failures it then routed around. An audit of 353 live trajectory records found that at least 63 of 573
failed stages were the router corrupting or over-constraining a valid client request, not provider
faults. Those failures were booked against innocent providers, quarantined as if the provider were
sick (a `key_rejected` costs one strike), and reported to the operator as "provider down" — so the log
an operator would use to diagnose the chain was itself wrong. Two paid subscriptions were permanently
unreachable, a fully written auto-disable subsystem was wired to nothing, a stream that failed
mid-flight was forwarded instead of retried, and the exact body the router *sent* upstream — the single
most useful fact for any future fix — was never recorded.

## 2. Anchor Facts

All established by reading `src/` and replaying `~/.config/local-router/trajectories/trajectories.jsonl`
(353 records, 2384 stages, 2026-11-12 → 2026-11-20) plus live calls to the router on `:11434`.

### Router-caused failures

- **`AUTH_RE` contained a bare `auth` alternative.** Replaying the shipped classifier:
  `classifyHttpFailure(200, {…content:'The author of…'})` → `upstream_http_auth`. 45 live stages were
  HTTP-200 completions booked as rejected keys. — established from `src/index.ts:6743` and a replay.
- **`buildFailoverPreservedBody` appended a trailing `system` message**, yielding
  `system → user → system`. Z.ai rejects this with `{"code":1214,"Incorrect role information"}`;
  21 live failures. — established by invoking the function and reading the live log.
- **`max_tokens` was never clamped** to the target's `outputTokens`: 30 live failures of
  `max_completion_tokens is too large: 943718 … at most 131072`. — established from `src/index.ts:1423`
  and the live log.
- **`prompt_cache_key` and passthrough fields such as `store` reached Google**, which validates its
  schema and 400s: `Unknown name "prompt_cache_key"` / `Unknown name "store"`. — established from the
  live log and `src/index.ts:7197-7291`.
- **`estimateRequestContext` folded the raw `max_tokens` into the context requirement**, so a client
  asking for 943K *output* produced `requiredContext: 945,635` and excluded every model below that.
  — established from `src/routing-capabilities.ts:119` and 30 live records.

### Maximization

- **No-dial members were hard-excluded, killing two subscriptions.** `reasoningLevelsFor` returns `[]`
  for `dialect === 'model-id'` (`src/provider-policy.ts:684`), and the filter treated
  `reasoningLevelCount === 0` as `no_reasoning_dial`. `cursor-auto`, `github-copilot-auto`,
  `cursor-deepseek-v41-flash-1017`, `cursor-grok-4.7` were excluded in 167 of 200 windowed records.
  — established from `GET /api/trajectories/health` on the live router.

### Dead wiring

- `src/auto-disable.ts` (`planAutoDisable`, `applyAutoDisable`, `reEnableModel`) had zero production
  callers. `healthRegistry.autoDisableCandidates|markAutoDisabled|clearAutoDisabled` had zero callers
  anywhere. `src/tiers.ts` had zero importers. `isStreamErrorFrame` was defined and never called, so
  `mid_stream_error` had no producer. — established by repo-wide `rg` for each symbol.

### Observability

- **The outbound body was never recorded.** `summarizeRequestBody` captured the *client's* request;
  `proxyModelAttempt`'s `finalBody` was never persisted. Every defect above was invisible except as a
  truncated `providerErrorPreview`. — established from `src/trajectories.ts` and `src/index.ts`.
- **The decisions route was dark.** No `TrajectoryTracker` anywhere in `src/decisions/`.
- **Two chain files disagreed.** `<checkout>/router-settings.json` (19 steps) vs the machine copy
  (17 steps), because `persistFallbackModels` wrote both. — established from the two files on disk.

## 3. Plan

### Goals

- The router never sends a request a provider will reject for a router-authored reason.
- A failure's `errorType` names what actually failed, so quarantine and triage are trustworthy.
- Every configured model is reachable, with no-dial downgrades recorded rather than silent.
- Trajectories record the outbound request, so any future defect is diagnosable from the log alone.
- One authoritative chain file. Auto-disable advises; it never writes.

### Non-goals

- Re-architecting the 10k-line `index.ts` into modules. High risk, no behavioural gain here.
- Deleting `src/tiers.ts`. Recorded as a suggestion; removal is a separate decision.
- Rewriting `buildEscalatingWraparoundPlan`. It works; only its dead siblings are noted.

### Interfaces and data

- `classifyHttpFailure(status, bodyText)` — now status-first: a 2xx that parses as a completion is
  never auth/payment/limit evidence; a 2xx carrying an `error` payload is still classified from its body.
- `clampOutputTokens(body, maxOutputTokens)` — new, exported. Returns `{body, clamped?}`, only lowers.
- `dropUnsupportedRequestFields(body, provider, model)` — new, exported from `provider-policy`. Applies
  only when a provider row declares `requestFields.validation: 'strict'`.
- `CachingPolicy.requestFields` — new optional contract. Antigravity declares `strict` and
  `stickyKey: 'none'`.
- `filterEligibleFallbackModels` — returns a new `degraded: string[]`. `no_reasoning_models` is no
  longer produced.
- `TrajectoryChain.degradedTargets` and `TrajectoryStage.{outbound, clampedTokens, droppedFields,
  reasoningDialDowngraded, requestedLevel}` — new, all optional. Schema `TRAJECTORY_SCHEMA_VERSION` 2 → 3.
- `GET /api/chain/recommendations` — new, advisory only. `GET /api/trajectories/:id?part=outbound&stage=N`
  — new.

### Files and symbols

- `src/index.ts` — `AUTH_RE`, `bodyIsCompletion` (new), `classifyHttpFailure`, `normalizeHttpFailure`,
  `buildFailoverPreservedBody`, `clampOutputTokens` (new), `directShapingFacts` (new),
  `peekStreamForErrorFrame` (new), `createStreamErrorObserver` (new), `proxyModelAttempt`,
  `sendSuccessfulProxyResponse`, `executeFallbackRoute` (tier-2 plan), `persistFallbackModels` (single
  write), `migrateLegacyFallbackModelsFile` (new), `loadPersistedRouterSettings` (warn-if-absent).
- `src/routing-capabilities.ts` — `MAX_OUTPUT_HEADROOM_TOKENS` (new), `estimateRequestContext`,
  `FallbackFilterResult.degraded`, `filterEligibleFallbackModels` (partition instead of exclusion).
- `src/provider-policy.ts` — `CachingPolicy.requestFields`, antigravity row, `requestedThinkingLevel`
  (new), `dropUnsupportedRequestFields` (new).
- `src/trajectories.ts` — schema 3, the five new stage fields, `degradedTargets`, and `storeReceipt`
  spilling whenever the preview is truncated.
- `src/decisions/routes.ts` — trajectory capture on every decision call.
- `src/routes/config-api.ts` — `/api/chain/recommendations`, `part=outbound`.
- `src/ui/pages/{layout,trajectories}.ts` — recommendations card.
- `scripts/verify-fallback-chain.mjs` — trajectory-evidence assertions.
- `docs/trajectories.md` — schema 3, outbound receipts, tier-2, new endpoints.

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| Delete the bare `auth` regex and leave 2xx classification alone | A 200 carrying `{"error": "invalid api key"}` is a real auth failure with no other evidence; the status must not be the only signal, so the split is completion-shaped vs error-shaped. |
| Hard-fail a thinking request (status quo) | It trades a silent downgrade for a silent outage: two paid subscriptions served zero requests for 167 of 200 turns. |
| Auto-apply `planAutoDisable` now that it is wired | The chain is operator-authored truth; a background edit changes routing for every agent on the machine, unattended. |
| Spill at a fixed 4 KB | Measured live: a 422-byte outbound body is past the 400-char preview cap and under 4 KB, so it was neither inline nor spilled and the exact body was unrecoverable. |

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tier-2 ordering re-admits no-dial members *ahead* of dial-capable ones | The plan is `tier1 ++ tier2` by construction; `verify-fallback-chain.mjs` asserts no dial-capable attempt follows a tier-2 attempt, and unit tests assert no member appears in both tiers. |
| The stream peek breaks a working stream | One frame only, capped at 8 KB, and the consumed bytes are prepended so the pipe is byte-identical; a read error returns the response untouched. |
| Strict-schema filtering drops a field the provider actually needed | The gate applies only to providers whose row declares `strict`, keeps the documented chat core, and records every dropped name in the trajectory. |
| Single-source write loses a chain on a host with only the legacy file | `migrateLegacyFallbackModelsFile` adopts it once, and only when the authoritative file has no routes. |

## 4. Clarifications

### 4.1 Auto-disable behaviour

- **Question:** `auto-disable.ts` is fully written but wired to nothing. Enabling it means the router
  edits `disabledModels` in the chain file on its own.
- **Options:** 1. (Recommended) Advisory only — surface a ready-to-apply recommendation and never write
  the chain; 2. Auto-apply with the empty-chain guard; 3. Delete the dead module.
- **Selected:** Advisory only.
- **Trade-off accepted:** A sustained-failure member stays in the chain until a human acts; the
  recommendation is visible but not self-healing.
- **asked:** operator

### 4.2 Chain config source

- **Question:** Two files hold the chain — the checkout `router-settings.json` (tracked, 19 steps) and
  the machine copy (stale, 17 steps).
- **Options:** 1. (Recommended) Checkout file only, migrate once, fail loudly if absent; 2. Keep the
  machine mirror as read-only derived state; 3. Document the precedence and leave both writers.
- **Selected:** Checkout file only.
- **Trade-off accepted:** A machine that has never synced the checkout has no chain until it authors
  one; boot now says so explicitly instead of reporting "no eligible targets".
- **asked:** operator

### 4.3 Reasoning-dial eligibility

- **Question:** A request that chose a thinking level excluded every model without a request dial,
  which made two subscriptions unreachable. The doctrine behind the exclusion was preventing a
  *silent* downgrade.
- **Options:** 1. (Recommended) Rank them last, not ineligible — attempt only after every dial-capable
  member fails, and record each acceptance as a downgrade; 2. Map the level onto a sibling model id;
  3. Both; 4. Keep the hard exclusion.
- **Selected:** Rank them last, with the downgrade recorded.
- **Trade-off accepted:** A caller may be served by a model that could not honour their level; the
  trajectory states this explicitly (`reasoningDialDowngraded`, `requestedLevel`), so it is visible
  rather than silent.
- **asked:** operator

## 5. Todos

- [x] **T1** Status-first `classifyHttpFailure`; strict `AUTH_RE`; guard `normalizeHttpFailure`.
  - from: §2 | done when: a 200 completion mentioning "author" is not auth | verify: `node --test tests/fallback-content-classifier.test.mjs`
- [x] **T2** Failover marker appended as `user`, preserving system-first ordering.
  - from: §2 | done when: roles are `system, user, user` | verify: `node --test tests/fallback-content-classifier.test.mjs`
- [x] **T3** `clampOutputTokens` in `proxyModelAttempt`, recorded as `clampedTokens`.
  - from: §2 | done when: 943718 becomes 131072 | verify: `node --test tests/request-shaping.test.mjs`
- [x] **T4** Bound the output headroom in `estimateRequestContext`.
  - from: §2 | done when: a 943718 ask yields ~32768, not 945635 | verify: `node --test tests/fallback-context-multimodal.test.mjs`
- [x] **T5** Per-provider `requestFields` contract and `dropUnsupportedRequestFields`.
  - from: §2 | done when: antigravity drops `store`/`prompt_cache_key` | verify: `node --test tests/request-shaping.test.mjs`
- [x] **T6** `degraded` eligibility plus tier-2 tail planning and downgrade recording.
  - from: §4.3 | done when: `degraded` is populated and tier-1 precedes tier-2 | verify: `node --test tests/fallback-topology.test.mjs`
- [x] **T7** Wire `isStreamErrorFrame` via a first-frame peek and a mid-stream observer.
  - from: §2 | done when: `mid_stream_error` has a producer | verify: `npm run build && node --test tests/fallback-content-classifier.test.mjs`
- [x] **T8** Trajectory schema 3: outbound receipt, clamp, drops, downgrade; receipts always retrievable.
  - from: §2 | done when: every outbound body round-trips | verify: `node --test tests/trajectories.test.mjs`
- [x] **T9** Decisions-route trajectory capture.
  - from: §2 | done when: a decision call appends a record | verify: `node --test tests/decisions*.test.mjs`
- [x] **T10** Advisory `/api/chain/recommendations` plus the UI card; no chain writes.
  - from: §4.1 | done when: the endpoint answers `advisoryOnly: true` | verify: `curl -s localhost:11434/api/chain/recommendations`
- [x] **T11** Single authoritative chain file with one-time legacy migration and a loud warning.
  - from: §4.2 | done when: only `router-settings.json` is written | verify: `node --test tests/fallback-persist-edits.test.mjs`
- [x] **T12** Trajectory-evidence assertions in `verify-fallback-chain.mjs`.
  - from: §3 | done when: the script checks 2xx misreads, tier order, and unexplained members | verify: `node scripts/verify-fallback-chain.mjs`
- [x] **T13** Close-out: task record, COMMS ledger, memory entry, suggestions.
  - from: §3 | done when: the records exist | verify: `ls .agents/tasks .agents/comms .agents/suggestions`

## 6. Verification

- `npm run test:integration` — 450 tests, 437 pass, 12 skipped, 1 failure. The failure
  (`detectLocalCursorSession auto-detects host installation if present`) is **pre-existing on
  untouched `main`** and host-specific; reproduced on `f7a5cb8` before any change.
- `node --test tests/{failure-classification,fallback-content-classifier,fallback-context-multimodal,fallback-topology,request-shaping,trajectories,health-registry,health-persistence,auto-disable}.test.mjs`
  — all pass.
- Replay of all 114 live 2xx-completion misfires through the new classifier — 0 remain classified as
  `auth`/`invalid_request`.
- Live smoke on `:11477` with `max_tokens: 943718`, `store`, `prompt_cache_key`, `reasoning_effort` —
  HTTP 200; the record shows `clamp=943718->131072`, retrievable outbound body, and `system, user`
  roles. A direct antigravity call records `droppedFields: ["store","prompt_cache_key"]`.
- `node scripts/verify-fallback-chain.mjs` — trajectory assertions pass; it still reports the 5
  providers absent from the chain as a pre-existing coverage gap (nebius-us-north1, moonshot,
  modal-proxy, ollama, nous-portal), unchanged by this task.

## 7. Open Decisions

- `src/tiers.ts` is unreachable code defining a success-rate tier model with
  `SUCCESS_RATE_THRESHOLD = 0.85` and `TIER_MIN_SAMPLES = 50`. Whether to delete it or use it as the
  basis for chain ranking is left to the operator; recorded in
  `.agents/suggestions/2026-11-20-tiers-and-index-decomposition.txt`.
- Five configured providers remain absent from the chain. Closing that is a chain-authoring decision,
  not a code defect, and `verify-fallback-chain.mjs` already reports it.
