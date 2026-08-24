# TASK 2026-08-24 — feat/config-ui-consolidation

Branch: feat/config-ui-consolidation (from develop)

## Chain-of-Draft

- Providers render twice: grid + groups.
- Grid cards = 21, group sections = same 21.
- Scroll duplicate => merge into one.
- Key pill/env/actions => group header.
- Fetch live => group header button.
- Live list = catalog group list.
####

- Fallback editing exists twice.
- Providers panel + fallback page editor.
- Keep ONLY fallback page editor.
- Catalog rows: "＋ Fallback" button.
- Stages model via ?add= on fallback page.
- Auto-saves into existing chains.
####

- Dead JS must go too.
- Chain panel fns, live-block fns removed.
- Guards for absent page elements.
- Copy mentions updated.
####

## Audit

- UI-only; endpoints untouched.
- No crypto/secrets surface.
####
