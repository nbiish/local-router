# TASK 2026-08-20 — Per-provider model curation

## Read
- User: key saved → fetch models.
- Toggle list under each provider.
- Only toggled models serve discovery.
- Existing: endpoints mode, curated keys.
- applyEndpointCuration gates /v1/models.
- Missing: per-provider refresh, UI, auto-fetch.

####

## Design (user-approved)
- Toggle default: pre-check catalog matches.
- Activation: auto on first save.
- PUT /api/model-curation gains activate flag.
- New POST /api/provider-models/:p/refresh.
- POST /api/keys auto-discovers (best-effort).
- Ollama exempt from curation (local backend).

####

## Execute — server
- fetchProviderEndpointModels: dedupe map.
- mergeProviderEndpointModels: replace section.
- seedCurationDefaultsForProvider: catalog matches.
- ensureCurationDefaultsForCache: all untouched.
- refreshProviderEndpointModels: compose three.
- applyEndpointCuration: keep ollama always.
- configApiDeps: export new helpers.

## Execute — API
- POST refresh: 404 unknown, timeout 20s.
- POST /api/keys: discovered {count, seededCount}.
- PUT curation: activate → source + enabled + seed.
- Skip OAuth providers in auto-discover.

## Execute — UI
- Provider cards: live-models collapsible block.
- Badges: total N, selected S.
- Per-provider: search, checkboxes, refresh, save.
- Save merges keys, activate on first save.
- saveKeys success → show discovered, expand list.

## Verify
- tsc clean; 113+ tests pass.
- :11436 smoke: refresh ollama, curation round-trip.
- /v1/models gated; ollama still served.
- Page scripts parse (node --check).

## Audit
- No new secrets surfaces; PQC untouched.
- No banned crypto. No secrets in task file.
- Template literal: no unescaped backslashes.
