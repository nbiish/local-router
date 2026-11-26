# Task: Make "tag → release → production → in-app update" one working chain

- lane: now
- branch: `fix/release-promotion-chain`
- worktree: `/Volumes/1tb-sandisk/code-external/local-router-worktrees/fix-release-promotion-chain`
- status: done
- plan: `.agents/plans/2026-11-26-17-release-promotion-chain.md`
- scope: `.github/workflows/desktop-release.yml`, `.github/workflows/promote-website-release.yml`, `scripts/verify-updater-manifest.mjs`, `tests/verify-updater-manifest.test.mjs`, `package.json`, `src-tauri/build.rs`, `src-tauri/capabilities/dashboard-updater.json`, `src-tauri/Cargo.lock`, `.gitignore`, `RELEASING.md`
- compat: additive; the release workflow gains one job, the promotion workflow gains a `workflow_call` trigger (its existing triggers are unchanged), the app gains a narrowly scoped IPC capability for its own updater commands
- objective: After a `v*` tag, the released commit reaches `production` and the website on its own, and the desktop app's "check for updates" controls install the signed release.

## What the 2026-11-26 v1.2.1 release proved and exposed

- v1.2.1 (tag → `5e541f6`) built green on three platforms with 14 signed assets; `latest.json` carried `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64` and `linux-x86_64`; the universal macOS bundle verified against the embedded minisign key.
- Nothing promoted it: a release published by the workflow's own `GITHUB_TOKEN` raises no `release` event (GitHub docs, *Triggering a workflow from a workflow*), so `promote-website-release.yml` never ran and `production` stayed at `114a309` until a manual dispatch.
- In the desktop app the dashboard's "Check for updates" failed ("Update check failed.") because the dashboard is a remote origin for IPC and no capability granted it the updater commands; `build.rs` generated no permissions for those commands at all.
- v1.2.1 shipped with a stale `Cargo.lock` entry (`1.2.0` against `1.2.1` everywhere else), the drift `RELEASING.md` §1 forbids.

## Verification (2026-11-26)

- `node --test tests/verify-updater-manifest.test.mjs` — 7/7.
- `node scripts/verify-updater-manifest.mjs v1.2.1` — exit 0 against the live release; `… v1.2.0` — exit 1 (refused; no `latest.json` asset).
- `npm run build` + `node --test tests/app-update-ui.test.mjs tests/ui-page-scripts-parse.test.mjs` — 8/8.
- Python YAML parse of both workflows; the resolve step's extraction returns package.json = tauri.conf.json = Cargo.toml = Cargo.lock = 1.2.1.
- Local build (`tauri build -b app`): `gen/schemas/capabilities.json` lists `dashboard-updater` with the three updater permissions and the two loopback origins.
- End to end on macOS: a locally built copy reporting 1.2.0 showed "Update v1.2.1 available" from the dashboard control, and its Install button downloaded the published universal bundle, verified the signature and relaunched as 1.2.1 (bundle on disk: `x86_64 arm64`, version 1.2.1, release build timestamp). The released 1.2.1 on the same machine still fails the same button — the control experiment.

## Not done

- The `workflow_call` wiring is exercised for real only by the next tag.
- The tray item was not driven: it is outside the sanctioned automation's reach (window tree only). The dashboard control exercises the same three commands.
- 19 test files on disk are not enumerated in `test:integration`, so CI never runs them — suggestion filed, out of scope here.
