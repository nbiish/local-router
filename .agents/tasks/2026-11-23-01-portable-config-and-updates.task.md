# Task: portable fallback chain + check-for-updates in icon and app

- Plan: `.agents/plans/2026-11-23-01-portable-fallback-and-updates.md`
- Branch: `feat/portable-config-and-updates` (worktree `local-router-worktrees/portable-config`, off `origin/main@efc374e`)
- Status: done (PR open; human merge pending; signed release publish needs operator authority)
- Operator directive: "just port the fallback-models chain", "update the ui", "icon and the app to have a check for updates section", "windows version updated after our configuration here".

## Evidence log

- 2026-11-23T01:19Z: `origin/main` refreshed to `efc374e` (PR #13 support-section merged); local `main` remains ahead 3 / behind 13.
- Windows SSH verified working for all four aliases (`windows`, `windows-ip` -> `kenwa`; `wsl`, `wsl-ip` -> `nanoboozhoo`). Earlier "keys refused" blocker is resolved.
- The operator's 20-model list already matches the live `router-settings.json` chain exactly (verified by diff), so this task adds portability, not a chain rewrite.
- Signed Tauri updater confirmed in files (PR #11): `src-tauri/src/updater.rs`, `tauri.conf.json` pubkey + `https://local-router.com/updates/latest.json`, `scripts/make-update-manifest.mjs`, `RELEASING.md` §6. Context injection claiming otherwise was stale and was not followed.
- Bundle boundary: `src/fallback-config-bundle.ts` pins `local-router-fallback/v1`, caps size/steps/routes/id length, rejects unknown fields and control characters, and never echoes untrusted input into errors.
- Export/import reuses `applyRouterSettingsPayload()`, so `persistFallbackModels()` remains the single writer; import is dry-run by default.
- Tray and app now share the same `SharedUpdateState` through Tauri commands; `/api/apply-update` (git pull) is deliberately not surfaced in the UI.

## Verification

- Focused tests: bundle 8/8, API 4/4, update UI 3/3, page-script parse 5/5.
- Full suite: 437 pass / 2 fail / 13 skipped. One fail is the known Cursor baseline flake; the other (decisions.integration ENOTEMPTY temp rmdir) passes 14/14 in isolation — suite-ordering race, not a regression.
- `npm run build` and `cargo check` clean on macOS; `npm run build` clean on WSL and native Windows.
- Cross-architecture: exported bundle sha256 `5fa45df7ef2305d4df52782a3538496651526bf5c179ea71422ee052250b0d56` verified on both Windows hosts; WSL live 11434 and native Windows isolated 28136 both read back the exact 20-step chain.
- No credentials in the bundle (tested), no secret fields in the diff.

## Not verified

- Published signed release / `latest.json` update — needs operator signing/publishing authority. Human merge of the PR.
