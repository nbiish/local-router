---
name: context-orchestration
description: "Use for context engineering, project planning, task orchestration, multi-step coding work, checkpoints, handoffs, and reducing agent token waste while preserving verification."
argument-hint: "Describe the project or task to orient and orchestrate"
---

# Context Orchestration

This workflow adapts Google’s [Elephant-Goldfish Model](https://opensource.googleblog.com/2026/10/introducing-elephant-goldfish-model-plugin.html) without copying its plugin or license-bound assets: the Elephant carries design context, Goldfish reviews only the explicit design artifact, and implementation starts only after readiness is proven.

## Goal

Produce the smallest trustworthy context packet, then move the work through explicit state transitions. Do not substitute a longer prompt for missing evidence.

## Procedure

1. **Elephant — orient and design**
   - Confirm branch, worktree, and status; never operate on `main`.
   - Read the nearest `llms.txt` chain, today’s COMMS, memory, and the newest
     bounded master-suggestion tail from `bin/context-packet.sh`.
   - Treat master suggestions as advisory lenses: apply compatible findings to
     the design, but never let them authorize a change or replace acceptance criteria.
   - Run `bin/context-packet.sh --task "<request>"`.
   - Brainstorm and debate intent, alternatives, constraints, and micro-decisions; do not write production code.
   - Draft [`../templates/egm-design.md`](../templates/egm-design.md) with named files/symbols and measurable acceptance.
2. **Read**
   - Read the files the request actually concerns, plus the nearest `llms.txt` chain.
   - Use `bin/context-packet.sh --task "<request>"` when a bounded summary helps.
   - `ainish-rag` (`route`, `orient`, `eval`, `gate`) is the operator's own project utility. Use it only when the operator asks for it; it is not required agent intake, and its output is advisory when used.
3. **Goldfish — stateless review**
   - Start a fresh reviewer with only the design artifact and its explicit references; do not provide Elephant memory, master suggestions, COMMS, chat history, or implementation diff.
   - Run three checks: explain the design, antagonistically find gaps/edge cases, and decide implementation readiness.
   - Feed findings back to the Elephant; revise and repeat until the design is clear or the task is blocked.
4. **Plan**
   - Run `bin/egm-check.sh --design <path>`; it must return `READY_FOR_GOLDFISH` before implementation.
   - Create/update one `.agents/tasks/{date}-task.md` with scope, acceptance, dependencies, risks, `compat:`, and `budget:` lines.
   - Choose a topology: serial pipeline for dependent writes; read-only fan-out for independent evidence; evaluator after implementation.
5. **Execute**
   - Keep a file/symbol allowlist. Prefer existing helpers and skills.
   - Checkpoint after orientation, implementation, and verification. A checkpoint records state, evidence, next action, and blocker.
   - Subagents return reports; the orchestrator owns shared-file mutations and receipts.
6. **Verify**
   - Run focused tests/build/lint and a real changed-surface smoke test.
   - Run `ainish-rag eval --patch` and `ainish-rag gate` when the operator uses them for this project.
   - Verify signatures, lockfiles, privacy/redaction, and compatibility for touched surfaces.
7. **Close**
   - Mark the task done or blocked with evidence.
   - Append COMMS and memory entries; append one suggestions block with the masters that actually fired (see `.agents/templates/masters.md`). Omit silent masters.
   - Leave a clean worktree or name the exact remaining file/command.

## Packet schema

Use these fields in JSON or compact text:

`request`, `route`, `next_action`, `files`, `symbols`, `constraints`, `task_state`, `master_suggestions`, `acceptance`, `verification`, `source`.

Do not include whole files, raw secrets, resolved memories, unbounded logs, or model transcripts. Keep evidence close to the claim and preserve source/commit identifiers.

## Context classes

- **Durable:** architecture decisions, invariants, accepted trade-offs, and stable gotchas. Promote only after verification; store in the appropriate wiki or memory entry.
- **Ephemeral:** current request, route, changed files, open blockers, and review findings. Keep in the task record or handoff; expire at close.
- **Goldfish input:** design plus explicit references only. Never silently add project memory,
  master suggestions, chat history, or implementation context.
- **Route probe:** context packets bound the optional RAG route probe to 20 seconds; a timeout is
  reported as unavailable rather than stalling orientation.

## Stop conditions

Stop design when intent and acceptance are explicit. Stop Goldfish review when the design is either implementation-ready with evidence or blocked by a named unresolved decision. Stop fan-out when evidence is sufficient, a writer boundary conflicts, or a verification gate fails.
