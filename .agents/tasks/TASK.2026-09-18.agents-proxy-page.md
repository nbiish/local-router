# TASK 2026-09-18: Agent CLI Proxy Interception & 'Agents' Config Page

- Branch: feat/agents-proxy
- Worktree: D:/Code/local-router (branch feat/agents-proxy)
- Status: in-progress
- Triage: now
- Scope:
  - Add 'Agents' navigation link and configuration page under 'Prompt & Thinking'.
  - Provide master toggle and 5 model slot dropdowns ('Default', 'Opus (1M context)', 'Sonnet', 'Sonnet 5 (1M context)', 'Haiku') populated from user's active/checked-on models and fallback routes.
  - Implement system-wide proxy interception via environment variables and CLI shims (`bin/claude.cmd`, `bin/claude`).
  - Implement request remapping in `src/index.ts` for Anthropic Messages API (`/v1/messages`).
  - Unit and integration tests for script parsing and model remapping.
