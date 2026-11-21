# 2026-11-21 00 local-router sync

**Plan:** `.agents/plans/2026-11-21-00-local-router-sync.md`
**Status:** ready

## Finding: the repository is healthy; the watcher is not

A manual `ainish-coder --machine-sync --kind windows --both --ff-peers` completes without a fetch
error. Windows HEAD `df4cf61` exists in the Mac repo and is a strict ancestor of Mac HEAD
(`git merge-base --is-ancestor` succeeds), so a plain fast-forward is available.

The watcher's log shows `failed: … (attempt 51–55)` followed by `ssh cycle failed` with no git error —
a delegated-cycle failure, not a repository problem. Loopback ssh works from a terminal and can read
this repo (`git rev-parse` → `01e0e0c`), so the fault is in the launchd-spawned context.

## Repo hygiene

- **56 commits ahead of `origin/main`**, of which **13** are `wip(Mac): synced by --auto-commit`.
- Nothing has been pushed, so collapsing those snapshots is safe. Verify
  `git rev-list --count origin/main..HEAD` before and after.

## Next action

The watcher-side fixes live in the ainish-coder fleet plan (fair scheduling, quarantine, honest
state). Do those first, then this repo's T1–T5 become a short tidy-and-push.
