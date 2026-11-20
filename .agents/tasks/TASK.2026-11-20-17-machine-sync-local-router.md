# TASK 2026-11-20-17 — machine-sync: bring local-router current on both machines

- **Plan:** `.agents/plans/2026-11-20-17-machine-sync-local-router.plan.md`
- **Repo:** `local-router`
- **Status:** done
- **Operator:** question-me (six decisions, §4 of the plan)

## Objective

Answer whether `ainish-coder --machine-sync` was working for this repo, and make Windows current with
the latest `local-router` actually running.

## Answer: it was not working, for four independent reasons

1. **Never linked.** `local-router` was absent from `links.txt`; only `goal-first-trillion` was there,
   so no commit ever triggered a push. Windows sat 38 commits behind.
2. **`build/` never travels.** It is gitignored, so a sync advances refs while the old binary keeps
   running. Windows was executing a build dated 2026-11-10.
3. **The status check was misleading.** `--machine-sync --status` reported success while the checkout
   had not moved: a peer with any local modification silently skips its fast-forward.
4. **The local Mac router was also stale** — pid 98426 started 14:23 against a 16:18 build, so the
   fallback fixes merged that afternoon had never run on either machine.

## Final state (verified)

| | Mac | Windows |
|---|---|---|
| Commit | `f8fddf0` | `f8fddf0` |
| Build current | yes | yes (rebuilt, `src` newer: 0) |
| Chain | 19 steps | 19 steps |
| Live request | `MAC-FINAL` 200 | `REBUILT-OK` 200 |
| `/api/chain/recommendations` | 200 | 200 |
| Rules `AGENTS.md` | — | hash-identical to the Mac source |

## What was changed where

- `links.txt` — added the `local-router` → `windows-128gb:D:/Code/local-router` line.
- Local `.git/config` — unset `core.hooksPath=/dev/null` (it blocked the sync hook; the other linked
  repo uses the default).
- Peer — drift backed up to `D:/Code/local-router-sync-backups/` then discarded superseded files;
  fast-forwarded `706bb78..f8fddf0`; rebuilt; chain replaced with the Mac's 19-step version; hooks
  moved aside during the FF and restored after.
- Peer `.agents/ainish-deploy.json` — `source_repo` repointed to a peer-local checkout of the Mac
  rules generation (`/mnt/d/Code/ainish-coder-mac`, pinned at `c71f164`).

## Not done, deliberately

- **The two `ainish-coder` repos share no ancestor.** Root commits `dda3a90` vs `dc9d7e2`, 1030 vs
  915 commits. Fast-forward is impossible; a merge would fabricate ~915 conflicts. This was already
  diagnosed and stopped as T8 in that repo's own task record.
- The peer keeps ~6 genuinely machine-local dirty paths. Its deploy manifest records a host-local
  source path, so it can never be clean on both machines. That is by design, not corruption.

## Expected first failure if this is wrong

A future sync reports success while Windows runs an older build. The check that catches it is
`find src -name '*.ts' -newer build/index.js` on the peer — non-zero means the running code predates
the synced source. Run it after every sync; refs advancing is not evidence the code is current.
