# TASK 2026-08-20 — Retire providers.txt model table

## Read
- User: toggle system supersedes static catalog.
- User picked: keep file summary-only;
  migrate rows pre-checked; remove mode switch.
- providers.txt: 638 lines, 118 model rows,
  4 sections (summary/caching/details/matrix).
- modelStore overrides: persisted custom edits.
- catalogMigrationVersion absent in loader →
  re-migration bug (fixed).

####

## Design
- providers.txt: model rows stripped, note added.
- providers.legacy-catalog.txt: frozen full copy.
- readProviderModels → legacy file (seed only).
- Toggle store = only catalog:
  endpoint-models-cache + curated keys.
- Migration v1 (boot, once): legacy rows ∪
  overrides → cache, ALL pre-checked,
  source=endpoints, curation on.
- effectiveProviderModels: overrides || curated
  section; ollama exempt.
- rawProviderCacheModels: unfiltered (discovery UI).
- Serving: applyEndpointCuration(store ∪ overrides).
- endpointCurationActive: always true.
- Mode switch UI/API removed; PUTs normalized.
- seedCuration compares cache not legacy file.

## Execute
- index.ts: migration, accessors, mode fns, boot.
- config-api: model-source normalize, curation pin.
- providers.ts: radios → refresh button.
- layout.ts: single-mode loadCatalog, shim.
- loader: persist + read migrationVersion.

## Verify
- tsc clean each pass.
- Fresh HOME: 118 migrated pre-checked.
- Upgrade HOME: custom/off → endpoints/on,
  906 selected; zai 5, cline 16 served prefixed.
- Toggle-off: /v1/models + /api/tags parity.
- Restart: no re-migration; selection persists.
- Page scripts parse; radios gone.

## Audit
- No secrets in code/task/PRD.
- PQC bundle untouched; keys still env/bundle.
- No banned crypto.
- Skills model-add/model-remove need
  post-merge providers.txt doc updates.
