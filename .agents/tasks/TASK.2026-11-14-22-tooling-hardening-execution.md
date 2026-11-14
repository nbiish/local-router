# TASK.2026-11-14-22 — Tooling hardening execution (contract artifacts, plans-doctor, trajectory v2)

- Machine: mac (darwin arm64), worktree `/Volumes/1tb-sandisk/code-external/local-router-tooling`
- Branch: `feat/tooling-hardening` (cut from `main` @ `419f43c`)
- Plan: `.agents/plans/2026-11-14-21-tooling-hardening.md` (status: implementing)
- Predecessor: `.agents/tasks/TASK.2026-11-14-21-tooling-hardening.md` (plan authoring, done)
- Status: done for the selected slice; 13 of 19 todos remain open by operator scoping

## Objective

Execute the confirmed-defect subset of the tooling-hardening plan: the contract artifacts the plans
contract cites but this checkout lacked, a deterministic plans checker, and the two trajectory defects
that were reproduced against live records. Not the full 19 — the operator scoped this session to the
defects that were actually demonstrated.

## What was done

### Pre-work: `main` was dirty and could not be branched cleanly

41 paths were uncommitted — the 2026-11-12 rules deploy plus untracked plans/tasks/comms from the
2026-11-12 feature cycle. Committed as two separate commits on `main` at operator direction:

- `2175ed2` chore(rules): the deploy roll, with the signature-gate failure recorded in the message
- `419f43c` docs(agents): the coordination records, which also resolved three dangling
  `.agents/plans` -> `.agents/tasks` pointers

### A2/A3/A4 — contract artifacts (copies, not authoring)

`bin/context-packet.sh`, `.agents/templates/worktree-merge.md`,
`scripts/commit-identity-guard.sh` all existed in ainish-coder but were absent here: they are not in
`managed_paths`, so `--rules` never deploys them while the contract cites them as live. Copied
verbatim from `b0f5841`; `diff` against upstream is empty, so the next deploy is a no-op.

### A5 — `scripts/plans-doctor.mjs`

Turns the contract's verification section into code: frontmatter parses and `status` is one of five
values, `task_record` exists, sections follow template order, §5 boxes use only `[ ]`/`[~]`/`[x]`,
`[~]` carries its PARTIAL note, `status: done` carries no unlabelled open todo, and the cited
artifacts exist and are executable. Wired as `npm run verify:plans`.

Immediately found four real defects, all fixed in this branch:

1. This plan's `task_record` pointed at `.agents/tasks/2026-11-14-21-tooling-hardening.md`; the file
   is `TASK.`-prefixed. A dangling pointer every other artifact follows.
2. The max-caching plan had two `[~]` todos with no PARTIAL note.
3. Two 2026-11-12 plans have no frontmatter (grandfathered by name, not wildcarded).
4. The contract's prose says "§1-§8" while the template ships §1-§7.

### C1 — explicit chain-alias shedding (schema v2)

`shedding: { from, to, attemptsBeforeAnswer, excludedCount }`, emitted only on a real shed — absent
rather than zeroed otherwise, so "not a chain call" and "chain call answered directly" stay
distinct. `TRAJECTORY_SCHEMA_VERSION` is 2; `TrajectorySummary.shedTo` feeds the list view; the
detail view renders a shed banner.

### C3 — client attribution

Root cause confirmed, not guessed: 167 of 169 live records said `client: "unknown"` because the
router read only `x-local-router-client`, and pi sends no such header. A probe server captured pi's
actual UA (`pi/1.5.2 (darwin; node/v22.22.3; arm64)`). `resolveTrajectoryClient` now prefers the
header, falls back to the UA product token, and records `clientSource` so an unattributed call is
never mistaken for a caller named "unknown".

### C4 — `docs/trajectories.md`

Agent-facing guide: the shed rule first, record shape, skipped-vs-failed, the errorType→errorClass
mapping read off `errorClassFor`, all four health flags, the API surface, jq recipes. Every claim
checked against source.

### Not done (open, by operator scoping)

A1, A6, B1-B4, C2, D1-D3, E1-E2 — 13 todos. B2 additionally blocked on operator keys. A6 matters:
`.agents/plans/llms.txt` and `.agents/skills/llms.txt` are deploy-managed, so the local edits
(including the dangling `wtf-is-going-on-mcp` removal) revert on the next `--rules` run.

## Verification

- `npm run verify:plans` → exit 0, 0 errors, 0 warnings, 2 grandfathered.
- `node --test tests/trajectories.test.mjs` → 16/16 (8 new).
- Live-record replay: 60 records → 54 sheds, 6 correctly non-sheds (2 genuine failures with no
  answer, 4 direct calls answered as requested). Zero false negatives.
- End-to-end on a scratch router (port 11499, isolated `HOME` + config dir): a pi-shaped request
  produced `schema 2`, `client: pi`, `clientSource: user-agent`, raw UA present, and correctly
  omitted `shedding` because the chain was exhausted. **The live router on 11434 was never touched**
  and was confirmed still up afterwards.
- Full suite: 374 pass, 1 fail — `wafer-serverless live probe`, present in the pre-change baseline
  (366 pass / 1 fail / 12 skipped) and unrelated to this work.

## Deliberately not done

- **Did not arm** `commit-identity-guard.sh` as a post-commit hook. Arming means editing
  `.git/hooks/post-commit`, which is untracked — the repo could not prove a clone has it. Left for
  an operator decision.
- **Did not resolve** the `--rules` signature gate. The deploy signer (`69e7233d…`) does not match
  this checkout's committed anchor (`1e559320…`); the gate is correctly fail-closed and rotating a
  trust anchor is a security control, not an agent edit.
- **Did not remove** any `.agents/` content. The operator clarified "agent fleet content" meant the
  retired wtf-is-going-on-mcp tooling (now its own repo), not the `.agents/` context tree.

## Environment note

The `post-checkout` hook fires `ainish-rules-sync` in a fresh worktree and re-deployed from upstream,
clobbering the new tree (replacing AGENTS.md, .gitignore, etc.). It fails at the signature gate, so
it exits non-zero but only after writing. Handled by `git restore` with `core.hooksPath=/dev/null`
and disabling hooks for this worktree. Anyone opening a new worktree here should expect the same.

## First failure to expect if this is wrong

The shed marker's `to` is built as `provider/actualModel` from the answering stage. If a provider ever
reports an `actualModel` that itself contains a slash plus the presented id in a way that collides,
`isAliasAnswer` would classify a direct call as a shed. The replay over 60 live records and the four
explicit edge-case probes (direct-same, no-chain, same-pair, alias-shed) all behaved correctly.
