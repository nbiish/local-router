---
plan_format: ainish/plan/v1
slug: portable-fallback-and-updates
date: 2026-11-23
status: done
branch: feat/portable-config-and-updates
worktree: /Volumes/1tb-sandisk/code-external/local-router-worktrees/portable-config
task_record: .agents/tasks/2026-11-23-01-portable-config-and-updates.task.md
---

# Plan: portable fallback chain + check-for-updates in icon and app

## 1. Objective

- Make the operator's 20-model fallback chain portable: export a versioned JSON
  file from the app, import it on another machine, with preview, validation and
  backup. Chain only — no credentials, no curation.
- Surface a "Check for updates" affordance in both the tray icon and the main
  app, driven by the existing signed Tauri updater (GitHub Releases + minisign).
- Apply the exported chain on the Windows host and verify the router + desktop
  app work there (cross-architecture proof).

## 2. Asset / threat model

Asset: the authoritative 20-step fallback chain (`router-settings.json`) and the
signed update path. Adversary: a crafted import file (traversal, oversized input,
control characters, secret smuggling) and a tampered release manifest. Worst
outcome: silent chain corruption or installation of unsigned code. Controls:
schema/version pin, strict size and shape limits, allow-listed characters,
atomic writes with timestamped backup, diff preview, signed updates only.
Re-added UI deliberately reverses the 2026-11-10 removal; this is an explicit
operator decision recorded in this plan.

## 3. Design

### 3.1 Portable chain bundle
- New module `src/fallback-config-bundle.ts`:
  - schema `local-router-fallback/v1`, fields: `exportedAt`,
    `fallbackModelsText`, `routes` (id/models/disabledModels).
  - `buildFallbackBundle(settings)`, `parseFallbackBundle(raw)` with bounds
    (<=1 MiB input, <=200 chain lines, <=50 routes, <=100 models/route,
    <=256 chars/id, printable non-control charset, no newlines in ids).
  - No secret fields by construction; a test asserts this.
- API: `GET /api/config/fallback/export`, `POST /api/config/fallback/import`
  (`{ config, dryRun }`). Import reuses the existing PUT write path (shared
  helper) so `persistFallbackModels()` remains the sole writer. Dry run returns
  an added/removed/changed diff and never writes. Apply snapshots the previous
  chain first.
- UI on `/config/fallback`: Export (download JSON) + Import (file → preview →
  confirm). CLI `scripts/fallback-config.mjs export|import` over the loopback
  API, with `--dry-run` default for import.

### 3.2 Check for updates
- Rust: add Tauri commands `update_status`, `check_updates`, `install_update`
  wrapping the existing `SharedUpdateState`; register with `generate_handler!`.
  Tray keeps its existing item; both surfaces read the same state. Only signed
  artifacts install; failure keeps the previous label.
- Web: sidebar-footer control shows current/latest version and status; Check
  calls the same Rust path via `window.__TAURI_INTERNALS__.invoke`. Outside the
  desktop shell it falls back to `/api/update-status` with "source checkout"
  wording and no install button. `/api/apply-update` stays dev-only, never
  surfaced.

### 3.3 Windows leg
- SSH aliases verified working: `windows`, `windows-ip`, `wsl`, `wsl-ip`.
- Export on Mac → scp to Windows → import into `D:\Workspace\local-router` and
  `/mnt/d/Code/local-router` → read back the 20-model chain → run gates there.
- Currency check: `stat build/index.js >= git log -1 --format=%ct`.
- Keys never copied; per-machine PQC stores remain untouched.

## 4. Todos

- [ ] T1 Plan record + worktree off latest origin/main.
- [ ] T2 Bundle module + tests.
- [ ] T3 Export/import API reusing the persisted write path + tests.
- [ ] T4 UI panel + CLI scripts.
- [ ] T5 Rust update commands + webview control + gate.
- [ ] T6 Build, focused tests, full suite vs 437/1/13 baseline, PRs.
- [ ] T7 Windows import + cross-architecture verification, records closed.

## 5. Verification

- `npm run build`, focused `node --test` on new tests, full `npm test`,
  `cargo check`.
- HTTP smoke of export → dry-run import → apply → re-export equality.
- Read-back of `router-settings.json` on both machines; checksum/diff of the
  exported bundle.
- Confirm no secret fields appear in any exported file or log.
