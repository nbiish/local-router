---
plan_format: ainish/plan/v1
slug: release-promotion-chain
date: 2026-11-26
status: done
branch: fix/release-promotion-chain
worktree: /Volumes/1tb-sandisk/code-external/local-router-worktrees/fix-release-promotion-chain
task_record: .agents/tasks/2026-11-26-17-release-promotion-chain.md
operator: omp
---

# Plan: Make "tag → release → `production` → in-app update" one working chain

## 1. Problem

A `v*` tag now builds and publishes a correct, signed, multi-platform release — v1.2.1 proved that — but
the chain stops there. Nothing promotes the released commit to `production` or refreshes the website's
update manifest, and inside the desktop app the dashboard's own "Check for updates" button fails. The
operator wants to operate on the latest `main`, have it verified, see it reach `production`, and update
the app from the "check for updates" buttons of the latest production release.

## 2. Anchor Facts

- v1.2.1 (tag → `5e541f6` = `main` tip) built green on Windows, macOS universal and Linux; 14 assets, each installer with a `.sig` — `gh run view 45863326778`'s sibling `45851010333`, `gh release view v1.2.1`.
- The release was published at 15:42:34Z by `desktop-release.yml`'s own `GITHUB_TOKEN`; `promote-website-release.yml` recorded zero runs and `production` stayed at `114a309` until a manual `workflow_dispatch -f tag=v1.2.1` (run `45863326778`, website run `45863365622`) — `gh run list --workflow promote-website-release.yml`.
- GitHub docs, *Triggering a workflow from a workflow*: "events triggered by the `GITHUB_TOKEN` will not create a new workflow run", except `workflow_dispatch` and `repository_dispatch` — https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow. A `release: published` raised by the build job therefore never starts the promotion workflow.
- `includeUpdaterJson` is not an input of `tauri-apps/tauri-action@v0`; current inputs are `uploadUpdaterJson` and `uploadUpdaterSignatures` (default on for non-draft releases) — `action.yml` at `tauri-apps/tauri-action` main.
- The auto-generated release `latest.json` merged all matrix jobs and carries `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, `linux-x86_64`; `tauri-plugin-updater` 2.12.0 looks platforms up by exact `{os}-{arch}` and never mentions `universal` — release asset; `tauri-plugin-updater-2.12.0/src/updater.rs:1393`.
- The universal macOS bundle verifies against the embedded public key under the plugin's own algorithm (`minisign-verify` 0.2.5: plain BLAKE2b-512 prehash for `ED`, plus the global signature over `signature || trusted_comment`) — `minisign-verify-0.2.5/src/lib.rs:334-371`; verified on the real bundle and on a tampered copy.
- The desktop shell loads the dashboard from `http://127.0.0.1:11434/config` (a remote origin for IPC) and the last local build resolved zero capabilities (`gen/schemas/capabilities.json` = `{}`); `build.rs` is a bare `tauri_build::build()`, so no permissions exist for the app's own commands — `src-tauri/src/window.rs:18`, `src-tauri/build.rs`.
- Tauri 2.11.5 resolves each IPC call as a capability lookup filtered by origin, window and webview — `tauri-2.11.5/src/ipc/authority.rs:439`.
- Observed on the installed 1.2.1 app: the dashboard shows "Source up to date" and pressing "Check for updates" raises "Update check failed." — `orca computer get-app-state --app pid:55752` before and after the click.
- App-command permissions are generated only when `build.rs` declares the commands (`AppManifest::commands` → `allow-<command>` / `deny-<command>`) — `tauri-build-2.6.3/src/acl.rs:88-110`.
- `tests/*.test.mjs` are enumerated one by one in `package.json` `test:integration`; shell globs are not used because of PowerShell CI legs — `RELEASING.md` §2.
- The app never calls the autostart plugin's `enable()`, so launching a locally built copy does not repoint a login item — `src-tauri/src/lib.rs:22`.

## 3. Plan

### Goals

- A pushed `v*` tag ends with: release published → manifest verified → `production` fast-forwarded → website synced, with no operator step.
- A release whose manifest lacks a required platform is refused before anything is promoted.
- The dashboard's "Check for updates" / "Install" controls drive the same signed updater as the tray item.

### Non-goals

- No change to what is signed or to the signing key; the updater's verification stays the plugin's.
- No broad IPC grant to the dashboard: only the three updater commands, only on the loopback dashboard origins.
- No Windows/Linux installer-format changes (`updaterJsonPreferNsis` stays at its default).

### Constraints and invariants

- Fail closed: an unverifiable or incomplete manifest blocks promotion.
- Smallest authority: the new capability names three commands and two loopback URL patterns; nothing else changes for the window, which today holds no permissions at all.
- A workflow started by `GITHUB_TOKEN` cannot start another by event; only a direct call (`workflow_call`) or a dispatch is reliable.
- Tags are immutable once on origin; this change is exercised by the next tag, not by moving v1.2.1.

### Proposed architecture

```
push tag v*  ──►  desktop-release.yml
                   build-desktop (matrix ×3) ──► release + per-platform latest.json (merged by tauri-action)
                         │ needs
                   promote ──► resolve tag from tauri.conf.json / package.json (must agree)
                         ├─► scripts/verify-updater-manifest.mjs  (fail closed)
                         └─► uses: promote-website-release.yml (workflow_call, tag passed explicitly)
                                   ├─► fast-forward refs/heads/production
                                   └─► repository_dispatch → local-router-dot-com → Cloudflare Pages production
```

Why this shape: the promotion logic already exists and is tested by use; it only needs to be reachable from the release run. A guard in front of it turns "last writer wins" and a missing platform from a silent bad manifest into a red job.

### Interfaces and data

