# TASK.2026-11-12 — Fallback-system logic corrections (health-aware chain execution) + error-class visibility

- Machine: mac (darwin arm64), checkout `/Volumes/1tb-sandisk/code-external/local-router`
- Branch: `feat/fallback-logic-corrections` (worktree `../local-router-fallback-logic`, off `main` @ f9e352c)
- Plan: `.agents/plans/2026-11-12-fallback-logic-corrections.plan.md` (clarifications §4.1–§4.3 resolved by operator 2026-11-12)
- Status: done (T7 operator key action pending — see below)

## Objective

Stop the fallback chain burning ~34 dead stages per request on members that cannot answer;
make usage errors and API-key out-of-funds errors first-class on the trajectories page and
`/api/trajectories/health` so the operator and agents can review and iterate.

## Worktree journal

- Branch `feat/fallback-logic-corrections`, cut 2026-11-12 from `main` @ f9e352c.
- Commit `90295d6` `feat(fallback): health-aware chain execution and error-class visibility`
  (author `Nanoboozhoo - embodies by omp <nanoboozhoo@local>` per AGENTS.md rule 4).
- Diffstat: 11 files, +769/−51; new `src/health-registry.ts`, `tests/health-registry.test.mjs`.
- Merge commit `056e13d` `merge: feat/fallback-logic-corrections — health-aware chain
  execution + error-class visibility` into `main` 2026-11-12.
- Landing proof: `git log main..feat/fallback-logic-corrections` empty; diffstat matches;
  worktree removed and branch deleted (refused-free `git branch -d`, was 90295d6).

## Operator decisions (2026-11-12, recorded in plan §4)

- §4.1 per-class thresholds: key_rejected/out_of_funds 1 strike × 30 min; usage_limit/
  usage_error/transient 3 consecutive × 5 min; any success clears.
- §4.2 force-try quarantined members as a last pass (refined in code: only members the
  request never attempted — re-hammering a fresh failure is what the cooldown exists to stop).
- §4.3 four stable error classes — key_rejected, out_of_funds, usage_limit, usage_error —
  counts + flags on the page and JSON.

## What changed

- `src/health-registry.ts` (new): chain-scoped `FallbackHealthRegistry` — `recordOutcome`,
  `mayAttempt`, `quarantined`, `snapshot`; in-memory, re-derivable, bounded expiry;
  `LOCAL_ROUTER_HEALTH_DISABLE=1`, `LOCAL_ROUTER_HEALTH_COOLDOWN_AUTH_MIN` (30),
  `LOCAL_ROUTER_HEALTH_COOLDOWN_RETRY_MIN` (5).
- Health wiring is eager at stage resolution (`recordStageOutcome` in `executeFallbackRoute`
  and the embedding loop), not at `TrajectoryTracker.finish`: a failure must quarantine
  BEFORE the wraparound re-enters the member later in the same request (deviation from the
  plan's §3 "finish call sites" wording, needed for T3's goal; trajectory log stays
  observational).
- `classifyHttpFailure` corrected: 402 → `upstream_http_payment_required`, 429 →
  `upstream_http_rate_limit` (body `insufficient_quota|balance|billing|payment|credit…` →
  payment_required BEFORE quota), 413 → `upstream_http_invalid_request`; body
  `api_usage_error|unknown model|context_length…` → invalid_request. The old mapping made
  `upstream_http_payment_required` dead code and collapsed out-of-funds into quota.
- `buildEscalatingWraparoundPlan(models, { skipRevisitsFor })`: wraparound revisits of
  quarantined members omitted; mid-request quarantine hits the `fallbackStagePreflight`
  registry consult (`cooldown:<errorType>` skip entries, `health_cooldown` errorType).
- §4.2 force-try tail in `executeFallbackRoute` (and embedding candidate ordering):
  `forced`/`forcedAfterQuarantine` markers in trajectory stages and attempt logs.
- Analysis (`analyzeTrajectories`): `ModelHealth.errorClasses` + class flags
  (`count >= 2` or last-error class); page renders an "Error classes" column and
  `quarantined` badges; `/api/trajectories/health` and `health.json` gain `chainHealth`.
- T4 root cause (NOT the plan's guessed upsert/resolution order): `localLoopbackRegisteredModels`
  rebuilt rows with `id = defaultPresentedModelName(...)`, and `providerCatalogModels`'s
  unconditional `byKey.set` overwrote the custom-editor override — the presented alias then
  missed `findProviderModel` and the raw `split('/')` path forwarded the alias upstream.
  Fixed by preferring the toggle-store override (id + specs) in the loopback row.
- `LogEntryTracker.onFinish` idempotent (double flush appended one expert entry per call).

## Verification

- Full suite `npm test`: 380 tests, 368 pass, 12 skipped (sandbox/network-gated), 0 fail —
  including `tests/custom-providers.integration.test.mjs`, the plan's known pre-existing
  failure, now green.
- New `tests/health-registry.test.mjs` (13 cases: classification, thresholds, streak reset,
  expiry, chain scoping, snapshot, kill-switch) + execution-plan revisit-gating cases +
  error-class aggregation cases in `tests/trajectories.test.mjs`; classifier contract tests
  updated to the corrected mapping (429→rate_limit etc.).
- Live smoke on :11436 (16/16 checks): dead member hits its upstream exactly once, next
  request records `skipReason: cooldown:upstream_http_auth` with zero upstream calls;
  mid-request wraparound revisits cooldown-skipped (not re-attempted); force-try runs only
  for never-attempted quarantined members; `chainHealth`/`errorClasses`/flags verified via API.
- Browser screenshot of `/config/trajectories` on :11436: key_rejected + out_of_funds +
  quarantined badges and the Error classes column render per member.
- Live deploy: `main` @ 056e13d rebuilt, daemon kickstarted (old orphaned PID 12527 had to
  be SIGTERMed — `launchctl kickstart -k` left it holding :11434 while the job showed
  "not running"); new PID 50004 serves `/api/trajectories/health` with `chainHealth` and
  error classes over the existing history.

## T7 — operator key action (blocked on operator)

Live history now names the stale keys precisely: `key_rejected` counts on
`cline-deepseek-deepseek-v4-flash-free` (×18), `zenmux-glm-5.3-free` (×14),
`antigravity-gemini-3.7-flash` (×10), `openrouter-ernie-5.5-flash-preview-free` (×4).
Refreshing needs new key material from those providers (pqc-secrets `set`); flags clear on
fresh trajectories after that. `zai-glm-5.3-flash` and `cursor-deepseek-v41-flash-1017` are
`never_answers` without a key_rejected class — worth a raw-log look at their errorTypes.
