# Task: Treat Trae-CLI and Mini as Agentic Tool Calls with Expert Personas and Zero-Config Mini
Date: 2026-09-03
Branch: docs/agents-fleet-tools
Worktree: /Volumes/1tb-sandisk/code-external/local-router-fleet-tools

## Objective
Update AGENTS.md instructions and trae-mini-fleet skill:
1. Clearly instruct any LLM of any capability to treat trae-cli and mini actions as direct agentic tool calls executed headlessly in isolated worktrees (not passive commentary or manual user tasks).
2. Instruct the LLM to embody the exact expert persona required at each phase (e.g., AST Refactoring Master, TDD Reproduction Engineer, Security Auditor).
3. Remove redundant `--config <cfg>` requirements for `mini` in all directives, tables, and scripts, highlighting that `mini` is already configured via `~/.config/mini-swe-agent/.env` to route through `local-router/fallback-models`.
4. Align the 9 TTS Master Directives and the Dual-Engine Matrix with these principles.
