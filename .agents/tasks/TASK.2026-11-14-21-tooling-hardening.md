# TASK.2026-11-14-21 — Tooling hardening planning (contracts, trajectories/tracing, fallback, pi pipeline)

- Machine: mac (darwin arm64), checkout `/Volumes/1tb-sandisk/code-external/local-router`
- Branch: `main` (docs/coordination only — no repo code changed)
- Plan produced: `.agents/plans/2026-11-14-21-tooling-hardening.md` (status: ready)
- Status: done (this task = plan authoring; execution happens in the next chat per operator)

## Objective

Review the plans-tooling contract the rules agent deployed (2026-11-14 15:50), enhance it, and
produce a comprehensive tooling-improvement plan spanning BOTH the agent/plans tooling and the
local-router tooling — including (operator scope addendum) proper trajectories/tracing updates,
fallback-tooling correctness, and the ainish-rag → pi agents → localhost:11434 →
`local-router/fallback-models` serving pipeline.

## Deliverables

1. **Enhanced contract doc** — `.agents/plans/llms.txt` (local-router copy) upgraded from the stale
   scheme to the deployed 2026-11-14 contract plus enhancements from this session's friction:
   `[~]` partial-box marks with `— PARTIAL:` notes, strict §1-§8 section order, `status: done` with
   open todos allowed ONLY for labelled operator actions (the T7 precedent), and a **Reference
   integrity** section listing artifacts the contract cites that MUST exist.
2. **The plan** — `.agents/plans/2026-11-14-21-tooling-hardening.md` (new `{date}-{HH}-{slug}.md`
   scheme), 19 todos across five workstreams: A contract artifacts + rules sync, B router tooling
   scripts (deploy-local, probe-caching, verify-decisions, gate-baseline), C trajectories/tracing
   v2 (explicit chain-alias shedding marker, per-stage cache observability, client attribution,
   agent-facing trace guide), D fallback tooling receipts (promote deleted smokes to `scripts/smoke/`,
   health audit under pi load, pi metadata drift guard), E pi pipeline verification
   (`verify-pi-pipeline.mjs`, `npm run verify:tooling` aggregate).

## Key findings (anchor facts in the plan)

- Three contract artifacts are MISSING while cited as live: `bin/context-packet.sh`,
  `.agents/templates/worktree-merge.md`, `scripts/commit-identity-guard.sh`.
- pi's `~/.pi/agent/models.json` **mirrors** the shim's `/v1/models` chain metadata — silent drift
  as the chain changes; the plan adds a drift guard.
- Chain-alias shedding (`local-router/fallback-models` → concrete winner) is implicit in trajectory
  records; agents currently rely on folklore ("match winner + timestamp") — the plan makes it an
  explicit schema field.
- Trajectory/health/fallback verification lives only in deleted /tmp smokes; the plan promotes them
  to committed `scripts/smoke/` receipts.
- Deploy twice served stale builds (wrong-PID kill) — `scripts/deploy-local.sh` replaces the ritual.
- Open suggestion debts folded in: `verify-decisions.mjs` (2026-10-31), `gate-baseline` (2026-11-03),
  fastino/opencode caching re-measurement (blocked on operator keys).

## Notes

- The rules deploy (2026-11-14 15:50) landed the new contract in `hermes-backup` while this checkout
  still carried the old scheme — plan A1 syncs the checkout; A6 feeds the doc enhancements upstream
  so `--rules` deploys don't clobber them.
- No implementation was started (operator: "we will complete this in a well planned out new chat").
