# TASK: Fallback Routes — Chain Dropdown Editor

Classification: Confidential. No secrets.

## Chain-of-Draft

- Route-id input: broken UX.
- Edit buttons: dead for users.
- Replace: chain dropdown.
- Select → hydrate → drag autosaves.
- Edit buttons removed; Delete kept.
- New chain via "— New chain…".
- Post-save: stay on saved chain.
- Regex template bug: `\/` collapse.
- Served-JS syntax: now gated.
- Affected fallback scripts wait time.

####

## Change

1. **fallback.ts:** `Presented Fallback Model Name` text input replaced by `#fallbackRouteSelect` dropdown (all chains, ordered fallback-models/free/performance/multimodal/custom, plus `— New chain…` with inline new-name input).
2. **layout.ts:** `populateFallbackRouteSelect`, `selectFallbackRouteToEdit`, `currentFallbackEditTarget`, `hydrateFallbackForm`; `saveFallbackRoute`/`autoSaveFallbackRoute` use the target (autosave restricted to existing chains — no accidental on-type chain creation); Edit buttons removed from route cards (Delete kept); `applyFallbackDefaults` now targets the system chain in the dropdown and saves immediately; post-save reselects the saved chain via its presented id.
3. **Bug fix embedded:** emitted-script syntax error from template-literal regex (`\/`) — replaced with string ops; added browser script-parse check to the verification loop (node --check on served script).
4. **Verified in-browser (real Chromium):** dropdown hydrate/switch (18/21/24-item counts), drag-reorder on `free` auto-saves server-side, new-chain creation reselects the created chain, Reset Defaults persists 24-step system chain, deletions reflected immediately.
