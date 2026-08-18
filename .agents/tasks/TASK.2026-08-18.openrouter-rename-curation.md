# TASK.2026-08-18 — openrouter rename + endpoint model curation

## Task
Rename provider `openrouter-presets` → `openrouter` (presets stay private custom models,
user-input only). Port all endpoint models, search, curate. Install real ollama in WSL.

## Chain of Draft
- Presets never list. Custom names, user input.
- Rename slug. Keep legacy alias canonical.
- canonicalProviderSlug() shared by both modules.
- DEFAULT_PROVIDER_TIER_ORDER last entry openrouter.
- Prefix map: both slugs map openrouter.
- Upstream aliases extended. Legacy keys kept.
- Persisted provider models: canonicalize then merge.
- Config API canonicalizes :provider params.
- Curation: curationEnabled, curatedEndpointModelKeys.
- Key format provider::model. Max 5000.
- applyEndpointCuration gates endpoints catalog.
- Empty selection serves nothing. Intentional.
- GET /api/model-curation returns groups.
- PUT validates enabled plus keys.
- /v1/models and /api/tags both filtered.
- Providers page: toggle, search, select shown.
- Clear all, save curation buttons.
- loadCatalog branches per source mode.
- loadModelSource ends with loadCatalog.
- Restart persistence verified integration test.
- ollama.com tarball 404. GitHub release v0.32.14.
- User-level install. No curl|sh. No sudo.

#### 
Deliverables: providers.txt rename + alignment, src/index.ts canonical slug + curation
pipeline + config, routing-exhaustion-order.ts canonical banding, config-api.ts
GET/PUT /api/model-curation + canonicalized provider routes, ui providers.ts curation
controls, ui layout.ts port-all/search/curate logic, tests routing-exhaustion-order +
model-curation integration, llms.txt rename + curation docs, SKILL.md + probe.mjs slug,
this task file. Legacy slug accepted everywhere via alias. No secrets in any file.

#### 
Audit: gates npm run build + validate:model-specs + npm test; smoke on spare port —
openrouter naming, presets served, refresh ports, curation filters, ollama backend,
PQC keys; merges feat → develop → main with gates each hop.