- `promote-website-release.yml`: adds `workflow_call` with a required string input `tag`; `workflow_dispatch` and `release` triggers unchanged.
- `desktop-release.yml`: `includeUpdaterJson: true` (ignored) replaced by `uploadUpdaterJson: true` + `uploadUpdaterSignatures: true`; new job `promote` (`needs: build-desktop`).
- New `scripts/verify-updater-manifest.mjs <tag>`: exit 0 only when the release's `latest.json` has `version` equal to the tag and each of `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, `linux-x86_64` names an asset on that release with a non-empty signature. Uses the `gh` CLI; handles no token itself.
- New `src-tauri/capabilities/dashboard-updater.json` and `build.rs` declaring `check_updates`, `update_status`, `install_update`.

### Files and symbols

- `.github/workflows/desktop-release.yml` — tauri-action inputs; `promote` job.
- `.github/workflows/promote-website-release.yml` — `workflow_call` trigger.
- `scripts/verify-updater-manifest.mjs`, `tests/verify-updater-manifest.test.mjs`, `package.json` `test:integration` — the guard and its test.
- `src-tauri/build.rs`, `src-tauri/capabilities/dashboard-updater.json` — app permissions and the capability.
- `RELEASING.md` — describe the automatic publish, guard and promotion; keep the manual dispatch as the fallback.

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| Create the release with a PAT so `release: published` fires | Adds a second long-lived credential to make an event happen, when the release run can simply call the promotion |
| Keep promoting by hand each release | Relies on someone remembering; already missed once |
| Point the shell at bundled frontend instead of the served dashboard | The dashboard is the router's live UI; changing where it loads from is a product change |
| Grant the dashboard `core:default` / broad permissions | More authority than the three updater commands need |

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Two matrix jobs rewrite `latest.json` at the same instant and one platform is lost | The guard refuses to promote; the job goes red instead of shipping a partial manifest |
| `package.json` and `tauri.conf.json` versions drift | The `promote` job fails when they disagree before it resolves a tag |
| A remote page can now call `install_update` | Only the loopback dashboard origins; the updater installs nothing that is not signed with the release key |
| The reusable-workflow wiring cannot be run before the next tag | Validated statically (YAML, inputs) and by exercising the guard against the real v1.2.1 and v1.2.0 releases |
| The tray item cannot be driven by automation | The in-app control, once authorized, exercises the same commands and is reachable in the window's accessibility tree |

## 4. Clarifications

### 4.1 Promote v1.2.1 to production

- **Question:** Promote v1.2.1 to `production` and the website now, by manual dispatch?
- **Selected:** Yes — `gh workflow run promote-website-release.yml -f tag=v1.2.1`.
- **Trade-off accepted:** This release needed a manual step; the fix here removes it for the next one.
- **asked:** operator

### 4.2 Exercise "Check for Updates" on this mac

- **Question:** Drive the app's update control on this mac?
- **Selected:** Yes. The in-app control turned out to be broken on the installed build, which this plan fixes; the tray item is not reachable with the sanctioned automation.
- **Trade-off accepted:** The live proof runs through a locally built copy of the fixed app, not the installed one.
- **asked:** operator

### 4.3 Make the chain automatic

- **Question:** Open a PR so the next release promotes itself?
- **Selected:** Yes.
- **Trade-off accepted:** The workflow wiring is first exercised for real by the next tag.
- **asked:** operator

## 5. Todos

- [x] **T1** Add `workflow_call` (required string input `tag`) to `promote-website-release.yml`.
  - from: §3 | done when: the workflow is callable with an explicit tag and its existing triggers are unchanged | verify: YAML parses; `inputs.tag` is the only tag source in the job
- [x] **T2** In `desktop-release.yml`, replace the ignored `includeUpdaterJson` with explicit `uploadUpdaterJson` / `uploadUpdaterSignatures`, and add the `promote` job (resolve tag, guard, call the promotion).
  - from: §3 | done when: the job runs only after every matrix job and passes a tag explicitly | verify: YAML parses; tag resolution asserts the two version files agree
- [x] **T3** Add `scripts/verify-updater-manifest.mjs` and `tests/verify-updater-manifest.test.mjs`; list the test in `test:integration`.
  - from: §3 | done when: a complete manifest passes and each of missing platform / wrong version / missing asset / empty signature fails | verify: `node --test tests/verify-updater-manifest.test.mjs`
- [x] **T4** Declare the three updater commands in `src-tauri/build.rs` and add `src-tauri/capabilities/dashboard-updater.json`.
  - from: §2 | done when: the build generates `allow-check-updates`, `allow-update-status`, `allow-install-update` and the dashboard origin may use them | verify: a local build's `gen/schemas/capabilities.json` lists the capability
- [x] **T5** Align `RELEASING.md` with the workflow: automatic publish, guard, promotion, manual fallback.
  - from: §3 | done when: no section says the release stays a draft until published by hand | verify: read-back
- [x] **T6** Task record, COMMS, memory and suggestion for this work.
  - from: contract | done when: files exist and are committed on the branch | verify: `git status` clean

## 6. Verification

- `node --test tests/verify-updater-manifest.test.mjs` — all cases pass.
- `node scripts/verify-updater-manifest.mjs v1.2.1` — exit 0 against the real release; `… v1.2.0` — non-zero (macOS-only manifest).
- `node --test tests/app-update-ui.test.mjs` — still passes after the shell changes.
- Python YAML parse of both workflows — no error.
- Local build of the shell from this branch with `gen/schemas/capabilities.json` listing `dashboard-updater`.
- End to end on this mac: a locally built copy reporting 1.2.0 shows "Update v1.2.1 available", installs through the dashboard control, and relaunches as 1.2.1.

## 7. Open Decisions

- _(empty)_
