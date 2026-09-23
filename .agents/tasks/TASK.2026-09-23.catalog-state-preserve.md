# Task: catalog state preservation — 2026-09-23
- scope: providers catalog — per-provider list scroll + search state must survive model toggling (no re-render on select); finish in-flight in-place filter refactor (src/ui/pages/layout.ts, src/ui/pages/providers.ts)
- branch: ui/catalog-state-preserve (merged 094ee9c -> main 8103707, --no-ff; worktree+branch cleaned)
- contract: catalog DOM rebuilds only on data change (load / refresh / Save Curation / key refresh), and every rebuild snapshot-restores each provider's `ul.model-list` scrollTop keyed by `data-provider` plus window offsets and per-provider search values; selection toggles go through syncCurationSelection (live DOM, never a rebuild); search toggling runs onCatalogSearchInput (in-place filter + list-scroll reset to top); silent auto-save keeps the canonical status line; "＋ Fallback" stages in place via POST /api/fallback-chain/toggle {modelId, enabled, routeId: fallback-models}
- gates: tsc clean; suite 144/144 pass
- smoke: 28999 instance against a COPY of the real config (1069 cached models) — all state-preservation scenarios green, zero page errors; production 11434 rebuilt + restarted (state-file PID == listener PID 2189621), localrouter verify PASSED (catalog 2391), served page carries the new handlers
- status: done
- Classification: Confidential. No secrets in this file.
