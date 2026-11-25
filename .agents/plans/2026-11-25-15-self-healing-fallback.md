---
plan_format: ainish/plan/v1
slug: self-healing-fallback
date: 2026-11-25
status: done
branch: feat/self-healing-fallback
worktree: C:/Users/kenwa/code-external/local-router-worktrees/feat-self-healing-fallback
task_record: .agents/tasks/2026-11-25-15-self-healing-fallback.md
operator: user
---

# Plan: Self-Healing `fallback-models` Quarantine & Recovery

1. Upgrade `FallbackHealthRegistry.recordOutcome()` (`src/health-registry.ts`) to park immediately on strike 1 for explicit quota exhaustion (`upstream_http_quota`), published reset headers (`Retry-After` / `x-ratelimit-reset*`), and subscription window exhaustion (`window`), while keeping 3-strike tolerance for bare transient burst 429s/5xx.
2. Export deterministic `selectForcedLastPassMembers()` and wire it into the `§4.2` last-pass in `src/index.ts` so recovery attempts strictly respect request eligibility (context window, vision, active non-disabled models) and try earliest-expiring cooldowns first.
3. Add `tests/self-healing-fallback.test.mjs`, verify build + full health/fallback test suites, and open PR on `nbiish/local-router`.
