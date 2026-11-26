# Suggestion: 19 test files on disk are never run by CI

- date: 2026-11-26
- status: open
- found during: release-promotion-chain work (`.agents/tasks/2026-11-26-17-release-promotion-chain.md`)

`package.json`'s `test:integration` enumerates test files one by one (deliberately — PowerShell CI
legs do not expand `tests/*.test.mjs`), but the list is missing 19 files that exist on disk:

`agent-wire.test.mjs`, `anthropic-stream.integration.test.mjs`, `app-update-ui.test.mjs`,
`catalog-federation.test.mjs`, `chain-resilience.test.mjs`, `decisions-typesafe-provider.test.mjs`,
`durability.test.mjs`, `embeddings-fallback.test.mjs`, `expert-logs.test.mjs`,
`fallback-config-api.test.mjs`, `fallback-config-bundle.test.mjs`,
`fallback-context-multimodal.test.mjs`, `fastino-migration.test.mjs`, `health-registry.test.mjs`,
`model-identity-and-archive.test.mjs`, `pqc-drift.integration.test.mjs`, `request-shaping.test.mjs`,
`routing-availability.test.mjs`, `self-healing-fallback.test.mjs`.

Notable: `app-update-ui.test.mjs` is the only test covering the dashboard's update control, and
`self-healing-fallback.test.mjs` covers PR #26 — neither runs in CI.

Suggested resolution: add a tiny check (test or CI step) that every `tests/*.test.mjs` on disk is
either in `test:integration` or explicitly listed in an exclusion file, so the enumeration cannot
silently drift again; then either add the 19 to the run or delete the dead ones.
