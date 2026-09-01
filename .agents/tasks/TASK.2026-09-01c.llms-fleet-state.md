# TASK 2026-09-01c — llms.txt fleet-state documentation + skill mirror

Branch: `docs/llms-accomplishments` (worktree `../lr-llms`, from `main` @ `9c0a843`)

## Operator directive
Document everything accomplished in `llms.txt` so the repo's PRD reflects the
current state: agent-harness routing, fleet topology, cross-machine port.

## Changed (llms.txt)
- Intro client list: adds agent-harness CLIs (omp, hermes, fcc-claude, ollama CLI).
- New section **Agent-Harness Integration & Fleet State (2026-09-01)**:
  - singular model system (all harnesses → `local-router/fallback-models`), per-harness
    wiring details + verification receipts (mac + windows)
  - fleet topology: mac hub ⇄ windows hub federation, `local-router ops` encrypted
    control-plane chat, wtf ≥ v0.14.0 executor, PQC envelope key transfer (17 secrets)
  - operational rule: lane failure = router troubleshooting, never harness repoint
- System Snapshot header refreshed: `main` @ `9c0a843` single-branch, June 2026
  snapshot kept as historical.

## Also in this unit (same day, earlier commits)
- `feat/envelope-import-python` (a6154e0): `pqc-secrets envelope export|import`
  in the py engine — cross-platform, signature layout reverse-verified against the
  Rust engine (17/17 roundtrip). Unblocked the windows key import.
- Skill mirror `docs/wtf-skill-v0.14.0` (9c0a843): wtf-agent-hub SKILL.md synced
  byte-identical from wtf-is-going-on-mcp (20-tool surface + executor + SESSIONS card).

## Classification: Confidential. No secrets in this file.
