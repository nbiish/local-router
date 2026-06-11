# TASK: Ollama Proxy Model Filtering

## Problem
- Ollama-compatible endpoints (`/v1/models`, `/api/tags`) expose ALL catalog models (~110+) regardless of whether the user has configured keys for those providers.
- Clients like Hermes see every model but can only use the ones with keys.

## Goal
- Filter proxy model lists to only show providers with configured keys/OAuth.
- Ollama provider always passes (local backend).
- Fallback models and router models always show.
- Config UI (`/config`) still shows the full unfiltered catalog for management.
- Add a toggle in config UI to optionally show ALL models (for users who want the current behavior).

## Plan
1. Extend `modelSourceConfig` with `filterConfigured: boolean` (default `true`).
2. Add `filterConfiguredModels()` helper — filters provider models by key presence.
3. Update `/v1/models` and `/api/tags` to apply filtering.
4. Persist/load `filterConfigured` to `model-source-config.json`.
5. Add `GET/PUT /api/model-source` extension for `filterConfigured`.
6. Add config UI toggle on providers page.
7. Build + smoke test on :11436.

## Branch
`feat/ollama-proxy-model-filtering` in worktree `../fvs-code-ollama-proxy`

## Audit
- No secrets touched.
- No crypto changes.
- No banned algorithms.

####

## Execution

### Changes Made

1. **`src/index.ts`:**
   - Added `filterConfigured: boolean` to `modelSourceConfig` (default `true`).
   - Added `filterConfiguredModels()` helper — filters provider models by key presence; fallback/router models always pass; ollama always passes.
   - Updated `/v1/models` and `/api/tags` to apply `filterConfiguredModels()`.
   - Added `created` Unix timestamp to `openAIModelEntry()` — this was the root cause of Hermes not displaying models.
   - Updated `loadModelSourceConfig()` and `persistModelSourceConfig()` to handle `filterConfigured`.

2. **`src/routes/config-api.ts`:**
   - Extended `GET /api/model-source` to return `filterConfigured`.
   - Extended `PUT /api/model-source` to accept `filterConfigured` boolean.
   - Added `filterConfiguredModels` to `ConfigApiDeps` interface and destructuring.

3. **`src/ui/pages/providers.ts`:**
   - Added checkbox toggle: "Only show models from configured providers in Ollama proxy".

4. **`src/ui/pages/layout.ts`:**
   - Added `filterConfigured` state sync in `loadModelSource()`.
   - Added `setFilterConfigured()` handler.

### Verification (port 11436)
- `/v1/models` now includes `created` timestamp field.
- `filter_configured: true` present in response.
- `/api/tags` also applies filtering.
- `PUT /api/model-source` toggles `filterConfigured` correctly.

### Next Step
Restart the main server on port 11434 from the worktree build so Hermes picks up the `created` field fix.
