# Suggestion 2026-11-25 12 UTC — tauri.conf.json lost `app.windows`; tauri-dnd-config test fails on origin/main

Found while running the full suite on `fix/inbound-access-control` (base `origin/main` @ baf9e7d):

- `tests/tauri-dnd-config.test.mjs` ("tauri window config keeps dragDropEnabled false for HTML5 DnD") fails on origin/main because `src-tauri/tauri.conf.json` defines no `config.app.windows` array (`assert.ok(Array.isArray(windows) && windows.length > 0, 'expected app.windows')`).
- The failure reproduces identically on the unmodified local checkout (same conf content on both), so it predates the inbound-access-control work; it is NOT caused by PR #22.
- The desktop DnD fix (PR #15, `dragDropEnabled: false` + window block) appears to have been lost when `feat/portable-config-and-updates` (PR #14) restructured the conf — the conf's recent history (`7249e38`, `da07db2`) carries release/updater changes, not the window block.
- Consequence worth checking beyond the test: without a `windows` block, the Tauri shell may fall back to build-time defaults, which could bring back the HTML5-drag-consumed-as-file-drop behavior the DnD fix removed.

Suggested fix: restore the `app.windows` entry (with `dragDropEnabled: false`) or, if the window is now created programmatically in Rust, re-point the test at that source of truth.

## Resolution (operator, 2026-11-25)

Not a behaviour regression. `da07db2` (navigation guard) moved window creation out of
`tauri.conf.json` into `src-tauri/src/window.rs`, and `build_main_window` calls
`.disable_drag_drop_handler()` — the Tauri v2 builder equivalent of `dragDropEnabled: false`.
Only the test was stale. Re-pointed at the Rust source of truth (and still guards any future
`app.windows` entry) in the close-out PR; the "consequence worth checking" paragraph does not apply.
