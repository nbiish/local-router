---
plan_format: ainish/plan/v1
slug: tooling-hardening
date: 2026-11-14
status: implementing
branch: feat/tooling-hardening
worktree: /Volumes/1tb-sandisk/code-external/local-router-tooling
task_record: .agents/tasks/TASK.2026-11-14-21-tooling-hardening.md
operator: direct
---

# Plan: Tooling hardening — agent contracts, trajectories/tracing, fallback correctness, pi pipeline

## 1. Problem

The recent feature work (fallback quarantine, max caching, catalog federation, dual toggles) shipped
against tooling that drifted or was never built: the plans contract cites artifacts this checkout
does not have, deploy/verify rituals and smoke checks live in throwaway /tmp scripts that are gone,
the trajectory log does not say explicitly when the `local-router/fallback-models` chain alias sheds
to a concrete member (agents can mistake it for an outage), and the ainish-rag → pi agents →
localhost:11434 → `local-router/fallback-models` pipeline — which now powers the fleet's reviews —
has no single command proving it works end to end or that pi's mirrored model metadata still matches
the shim. The operator wants the tooling brought up to the standard the features assume: contracts
honest and enforced, traces legible to agents, fallback behavior provable, the pi pipeline verifiable.

## 2. Anchor Facts

- The plans-tooling contract is `.agents/plans/llms.txt` (fleet version deployed 2026-11-14 15:50;
  local-router's copy was a stale older scheme) — established from `diff` of the two checkouts'
  copies and the `ainish-sync.log` deploy batch.
- Three contract artifacts are MISSING while AGENTS.md/the contract cite them as live:
  `bin/context-packet.sh`, `.agents/templates/worktree-merge.md`, `scripts/commit-identity-guard.sh`
  — established from `test -e` audit against the AGENTS.md and plans/llms.txt references.
- The pi/hermes pipeline wiring is recorded in `.agents/tasks/TASK.2026-11-12.pi-hermes-ollama-defaults.md`:
  pi `~/.pi/agent/models.json` (provider `ollama`, `http://localhost:11434/v1`,
  `api openai-completions`, one model `local-router/fallback-models`, metadata **mirroring** the
  shim's live `/v1/models` entry) + `settings.json` defaults; hermes via the named
  `providers.local-router` block (the `ollama` provider name resolves to the real Ollama on :11435
  and 404s — a documented trap).
- Chain-alias shedding is real but implicit: `local-router/fallback-models` is an alias that sheds to
  a concrete member per request (live records show winners like `xiaomi-mimo-mimo-v2.6-pro`); the
  trajectory record carries `presentedModel` + winner but no explicit shedding marker — established
  from `src/trajectories.ts` (TrajectoryRecord shape) and the trajectory-traces task record.
- Trajectory/health system of record: `src/trajectories.ts` (TrajectoryRecord, `analyzeTrajectories`,
  error classes), `src/health-registry.ts` (quarantine), `/api/trajectories*`, `/config/trajectories`
  — established from the 2026-11-12 fallback-logic task record (commits daf1ad8/f9e352c onwards).
- Fallback behavior is verified only by throwaway smokes (16/16 and 11/11 checks) whose scripts were
  deleted after the merges — established from the task records' verification sections.
- Deploy has twice served a stale build because `lsof -ti :11434 | head -1` killed the wrong PID of
  a multi-PID port — established from TASK.2026-11-12.dual-toggles-model-identity.md notes and the
  memory entry.
- Caching capability probes used a pqc-secrets-pipe pattern (`bin/pqc-secrets.darwin-arm64 export |
  node <probe>`) and found the fastino key retired and the opencode key expired; the probe script
  is gone and the rows' re-measurement remains blocked on operator keys — established from
  TASK.2026-11-12.max-caching-everywhere.md.
- Suggestion debts still open: `scripts/verify-decisions.mjs` one-command transport receipt
  (2026-10-31-suggestions) and a `gate-baseline` note pinning the chronic red axes
  (2026-11-03-suggestions) — established from those files.

## 3. Plan

### Goals

- Every artifact the contracts cite exists and is exercised; plan/record verification runs as one
  command (`plans-doctor`).
- The trajectory log states chain-alias shedding explicitly, attributes pi/ainish-rag calls to their
  client, and reports per-stage cache observability — so agents can review errors and fallback
  behavior without folklore.
- Fallback behavior (quarantine skips, cooldown reasons, force-try, wraparound revisit gating, error
  classes) is provable from committed `scripts/smoke/` receipts, not memory.
- One command proves the fleet pipeline: ainish-rag → pi → `http://localhost:11434/v1` →
  `local-router/fallback-models` → chain winner → trajectory record, including the pi metadata-vs-
  shim drift check and an interactive latency/cost line.
- Deploy is scripted and fingerprint-verified (no stale-build class), and the caching probe +
  decisions verify + gate baseline are repo tools.

### Non-goals

- No chain reordering or new fallback semantics (execution correctness is audited, not redesigned).
- No cross-machine telemetry (trajectories stay local-only per contract).
- No UI redesign beyond what trace/health surfaces need.

### Constraints and invariants

- Secrets never in argv, files, logs, or fixtures — probes take key material only via the
  pqc-secrets stdout pipe (AGENTS.md secrets rule).
- Trajectory honesty contract: every skipped stage is recorded with its reason; new fields are
  additive and bump `schema_version`.
- One writer per mutation boundary; `router-settings.json` keeps the read-merge-write discipline.
- Plans artifacts follow the enhanced `.agents/plans/llms.txt` (this repo copy carries the 2026-11-14
  enhancements: `[~]` partial marks, section order, done-with-operator-blocker, reference integrity).
- "Decisions live in code": drift checks, thresholds, and pass/fail verdicts are deterministic code.

### Proposed architecture

```mermaid
flowchart LR
  subgraph fleet [Fleet pipeline under verification]
    RAG[ainish-rag] --> PI[pi agents]
    PI -->|openai-completions| SHIM[localhost:11434 /v1 shim]
    SHIM --> CHAIN[local-router/fallback-models]
    CHAIN --> WIN[concrete member]
    WIN --> TR[trajectories.jsonl]
  end
  V[scripts/verify-pi-pipeline.mjs] -. asserts each hop .-> SHIM
  S[scripts/smoke/* receipts] -. asserts chain behavior .-> CHAIN
  D[scripts/deploy-local.sh] -. build fingerprint .-> SHIM
  TR -. shedding + client + cache fields .-> AGENTS[agent review]
```

- `scripts/` becomes the tooling surface: `deploy-local.sh`, `probe-caching.mjs`,
  `verify-decisions.mjs`, `verify-pi-pipeline.mjs`, `smoke/*.mjs` + one runner, `plans-doctor`.
- Trajectory schema v2 (additive): an explicit shedding marker (alias → concrete winner), per-stage
  cached-token observability where the wire reports usage, and verified `client` attribution.
- The missing contract artifacts are created in their cited locations and covered by `plans-doctor`.

### Interfaces and data

- `TrajectoryRecord`: additive fields only (`schema_version` bump) — shedding marker, per-stage cache
  usage; existing readers (page, `/api/trajectories*`) must stay compatible.
- `scripts/verify-pi-pipeline.mjs`: reads `~/.pi/agent/models.json` + `/v1/models`; posts one chat via
  `local-router/fallback-models`; asserts trajectory record fields; prints latency/cost/verdict JSON.
- `plans-doctor`: runs the plans/llms.txt verification commands + reference-integrity check; exit
  non-zero on drift.

## 4. Clarifications

- None pending. Scope settled by the operator 2026-11-14 ("the tooling also includes the proper
  updates to the trajectories, tracing, and ensuring our fallback tooling works right; ainish-rag now
  uses `pi` agents that need to be powered by the localhost:11434 local-router fallback-models
  model") — `asked: operator`.
- **A2/A3/A4 are copies, not authoring** — the three "missing" artifacts already exist in the
  ainish-coder source repo (`bin/context-packet.sh`, `.agents/templates/worktree-merge.md`,
  `scripts/commit-identity-guard.sh`); they were never deployed here because they are not in
  `managed_paths`. Copying them verbatim means the next `--rules` run produces no diff. — `asked: resolved from code`
- **Execution is a slice, not all 19 todos** — the operator selected the confirmed-defect set
  (A2/A3/A4 contract artifacts, A5 plans-doctor, C1 shedding marker, C3 client attribution, C4
  trajectory docs) for this session. Remaining todos stay open and the plan stays off `done`.
  — `asked: operator`
- **`main` was dirty with the 2026-11-12 rules deploy** — that roll plus the untracked
  coordination records were committed to `main` as two separate commits before this branch was
  cut, so the worktree starts from a clean tree. — `asked: operator`
- **"Agent fleet content" is NOT being removed** — the operator clarified the phrase referred to the
  retired wtf-is-going-on-mcp federated tooling, now its own repo. `.agents/` context folders stay.
  The only residue removed is the dangling `wtf-is-going-on-mcp` skill reference in
  `.agents/skills/llms.txt` (the directory does not exist). — `asked: operator`
- **Plan §7/§8 numbering** — the template ships §1-§7 while the contract text says "§1-§8"; §8 is
  the sanctioned appendix slot. `plans-doctor` reads the template for the real order rather than
  hardcoding a count. — `asked: resolved from code`

## 5. Todos

- [ ] **A1** Sync this checkout to the deployed rules contract (`ainish-rules-sync --headless`):
  plans/llms.txt + templates + `-team.md` ledger naming + live-board adoption; grandfather existing
  plans; new plans use `{date}-{HH}-{slug}.md`.
- [x] **A2** Create `bin/context-packet.sh` (reads plan `status` + unchecked §5 boxes for bootstrap).
  Copied verbatim from ainish-coder b0f5841 so the next `--rules` deploy is a no-op.
  Verified: `./bin/context-packet.sh --task "test packet"` emits the plan state block.
- [x] **A3** Create `.agents/templates/worktree-merge.md` (the merge journal format AGENTS.md mandates).
  Copied verbatim from upstream; `diff` against source is empty.
- [x] **A4** Create `scripts/commit-identity-guard.sh` (post-commit identity enforcement, rule 4).
  Copied verbatim from upstream, mode 755. NOT yet installed as a hook in this checkout.
- [x] **A5** Create `scripts/plans-doctor` running the contract's verification + reference integrity;
  wire as `npm run verify:plans`.
  Delivered as `scripts/plans-doctor.mjs` (an extensionless file is loaded as CommonJS and cannot use
  ESM imports). Checks frontmatter, status vocabulary, task_record existence, section order,
  three-way todo marks, PARTIAL notes, done-with-open-todos, and reference integrity.
- [ ] **A6** Feed the 2026-11-14 `.agents/plans/llms.txt` enhancements upstream to the rules source so
  the next `--rules` deploy carries them (partial marks, section order, done-with-blocker, reference
  integrity) — `asked: resolved from code` that deploy-managed files are clobbered on sync.
- [x] **C1** Trajectory schema v2: explicit chain-alias shedding marker (presented alias → concrete
  winner) in `TrajectoryRecord` + page/API rendering; bump `schema_version`; keep readers compatible.
  `shedding: { from, to, attemptsBeforeAnswer, excludedCount }` is emitted only on a real shed;
  `TRAJECTORY_SCHEMA_VERSION` is 2; `TrajectorySummary.shedTo` feeds the list view; the detail view
  renders a shed banner. Verified: 8 new unit tests green; replaying 60 live records classified 54
  sheds and 6 non-sheds correctly (2 genuine failures, 4 direct calls answered as requested); a v1
  record still loads and summarizes.
- [ ] **C2** Per-stage cache observability: capture cached/usage tokens per stage where the wire
  reports them (stream usage already requested per policy), visible in stage timelines.
- [x] **C3** Client attribution: pi/ainish-rag calls carry `x-local-router-client` (or derived UA) and
  land in `trajectory.client`; fix the capture path where they don't.
  Root cause: the router read only `x-local-router-client`; pi sends no such header but does send
  `user-agent: pi/1.5.2 (darwin; node/v22.22.3; arm64)` (captured 2026-11-14 against a probe server).
  `resolveTrajectoryClient` now prefers the header, falls back to the UA product token, and records
  `clientSource` (`header`/`user-agent`/`unknown`) so an unattributed call is never mistaken for a
  caller named "unknown". 167 of 169 existing records said `unknown`; new calls attribute correctly.
- [x] **C4** `docs/trajectories.md`: the agent-facing guide to reading the log/API (records, flags,
  error classes, health, shedding semantics) — the "agents can properly review errors" surface.
  Written and fact-checked against `src/trajectories.ts` (`errorClassFor` mapping, all four health
  flags, `cooldown:<errorType>` skip format, API routes).
- [ ] **D1** Promote the deleted smoke checks into `scripts/smoke/` receipts (quarantine skip +
  cooldown reasons + force-try + error classes; model identity + archive federation; caching wire
  shape) with one runner and a `npm run smoke` alias.
- [ ] **D2** Fallback-tooling audit under pi load: `GET /api/trajectories/health` + `chainHealth`
  correctness on live traffic; measure `planStageCount` vs `stageCount` across records (the
  fallback-logic plan §7 open decision) and record the verdict.
- [ ] **D3** pi metadata drift guard: `verify-pi-pipeline` compares `~/.pi/agent/models.json`'s
  mirrored chain metadata (context/maxTokens/thinking map) against the shim's live `/v1/models`
  entry and reports drift.
- [ ] **E1** `scripts/verify-pi-pipeline.mjs`: end-to-end proof of ainish-rag → pi → /v1 →
  `local-router/fallback-models` → chain winner → trajectory record (client + chain + shedding
  fields asserted), with an interactive latency/cost line (fallback-logic target: chain latency
  bounded when only tail members are dead).
- [ ] **E2** `npm run verify:tooling` aggregate: plans-doctor + smoke runner + verify-decisions +
  verify-pi-pipeline — the one command a deploy or a new chat runs first.
- [ ] **B1** `scripts/deploy-local.sh`: kill-all-PIDs on :11434, rebuild, kickstart, fingerprint the
  served build (a known API marker), report served-vs-built commit; replaces the twice-broken manual
  ritual.
- [ ] **B2** `scripts/probe-caching.mjs` (promoted from the throwaway): pqc-secrets-pipe probes for
  markers/retention/sticky keys; run on key rotation; its output replaces `[INFERENCE]` caching notes
  (fastino/opencode re-measurement once valid keys exist — operator action).
- [ ] **B3** `scripts/verify-decisions.mjs` (2026-10-31 suggestion): probe + typed batch + chat guard
  + forced-fallback rerank as one JSON receipt.
- [ ] **B4** `gate-baseline` note (2026-11-03 suggestion): pin the chronic red axes so gate cards show
  only new regressions.

## 6. Verification

- `npm run verify:tooling` green end to end on the live router (plans-doctor, smoke receipts,
  verify-decisions, verify-pi-pipeline).
- `npm test` full suite green; trajectory schema v2 covered by unit tests (shedding marker, cache
  fields, client attribution) and the page/API stay reader-compatible.
- `verify-pi-pipeline` prints a passing verdict with a trajectory record id that a reviewer can open
  on `/config/trajectories` and see the shedding marker + client + error classes.
- `deploy-local.sh` round-trip: deploy, fingerprint matches, no stale PID survives.

## 7. Open Decisions

- **A6 upstream feed is unresolved.** `.agents/skills/llms.txt` and `.agents/plans/llms.txt` are
  both deploy-managed (`managed_paths`), so the local edits made here — the stale
  `wtf-is-going-on-mcp` skill reference removal and the 2026-11-14 plans-contract enhancements — are
  clobbered by the next `ainish-coder --rules` run on this checkout. They must be fed upstream to
  ainish-coder or they will silently revert.
- **The `--rules` signature gate fails on every run here.** The deploy signer
  (`69e7233dc7776273af28c3d80d774dad`) does not match this checkout's committed anchor
  (`.agents/audit/signer.mldsa65.pub` = `1e5593207b268d81bdb957b7fd6bc28f`). The gate is correctly
  fail-closed. Resolution is an operator decision (set the original seed, rotate the anchor, or
  rebuild the seed store) — recorded in ainish-coder
  `.agents/suggestions/2026-11-12-rules-signing-anchor-mismatch.txt`.
- **`commit-identity-guard.sh` is present but not armed.** Installing it means editing
  `.git/hooks/post-commit`, which is not tracked, so the repo cannot prove a clone has it. Whether
  to arm it here, and to teach `plans-doctor` to check hook presence, is undecided.
