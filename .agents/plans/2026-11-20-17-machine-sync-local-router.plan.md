---
plan_format: ainish/plan/v1
slug: machine-sync-local-router-fleet
date: 2026-11-20
status: done
branch: main
worktree: /Volumes/1tb-sandisk/code-external/local-router
task_record: .agents/tasks/TASK.2026-11-20-17-machine-sync-local-router.md
operator: question-me
---

# Plan: Bring `local-router` current on both machines and make `--machine-sync` actually deliver

## 1. Problem

The operator asked whether `ainish-coder --machine-sync` was "properly working" for this repo, so that
the Windows machine would be at exactly the current commit with the latest `local-router` running.

It was not. The repo had never been registered as a federation link, so nothing triggered on commit and
Windows sat 38 commits behind on the Nov-10 build. Worse, the check that looked like it worked —
`--machine-sync --status` — reported success while the checkout had not moved, because a peer with any
local modification silently skips its fast-forward. And the local Mac router was itself running code
older than its own build, so the fallback fixes merged hours earlier had never run anywhere.

## 2. Anchor Facts

- `local-router` was absent from `~/.config/ainish-coder/links.txt`; only `goal-first-trillion` was
  listed. Nothing pushed on commit. — established from the links file and `--machine-sync --status`.
- Windows HEAD was `706bb78` (== `origin/main`), local was `ccc3662`; the peer was an ancestor, so a
  pure fast-forward was possible. — established from `git merge-base --is-ancestor`.
- `build/` and `node_modules/` are gitignored (`.gitignore:80`, `:233`), so sync can NEVER deliver
  compiled code. A sync without a peer-side `npm run build` advances refs while the old binary runs.
  — established from `git check-ignore` and a peer `build/index.js` dated 2026-11-10.
- The peer's 8 dirty paths included 6 inside the incoming range. Its working tree was strictly OLDER
  than my HEAD: my `AGENTS.md` had 41 lines it lacked, my `.gitignore` had a rule it lacked, and
  `.agents/llms.txt` was byte-identical. — established by git blob hash, not by reading a diff.
- The Mac router (pid 98426, started 14:23) predated its build (16:18). `/api/chain/recommendations`
  and `?part=outbound` both returned 404, proving the running process lacked the merged fixes.
  — established by probing the live process.
- The peer's `post-checkout`/`post-merge` hooks re-deploy rules on every checkout, and its
  `ainish-coder` source is at `1bd8865`.
- **The two `ainish-coder` repos have no common ancestor.** Root commits `dda3a90` (Mac) vs `dc9d7e2`
  (Windows), 1030 vs 915 commits, 568 vs 450 files. Fast-forward is impossible and a merge would
  fabricate ~915 conflicted decisions. This was already diagnosed and deliberately stopped as T8 in
  `ainish-coder`'s own task record `2026-11-20-21-machine-sync-fleet-hardening`. — established from
  `git merge-base` returning nothing and from that task record.
- `core.hooksPath = /dev/null` was set in this repo's local `.git/config` only, which blocked the
  machine-sync hook from installing while every other repo used the default. — established from
  `git config --show-origin --get core.hooksPath`.
- `router-settings.json` is gitignored (`.gitignore:234`), so the chain never travels with a sync.
  — established from `git check-ignore`.

## 3. Plan

### Goals

- Windows at the exact same commit as the Mac, with a peer-side build of that commit.
- Both machines running the code from the fallback-tooling audit, proved by live request.
- The fleet link registered so this repo stops silently drifting.
- The peer's rules loop stopped at its root rather than papered over.

### Non-goals

- Merging the two unrelated `ainish-coder` histories. Already stopped as T8; not reversible safely.
- Making the peer's per-machine manifest byte-clean. It records a host-local path and cannot be.

### Constraints and invariants

- Never force, never merge across unrelated histories.
- Back up before discarding anything on the peer.
- Prove with a live request, not with an exit code.

### Proposed architecture

