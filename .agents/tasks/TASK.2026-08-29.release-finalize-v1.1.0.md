# TASK 2026-08-29: Release Finalize v1.1.0

## Draft
- universal-env merged: main @ 338224c
- post-merge: prune worktree, delete branch
- suite: 111 pass + 1 rerun pass (port flake 28201)
- tag v1.0.0 exists on origin (June) — immutable
- bump 1.0.0 → 1.1.0: package.json, tauri.conf.json, Cargo.toml, Cargo.lock
- llms.txt lineage: backfill 338224c, 4d428dd, e731adb
- next: merge → tag v1.1.0 → push → CI desktop draft

####

## Output
- Version bump to 1.1.0 across JS/Tauri/Rust manifests (tag v1.0.0 already published on origin; cannot move).
- `desktop-release.yml` (tag `v*` trigger) builds Windows NSIS/MSI + macOS universal + Linux AppImage/Deb as DRAFT release.
- Verification receipts: `npm test` green on main (single re-run of flaky file: 1/1); `tsc` clean; Cargo.lock manually synced to match `cargo`'s own-package entry.
