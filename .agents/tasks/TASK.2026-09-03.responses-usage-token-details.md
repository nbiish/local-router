# Task: Responses API Token Details Fix & WTF Fleet Skill Integration
Date: 2026-09-03
Branch: feat/responses-usage-token-details
Worktree: /Volumes/1tb-sandisk/code-external/local-router-responses

## Objective
Fix /v1/responses usage payload to include input_tokens_details and output_tokens_details for OpenAI client / trae-cli compatibility, and update .agents/skills/wtf-agent-hub/SKILL.md and AGENTS.md with the 6-point reporting & sub-agent fleet execution contract.

## Changes
- src/responses-stream.ts: add input_tokens_details.cached_tokens and output_tokens_details.reasoning_tokens
- tests/responses-http-stream.integration.test.mjs: verify token details fields in responses tests
- .agents/skills/wtf-agent-hub/SKILL.md: full documentation for chat_run, chat_sessions, and chat_session_lifecycle
- AGENTS.md: expand to 6-point contract with live headless execution

## Verification
- node --test tests/responses-http-stream.integration.test.mjs: all 5 tests pass
- npm test: all 124 tests pass
- npm run build: clean compilation
