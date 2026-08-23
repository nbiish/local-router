# TASK 2026-08-23 — headroom 0.36.5 + per-provider caching docs

## Chain-of-Draft
- headroom-ai 0.22.4 stale
- latest = 0.36.5 (2026-08-22)
- compress API unchanged
- upgrade, pin ^0.36.5
- build pass, 9/9 tests pass
- caching audit → 21 providers
- 4 research agents → docs/caching/*.txt
- cite sources, date-stamp
- llms.txt changelog entry

## Deliverables
1. `package.json` headroom-ai `^0.22.4` → `^0.36.5`
2. `package-lock.json` regenerated
3. `docs/caching/<provider>.txt` — 21 files, one per provider: mechanism, max TTL, breakpoints, thresholds, pricing, recipe, local-router integration, sources
4. `llms.txt` changelog entry

####

## Status
- headroom 0.36.5 installed; tsc clean; headroom tests 9/9 pass
- 21 docs/caching/*.txt written, source-cited
- llms.txt changelog entry added
- Smoke: /api/headroom-config GET/PUT live on :11440 pass
- Committed on chore/headroom-caching-docs; awaiting merge confirm
