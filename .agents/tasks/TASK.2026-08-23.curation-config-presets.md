# TASK: Curation Config Presets + Registry-Scoped Validation

Classification: Confidential. No secrets.

## Chain-of-Draft

- User: preset saves dead.
- Registry ids unresolvable.
- allCatalogModels too narrow.
- Widened: registry ∪ cache.
- Edit-save works again.
- Select/deselect-all added.
- Named configs: save/load/delete.
- Default marker: boot apply.
- Five API endpoints.
- Tests: repro + API + reboot.
- tsc clean; suite green.

####

## Change

1. **Fix (Edit→Save dead):** `allCatalogModels()` now unions the static registry/override/custom inventory with the live cache (was: serving ∪ cache). Registry-known steps (`zai-code-pass-glm-5.1`, `openrouter-chain-of-draft`) pass fallback reference validation and toggle checks again — the preset chains' Edit button flow works end-to-end.
2. **Select/deselect all:** Providers & Models gains **Select all** (every provider row, ignoring search) and **Deselect all**; **Select shown** kept for search-filtered bulk ops.
3. **Named curation configs:** `curation-configs.json` (via `config-persistence.ts`) + endpoints — `GET/POST/DELETE /api/curation-configs`, `POST /api/curation-configs/load`, `PUT /api/curation-configs/default ({name|null})`. UI panel: selector (★ marks default), name input, Save as…/Load/Delete/Set default/Clear default. The default config's selection is re-applied at every boot.
4. **Tests:** `tests/curation-configs.test.mjs` (save→list→load→default→restart re-apply→clear→delete) + registry-acceptance case added to `tests/fallback-default-bootstrap.test.mjs`.
