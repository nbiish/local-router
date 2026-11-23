# Task: FCC-style tray icon + desktop launchers (in flight)

- Plan: `.agents/plans/2026-11-22-19-tray-icon-tooling.md`
- Branch: `feat/tray-icon-tooling` (worktree `/Volumes/1tb-sandisk/code-external/local-router-worktrees/tray-icon-tooling`)
- Opened: 2026-11-22 19:xx UTC by The Lab (rev profile), implementation delegated to veteran-production-coder.
- Status: implementing.

## Evidence log

- Baseline `cargo check` green (22.29s) on main checkout before any edit — this session.
- Dual-tray defect proven from tauri-2.11.5 `app.rs:2420` + `tray.rs:35-39`.
- FCC reference cloned to `~/.hermes/profiles/rev/cache/scratch/fcc` (read-only reference; AGPL — no bytes copied).
