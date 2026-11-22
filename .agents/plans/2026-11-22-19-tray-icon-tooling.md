---
plan_format: ainish/plan/v1
slug: tray-icon-tooling
date: 2026-11-22
status: ready
branch: feat/tray-icon-tooling
worktree: /Volumes/1tb-sandisk/code-external/local-router-worktrees/tray-icon-tooling
task_record: .agents/tasks/2026-11-22-19-tray-icon-tooling.task.md
operator: nbiish
---

# Plan: FCC-style tray icon + desktop launchers for Local Router

## 1. Problem

When Local Router runs, there is no single reliable icon to access it from. The desktop app
currently produces a duplicated/broken tray (a template-masked config icon plus a second
icon-less code-built one), the tray's Restart and Quit items do not actually control the
router daemon, and nothing installs a launcher into ~/Applications / Desktop (macOS) or
Start Menu / Desktop (Windows) the way Free Claude Code's desktop tooling does. The operator
wants FCC-parity: click an icon in the menu bar / system tray to open the dashboard, restart,
or quit, and open Local Router from the desktop or Start menu like a normal app.

## 2. Anchor Facts

- Tauri auto-creates a tray from `app.trayIcon` config at startup — `tauri-2.11.5/src/app.rs:2420` (`if let Some(tray_config) = &config.app.tray_icon`).
- `setup_tray()` builds a SECOND tray (`with_id("main-tray")`) with no `.icon()` call — `src-tauri/src/tray.rs:35-39` → blank menu-bar slot.
- Tray "restart" only opens a URL; `DaemonManager::{restart,stop}` are `#[allow(dead_code)]` and unwired — `tray.rs:57-60`, `daemon.rs:71-87`.
- Daemon spawn is `sh -c "local-router start || node build/index.js"` — relative path breaks when cwd is `/` (Finder/launcher launch) — `daemon.rs:45-48`. Repo physically lives at `/Volumes/1tb-sandisk/code-external/local-router` (cargo output this session).
- `~/.local/bin/local-router` shim is installed by setup — `scripts/setup-platform.mjs:119-131`.
- FCC macOS launcher pattern: install to `~/Applications/Free Claude Code.app`, Desktop symlink, owner-marker file, staged swap with backup, ad-hoc codesign, `LSUIElement` — `fcc/src/free_claude_code/cli/macos_app.py:70-147`.
- FCC Windows launcher pattern: WScript.Shell `.lnk` to `%USERPROFILE%\Desktop\...` and `...\Start Menu\Programs\...` with exported `.ico` — `fcc/scripts/install.ps1:1947-1990`.
- `cargo check` baseline is green (22.29s) on this host — run this session.
- `gh` authenticated as nbiish; origin = github.com/nbiish/local-router — `gh auth status`, `git remote -v` this session.
- FCC is AGPL-3.0-only; local-router is ISC — no FCC code may be copied, only the behavioral pattern.

## 3. Plan

### Goals

- Exactly one branded tray/menu-bar icon on macOS and Windows whenever the desktop app runs; left-click opens the dashboard, context menu offers deep links, working Restart, and Quit.
- Restart actually restarts the router daemon; Quit stops the owned daemon and exits.
- `npm run desktop:install` puts a real launcher on both platforms: macOS `~/Applications/Local Router.app` + Desktop symlink; Windows Desktop + Start Menu `.lnk` pointing at the built exe with the branded icon.
- README/SETUP document the icon behaviors.

### Non-goals

- Porting FCC's pystray/Python tray (wrong stack for this repo; Tauri tray already exists).
- Auto-update machinery, login-item toggle UI (autostart plugin stays as-is).
- Running the full integration test suite (network-bound, out of scope for this change).

### Constraints and invariants

- Operator is sole commit author; no co-author trailers; Conventional Commits.
- All work in the worktree off latest `origin/main`; delivery via PR, no self-merge.
- No secrets, no writes outside the worktree + user-level install targets (`~/Applications`, `~/Desktop`, Start Menu).
- No FCC source bytes copied into this repo (AGPL/ISC boundary).
- Windows code paths cannot be executed on this macOS host: static review + PowerShell parse check only; called out honestly in the PR.

### Proposed architecture

```
Tauri app (single code-built tray)
  ├─ tray icon ← app.default_window_icon() (bundled icons/), template OFF
  ├─ menu: status / deep links / Restart / Quit
  ├─ Restart/Quit → Arc<DaemonManager> (Tauri managed state)
  └─ DaemonManager spawns router via absolute resolution:
       repo root (walk up from current_exe) → PATH `local-router` shim → clear error
scripts/install-desktop.mjs
  ├─ macOS: tauri build → copy bundle → ~/Applications + Desktop symlink (FCC pattern)
  └─ Windows: tauri build → WScript.Shell .lnk (Desktop + Start Menu) → built exe
```

One tray, built in code, is the single source of truth; the config-level `app.trayIcon` is
removed so the framework duplicate disappears.

### Interfaces and data

- `tauri.conf.json`: `app.trayIcon` block removed (was: iconPath/template/tooltip).
- `tray.rs`: `setup_tray(app: &AppHandle)` signature unchanged; handlers now use `app.state::<Arc<DaemonManager>>()`.
- `daemon.rs`: `ensure_started` resolves the server command absolutely; `restart`/`stop` lose `#[allow(dead_code)]`; new `pub fn server_command() -> Option<Command>` resolution helper.
- `package.json`: new scripts `desktop:build` (`tauri build`), `desktop:install` (`node scripts/install-desktop.mjs`).
- `scripts/install-desktop.mjs`: flags `--dry-run`, `--skip-build`; exit 0 on success, non-zero with message on failure.

### Files and symbols

