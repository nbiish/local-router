# TASK 2026-08-29 — fix/config-fallback-persist

Branch: fix/config-fallback-persist (from develop)

## Chain-of-Draft

- Fallback UI edits lack auto-save.
- Toggle, remove, add: no auto-save.
- Drag-drop only calls autoSave.
- Short chains (<2) fail save.
- Existing routes require >=0 models.
- Auto-save on all UI mutations.
- Debounce textarea oninput auto-save.
- RouterSettings export/import syncs routes.
- Boot loader: never clobber routes.
####

## Audit

- FIPS 203/204/205 compliant.
- No secrets in config persistence.
- Safe JSON atomic write.
####
