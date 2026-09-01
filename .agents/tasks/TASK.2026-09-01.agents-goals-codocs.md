# TASK 2026-09-01 — AGENTS.md goals & co-docs, skill prune commit

Branch: `docs/agents-goals-codocs` (worktree `../agents-goals-codocs`, from `main` @ 6420110)

## Operator input
1. Ensure latest local-router main is pulled and running. → Verified: main == origin/main @ 6420110; server PID 49808 runs `node build/index.js` from this repo; build (2026-08-30 19:22) postdates last `src/` commit (74c690b, 2026-08-29). Fresh.
2. Operator deleted unused `.agents/skills/` packs in the main working tree (43 files). → Committed on this branch.
3. AGENTS.md must clearly document repo goals and co-doc with llms.txt (non-duplicative context), plus agent COMMS and tasks. → New "Mission & Goals" + "Documentation Map" sections; llms.txt stays PRD/product authority, AGENTS.md stays agent workflow/security authority.

## Decisions
- Co-doc split of concerns: AGENTS.md = why/who/how agents work (goals, workflow, security, COMMS/tasks/hub pointers); llms.txt = what to build (PRD, capabilities, catalog contracts, DOX hierarchy).
- Remove stale line 64 reference to `src/scroll_integrity.sh` (8thfire subsystem deleted with the skill prune).
- No product/code changes; docs-only branch.

## Classification: Confidential. No secrets in this file.
