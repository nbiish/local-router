# TASK 2026-08-24 — fix/curation-autosave

Branch: fix/curation-autosave (from develop)

## Chain-of-Draft

- User checked serving toggles.
- Server selectedKeys = 0.
- Checks browser-only until Save.
- Reload silently wipes intent.
- Chain panel: saves immediately.
- Serving toggles: require Save; inconsistent.
- Fix: debounced auto-save all curation ops.
- Silent save, keep explicit button.
####

## Audit

- No secrets, no crypto.
- UI-only mutation; same PUT contract.
####
