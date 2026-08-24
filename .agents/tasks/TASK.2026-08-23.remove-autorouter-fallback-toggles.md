# TASK: Remove Auto-Router System — User-Configured Fallback Only

Classification: Confidential. No secrets.

## Chain-of-Draft

- Auto-router obsolete.
- Models converge quality.
- Keep fallback chains only.
- Remove /routers UI page.
- Kill RouterModel CRUD endpoints.
- Kill scoring, tiers, recompute.
- Kill preset auto-routers.
- Keep preset fallback chains.
- Catalog rows gain fallback toggle.
- Toggle mutates `fallback-models`.
- Drag reorders chain live.
- Persist via fallback store.
- Live refresh feeds catalog.
- Migration: drop persisted routers.
- llms.txt PRD updated.
- Gates: tsc + smoke 11436.

####

## Scope

1. **Removal:** entire auto-router system — `/config/routers` page, RouterModel type/store/parse, `PRESET_ROUTER_ROUTES`, auto-local/pareto-code/priority/bandit-local execution path, candidate scoring, auto-tiers, telemetry recompute, `/api/router-*` endpoints (except `/api/router-settings` fallback text), `localrouter router` CLI subcommands.
2. **Providers & Models page:** per-model **fallback toggle** in the Available Providers & Models catalog; toggling adds/removes the model in the system chain `local-router/fallback-models` (append at end on add).
3. **Order UX:** draggable fallback-order panel reflecting the system chain; drag autosaves order. Existing Fallback Routes page builder stays as the multi-route editor.
4. **Backend:** small chain-mutation endpoint (toggle membership) reusing `fallbackModelStore` + `persistFallbackModels()`.
5. **Migration:** persisted router routes dropped on boot; fallback routes untouched.
6. **Docs/tests:** llms.txt PRD + ROUTER.md updated; router tests retired; fallback tests kept; tsc clean; smoke test on port 11436.

## Non-goals

- Changing provider curation behavior or `/v1/models` serving logic.
- Rewriting the direct-model execution path beyond deleting the router branch.
- Pricing overrides, OAuth, diagnostics pages (untouched).
