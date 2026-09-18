# TASK.2026-09-18.wafer-deepseek-discovery.md

- **Scope:** Resolve endpoint discovery logic to properly pull in latest and active models from providers like Wafer AI, including DeepSeek-V4.1-Flash.
- **Branch:** `fix/discovery-wafer-models`
- **Worktree:** `d:\Code\discovery-wafer-models` (branch `fix/discovery-wafer-models`)
- **Triage:** `now`
- **Status:** `completed`
- **Root Cause:**
  - `fetchLiveProviderModels` required a configured API key before attempting `/models` fetch, but Wafer AI (`https://pass.wafer.ai/v1/models`) hosts a public catalog.
  - When a dummy/invalid key (`test_wafer_persistence_key_123` from bundle) was sent, Wafer responded with HTTP 401; router did not retry unauthenticated and fell back to static curated catalog.
  - Curated catalog and model specifications did not include `DeepSeek-V4.1-Flash`.
  - Nested Wafer capability metadata (`wafer.capabilities.vision`, `wafer.capabilities.reasoning`) was not extracted by `mapLiveRawModelsToCatalog`.
- **Resolution:**
  - Added `isOpenCatalogProvider` helper allowing unauthenticated probing when `!key` on open catalogs (`wafer-serverless`, `commandcode`).
  - Added automatic unauthenticated retry on HTTP 401/403 for open catalog providers (`wafer-serverless`, `commandcode`, `openrouter`, `zenmux`).
  - Added Wafer metadata extraction in `mapLiveRawModelsToCatalog` (`wafer.context_length`, `wafer.max_output_tokens`, `wafer.capabilities.vision`, `wafer.capabilities.reasoning`, `wafer.capabilities.tools`, `serverless_only` tier mapped to `paid`).
  - Added `DeepSeek-V4.1-Flash` and alias `deepseek-v4.1-flash` to `PROVIDER_MODEL_REGISTRY`, `model-specs.json`, `provider-pricing.ts`, `routing-defaults.ts`, and `ZDR_ELIGIBLE_MODELS`.
  - Added fallback probe support in `.agents/skills/provider-models-list/scripts/probe.mjs`.
  - Added unit and mock-server integration tests in `tests/wafer-discovery.test.mjs`.
- **Verification:**
  - `npm run build`: cleanly compiles.
  - `npm test`: 153/153 passed (including wafer baseline, live probe, 401 recovery).
  - Live probe on test instance (port 11436): `POST /api/provider-models/wafer-serverless/refresh` returns `source: "live"`, `count: 14`, including `wafer-ai-deepseek-v4.1-flash`.

