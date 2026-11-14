# Worktree merge and cleanup

The procedure behind *Worktrees* in `AGENTS.md`. Work happens on `main`'s siblings; nothing is done
until every worktree either merged or explicitly abandoned with a reason.

## 1. Inventory before you touch anything

```bash
git worktree list --porcelain                       # every worktree and its branch
git for-each-ref --sort=committerdate --format='%(committerdate:iso8601) %(refname:short) %(objectname:short)' refs/heads/
git branch -vv --no-merged main                     # what main does not contain
```

Record the list in the task record before merging. A worktree that is not on it did not get cleaned.

## 2. Decide per worktree, by evidence — never by branch name

For each branch, gather four facts and write them down:

| Fact | Command | What it tells you |
|---|---|---|
| Commits main lacks | `git log --oneline main..<branch>` | empty = already absorbed; the branch is dead weight |
| Content diff | `git diff --stat main..<branch>` | what merging would actually change |
| Branch point | `git merge-base main <branch>` | how far behind the branch was cut |
| Activity dates | `git log -1 --format='%cI %aI' <branch>` and `git log -1 --format='%cI' main` | whether the work is newer than what `main` already has |

**The dating rule.** Compare the branch's newest commit date against the branch point, not against
today. If `<branch>`'s newest commit predates `main`'s tip *and* `main` has touched the same files since
the branch point, the branch is **stale**: its author has not seen the newer work. Rebase it on `main`,
re-run the tests, and only then merge. Merging stale work over newer work silently reverts the newer
side, and a green test run on the stale tree proves nothing about the merged result.

Also check filesystem mtimes for work that never got committed: an edited file newer than the branch's
last commit is uncommitted work, and it is the thing you are about to lose.

## 3. Order

Merge **oldest-first** by commit date. Each merge then lands on a tree that already contains the older
work, so conflicts surface against the smallest possible delta instead of at the end against everything.

For each branch, in order:

1. `git switch main && git pull --ff-only` (or `ainish-coder --machine-sync` on a federated repo).
2. `git merge --no-ff <branch>` — keep the merge commit: it is the record of when and why the lane landed.
   Use `--ff-only` only when the branch is strictly ahead and you have confirmed no other lane is open.
3. Resolve conflicts by reading both sides. Never `-X ours`/`-X theirs` on a whole merge: it discards a
   lane silently, which is the failure this procedure exists to prevent.
4. Run the tests that lane touches, on the merged tree, before the next merge.
5. Append the merge to the task record: branch, commit range, diffstat, merge commit, test result.

## 4. Clean up

```bash
git worktree remove <path>        # refuses if dirty — that refusal is information, not an obstacle
git branch -d <branch>            # refuses if unmerged — NEVER -D to get past it
git worktree prune
```

- A `remove` refusal: list what is dirty, decide commit-or-discard, then remove. Never `--force` without
  naming the file you are choosing to lose.
- A `branch -d` refusal: the branch is not merged. Go back to step 2 — do not delete it.
- Abandoning a lane on purpose is legitimate. Record it in the task record (`abandoned: <reason>`) and
  leave the branch, not the worktree; abandoned branches are cheap, stray trees are not.
- Finish with `git worktree list` empty of your task's path and `git status` clean on `main`.

## 5. Record

One entry per merge in the task record, and one lifecycle line in the daily COMMS ledger:

```
[<ISO8601>] merge | <branch> | <first>..<last> | +<ins>/-<del> across <n> files | tests: <result>
```

If two lanes touched the same file and you merged both, say which side won and why. The next agent reads
the record, not the reflog.

## Anti-patterns

- Merging by branch name because it sounds finished.
- `git merge --no-ff` on a branch that `main` already contains (creates an empty merge commit that lies).
- Deleting a worktree to "clean up" before verifying its branch merged.
- Rebasing a branch that another agent has checked out in a worktree they are still using — coordinate
  first; one writer per branch.
- Trusting CI on the branch instead of the merged tree.
