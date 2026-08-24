# TASK 2026-08-24 — fix/config-ui-ollama-compat

Branch: fix/config-ui-ollama-compat (worktree ../local-router-fix-config-ui, from develop)

## Chain-of-Draft

- VSCode fetches /api/version.
- Current: static "0.6.4".
- Root: fetch fail => error.
- Mirror real backend version.
- Dual-stack: bind ::1 too.
- Footer badge: hydrate live.
####

- Dropdown fed by /api/tags.
- Tags = curated served only.
- Live tags count: 7/1807.
- Toggled fallback models absent.
- Fix: source /api/model-curation.
- Same superset as validation.
####

- /api/show: chain config hidden.
- fallback-models API: ids only.
- Fix: chainDetails per member.
- ctx/output/tools/vision/ready.
- Show payload: local_router_chain.
- UI renders member configs.
####

- Provider Key Configs separate.
- Available Providers & Models separate.
- Merge into one card.
- Key status per group header.
- Configure button => key form.
####

## Audit

- No secrets in task/PRD.
- No crypto touched.
- TS native; no deps added.
####
