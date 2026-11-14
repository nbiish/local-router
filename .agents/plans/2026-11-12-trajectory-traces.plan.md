# Plan — Trajectory/trace capture + fallback-chain analysis page (2026-11-12)

## 1. How the DeepSeek harness captures trajectories/traces (analysis)

Analyzed `~/.deepseek` (the DeepSeek agent harness home) and `~/.deepseek/state.db`:

| Mechanism | What it captures | Reusable idea |
|---|---|---|
| `sessions/<uuid>.json` | One file per conversation: `schema_version`, `metadata` (id, title, timestamps, `message_count`, `total_tokens`, model, workspace, `cost` breakdown, `cumulative_turn_secs`), `messages` (full trajectory: typed content blocks `text` / `thinking` / `tool_result`), `system_prompt` | Whole trajectory as one inspectable record with rollup metadata |
| `tool_outputs/`, `sessions/<id>/artifacts/art_call_*.txt` | Large tool outputs spill out-of-band; the message keeps a receipt: `TOOL_OUTPUT_RECEIPT { tool, tool_call_id, status, exit_status, elapsed, output: <size>, truncation, detail_handle: sha:<hex>, retrieve: retrieve_tool_result ref=sha:<hex> }` | Content-addressed spill: record stays small, payload retrievable by sha handle |
| `state.db` (SQLite) | `threads` (rollout_path, model_provider, status, git sha/branch, cwd), `messages` (role, content, `item_json`), `checkpoints` (`state_json`), `jobs` | Per-thread indexed history; item-level JSON beside display content |
| `tasks/runtime/{threads,items,events,turns}` | Event-sourced runtime decomposition: thread → turns → items → events | Trajectory = ordered stages/events, not just a summary row |
| `sessions/checkpoints/`, `snapshots/`, `audit.log` | State snapshots + audit trail | Append-only audit of what happened |

Key properties to replicate: (a) one record per request carrying the **full ordered stage
trajectory** (every attempt, skip, and reason), (b) metadata rollups (tokens, cost, duration),
(c) receipts with content-addressed spill for large payloads so agents can read the log without
wading through huge blobs, (d) machine-readable on-disk log agents can grep directly.

## 2. Gap in local-router today

- `expert-logs.json` records one row per request (winner only). The cascade's per-stage
  `attemptLog` (skip reasons, per-stage errors, retries) is returned in the *error body* on total
  exhaustion and then lost on success — so "which chain member answered / was skipped / is dead"
  is unanswerable after the fact.
- Models dropped **before** the plan (`activeFallbackModels` key-presence filter, disabled
  toggles) are invisible entirely — exactly the "skipping providers/models for some reason" bug
  class the operator wants to detect.
- No UI surface analyzes fallback-chain health over time.

## 3. Design

### 3.1 `src/trajectories.ts` (new)

- `TrajectoryRecord` (`schema_version: 1`): id, timestamps, client, presentedModel, routeKind
  (`direct` | `fallback` | `direct+cascade`), routeId, request summary (stream, modalities,
  toolCallsRequested, messageCount, promptHash), `chain` (configuredTargets incl. exclusion
  reasons `{model, reason: no_configured_key | disabled | <capability skip>}`, eligibleTargets,
  requiredContext, requiresMultimodal, planStageCount), `stages[]` (stage, targetModel,
  provider, actualModel, attempt, stageAttempts, outcome `answered|failed|skipped`, skipReason,
  errorType, status, ms, waitBeforeRetrySeconds, providerErrorPreview), `result` (status,
  answeredBy, errorType/Message, usage, cost), `receipts` (`sha:` handles + byte sizes for
  request body / response content / thinking when above a threshold).
- Store: append-only JSONL `~/.config/local-router/trajectories/trajectories.jsonl`
  (0600, agents can `grep`/`tail` it), spill payloads in `trajectories/spill/<sha256>.txt`.
  Bounded: 2000 records, compaction rewrites the JSONL and drops unreferenced spill files.
  `LOCAL_ROUTER_TRAJECTORY_LOG=0` disables; `LOCAL_ROUTER_TRAJECTORY_DIR` overrides for tests.
- `analyzeTrajectories()` per route (chain): stage health (planned/answered/failed/skipped counts,
  errorType + skipReason breakdowns, answerRate, lastError/lastSeen) and anomaly flags:
  `never_answers` (≥3 planned observations, 0 answers), `always_skipped` (skipped every time
  planned; dominant reason), `missing_from_plan` (configured in chain, never executed),
  `recent_error_spike` (failure rate last 20 vs prior window).

### 3.2 Capture hooks (`src/index.ts`)

- `TrajectoryTracker` created in `handleChatCompletion` beside `LogEntryTracker`; finished via an
  `onComplete` hook on `LogEntryTracker.onFinish` (single integration point, no missed
  error paths) — usage/cost/content/thinking reuse the expert-log parsing already done there.
- `executeFallbackRoute`: record chain snapshot (configured vs eligible vs excluded-with-reason),
  mirror every `attemptLog` push into the tracker, and record the answering stage on success
  (currently absent from attemptLog).
- Direct model path: one stage; direct→system-fallback cascade: direct attempt stage + fallback stages.
- Embeddings: mirror the existing `attempts` array + winner into a light record (same schema,
  `routeKind: 'fallback'`/`'direct'`).

### 3.3 API (`src/routes/config-api.ts`)

- `GET /api/trajectories?limit=&route=&outcome=&since=` — summaries (no spilled payloads).
- `GET /api/trajectories/health` — `analyzeTrajectories()` output.
- `GET /api/trajectories/:id` — full record; `?part=request|response|thinking` resolves spill.
- `GET /api/trajectories/export` — JSON attachment; `DELETE /api/trajectories` — clear.

### 3.4 UI (`src/ui/pages/trajectories.ts`, nav in `layout.ts`)

`/config/trajectories` — chain-health table (model × planned/answered/failed/skipped + flag
badges), recent-trajectory table with expandable stage timeline (every skip reason visible),
filters (route, outcome), export/clear. Same render/API-fetch conventions as `efficiency.ts`.

### 3.5 Docs

`llms.txt` capability bullet; page links from the fallback page help text only if natural.

## 4. Verification

- `tests/trajectories.test.mjs`: store round-trip (JSONL append + reload), skip/missing-stage
  recording, `never_answers` / `always_skipped` / `missing_from_plan` flags, spill receipt +
  retrieval, pruning. Run via `npm run build && node --test` (existing convention: tests import
  `../build/*.js`).
- Live smoke on `develop` port (11436): one direct call + one exhausted-chain call, then
  `GET /api/trajectories` + `/health` prove the stages and flags; page renders.

## 5. Out of scope

Decisions API provenance (already has its own `attempts` reporting); `router-events.csv`
telemetry (separate legacy surface); cross-machine shipping of traces.
