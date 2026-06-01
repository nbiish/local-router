---
name: gitignore-worktree-debugging
description: Diagnose missing files in git worktrees — when a file exists in the main worktree but not in a linked worktree, check .gitignore
source: auto-skill
extracted_at: '2026-05-30T00:47:23.478Z'
---

# Gitignore Worktree Debugging

When files that exist in the main worktree are mysteriously absent from a linked git worktree, the cause is almost always `.gitignore`.

## The Symptom

- File `foo.txt` exists and works in the main worktree (`/repo`)
- A linked worktree created via `git worktree add` is missing `foo.txt`
- `git ls-files foo.txt` returns nothing or shows it's untracked
- The application breaks because it reads `foo.txt` from `process.cwd()`

## Root Cause

`git worktree add` creates a fresh checkout of the branch. Gitignored files are never tracked, so they're never checked out into the new worktree. The file only exists in the main worktree because someone created it there manually (or it was force-added in a past commit that has since been undone).

## Diagnosis

```bash
# 1. Confirm the file exists on disk in the main repo but isn't tracked
git ls-files foo.txt          # empty → not tracked
ls -la foo.txt                # exists on disk → gitignored

# 2. Confirm gitignore is the culprit
git check-ignore foo.txt      # prints the path if ignored

# 3. Check which gitignore rule matches
grep -n 'foo' .gitignore      # find the blocking pattern
```

## Fix

1. Remove the file pattern from `.gitignore`
2. `git add -f foo.txt` to force-add it
3. Commit the `.gitignore` change and the newly tracked file
4. The worktree will get the file on next checkout/merge

If the file genuinely shouldn't be tracked (contains secrets), the application must generate or download it at runtime rather than relying on it being present in the working directory.

## Why This Matters for Worktrees

The AGENTS.md workflow requires one worktree per task. If essential runtime files are gitignored, every new worktree will be broken. This creates a misleading situation where the code "works in the main repo" but fails in every worktree — leading to wasted debugging time chasing phantom issues.

## Prevention

- Audit `.gitignore` for entries that match runtime-required non-secret files
- Files like provider catalogs, model registries, and schema definitions should be tracked
- Secrets (API keys, tokens, credentials) must stay gitignored and be provisioned at runtime