```
Mac (ccc3662..f8fddf0)                    Windows (D:/Code/local-router == WSL /mnt/d)
   │                                          │
   ├─ machine-link ────────────────────────►  registered in links.txt (was missing)
   │                                          │
   ├─ backup peer drift ───────────────────►  D:/Code/local-router-sync-backups/*.patch
   ├─ discard superseded drift ────────────►  tree clean → fast-forward possible
   ├─ machine-sync --push ─────────────────►  refs/remotes/mac-18gb/main
   ├─ git merge --ff-only ─────────────────►  HEAD advances
   ├─ copy router-settings.json ───────────►  19-step chain (gitignored, must be manual)
   ├─ npm run build ───────────────────────►  build/index.js (gitignored, must be manual)
   └─ restart via local-router-ensure ─────►  live 200 + PARITY
```

### Interfaces and data

- `~/.config/ainish-coder/links.txt` — gains the `local-router` line.
- `~/.config/ainish-coder/locator`/`machines.txt` — unchanged (`windows-128gb=D:/Code`).
- Peer `router-settings.json` — replaced with the Mac's 19-step chain; peer copy backed up first.
- Peer `.git/hooks/{post-checkout,post-merge,pre-commit}` — temporarily moved to `*.syncbackup`
  during the fast-forward (they re-dirtied the tree mid-sync), then restored.
- Peer `.agents/ainish-deploy.json` — `source_repo` repointed to `/mnt/d/Code/ainish-coder-mac`, a
  self-contained checkout of the Mac rules generation at `c71f164`.

### Files and symbols

- No source changes. This task is fleet state, not code.
- Artifacts written: this plan, `.agents/tasks/TASK.2026-11-20-17-machine-sync-local-router.md`, the
  COMMS entry, and the suggestion file on sync mechanics.

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| Merge the two `ainish-coder` histories to converge rules | No common ancestor; would fabricate ~915 conflicts. Already stopped as T8. |
| Copy the Mac binary to Windows instead of building | Wrong platform; `build/` is a per-host product. |
| Force-push the peer's `main` over its drift | Discards commits without evidence; backup + FF was available. |
| Leave the peer's 6 machine-local files clean | The manifest records a host-local source path; it cannot be clean on both. |
| Keep `core.hooksPath=/dev/null` | It is why the link hook could not install; the other linked repo uses the default. |

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Sync advances refs while the old binary keeps running | Detect with `find src -newer build/index.js` and rebuild; verified `f8fddf0` touched no `src/`, so the running code was already correct. |
| Peer hooks re-dirty mid-fast-forward | Moved to `*.syncbackup`, restored after; re-verified hooks present at the end. |
| A commit loop between the Mac watcher and the peer's rules deploy | Watched 60s for HEAD movement after the fix; stable, clean, no new commits. |
| Rules still diverge between machines | Pointed the peer manifest at a peer-local checkout of the Mac generation; `AGENTS.md` and `.agents/llms.txt` now hash-identical to it. |

## 4. Clarifications

### 4.1 Local restart

- **Question:** The Mac router was running code older than its build; restarting briefly drops 11434.
- **Options:** 1. (Recommended) Restart now via launchd `ensure`; 2. Leave it; 3. Do Windows first.
- **Selected:** Restart now.
- **Trade-off accepted:** A brief 11434 blip, including for this session's own RAG calls.
- **asked:** operator

### 4.2 Peer drift

- **Question:** 6 modified tracked rules files, content older than my HEAD.
- **Options:** 1. (Recommended) Back up a timestamped patch, then discard so the FF lands;
  2. Preserve and hand over for review; 3. Keep only the deploy manifest and signature.
- **Selected:** Back up, then discard.
- **Trade-off accepted:** The peer's local rules edits are not restored (they are preserved in
  `D:/Code/local-router-sync-backups/peer-drift-20261120-164040.patch`).
- **asked:** operator

### 4.3 Peer chain config

- **Question:** `router-settings.json` is gitignored, so sync cannot carry the 19-step chain.
- **Options:** 1. (Recommended) Copy the Mac's 19-step chain; 2. Leave the peer's 15-step chain;
  3. Sync first, then compare.
- **Selected:** Copy the Mac chain.
- **Trade-off accepted:** The chain is shared state now, so a Mac-only model change reaches the peer
  only when copied by hand — that is a property of the file being gitignored.
- **asked:** operator

### 4.4 Rules divergence

