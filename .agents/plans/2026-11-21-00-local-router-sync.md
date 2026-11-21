---
plan_format: ainish/plan/v1
slug: local-router-sync
date: 2026-11-21
status: ready
branch: feat/local-router-sync
worktree: /Volumes/1tb-sandisk/code-external/local-router
task_record: .agents/tasks/2026-11-21-00-local-router-sync.md
operator: operator
---

# Plan: resolve the local-router sync failure (and the 56 uncommitted-to-origin commits)

## 1. Problem

The background watcher retries `local-router` continuously and never succeeds, which both hides the
repo's real state and starves the other watched repositories. Separately, the repo has drifted 56
commits ahead of its GitHub remote, 13 of them machine-generated `wip` snapshots with no meaningful
message. Nobody can tell from the log whether the repository is broken or the watcher is.

## 2. Anchor Facts

Verified this session.

- **The repository is NOT broken.** A manual
  `ainish-coder --machine-sync --kind windows --both --ff-peers` inside `local-router` completed with
  no fetch error — established by running it. The only output was `smoke: windows-128gb — unverified`,
  which is the known wrong-repo probe defect, not a sync failure.
- **Fast-forward is possible and safe.** Windows HEAD `df4cf61` **exists in the Mac repo** and
  `git merge-base --is-ancestor df4cf61 HEAD` succeeds, so the peer is a strict ancestor — established
  from both commands. Mac HEAD `01e0e0c` is likewise present on the Windows checkout.
- **The failure is in the watcher's delegated cycle.** The log shows
  `failed: … (attempt 51…55)` immediately followed by `ssh cycle failed` with no `fatal:` git line —
  established from `~/.config/ainish-coder/watch.log`. An earlier, different error in the same log
  (`… ainish-machine-sync-in.bundle does not appear to be a git repository`) is the pre-fix bundle
  collision and is not what is happening now.
- **Loopback ssh is healthy from a terminal**, and can read this repo over loopback
  (`git rev-parse` → `01e0e0c`) — established by running both. It is the launchd-spawned context that
  fails, consistent with the TCC/external-volume behaviour the watcher documents.
- **The repo is 56 commits ahead of `origin/main`**, of which **13** are
  `wip(Mac): synced by --auto-commit` — established from `git rev-list --count origin/main..HEAD` and
  `grep -c`.
- **13 machine commits with an identical useless subject** make `git log` unreadable and would be
  published to GitHub as-is if pushed — established by reading the log.

## 3. Plan

### Goals

- The watcher either syncs this repo or states a specific, actionable reason — no unbounded identical
  retries.
- `origin/main` becomes current, with the 13 `wip` snapshots collapsed into something a human can
  read, or deliberately kept and explained.
- The `smoke: … unverified` line resolves to a real answer for this repo rather than a permanent
  unknown.

### Non-goals

- Rewriting published history on GitHub. Squashing only applies to commits never pushed (all 56 are
  local, `origin/main` is behind, so this is safe — but confirm before doing it).
- Changing what `local-router` does as a program. This plan is about repo hygiene and sync, not its
  runtime behaviour.

### Constraints and invariants

- `AGENTS.md`: never co-author a commit; the operator is the only author. Machine commits read
  `Nanoboozhoo - embodied by {harness}`.
- Rewriting history is safe **only** while `origin/main` is behind. Verify
  `git rev-list --count origin/main..HEAD` before and after.
- The fix must not require the peer to run a newer ainish-coder than it has.

### Proposed architecture

```
  1. Prove the sync path      manual sync succeeds  ->  watcher is the fault, not the repo
  2. Make the watcher honest   specific reason per failure, bounded retries
  3. Tidy the history          collapse 13 wip commits into one explained commit
  4. Push + verify             origin/main matches; peer fast-forwards
```

### Interfaces and data

| Surface | Before | After |
|---|---|---|
| failure reporting | `ssh cycle failed` once per attempt | named cause (ssh / fetch / divergent / no-peer-path) |
| commit history | 13 `wip(Mac)` subjects | one commit whose body lists the changed paths |
| `origin/main` | 56 behind | current, verified by read-back |

### Files and symbols

- `/Volumes/1tb-sandisk/code-external/local-router` — history only; no source change planned.
- `src/machine_watch.sh` — the delegated-cycle failure path (shared with the fleet plan; do the fleet
  plan's T1/T6 first so this repo stops being retried blind).

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| Remove local-router from `links.txt` | The repo wants syncing; removing it abandons the goal and hides the watcher bug |
| Push all 56 commits as-is | Publishes 13 meaningless subjects and an unreadable log to a shared remote |
| Squash by force-push to a shared branch others may have | Safe here only because origin is strictly behind; would be unsafe in general |

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Squashing loses a snapshot someone needed | All 13 are `--auto-commit` snapshots of tracked work; confirm each commit's diff is represented in the squashed tree (`git diff` empty) |
| Push publishes something unintended | Review `git log --stat` before pushing; push is reversible only by another force-push |
| Watcher keeps retrying meanwhile | Do fleet T1/T2 (fair scheduling + quarantine) first |

## 4. Clarifications

- **The "local-router issue" is two things**, and conflating them is why it stayed unresolved: a
  watcher-transport failure (not the repo) and repo hygiene (56 local commits). `asked: resolved from code`
- **No source change to local-router is proposed**, because a manual sync proves the repo and peer
  are fine. If the operator expected a code fix, this plan says explicitly that none is needed yet.

## 5. Todos

- [ ] T1 Capture the exact delegated-cycle error at debug level (the log elides it). Without this the
  "ssh cycle failed" line is unactionable — this is the first task, not an afterthought.
- [ ] T2 Collapse the 13 `wip(Mac)` commits into one, verifying `git diff` is empty afterwards.
- [ ] T3 Push `main` to `origin` and read back `origin/main` == local HEAD.
- [ ] T4 Confirm the Windows peer fast-forwards to the pushed tip (it is a strict ancestor, so this
  should be a plain FF) and read back its HEAD.
- [ ] T5 Re-run the watcher cycle for this repo and confirm a genuine `ok`, not `unverified`.

## 6. Verification

- `git rev-list --count origin/main..HEAD` → 0 after the push.
- `ssh wsl-94gb 'git -C /mnt/d/Code/local-router rev-parse HEAD'` equals the pushed tip.
- `git log --oneline -5` shows no repeated `wip` subjects.
- One watcher cycle for this repo logs `ok`.

## 7. Open Decisions

- **Should `local-router` stay in the unattended watch set at all?** It is a router, not a business
  repo; syncing it every 2 minutes may be more churn than value. Operator call.
- **Should `--auto-commit` be repo-opt-in rather than global?** Today one flag applies everywhere,
  which is how a business repo and a tooling repo got the same treatment.
