# TASK 2026-08-20 — Remove providers.txt; factual registries

## Read
- User: remove providers.txt completely.
- User: not all models visible (zai).
- User: document factual per-provider query
  info, paid AND free; user always
  chooses toggles.
- Only summary table machine-parsed before;
  caching/details/matrix were docs-only.
- 20 provider rows extracted.
- Migration v1 already applied everywhere.

####

## Execute
- src/provider-registry.ts: 20 providers
  in code; commandcode base fixed to
  /provider/v1 (live-verified).
- Deleted providers.txt, legacy-catalog,
  crx-validate, crx-aggregate, workflow.
- readCatalogProviderSummaries → registry.
- readProviderModels deleted; spec baseline
  = store section.
- Seed v2: registry unions into store;
  pre-check only never-seen keys.
- Registry rebuilt from live captures:
  kilo 368, nous 373, zenmux 164, pioneer
  89, commandcode 58, nvidia 102, opencode
  zen 64/go 29, wafer 5; docs tables for
  moonshot/xiaomi/nebius/copilot/gemini/
  modal; zai 9 live ids (has models API —
  removed from no-list set); cline stays
  curated (404 verified, no public list).
- Tier + sourceUrl plumbed ProviderModel →
  UI; tier badges on toggle rows.
- Fallbacks return registry∪cache enriched.
- Tests/scripts/probe read build modules.
- SKILL.md + llms.txt 20h row updated.

## Verify
- tsc clean.
- Full suite running (job bash-4).
- Worktree smoke: fresh HOME seed v2,
  pre-checked catalog, /v1/models parity.

## Audit
- No secrets; public catalog data only.
- Banned crypto: none.