- **Question:** The peer's hooks redeploy an older rules generation, deleting skills on every checkout.
- **Options:** 1. (Recommended) Point the peer's manifest at a synced source; 2. Disable the peer's
  hooks only; 3. Investigate the divergence first; 4. Leave it.
- **Selected:** Point to local (implemented as a peer-local checkout of the Mac generation, because
  the two `ainish-coder` histories share no ancestor and cannot be merged).
- **Trade-off accepted:** The peer now reads rules from `/mnt/d/Code/ainish-coder-mac`, a checkout
  that must be updated deliberately rather than following the Mac's live `ainish-coder`.
- **asked:** operator

### 4.5 hooksPath

- **Question:** `core.hooksPath=/dev/null` in this repo blocked the machine-sync hook.
- **Options:** 1. (Recommended) Unset to match the working peer setup; 2. Keep it as deliberate.
- **Selected:** Unset.
- **Trade-off accepted:** The rules-sync and pre-commit hooks now run on this repo again; both were
  read and are benign (rules refresh, an AGENTS.md symlink warning).
- **asked:** operator

### 4.6 The auto-commit

- **Question:** The watcher auto-committed 26 pre-existing dirty files as `wip(Mac)`.
- **Options:** 1. Keep as-is; 2. Reword; 3. Show the diff first.
- **Selected:** Keep as-is.
- **asked:** operator

## 5. Todos

- [x] **T1** Register the repo link so sync triggers on commit.
  - from: §2 | done when: `links.txt` has the local-router line | verify: `cat ~/.config/ainish-coder/links.txt`
- [x] **T2** Back up and clear the peer's superseded drift.
  - from: §4.2 | done when: peer tree clean, patch saved | verify: `git status --porcelain` on peer
- [x] **T3** Deliver refs and fast-forward the peer.
  - from: §3 | done when: peer HEAD == Mac HEAD | verify: `git rev-parse --short HEAD` both sides
- [x] **T4** Rebuild on the peer.
  - from: §2 | done when: no `src` file newer than `build/index.js` | verify: `find src -newer build/index.js`
- [x] **T5** Copy the 19-step chain to the peer.
  - from: §4.3 | done when: peer serves 19 steps | verify: chain step count on peer
- [x] **T6** Restart both routers on the new build.
  - from: §4.1 | done when: both answer a live fallback request | verify: curl on 11434 both sides
- [x] **T7** Stop the peer rules loop at its root.
  - from: §4.4 | done when: peer `AGENTS.md` hash == Mac source | verify: sha256 both sides
- [x] **T8** Unset `core.hooksPath` and restore peer hooks.
  - from: §4.5 | done when: hooks present, hooksPath default | verify: `git config --get core.hooksPath`
- [x] **T9** Close out records.
  - from: §3 | done when: task, COMMS, memory, suggestion exist | verify: `ls .agents/...`

## 6. Verification

- `git rev-parse --short HEAD` on both machines — identical (`f8fddf0` at close).
- Live fallback request on both — Mac `MAC-FINAL`, Windows `REBUILT-OK` / `PARITY`, all HTTP 200.
- `curl /api/chain/recommendations` — 200 on both (404 before, proving the new build is live).
- Peer build-vs-commit check (`stat -c %Y build/index.js` >= `git log -1 --format=%ct`) — CURRENT.
  Note: the earlier `find src -newer build/index.js` form was discarded as unreliable; it flagged 59
  files on a current build because checkout rewrites mtimes.
- Peer `AGENTS.md` sha256 — equals `/mnt/d/Code/ainish-coder-mac/AGENTS.md` (rules converged).
- 60-second HEAD watch on the Mac — no new commits (the loop had stopped).
- Machine-sync `--status` — `wip: clean`, peer refs present.

## 7. Open Decisions

- The two `ainish-coder` histories remain unrelated. Resolving them (re-clone one side, or adopt one
  history as canonical) is an operator decision; until then the peer reads rules from a pinned
  checkout rather than following the Mac's live source.
- The peer keeps ~6 genuinely machine-local dirty paths (manifest source path, signature, two skills
  its own selection adds, a COMMS file). They do not affect the running router, but they mean the
  peer will never report a clean tree, so future syncs need an explicit FF step.
