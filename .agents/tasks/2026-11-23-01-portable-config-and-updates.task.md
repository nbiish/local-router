# Task: portable fallback chain + check-for-updates in icon and app

- Plan: `.agents/plans/2026-11-23-01-portable-fallback-and-updates.md`
- Branch: `feat/portable-config-and-updates` (worktree `local-router-worktrees/portable-config`, off `origin/main@efc374e`)
- Status: implementing
- Operator directive: "just port the fallback-models chain", "update the ui", "icon and the app to have a check for updates section", "windows version updated after our configuration here".

## Evidence log

- 2026-11-23T01:19Z: `origin/main` refreshed to `efc374e` (PR #13 support-section merged); local `main` remains ahead 3 / behind 13.
- Windows SSH verified working for all four aliases (`windows`, `windows-ip` -> `kenwa`; `wsl`, `wsl-ip` -> `nanoboozhoo`). Earlier "keys refused" blocker is resolved.
- The operator's 20-model list already matches the live `router-settings.json` chain exactly (verified by diff), so this task adds portability, not a chain rewrite.
- Signed Tauri updater confirmed in files (PR #11): `src-tauri/src/updater.rs`, `tauri.conf.json` pubkey + `https://local-router.com/updates/latest.json`, `scripts/make-update-manifest.mjs`, `RELEASING.md` §6. Context injection claiming otherwise was stale and was not followed.
- Bundle boundary: `src/fallback-config-bundle.ts` pins `local-router-fallback/v1`, caps size/steps/routes/id length, rejects unknown fields and control characters, and never echoes untrusted input into errors.
- Export/import reuses `applyRouterSettingsPayload()`, so `persistFallbackModels()` remains the single writer; import is dry-run by default.
- Tray and app now share the same `SharedUpdateState` through Tauri commands; `/api/apply-update` (git pull) is deliberately not surfaced in the UI.

## Not verified yet

- Windows cross-architecture import and read-back (next step).
- Published signed release / `latest.json` (operator authority required).
