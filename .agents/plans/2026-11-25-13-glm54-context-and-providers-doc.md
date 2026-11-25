---
plan_format: ainish/plan/v1
slug: glm54-context-and-providers-doc
date: 2026-11-25
status: done
branch: feat/glm54-context-and-providers-doc
worktree: C:/Users/kenwa/code-external/local-router-worktrees/feat-glm54-providers-doc
task_record: .agents/tasks/2026-11-25-13-glm54-context-and-providers-doc.md
operator: user
---

# Plan: `glm-5.4` 1M Context Investigation & Sourced `docs/providers.txt`

## 1. Objective

1. Restart `:11434` onto merged `origin/main` (`5f6a606`) cleanly so live Hermes/`pi` routes and updated metadata work.
2. Investigate why `glm-5.4` (`zai-glm-5.4`) and sibling `-legal` / `[1m]` aliases fell back to `64000`/`4096` defaults, verify live `/models` + `zai/glm-5.4` reasoning behavior + primary `docs.z.ai` specs, and fix `model-specs.json`, `provider-model-registries.ts`, `model-metadata.ts`, and `provider-policy.ts`.
3. Audit all built-in providers against live `GET /models` and primary documentation, update any stale factual registry/doc metadata, and ship a deterministically generated, zero-secret, sourced `docs/providers.txt` reference alongside `PROVIDER_ENDPOINTS.md`.

## 2. Threat Model & Constraints

- Protect PQC credentials: never print, log, or embed API keys/tokens in scratch scripts, repo files, `docs/providers.txt`, tests, or commits; redact resolved secret substrings in probe output.
- Runtime catalog stays in-code (`src/provider-registry.ts`, `src/provider-model-registries.ts`, `src/model-specs.json`, `src/provider-policy.ts`) — do not reintroduce runtime `providers.txt` parsing.
- Every number/capability added must carry an explicit verification date/source citation; mark unkeyed/unverified endpoints honestly without guessing.

## 3. Verification

- `npm run build`
- `npm run validate:model-specs`
- `node --test --test-concurrency=1 tests/model-context-metadata.test.mjs tests/model-context-boot.integration.test.mjs tests/provider-policy-matrix.test.mjs tests/provider-policy-docs.test.mjs tests/agent-hermes-pi-config.test.mjs`
- Live `/v1/models` read-back confirming `zai-glm-5.4` advertises `context_length` >= `1000000` (and `1048576` / `1000000` per verified spec).
