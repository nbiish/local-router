# TASK: Fallback Bootstrap — Inventory-Scoped Resolution

Classification: Confidential. No secrets.

## Chain-of-Draft

- Production: no system chain.
- Curated keys = 0.
- Serving catalog: ollama-only.
- findProviderModel: serving-scoped.
- Defaults unresolved → skip.
- Bootstrap guard fired.
- Fix: inventory-scoped lookup.
- allCatalogModels = serving ∪ cache.
- Bootstrap + validation + toggle widened.
- Repro test: zero curated keys.
- 83/83 pass.

####

## Change

- `src/index.ts`: new `findCatalogModel()` (identical lookup over `allCatalogModels()` — serving catalog ∪ endpoint cache). Used by `resolvedDefaultFallbackModels()`, `validateFallbackReferences()`, and exposed via `configApiDeps` for `POST /api/fallback-chain/toggle`.
- `src/routes/config-api.ts`: `findCatalogModel` dep (interface + destructure); toggle handler uses it.
- Execution semantics unchanged: serving catalog (`findProviderModel`) still governs request-time resolution; unknown/unkeyed chain steps skip at runtime.
- `tests/fallback-default-bootstrap.test.mjs`: reproduction — zero curated keys + seeded cache → system chain still bootstraps; cache-known-but-unserved model toggles into `free`.