- `src-tauri/tauri.conf.json` — delete `app.trayIcon` (lines 29-33).
- `src-tauri/src/tray.rs` — `.icon(...)`, `.icon_as_template(false)`, wire restart/quit to managed daemon state, refresh status item text after restart.
- `src-tauri/src/lib.rs` — `app.manage(Arc<DaemonManager>)`, stop daemon on exit (`RunEvent::ExitRequested`/`Exit`).
- `src-tauri/src/daemon.rs` — absolute spawn resolution, `CREATE_NO_WINDOW` on Windows, remove dead_code allows.
- `scripts/install-desktop.mjs` — new installer (both platforms, dry-run first).
- `package.json` — add `desktop:build`, `desktop:install`.
- `README.md` + `SETUP.md` — "Desktop App & Tray Icon" section.

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep config tray, fetch via `tray_by_id` | Couples to Tauri internal config id; no control over icon/template from code. |
| pystray sidecar (literal FCC port) | Drags a Python runtime into a Node/Rust app that already has a native tray. |
| Windows: run NSIS installer silently | Needs elevation in some setups; `.lnk` gives FCC parity without install machinery. |

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Release `tauri build` is slow on first run | `--skip-build` reuses an existing bundle; debug binary verifies the tray behavior. |
| Installed .app can't locate the repo | Resolution chain ends at PATH `local-router` shim (setup-platform installs it); loud error if both fail. |
| Windows path untested on this host | Static review + `pwsh -NoProfile -Command` parse if available; flagged in PR as untested-on-hardware. |
| Clobbering an existing ~/Applications app | Owner-marker file check before replace; refuse non-owned targets (FCC pattern). |

## 4. Clarifications

### 4.1 Implementation substrate

- **Question:** Port FCC's pystray tray literally, or fix the native Tauri tray?
- **Options:** 1. (Recommended) Native Tauri tray — repo already ships `tray-icon` feature, tray.rs, daemon.rs; 2. pystray sidecar — requires Python runtime.
- **Selected:** Native Tauri tray.
- **Trade-off accepted:** Tray behavior differences from FCC internals are acceptable; UX parity is the target.
- **asked:** operator | **resolved by:** operator request "similar to free-claude-code's new icon tooling" + existing `src-tauri` tree.

### 4.2 Icon rendering mode

- **Question:** Template (monochrome, adapts to menu-bar theme) or full-color icon?
- **Options:** 1. (Recommended) Full color — branded gradient ring reads as "our icon", matches FCC's colored icon; 2. Template — masks the gradient art into a black blob.
- **Selected:** Full color, `iconAsTemplate: false`.
- **Trade-off accepted:** No automatic light/dark adaptation of the artwork.
- **asked:** resolved from code | **resolved by:** `scripts/generate-icons.mjs` artwork (color gradient disc) + FCC precedent.

### 4.3 macOS install scope

- **Question:** `/Applications` (system) or `~/Applications` (user)?
- **Options:** 1. (Recommended) `~/Applications` — no sudo, FCC does exactly this (`macos_app.py:75`); 2. `/Applications` — needs elevation.
- **Selected:** `~/Applications` + Desktop symlink.
- **Trade-off accepted:** App is per-user, not system-wide.
- **asked:** resolved from code | **resolved by:** FCC `macos_app.py:70-147`.

## 5. Todos

- [ ] **T1** Remove `app.trayIcon` from `src-tauri/tauri.conf.json`; single tray in code.
  - from: §2/§3 | done when: config has no trayIcon block | verify: `rg -n trayIcon src-tauri/tauri.conf.json` → no match
- [ ] **T2** `tray.rs`: set icon from `default_window_icon`, `icon_as_template(false)`, keep left-click→dashboard.
  - from: §3 | done when: builder chain contains `.icon(` and `.icon_as_template(false)` | verify: `cargo check`
- [ ] **T3** Manage `Arc<DaemonManager>` as Tauri state; Restart calls `restart()` + refreshes status text; Quit calls `stop()` then `app.exit(0)`; daemon stopped on app exit.
  - from: §3 | done when: no `#[allow(dead_code)]` on restart/stop | verify: `rg -n 'dead_code' src-tauri/src/daemon.rs` → no match + `cargo check`
- [ ] **T4** `daemon.rs`: absolute server resolution (exe-walk → PATH shim → error), `CREATE_NO_WINDOW` on Windows.
  - from: §3 | done when: no relative `node build/index.js` spawn | verify: `cargo check` + manual run from `/` cwd
- [ ] **T5** `scripts/install-desktop.mjs` + `package.json` scripts (`desktop:build`, `desktop:install`), FCC-pattern installers, `--dry-run`.
  - from: §3 | done when: `node scripts/install-desktop.mjs --dry-run --skip-build` prints the platform plan, exit 0 | verify: same command
- [ ] **T6** README + SETUP "Desktop App & Tray Icon" section.
  - from: §3 | done when: both files document install + tray menu | verify: `rg -n 'desktop:install' README.md SETUP.md`
- [ ] **T7** Gates green in worktree; commit (feat:), push, PR opened.
  - from: §6 | done when: PR URL exists | verify: `gh pr view`

## 6. Verification

- `cd src-tauri && cargo check` — clean, no new warnings vs baseline.
- `npm run build` — tsc clean.
- Debug binary launched from `/` cwd: exactly one menu-bar icon renders (screencapture evidence), dashboard opens on click.
- `node scripts/install-desktop.mjs --dry-run --skip-build` — prints actions, exit 0.
- Windows script block: parsed by `pwsh` if present on host; otherwise marked untested in PR.

## 7. Open Decisions

- Windows runtime verification — settled by running `desktop:install` on the Windows host (next operator session there).
- Whether to additionally ship the NSIS installer path on Windows — settled by operator preference after using the `.lnk` flow.
