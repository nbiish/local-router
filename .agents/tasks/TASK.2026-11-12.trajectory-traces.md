# TASK.2026-11-12 — Trajectory traces + fallback-chain health analysis (DeepSeek-harness capture)

- Machine: mac (darwin arm64), checkout `/Volumes/1tb-sandisk/code-external/local-router`
- Branch: `feat/trajectory-traces` (worktree `../local-router-trajectory-traces`, off `main`)
- Plan: `.agents/plans/2026-11-12-trajectory-traces.plan.md`
- Status: done

## Objective

Analyze how the DeepSeek harness captures trajectories/traces, replicate the pattern inside
local-router, and expose a page + agent-readable log for detecting a fallback-chain
provider/model that is no longer working right or is being silently skipped.

## DeepSeek harness capture analysis (source: `~/.deepseek`, `~/.deepseek/state.db`)

- `sessions/<uuid>.json`: one record per conversation — `schema_version`, metadata rollups
  (message_count, total_tokens, cost breakdown, cumulative turn seconds), full typed message
  trajectory (`text` / `thinking` / `tool_result` blocks), `system_prompt`.
- `tool_outputs/` + `sessions/<id>/artifacts/`: large tool outputs spill out-of-band; the
  message keeps a `TOOL_OUTPUT_RECEIPT` (status, elapsed, output size, `detail_handle: sha:<hex>`,
  `retrieve: … ref=sha:<hex>`) — content-addressed retrieval without bloating the record.
- `state.db`: `threads` / `messages` / `checkpoints` / `jobs` — indexed per-thread history;
  `tasks/runtime/{threads,items,events,turns}` — event-sourced thread→turn→item→event layout.

## Changes (worktree `feat/trajectory-traces`)

1. `src/trajectories.ts` (new): `TrajectoryRecord` (schema_version 1) — request summary
   (modalities, tool count, prompt hash; binary payloads redacted), chain snapshot
   (configured vs excluded-with-reason vs eligible), ordered stage timeline
   (answered/failed/skipped, skip reason, errorType, status, retry waits, ms), result
   (winner, usage, cost), `sha:` receipts with 400-char previews; store = append-only JSONL
   `~/.config/local-router/trajectories/trajectories.jsonl` (2000-record bound, compaction
   drops unreferenced spill files) + `spill/<sha256>.txt`; `analyzeTrajectories()` per-chain
   model health with flags `never_answers`, `always_skipped`, `recent_error_spike`,
   `missing_from_plan`; `TrajectoryTracker` flushed via `LogEntryTracker.onFinish`.
2. `src/expert-logs.ts`: `LogEntryTracker.onComplete` hook (single flush point, no error path lost).
3. `src/index.ts`: capture in `handleChatCompletion` (direct, direct→system-cascade,
   `executeFallbackRoute` — chain exclusions incl. `disabled_toggle` / `no_configured_key`,
   every attemptLog event + the answered stage), `handleEmbeddingRequest` (same record shape).
4. `src/routes/config-api.ts`: `GET /api/trajectories` (+`?route=&outcome=&limit=&since=`),
   `GET /api/trajectories/health`, `GET /api/trajectories/:id` (+`?part=request|response|thinking|toolCalls`),
   `GET /api/trajectories/export` (raw JSONL), `DELETE /api/trajectories`; `GET /config/trajectories`.
5. `src/ui/pages/trajectories.ts` (new) + `src/ui/pages/layout.ts`: page (agent docs, chain-health
   table with flag badges + reasons, expandable stage timelines, filters, export/clear), nav link.
6. `tests/trajectories.test.mjs` (7 tests, added to `test:integration`) + `llms.txt` capability
   and test bullets.

## Verification

- `npm test` (full 373-test suite): green except `custom-provider CRUD, chat routing, and delete
  guards` — pre-existing, fails identically on main's untouched build (model-echo mismatch
  `ok:test-vendor-demo` vs `/ok:vendor-model-1/`), out of scope.
- Live smoke on develop port 11436 (real chain, real keys): 2 `local-router/fallback-models`
  completions (HTTP 200 via `cursor/auto`), trajectory records with 35-stage timelines,
  receipts (`?part=response` returns the answer), raw JSONL on disk.
- Browser screenshot of `/config/trajectories`: hero + docs + chain-health table rendering.
  Smoke immediately found real chain breakage: `upstream_http_auth` on cline-deepseek/zenmux-glm
  free tiers, `upstream_http` on xiaomi-mimo — 7 members flagged `never_answers`.
- Bug found and fixed during verification: `missing_from_plan` false-flagged healthy chain
  members planned after the winner; now only flags members never eligible/excluded/executed.

## Findings

- The old `attemptLog` only surfaced on total exhaustion and never survived success — the
  "which member answered / was skipped / is dead" question was unanswerable after the fact.
- Models dropped pre-plan (`activeFallbackModels` key filter, disabled toggles) were completely
  invisible in logs — exactly the silent-skip bug class this task targets.

## Worktree journal

- branch `feat/trajectory-traces` cut from `main` @ 706bb78 (2026-11-12); feature commit
  `daf1ad8` (2026-11-12T14:56:08-05:00, author: operator git profile), merged into `main`
  as `f9e352c` (no-ff). `git log main..feat/trajectory-traces` empty; diffstat 9 files,
  1687 insertions / 4 deletions — matches the Changes list above. Worktree removed,
  branch deleted (`was daf1ad8`).
