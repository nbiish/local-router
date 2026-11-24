# Task: Managed Hermes Agent & `pi` CLI Harnesses

- lane: now
- branch: `feat/hermes-pi-harness`
- worktree: `C:/Users/kenwa/code-external/local-router-worktrees/feat-hermes-pi-harness`
- status: done (PR open; awaiting human approval/merge)
- plan: `.agents/plans/2026-11-24-21-hermes-pi-harness.md`
- scope: `src/agent-pi-config.ts`, `src/agent-hermes-config.ts`, `src/config-persistence.ts`, `src/agent-harness-status.ts`, `src/routes/config-api.ts`, `src/ui/pages/{agents,layout}.ts`, `bin/agents-doctor.js`, `tests/`, `package.json`, `llms.txt`
- objective: Add managed Hermes Agent (`config.yaml` + context/consolidation profiles) and `pi` CLI (`models.json`) harness wiring, readiness, verification, UI cards, and doctor checks to `local-router`.

## Verification

- `npm run build` clean (`tsc` exited 0).
- `node --test --test-concurrency=1 tests/agent-hermes-pi-config.test.mjs tests/agent-proxy-interception.test.mjs tests/agent-harness.integration.test.mjs tests/ui-page-scripts-parse.test.mjs` — 32/32 passing.
- `node bin/agents-doctor.js` — exit 0 against live `:11434`, discovering Claude, Codex, Hermes (`%LOCALAPPDATA%\hermes\bin\hermes.exe`), and `pi`.
- Zero secrets in diff; `HERMES_HOME`, `CODEX_HOME`, and `PI_CODING_AGENT_DIR` isolated in integration tests.
