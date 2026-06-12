# TASK: Custom Preset Model Routes

## CoD Draft
- 8 new preset routes needed
- Fallback + router types
- routing-defaults.ts → defs
- index.ts → bootstrap wiring
- multimodal = vision models
####

## Deliverables

Added 8 preset model routes alongside existing `fallback-models` and `auto-router-main`:

### Fallback Routes (1)
- **`local-router/multimodal`** — 16 vision-capable models in fixed retry order

### Router Routes (7)
- **`local-router/preferred-text`** — 14 candidates, quality=9, minCoding=0.85
- **`local-router/preferred-multimodal`** — 12 candidates, quality=9, minCoding=0.84
- **`local-router/performance-text`** — 15 candidates, quality=10, minCoding=0.88
- **`local-router/performance-multimodal`** — 8 candidates, quality=10, minCoding=0.88
- **`local-router/low-cost-text`** — 12 candidates, quality=2, minCoding=0.75
- **`local-router/low-cost-multimodal`** — 8 candidates, quality=2, minCoding=0.75
- **`local-router/nanoboozhoo`** — 64 candidates (full superset), quality=10, minCoding=0.86

### Files Modified
- `src/routing-defaults.ts` — Added `PRESET_FALLBACK_ROUTES`, `PRESET_ROUTER_ROUTES`, `buildPresetRouterCandidatesText()`
- `src/index.ts` — Added `ensurePresetRoutes()` function, called after `ensureDefaultFallback()`
- `llms.txt` — Documented all 8 routes in Capabilities and Router sections

### Verification
- TypeScript: clean compile (`tsc --noEmit`)
- 25/25 routing tests pass
- 6/7 integration tests pass (1 pre-existing failure on main)
- Bootstrap logs confirm all 8 routes created with correct candidate counts
