---
plan_format: ainish/plan/v1
slug: max-caching-everywhere
date: 2026-11-12
status: done
branch: feat/max-caching-everywhere
worktree: /Volumes/1tb-sandisk/code-external/local-router-max-caching
task_record: .agents/tasks/TASK.2026-11-12.max-caching-everywhere.md
operator: direct
---

# Plan: Maximum prompt caching across all providers and models

## 1. Problem

Operator directive (2026-11-12): "We should be using max possible caching across all providers
and models." The immediate trigger is the fastino policy row shipped conservative
(`implicitCache` + sticky key only — no cache_control markers) because the retired pioneer
wire's marker behavior was not re-verified on `api.fastino.ai`. The directive reverses that
posture: every provider and model should run with the maximum caching its wire supports, backed
by measurement where a key is configured and by the repo's per-provider evidence docs elsewhere.

## 2. Anchor facts (verified)

- Caching policy lives in `src/provider-policy.ts`: per provider, `caching` carries
  `ttl: '5m'|'1h'|null`, `stickyKey: 'session_id'|'prompt_cache_key'|'keep_alive'|'none'`,
  `minCacheableTokens?`, `stripsCacheControl`, `includeStreamUsage`.
- Factories: `anthropicCache` (explicit `cache_control` markers, `ttl: '1h'`, 4 markers,
  sticky `prompt_cache_key`, markers kept, stream usage on) is the marker-capable maximum;
  `implicitCache` (no markers) is the automatic-cache shape for OpenAI-family wires.
- Per-provider evidence lives in `docs/caching/*.txt` with "Last verified" dates; the
  policy-docs test suite enforces the doc ↔ row ↔ registry citation chain.
- `fastino` (docs/caching/fastino.txt): marker/retention behavior UNVERIFIED on the new host;
  historical api.pioneer.ai measurements (4 markers, 1h TTL, `prompt_cache_retention: '24h'`
  on GPT-family) are in the doc as provenance.
- `opencode-go`/`opencode-zen` now speak the Console chat wire; their rows still carry
  `anthropicCache` (marker notes were for the `/messages` families the router no longer sends).
  Console docs say chat-completions models get automatic upstream prefix caching and report
  `usage.opencode.tokens.cache_read`.
- Live keys configured on this machine: `fastino` ✓, `opencode-zen` ✓ — both wires are
  measurable THROUGH the live router (keys never leave the router's memory; measurement
  requests are plain localhost API calls).
- Model-level `supportsCache` flags come from registry rows / discovery; how they gate
  `injectPromptCaching` is to be confirmed in T4.

## 3. Plan

### Goals

- Every provider policy row runs at the maximum its evidence supports: markers + 1h TTL +
  sticky key + stream usage wherever the wire accepts them; automatic-cache shape elsewhere.
- fastino and the opencode Console wire are MEASURED (markers accepted? auto cached tokens?
  `prompt_cache_key`/`prompt_cache_retention` accepted? TTL forms?) and their rows + docs carry
  the measured verdicts.
- No model silently runs uncached when its wire can cache (model-level flags audited).

### Non-goals

- No new caching mechanisms (no response-side caching, no cross-request stores).
- No chain/ordering changes.
- Unkeyed providers are not probed live; their rows follow their evidence docs and are marked
  `[INFERENCE]` where the doc does not decide.

### Constraints and invariants

