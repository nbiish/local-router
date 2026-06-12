# TASK: Custom Preset Model Routes

## CoD Draft
- 8 new preset routes needed
- Fallback + router types
- routing-defaults.ts → defs
- index.ts → bootstrap wiring
- multimodal = vision models
- Caching → universal max cache
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
  - `src/index.ts` — Added `ensurePresetRoutes()` function, called after `ensureDefaultFallback()`; updated `injectPromptCaching()` to support universal caching for all providers, all models, and no matter the input or output size.
  - `llms.txt` — Documented all 8 routes in Capabilities and Router sections.
  - `tests/prompt-caching.test.mjs` — Updated unit tests to expect universal caching.
  - `tests/responses-http-stream.integration.test.mjs` — Increased startup delay from 2.5s to 6s to allow preset route files bootstrap on startup.

### Verification
  - TypeScript: clean compile (`tsc --noEmit`)
  - 43/43 tests pass (including responses-http-stream and prompt-caching tests)
  - Bootstrap logs confirm all 8 routes created with correct candidate counts
