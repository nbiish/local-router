# Task: Self-Healing `fallback-models` Quarantine & Recovery

- lane: now
- branch: `feat/self-healing-fallback`
- status: done
- plan: `.agents/plans/2026-11-25-15-self-healing-fallback.md`
- scope: `src/health-registry.ts`, `src/index.ts`, `tests/self-healing-fallback.test.mjs`
- objective: Ensure `fallback-models` immediately routes around quota/window-exhausted providers across multi-turn agent conversations (Claude Code, pi, Hermes, Warp) and self-heals cleanly without resurrecting disabled or ineligible models.
