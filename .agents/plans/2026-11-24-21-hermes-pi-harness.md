---
plan_format: ainish/plan/v1
slug: hermes-pi-harness
date: 2026-11-24
status: done
branch: feat/hermes-pi-harness
worktree: C:/Users/kenwa/code-external/local-router-worktrees/feat-hermes-pi-harness
task_record: .agents/tasks/2026-11-24-21-hermes-pi-harness.md
operator: question-me
---

# Plan: Managed Hermes Agent & `pi` CLI Harnesses in Local Router

## 1. Objective

Add first-class managed harness support for **Hermes Agent** (`~/.hermes/config.yaml` / `%LOCALAPPDATA%\hermes\config.yaml` + `context-*` / `consolidate-*` profiles) and **`pi` CLI** (`~/.pi/agent/models.json`) alongside Claude Code and Codex CLI across `/api/agents-proxy`, `/config/agents`, and `bin/agents-doctor.js`.

## 2. Threat Model & Constraints

- **Assets:** Operator API keys/OAuth tokens and non-managed provider definitions in Hermes `config.yaml` and `pi` `models.json`.
- **Controls:**
  - Loopback-only `baseUrl` validation (`127.0.0.1` / `localhost` / `[::1]`) and single-line model ID validation (`<=200` chars, no CR/LF).
  - Never touch `.env`, `auth.json`, or non-context Hermes profiles' `model.provider`.
  - Zero new npm dependencies; deterministic indentation-aware YAML updates in `src/agent-hermes-config.ts` and atomic JSON merge in `src/agent-pi-config.ts`.
  - Loopback placeholder key `"local-router"` only.

## 3. Files & Changes

- `src/agent-pi-config.ts` (new): `piAgentDir`, `piModelsPath`, `readPiHarnessState`, `syncPiHarnessConfig`.
- `src/agent-hermes-config.ts` (new): `hermesHomeDir`, `hermesProfilesDir`, `readHermesHarnessState`, `syncHermesHarnessConfig`.
- `src/config-persistence.ts`: extend `AgentProxyConfig` + `DEFAULT_AGENT_PROXY_CONFIG` with `hermes` and `pi` (backwards-compatible loader).
- `src/agent-harness-status.ts`: Windows `%LOCALAPPDATA%\hermes\bin` search dir, `hermes`/`pi` status fields, `verifyAgentHarness` support for `'hermes' | 'pi'` via `/v1/chat/completions`.
- `src/routes/config-api.ts`: apply, validate, and verify `hermes` and `pi` on `/api/agents-proxy*`.
- `src/ui/pages/agents.ts` & `src/ui/pages/layout.ts`: readiness rows and config cards for Hermes and `pi`.
- `bin/agents-doctor.js`: readiness and `--verify` checks for Hermes and `pi`.
- `tests/agent-hermes-pi-config.test.mjs`, `tests/agent-harness.integration.test.mjs`, `package.json`, `llms.txt`.

## 4. Verification

- `npm run build`
- `node --test tests/agent-hermes-pi-config.test.mjs tests/agent-proxy-interception.test.mjs tests/agent-harness.integration.test.mjs tests/ui-page-scripts-parse.test.mjs`
- `node bin/agents-doctor.js`
