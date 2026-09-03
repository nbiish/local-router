# Task: Refine trae-mini-fleet Skill with Master Personas, Concrete Prompt Examples, and COMMS Protocol
Date: 2026-09-03
Branch: feat/fleet-skill-masters
Worktree: /Volumes/1tb-sandisk/code-external/local-router-skill-masters

## Objective
Streamline and enhance `.agents/skills/trae-mini-fleet/SKILL.md`:
1. Make the skill concise and focused on agentic tool calling.
2. Establish the Top-Tier "Masters" Persona Matrix:
   - AST Refactoring Master (`trae-cli`)
   - TDD Reproduction Engineer (`mini`)
   - Adversarial Security Auditor (`trae-cli` / `mini`)
   - Systems Architecture Master (`trae-cli`)
   - Reliability & Performance Master (`mini`)
3. Provide concrete, usable prompt examples for each master persona.
4. Document the zero-config contract for `mini` (`mini --task ... --yolo --exit-immediately` without `--config`).
5. Detail the `AGENTS/{date}.COMMS.md` protocol with structured `SUBAGENT-DISPATCH` and `FLEET-HANDOFF` ledger entries.