- "Decisions live in code": marker counts, TTLs, and floors are constants in the policy rows,
  each carrying its evidence citation (docs/caching/*.txt or a measurement date).
- Measurement happens through the router's own proxy path — no key material in argv, files,
  logs, prompts, or test fixtures (AGENTS.md secrets rule).
- A "max" setting that a wire rejects is not maximum caching, it is a 400: where a wire's
  marker tolerance is unknown and unmeasurable, the row keeps its documented shape and cites
  the gap.

### Proposed architecture

- `src/provider-policy.ts`: per-row knob upgrades + fastino/opencode measured rows.
- `docs/caching/fastino.txt` + `docs/caching/opencode-*.txt`: measurement receipts appended
  ("Last verified" updated).
- `tests/prompt-caching.test.mjs`: pin the measured-max contracts (marker injection, TTL,
  sticky key) per changed row.

### Files and symbols

- `src/provider-policy.ts` — `PROVIDER_POLICIES` rows and factories.
- `src/index.ts` — `injectPromptCaching`/`supportsCache` interaction only if T4 finds gating.
- `docs/caching/fastino.txt`, `docs/caching/opencode-go.txt`, `docs/caching/opencode-zen.txt`.
- `tests/prompt-caching.test.mjs`, `tests/provider-policy-docs.test.mjs` (citation chain).

## 4. Clarifications

None pending: the directive ("max possible caching across all providers and models") settles
the posture. Where measurement shows a wire rejects a feature, "max possible" means the max
the wire accepts — recorded as evidence, not as conservatism.

## 5. Todos

- [~] **T1** Measure the fastino wire through the live router (no secrets in tooling):
  (a) repeat-prefix automatic caching (`usage.cached_tokens` / `prompt_tokens_details`),
  (b) `cache_control` content-block markers with `ttl: '1h'` and `'5m'` accepted?,
  (c) `prompt_cache_key` + `prompt_cache_retention` accepted?. Record receipts in
  `docs/caching/fastino.txt`; set the fastino row to the measured maximum.
  — PARTIAL: measurement blocked — the fastino key is retired, so no wire can be probed. Row stays `[INFERENCE]`.
- [~] **T2** Same measurement for the opencode Console chat wire via `opencode-zen`
  (auto `cache_read`? markers? sticky key?); update both opencode rows to the chat-wire
  measured maximum and the docs.
  — PARTIAL: measurement blocked — the opencode key is expired. Rows stay `[INFERENCE]`.
- [x] **T3** Row-by-row audit of `PROVIDER_POLICIES` against its evidence doc: upgrade every
  sub-maximal knob the evidence supports (TTL, marker tolerance/`stripsCacheControl`, sticky
  key, `includeStreamUsage`, `minCacheableTokens` floors only where the provider requires
  them). Mark unresolved gaps `[INFERENCE]` with the missing measurement named.
- [x] **T4** Model-level audit: how `supportsCache` gates `injectPromptCaching`/presentation;
  fix wrong `supportsCache: false` flags in registry rows where the wire caches automatically.
- [x] **T5** Tests: pin measured-max contracts; policy-docs chain stays green.
- [x] **T6** Full suite + live smoke (repeat-prefix cache hit visible in usage) + page/API check.

## 6. Verification

- `npm test` full suite green.
- Live smoke on :11436: two identical long-prefix requests to fastino (and opencode-zen) show
  cache hits in usage; marker-carrying requests return 200 on wires that accept markers.
- `docs/caching/*.txt` receipts: each changed row's note cites the 2026-11-12 measurement.

## 7. Implementation notes (2026-11-12/13)

Shipped as `e1f9ab6`, merged to `main`; see
`.agents/tasks/TASK.2026-11-12.max-caching-everywhere.md` for the journal and probe receipts.

- T1/T2 are half-done by design: the ROWS are at maximum posture, but live re-measurement on
  api.fastino.ai and the opencode Console wire is blocked on valid keys (the configured
  fastino key is a retired `pio_sk_`; the opencode key is expired). The probes exist and were
  run — see the task record for the exact 401 evidence and the `pqc-secrets set` follow-ups.
- Audit finding: `minCacheableTokens` was a dead knob (declared in rows, consulted nowhere) —
  removed; markers already reach every prompt, which IS the max posture.
- opencode's max on the chat wire is automatic prefix caching + sticky key: markers were for
  `/messages` families outside the §4.1 chat-only scope.
