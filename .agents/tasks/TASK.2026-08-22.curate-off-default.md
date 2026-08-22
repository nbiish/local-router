# TASK 2026-08-22 — Off-by-default curation + provider UX

## Read
- User: save toggled state; scroll each
  provider; refresh/key => all OFF; per-
  provider search; pick few.
- Safety pre-select fought contract
  (loadCatalog + toggleCuration).
- Management EMPTY after auto-off:
  effectiveProviderModels curated-only.
- Refresh-all DESTROYED sections on
  fetch exceptions (pre-existing).

####

## Execute
- Backup: curation-backups/ config+cache
  1821 keys (manual snapshot 110454).
- deselectProviderCurationKeys + 25-file
  rolling snapshot, deselectAll wrapper.
- refreshProviderEndpointModels: seed ->
  deselect (deselectedCount API shape).
- key-save + Refresh All: same contract.
- knownProviderModels for providerConfigs;
  customCatalogModels -> allCatalogModels;
  catalogModelsForMode custom branch fixed.
- GET /api/provider-models/:provider ->
  known surface (mgmt). v1/models gating
  untouched.
- mergeProviderEndpointModels per-provider
  in refresh-all (section-preserving).
- UI: .provider-group .model-list 360px
  scroll; per-provider search w/ caret
  restore; pre-selects deleted; messages.

## Verify
- tsc clean; suite 114/114.
- Live probe: seed 1401 -> refresh-all
  1760 ported, 1401 deselected; custom/all
  1815; openrouter mgmt 421, served 0.
- Backup files round-trip in harness test.

## Audit
- No secrets; snapshots 0600 local-only.
