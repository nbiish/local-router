# TASK: Router Preset Cleanup — Combine/Remove

## CoD Draft
- 6 preset routes → 4
- Drop preferred-text/multimodal
- Merge performance-text+multimodal
- Merge low-cost-text+multimodal
- Update llms.txt both spots
- Test + smoke
####

## Goal
Simplify the local-router preset route set per operator direction.

## Changes

### `src/routing-defaults.ts` — `PRESET_ROUTER_ROUTES`
- **Remove** `preferred-text` (14 candidates, minCoding=0.85, q=9) — rationale: the curated local-router candidate set IS the preferred set; the explicit route is redundant.
- **Remove** `preferred-multimodal` (12 candidates, minCoding=0.84, q=9) — same rationale.
- **Replace** `performance-text` + `performance-multimodal` with a single `performance` route. Union of both candidate lists, deduped, preserves `minCodingScore=0.88`, `costQualityTradeoff=10`. 15 unique candidates (multimodal list is a strict subset of text list).
- **Replace** `low-cost-text` + `low-cost-multimodal` with a single `low-cost` route. Union of both candidate lists, deduped, preserves `minCodingScore=0.75`, `costQualityTradeoff=2`. 16 unique candidates.

### `llms.txt` — Preset routes
- Update Capabilities bullet list (lines 19-24) — remove 4 entries, add 2.
- Update Preset Routes table (lines 588-593) — same.

## Files Modified
- `src/routing-defaults.ts`
- `llms.txt`

## Verification
- `npm run build` — clean tsc compile
- `npm test` — 68/69 pass (1 pre-existing failure on `main` baseline: provider-keys integration test about NVIDIA ordering — unrelated to this change)
- Smoke test on `:11436`:
  - `[router] Removed obsolete preset router` for all 6 obsolete IDs (logged at startup)
  - `[PQC] Loaded 15 provider key(s) from bundle` — PQC bundle intact
  - `/v1/models` shows 6 `local-router/*` IDs (auto-router-main, fallback-models, multimodal, nanoboozhoo, performance, low-cost) — no obsolete IDs
  - `/api/router-models` shows 4 router routes: auto-router-main (66), nanoboozhoo (64), performance (15), low-cost (16)
  - `/api/fallback-models` shows 2 fallback routes: fallback-models (20), multimodal (16)
  - No errors in log

## Migration
Added `OBSOLETE_PRESET_ROUTE_IDS` constant in `src/routing-defaults.ts` and a deletion loop at the top of `ensurePresetRoutes()` in `src/index.ts` to remove persisted routes matching the obsolete IDs. This converges the persisted `router-models.json` / `fallback-models.json` to the current preset set on next startup. List is additive-only — once an ID is added, never remove it.
